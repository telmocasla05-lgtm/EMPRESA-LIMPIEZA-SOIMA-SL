"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  PageHeader,
  SectionTitle,
  StatusPill,
} from "@/components/design-import/dashboard";
import {
  ETIQUETA_ESTADO,
  SIGUIENTES_ESTADOS,
  TONO_ESTADO,
  notaDeCambioDeEstado,
  type EstadoIncidencia,
} from "@/lib/incidencias/estado";
import { ETIQUETAS_TIPO, type TipoIncidencia } from "@/lib/incidencias/tipos";
import { createClient } from "@/lib/supabase/client";
import { formatFechaHora } from "@/lib/dates";

export type IncidenciaDetallada = {
  id: string;
  company_id: string;
  type: TipoIncidencia;
  urgency: "alta" | "normal";
  status: EstadoIncidencia;
  description: string | null;
  photo_url: string | null;
  created_at: string;
  resolved_at: string | null;
  notified_at: string | null;
  notified_phone: string | null;
  workers: { full_name: string } | null;
  centers: { name: string } | null;
};

export type ActualizacionIncidencia = {
  id: string;
  note: string;
  created_at: string;
  profiles: { full_name: string } | null;
};

const CAMPOS_INCIDENCIA =
  "id, company_id, type, urgency, status, description, photo_url, created_at, " +
  "resolved_at, notified_at, notified_phone, workers ( full_name ), centers ( name )";

