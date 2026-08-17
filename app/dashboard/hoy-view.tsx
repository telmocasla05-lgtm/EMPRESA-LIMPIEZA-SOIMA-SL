"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EmptyState,
  MetricCard,
  SectionTitle,
  TodayDashboard,
  type FichadoAhora,
  type PendienteRevision,
} from "@/components/design-import/dashboard";
import {
  HORAS_ESTANCADA,
  resumenIncidencias,
  type IncidenciaResumible,
} from "@/lib/incidencias/estado";
import { createClient } from "@/lib/supabase/client";
import {
  formatDuracion,
  formatHora,
  madridDayStart,
  madridToday,
} from "@/lib/dates";
import { formatShiftTime } from "@/lib/shifts/overlap";

type EntryRow = {
  id: string;
  worker_id: string;
  type: "entrada" | "salida";
  valid: boolean;
  created_at: string;
  workers: { full_name: string } | null;
  centers: { name: string } | null;
};

type AbsenceRow = {
  id: string;
  detected_at: string;
  workers: { full_name: string } | null;
  centers: { name: string } | null;
  shifts: { start_time: string } | null;
};

type ActiveWorker = {
  workerId: string;
  name: string;
  centerName: string;
  since: Date;
  accumulatedMs: number;
};

// Un operario está fichado si su último movimiento de hoy es una entrada.
// Las horas acumuladas suman todos los tramos entrada→salida del día más
// el tramo abierto.
function computeActiveWorkers(entries: EntryRow[], now: Date): ActiveWorker[] {
  const byWorker = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    const list = byWorker.get(entry.worker_id) ?? [];
    list.push(entry);
    byWorker.set(entry.worker_id, list);
  }

  const active: ActiveWorker[] = [];
  for (const [workerId, list] of byWorker) {
    let openEntry: EntryRow | null = null;
    let openSince: Date | null = null;
    let accumulatedMs = 0;

    for (const entry of list) {
      if (entry.type === "entrada") {
        openEntry = entry;
        openSince = new Date(entry.created_at);
      } else if (openSince) {
        accumulatedMs += new Date(entry.created_at).getTime() - openSince.getTime();
        openEntry = null;
        openSince = null;
      }
    }

    if (openEntry && openSince) {
      active.push({
        workerId,
        name: openEntry.workers?.full_name ?? "(sin nombre)",
        centerName: openEntry.centers?.name ?? "(sin centro)",
        since: openSince,
        accumulatedMs: accumulatedMs + (now.getTime() - openSince.getTime()),
      });
    }
  }

  return active.sort((a, b) => a.name.localeCompare(b.name));
}

// La tabla no guarda el motivo por el que un fichaje quedó pendiente, así que
// se deduce de la secuencia del día. Los motivos posibles están documentados
// en la migración de time_entries: doble entrada sin salida, salida sin
// entrada previa, o fuera del radio del centro.
function motivoDeRevision(entry: EntryRow, delMismoOperario: EntryRow[]): string {
  const previas = delMismoOperario.filter(
    (otra) => new Date(otra.created_at).getTime() < new Date(entry.created_at).getTime(),
  );
  const anterior = previas[previas.length - 1];

  if (entry.type === "salida") {
    if (!anterior || anterior.type === "salida") return "salida sin entrada previa";
    return "fuera del radio GPS del centro";
  }

  if (anterior?.type === "entrada") {
    const minutos =
      (new Date(entry.created_at).getTime() - new Date(anterior.created_at).getTime()) /
      60_000;
    return minutos < 5
      ? "doble entrada en menos de 5 minutos"
      : "doble entrada sin salida intermedia";
  }

  return "fuera del radio GPS del centro";
}

function fechaLarga(): string {
  const texto = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
  }).format(new Date());
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function textoActualizado(desde: Date, ahora: Date): string {
  const minutos = Math.floor((ahora.getTime() - desde.getTime()) / 60_000);
  if (minutos < 1) return "actualizado ahora mismo";
  if (minutos === 1) return "actualizado hace 1 min";
  return `actualizado hace ${minutos} min`;
}

