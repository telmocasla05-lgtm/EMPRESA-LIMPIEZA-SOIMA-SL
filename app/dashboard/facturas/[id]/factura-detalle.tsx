"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Button,
  PageHeader,
  SectionTitle,
  StatusPill,
} from "@/components/design-import/dashboard";
import {
  eurosACentimos,
  formatEuros,
  formatFecha,
  formatHoras,
  formatMes,
  formatPorcentaje,
} from "@/lib/billing/importes";
import {
  emitirFacturaAction,
  generarAhoraAction,
  marcarCobradaAction,
  type ResultadoAccion,
} from "../actions";
import {
  ETIQUETA_ESTADO,
  TONO_ESTADO,
  estadoDeFactura,
  estaVencida,
} from "../estado";

export type FacturaDetallada = {
  id: string;
  client_id: string;
  invoice_number: string | null;
  kind: string;
  status: string;
  period_start: string;
  period_end: string;
  issue_date: string | null;
  due_date: string | null;
  paid_at: string | null;
  client_name: string;
  client_tax_id: string | null;
  client_address: string | null;
  vat_rate: number;
  payment_method: string | null;
  payment_terms_days: number | null;
  total_hours: number;
  subtotal: number;
  vat_amount: number;
  total: number;
  pdf_path: string | null;
};

export type LineaFactura = {
  id: string;
  center_name: string;
  description: string;
  period_from: string;
  period_to: string;
  hours: number;
  hourly_rate: number;
  amount: number;
};

const euros = (valor: number) => formatEuros(eurosACentimos(Number(valor)));

