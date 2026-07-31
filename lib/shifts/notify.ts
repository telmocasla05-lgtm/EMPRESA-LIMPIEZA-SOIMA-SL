import { type SupabaseClient } from "@supabase/supabase-js";
import { addDays, madridToday } from "@/lib/dates";
import { formatShiftTime, timeToMinutes } from "@/lib/shifts/overlap";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

type ShiftRow = {
  id: string;
  worker_id: string;
  start_time: string;
  end_time: string;
  workers: { full_name: string; phone: string; active: boolean } | null;
  centers: { name: string } | null;
};

export type NotifyResult = {
  date: string;
  sent: number;
  failed: number;
  skipped: number;
};

type ShiftLine = { center: string; start_time: string; end_time: string };

// Si un worker tiene varios turnos mañana recibe un único mensaje con todos.
export function buildShiftMessage(lines: ShiftLine[]): string {
  const ordered = [...lines].sort(
    (a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time),
  );
  const format = (line: ShiftLine) =>
    `${line.center}, de ${formatShiftTime(line.start_time)} a ${formatShiftTime(line.end_time)}`;

  if (ordered.length === 1) {
    return `📅 Mañana: ${format(ordered[0])}`;
  }
  return `📅 Mañana tienes ${ordered.length} turnos:\n${ordered
    .map((line) => `• ${format(line)}`)
    .join("\n")}`;
}

// Avisa por WhatsApp a cada worker de sus turnos de mañana (fecha de Madrid)
// aún no notificados, y marca notified = true tras enviar. Un fallo de envío
// deja esos turnos sin marcar y no corta el resto de workers.
export async function notifyTomorrowShifts(
  admin: SupabaseClient,
): Promise<NotifyResult> {
  const tomorrow = addDays(madridToday(), 1);

  const { data, error } = await admin
    .from("shifts")
    .select(
      "id, worker_id, start_time, end_time, workers ( full_name, phone, active ), centers ( name )",
    )
    .eq("date", tomorrow)
    .eq("notified", false);
  if (error) {
    throw new Error(`Error consultando turnos de mañana: ${error.message}`);
  }

  const result: NotifyResult = { date: tomorrow, sent: 0, failed: 0, skipped: 0 };
  const byWorker = new Map<string, ShiftRow[]>();

  for (const shift of (data ?? []) as unknown as ShiftRow[]) {
    if (!shift.workers?.active || !shift.centers) {
      result.skipped++;
      continue;
    }
    const group = byWorker.get(shift.worker_id) ?? [];
    group.push(shift);
    byWorker.set(shift.worker_id, group);
  }

  for (const shifts of byWorker.values()) {
    const worker = shifts[0].workers!;
    const message = buildShiftMessage(
      shifts.map((shift) => ({
        center: shift.centers!.name,
        start_time: shift.start_time,
        end_time: shift.end_time,
      })),
    );

    try {
      await sendWhatsAppText(worker.phone, message);
    } catch (error) {
      console.error(
        `[turnos] Fallo avisando a ${worker.full_name} (${worker.phone}):`,
        error,
      );
      result.failed += shifts.length;
      continue;
    }

    const { error: updateError } = await admin
      .from("shifts")
      .update({ notified: true })
      .in(
        "id",
        shifts.map((shift) => shift.id),
      );
    if (updateError) {
      // El aviso ya salió; solo falló dejar constancia.
      console.error(
        `[turnos] Aviso enviado a ${worker.full_name} pero no se pudo marcar notified:`,
        updateError.message,
      );
    }
    result.sent += shifts.length;
  }

  return result;
}
