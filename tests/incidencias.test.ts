import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  processWebhookPayload,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/process-message";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import type { WorkerRow } from "@/lib/whatsapp/time-entry";

const PHONE = "34618559210";
const GRAPH = "https://graph.facebook.com/v23.0";
const URL_FICHERO = "https://lookaside.example/fichero";

const state = vi.hoisted(() => ({
  worker: null as WorkerRow | null,
  // Último fichaje del operario: de aquí sale el centro de la incidencia.
  ultimoFichaje: null as { type: string; center_id: string | null } | null,
  mimeMedia: "image/jpeg",
  transcripcion: "" as string,
  whisperOk: true,
}));

const mocks = vi.hoisted(() => ({
  // Llamada a la API de Claude que clasifica el tipo y la urgencia.
  create: vi.fn(),
  fetch: vi.fn(),
  messageInsert: vi.fn(),
  incidentInsert: vi.fn(),
  incidentUpdate: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mocks.create };
  },
}));

// La intención (fichaje / incidencia / desconocido) se prueba en
// whatsapp-intent.test.ts; aquí todo mensaje de texto ya es una incidencia.
vi.mock("@/lib/whatsapp/intent", () => ({
  classifyIntent: vi
    .fn()
    .mockResolvedValue({ intent: "incidencia", motivo: "describe un problema" }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: unknown, opciones: unknown) => {
          mocks.upload({ bucket, path, bytes, opciones });
          return { error: null };
        },
      }),
    },
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
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        case "whatsapp_messages":
          return {
            insert: async (row: unknown) => {
              mocks.messageInsert(row);
              return { error: null };
            },
          };
        case "time_entries":
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.ultimoFichaje,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        case "incidents":
          return {
            insert: (row: unknown) => {
              mocks.incidentInsert(row);
              return {
                select: () => ({
                  single: async () => ({ data: { id: "incident-1" }, error: null }),
                }),
              };
            },
            update: (values: unknown) => ({
              eq: async () => {
                mocks.incidentUpdate(values);
                return { error: null };
              },
            }),
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

// Respuesta con la forma que devuelve la API con salida estructurada.
function respuestaIA(tipo: string, urgencia = "normal", resumen = "Resumen") {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ tipo, urgencia, resumen }) }],
  };
}

function payload(
  message: { type: string } & Record<string, unknown>,
): WhatsAppWebhookPayload {
  return {
    entry: [
      { changes: [{ value: { messages: [{ from: PHONE, id: "wamid.test", ...message }] } }] },
    ],
  };
}

function lastReply(): string {
  const calls = vi.mocked(sendWhatsAppText).mock.calls;
  return calls[calls.length - 1]![1];
}

function incidenciaCreada(): Record<string, unknown> {
  return mocks.incidentInsert.mock.calls[0]![0];
}

