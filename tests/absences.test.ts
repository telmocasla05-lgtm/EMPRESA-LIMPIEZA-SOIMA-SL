import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAbsenceMessage,
  detectAndNotifyAbsences,
  findSubstitutes,
  hasCheckedIn,
  isPastGrace,
} from "@/lib/shifts/absences";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import { GET } from "@/app/api/cron/ausencias/route";

// Instante fijado: 3 de agosto de 2026 a las 07:00 UTC = 09:00 en Madrid
// (CEST). El turno de referencia empieza a las 08:30 de Madrid (06:30 UTC),
// es decir, hace 30 minutos: pasado el margen de gracia de 20.
const AHORA = new Date("2026-08-03T07:00:00Z");
const HOY = "2026-08-03";
const CRON_SECRET = "secreto-de-test";
const TELEFONO_COMPANY = "+34999888777";

type MockShift = {
  id: string;
  company_id: string;
  worker_id: string;
  center_id: string;
  date: string;
  start_time: string;
  end_time: string;
  workers: { full_name: string; active: boolean } | null;
  centers: { name: string } | null;
};

function shiftRow(partial: Partial<MockShift> = {}): MockShift {
  return {
    id: "shift-1",
    company_id: "company-1",
    worker_id: "worker-1",
    center_id: "center-1",
    date: HOY,
    start_time: "08:30:00",
    end_time: "11:00:00",
    workers: { full_name: "María López", active: true },
    centers: { name: "Centro Sol" },
    ...partial,
  };
}

function entryRow(workerId: string, createdAtUtc: string, type = "entrada") {
  return { worker_id: workerId, type, created_at: createdAtUtc };
}

type MockAbsence = {
  id: string;
  company_id: string;
  shift_id: string;
  worker_id: string;
  center_id: string;
  date: string;
  notified: boolean;
};

const state = vi.hoisted(() => ({
  shifts: [] as unknown[],
  timeEntries: [] as unknown[],
  workers: [] as unknown[],
  absences: [] as MockAbsence[],
  companyPhone: "+34999888777" as string | null,
}));

