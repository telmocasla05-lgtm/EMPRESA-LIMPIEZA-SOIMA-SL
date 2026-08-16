import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  processWebhookPayload,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/process-message";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import type { WorkerRow } from "@/lib/whatsapp/time-entry";

const PHONE = "34618559210";
const RESPUESTA_INCIDENCIA =
  "📋 Incidencia registrada: Material roto. Nos ponemos en ello.";

const state = vi.hoisted(() => ({
  worker: null as WorkerRow | null,
}));

const mocks = vi.hoisted(() => ({
  // Llamada a la API de Claude.
  create: vi.fn(),
  messageInsert: vi.fn(),
  registrarIncidencia: vi.fn(),
  workerUpdate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mocks.create };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      switch (table) {
        case "workers":
          return {
            select: () => ({
              in: () => ({
                limit: async () => ({
                  data: [state.worker].filter(Boolean),
                  error: null,
                }),
              }),
            }),
            update: (values: Record<string, unknown>) => ({
              eq: async () => {
                mocks.workerUpdate(values);
                return { error: null };
              },
            }),
          };
        case "whatsapp_messages":
          return {
            insert: async (row: unknown) => {
              mocks.messageInsert(row);
              return { error: null };
            },
          };
        default:
          throw new Error(`Tabla no esperada en el mock: ${table}`);
      }
    },
  }),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue(undefined),
}));

// El alta de la incidencia (transcripción, tipo, centro, foto) se prueba en
// incidencias.test.ts; aquí solo importa a qué flujo se enruta el mensaje.
vi.mock("@/lib/whatsapp/incidencias", () => ({
  registrarIncidencia: mocks.registrarIncidencia,
}));

// Respuesta con la forma que devuelve la API con salida estructurada.
function respuestaIA(intencion: string, motivo = "Motivo de prueba") {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ intencion, motivo }) }],
  };
}

function payload(
  message: { type: string } & Record<string, unknown>,
): WhatsAppWebhookPayload {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: PHONE, id: "wamid.test", ...message }],
            },
          },
        ],
      },
    ],
  };
}

function textPayload(body: string) {
  return payload({ type: "text", text: { body } });
}

function lastReply(): string {
  const calls = vi.mocked(sendWhatsAppText).mock.calls;
  return calls[calls.length - 1]![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "clave-de-prueba");
  mocks.registrarIncidencia.mockResolvedValue(RESPUESTA_INCIDENCIA);
  state.worker = { id: "worker-1", company_id: "company-1", pending_action: null };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("las palabras clave no llegan a la IA", () => {
  it.each(["entro", "Entrada", "¡Hola!", "salgo", "SALIDA", "me voy"])(
    "«%s» ficha sin llamar a la API de Claude",
    async (texto) => {
      await processWebhookPayload(textPayload(texto));

      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.registrarIncidencia).not.toHaveBeenCalled();
      expect(mocks.workerUpdate).toHaveBeenCalled();
      expect(lastReply()).toContain("ubicación");
    },
  );
});

describe("fichajes claros sin palabra clave", () => {
  it.each([
    "ya he llegado al centro",
    "acabo por hoy y me marcho",
    "se me ha olvidado fichar la salida esta mañana",
    "buenas, empiezo el turno ahora",
  ])("«%s» se responde con la ayuda de fichaje", async (texto) => {
    mocks.create.mockResolvedValue(respuestaIA("fichaje"));

    await processWebhookPayload(textPayload(texto));

    expect(lastReply()).toContain("*entro*");
    expect(lastReply()).toContain("*salgo*");
    // Sin ubicación no se ficha, y esto no es una incidencia.
    expect(mocks.workerUpdate).not.toHaveBeenCalled();
    expect(mocks.registrarIncidencia).not.toHaveBeenCalled();
  });
});

describe("incidencias claras", () => {
  it.each([
    "se ha roto la rueda del carro grande",
    "no queda papel en los baños de la segunda planta",
    "hay un cristal partido en la puerta de entrada",
    "ojo que hay un cable pelado en el pasillo",
    "la aspiradora echa humo y huele a quemado",
  ])("«%s» se enruta al flujo de incidencias", async (texto) => {
    mocks.create.mockResolvedValue(respuestaIA("incidencia"));

    await processWebhookPayload(textPayload(texto));

    expect(mocks.registrarIncidencia).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "worker-1", company_id: "company-1" }),
      { texto },
    );
    expect(lastReply()).toBe(RESPUESTA_INCIDENCIA);
    expect(mocks.workerUpdate).not.toHaveBeenCalled();
  });
});

