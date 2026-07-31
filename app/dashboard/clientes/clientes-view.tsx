"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { getOwnCompanyId } from "@/lib/supabase/company";

type ClientRow = {
  id: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  hourly_rate: number | null;
};

// Acepta coma o punto como separador decimal ("12,50" → 12.5).
function parseTarifa(raw: string): number | null | "invalida" {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return "invalida";
  return Math.round(value * 100) / 100;
}

const inputClass =
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:border-blue-300 focus:outline-none";

export function ClientesView() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [rate, setRate] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, contact_name, contact_phone, hourly_rate")
      .order("name");
    if (error) {
      setPageError(error.message);
    } else {
      setPageError(null);
      setRows((data ?? []) as ClientRow[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setName("");
    setContactName("");
    setContactPhone("");
    setRate("");
    setEditingId(null);
    setFormError(null);
  }

  function startEdit(client: ClientRow) {
    setEditingId(client.id);
    setName(client.name);
    setContactName(client.contact_name ?? "");
    setContactPhone(client.contact_phone ?? "");
    setRate(
      client.hourly_rate !== null ? String(client.hourly_rate).replace(".", ",") : "",
    );
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("El nombre del cliente es obligatorio.");
      return;
    }
    const tarifa = parseTarifa(rate);
    if (tarifa === "invalida") {
      setFormError("Tarifa no válida. Escribe un número, por ejemplo 14,50.");
      return;
    }

    const values = {
      name: trimmedName,
      contact_name: contactName.trim() || null,
      contact_phone: contactPhone.trim() || null,
      hourly_rate: tarifa,
    };

    setSaving(true);
    setFormError(null);
    try {
      const { error } = editingId
        ? await supabase.from("clients").update(values).eq("id", editingId)
        : await supabase.from("clients").insert({
            ...values,
            company_id: await getOwnCompanyId(supabase),
          });

      if (error) {
        setFormError(`No se pudo guardar: ${error.message}`);
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

  async function handleDelete(client: ClientRow) {
    const confirmed = window.confirm(
      `¿Eliminar el cliente "${client.name}"? Se eliminarán también sus centros de trabajo.`,
    );
    if (!confirmed) return;

    const { error } = await supabase.from("clients").delete().eq("id", client.id);
    if (error) {
      setPageError(`No se pudo eliminar: ${error.message}`);
      return;
    }
    if (editingId === client.id) resetForm();
    await load();
  }

  return (
    <div className="space-y-6">
      <h2 className="text-base font-medium tracking-tight text-gray-900">Clientes</h2>

      <form
        onSubmit={handleSubmit}
        className="max-w-2xl space-y-4 rounded-2xl bg-gray-50 p-5"
      >
        <h3 className="text-sm font-medium text-gray-900">
          {editingId ? "Editar cliente" : "Nuevo cliente"}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-gray-400">Nombre</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-gray-400">Tarifa por hora (€)</span>
            <input
              value={rate}
              onChange={(event) => setRate(event.target.value)}
              placeholder="14,50"
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-gray-400">Persona de contacto</span>
            <input
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-gray-400">Teléfono de contacto</span>
            <input
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        {formError && <p className="text-sm text-red-600">{formError}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-full bg-blue-100 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-200 disabled:opacity-50"
          >
            {saving ? "Guardando…" : editingId ? "Guardar cambios" : "Crear cliente"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-full px-4 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {pageError && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{pageError}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Todavía no hay clientes.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wider text-gray-400">
                <th className="py-2 pr-4 font-medium">Nombre</th>
                <th className="py-2 pr-4 font-medium">Contacto</th>
                <th className="py-2 pr-4 font-medium">Teléfono</th>
                <th className="py-2 pr-4 font-medium">Tarifa</th>
                <th className="py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((client) => (
                <tr key={client.id} className="border-b border-gray-50">
                  <td className="py-2 pr-4 font-medium">{client.name}</td>
                  <td className="py-2 pr-4">{client.contact_name ?? "—"}</td>
                  <td className="py-2 pr-4">{client.contact_phone ?? "—"}</td>
                  <td className="py-2 pr-4">
                    {client.hourly_rate !== null
                      ? `${client.hourly_rate.toLocaleString("es-ES", {
                          minimumFractionDigits: 2,
                        })} €/h`
                      : "—"}
                  </td>
                  <td className="py-2">
                    <span className="flex gap-2">
                      <button
                        onClick={() => startEdit(client)}
                        className="rounded-full px-2.5 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(client)}
                        className="rounded-full px-2.5 py-1 text-xs text-red-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      >
                        Eliminar
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
