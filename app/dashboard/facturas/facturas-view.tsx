"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import {
  Button,
  EmptyState,
  PageHeader,
  SectionTitle,
  Skeleton,
  StatusPill,
} from "@/components/design-import/dashboard";
import { eurosACentimos, formatEuros, formatHoras, formatMes } from "@/lib/billing/importes";
import { previousMonth, madridToday } from "@/lib/dates";
import { createClient } from "@/lib/supabase/client";
import { generarAhoraAction } from "./actions";
import {
  ETIQUETA_ESTADO,
  TONO_ESTADO,
  estadoDeFactura,
  estaVencida,
  type EstadoFactura,
} from "./estado";

type FacturaRow = {
  id: string;
  invoice_number: string | null;
  client_id: string;
  client_name: string;
  period_start: string;
  status: string;
  paid_at: string | null;
  due_date: string | null;
  total_hours: number;
  subtotal: number;
  vat_amount: number;
  total: number;
};

type Cliente = { id: string; name: string };

const FILTROS_ESTADO: { valor: "todas" | EstadoFactura; etiqueta: string }[] = [
  { valor: "todas", etiqueta: "Todos los estados" },
  { valor: "borrador", etiqueta: "Borrador" },
  { valor: "emitida", etiqueta: "Emitida (sin cobrar)" },
  { valor: "cobrada", etiqueta: "Cobrada" },
  { valor: "anulada", etiqueta: "Anulada" },
];

const selectClass =
  "rounded-xl border border-[#e7e4e0] bg-white px-3 py-2 text-[15px] text-[#16130f] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ec3013]";

const euros = (valor: number) => formatEuros(eurosACentimos(Number(valor)));