describe("mensajes ambiguos", () => {
  it.each([
    "hola jefe, qué tal",
    "gracias",
    "vale",
    "mañana te cuento una cosa",
    "?",
  ])("«%s» pide aclaración sin abrir nada", async (texto) => {
    mocks.create.mockResolvedValue(respuestaIA("desconocido"));

    await processWebhookPayload(textPayload(texto));

    expect(lastReply()).toContain("No sé si quieres fichar o reportar una incidencia");
    expect(lastReply()).toContain("*entro*");
    expect(mocks.registrarIncidencia).not.toHaveBeenCalled();
    expect(mocks.workerUpdate).not.toHaveBeenCalled();
  });
});

describe("foto y audio", () => {
  it("una foto va al flujo de incidencias con su pie de foto", async () => {
    await processWebhookPayload(
      payload({
        type: "image",
        image: { id: "media-1", mime_type: "image/jpeg", caption: "mira el carro" },
      }),
    );

    // La intención no se clasifica: una foto solo puede ser un reporte.
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.registrarIncidencia).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "worker-1" }),
      {
        texto: "mira el carro",
        media: { kind: "image", id: "media-1", mimeType: "image/jpeg" },
      },
    );
    expect(lastReply()).toBe(RESPUESTA_INCIDENCIA);
  });

  it("un audio se trata igual que una foto", async () => {
    await processWebhookPayload(
      payload({ type: "audio", audio: { id: "media-2", mime_type: "audio/ogg" } }),
    );

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.registrarIncidencia).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        texto: null,
        media: { kind: "audio", id: "media-2", mimeType: "audio/ogg" },
      },
    );
  });

  it("los tipos sin flujo (por ejemplo un sticker) no abren nada", async () => {
    await processWebhookPayload(payload({ type: "sticker" }));

    expect(mocks.registrarIncidencia).not.toHaveBeenCalled();
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    // El mensaje sí queda guardado.
    expect(mocks.messageInsert).toHaveBeenCalled();
  });
});

// Regla de oro: no perder nunca un reporte. Si la IA no contesta, el mensaje
// entra como incidencia y el jefe la cierra desde el panel si sobraba.
describe("fallos de la IA", () => {
  it("sin ANTHROPIC_API_KEY abre incidencia y lo advierte", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await processWebhookPayload(textPayload("el dispensador de gel no funciona"));

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.registrarIncidencia).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { texto: "el dispensador de gel no funciona" },
    );
    expect(lastReply()).toBe(RESPUESTA_INCIDENCIA);
  });

  it("un rechazo de la IA acaba en incidencia", async () => {
    mocks.create.mockResolvedValue({ stop_reason: "refusal", content: [] });

    await processWebhookPayload(textPayload("mensaje que la IA rechaza"));

    expect(mocks.registrarIncidencia).toHaveBeenCalled();
  });

  it("un error de red acaba en incidencia", async () => {
    mocks.create.mockRejectedValue(new Error("timeout"));

    await processWebhookPayload(textPayload("se ha caído una estantería"));

    expect(mocks.registrarIncidencia).toHaveBeenCalled();
  });

  it("una intención inventada acaba en incidencia", async () => {
    mocks.create.mockResolvedValue(respuestaIA("saludo"));

    await processWebhookPayload(textPayload("mensaje raro"));

    expect(mocks.registrarIncidencia).toHaveBeenCalled();
  });
});

describe("la llamada a la API", () => {
  it("manda el prompt de sistema, el modelo y el esquema de salida", async () => {
    mocks.create.mockResolvedValue(respuestaIA("desconocido"));

    await processWebhookPayload(textPayload("una frase cualquiera"));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const args = mocks.create.mock.calls[0]![0];

    expect(args.model).toBe("claude-opus-5");
    expect(args.output_config.effort).toBe("low");
    expect(args.output_config.format.type).toBe("json_schema");
    expect(args.output_config.format.schema.properties.intencion.enum).toEqual([
      "fichaje",
      "incidencia",
      "desconocido",
    ]);
    // El prompt va en el turno de sistema y el mensaje del operario en el suyo.
    expect(args.system[0].text).toContain("clasificador de mensajes entrantes");
    expect(args.messages).toEqual([
      { role: "user", content: "una frase cualquiera" },
    ]);
  });
});
