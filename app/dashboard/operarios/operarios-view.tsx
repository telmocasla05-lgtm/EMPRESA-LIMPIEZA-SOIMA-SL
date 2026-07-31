"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { getOwnCompanyId } from "@/lib/supabase/company";

type WorkerRow = {
  id: string;
  full_name: string;
  phone: string;
  active: boolean;
};

// Normaliza a formato +34600111222; el flujo de WhatsApp casa con y sin "+".
function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s.-]/g, "");
  if (/^\+\d{9,15}$/.test(compact)) return compact;
  if (/^[679]\d{8}$/.test(compact)) return `+34${compact}`;
  if (/^34\d{9}$/.test(compact)) return `+${compact}`;
  return null;
}

const inputClass =
  "w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 transition-colors focus:border-gray-900 focus:outline-none";
const labelClass = "mb-1.5 block text-xs font-medium text-gray-500";
const primaryBtn =
  "rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40";
const ghostBtn =
  "rounded-lg px-3 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";
const tinyBtn =
  "rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";

export function OperariosView() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<WorkerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("workers")
      .select("id, full_name, phone, active")
      .order("full_name");
    if (error) {
      setPageError(error.message);
    } else {
      setPageError(null);
      setRows((data ?? []) as WorkerRow[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setFullName("");
    setPhone("");
    setEditingId(null);
    setFormError(null);
  }

  function startEdit(worker: WorkerRow) {
    setEditingId(worker.id);
    setFullName(worker.full_name);
    setPhone(worker.phone);
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = fullName.trim();
    if (!name) {
      setFormError("El nombre es obligatorio.");
      return;
    }
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      setFormError("Teléfono no válido. Usa el formato +34600111222 o 600111222.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const { error } = editingId
        ? await supabase
            .from("workers")
            .update({ full_name: name, phone: normalizedPhone })
            .eq("id", editingId)
        : await supabase.from("workers").insert({
            company_id: await getOwnCompanyId(supabase),
            full_name: name,
            phone: normalizedPhone,
          });

      if (error) {
        setFormError(
          error.code === "23505"
            ? "Ya existe un operario con ese teléfono en tu empresa."
            : `No se pudo guardar: ${error.message}`,
        );
        return;
      }
      resetForm();
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(worker: WorkerRow) {
    const { error } = await supabase
      .from("workers")
      .update({ active: !worker.active })
      .eq("id", worker.id);
    if (error) {
      setPageError(`No se pudo actualizar: ${error.message}`);
      return;
    }
    await load();
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-medium tracking-tight text-gray-900">
          Operarios
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Tu equipo y sus números de WhatsApp para fichar.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="max-w-xl space-y-4 rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm"
      >
        <h3 className="text-sm font-medium text-gray-900">
          {editingId ? "Editar operario" : "Nuevo operario"}
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className={labelClass}>Nombre</span>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className={labelClass}>Teléfono (WhatsApp)</span>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+34600111222"
              className={inputClass}
            />
          </label>
        </div>
        {formError && <p className="text-sm text-red-500">{formError}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className={primaryBtn}>
            {saving ? "Guardando…" : editingId ? "Guardar cambios" : "Crear operario"}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm} className={ghostBtn}>
              Cancelar
            </button>
          )}
        </div>
      </form>

      {pageError && (
        <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
          {pageError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400">Todavía no hay operarios.</p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200/60 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">
                  <th className="px-5 py-3 font-medium">Nombre</th>
                  <th className="px-5 py-3 font-medium">Teléfono</th>
                  <th className="px-5 py-3 font-medium">Estado</th>
                  <th className="px-5 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((worker) => (
                  <tr
                    key={worker.id}
                    className={`transition-colors hover:bg-gray-50/60 ${
                      worker.active ? "" : "text-gray-400"
                    }`}
                  >
                    <td className="px-5 py-3 font-medium">{worker.full_name}</td>
                    <td className="px-5 py-3">{worker.phone}</td>
                    <td className="px-5 py-3">
                      {worker.active ? (
                        <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                          activo
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-400">
                          desactivado
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="flex gap-1">
                        <button onClick={() => startEdit(worker)} className={tinyBtn}>
                          Editar
                        </button>
                        <button onClick={() => toggleActive(worker)} className={tinyBtn}>
                          {worker.active ? "Desactivar" : "Reactivar"}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