export function HoyView() {
  const supabase = useMemo(() => createClient(), []);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [absences, setAbsences] = useState<AbsenceRow[]>([]);
  const [incidencias, setIncidencias] = useState<IncidenciaResumible[]>([]);
  const [activeWorkerCount, setActiveWorkerCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [lastUpdated, setLastUpdated] = useState(() => new Date());

  const fetchEntries = useCallback(async () => {
    const dayStart = madridDayStart(madridToday());
    const { data, error: fetchError } = await supabase
      .from("time_entries")
      .select(
        "id, worker_id, type, valid, created_at, workers ( full_name ), centers ( name )",
      )
      .gte("created_at", dayStart.toISOString())
      .order("created_at", { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }
    setError(null);
    setEntries((data ?? []) as unknown as EntryRow[]);
    setLoading(false);
    setNow(new Date());
    setLastUpdated(new Date());
  }, [supabase]);

  const fetchAbsences = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("absences")
      .select(
        "id, detected_at, workers ( full_name ), centers ( name ), shifts ( start_time )",
      )
      .eq("date", madridToday())
      .order("detected_at", { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setAbsences((data ?? []) as unknown as AbsenceRow[]);
  }, [supabase]);

  // Incidencias sin resolver de la company, sin filtro de fecha: una de hace
  // tres días que sigue abierta es justo la que hay que ver hoy.
  const fetchIncidencias = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("incidents")
      .select("status, created_at")
      .neq("status", "resolved");

    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setIncidencias((data ?? []) as IncidenciaResumible[]);
  }, [supabase]);

  // Denominador de la métrica "de N operarios activos".
  const fetchActiveWorkerCount = useCallback(async () => {
    const { count, error: fetchError } = await supabase
      .from("workers")
      .select("id", { count: "exact", head: true })
      .eq("active", true);

    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setActiveWorkerCount(count ?? 0);
  }, [supabase]);

  useEffect(() => {
    fetchEntries();
    fetchAbsences();
    fetchIncidencias();
    fetchActiveWorkerCount();

    const channel = supabase
      .channel("fichajes-hoy")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_entries" },
        () => {
          fetchEntries();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "absences" },
        () => {
          fetchAbsences();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        () => {
          fetchIncidencias();
        },
      )
      .subscribe();

    // Las horas acumuladas del tramo abierto crecen con el reloj.
    const tick = setInterval(() => setNow(new Date()), 60_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(tick);
    };
  }, [supabase, fetchEntries, fetchAbsences, fetchIncidencias, fetchActiveWorkerCount]);

  const marcarValido = useCallback(
    async (id: string) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { error: updateError } = await supabase
        .from("time_entries")
        .update({
          valid: true,
          edited_by: user?.id ?? null,
          edited_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (updateError) {
        setError(`No se pudo marcar el fichaje como válido: ${updateError.message}`);
        // El componente lo espera para devolver la tarjeta a la lista.
        throw new Error(updateError.message);
      }
      // Realtime devolverá la fila ya validada; refrescamos por si acaso.
      fetchEntries();
    },
    [supabase, fetchEntries],
  );

  const active = computeActiveWorkers(entries, now);
  // `now` avanza con el reloj de la página, así que las que cruzan las 48 h
  // pasan a la tarjeta roja sin recargar.
  const resumen = resumenIncidencias(incidencias, now);

  const fichados: FichadoAhora[] = active.map((worker) => ({
    id: worker.workerId,
    operario: worker.name,
    centro: worker.centerName,
    horaEntrada: formatHora(worker.since),
    horasHoy: formatDuracion(worker.accumulatedMs),
  }));

  const pendientes: PendienteRevision[] = entries
    .filter((entry) => !entry.valid)
    .map((entry) => ({
      id: entry.id,
      operario: entry.workers?.full_name ?? "(sin nombre)",
      centro: entry.centers?.name ?? "(sin centro)",
      tipo: entry.type,
      hora: formatHora(entry.created_at),
      motivo: motivoDeRevision(
        entry,
        entries.filter((otra) => otra.worker_id === entry.worker_id),
      ),
    }));

  return (
    <>
      {error && (
        <p
          role="alert"
          className="m-0 rounded-xl border border-[#ec3013]/30 bg-[#fef1ee] px-[18px] py-3.5 text-[15px] font-semibold text-[#b8240d]"
        >
          Error cargando datos: {error}
        </p>
      )}

      <TodayDashboard
        fecha={`${fechaLarga()} · ${textoActualizado(lastUpdated, now)}`}
        fichados={fichados}
        pendientes={pendientes}
        operariosActivos={activeWorkerCount}
        loading={loading}
        onMarcarValido={marcarValido}
      />

      {!loading && (
        <section className="flex flex-col gap-4">
          <SectionTitle>Incidencias</SectionTitle>

          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            <MetricCard
              label="Incidencias sin resolver"
              value={resumen.abiertas}
              footnote={
                resumen.abiertas > 0
                  ? "Abiertas o en curso · pulsa para verlas"
                  : "Todo cerrado ✓"
              }
              tone={resumen.abiertas > 0 ? "warn" : "neutral"}
              href="/dashboard/incidencias?estado=sin_resolver"
            />
            <MetricCard
              label={`Más de ${HORAS_ESTANCADA} h sin resolver`}
              value={resumen.estancadas}
              footnote={
                resumen.estancadas > 0
                  ? "Llevan demasiado tiempo esperando"
                  : "Ninguna se ha quedado atrás"
              }
              tone={resumen.estancadas > 0 ? "danger" : "neutral"}
              href="/dashboard/incidencias?estado=sin_resolver"
            />
          </div>
        </section>
      )}

      {!loading && (
        <section className="flex flex-col gap-4">
          <SectionTitle>Ausencias de hoy</SectionTitle>

          {absences.length === 0 ? (
            <EmptyState
              tone="ok"
              title="Ninguna ausencia detectada hoy ✓"
              body="Si alguien no ficha al empezar su turno, aparecerá aquí."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {absences.map((absence) => (
                <div
                  key={absence.id}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#fadbd1] border-l-[3px] border-l-[#ec3013] bg-[#fff6f3] px-5 py-[18px] shadow-[0_1px_2px_rgba(22,19,15,.05)]"
                >
                  <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                    <span className="text-base font-bold">
                      {absence.workers?.full_name ?? "(sin nombre)"} ·{" "}
                      {absence.centers?.name ?? "(sin centro)"}
                    </span>
                    <span className="text-[14.5px] text-[#b8240d]">
                      No ha fichado en el turno de{" "}
                      {absence.shifts ? formatShiftTime(absence.shifts.start_time) : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
