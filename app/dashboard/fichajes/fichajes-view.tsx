"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  formatHora,
  madridDateOf,
  madridDayStart,
  madridInstant,
  madridNextDayStart,
  madridToday,
} from "@/lib/dates";

type FichajeRow = {
  id: string;
  worker_id: string;
  center_id: string | null;
  type: "entrada" | "salida";
  valid: boolean;
  created_at: string;
  edited_at: string | null;
  workers: { full_name: string } | null;
  centers: { name: string } | null;
  edited_by_profile: { full_name: string } | null;
};

type Option = { id: string; name: string };

type EditForm = {
  type: "entrada" | "salida";
  centerId: string;
  valid: boolean;
  hora: string;
};

export function FichajesView() {
  const supabase = useMemo(() => createClient(), []);

  const [date, setDate] = useState(() => madridToday());
  const [workerId, setWorkerId] = useState("");
  const [centerId, setCenterId] = useState("");

  const [workers, setWorkers] = useState<Option[]>([]);
  const [centers, setCenters] = useState<Option[]>([]);
  const [rows, setRows] = useState<FichajeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadOptions() {
      const [workersResult, centersResult] = await Promise.all([
        supabase.from("workers").select("id, full_name").order("full_name"),
        supabase.from("centers").select("id, name").order("name"),
      ]);
      setWorkers(
        (workersResult.data ?? []).map((w) => ({ id: w.id, name: w.full_name })),
      );
      setCenters(
        (centersResult.data ?? []).map((c) => ({ id: c.id, name: c.name })),
      );
    }
    loadOptions();
  }, [supabase]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("time_entries")
      .select(
        "id, worker_id, center_id, type, valid, created_at, edited_at, workers ( full_name ), centers ( name ), edited_by_profile:profiles ( full_name )",
      )
      .gte("created_at", madridDayStart(date).toISOString())
      .lt("created_at", madridNextDayStart(date).toISOString())
      .order("created_at", { ascending: false });

    if (workerId) query = query.eq("worker_id", workerId);
    if (centerId) query = query.eq("center_id", centerId);

    const { data, error: fetchError } = await query;
    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }
    setError(null);
    setRows((data ?? []) as unknown as FichajeRow[]);
    setLoading(false);
  }, [supabase, date, workerId, centerId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  function startEdit(row: FichajeRow) {
    setEditingId(row.id);
    setEditForm({
      type: row.type,
      centerId: row.center_id ?? "",
      valid: row.valid,
      hora: formatHora(row.created_at),
    });
  }

  async function saveEdit(row: FichajeRow) {
    if (!editForm) return;
    setSaving(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const createdAt = madridInstant(
      madridDateOf(row.created_at),
      editForm.hora,
    ).toISOString();

    const { error: updateError } = await supabase
      .from("time_entries")
      .update({
        type: editForm.type,
        center_id: editForm.centerId || null,
        valid: editForm.valid,
        created_at: createdAt,
        edited_by: user?.id ?? null,
        edited_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    setSaving(false);
    if (updateError) {
      setError(`No se pudo guardar la corrección: ${updateError.message}`);
      return;
    }
    setError(null);
    setEditingId(null);
    setEditForm(null);
    await fetchRows();
  }

  const inputClass =
    "rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Histórico de fichajes</h2>

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="mb-1 block text-gray-500">Fecha</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-gray-500">Operario</span>
          <select
            value={workerId}
            onChange={(event) => setWorkerId(event.target.value)}
            className={inputClass}
          >
            <option value="">Todos</option>
            {workers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-gray-500">Centro</span>
          <select
            value={centerId}
            onChange={(event) => setCenterId(event.target.value)}
            className={inputClass}
          >
            <option value="">Todos</option>
            {centers.map((center) => (
              <option key={center.id} value={center.id}>
                {center.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">
          No hay fichajes para los filtros elegidos.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-2 pr-4 font-medium">Hora</th>
                <th className="py-2 pr-4 font-medium">Operario</th>
                <th className="py-2 pr-4 font-medium">Centro</th>
                <th className="py-2 pr-4 font-medium">Tipo</th>
                <th className="py-2 pr-4 font-medium">Estado</th>
                <th className="py-2 pr-4 font-medium">Editado por</th>
                <th className="py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const editing = editingId === row.id && editForm;
                return (
                  <tr
                    key={row.id}
                    className={
                      row.valid
                        ? "border-b border-gray-100"
                        : "border-b border-gray-100 bg-amber-50"
                    }
                  >
                    <td className="py-2 pr-4">
                      {editing ? (
                        <input
                          type="time"
                          value={editForm.hora}
                          onChange={(event) =>
                            setEditForm({ ...editForm, hora: event.target.value })
                          }
                          className={inputClass}
                        />
                      ) : (
                        formatHora(row.created_at)
                      )}
                    </td>
                    <td className="py-2 pr-4 font-medium">
                      {row.workers?.full_name ?? "(sin nombre)"}
                    </td>
                    <td className="py-2 pr-4">
                      {editing ? (
                        <select
                          value={editForm.centerId}
                          onChange={(event) =>
                            setEditForm({
                              ...editForm,
                              centerId: event.target.value,
                            })
                          }
                          className={inputClass}
                        >
                          <option value="">(sin centro)</option>
                          {centers.map((center) => (
                            <option key={center.id} value={center.id}>
                              {center.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (row.centers?.name ?? "(sin centro)")
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editing ? (
                        <select
                          value={editForm.type}
                          onChange={(event) =>
                            setEditForm({
                              ...editForm,
                              type: event.target.value as "entrada" | "salida",
                            })
                          }
                          className={inputClass}
                        >
                          <option value="entrada">entrada</option>
                          <option value="salida">salida</option>
                        </select>
                      ) : (
                        row.type
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editing ? (
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={editForm.valid}
                            onChange={(event) =>
                              setEditForm({
                                ...editForm,
                                valid: event.target.checked,
                              })
                            }
                          />
                          válido
                        </label>
                      ) : row.valid ? (
                        <span className="text-green-700">válido</span>
                      ) : (
                        <span className="font-medium text-amber-700">
                          revisión
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-gray-500">
                      {row.edited_by_profile
                        ? `${row.edited_by_profile.full_name} (${formatHora(row.edited_at!)})`
                        : "—"}
                    </td>
                    <td className="py-2">
                      {editing ? (
                        <span className="flex gap-2">
                          <button
                            onClick={() => saveEdit(row)}
                            disabled={saving}
                            className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {saving ? "Guardando…" : "Guardar"}
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(null);
                              setEditForm(null);
                            }}
                            className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                          >
                            Cancelar
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => startEdit(row)}
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                        >
                          Corregir
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
