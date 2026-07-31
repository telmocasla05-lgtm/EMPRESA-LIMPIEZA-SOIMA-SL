"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { getOwnCompanyId } from "@/lib/supabase/company";
import { isShortMapsLink, parseCoordinates } from "@/lib/maps";

type CenterRow = {
  id: string;
  client_id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
  clients: { name: string } | null;
};

type ClientOption = { id: string; name: string };

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

export function CentrosView() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<CenterRow[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [mapsInput, setMapsInput] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [radius, setRadius] = useState("200");
  const [coordsMsg, setCoordsMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [centersResult, clientsResult] = await Promise.all([
      supabase
        .from("centers")
        .select(
          "id, client_id, name, address, latitude, longitude, radius_meters, clients ( name )",
        )
        .order("name"),
      supabase.from("clients").select("id, name").order("name"),
    ]);

    if (centersResult.error) {
      setPageError(centersResult.error.message);
    } else {
      setPageError(null);
      setRows((centersResult.data ?? []) as unknown as CenterRow[]);
    }
    setClients((clientsResult.data ?? []) as ClientOption[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setClientId("");
    setName("");
    setAddress("");
    setMapsInput("");
    setLatitude("");
    setLongitude("");
    setRadius("200");
    setCoordsMsg(null);
    setEditingId(null);
    setFormError(null);
  }

  function startEdit(center: CenterRow) {
    setEditingId(center.id);
    setClientId(center.client_id);
    setName(center.name);
    setAddress(center.address ?? "");
    setMapsInput("");
    setLatitude(center.latitude !== null ? String(center.latitude) : "");
    setLongitude(center.longitude !== null ? String(center.longitude) : "");
    setRadius(String(center.radius_meters));
    setCoordsMsg(null);
    setFormError(null);
  }

  function handleMapsInput(value: string) {
    setMapsInput(value);
    if (!value.trim()) {
      setCoordsMsg(null);
      return;
    }
    if (isShortMapsLink(value)) {
      setCoordsMsg({
        ok: false,
        text: "Eso es un enlace corto. Ábrelo en el navegador y copia aquí la URL completa de la barra de direcciones.",
      });
      return;
    }
    const coords = parseCoordinates(value);
    if (coords) {
      setLatitude(String(coords.latitude));
      setLongitude(String(coords.longitude));
      setCoordsMsg({
        ok: true,
        text: `Coordenadas extraídas: ${coords.latitude}, ${coords.longitude}`,
      });
    } else {
      setCoordsMsg({
        ok: false,
        text: "No se encontraron coordenadas en ese enlace.",
      });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!clientId) {
      setFormError("Elige el cliente al que pertenece el centro.");
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("El nombre del centro es obligatorio.");
      return;
    }

    const lat = Number(latitude.replace(",", "."));
    const lng = Number(longitude.replace(",", "."));
    if (
      !latitude.trim() ||
      !longitude.trim() ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      setFormError(
        "Faltan las coordenadas o no son válidas. Pega un enlace de Google Maps para rellenarlas.",
      );
      return;
    }

    const radiusValue = Number(radius);
    if (!Number.isInteger(radiusValue) || radiusValue < 10 || radiusValue > 10000) {
      setFormError("El radio debe ser un número entero entre 10 y 10000 metros.");
      return;
    }

    const values = {
      client_id: clientId,
      name: trimmedName,
      address: address.trim() || null,
      latitude: lat,
      longitude: lng,
      radius_meters: radiusValue,
    };

    setSaving(true);
    setFormError(null);
    try {
      const { error } = editingId
        ? await supabase.from("centers").update(values).eq("id", editingId)
        : await supabase.from("centers").insert({
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

  async function handleDelete(center: CenterRow) {
    const confirmed = window.confirm(
      `¿Eliminar el centro "${center.name}"? Los fichajes antiguos se conservarán, pero sin centro asociado.`,
    );
    if (!confirmed) return;

    const { error } = await supabase.from("centers").delete().eq("id", center.id);
    if (error) {
      setPageError(`No se pudo eliminar: ${error.message}`);
      return;
    }
    if (editingId === center.id) resetForm();
    await load();
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Centros de trabajo</h2>

      <form
        onSubmit={handleSubmit}
        className="max-w-2xl space-y-3 rounded-lg border border-gray-200 p-4"
      >
        <h3 className="text-sm font-semibold">
          {editingId ? "Editar centro" : "Nuevo centro"}
        </h3>

        {clients.length === 0 && !loading && (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
            Primero crea un cliente en la pestaña Clientes: cada centro
            pertenece a un cliente.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Cliente</span>
            <select
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              className={inputClass}
            >
              <option value="">Elige un cliente…</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Nombre del centro</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Oficinas centrales"
              className={inputClass}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-gray-500">Dirección</span>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-gray-500">
              Enlace de Google Maps (o coordenadas &quot;lat, lng&quot;)
            </span>
            <input
              value={mapsInput}
              onChange={(event) => handleMapsInput(event.target.value)}
              placeholder="https://www.google.com/maps/place/…"
              className={inputClass}
            />
            {coordsMsg && (
              <span
                className={`mt-1 block ${coordsMsg.ok ? "text-green-700" : "text-red-600"}`}
              >
                {coordsMsg.text}
              </span>
            )}
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Latitud</span>
            <input
              value={latitude}
              onChange={(event) => setLatitude(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Longitud</span>
            <input
              value={longitude}
              onChange={(event) => setLongitude(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-500">Radio (metros)</span>
            <input
              value={radius}
              onChange={(event) => setRadius(event.target.value)}
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
            {saving ? "Guardando…" : editingId ? "Guardar cambios" : "Crear centro"}
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
        <p className="text-sm text-gray-500">Todavía no hay centros.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-2 pr-4 font-medium">Nombre</th>
                <th className="py-2 pr-4 font-medium">Cliente</th>
                <th className="py-2 pr-4 font-medium">Dirección</th>
                <th className="py-2 pr-4 font-medium">Coordenadas</th>
                <th className="py-2 pr-4 font-medium">Radio</th>
                <th className="py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((center) => (
                <tr key={center.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{center.name}</td>
                  <td className="py-2 pr-4">{center.clients?.name ?? "—"}</td>
                  <td className="py-2 pr-4">{center.address ?? "—"}</td>
                  <td className="py-2 pr-4">
                    {center.latitude !== null && center.longitude !== null
                      ? `${center.latitude}, ${center.longitude}`
                      : "sin coordenadas"}
                  </td>
                  <td className="py-2 pr-4">{center.radius_meters} m</td>
                  <td className="py-2">
                    <span className="flex gap-2">
                      <button
                        onClick={() => startEdit(center)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(center)}
                        className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
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
