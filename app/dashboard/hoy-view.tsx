"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  formatDuracion,
  formatHora,
  madridDayStart,
  madridToday,
} from "@/lib/dates";

type EntryRow = {
  id: string;
  worker_id: string;
  type: "entrada" | "salida";
  valid: boolean;
  created_at: string;
  workers: { full_name: string } | null;
  centers: { name: string } | null;
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

export function HoyView() {
  const supabase = useMemo(() => createClient(), []);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

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
  }, [supabase]);

  useEffect(() => {
    fetchEntries();

    const channel = supabase
      .channel("fichajes-hoy")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_entries" },
        () => {
          fetchEntries();
        },
      )
      .subscribe();

    // Las horas acumuladas del tramo abierto crecen con el reloj.
    const tick = setInterval(() => setNow(new Date()), 60_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(tick);
    };
  }, [supabase, fetchEntries]);

  const active = computeActiveWorkers(entries, now);
  const forReview = entries.filter((entry) => !entry.valid);

  if (loading) {
    return <p className="text-sm text-gray-500">Cargando fichajes de hoy…</p>;
  }

  return (
    <div className="space-y-8">
      {error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
          Error cargando datos: {error}
        </p>
      )}

      <section>
        <h2 className="text-base font-medium tracking-tight text-gray-900">
          Fichados ahora mismo
        </h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            No hay nadie fichado en este momento.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wider text-gray-400">
                  <th className="py-2 pr-4 font-medium">Operario</th>
                  <th className="py-2 pr-4 font-medium">Centro</th>
                  <th className="py-2 pr-4 font-medium">Entrada</th>
                  <th className="py-2 font-medium">Horas hoy</th>
                </tr>
              </thead>
              <tbody>
                {active.map((worker) => (
                  <tr key={worker.workerId} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium">{worker.name}</td>
                    <td className="py-2 pr-4">{worker.centerName}</td>
                    <td className="py-2 pr-4">{formatHora(worker.since)}</td>
                    <td className="py-2">{formatDuracion(worker.accumulatedMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-base font-medium tracking-tight text-gray-900">
          Pendientes de revisión
        </h2>
        {forReview.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            Ningún fichaje pendiente de revisión hoy.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {forReview.map((entry) => (
              <li
                key={entry.id}
                className="rounded-xl bg-amber-50/70 px-4 py-3 text-sm text-amber-800"
              >
                <span className="font-medium">
                  {entry.workers?.full_name ?? "(sin nombre)"}
                </span>{" "}
                — {entry.type} a las {formatHora(entry.created_at)} en{" "}
                {entry.centers?.name ?? "(sin centro)"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
