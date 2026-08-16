"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EJEMPLOS_TIPO,
  ETIQUETAS_TIPO,
  TIPOS_CON_RESPONSABLE,
} from "@/lib/incidencias/tipos";
import { createClient } from "@/lib/supabase/client";
import { getOwnCompanyId } from "@/lib/supabase/company";

type Tipo = (typeof TIPOS_CON_RESPONSABLE)[number];

type ResponsableRow = {
  id: string;
  type: Tipo;
  name: string;
  phone: string;
};

// Lo que hay escrito en cada fila del formulario, tipo a tipo.
type Borrador = Record<Tipo, { name: string; phone: string }>;

const BORRADOR_VACIO = Object.fromEntries(
  TIPOS_CON_RESPONSABLE.map((tipo) => [tipo, { name: "", phone: "" }]),
) as Borrador;

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500";

export function ResponsablesView({
  esAdmin,
  telefonoEmpresa,
}: {
  esAdmin: boolean;
  telefonoEmpresa: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [borrador, setBorrador] = useState<Borrador>(BORRADOR_VACIO);
  const [guardados, setGuardados] = useState<Partial<Record<Tipo, ResponsableRow>>>({});
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<Tipo | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("incident_responsibles")
      .select("id, type, name, phone");

    if (error) {
      setPageError(error.message);
      setLoading(false);
      return;
    }

    const filas = (data ?? []) as ResponsableRow[];
    const porTipo: Partial<Record<Tipo, ResponsableRow>> = {};
    const nuevoBorrador = { ...BORRADOR_VACIO };

    for (const fila of filas) {
      porTipo[fila.type] = fila;
      nuevoBorrador[fila.type] = { name: fila.name, phone: fila.phone };
    }

    setPageError(null);
    setGuardados(porTipo);
    setBorrador(nuevoBorrador);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function editar(tipo: Tipo, campo: "name" | "phone", valor: string) {
    setBorrador((actual) => ({ ...actual, [tipo]: { ...actual[tipo], [campo]: valor } }));
    setAviso(null);
  }

  async function guardar(tipo: Tipo) {
    const name = borrador[tipo].name.trim();
    const phone = borrador[tipo].phone.trim();

    if (!name || !phone) {
      setPageError("Hacen falta el nombre y el teléfono para asignar un responsable.");
      return;
    }

    setGuardando(tipo);
    setPageError(null);
    try {
      // upsert por (company_id, type): la tabla solo admite un responsable por
      // tipo, así que guardar es crear o sustituir, nunca añadir otro.
      const { error } = await supabase.from("incident_responsibles").upsert(
        { company_id: await getOwnCompanyId(supabase), type: tipo, name, phone },
        { onConflict: "company_id,type" },
      );

      if (error) {
        setPageError(`No se pudo guardar: ${error.message}`);
        return;
      }
      setAviso(`Responsable de "${ETIQUETAS_TIPO[tipo]}" guardado.`);
      await load();
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setGuardando(null);
    }
  }

  async function quitar(tipo: Tipo) {
    const fila = guardados[tipo];
    if (!fila) return;

    const confirmado = window.confirm(
      `¿Quitar a ${fila.name} como responsable de "${ETIQUETAS_TIPO[tipo]}"?\n\n` +
        "A partir de ahora esas incidencias se avisarán al teléfono de la empresa.",
    );
    if (!confirmado) return;

    const { error } = await supabase
      .from("incident_responsibles")
      .delete()
      .eq("id", fila.id);

    if (error) {
      setPageError(`No se pudo quitar: ${error.message}`);
      return;
    }
    setBorrador((actual) => ({ ...actual, [tipo]: { name: "", phone: "" } }));
    setAviso(`"${ETIQUETAS_TIPO[tipo]}" pasa a avisarse al teléfono de la empresa.`);
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Incidencias · Responsables</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Cuando un operario reporta un problema por WhatsApp, el sistema lo
          clasifica y avisa por WhatsApp a la persona que indiques aquí, con el
          centro, la descripción y la foto si la hay.
        </p>
      </div>

      <div
        className={`max-w-2xl rounded-md p-3 text-sm ${
          telefonoEmpresa
            ? "bg-blue-50 text-blue-900"
            : "bg-amber-50 text-amber-900"
        }`}
      >
        {telefonoEmpresa ? (
          <>
            Los tipos que dejes en blanco se avisan al teléfono de la empresa
            (<strong>{telefonoEmpresa}</strong>), igual que las incidencias que
            la IA no consigue clasificar.
          </>
        ) : (
          <>
            Tu empresa no tiene teléfono configurado: si un tipo se queda sin
            responsable, <strong>esa incidencia no se avisará a nadie</strong>
            {" "}(quedará registrada en el panel). Añade el teléfono de la
            empresa o rellena los cuatro tipos.
          </>
        )}
      </div>

      {!esAdmin && (
        <p className="max-w-2xl rounded-md bg-gray-50 p-3 text-sm text-gray-600">
          Puedes consultar quién recibe cada aviso, pero solo un administrador
          puede cambiarlo.
        </p>
      )}

      {pageError && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{pageError}</p>
      )}
      {aviso && (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-800">{aviso}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Cargando…</p>
      ) : (
        <div className="max-w-3xl space-y-3">
          {TIPOS_CON_RESPONSABLE.map((tipo) => {
            const asignado = guardados[tipo];
            return (
              <div key={tipo} className="rounded-lg border border-gray-200 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{ETIQUETAS_TIPO[tipo]}</h3>
                  <span
                    className={`text-xs ${asignado ? "text-green-700" : "text-amber-700"}`}
                  >
                    {asignado
                      ? `Avisa a ${asignado.name}`
                      : "Sin responsable: avisa a la empresa"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{EJEMPLOS_TIPO[tipo]}</p>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-gray-500">Nombre</span>
                    <input
                      value={borrador[tipo].name}
                      onChange={(event) => editar(tipo, "name", event.target.value)}
                      placeholder="Marta Ruiz"
                      disabled={!esAdmin}
                      className={inputClass}
                    />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-gray-500">
                      Teléfono de WhatsApp
                    </span>
                    <input
                      value={borrador[tipo].phone}
                      onChange={(event) => editar(tipo, "phone", event.target.value)}
                      placeholder="+34600111222"
                      disabled={!esAdmin}
                      className={inputClass}
                    />
                  </label>
                </div>

                {esAdmin && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => guardar(tipo)}
                      disabled={guardando === tipo}
                      className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {guardando === tipo ? "Guardando…" : "Guardar"}
                    </button>
                    {asignado && (
                      <button
                        onClick={() => quitar(tipo)}
                        className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                      >
                        Quitar
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
