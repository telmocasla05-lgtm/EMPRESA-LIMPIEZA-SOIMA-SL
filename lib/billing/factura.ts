// Generación y emisión de facturas (SPEC-facturacion.md 5).
//
// Ciclo: un borrador se recalcula entero cada vez (sin número, sin PDF, sin
// valor legal) y solo al EMITIR recibe número, se congelan los importes y se
// genera el PDF. Por eso hay dos funciones y no una: si el borrador llevara
// número, borrarlo dejaría un hueco en la numeración (decisión 9).

import { type SupabaseClient } from "@supabase/supabase-js";
import { addDays, madridToday } from "@/lib/dates";
import {
  calcularHorasFacturables,
  type CentroRow,
  type Incidencia,
  type TimeEntryRow,
} from "@/lib/billing/horas";
import { calcularTotales, formatFecha } from "@/lib/billing/importes";
import { generarPdfFactura, type DatosFacturaPdf } from "@/lib/billing/pdf";

export const BUCKET_FACTURAS = "facturas";

// Un día de margen a cada lado, que es lo que necesita el emparejado de
// jornadas nocturnas (ver MARGEN_MS en horas.ts).
const MARGEN_DIAS = 2;

export type ResultadoBorrador =
  | { creada: true; invoiceId: string; totalHours: number; incidencias: Incidencia[] }
  | { creada: false; motivo: "sin_actividad" | "ya_emitida" };

type ClienteFila = {
  id: string;
  company_id: string;
  name: string;
  hourly_rate: number | null;
  vat_rate: number;
  tax_id: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  province: string | null;
  payment_method: string | null;
  payment_terms_days: number | null;
};

const CAMPOS_CLIENTE =
  "id, company_id, name, hourly_rate, vat_rate, tax_id, address, postal_code, city, province, payment_method, payment_terms_days";

const CAMPOS_EMPRESA =
  "id, name, tax_id, address, postal_code, city, province, iban";

function fallo(mensaje: string): never {
  throw new Error(mensaje);
}

// Dirección de una línea, para congelar en la cabecera de la factura.
function direccionPlana(cliente: ClienteFila): string | null {
  const partes = [
    cliente.address,
    [cliente.postal_code, cliente.city].filter(Boolean).join(" "),
    cliente.province,
  ].filter((p) => p && p.trim());
  return partes.length > 0 ? partes.join(", ") : null;
}

async function cargarDatosDelPeriodo(
  supabase: SupabaseClient,
  cliente: ClienteFila,
  periodStart: string,
  periodEnd: string,
) {
  const { data: centrosData, error: errorCentros } = await supabase
    .from("centers")
    .select("id, name")
    .eq("client_id", cliente.id);
  if (errorCentros) fallo(errorCentros.message);
  const centros = (centrosData ?? []) as CentroRow[];

  // Los fichajes de TODA la company, no solo los de este cliente: el
  // emparejado necesita la secuencia completa de cada operario para detectar
  // que entró en un centro y salió en otro (SPEC 4.2).
  const { data: entriesData, error: errorEntries } = await supabase
    .from("time_entries")
    .select("id, worker_id, center_id, type, valid, created_at")
    .eq("company_id", cliente.company_id)
    .gte("created_at", `${addDays(periodStart, -MARGEN_DIAS)}T00:00:00Z`)
    .lte("created_at", `${addDays(periodEnd, MARGEN_DIAS)}T23:59:59Z`)
    .order("created_at", { ascending: true });
  if (errorEntries) fallo(errorEntries.message);

  const horas = calcularHorasFacturables({
    entries: (entriesData ?? []) as TimeEntryRow[],
    centros,
    periodStart,
    periodEnd,
  });

  const totales = calcularTotales({
    porCentro: horas.porCentro,
    totalMinutes: horas.totalMinutes,
    hourlyRate: cliente.hourly_rate ?? 0,
    vatRate: cliente.vat_rate,
    descripcion: (centro) =>
      `Limpieza — ${centro.center_name} (${formatFecha(periodStart).slice(0, 5)}–${formatFecha(periodEnd).slice(0, 5)})`,
  });

  return { horas, totales };
}