export function IncidenciaDetalle({
  inicial,
  actualizacionesIniciales,
}: {
  inicial: IncidenciaDetallada;
  actualizacionesIniciales: ActualizacionIncidencia[];
}) {
  const supabase = useMemo(() => createClient(), []);

  const [incidencia, setIncidencia] = useState(inicial);
  const [actualizaciones, setActualizaciones] = useState(actualizacionesIniciales);
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    const [{ data: fila }, { data: historial }] = await Promise.all([
      supabase.from("incidents").select(CAMPOS_INCIDENCIA).eq("id", inicial.id).maybeSingle(),
      supabase
        .from("incident_updates")
        .select("id, note, created_at, profiles ( full_name )")
        .eq("incident_id", inicial.id)
        .order("created_at", { ascending: true }),
    ]);

    if (fila) setIncidencia(fila as unknown as IncidenciaDetallada);
    setActualizaciones((historial ?? []) as unknown as ActualizacionIncidencia[]);
  }, [supabase, inicial.id]);

  // Realtime, igual que la vista Hoy, pero acotado a esta incidencia: si otro
  // jefe la cierra o escribe una nota mientras la tienes abierta, se ve aquí.
  useEffect(() => {
    const channel = supabase
      .channel(`incidencia-${inicial.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "incidents",
          filter: `id=eq.${inicial.id}`,
        },
        () => {
          recargar();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "incident_updates",
          filter: `incident_id=eq.${inicial.id}`,
        },
        () => {
          recargar();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, inicial.id, recargar]);

  // Toda nota lleva quién la escribió: es lo que hace auditable el historial.
  const anotar = useCallback(
    async (texto: string) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { error: errorInsert } = await supabase.from("incident_updates").insert({
        company_id: incidencia.company_id,
        incident_id: incidencia.id,
        note: texto,
        created_by: user?.id ?? null,
      });

      return errorInsert?.message ?? null;
    },
    [supabase, incidencia.company_id, incidencia.id],
  );

  async function guardarNota() {
    const texto = nota.trim();
    if (!texto) {
      setError("Escribe algo antes de guardar la nota.");
      return;
    }

    setGuardando(true);
    setError(null);
    setAviso(null);

    const fallo = await anotar(texto);
    if (fallo) setError(`No se pudo guardar la nota: ${fallo}`);
    else {
      setNota("");
      setAviso("Nota guardada.");
      await recargar();
    }
    setGuardando(false);
  }

  async function cambiarEstado(nuevo: EstadoIncidencia) {
    setGuardando(true);
    setError(null);
    setAviso(null);

    // resolved_at no es decorativo: la base exige que una incidencia resuelta
    // lo tenga, y al reabrirla hay que limpiarlo o quedaría una fecha de
    // cierre que ya no significa nada.
    const { error: errorUpdate } = await supabase
      .from("incidents")
      .update({
        status: nuevo,
        resolved_at: nuevo === "resolved" ? new Date().toISOString() : null,
      })
      .eq("id", incidencia.id);

    if (errorUpdate) {
      setError(`No se pudo cambiar el estado: ${errorUpdate.message}`);
      setGuardando(false);
      return;
    }

    // La nota se escribe después del cambio: al revés, un fallo al actualizar
    // dejaría en el historial un cambio que nunca ocurrió.
    const fallo = await anotar(notaDeCambioDeEstado(incidencia.status, nuevo, nota));
    if (fallo) {
      setError(
        `La incidencia pasó a "${ETIQUETA_ESTADO[nuevo]}", pero no se pudo guardar la ` +
          `nota en el historial: ${fallo}`,
      );
    } else {
      setNota("");
      setAviso(`Incidencia marcada como "${ETIQUETA_ESTADO[nuevo]}".`);
    }

    await recargar();
    setGuardando(false);
  }

  const siguientes = SIGUIENTES_ESTADOS[incidencia.status];

  return (
    <>
      <PageHeader
        title={ETIQUETAS_TIPO[incidencia.type]}
        meta={`Reportada el ${formatFechaHora(incidencia.created_at)}`}
      />

      <Link
        href="/dashboard/incidencias"
        className="-mt-4 self-start text-[15px] font-semibold text-[#6b6560] underline underline-offset-2"
      >
        ← Volver al listado
      </Link>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill tone={TONO_ESTADO[incidencia.status]}>
            {ETIQUETA_ESTADO[incidencia.status]}
          </StatusPill>
          {incidencia.urgency === "alta" ? (
            <span className="text-[15px] font-semibold text-[#b8240d]">🚨 Urgente</span>
          ) : null}
          {incidencia.type === "sin_clasificar" ? (
            <StatusPill tone="off">Pendiente de clasificar</StatusPill>
          ) : null}
          {!incidencia.notified_at ? (
            <StatusPill tone="warn">Aviso pendiente</StatusPill>
          ) : null}
        </div>

        <div className="rounded-2xl border border-[#e7e4e0] bg-white p-5 shadow-[0_1px_2px_rgba(22,19,15,.05)]">
          <dl className="m-0 grid gap-x-8 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <Dato etiqueta="Operario" valor={incidencia.workers?.full_name ?? "—"} />
            <Dato etiqueta="Centro" valor={incidencia.centers?.name ?? "Sin centro"} />
            <Dato
              etiqueta="Aviso por WhatsApp"
              valor={
                incidencia.notified_at
                  ? `${incidencia.notified_phone ?? "—"} · ${formatFechaHora(incidencia.notified_at)}`
                  : "No se ha podido avisar a nadie"
              }
            />
            <Dato
              etiqueta="Resuelta"
              valor={
                incidencia.resolved_at ? formatFechaHora(incidencia.resolved_at) : "Todavía no"
              }
            />
          </dl>

          <p className="m-0 mt-5 text-[13px] font-medium text-[#6b6560]">Descripción</p>
          <p className="m-0 mt-1.5 whitespace-pre-wrap text-[15px]">
            {incidencia.description?.trim() || "El operario no escribió nada: solo mandó la foto."}
          </p>
        </div>

        {incidencia.photo_url ? (
          // Misma razón que en la miniatura del listado: la URL va firmada a
          // 60 s y cambia con cada firma, así que next/image no puede con ella.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/incidencias/${incidencia.id}/foto`}
            alt={`Foto de la incidencia reportada por ${incidencia.workers?.full_name ?? "el operario"}`}
            className="max-h-[520px] w-full rounded-2xl border border-[#e7e4e0] bg-white object-contain"
          />
        ) : null}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Seguimiento</SectionTitle>

        <div className="rounded-2xl border border-[#e7e4e0] bg-white p-5 shadow-[0_1px_2px_rgba(22,19,15,.05)]">
          <label className="block text-[13px] font-medium text-[#6b6560]" htmlFor="nota">
            Nota
          </label>
          <textarea
            id="nota"
            rows={3}
            value={nota}
            onChange={(event) => setNota(event.target.value)}
            placeholder="Qué has hecho, qué falta, con quién has hablado…"
            className="mt-1.5 w-full rounded-xl border border-[#e7e4e0] px-3 py-2 text-[15px]
                       focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ec3013]"
          />
          <p className="m-0 mt-1.5 text-[13px] text-[#6b6560]">
            Si escribes una nota y cambias el estado, la nota se guarda junto al cambio.
          </p>

          <div className="mt-4 flex flex-wrap gap-2.5">
            <Button variant="secondary" onClick={guardarNota} disabled={guardando}>
              Guardar nota
            </Button>
            {siguientes.map((estado) => (
              <Button
                key={estado}
                variant={estado === "resolved" ? "primary" : "secondary"}
                onClick={() => cambiarEstado(estado)}
                disabled={guardando}
              >
                {`Marcar como ${ETIQUETA_ESTADO[estado].toLowerCase()}`}
              </Button>
            ))}
          </div>

          {error ? (
            <p role="alert" className="m-0 mt-4 text-[15px] text-[#b8240d]">
              {error}
            </p>
          ) : null}
          {aviso ? (
            <p role="status" className="m-0 mt-4 text-[15px] text-[#1f7a4d]">
              {aviso}
            </p>
          ) : null}
        </div>

        <SectionTitle>Historial</SectionTitle>

        {actualizaciones.length === 0 ? (
          <p className="m-0 text-[15px] text-[#6b6560]">
            Todavía no hay notas. La primera nota o el primer cambio de estado
            aparecerán aquí, con quién lo hizo.
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {actualizaciones.map((actualizacion) => (
              <li
                key={actualizacion.id}
                className="rounded-2xl border border-[#e7e4e0] bg-white px-5 py-4 shadow-[0_1px_2px_rgba(22,19,15,.05)]"
              >
                <p className="m-0 text-[13px] text-[#6b6560]">
                  {/* El perfil se pone a null si se borra el usuario: la nota
                      sobrevive, pero ya no sabemos de quién era. */}
                  {actualizacion.profiles?.full_name ?? "Usuario dado de baja"} ·{" "}
                  {formatFechaHora(actualizacion.created_at)}
                </p>
                <p className="m-0 mt-1.5 whitespace-pre-wrap text-[15px]">
                  {actualizacion.note}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <dt className="text-[13px] font-medium text-[#6b6560]">{etiqueta}</dt>
      <dd className="m-0 mt-1 text-[15px]">{valor}</dd>
    </div>
  );
}