// Contenido del turno de usuario que se le manda a Claude.
function contenidoIA(): unknown {
  return mocks.create.mock.calls[0]![0].messages[0].content;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "clave-de-prueba");
  vi.stubEnv("OPENAI_API_KEY", "clave-de-whisper");
  vi.stubEnv("WHATSAPP_TOKEN", "token-de-prueba");

  state.worker = { id: "worker-1", company_id: "company-1", pending_action: null };
  state.ultimoFichaje = { type: "entrada", center_id: "center-1" };
  state.mimeMedia = "image/jpeg";
  state.transcripcion = "se ha caído una estantería en el almacén";
  state.whisperOk = true;

  mocks.create.mockResolvedValue(respuestaIA("material_roto"));

  mocks.fetch.mockImplementation(async (input: string | URL) => {
    const url = input.toString();

    // 1) Metadatos del media en la Graph API.
    if (url.startsWith(`${GRAPH}/`)) {
      return new Response(
        JSON.stringify({ url: URL_FICHERO, mime_type: state.mimeMedia }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // 2) Los bytes del fichero.
    if (url === URL_FICHERO) {
      return new Response(new TextEncoder().encode("BYTES"), { status: 200 });
    }

    // 3) Whisper.
    if (url.includes("openai.com")) {
      return state.whisperOk
        ? new Response(JSON.stringify({ text: state.transcripcion }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("service unavailable", { status: 503 });
    }

    throw new Error(`URL no esperada en el mock: ${url}`);
  });

  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("incidencia de solo texto", () => {
  it("clasifica, deduce el centro y confirma con el tipo", async () => {
    await processWebhookPayload(
      payload({ type: "text", text: { body: "se ha roto la rueda del carro" } }),
    );

    expect(incidenciaCreada()).toEqual({
      company_id: "company-1",
      worker_id: "worker-1",
      center_id: "center-1",
      type: "material_roto",
      urgency: "normal",
      status: "open",
      description: "se ha roto la rueda del carro",
    });
    // Sin adjunto no se baja nada de Meta ni se toca Storage.
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(lastReply()).toBe(
      "📋 Incidencia registrada: Material roto. Nos ponemos en ello.",
    );
  });

  it("una incidencia de seguridad sale siempre con urgencia alta", async () => {
    // Aunque la IA diga "normal": la decisión 6 del SPEC manda.
    mocks.create.mockResolvedValue(respuestaIA("seguridad", "normal"));

    await processWebhookPayload(
      payload({ type: "text", text: { body: "hay un cable pelado en el pasillo" } }),
    );

    expect(incidenciaCreada()).toMatchObject({
      type: "seguridad",
      urgency: "alta",
    });
    expect(lastReply()).toBe(
      "📋 Incidencia registrada: Seguridad. Nos ponemos en ello.",
    );
  });

  it("si la IA falla la incidencia se abre igual, sin clasificar", async () => {
    mocks.create.mockRejectedValue(new Error("timeout"));

    await processWebhookPayload(
      payload({ type: "text", text: { body: "el dispensador de gel no funciona" } }),
    );

    expect(incidenciaCreada()).toMatchObject({
      type: "sin_clasificar",
      urgency: "normal",
      description: "el dispensador de gel no funciona",
    });
    expect(lastReply()).toContain("No he entendido bien tu mensaje");
  });
});

describe("incidencia de texto + foto", () => {
  it("manda la foto a la IA y la guarda en Storage enlazada en photo_url", async () => {
    mocks.create.mockResolvedValue(respuestaIA("desperfecto"));

    await processWebhookPayload(
      payload({
        type: "image",
        image: {
          id: "media-1",
          mime_type: "image/jpeg",
          caption: "el cristal de la entrada está partido",
        },
      }),
    );

    // Dos llamadas a la Graph API: metadatos y bytes (la URL caduca en minutos).
    expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${GRAPH}/media-1`,
      URL_FICHERO,
    ]);

    // El turno de usuario lleva la foto en base64 y el pie de foto.
    expect(contenidoIA()).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: Buffer.from("BYTES").toString("base64"),
        },
      },
      { type: "text", text: "el cristal de la entrada está partido" },
    ]);

    expect(incidenciaCreada()).toMatchObject({
      type: "desperfecto",
      center_id: "center-1",
      description: "el cristal de la entrada está partido",
    });

    // Ruta dentro del bucket privado, nunca una URL pública.
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "incidencias",
        path: "company-1/incident-1/media-1.jpg",
        opciones: { contentType: "image/jpeg" },
      }),
    );
    expect(mocks.incidentUpdate).toHaveBeenCalledWith({
      photo_url: "company-1/incident-1/media-1.jpg",
    });
    expect(lastReply()).toBe(
      "📋 Incidencia registrada: Desperfecto en el centro. Nos ponemos en ello.",
    );
  });

  it("si no se puede descargar la foto la incidencia se abre igual", async () => {
    mocks.fetch.mockRejectedValue(new Error("Meta caída"));

    await processWebhookPayload(
      payload({
        type: "image",
        image: { id: "media-1", mime_type: "image/jpeg", caption: "mira esto" },
      }),
    );

    expect(incidenciaCreada()).toMatchObject({ description: "mira esto" });
    // Sin foto: se clasifica solo con el pie de foto y no se sube nada.
    expect(contenidoIA()).toBe("mira esto");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.incidentUpdate).not.toHaveBeenCalled();
  });
});

describe("incidencia de solo audio", () => {
  beforeEach(() => {
    state.mimeMedia = "audio/ogg; codecs=opus";
  });

  it("transcribe con Whisper y clasifica la transcripción", async () => {
    mocks.create.mockResolvedValue(respuestaIA("desperfecto"));

    await processWebhookPayload(
      payload({ type: "audio", audio: { id: "media-2", mime_type: "audio/ogg" } }),
    );

    // Descarga (2) + Whisper (1).
    const [, , llamadaWhisper] = mocks.fetch.mock.calls;
    expect(String(llamadaWhisper![0])).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );

    // La transcripción hace de descripción y es lo que se clasifica.
    expect(contenidoIA()).toBe("se ha caído una estantería en el almacén");
    expect(incidenciaCreada()).toMatchObject({
      type: "desperfecto",
      description: "se ha caído una estantería en el almacén",
      center_id: "center-1",
    });
    // Un audio no es una foto: no se enlaza en photo_url.
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(lastReply()).toBe(
      "📋 Incidencia registrada: Desperfecto en el centro. Nos ponemos en ello.",
    );
  });

  it("si Whisper falla la incidencia se abre y se pide la descripción", async () => {
    state.whisperOk = false;

    await processWebhookPayload(
      payload({ type: "audio", audio: { id: "media-2", mime_type: "audio/ogg" } }),
    );

    // Sin nada que leer no se gasta una llamada a la IA.
    expect(mocks.create).not.toHaveBeenCalled();
    expect(incidenciaCreada()).toMatchObject({
      type: "sin_clasificar",
      description: null,
    });
    expect(lastReply()).toContain("¿Me cuentas en una frase qué ha pasado?");
  });
});

describe("sin poder determinar el centro", () => {
  it("si el último fichaje es una salida, la incidencia queda sin centro", async () => {
    state.ultimoFichaje = { type: "salida", center_id: "center-1" };

    await processWebhookPayload(
      payload({ type: "text", text: { body: "no queda papel en los baños" } }),
    );

    expect(incidenciaCreada()).toMatchObject({ center_id: null });
    // No se pierde el reporte: se abre igual y se confirma con el tipo.
    expect(lastReply()).toBe(
      "📋 Incidencia registrada: Material roto. Nos ponemos en ello.",
    );
  });

  it("si el operario nunca ha fichado, la incidencia queda sin centro", async () => {
    state.ultimoFichaje = null;

    await processWebhookPayload(
      payload({ type: "text", text: { body: "se ha roto el mocho" } }),
    );

    expect(incidenciaCreada()).toMatchObject({ center_id: null });
  });

  it("una entrada sin centro asignado tampoco tumba la incidencia", async () => {
    state.ultimoFichaje = { type: "entrada", center_id: null };

    await processWebhookPayload(
      payload({ type: "text", text: { body: "se ha roto el mocho" } }),
    );

    expect(incidenciaCreada()).toMatchObject({ center_id: null });
  });
});
