import { beforeEach, describe, expect, it, vi } from "vitest";
import { processWebhookPayload } from "@/lib/whatsapp/process-message";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import type { WorkerRow } from "@/lib/whatsapp/time-entry";

// Centro de referencia: Puerta del Sol, radio 200 m.
const CENTRO_SOL = {
  id: "centro-1",
  name: "Centro Sol",
  latitude: 40.4168,
  longitude: -3.7038,
  radius_meters: 200,
};

const PHONE = "34618559210";

const state = vi.hoisted(() => ({
  worker: null as WorkerRow | null,
  // Segundo worker con el mismo teléfono en otra company (workers.phone es
  // único por company, no a nivel global).
  duplicateWorker: null as WorkerRow | null,
  centers: [] as Record<string, unknown>[],
  lastEntry: null as { type: string } | null,
}));

const mocks = vi.hoisted(() => ({
  messageInsert: vi.fn(),
  timeEntryInsert: vi.fn(),
  workerUpdate: vi.fn(),
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
                  data: [state.worker, state.duplicateWorker].filter(Boolean),
                  error: null,
                }),
              }),
            }),
            update: (values: Record<string, unknown>) => ({
              eq: async () => {
                mocks.workerUpdate(values);
                // El worker se relee en cada mensaje: la actualización tiene
                // que verse en la siguiente entrega del webhook.
                if (state.worker) Object.assign(state.worker, values);
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
        case "centers":
          return {
            select: () => ({
              eq: async () => ({ data: state.centers, error: null }),
            }),
          };
        case "time_entries":
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.lastEntry,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
            insert: async (row: unknown) => {
              mocks.timeEntryInsert(row);
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

function textPayload(body: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: PHONE, id: "wamid.test", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function locationPayload(latitude: number, longitude: number) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: PHONE,
                  id: "wamid.test",
                  type: "location",
                  location: { latitude, longitude },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function lastReply(): string {
  const calls = vi.mocked(sendWhatsAppText).mock.calls;
  return calls[calls.length - 1]![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  state.worker = { id: "worker-1", company_id: "company-1", pending_action: null };
  state.duplicateWorker = null;
  state.centers = [{ ...CENTRO_SOL }];
  state.lastEntry = null;
});

describe("palabras clave", () => {
  it.each([
    ["entro", "entrada"],
    ["Entrada", "entrada"],
    ["¡Hola!", "entrada"],
    ["salgo", "salida"],
    ["SALIDA", "salida"],
    ["me voy", "salida"],
  ])("«%s» guarda la acción %s y pide la ubicación", async (texto, accion) => {
    await processWebhookPayload(textPayload(texto));

    expect(mocks.workerUpdate).toHaveBeenCalledWith({ pending_action: accion });
    expect(lastReply()).toContain("ubicación");
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
  });

  it("texto no reconocido responde con ayuda sin guardar acción", async () => {
    await processWebhookPayload(textPayload("hola jefe, qué tal"));

    expect(mocks.workerUpdate).not.toHaveBeenCalled();
    expect(lastReply()).toContain("*entro*");
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
  });
});

describe("registro con ubicación", () => {
  it("entrada dentro de radio queda válida y confirma con centro y hora", async () => {
    state.worker!.pending_action = "entrada";

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        worker_id: "worker-1",
        center_id: "centro-1",
        type: "entrada",
        latitude: CENTRO_SOL.latitude,
        longitude: CENTRO_SOL.longitude,
        valid: true,
      }),
    );
    expect(lastReply()).toMatch(
      /^✅ Entrada registrada en Centro Sol a las \d{2}:\d{2}$/,
    );
    expect(mocks.workerUpdate).toHaveBeenLastCalledWith({ pending_action: null });
  });

  it("salida con entrada previa queda válida", async () => {
    state.worker!.pending_action = "salida";
    state.lastEntry = { type: "entrada" };

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "salida", valid: true }),
    );
    expect(lastReply()).toContain("✅ Salida registrada en Centro Sol");
  });

  it("elige el centro más cercano cuando hay varios", async () => {
    state.worker!.pending_action = "entrada";
    state.centers = [
      { ...CENTRO_SOL },
      {
        id: "centro-2",
        name: "Centro Retiro",
        latitude: 40.4153,
        longitude: -3.6845,
        radius_meters: 200,
      },
    ];

    await processWebhookPayload(locationPayload(40.4152, -3.6846));

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ center_id: "centro-2", valid: true }),
    );
    expect(lastReply()).toContain("Centro Retiro");
  });
});

