import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyTomorrowShifts } from "@/lib/shifts/notify";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import { GET } from "@/app/api/cron/avisos-turnos/route";

// Hora fijada: 3 de agosto de 2026 a las 18:00 UTC = 20:00 en Madrid (CEST).
// "Mañana" en Madrid es por tanto el 2026-08-04.
const LAS_20_DE_MADRID = new Date("2026-08-03T18:00:00Z");
const CRON_SECRET = "secreto-de-test";

type MockShiftRow = {
  id: string;
  worker_id: string;
  start_time: string;
  end_time: string;
  workers: { full_name: string; phone: string; active: boolean } | null;
  centers: { name: string } | null;
};

function shiftRow(partial: Partial<MockShiftRow>): MockShiftRow {
  return {
    id: "shift-1",
    worker_id: "worker-1",
    start_time: "08:00:00",
    end_time: "11:00:00",
    workers: { full_name: "Telmo Casla", phone: "+34618559210", active: true },
    centers: { name: "Centro Sol" },
    ...partial,
  };
}

const state = vi.hoisted(() => ({
  shifts: [] as unknown[],
}));

const mocks = vi.hoisted(() => ({
  selectFilter: vi.fn(),
  markNotified: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "shifts") {
        throw new Error(`Tabla no esperada en el mock: ${table}`);
      }
      return {
        select: () => ({
          eq: (column: string, value: unknown) => {
            mocks.selectFilter(column, value);
            return {
              eq: (column2: string, value2: unknown) => {
                mocks.selectFilter(column2, value2);
                return Promise.resolve({ data: state.shifts, error: null });
              },
            };
          },
        }),
        update: (values: unknown) => ({
          in: (_column: string, ids: unknown) => {
            mocks.markNotified(values, ids);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  }),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue(undefined),
}));

function cronRequest(options: { auth?: string; force?: boolean } = {}): Request {
  const url = `http://localhost/api/cron/avisos-turnos${options.force ? "?force=1" : ""}`;
  return new Request(url, {
    headers:
      options.auth === undefined ? {} : { authorization: options.auth },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(LAS_20_DE_MADRID);
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  state.shifts = [shiftRow({})];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("notifyTomorrowShifts", () => {
  it("consulta los turnos de mañana (fecha de Madrid) sin notificar", async () => {
    await notifyTomorrowShifts(createAdminClient());

    expect(mocks.selectFilter).toHaveBeenCalledWith("date", "2026-08-04");
    expect(mocks.selectFilter).toHaveBeenCalledWith("notified", false);
  });

  it("envía el aviso con el formato pactado y marca notified", async () => {
    const result = await notifyTomorrowShifts(createAdminClient());

    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "+34618559210",
      "📅 Mañana: Centro Sol, de 08:00 a 11:00",
    );
    expect(mocks.markNotified).toHaveBeenCalledWith({ notified: true }, ["shift-1"]);
    expect(result).toEqual({ date: "2026-08-04", sent: 1, failed: 0, skipped: 0 });
  });

  it("agrupa varios turnos del mismo worker en un solo mensaje ordenado", async () => {
    state.shifts = [
      shiftRow({ id: "shift-2", start_time: "15:00:00", end_time: "18:00:00", centers: { name: "Centro Retiro" } }),
      shiftRow({ id: "shift-1" }),
    ];

    const result = await notifyTomorrowShifts(createAdminClient());

    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "+34618559210",
      "📅 Mañana tienes 2 turnos:\n• Centro Sol, de 08:00 a 11:00\n• Centro Retiro, de 15:00 a 18:00",
    );
    expect(mocks.markNotified).toHaveBeenCalledWith({ notified: true }, ["shift-2", "shift-1"]);
    expect(result.sent).toBe(2);
  });

  it("omite turnos de workers desactivados sin enviar nada", async () => {
    state.shifts = [
      shiftRow({
        workers: { full_name: "Baja Temporal", phone: "+34600000000", active: false },
      }),
    ];

    const result = await notifyTomorrowShifts(createAdminClient());

    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(mocks.markNotified).not.toHaveBeenCalled();
    expect(result).toEqual({ date: "2026-08-04", sent: 0, failed: 0, skipped: 1 });
  });

  it("si falla un envío no marca ese turno y sigue con el resto", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.shifts = [
      shiftRow({}),
      shiftRow({
        id: "shift-2",
        worker_id: "worker-2",
        workers: { full_name: "Ana Ruiz", phone: "+34611111111", active: true },
      }),
    ];
    vi.mocked(sendWhatsAppText).mockRejectedValueOnce(new Error("Meta caída"));

    const result = await notifyTomorrowShifts(createAdminClient());

    expect(sendWhatsAppText).toHaveBeenCalledTimes(2);
    expect(mocks.markNotified).toHaveBeenCalledTimes(1);
    expect(mocks.markNotified).toHaveBeenCalledWith({ notified: true }, ["shift-2"]);
    expect(result).toEqual({ date: "2026-08-04", sent: 1, failed: 1, skipped: 0 });
  });

  it("sin turnos mañana no envía nada", async () => {
    state.shifts = [];

    const result = await notifyTomorrowShifts(createAdminClient());

    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(result).toEqual({ date: "2026-08-04", sent: 0, failed: 0, skipped: 0 });
  });
});

describe("GET /api/cron/avisos-turnos", () => {
  it("rechaza llamadas sin el secreto", async () => {
    const response = await GET(cronRequest());
    expect(response.status).toBe(401);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("rechaza llamadas con secreto incorrecto", async () => {
    const response = await GET(cronRequest({ auth: "Bearer otro" }));
    expect(response.status).toBe(401);
  });

  it("a las 20:00 de Madrid envía los avisos y devuelve el resumen", async () => {
    const response = await GET(cronRequest({ auth: `Bearer ${CRON_SECRET}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      date: "2026-08-04",
      sent: 1,
      failed: 0,
      skipped: 0,
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

  it("fuera de las 20:00 de Madrid no hace nada (pasada UTC descartada)", async () => {
    // 19:00 UTC = 21:00 en Madrid en verano; en invierno sería la pasada buena.
    vi.setSystemTime(new Date("2026-08-03T19:00:00Z"));

    const response = await GET(cronRequest({ auth: `Bearer ${CRON_SECRET}` }));

    expect(await response.json()).toMatchObject({ skipped: true });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("con ?force=1 funciona a cualquier hora (prueba manual)", async () => {
    vi.setSystemTime(new Date("2026-08-03T10:00:00Z"));

    const response = await GET(
      cronRequest({ auth: `Bearer ${CRON_SECRET}`, force: true }),
    );

    expect(response.status).toBe(200);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
});
