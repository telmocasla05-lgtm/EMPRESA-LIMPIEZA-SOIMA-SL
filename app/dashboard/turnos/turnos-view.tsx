"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { getOwnCompanyId } from "@/lib/supabase/company";
import { addDays, madridToday, mondayOf } from "@/lib/dates";
import {
  findOverlap,
  formatShiftTime,
  timeToMinutes,
} from "@/lib/shifts/overlap";

type WorkerRow = { id: string; full_name: string };
type CenterOption = { id: string; name: string };

type ShiftRow = {
  id: string;
  worker_id: string;
  center_id: string;
  date: string;
  start_time: string;
  end_time: string;
  notified: boolean;
};

// Código de Postgres para violación de exclusion constraint (solapamiento):
// red de seguridad si otro jefe crea un turno a la vez.
const OVERLAP_PG_CODE = "23P01";

const inputClass =
  "w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 transition-colors focus:border-gray-900 focus:outline-none";
const labelClass = "mb-1.5 block text-xs font-medium text-gray-500";
const primaryBtn =
  "rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40";
const ghostBtn =
  "rounded-lg px-3 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";
const segmentBtn =
  "rounded-md px-2.5 py-1 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";

function formatWeekday(isoDate: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatDayNumber(isoDate: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC",
    day: "numeric",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatDayLabel(isoDate: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatLongDate(isoDate: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function TurnosView() {
  const supabase = useMemo(() => createClient(), []);
  const [weekStart, setWeekStart] = useState(() => mondayOf(madridToday()));
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [centers, setCenters] = useState<CenterOption[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Formulario de turno: null = cerrado. shiftId null = crear.
  const [form, setForm] = useState<{
    shiftId: string | null;
    workerId: string;
    date: string;
  } | null>(null);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("13:00");
  const [centerId, setCenterId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);

  const load = useCallback(async () => {
    const [workersResult, centersResult, shiftsResult] = await Promise.all([
      supabase
        .from("workers")
        .select("id, full_name")
        .eq("active", true)
        .order("full_name"),
      supabase.from("centers").select("id, name").order("name"),
      supabase
        .from("shifts")
        .select("id, worker_id, center_id, date, start_time, end_time, notified")
        .gte("date", weekStart)
        .lte("date", addDays(weekStart, 6))
        .order("start_time"),
    ]);

    const firstError =
      workersResult.error ?? centersResult.error ?? shiftsResult.error;
    if (firstError) {
      setPageError(firstError.message);
    } else {
      setPageError(null);
      setWorkers((workersResult.data ?? []) as WorkerRow[]);
      setCenters((centersResult.data ?? []) as CenterOption[]);
      setShifts((shiftsResult.data ?? []) as ShiftRow[]);
    }
    setLoading(false);
  }, [supabase, weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  const centerName = useCallback(
    (id: string) => centers.find((center) => center.id === id)?.name ?? "¿?",
    [centers],
  );

  function closeForm() {
    setForm(null);
    setFormError(null);
  }

  function openCreate(workerId: string, date: string) {
    setForm({ shiftId: null, workerId, date });
    setStartTime("09:00");
    setEndTime("13:00");
    setCenterId(centers.length === 1 ? centers[0].id : "");
    setFormError(null);
  }

  function openEdit(shift: ShiftRow) {
    setForm({ shiftId: shift.id, workerId: shift.worker_id, date: shift.date });
    setStartTime(formatShiftTime(shift.start_time));
    setEndTime(formatShiftTime(shift.end_time));
    setCenterId(shift.center_id);
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;

    if (!centerId) {
      setFormError("Elige un centro.");
      return;
    }
    if (!startTime || !endTime) {
      setFormError("Indica hora de inicio y de fin.");
      return;
    }
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      setFormError("La hora de fin debe ser posterior a la de inicio.");
      return;
    }

    const candidate = {
      id: form.shiftId ?? undefined,
      worker_id: form.workerId,
      date: form.date,
      start_time: startTime,
      end_time: endTime,
    };
    const clash = findOverlap(shifts, candidate);
    if (clash) {
      setFormError(
        `Se solapa con otro turno de ${formatShiftTime(clash.start_time)} a ${formatShiftTime(clash.end_time)} en ${centerName(clash.center_id)}.`,
      );
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const values = {
        center_id: centerId,
        start_time: startTime,
        end_time: endTime,
      };
      const { error } = form.shiftId
        ? await supabase.from("shifts").update(values).eq("id", form.shiftId)
        : await supabase.from("shifts").insert({
            ...values,
            company_id: await getOwnCompanyId(supabase),
            worker_id: form.workerId,
            date: form.date,
          });

      if (error) {
        setFormError(
          error.code === OVERLAP_PG_CODE
            ? "Se solapa con otro turno de ese operario."
            : `No se pudo guardar: ${error.message}`,
        );
        return;
      }
      closeForm();
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!form?.shiftId) return;
    if (!confirm("¿Borrar este turno?")) return;

    setSaving(true);
    const { error } = await supabase.from("shifts").delete().eq("id", form.shiftId);
    setSaving(false);
    if (error) {
      setFormError(`No se pudo borrar: ${error.message}`);
      return;
    }
    closeForm();
    await load();
  }

  // Copia los turnos de la semana anterior a esta, saltando los que se
  // solaparían con turnos ya existentes o cuyo operario/centro ya no está.
  async function copyPreviousWeek() {
    setCopying(true);
    setNotice(null);
    setPageError(null);
    try {
      const { data, error } = await supabase
        .from("shifts")
        .select("worker_id, center_id, date, start_time, end_time")
        .gte("date", addDays(weekStart, -7))
        .lte("date", addDays(weekStart, -1));
      if (error) {
        setPageError(`No se pudo leer la semana anterior: ${error.message}`);
        return;
      }
      if (!data || data.length === 0) {
        setNotice("La semana anterior no tiene turnos que copiar.");
        return;
      }

      const workerIds = new Set(workers.map((worker) => worker.id));
      const centerIds = new Set(centers.map((center) => center.id));
      const companyId = await getOwnCompanyId(supabase);

      let skipped = 0;
      const toInsert: Record<string, string | boolean>[] = [];
      for (const shift of data as Omit<ShiftRow, "id" | "notified">[]) {
        const candidate = {
          worker_id: shift.worker_id,
          date: addDays(shift.date, 7),
          start_time: shift.start_time,
          end_time: shift.end_time,
        };
        if (
          !workerIds.has(shift.worker_id) ||
          !centerIds.has(shift.center_id) ||
          findOverlap(shifts, candidate)
        ) {
          skipped++;
          continue;
        }
        toInsert.push({
          ...candidate,
          company_id: companyId,
          center_id: shift.center_id,
          notified: false,
        });
      }

      if (toInsert.length > 0) {
        const { error: insertError } = await supabase.from("shifts").insert(toInsert);
        if (insertError) {
          setPageError(`No se pudieron copiar los turnos: ${insertError.message}`);
          return;
        }
      }
      setNotice(
        `Copiados ${toInsert.length} turnos de la semana anterior` +
          (skipped > 0 ? ` (${skipped} omitidos por solapamiento o bajas).` : "."),
      );
      await load();
    } finally {
      setCopying(false);
    }
  }

  const formWorker = workers.find((worker) => worker.id === form?.workerId);
  const today = madridToday();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <header>
          <h2 className="text-xl font-medium tracking-tight text-gray-900">
            Turnos
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Semana del {formatLongDate(weekStart)} al{" "}
            {formatLongDate(addDays(weekStart, 6))}
          </p>
        </header>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
            <button
              onClick={() => setWeekStart(addDays(weekStart, -7))}
              className={segmentBtn}
              title="Semana anterior"
            >
              ←
            </button>
            <button
              onClick={() => setWeekStart(mondayOf(madridToday()))}
              className={segmentBtn}
            >
              Hoy
            </button>
            <button
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              className={segmentBtn}
              title="Semana siguiente"
            >
              →
            </button>
          </div>
          <button
            onClick={copyPreviousWeek}
            disabled={copying}
            className={primaryBtn}
          >
            {copying ? "Copiando…" : "Copiar semana anterior"}
          </button>
        </div>
      </div>

      {pageError && (
        <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
          {pageError}
        </p>
      )}
      {notice && (
        <p className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
          {notice}
        </p>
      )}

      {form && (
        <form
          onSubmit={handleSubmit}
          className="max-w-xl space-y-4 rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm"
        >
          <h3 className="text-sm font-medium text-gray-900">
            {form.shiftId ? "Editar turno" : "Nuevo turno"} —{" "}
            {formWorker?.full_name ?? "operario"}, {formatDayLabel(form.date)}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="text-sm">
              <span className={labelClass}>Centro</span>
              <select
                value={centerId}
                onChange={(event) => setCenterId(event.target.value)}
                className={inputClass}
              >
                <option value="">— Elige centro —</option>
                {centers.map((center) => (
                  <option key={center.id} value={center.id}>
                    {center.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className={labelClass}>Inicio</span>
              <input
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className={inputClass}
              />
            </label>
            <label className="text-sm">
              <span className={labelClass}>Fin</span>
              <input
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          {formError && <p className="text-sm text-red-500">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving ? "Guardando…" : form.shiftId ? "Guardar cambios" : "Crear turno"}
            </button>
            <button type="button" onClick={closeForm} className={ghostBtn}>
              Cancelar
            </button>
            {form.shiftId && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="ml-auto rounded-lg px-3 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-50 disabled:opacity-40"
              >
                Borrar turno
              </button>
            )}
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Cargando…</p>
      ) : workers.length === 0 ? (
        <p className="text-sm text-gray-400">
          No hay operarios activos. Crea alguno en la pestaña Operarios.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200/60 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left">
                  <th className="w-40 border-b border-gray-100 px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
                    Operario
                  </th>
                  {weekDays.map((day) => (
                    <th
                      key={day}
                      className="border-b border-l border-gray-100 px-2 py-2.5 text-center font-normal"
                    >
                      <span className="block text-[11px] font-medium uppercase tracking-wider text-gray-400">
                        {formatWeekday(day)}
                      </span>
                      <span
                        className={`mx-auto mt-1 flex h-7 w-7 items-center justify-center rounded-full text-sm ${
                          day === today
                            ? "bg-gray-900 font-medium text-white"
                            : "text-gray-700"
                        }`}
                      >
                        {formatDayNumber(day)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 align-top text-sm font-medium text-gray-800">
                      {worker.full_name}
                    </td>
                    {weekDays.map((day) => {
                      const cellShifts = shifts.filter(
                        (shift) => shift.worker_id === worker.id && shift.date === day,
                      );
                      return (
                        <td
                          key={day}
                          onClick={() => openCreate(worker.id, day)}
                          className={`group h-20 min-w-28 cursor-pointer border-l border-gray-100 p-1.5 align-top transition-colors hover:bg-gray-50/70 ${
                            day === today ? "bg-gray-50/50" : ""
                          }`}
                          title="Crear turno"
                        >
                          <div className="space-y-1">
                            {cellShifts.map((shift) => (
                              <button
                                key={shift.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openEdit(shift);
                                }}
                                className="block w-full rounded-lg bg-blue-50 px-2 py-1.5 text-left text-xs leading-tight text-blue-700 ring-1 ring-inset ring-blue-100 transition-colors hover:bg-blue-100"
                                title="Editar turno"
                              >
                                <span className="font-medium">
                                  {formatShiftTime(shift.start_time)}–
                                  {formatShiftTime(shift.end_time)}
                                </span>
                                {shift.notified && (
                                  <span title="Aviso enviado"> ✓</span>
                                )}
                                <span className="block truncate text-blue-500">
                                  {centerName(shift.center_id)}
                                </span>
                              </button>
                            ))}
                            <span className="block text-center text-sm text-gray-300 opacity-0 transition-opacity group-hover:opacity-100">
                              +
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {centers.length === 0 && (
            <p className="border-t border-gray-100 px-4 py-3 text-sm text-amber-700">
              No hay centros creados: crea uno en la pestaña Centros antes de
              asignar turnos.
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400">
        Haz clic en una casilla para crear un turno, o en un turno existente
        para editarlo o borrarlo. ✓ = aviso de WhatsApp enviado.
      </p>
    </div>
  );
}