describe("casos límite", () => {
  it("fuera de radio registra con valid=false y avisa con la distancia", async () => {
    state.worker!.pending_action = "entrada";

    // ~1.1 km al norte del centro.
    await processWebhookPayload(locationPayload(40.4268, -3.7038));

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "entrada", valid: false }),
    );
    expect(lastReply()).toContain("⚠️");
    expect(lastReply()).toMatch(/Estás a \d+ m de Centro Sol \(radio permitido: 200 m\)/);
    expect(lastReply()).toContain("pendiente de revisión");
  });

  it("doble entrada sin salida registra con valid=false y avisa", async () => {
    state.worker!.pending_action = "entrada";
    state.lastEntry = { type: "entrada" };

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "entrada", valid: false }),
    );
    expect(lastReply()).toContain("Ya tenías una entrada sin salida");
    expect(lastReply()).toContain("pendiente de revisión");
  });

  it("salida sin entrada previa registra con valid=false y avisa", async () => {
    state.worker!.pending_action = "salida";
    state.lastEntry = null;

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "salida", valid: false }),
    );
    expect(lastReply()).toContain("No constaba ninguna entrada abierta");
    expect(lastReply()).toContain("pendiente de revisión");
  });

  it("teléfono no registrado recibe aviso y no se guarda nada", async () => {
    state.worker = null;

    await processWebhookPayload(textPayload("entro"));

    expect(lastReply()).toContain("Contacta con tu responsable");
    expect(mocks.messageInsert).not.toHaveBeenCalled();
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
  });

  it("ubicación sin acción pendiente pide escribir entro o salgo", async () => {
    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(lastReply()).toContain("escribe *entro* o *salgo*");
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
  });

  it("company sin centros avisa y no registra", async () => {
    state.worker!.pending_action = "entrada";
    state.centers = [];

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(lastReply()).toContain("no tiene centros");
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
    expect(mocks.workerUpdate).toHaveBeenLastCalledWith({ pending_action: null });
  });

  it("centros sin coordenadas se tratan como si no hubiera centros", async () => {
    state.worker!.pending_action = "entrada";
    // Centro recién creado al que aún no le han puesto el enlace de Maps.
    state.centers = [
      {
        id: "centro-sin-mapa",
        name: "Centro Nuevo",
        latitude: null,
        longitude: null,
        radius_meters: 200,
      },
    ];

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(lastReply()).toContain("no tiene centros");
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
    expect(mocks.workerUpdate).toHaveBeenLastCalledWith({ pending_action: null });
  });

  it("la reentrega del mismo mensaje no registra un segundo fichaje", async () => {
    state.worker!.pending_action = "entrada";
    const payload = locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude);

    // Meta reintenta la entrega del mismo evento: al limpiarse la acción
    // pendiente, la segunda pasada ya no ficha.
    await processWebhookPayload(payload);
    await processWebhookPayload(payload);

    expect(mocks.timeEntryInsert).toHaveBeenCalledTimes(1);
    expect(lastReply()).toContain("escribe *entro* o *salgo*");
  });

  it("un teléfono de alta en dos empresas no ficha en ninguna", async () => {
    state.duplicateWorker = {
      id: "worker-2",
      company_id: "company-2",
      pending_action: null,
    };

    await processWebhookPayload(textPayload("entro"));

    expect(lastReply()).toContain("más de una empresa");
    expect(mocks.workerUpdate).not.toHaveBeenCalled();
    expect(mocks.messageInsert).not.toHaveBeenCalled();
    expect(mocks.timeEntryInsert).not.toHaveBeenCalled();
  });
});

// El reloj del sistema va en UTC (vitest.config.ts): estos tests fijan un
// instante UTC y esperan la hora local de Madrid.
describe("hora de Madrid", () => {
  it("confirma la entrada con la hora local, no la UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T07:00:00Z")); // 09:00 en Madrid (CEST)
    state.worker!.pending_action = "entrada";

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(lastReply()).toBe("✅ Entrada registrada en Centro Sol a las 09:00");
  });

  it("la salida pasada la medianoche sigue siendo válida y con hora local", async () => {
    vi.useFakeTimers();
    // 22:30 UTC del día 3 son las 00:30 del día 4 en Madrid.
    vi.setSystemTime(new Date("2026-08-03T22:30:00Z"));
    state.worker!.pending_action = "salida";
    state.lastEntry = { type: "entrada" };

    await processWebhookPayload(
      locationPayload(CENTRO_SOL.latitude, CENTRO_SOL.longitude),
    );

    expect(mocks.timeEntryInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "salida", valid: true }),
    );
    expect(lastReply()).toBe("✅ Salida registrada en Centro Sol a las 00:30");
  });
});
