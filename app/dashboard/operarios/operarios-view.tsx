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
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

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
      <h2 className="text-lg font-semibold">Operarios</h2>

      <form
        onSubmit={handleSubmit}
        className="max-w-xl space-y-3 rounded-lg border border-gray-200 p-4"
      >
        <h3 className="text-sm font-semibold">
          {editingId ? "Editar operario" : "Nuevo operario"}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Nombre</span>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Teléfono (WhatsApp)</span>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+34600111222"
              className={inputClass}
            />
          </label>
        </div>
        {formError && <p className="text-sm text-red-600">{formError}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Guardando…" : editingId ? "Guardar cambios" : "Crear operario"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {pageError && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{pageError}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Todavía no hay operarios.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-2 pr-4 font-medium">Nombre</th>
                <th className="py-2 pr-4 font-medium">Teléfono</th>
                <th className="py-2 pr-4 font-medium">Estado</th>
                <th className="py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((worker) => (
                <tr
                  key={worker.id}
                  className={
                    worker.active
                      ? "border-b border-gray-100"
                      : "border-b border-gray-100 text-gray-400"
                  }
                >
                  <td className="py-2 pr-4 font-medium">{worker.full_name}</td>
                  <td className="py-2 pr-4">{worker.phone}</td>
                  <td className="py-2 pr-4">
                    {worker.active ? (
                      <span className="text-green-700">activo</span>
                    ) : (
                      <span>desactivado</span>
                    )}
                  </td>
                  <td className="py-2">
                    <span className="flex gap-2">
                      <button
                        onClick={() => startEdit(worker)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900 hover:bg-gray-50"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => toggleActive(worker)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900 hover:bg-gray-50"
                      >
                        {worker.active ? "Desactivar" : "Reactivar"}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
