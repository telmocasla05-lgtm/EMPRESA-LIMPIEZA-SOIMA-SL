// Validación de solapamientos de turnos. La comprobación en app da mensajes
// claros; el exclusion constraint shifts_no_overlap (código 23P01) es la red
// de seguridad ante inserciones concurrentes.

export type ShiftSlot = {
  id?: string;
  worker_id: string;
  date: string;
  start_time: string;
  end_time: string;
};

// Acepta "HH:MM" y "HH:MM:SS" (Postgres devuelve time con segundos).
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function formatShiftTime(time: string): string {
  return time.slice(0, 5);
}

// Intervalos semiabiertos [inicio, fin): acabar a las 14:00 y empezar
// a las 14:00 no cuenta como solapamiento (mismo criterio que la BD).
export function slotsOverlap(a: ShiftSlot, b: ShiftSlot): boolean {
  if (a.worker_id !== b.worker_id || a.date !== b.date) return false;
  return (
    timeToMinutes(a.start_time) < timeToMinutes(b.end_time) &&
    timeToMinutes(b.start_time) < timeToMinutes(a.end_time)
  );
}

// Primer turno existente que choca con el candidato. Si el candidato tiene
// id (edición), se ignora a sí mismo.
export function findOverlap<T extends ShiftSlot>(
  existing: T[],
  candidate: ShiftSlot,
): T | null {
  return (
    existing.find(
      (shift) => shift.id !== candidate.id && slotsOverlap(shift, candidate),
    ) ?? null
  );
}
