// Helpers de fecha/hora del proyecto: todo se muestra y se calcula en
// Europe/Madrid (ver CLAUDE.md), aunque en la base se guarda UTC.

const MADRID_TZ = "Europe/Madrid";

function offsetMinutesAt(utc: Date): number {
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: MADRID_TZ,
    timeZoneName: "longOffset",
  })
    .formatToParts(utc)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = tzName?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

// Instante UTC que corresponde a una fecha y hora locales de Madrid.
export function madridInstant(isoDate: string, hhmm = "00:00"): Date {
  const guess = new Date(`${isoDate}T${hhmm}:00Z`);
  return new Date(guess.getTime() - offsetMinutesAt(guess) * 60_000);
}

export function madridDayStart(isoDate: string): Date {
  return madridInstant(isoDate);
}

export function madridNextDayStart(isoDate: string): Date {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return madridDayStart(next.toISOString().slice(0, 10));
}

// Fecha local de Madrid en formato YYYY-MM-DD.
export function madridToday(): string {
  return madridDateOf(new Date());
}

export function madridDateOf(value: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MADRID_TZ }).format(
    typeof value === "string" ? new Date(value) : value,
  );
}

// Aritmética sobre fechas de calendario YYYY-MM-DD (sin zona horaria).
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Lunes de la semana a la que pertenece la fecha.
export function mondayOf(isoDate: string): string {
  const dayOfWeek = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, -((dayOfWeek + 6) % 7));
}

// Hora local de Madrid (0-23) de un instante.
export function madridHourOf(value: string | Date): number {
  return Number(formatHora(value).slice(0, 2));
}

export function formatHora(value: string | Date): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: MADRID_TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(typeof value === "string" ? new Date(value) : value);
}

export function formatDuracion(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${minutes.toString().padStart(2, "0")} min`;
}
