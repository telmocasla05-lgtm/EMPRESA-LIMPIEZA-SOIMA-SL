import { type SupabaseClient } from "@supabase/supabase-js";
import { addDays, madridDateOf, madridDayStart, madridInstant } from "@/lib/dates";
import { formatShiftTime, slotsOverlap } from "@/lib/shifts/overlap";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

// Un turno cuenta como ausencia si empezó hace más de este margen sin
// fichaje de entrada del worker.
export const GRACE_MINUTES = 20;
// Una entrada hasta una hora antes del inicio del turno cuenta como presencia.
const EARLY_ARRIVAL_MINUTES = 60;
// Máximo de sustitutos listados en el mensaje al admin.
const MAX_SUBSTITUTES_LISTED = 5;

export type AbsenceShift = {
  id: string;
  worker_id: string;
  date: string;
  start_time: string;
  end_time: string;
};

export type WorkerEntry = {
  worker_id: string;
  type: string;
  created_at: string;
};

export type SubstituteCandidate = {
  id: string;
  full_name: string;
  active: boolean;
};

export type AbsenceCheckResult = {
  date: string;
  detected: number;
  notified: number;
  failed: number;
};

export function isPastGrace(
  shift: Pick<AbsenceShift, "date" | "start_time">,
  now: Date,
): boolean {
  const start = madridInstant(shift.date, formatShiftTime(shift.start_time));
  return now.getTime() - start.getTime() > GRACE_MINUTES * 60_000;
}

// El worker cuenta como presente si tiene una entrada entre una hora antes
// del inicio y el fin del turno, o si al empezar el turno seguía fichado
// (turnos encadenados con un único fichaje de entrada). Las entradas
// pendientes de revisión (valid = false) también cuentan: el intento existe
// y el jefe ya las ve en "Pendientes de revisión".
export function hasCheckedIn(shift: AbsenceShift, entries: WorkerEntry[]): boolean {
  const start = madridInstant(shift.date, formatShiftTime(shift.start_time)).getTime();
  const end = madridInstant(shift.date, formatShiftTime(shift.end_time)).getTime();
  const windowStart = start - EARLY_ARRIVAL_MINUTES * 60_000;

  const own = entries
    .filter((entry) => entry.worker_id === shift.worker_id)
    .map((entry) => ({ type: entry.type, at: new Date(entry.created_at).getTime() }))
    .sort((a, b) => a.at - b.at);

  const inWindow = own.some(
    (entry) => entry.type === "entrada" && entry.at >= windowStart && entry.at <= end,
  );
  if (inWindow) return true;

  const lastBeforeStart = own.filter((entry) => entry.at <= start).at(-1);
  return lastBeforeStart?.type === "entrada";
}

// Workers activos de la company sin turno que se solape con el del ausente.
// slotsOverlap ya exige mismo worker y misma fecha, así que basta con pasar
// los turnos de la company de ese día (o de días vecinos: se ignoran solos).
export function findSubstitutes(
  shift: AbsenceShift,
  workers: SubstituteCandidate[],
  companyShifts: AbsenceShift[],
): string[] {
  return workers
    .filter((worker) => worker.active && worker.id !== shift.worker_id)
    .filter((worker) => {
      const slot = {
        worker_id: worker.id,
        date: shift.date,
        start_time: shift.start_time,
        end_time: shift.end_time,
      };
      return !companyShifts.some((other) => slotsOverlap(slot, other));
    })
    .map((worker) => worker.full_name)
    .sort((a, b) => a.localeCompare(b));
}

export function buildAbsenceMessage(input: {
  workerName: string;
  centerName: string;
  startTime: string;
  substitutes: string[];
}): string {
  const header = `⚠️ ${input.workerName} no ha fichado en ${input.centerName} (turno de ${formatShiftTime(input.startTime)})`;
  if (input.substitutes.length === 0) {
    return `${header}\nNo hay sustitutos disponibles sin turno a esa hora.`;
  }
  const listed = input.substitutes.slice(0, MAX_SUBSTITUTES_LISTED);
  const extra = input.substitutes.length - listed.length;
  const suffix = extra > 0 ? ` (+${extra} más)` : "";
  return `${header}\nSustitutos disponibles: ${listed.join(", ")}${suffix}`;
}

type ShiftJoinRow = AbsenceShift & {
  company_id: string;
  center_id: string;
  workers: { full_name: string; active: boolean } | null;
  centers: { name: string } | null;
};

type PendingAbsenceRow = {
  id: string;
  company_id: string;
  shift_id: string;
  companies: { phone: string | null } | null;
};

type CompanyWorkerRow = SubstituteCandidate & { company_id: string };