export function FacturaDetalle({
  factura,
  lineas,
  esAdmin,
}: {
  factura: FacturaDetallada;
  lineas: LineaFactura[];
  esAdmin: boolean;
}) {
  const router = useRouter();
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [trabajando, iniciar] = useTransition();

  const estado = estadoDeFactura(factura);
  const esBorrador = estado === "borrador";
  const cobrada = estado === "cobrada";

  function ejecutar(accion: () => Promise<ResultadoAccion>) {
    iniciar(async () => {
      const resultado = await accion();
      setAviso(
        resultado.ok
          ? { ok: true, texto: resultado.mensaje }
          : { ok: false, texto: resultado.error },
      );
      router.refresh();
    });
  }

  // Emitir es irreversible: consume número y congela los importes, y a partir
  // de ahí la factura ya no se puede tocar. Por eso se pregunta antes.
  function handleEmitir() {
    const seguro = window.confirm(
      `Se va a emitir la factura de ${factura.client_name} (${formatMes(factura.period_start)}).\n\n` +
        "Recibirá número oficial y ya no se podrá modificar: para corregirla habría que hacer una factura rectificativa.\n\n¿Emitir?",
    );
    if (seguro) ejecutar(() => emitirFacturaAction(factura.id));
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/facturas"
          className="text-[15px] font-semibold text-[#6b6560] no-underline hover:text-[#16130f]"
        >
          ← Volver a facturas
        </Link>
        <PageHeader
          title={factura.invoice_number ?? "Borrador"}
          meta={`${factura.client_name} · ${formatMes(factura.period_start)}`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {estaVencida(factura) ? (
          <StatusPill tone="warn">Vencida</StatusPill>
        ) : (
          <StatusPill tone={TONO_ESTADO[estado]}>{ETIQUETA_ESTADO[estado]}</StatusPill>
        )}
        {factura.kind === "rectificativa" ? (
          <StatusPill tone="warn">Rectificativa</StatusPill>
        ) : null}

        {esBorrador ? (
          <>
            <Button variant="primary" onClick={handleEmitir} disabled={!esAdmin || trabajando}>
              Emitir
            </Button>
            <Button
              variant="secondary"
              disabled={!esAdmin || trabajando}
              onClick={() =>
                ejecutar(() =>
                  generarAhoraAction(factura.client_id, factura.period_start.slice(0, 7)),
                )
              }
            >
              Recalcular
            </Button>
          </>
        ) : null}

        {estado === "emitida" || estado === "cobrada" ? (
          <Button
            variant={cobrada ? "secondary" : "primary"}
            disabled={!esAdmin || trabajando}
            onClick={() => ejecutar(() => marcarCobradaAction(factura.id, !cobrada))}
          >
            {cobrada ? "Marcar como pendiente de cobro" : "Marcar como cobrada"}
          </Button>
        ) : null}

        {factura.pdf_path ? (
          <a
            href={`/api/facturas/${factura.id}/pdf`}
            className="inline-flex items-center rounded-full border border-[#e7e4e0] bg-white px-[18px] py-2.5 text-[15px] font-semibold text-[#16130f] no-underline shadow-[0_1px_2px_rgba(22,19,15,.05)] hover:border-[#d8d3ce]"
          >
            Descargar PDF
          </a>
        ) : null}
      </div>

      {!esAdmin ? (
        <p className="m-0 text-[15px] text-[#6b6560]">
          Solo un administrador puede emitir facturas o marcarlas como cobradas.
        </p>
      ) : null}

      {aviso ? (
        <p
          role="status"
          className={`m-0 text-[15px] ${aviso.ok ? "text-[#1f7a4d]" : "text-[#b8240d]"}`}
        >
          {aviso.texto}
        </p>
      ) : null}

      {esBorrador ? (
        <p className="m-0 text-[15px] text-[#6b6560]">
          Es un borrador: no tiene número ni valor legal y se recalcula entero
          con los fichajes de cada momento.
        </p>
      ) : null}

      {!esBorrador && !factura.pdf_path ? (
        <p className="m-0 text-[15px] text-[#8a5a18]">
          PDF pendiente: la factura está emitida y es válida, pero el archivo no
          se llegó a guardar.
        </p>
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionTitle>Datos de la factura</SectionTitle>
        <dl className="grid gap-x-8 gap-y-4 rounded-2xl border border-[#e7e4e0] bg-white p-5 shadow-[0_1px_2px_rgba(22,19,15,.05)] [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          <Dato etiqueta="Cliente" valor={factura.client_name} />
          <Dato etiqueta="NIF" valor={factura.client_tax_id ?? "—"} />
          <Dato etiqueta="Dirección" valor={factura.client_address ?? "—"} />
          <Dato
            etiqueta="Periodo facturado"
            valor={`${formatFecha(factura.period_start)} – ${formatFecha(factura.period_end)}`}
          />
          <Dato
            etiqueta="Fecha de factura"
            valor={factura.issue_date ? formatFecha(factura.issue_date) : "—"}
          />
          <Dato
            etiqueta="Vencimiento"
            valor={factura.due_date ? formatFecha(factura.due_date) : "—"}
          />
          <Dato
            etiqueta="Forma de pago"
            valor={
              factura.payment_method
                ? `${factura.payment_method}${
                    factura.payment_terms_days ? ` · ${factura.payment_terms_days} días` : ""
                  }`
                : "—"
            }
          />
          <Dato
            etiqueta="Cobro"
            valor={factura.paid_at ? `Cobrada el ${formatFecha(factura.paid_at)}` : "Pendiente"}
          />
        </dl>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Desglose por centro</SectionTitle>

        <div className="overflow-x-auto rounded-2xl border border-[#e7e4e0] bg-white shadow-[0_1px_2px_rgba(22,19,15,.05)]">
          <table className="w-full border-separate border-spacing-0 text-[15px]">
            <thead>
              <tr>
                {["Centro", "Periodo", "Horas", "€/hora", "Importe"].map((encabezado) => (
                  <th
                    key={encabezado}
                    scope="col"
                    className="border-b border-[#e7e4e0] bg-[#fcfcfd] px-4 py-[13px] text-left text-[13px] font-semibold text-[#6b6560]"
                  >
                    {encabezado}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lineas.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-[15px] text-[#6b6560]">
                    Esta factura no tiene líneas.
                  </td>
                </tr>
              ) : (
                lineas.map((linea, indice) => {
                  const borde =
                    indice === lineas.length - 1 ? "" : "border-b border-[#f1f0ee]";
                  return (
                    <tr key={linea.id}>
                      <td className={`px-4 py-[15px] font-semibold ${borde}`}>
                        {linea.center_name}
                      </td>
                      <td className={`px-4 py-[15px] whitespace-nowrap ${borde}`}>
                        {formatFecha(linea.period_from)} – {formatFecha(linea.period_to)}
                      </td>
                      <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                        {formatHoras(Number(linea.hours))}
                      </td>
                      <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                        {euros(linea.hourly_rate)}
                      </td>
                      <td className={`px-4 py-[15px] tabular-nums ${borde}`}>
                        {euros(linea.amount)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="ml-auto flex w-full max-w-[340px] flex-col gap-2 rounded-2xl border border-[#e7e4e0] bg-white p-5 text-[15px] shadow-[0_1px_2px_rgba(22,19,15,.05)]">
          <Total etiqueta="Horas facturadas" valor={formatHoras(Number(factura.total_hours))} />
          <Total etiqueta="Base imponible" valor={euros(factura.subtotal)} />
          <Total
            etiqueta={`IVA ${formatPorcentaje(Number(factura.vat_rate))}`}
            valor={euros(factura.vat_amount)}
          />
          <div className="mt-1 border-t border-[#e7e4e0] pt-3">
            <Total etiqueta="TOTAL" valor={euros(factura.total)} destacado />
          </div>
        </div>
      </section>
    </>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <dt className="text-[13px] font-medium text-[#6b6560]">{etiqueta}</dt>
      <dd className="m-0 mt-1 text-[15px] text-[#16130f]">{valor}</dd>
    </div>
  );
}

function Total({
  etiqueta,
  valor,
  destacado = false,
}: {
  etiqueta: string;
  valor: string;
  destacado?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={destacado ? "font-bold" : "text-[#6b6560]"}>{etiqueta}</span>
      <span className={`tabular-nums ${destacado ? "text-[17px] font-extrabold" : ""}`}>
        {valor}
      </span>
    </div>
  );
}