// Crea o recalcula el borrador de un cliente para un periodo.
//
// Es idempotente: si ya hay un borrador de ese cliente y periodo, se le
// reescriben las líneas en vez de crear otro (lo garantiza además el índice
// invoices_periodo_unico_idx). Si ya hay una factura emitida, no se toca nada.
export async function generarBorrador({
  supabase,
  clientId,
  periodStart,
  periodEnd,
}: {
  supabase: SupabaseClient;
  clientId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<ResultadoBorrador> {
  const { data: clienteData, error: errorCliente } = await supabase
    .from("clients")
    .select(CAMPOS_CLIENTE)
    .eq("id", clientId)
    .single();
  if (errorCliente) fallo(errorCliente.message);
  const cliente = clienteData as ClienteFila;

  const { data: existentes, error: errorExistentes } = await supabase
    .from("invoices")
    .select("id, status")
    .eq("client_id", clientId)
    .eq("period_start", periodStart)
    .eq("kind", "ordinaria")
    .neq("status", "anulada");
  if (errorExistentes) fallo(errorExistentes.message);

  const emitida = (existentes ?? []).find((f) => f.status !== "borrador");
  if (emitida) return { creada: false, motivo: "ya_emitida" };
  const borradorPrevio = (existentes ?? [])[0];

  const { horas, totales } = await cargarDatosDelPeriodo(
    supabase,
    cliente,
    periodStart,
    periodEnd,
  );

  // Sin horas no hay factura: el cliente aparece en la lista "sin actividad"
  // (decisión 7). Si había un borrador viejo que se ha quedado a cero, se
  // borra para que no quede una factura fantasma.
  if (totales.totalMinutes === 0) {
    if (borradorPrevio) {
      const { error } = await supabase
        .from("invoices")
        .delete()
        .eq("id", borradorPrevio.id);
      if (error) fallo(error.message);
    }
    return { creada: false, motivo: "sin_actividad" };
  }

  const cabecera = {
    company_id: cliente.company_id,
    client_id: cliente.id,
    period_start: periodStart,
    period_end: periodEnd,
    client_name: cliente.name,
    client_tax_id: cliente.tax_id,
    client_address: direccionPlana(cliente),
    vat_rate: cliente.vat_rate,
    payment_method: cliente.payment_method,
    payment_terms_days: cliente.payment_terms_days,
    total_hours: totales.totalHours,
    subtotal: totales.subtotal,
    vat_amount: totales.vatAmount,
    total: totales.total,
  };

  let invoiceId: string;

  if (borradorPrevio) {
    invoiceId = borradorPrevio.id;
    const { error } = await supabase
      .from("invoices")
      .update(cabecera)
      .eq("id", invoiceId);
    if (error) fallo(error.message);

    // Se reescriben enteras: el borrador siempre refleja los fichajes de
    // ahora mismo (SPEC 5.1).
    const { error: errorBorrado } = await supabase
      .from("invoice_lines")
      .delete()
      .eq("invoice_id", invoiceId);
    if (errorBorrado) fallo(errorBorrado.message);
  } else {
    const { data, error } = await supabase
      .from("invoices")
      .insert(cabecera)
      .select("id")
      .single();
    if (error) fallo(error.message);
    invoiceId = data.id as string;
  }

  const lineas = totales.lineas.map((linea, indice) => ({
    company_id: cliente.company_id,
    invoice_id: invoiceId,
    center_id: linea.center_id,
    center_name: linea.center_name,
    description: linea.description,
    period_from: periodStart,
    period_to: periodEnd,
    minutes: linea.minutes,
    hours: linea.hours,
    hourly_rate: linea.hourly_rate,
    amount: linea.amount,
    position: indice + 1,
  }));

  const { error: errorLineas } = await supabase
    .from("invoice_lines")
    .insert(lineas);
  if (errorLineas) fallo(errorLineas.message);

  return {
    creada: true,
    invoiceId,
    totalHours: totales.totalHours,
    incidencias: horas.incidencias,
  };
}

export type ResultadoEmision = {
  invoiceId: string;
  invoiceNumber: string;
  series: string;
  number: number;
  pdfPath: string | null;
  pdfError?: string;
};

// Emite un borrador: le pone número, congela los importes y genera el PDF.
export async function emitirFactura({
  supabase,
  invoiceId,
  issueDate = madridToday(),
}: {
  supabase: SupabaseClient;
  invoiceId: string;
  issueDate?: string;
}): Promise<ResultadoEmision> {
  const { data: facturaData, error: errorFactura } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (errorFactura) fallo(errorFactura.message);
  const factura = facturaData as Record<string, unknown>;

  if (factura.status !== "borrador") {
    fallo(`La factura ya no es un borrador (está ${String(factura.status)})`);
  }

  const { data: clienteData, error: errorCliente } = await supabase
    .from("clients")
    .select(CAMPOS_CLIENTE)
    .eq("id", factura.client_id as string)
    .single();
  if (errorCliente) fallo(errorCliente.message);
  const cliente = clienteData as ClienteFila;

  const { data: empresaData, error: errorEmpresa } = await supabase
    .from("companies")
    .select(CAMPOS_EMPRESA)
    .eq("id", factura.company_id as string)
    .single();
  if (errorEmpresa) fallo(errorEmpresa.message);

  // 1. Recalcular el periodo desde cero.
  const { horas, totales } = await cargarDatosDelPeriodo(
    supabase,
    cliente,
    factura.period_start as string,
    factura.period_end as string,
  );

  // 2. Ninguna incidencia del cliente (SPEC 5.2, paso 2).
  if (horas.incidencias.length > 0) {
    const detalle = [...new Set(horas.incidencias.map((i) => i.codigo))].join(", ");
    fallo(
      `La factura tiene ${horas.incidencias.length} incidencia(s) sin resolver: ${detalle}`,
    );
  }

  // 3. Datos fiscales de empresa y cliente.
  const faltan = datosFiscalesQueFaltan(
    empresaData as Record<string, unknown>,
    cliente,
  );
  if (faltan.length > 0) {
    fallo(`Faltan datos fiscales para emitir: ${faltan.join(", ")}`);
  }

  // 4. Sin horas no hay factura (decisión 7).
  if (totales.totalMinutes === 0) {
    fallo("La factura no tiene horas: no se puede emitir");
  }

  // 5. Congelar la cabecera con lo recalculado.
  const dueDate = addDays(issueDate, cliente.payment_terms_days ?? 30);
  const { error: errorCongelar } = await supabase
    .from("invoices")
    .update({
      client_name: cliente.name,
      client_tax_id: cliente.tax_id,
      client_address: direccionPlana(cliente),
      vat_rate: cliente.vat_rate,
      payment_method: cliente.payment_method,
      payment_terms_days: cliente.payment_terms_days,
      total_hours: totales.totalHours,
      subtotal: totales.subtotal,
      vat_amount: totales.vatAmount,
      total: totales.total,
    })
    .eq("id", invoiceId);
  if (errorCongelar) fallo(errorCongelar.message);

  // 6. Trazabilidad: qué jornadas concretas entran en esta factura.
  const jornadas = horas.porCentro.flatMap((centro) => centro.jornadas);
  if (jornadas.length > 0) {
    const { error } = await supabase.from("invoice_time_entries").upsert(
      jornadas.map((jornada) => ({
        invoice_id: invoiceId,
        entry_in_id: jornada.entry_in_id,
        entry_out_id: jornada.entry_out_id,
        company_id: factura.company_id as string,
        center_id: jornada.center_id,
        worker_id: jornada.worker_id,
        work_date: jornada.work_date,
        minutes: jornada.minutes,
      })),
      { onConflict: "invoice_id,entry_in_id" },
    );
    if (error) fallo(error.message);
  }

  // 7. Número y estado, en una sola transacción de Postgres.
  const { data: emitida, error: errorEmitir } = await supabase.rpc(
    "emitir_factura",
    {
      p_invoice_id: invoiceId,
      p_issue_date: issueDate,
      p_due_date: dueDate,
    },
  );
  if (errorEmitir) fallo(errorEmitir.message);

  const cabecera = (Array.isArray(emitida) ? emitida[0] : emitida) as Record<
    string,
    unknown
  >;
  const invoiceNumber = cabecera.invoice_number as string;

  // 8. Fuera de la transacción: el PDF. Si falla, la factura queda emitida y
  // correcta con el PDF pendiente de reintentar (SPEC 5.2, paso 10).
  let pdfPath: string | null = null;
  let pdfError: string | undefined;
  try {
    pdfPath = await generarYGuardarPdf({
      supabase,
      invoiceId,
      companyId: factura.company_id as string,
      empresa: empresaData as never,
      cliente,
      cabecera,
      lineas: totales.lineas,
      totales,
    });
  } catch (error) {
    pdfError = error instanceof Error ? error.message : String(error);
  }

  return {
    invoiceId,
    invoiceNumber,
    series: cabecera.series as string,
    number: cabecera.number as number,
    pdfPath,
    ...(pdfError ? { pdfError } : {}),
  };
}

// Campos sin los que no se puede emitir una factura legal (SPEC 2.1).
export function datosFiscalesQueFaltan(
  empresa: Record<string, unknown>,
  cliente: ClienteFila,
): string[] {
  const faltan: string[] = [];
  const vacio = (valor: unknown) =>
    valor == null || String(valor).trim().length === 0;

  if (vacio(empresa.tax_id)) faltan.push("NIF de la empresa");
  if (vacio(empresa.address)) faltan.push("dirección de la empresa");
  if (vacio(empresa.postal_code)) faltan.push("código postal de la empresa");
  if (vacio(empresa.city)) faltan.push("ciudad de la empresa");
  if (vacio(cliente.tax_id)) faltan.push(`NIF del cliente ${cliente.name}`);
  if (vacio(cliente.address)) faltan.push(`dirección del cliente ${cliente.name}`);

  return faltan;
}

async function generarYGuardarPdf({
  supabase,
  invoiceId,
  companyId,
  empresa,
  cliente,
  cabecera,
  lineas,
  totales,
}: {
  supabase: SupabaseClient;
  invoiceId: string;
  companyId: string;
  empresa: DatosFacturaPdf["empresa"];
  cliente: ClienteFila;
  cabecera: Record<string, unknown>;
  lineas: DatosFacturaPdf["lineas"];
  totales: {
    subtotalCentimos: number;
    ivaCentimos: number;
    totalCentimos: number;
  };
}): Promise<string> {
  const bytes = await generarPdfFactura({
    empresa,
    cliente: {
      name: cliente.name,
      tax_id: cliente.tax_id,
      address: cliente.address,
      postal_code: cliente.postal_code,
      city: cliente.city,
      province: cliente.province,
    },
    invoice_number: cabecera.invoice_number as string,
    issue_date: cabecera.issue_date as string,
    due_date: cabecera.due_date as string | null,
    period_start: cabecera.period_start as string,
    vat_rate: Number(cabecera.vat_rate),
    payment_method: cabecera.payment_method as string | null,
    payment_terms_days: cabecera.payment_terms_days as number | null,
    kind: cabecera.kind as "ordinaria" | "rectificativa",
    lineas,
    subtotalCentimos: totales.subtotalCentimos,
    ivaCentimos: totales.ivaCentimos,
    totalCentimos: totales.totalCentimos,
  });

  // <company_id>/<año>/<numero>.pdf — la primera carpeta es lo que mira la
  // política de storage.objects.
  const series = String(cabecera.series);
  const numero = String(cabecera.invoice_number).replace("/", "-");
  const path = `${companyId}/${series.replace("R-", "")}/${numero}.pdf`;

  const { error: errorSubida } = await supabase.storage
    .from(BUCKET_FACTURAS)
    .upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (errorSubida) fallo(errorSubida.message);

  const { error: errorRuta } = await supabase
    .from("invoices")
    .update({ pdf_path: path })
    .eq("id", invoiceId);
  if (errorRuta) fallo(errorRuta.message);

  return path;
}

// URL de descarga temporal. El bucket es privado: nunca se expone, y la firma
// caduca en 60 segundos (SPEC 3).
export async function urlFirmadaFactura(
  supabase: SupabaseClient,
  pdfPath: string,
  segundos = 60,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET_FACTURAS)
    .createSignedUrl(pdfPath, segundos);
  if (error) fallo(error.message);
  return data.signedUrl;
}