// Registra en absences los turnos de ayer y hoy (ayer cubre los cercanos a
// medianoche) empezados hace más del margen sin entrada, y avisa por WhatsApp
// al teléfono de la company. El aviso se marca con notified = true tras salir:
// nunca se avisa dos veces; si el envío falla se reintenta en la pasada
// siguiente sin volver a registrar la ausencia.
export async function detectAndNotifyAbsences(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<AbsenceCheckResult> {
  const today = madridDateOf(now);
  const dates = [addDays(today, -1), today];
  const result: AbsenceCheckResult = { date: today, detected: 0, notified: 0, failed: 0 };

  const { data: shiftsData, error: shiftsError } = await admin
    .from("shifts")
    .select(
      "id, company_id, worker_id, center_id, date, start_time, end_time, workers ( full_name, active ), centers ( name )",
    )
    .in("date", dates);
  if (shiftsError) {
    throw new Error(`Error consultando turnos: ${shiftsError.message}`);
  }

  const shifts = (shiftsData ?? []) as unknown as ShiftJoinRow[];
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));

  const started = shifts.filter(
    (shift) => shift.workers?.active && isPastGrace(shift, now),
  );

  if (started.length > 0) {
    const { data: existingData, error: existingError } = await admin
      .from("absences")
      .select("shift_id")
      .in(
        "shift_id",
        started.map((shift) => shift.id),
      );
    if (existingError) {
      throw new Error(`Error consultando ausencias: ${existingError.message}`);
    }
    const existing = new Set(
      ((existingData ?? []) as { shift_id: string }[]).map((row) => row.shift_id),
    );

    const candidates = started.filter((shift) => !existing.has(shift.id));
    if (candidates.length > 0) {
      const workerIds = [...new Set(candidates.map((shift) => shift.worker_id))];
      const { data: entriesData, error: entriesError } = await admin
        .from("time_entries")
        .select("worker_id, type, created_at")
        .in("worker_id", workerIds)
        .gte("created_at", madridDayStart(dates[0]).toISOString());
      if (entriesError) {
        throw new Error(`Error consultando fichajes: ${entriesError.message}`);
      }
      const entries = (entriesData ?? []) as WorkerEntry[];

      const absent = candidates.filter((shift) => !hasCheckedIn(shift, entries));
      if (absent.length > 0) {
        // ignoreDuplicates: si dos pasadas del cron coinciden, la segunda
        // no falla contra absences_shift_unique.
        const { error: upsertError } = await admin.from("absences").upsert(
          absent.map((shift) => ({
            company_id: shift.company_id,
            shift_id: shift.id,
            worker_id: shift.worker_id,
            center_id: shift.center_id,
            date: shift.date,
          })),
          { onConflict: "shift_id", ignoreDuplicates: true },
        );
        if (upsertError) {
          throw new Error(`Error registrando ausencias: ${upsertError.message}`);
        }
        result.detected = absent.length;
      }
    }
  }

  // Avisos pendientes: las recién registradas más los reintentos de envíos
  // fallidos, siempre dentro de ayer/hoy para no reenviar avisos rancios.
  const { data: pendingData, error: pendingError } = await admin
    .from("absences")
    .select("id, company_id, shift_id, companies ( phone )")
    .eq("notified", false)
    .in("date", dates);
  if (pendingError) {
    throw new Error(`Error consultando avisos pendientes: ${pendingError.message}`);
  }
  const pending = (pendingData ?? []) as unknown as PendingAbsenceRow[];
  if (pending.length === 0) return result;

  const companyIds = [...new Set(pending.map((absence) => absence.company_id))];
  const { data: workersData, error: workersError } = await admin
    .from("workers")
    .select("id, company_id, full_name, active")
    .in("company_id", companyIds)
    .eq("active", true);
  if (workersError) {
    throw new Error(`Error consultando sustitutos: ${workersError.message}`);
  }
  const companyWorkers = (workersData ?? []) as CompanyWorkerRow[];

  for (const absence of pending) {
    const shift = shiftById.get(absence.shift_id);
    if (!shift) continue; // el turno se borró después de registrar la ausencia

    const phone = absence.companies?.phone;
    if (!phone) {
      console.warn(
        `[ausencias] Company ${absence.company_id} sin teléfono: ausencia registrada sin aviso`,
      );
      continue;
    }

    const substitutes = findSubstitutes(
      shift,
      companyWorkers.filter((worker) => worker.company_id === absence.company_id),
      shifts.filter((other) => other.company_id === absence.company_id),
    );
    const message = buildAbsenceMessage({
      workerName: shift.workers?.full_name ?? "(sin nombre)",
      centerName: shift.centers?.name ?? "(sin centro)",
      startTime: shift.start_time,
      substitutes,
    });

    try {
      await sendWhatsAppText(phone, message);
    } catch (error) {
      console.error(
        `[ausencias] Fallo avisando a la company ${absence.company_id}:`,
        error,
      );
      result.failed++;
      continue;
    }

    const { error: updateError } = await admin
      .from("absences")
      .update({ notified: true })
      .eq("id", absence.id);
    if (updateError) {
      // El aviso ya salió; solo falló dejar constancia.
      console.error(
        `[ausencias] Aviso enviado pero no se pudo marcar notified:`,
        updateError.message,
      );
    }
    result.notified++;
  }

  return result;
}