// Mini emulador del query builder de Supabase: cada from() acumula filtros y
// al hacer await resuelve contra el estado en memoria.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: { column: string; value: unknown }[] = [];
      let op: "select" | "upsert" | "update" = "select";
      let values: unknown;

      const run = () => {
        if (table === "shifts") return { data: state.shifts, error: null };
        if (table === "time_entries") return { data: state.timeEntries, error: null };
        if (table === "workers") return { data: state.workers, error: null };
        if (table !== "absences") throw new Error(`Tabla no esperada: ${table}`);

        if (op === "upsert") {
          for (const row of values as Omit<MockAbsence, "id" | "notified">[]) {
            if (!state.absences.some((a) => a.shift_id === row.shift_id)) {
              state.absences.push({
                id: `absence-${state.absences.length + 1}`,
                notified: false,
                ...row,
              });
            }
          }
          return { data: null, error: null };
        }
        if (op === "update") {
          const id = filters.find((f) => f.column === "id")?.value;
          for (const absence of state.absences) {
            if (absence.id === id) Object.assign(absence, values as object);
          }
          return { data: null, error: null };
        }
        if (filters.some((f) => f.column === "notified")) {
          return {
            data: state.absences
              .filter((a) => !a.notified)
              .map((a) => ({ ...a, companies: { phone: state.companyPhone } })),
            error: null,
          };
        }
        const shiftIds = filters.find((f) => f.column === "shift_id")?.value as string[];
        return {
          data: state.absences.filter((a) => shiftIds.includes(a.shift_id)),
          error: null,
        };
      };

      const builder = {
        select: () => builder,
        upsert: (v: unknown) => ((op = "upsert"), (values = v), builder),
        update: (v: unknown) => ((op = "update"), (values = v), builder),
        eq: (column: string, value: unknown) =>
          (filters.push({ column, value }), builder),
        in: (column: string, value: unknown) =>
          (filters.push({ column, value }), builder),
        gte: (column: string, value: unknown) =>
          (filters.push({ column, value }), builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.shifts = [shiftRow()];
  state.timeEntries = [];
  state.workers = [
    { id: "worker-2", company_id: "company-1", full_name: "Ana Ruiz", active: true },
  ];
  state.absences = [];
  state.companyPhone = TELEFONO_COMPANY;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("isPastGrace", () => {
  const turno = { date: HOY, start_time: "08:30:00" };

  it("pasados más de 20 minutos del inicio → sí", () => {
    expect(isPastGrace(turno, new Date("2026-08-03T06:51:00Z"))).toBe(true);
  });

  it("a los 20 minutos exactos aún no", () => {
    expect(isPastGrace(turno, new Date("2026-08-03T06:50:00Z"))).toBe(false);
  });

  it("turno futuro → no", () => {
    expect(isPastGrace(turno, new Date("2026-08-03T05:00:00Z"))).toBe(false);
  });
});

describe("hasCheckedIn", () => {
  const turno = shiftRow();

  it("sin fichajes → ausente", () => {
    expect(hasCheckedIn(turno, [])).toBe(false);
  });

  it("entrada tras el inicio del turno (llegada tarde) cuenta", () => {
    const entries = [entryRow("worker-1", "2026-08-03T06:45:00Z")];
    expect(hasCheckedIn(turno, entries)).toBe(true);
  });

  it("entrada anticipada dentro del margen de una hora cuenta", () => {
    const entries = [entryRow("worker-1", "2026-08-03T06:20:00Z")];
    expect(hasCheckedIn(turno, entries)).toBe(true);
  });

  it("entrada y salida de la mañana no cubren un turno posterior", () => {
    const entries = [
      entryRow("worker-1", "2026-08-03T04:30:00Z"),
      entryRow("worker-1", "2026-08-03T05:00:00Z", "salida"),
    ];
    expect(hasCheckedIn(turno, entries)).toBe(false);
  });

  it("turnos encadenados: seguir fichado del turno anterior cuenta", () => {
    // Entrada a las 06:05 de Madrid (turno previo) sin salida: al empezar
    // el de las 08:30 sigue en el centro aunque no vuelva a fichar.
    const entries = [entryRow("worker-1", "2026-08-03T04:05:00Z")];
    expect(hasCheckedIn(turno, entries)).toBe(true);
  });

  it("la entrada de otro worker no cuenta", () => {
    const entries = [entryRow("worker-2", "2026-08-03T06:45:00Z")];
    expect(hasCheckedIn(turno, entries)).toBe(false);
  });

  it("una salida dentro de la ventana no cuenta como entrada", () => {
    const entries = [entryRow("worker-1", "2026-08-03T06:45:00Z", "salida")];
    expect(hasCheckedIn(turno, entries)).toBe(false);
  });
});

describe("findSubstitutes", () => {
  const turno = shiftRow();
  const workers = [
    { id: "worker-1", full_name: "María López", active: true },
    { id: "worker-2", full_name: "Ana Ruiz", active: true },
    { id: "worker-3", full_name: "Pedro Gil", active: true },
    { id: "worker-4", full_name: "Baja Temporal", active: false },
  ];

  it("propone activos sin turno solapado, nunca al ausente ni a inactivos", () => {
    const companyShifts = [
      turno,
      shiftRow({ id: "shift-2", worker_id: "worker-3", start_time: "09:00:00", end_time: "10:00:00" }),
    ];
    expect(findSubstitutes(turno, workers, companyShifts)).toEqual(["Ana Ruiz"]);
  });

  it("un turno que empieza justo cuando acaba el ausente no descarta", () => {
    const companyShifts = [
      turno,
      shiftRow({ id: "shift-2", worker_id: "worker-3", start_time: "11:00:00", end_time: "13:00:00" }),
    ];
    expect(findSubstitutes(turno, workers, companyShifts)).toEqual([
      "Ana Ruiz",
      "Pedro Gil",
    ]);
  });

  it("un turno de otro día no descarta al sustituto", () => {
    const companyShifts = [
      turno,
      shiftRow({ id: "shift-2", worker_id: "worker-3", date: "2026-08-02" }),
    ];
    expect(findSubstitutes(turno, workers, companyShifts)).toEqual([
      "Ana Ruiz",
      "Pedro Gil",
    ]);
  });
});

describe("buildAbsenceMessage", () => {
  const base = {
    workerName: "María López",
    centerName: "Centro Sol",
    startTime: "08:30:00",
  };

  it("mensaje con sustitutos", () => {
    expect(buildAbsenceMessage({ ...base, substitutes: ["Ana Ruiz", "Pedro Gil"] })).toBe(
      "⚠️ María López no ha fichado en Centro Sol (turno de 08:30)\nSustitutos disponibles: Ana Ruiz, Pedro Gil",
    );
  });

  it("mensaje sin sustitutos", () => {
    expect(buildAbsenceMessage({ ...base, substitutes: [] })).toBe(
      "⚠️ María López no ha fichado en Centro Sol (turno de 08:30)\nNo hay sustitutos disponibles sin turno a esa hora.",
    );
  });

  it("con más de cinco sustitutos lista cinco y resume el resto", () => {
    const substitutes = ["A", "B", "C", "D", "E", "F", "G"];
    expect(buildAbsenceMessage({ ...base, substitutes })).toContain(
      "Sustitutos disponibles: A, B, C, D, E (+2 más)",
    );
  });
});

describe("detectAndNotifyAbsences", () => {
  it("registra la ausencia, avisa a la company con sustitutos y marca notified", async () => {
    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result).toEqual({ date: HOY, detected: 1, notified: 1, failed: 0 });
    expect(state.absences).toHaveLength(1);
    expect(state.absences[0]).toMatchObject({
      company_id: "company-1",
      shift_id: "shift-1",
      worker_id: "worker-1",
      center_id: "center-1",
      date: HOY,
      notified: true,
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      TELEFONO_COMPANY,
      "⚠️ María López no ha fichado en Centro Sol (turno de 08:30)\nSustitutos disponibles: Ana Ruiz",
    );
  });

  it("si el worker fichó no hay ausencia", async () => {
    state.timeEntries = [entryRow("worker-1", "2026-08-03T06:35:00Z")];

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result).toEqual({ date: HOY, detected: 0, notified: 0, failed: 0 });
    expect(state.absences).toHaveLength(0);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("dentro del margen de gracia (20 min) aún no hay ausencia", async () => {
    state.shifts = [shiftRow({ start_time: "08:45:00" })];

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result.detected).toBe(0);
    expect(state.absences).toHaveLength(0);
  });

  it("una ausencia ya avisada no se registra ni se avisa otra vez", async () => {
    state.absences = [
      {
        id: "absence-1",
        company_id: "company-1",
        shift_id: "shift-1",
        worker_id: "worker-1",
        center_id: "center-1",
        date: HOY,
        notified: true,
      },
    ];

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result).toEqual({ date: HOY, detected: 0, notified: 0, failed: 0 });
    expect(state.absences).toHaveLength(1);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("una ausencia registrada con aviso fallido se reintenta sin duplicarla", async () => {
    state.absences = [
      {
        id: "absence-1",
        company_id: "company-1",
        shift_id: "shift-1",
        worker_id: "worker-1",
        center_id: "center-1",
        date: HOY,
        notified: false,
      },
    ];

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result).toEqual({ date: HOY, detected: 0, notified: 1, failed: 0 });
    expect(state.absences).toHaveLength(1);
    expect(state.absences[0].notified).toBe(true);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

  it("si falla el envío la ausencia queda sin marcar para reintentar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendWhatsAppText).mockRejectedValueOnce(new Error("Meta caída"));

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result).toEqual({ date: HOY, detected: 1, notified: 0, failed: 1 });
    expect(state.absences[0].notified).toBe(false);
  });

  it("company sin teléfono: registra la ausencia pero no puede avisar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.companyPhone = null;

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result).toEqual({ date: HOY, detected: 1, notified: 0, failed: 0 });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("los turnos de workers desactivados no generan ausencia", async () => {
    state.shifts = [
      shiftRow({ workers: { full_name: "Baja Temporal", active: false } }),
    ];

    const result = await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(result.detected).toBe(0);
    expect(state.absences).toHaveLength(0);
  });

  it("sin sustitutos disponibles lo dice en el mensaje", async () => {
    state.workers = [];

    await detectAndNotifyAbsences(createAdminClient(), AHORA);

    expect(sendWhatsAppText).toHaveBeenCalledWith(
      TELEFONO_COMPANY,
      "⚠️ María López no ha fichado en Centro Sol (turno de 08:30)\nNo hay sustitutos disponibles sin turno a esa hora.",
    );
  });
});

describe("GET /api/cron/ausencias", () => {
  function cronRequest(auth?: string): Request {
    return new Request("http://localhost/api/cron/ausencias", {
      headers: auth === undefined ? {} : { authorization: auth },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AHORA);
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
  });

  it("rechaza llamadas sin el secreto", async () => {
    const response = await GET(cronRequest());
    expect(response.status).toBe(401);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("rechaza llamadas con secreto incorrecto", async () => {
    const response = await GET(cronRequest("Bearer otro"));
    expect(response.status).toBe(401);
  });

  it("con el secreto ejecuta la pasada y devuelve el resumen", async () => {
    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      date: HOY,
      detected: 1,
      notified: 1,
      failed: 0,
    });
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
});
