"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EmptyState,
  PageHeader,
  SectionTitle,
  Skeleton,
  StatusPill,
} from "@/components/design-import/dashboard";
import { formatFechaHora, madridDayStart, madridNextDayStart } from "@/lib/dates";
import {
  ETIQUETA_ESTADO,
  ESTADOS,
  TONO_ESTADO,
  type EstadoIncidencia,
} from "@/lib/incidencias/estado";
import { ETIQUETAS_TIPO, TIPOS, type TipoIncidencia } from "@/lib/incidencias/tipos";
import { createClient } from "@/lib/supabase/client";

export type IncidenciaFila = {
  id: string;
  type: TipoIncidencia;
  urgency: "alta" | "normal";
  status: EstadoIncidencia;
  description: string | null;
  photo_url: string | null;
  created_at: string;
  notified_at: string | null;
  center_id: string | null;
  workers: { full_name: string } | null;
  centers: { name: string } | null;
};

type Centro = { id: string; name: string };

// "sin_resolver" no es un valor de la columna: agrupa abierta + en curso, que
// es con lo que trabaja el jefe. Es el filtro por defecto (SPEC 6.1).
export type FiltroEstado = "sin_resolver" | "todas" | EstadoIncidencia;

const FILTROS_ESTADO: { valor: FiltroEstado; etiqueta: string }[] = [
  { valor: "sin_resolver", etiqueta: "Sin resolver" },
  { valor: "todas", etiqueta: "Todos los estados" },
  ...ESTADOS.map((estado) => ({ valor: estado, etiqueta: ETIQUETA_ESTADO[estado] })),
];

const selectClass =
  "rounded-xl border border-[#e7e4e0] bg-white px-3 py-2 text-[15px] text-[#16130f] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ec3013]";

// Lo que cabe en la columna Resumen sin romper la tabla (SPEC 6.1).
const LARGO_RESUMEN = 80;

export function resumenDescripcion(description: string | null): string {
  const texto = description?.trim();
  if (!texto) return "(sin descripción)";
  return texto.length > LARGO_RESUMEN
    ? `${texto.slice(0, LARGO_RESUMEN).trimEnd()}…`
    : texto;
}