export function FacturasView() {
  const supabase = useMemo(() => createClient(), []);

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [periodos, setPeriodos] = useState<string[]>([]);
  const [rows, setRows] = useState<FacturaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clienteId, setClienteId] = useState("");
  const [periodo, setPeriodo] = useState("");
  const [estado, setEstado] = useState<"todas" | EstadoFactura>("todas");

  // "Generar ahora": por defecto el mes anterior, que es el que cierra el cron.
  const [generarCliente, setGenerarCliente] = useState("");
  const [generarMes, setGenerarMes] = useState(() => previousMonth(madridToday()));
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [generando, iniciarGeneracion] = useTransition();

  const cargar = useCallback(async () => {
    setLoading(true);

    let consulta = supabase
      .from("invoices")
      .select(
        "id, invoice_number, client_id, client_name, period_start, status, paid_at, due_date, total_hours, subtotal, vat_amount, total",
      );

    if (clienteId) consulta = consulta.eq("client_id", clienteId);
    if (periodo) consulta = consulta.eq("period_start", periodo);

    // El estado del panel sale de dos columnas, así que el filtro también.
    if (estado === "borrador") consulta = consulta.eq("status", "borrador");
    if (estado === "anulada") consulta = consulta.eq("status", "anulada");
    if (estado === "emitida") {
      consulta = consulta.eq("status", "emitida").is("paid_at", null);
    }
    if (estado === "cobrada") {
      consulta = consulta.eq("status", "emitida").not("paid_at", "is", null);
    }

    const { data, error: errorConsulta } = await consulta
      .order("period_start", { ascending: false })
      .order("client_name");

    if (errorConsulta) setError(errorConsulta.message);
    else {
      setError(null);
      setRows((data ?? []) as FacturaRow[]);
    }
    setLoading(false);
  }, [supabase, clienteId, periodo, estado]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Opciones de los filtros: los clientes de la company y los meses que de
  // verdad tienen factura (no un calendario infinito de meses vacíos).
  useEffect(() => {
    async function cargarOpciones() {
      const [clientesResult, periodosResult] = await Promise.all([
        supabase.from("clients").select("id, name").order("name"),
        supabase
          .from("invoices")
          .select("period_start")
          .order("period_start", { ascending: false }),
      ]);

      setClientes((clientesResult.data ?? []) as Cliente[]);
      setPeriodos([
        ...new Set(
          ((periodosResult.data ?? []) as { period_start: string }[]).map(
            (fila) => fila.period_start,
          ),
        ),
      ]);
    }
    cargarOpciones();
  }, [supabase]);

  function handleGenerar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!generarCliente) {
      setAviso({ ok: false, texto: "Elige un cliente." });
      return;
    }

    iniciarGeneracion(async () => {
      const resultado = await generarAhoraAction(generarCliente, generarMes);
      setAviso(
        resultado.ok
          ? { ok: true, texto: resultado.mensaje }
          : { ok: false, texto: resultado.error },
      );
      await cargar();
    });
  }

  const totales = useMemo(
    () => rows.reduce((suma, fila) => suma + Number(fila.total), 0),
    [rows],
  );

  return (
    <>
      <PageHeader
        title="Facturas"
        meta={
          loading
            ? undefined
            : `${rows.length} factura(s) · ${euros(totales)} en total`
        }
      />

      {/* Generar ahora: el mismo cierre que hace el cron del día 1, a mano. */}
      <section className="flex flex-col gap-4">
        <SectionTitle>Generar ahora</SectionTitle>
        <div className="rounded-2xl border border-[#e7e4e0] bg-white p-5 shadow-[0_1px_2px_rgba(22,19,15,.05)]">
          <p className="m-0 mb-4 text-[15px] text-[#6b6560]">
            Prepara o rehace el borrador de un cliente sin esperar al cierre
            automático del día 1. Si ya hay un borrador, se recalcula con los
            fichajes de ahora mismo.
          </p>
          <form onSubmit={handleGenerar} className="flex flex-wrap items-center gap-3">
            <label className="sr-only" htmlFor="generar-cliente">
              Cliente
            </label>
            <select
              id="generar-cliente"
              className={selectClass}
              value={generarCliente}
              onChange={(event) => setGenerarCliente(event.target.value)}
            >
              <option value="">Elige un cliente…</option>
              {clientes.map((cliente) => (
                <option key={cliente.id} value={cliente.id}>
                  {cliente.name}
                </option>
              ))}
            </select>

            <label className="sr-only" htmlFor="generar-mes">
              Mes
            </label>
            <input
              id="generar-mes"
              type="month"
              className={selectClass}
              value={generarMes}
              onChange={(event) => setGenerarMes(event.target.value)}
            />

            <Button type="submit" variant="primary" disabled={generando}>
              {generando ? "Generando…" : "Generar ahora"}
            </Button>
          </form>

          {aviso ? (
            <p
              role="status"
              className={`m-0 mt-4 text-[15px] ${
                aviso.ok ? "text-[#1f7a4d]" : "text-[#b8240d]"
              }`}
            >
              {aviso.texto}
            </p>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Listado</SectionTitle>

        <div className="flex flex-wrap gap-3">
          <label className="sr-only" htmlFor="filtro-cliente">
            Filtrar por cliente
          </label>
          <select
            id="filtro-cliente"
            className={selectClass}
            value={clienteId}
            onChange={(event) => setClienteId(event.target.value)}
          >
            <option value="">Todos los clientes</option>
            {clientes.map((cliente) => (
              <option key={cliente.id} value={cliente.id}>
                {cliente.name}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="filtro-periodo">
            Filtrar por periodo
          </label>
          <select
            id="filtro-periodo"
            className={selectClass}
            value={periodo}
            onChange={(event) => setPeriodo(event.target.value)}
          >
            <option value="">Todos los periodos</option>
            {periodos.map((mes) => (
              <option key={mes} value={mes}>
                {formatMes(mes)}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="filtro-estado">
            Filtrar por estado
          </label>
          <select
            id="filtro-estado"
            className={selectClass}
            value={estado}
            onChange={(event) =>
              setEstado(event.target.value as "todas" | EstadoFactura)
            }
          >
            {FILTROS_ESTADO.map((opcion) => (
              <option key={opcion.valor} value={opcion.valor}>
                {opcion.etiqueta}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <p role="alert" className="m-0 text-[15px] text-[#b8240d]">
            {error}
          </p>
        ) : null}

        {loading ? (
          <Skeleton className="h-[220px]" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No hay facturas con esos filtros."
            body="Prueba a cambiar el cliente, el periodo o el estado, o genera el borrador de un cliente con el formulario de arriba."
          />
        ) : (
          <>
            {/* escritorio */}
            <div className="hidden overflow-hidden rounded-2xl border border-[#e7e4e0] bg-white shadow-[0_1px_2px_rgba(22,19,15,.05)] min-[901px]:block">
              <table className="w-full border-separate border-spacing-0 text-[15px]">
                <thead>
                  <tr>
                    {["Número", "Cliente", "Periodo", "Horas", "Base", "IVA", "Total", "Estado", ""].map(
                      (encabezado) => (
                        <th
                          key={encabezado}
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
                  {rows.map((factura, indice) => {
                    const borde =
                      indice === rows.length - 1 ? "" : "border-b border-[#f1f0ee]";
                    return (
                      <tr key={factura.id} className="transition-colors duration-150 hover:bg-[#fcfcfd]">
                        <td className={`px-4 py-[15px] font-semibold tabular-nums ${borde}`}>
                          {factura.invoice_number ?? "—"}
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>{factura.client_name}</td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          {formatMes(factura.period_start)}
                        </td>
                        <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                          {formatHoras(Number(factura.total_hours))}
                        </td>
                        <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                          {euros(factura.subtotal)}
                        </td>
                        <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                          {euros(factura.vat_amount)}
                        </td>
                        <td className={`px-4 py-[15px] font-semibold tabular-nums ${borde}`}>
                          {euros(factura.total)}
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          <EstadoPill factura={factura} />
                        </td>
                        <td className={`px-4 py-[15px] ${borde}`}>
                          <Link
                            href={`/dashboard/facturas/${factura.id}`}
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
              {rows.map((factura) => (
                <Link
                  key={factura.id}
                  href={`/dashboard/facturas/${factura.id}`}
                  className="rounded-2xl border border-[#e7e4e0] bg-white p-4 no-underline shadow-[0_1px_2px_rgba(22,19,15,.05)]"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-base font-bold text-[#16130f]">
                      {factura.client_name}
                    </span>
                    <span className="text-[15px] font-semibold tabular-nums text-[#16130f]">
                      {euros(factura.total)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-sm text-[#6b6560]">
                    <span>
                      {factura.invoice_number ?? "Sin número"} · {formatMes(factura.period_start)}
                    </span>
                    <EstadoPill factura={factura} />
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

function EstadoPill({ factura }: { factura: FacturaRow }) {
  const estado = estadoDeFactura(factura);
  if (estaVencida(factura)) return <StatusPill tone="warn">Vencida</StatusPill>;
  return <StatusPill tone={TONO_ESTADO[estado]}>{ETIQUETA_ESTADO[estado]}</StatusPill>;
}
