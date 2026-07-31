import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/whatsapp/webhook/route";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

const VERIFY_TOKEN = "token-de-prueba";
const APP_SECRET = "secreto-de-prueba";
const WEBHOOK_URL = "http://localhost/api/whatsapp/webhook";

process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.WHATSAPP_APP_SECRET = APP_SECRET;

// after() de Next no funciona fuera de una request real: en tests se
// ejecuta el callback inmediatamente.
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    void fn();
  },
}));

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) =>
      table === "workers"
        ? {
            select: () => ({
              in: () => ({
                limit: () => ({ maybeSingle: mocks.maybeSingle }),
              }),
            }),
          }
        : { insert: mocks.insert },
  }),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue(undefined),
}));

function sign(body: string, secret = APP_SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textMessagePayload(from: string, body: string) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from, id: "wamid.test.1", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insert.mockResolvedValue({ error: null });
  mocks.maybeSingle.mockResolvedValue({
    data: { id: "worker-1", company_id: "company-1" },
    error: null,
  });
});

describe("GET /api/whatsapp/webhook (verificación)", () => {
  it("devuelve el challenge con el verify token correcto", async () => {
    const response = await GET(
      new Request(
        `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("12345");
  });

  it("rechaza un verify token incorrecto", async () => {
    const response = await GET(
      new Request(
        `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=malo&hub.challenge=12345`,
      ),
    );

    expect(response.status).toBe(403);
  });
});

describe("POST /api/whatsapp/webhook", () => {
  it("rechaza una firma inválida sin procesar nada", async () => {
    const body = textMessagePayload("34600111222", "hola");

    const response = await POST(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "x-hub-signature-256": sign(body, "otro-secreto") },
        body,
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("rechaza una petición sin cabecera de firma", async () => {
    const body = textMessagePayload("34600111222", "hola");

    const response = await POST(
      new Request(WEBHOOK_URL, { method: "POST", body }),
    );

    expect(response.status).toBe(401);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("con firma válida responde 200, guarda el mensaje y contesta", async () => {
    const body = textMessagePayload("34600111222", "hola jefe");

    const response = await POST(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "x-hub-signature-256": sign(body) },
        body,
      }),
    );

    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(mocks.insert).toHaveBeenCalledTimes(1);
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        worker_id: "worker-1",
        phone: "34600111222",
        direction: "inbound",
        type: "text",
        content: "hola jefe",
      }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "34600111222",
      "Recibido: hola jefe",
    );
  });

  it("ignora mensajes de teléfonos no registrados", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const body = textMessagePayload("34999999999", "hola");

    const response = await POST(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "x-hub-signature-256": sign(body) },
        body,
      }),
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});