// Las urgentes arriba y, dentro de cada grupo, la más reciente primero. Se
// ordena aquí y no en la consulta para no depender de que 'alta' preceda a
// 'normal' por alfabeto.
export function ordenarIncidencias(filas: IncidenciaFila[]): IncidenciaFila[] {
  return [...filas].sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === "alta" ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

export function IncidenciasView({ estadoInicial }: { estadoInicial: FiltroEstado }) {
  const supabase = useMemo(() => createClient(), []);

  const [filas, setFilas] = useState<IncidenciaFila[]>([]);
  const [centros, setCentros] = useState<Centro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [estado, setEstado] = useState<FiltroEstado>(estadoInicial);
  const [tipo, setTipo] = useState<"todos" | TipoIncidencia>("todos");
  const [centro, setCentro] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  const cargar = useCallback(async () => {
    let consulta = supabase
      .from("incidents")
      .select(
        "id, type, urgency, status, description, photo_url, created_at, notified_at, " +
          "center_id, workers ( full_name ), centers ( name )",
      );

    if (estado === "sin_resolver") consulta = consulta.neq("status", "resolved");
    else if (estado !== "todas") consulta = consulta.eq("status", estado);

    if (tipo !== "todos") consulta = consulta.eq("type", tipo);

    // "sin_centro" es una opción real del filtro: una incidencia reportada sin
    // fichaje abierto no tiene centro, y son justo las que hay que repasar.
    if (centro === "sin_centro") consulta = consulta.is("center_id", null);
    else if (centro) consulta = consulta.eq("center_id", centro);

    // Las fechas del formulario son días de Madrid; en la base hay instantes
    // UTC, así que el rango va del inicio del día "desde" al inicio del día
    // siguiente a "hasta" (ambos incluidos para quien lo rellena).
    if (desde) consulta = consulta.gte("created_at", madridDayStart(desde).toISOString());
    if (hasta) consulta = consulta.lt("created_at", madridNextDayStart(hasta).toISOString());

    const { data, error: errorConsulta } = await consulta.order("created_at", {
      ascending: false,
    });

    if (errorConsulta) setError(errorConsulta.message);
    else {
      setError(null);
      setFilas(ordenarIncidencias((data ?? []) as unknown as IncidenciaFila[]));
    }
    setLoading(false);
  }, [supabase, estado, tipo, centro, desde, hasta]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    async function cargarCentros() {
      const { data } = await supabase.from("centers").select("id, name").order("name");
      setCentros((data ?? []) as Centro[]);
    }
    cargarCentros();
  }, [supabase]);

  // Realtime, igual que la vista Hoy: cualquier cambio en las incidencias de
  // la company (otro jefe cerrando una, o el webhook dando de alta otra nueva)
  // reaparece aquí sin recargar.
  useEffect(() => {
    const channel = supabase
      .channel("incidencias-listado")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        () => {
          cargar();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, cargar]);

  const urgentes = filas.filter((fila) => fila.urgency === "alta").length;

  return (
    <>
      <PageHeader
        title="Incidencias"
        meta={
          loading
            ? undefined
            : `${filas.length} incidencia(s)${urgentes > 0 ? ` · ${urgentes} urgente(s)` : ""}`
        }
      />

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle>Listado</SectionTitle>
          <Link
            href="/dashboard/incidencias/responsables"
            className="text-[15px] font-semibold text-[#16130f] underline underline-offset-2"
          >
            Responsables de aviso
          </Link>
        </div>

        <div className="flex flex-wrap gap-3">
          <label className="sr-only" htmlFor="filtro-estado">
            Filtrar por estado
          </label>
          <select
            id="filtro-estado"
            className={selectClass}
            value={estado}
            onChange={(event) => setEstado(event.target.value as FiltroEstado)}
          >
            {FILTROS_ESTADO.map((opcion) => (
              <option key={opcion.valor} value={opcion.valor}>
                {opcion.etiqueta}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="filtro-tipo">
            Filtrar por tipo
          </label>
          <select
            id="filtro-tipo"
            className={selectClass}
            value={tipo}
            onChange={(event) => setTipo(event.target.value as "todos" | TipoIncidencia)}
          >
            <option value="todos">Todos los tipos</option>
            {TIPOS.map((valor) => (
              <option key={valor} value={valor}>
                {ETIQUETAS_TIPO[valor]}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="filtro-centro">
            Filtrar por centro
          </label>
          <select
            id="filtro-centro"
            className={selectClass}
            value={centro}
            onChange={(event) => setCentro(event.target.value)}
          >
            <option value="">Todos los centros</option>
            <option value="sin_centro">Sin centro</option>
            {centros.map((opcion) => (
              <option key={opcion.id} value={opcion.id}>
                {opcion.name}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-[15px] text-[#6b6560]">
            Desde
            <input
              type="date"
              className={selectClass}
              value={desde}
              max={hasta || undefined}
              onChange={(event) => setDesde(event.target.value)}
            />
          </label>

          <label className="flex items-center gap-2 text-[15px] text-[#6b6560]">
            Hasta
            <input
              type="date"
              className={selectClass}
              value={hasta}
              min={desde || undefined}
              onChange={(event) => setHasta(event.target.value)}
            />
          </label>
        </div>

        {error ? (
          <p role="alert" className="m-0 text-[15px] text-[#b8240d]">
            {error}
          </p>
        ) : null}

        {loading ? (
          <Skeleton className="h-[220px]" />
        ) : filas.length === 0 ? (
          <EmptyState
            tone="ok"
            title="No hay incidencias con esos filtros."
            body="Cuando un operario reporte un problema por WhatsApp, aparecerá aquí al instante."
          />
        ) : (
          <>
            {/* escritorio */}
            <div className="hidden overflow-hidden rounded-2xl border border-[#e7e4e0] bg-white shadow-[0_1px_2px_rgba(22,19,15,.05)] min-[901px]:block">
              <table className="w-full border-separate border-spacing-0 text-[15px]">
                <thead>
                  <tr>
                    {["Foto", "Estado", "Tipo", "Centro", "Operario", "Resumen", "Fecha", ""].map(
                      (encabezado, indice) => (
                        <th
                          key={`${encabezado}-${indice}`}
                          scope="col"
                          className="border-b border-[#e7e4e0] bg-[#fcfcfd] px-4 py-[13px] text-left text-[13px] font-semibold text-[#6b6560]"
                        >
                          {encabezado}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filas.map((fila, indice) => {
                    const borde =
                      indice === filas.length - 1 ? "" : "border-b border-[#f1f0ee]";
                    return (
                      <tr
                        key={fila.id}
                        className="transition-colors duration-150 hover:bg-[#fcfcfd]"
                      >
                        <td className={`px-4 py-[15px] ${borde}`}>
                          <Miniatura incidencia={fila} />
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          <div className="flex flex-col items-start gap-1">
                            <StatusPill tone={TONO_ESTADO[fila.status]}>
                              {ETIQUETA_ESTADO[fila.status]}
                            </StatusPill>
                            {fila.urgency === "alta" ? (
                              <span className="text-[13px] font-semibold text-[#b8240d]">
                                🚨 Urgente
                              </span>
                            ) : null}
                            {!fila.notified_at ? (
                              <span className="text-[13px] text-[#8a5a18]">
                                Aviso pendiente
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          <span
                            className={
                              fila.type === "sin_clasificar" ? "text-[#6b6560]" : "font-semibold"
                            }
                          >
                            {ETIQUETAS_TIPO[fila.type]}
                          </span>
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          {fila.centers?.name ?? "—"}
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          {fila.workers?.full_name ?? "—"}
                        </td>
                        <td className={`max-w-[320px] px-4 py-[15px] ${borde}`}>
                          {resumenDescripcion(fila.description)}
                        </td>
                        <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                          {formatFechaHora(fila.created_at)}
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          <Link
                            href={`/dashboard/incidencias/${fila.id}`}
                            className="font-semibold text-[#16130f] underline underline-offset-2"
                          >
                            Ver
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* móvil */}
            <div className="flex flex-col gap-3 min-[901px]:hidden">
              {filas.map((fila) => (
                <Link
                  key={fila.id}
                  href={`/dashboard/incidencias/${fila.id}`}
                  className="flex gap-3 rounded-2xl border border-[#e7e4e0] bg-white p-4 no-underline shadow-[0_1px_2px_rgba(22,19,15,.05)]"
                >
                  <Miniatura incidencia={fila} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-base font-bold text-[#16130f]">
                        {ETIQUETAS_TIPO[fila.type]}
                      </span>
                      <StatusPill tone={TONO_ESTADO[fila.status]}>
                        {ETIQUETA_ESTADO[fila.status]}
                      </StatusPill>
                    </div>
                    <p className="m-0 mt-1.5 text-sm text-[#16130f]">
                      {resumenDescripcion(fila.description)}
                    </p>
                    <p className="m-0 mt-1.5 text-sm text-[#6b6560]">
                      {fila.centers?.name ?? "Sin centro"} ·{" "}
                      {fila.workers?.full_name ?? "—"} · {formatFechaHora(fila.created_at)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}

// El bucket es privado: la miniatura pasa por el route handler, que valida la
// sesión y firma la URL. Sin foto se deja el hueco marcado, para que la
// columna no baile de fila en fila.
function Miniatura({ incidencia }: { incidencia: IncidenciaFila }) {
  if (!incidencia.photo_url) {
    return (
      <span className="flex h-14 w-14 flex-none items-center justify-center rounded-xl border border-dashed border-[#e7e4e0] text-[11px] text-[#6b6560]">
        sin foto
      </span>
    );
  }

  // La foto llega por redirección a una URL firmada de 60 s: next/image no
  // puede optimizar un host que cambia con cada firma, así que va un <img>.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/incidencias/${incidencia.id}/foto`}
      alt={`Foto de la incidencia de ${incidencia.workers?.full_name ?? "un operario"}`}
      className="h-14 w-14 flex-none rounded-xl border border-[#e7e4e0] object-cover"
    />
  );
}
