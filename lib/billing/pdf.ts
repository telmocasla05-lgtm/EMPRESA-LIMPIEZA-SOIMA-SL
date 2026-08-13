// PDF de la factura con pdf-lib (SPEC-facturacion.md 7).
//
// pdf-lib es JavaScript puro: no necesita navegador headless ni binarios
// nativos, así que funciona en el runtime Node de Vercel.
//
// Fuentes estándar Helvetica / Helvetica-Bold con codificación WinAnsi, que
// cubre acentos, ñ, º y €. Tamaño A4 vertical y formato español.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  formatEuros,
  formatFecha,
  formatHoras,
  formatMes,
  formatPorcentaje,
} from "@/lib/billing/importes";

const A4_ANCHO = 595.28;
const A4_ALTO = 841.89;
const MARGEN = 50;

const NEGRO = rgb(0.1, 0.1, 0.1);
const GRIS = rgb(0.45, 0.45, 0.45);
const LINEA = rgb(0.8, 0.8, 0.8);

// Columnas de la tabla, medidas desde el margen izquierdo.
const COL_CONCEPTO = MARGEN;
const COL_HORAS_FIN = MARGEN + 355;
const COL_TARIFA_FIN = MARGEN + 435;
const COL_IMPORTE_FIN = A4_ANCHO - MARGEN;
const ANCHO_CONCEPTO = 300;

const ALTO_FILA = 15;
// Espacio que hay que dejar libre al final de la última página para el
// bloque de totales y la forma de pago.
const ALTO_CIERRE = 130;

export type DatosEmpresa = {
  name: string;
  tax_id: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  province: string | null;
  iban: string | null;
};

export type DatosCliente = {
  name: string;
  tax_id: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  province: string | null;
};

export type LineaPdf = {
  description: string;
  hours: number;
  hourly_rate: number;
  amount: number;
};

export type DatosFacturaPdf = {
  empresa: DatosEmpresa;
  cliente: DatosCliente;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  period_start: string;
  vat_rate: number;
  payment_method: string | null;
  payment_terms_days: number | null;
  kind?: "ordinaria" | "rectificativa";
  rectifica?: { invoice_number: string; issue_date: string } | null;
  lineas: LineaPdf[];
  subtotalCentimos: number;
  ivaCentimos: number;
  totalCentimos: number;
};

// Caracteres que Helvetica puede escribir con WinAnsiEncoding (CP1252).
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function encodable(char: string): boolean {
  const code = char.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return CP1252_EXTRA.includes(char);
}

// pdf-lib lanza una excepción si el texto lleva un carácter fuera de WinAnsi.
// El nombre de un cliente puede traer cualquier cosa, así que en vez de
// reventar la emisión se transcribe: se quitan las tildes que no existan en
// CP1252 y, si aun así no hay equivalente, se sustituye por '?'.
export function textoSeguro(texto: string): string {
  let salida = "";
  for (const char of texto.normalize("NFC")) {
    if (encodable(char)) {
      salida += char;
      continue;
    }
    const plano = char
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    salida += plano.length > 0 && [...plano].every(encodable) ? plano : "?";
  }
  return salida;
}

type Contexto = {
  normal: PDFFont;
  negrita: PDFFont;
};

function escribir(
  page: PDFPage,
  texto: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = NEGRO,
) {
  page.drawText(textoSeguro(texto), { x, y, size, font, color });
}

function escribirDerecha(
  page: PDFPage,
  texto: string,
  xFin: number,
  y: number,
  font: PDFFont,
  size: number,
  color = NEGRO,
) {
  const limpio = textoSeguro(texto);
  const ancho = font.widthOfTextAtSize(limpio, size);
  page.drawText(limpio, { x: xFin - ancho, y, size, font, color });
}

function separador(page: PDFPage, y: number) {
  page.drawLine({
    start: { x: MARGEN, y },
    end: { x: A4_ANCHO - MARGEN, y },
    thickness: 0.5,
    color: LINEA,
  });
}

// Parte el texto en las líneas que caben en un ancho dado.
function partirTexto(
  texto: string,
  font: PDFFont,
  size: number,
  ancho: number,
): string[] {
  const palabras = textoSeguro(texto).split(" ");
  const lineas: string[] = [];
  let actual = "";

  for (const palabra of palabras) {
    const intento = actual ? `${actual} ${palabra}` : palabra;
    if (font.widthOfTextAtSize(intento, size) <= ancho || !actual) {
      actual = intento;
    } else {
      lineas.push(actual);
      actual = palabra;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

function direccionEnLineas(
  datos: DatosEmpresa | DatosCliente,
): string[] {
  const lineas: string[] = [];
  if (datos.tax_id) lineas.push(`NIF: ${datos.tax_id}`);
  if (datos.address) lineas.push(datos.address);

  const ciudad = [datos.postal_code, datos.city].filter(Boolean).join(" ");
  const conProvincia = datos.province ? `${ciudad} (${datos.province})` : ciudad;
  if (conProvincia.trim()) lineas.push(conProvincia.trim());

  return lineas;
}

// Cabecera completa: solo en la primera página.
function dibujarCabecera(
  page: PDFPage,
  ctx: Contexto,
  datos: DatosFacturaPdf,
): number {
  let y = A4_ALTO - MARGEN;

  escribir(page, datos.empresa.name, MARGEN, y - 12, ctx.negrita, 14);

  const titulo =
    datos.kind === "rectificativa" ? "FACTURA RECTIFICATIVA" : "FACTURA";
  escribirDerecha(page, titulo, COL_IMPORTE_FIN, y - 4, ctx.negrita, 11);
  escribirDerecha(
    page,
    datos.invoice_number,
    COL_IMPORTE_FIN,
    y - 20,
    ctx.negrita,
    15,
  );

  let yIzq = y - 28;
  for (const linea of direccionEnLineas(datos.empresa)) {
    escribir(page, linea, MARGEN, yIzq, ctx.normal, 9, GRIS);
    yIzq -= 12;
  }

  let yDer = y - 40;
  escribirDerecha(
    page,
    `Fecha: ${formatFecha(datos.issue_date)}`,
    COL_IMPORTE_FIN,
    yDer,
    ctx.normal,
    9,
  );
  if (datos.due_date) {
    yDer -= 12;
    escribirDerecha(
      page,
      `Vencimiento: ${formatFecha(datos.due_date)}`,
      COL_IMPORTE_FIN,
      yDer,
      ctx.normal,
      9,
    );
  }
  if (datos.rectifica) {
    yDer -= 12;
    escribirDerecha(
      page,
      `Rectifica a ${datos.rectifica.invoice_number} de ${formatFecha(datos.rectifica.issue_date)}`,
      COL_IMPORTE_FIN,
      yDer,
      ctx.normal,
      9,
      GRIS,
    );
  }

  y = Math.min(yIzq, yDer) - 14;
  separador(page, y);
  y -= 18;

  escribir(page, "FACTURAR A", MARGEN, y, ctx.negrita, 8, GRIS);
  y -= 14;
  escribir(page, datos.cliente.name, MARGEN, y, ctx.negrita, 11);
  y -= 13;
  for (const linea of direccionEnLineas(datos.cliente)) {
    escribir(page, linea, MARGEN, y, ctx.normal, 9, GRIS);
    y -= 12;
  }

  y -= 6;
  separador(page, y);
  y -= 16;
  escribir(
    page,
    `Periodo facturado: ${formatMes(datos.period_start)}`,
    MARGEN,
    y,
    ctx.normal,
    10,
  );

  return y - 20;
}

// Cabecera reducida de las páginas siguientes.
function dibujarCabeceraContinuacion(
  page: PDFPage,
  ctx: Contexto,
  datos: DatosFacturaPdf,
): number {
  const y = A4_ALTO - MARGEN;
  escribir(page, datos.empresa.name, MARGEN, y - 10, ctx.negrita, 10);
  escribirDerecha(
    page,
    `${datos.invoice_number} (continuación)`,
    COL_IMPORTE_FIN,
    y - 10,
    ctx.normal,
    9,
    GRIS,
  );
  separador(page, y - 20);
  return y - 38;
}

// Cabecera de la tabla, que se repite en cada página.
function dibujarCabeceraTabla(page: PDFPage, ctx: Contexto, y: number): number {
  escribir(page, "Concepto", COL_CONCEPTO, y, ctx.negrita, 9, GRIS);
  escribirDerecha(page, "Horas", COL_HORAS_FIN, y, ctx.negrita, 9, GRIS);
  escribirDerecha(page, "€/hora", COL_TARIFA_FIN, y, ctx.negrita, 9, GRIS);
  escribirDerecha(page, "Importe", COL_IMPORTE_FIN, y, ctx.negrita, 9, GRIS);
  separador(page, y - 6);
  return y - 20;
}

function dibujarCierre(
  page: PDFPage,
  ctx: Contexto,
  datos: DatosFacturaPdf,
  yInicial: number,
) {
  let y = yInicial - 4;
  separador(page, y);
  y -= 16;

  const filas: [string, string, boolean][] = [
    ["Base imponible", formatEuros(datos.subtotalCentimos), false],
    [`IVA ${formatPorcentaje(datos.vat_rate)}`, formatEuros(datos.ivaCentimos), false],
    ["TOTAL", formatEuros(datos.totalCentimos), true],
  ];

  for (const [etiqueta, valor, fuerte] of filas) {
    const font = fuerte ? ctx.negrita : ctx.normal;
    const size = fuerte ? 12 : 10;
    if (fuerte) {
      separador(page, y + 12);
      y -= 4;
    }
    escribirDerecha(page, etiqueta, COL_TARIFA_FIN, y, font, size);
    escribirDerecha(page, valor, COL_IMPORTE_FIN, y, font, size);
    y -= fuerte ? 20 : 15;
  }

  const pago = [
    datos.payment_method,
    datos.payment_terms_days != null ? `${datos.payment_terms_days} días` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (pago) {
    escribir(page, `Forma de pago: ${pago}`, MARGEN, y, ctx.normal, 9, GRIS);
    y -= 12;
  }
  if (datos.empresa.iban) {
    escribir(page, `IBAN: ${datos.empresa.iban}`, MARGEN, y, ctx.normal, 9, GRIS);
  }
}

export async function generarPdfFactura(
  datos: DatosFacturaPdf,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx: Contexto = {
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  doc.setTitle(textoSeguro(`Factura ${datos.invoice_number}`));
  doc.setProducer("Limpieza SaaS");

  // Primera pasada: repartir las líneas en páginas para saber cuántas hay
  // antes de escribir "Página X de Y".
  const paginas: LineaPdf[][] = [];
  let actual: LineaPdf[] = [];
  let y = A4_ALTO - MARGEN - 210;

  for (const linea of datos.lineas) {
    const alto =
      partirTexto(linea.description, ctx.normal, 9, ANCHO_CONCEPTO).length *
      ALTO_FILA;
    if (y - alto < MARGEN + ALTO_CIERRE && actual.length > 0) {
      paginas.push(actual);
      actual = [];
      // Las páginas siguientes solo llevan la cabecera reducida.
      y = A4_ALTO - MARGEN - 58;
    }
    actual.push(linea);
    y -= alto;
  }
  paginas.push(actual);

  // Si el cierre no cabe bajo la última línea, va en una página más.
  const cierreEnPaginaAparte = y - ALTO_CIERRE < MARGEN;
  const totalPaginas = paginas.length + (cierreEnPaginaAparte ? 1 : 0);

  for (const [indice, lineasPagina] of paginas.entries()) {
    const page = doc.addPage([A4_ANCHO, A4_ALTO]);
    let cursor =
      indice === 0
        ? dibujarCabecera(page, ctx, datos)
        : dibujarCabeceraContinuacion(page, ctx, datos);

    cursor = dibujarCabeceraTabla(page, ctx, cursor);

    for (const linea of lineasPagina) {
      const trozos = partirTexto(linea.description, ctx.normal, 9, ANCHO_CONCEPTO);
      escribirDerecha(page, formatHoras(linea.hours), COL_HORAS_FIN, cursor, ctx.normal, 9);
      escribirDerecha(
        page,
        formatHoras(linea.hourly_rate),
        COL_TARIFA_FIN,
        cursor,
        ctx.normal,
        9,
      );
      escribirDerecha(
        page,
        formatEuros(Math.round(linea.amount * 100)),
        COL_IMPORTE_FIN,
        cursor,
        ctx.normal,
        9,
      );
      for (const trozo of trozos) {
        escribir(page, trozo, COL_CONCEPTO, cursor, ctx.normal, 9);
        cursor -= ALTO_FILA;
      }
    }

    if (indice === paginas.length - 1 && !cierreEnPaginaAparte) {
      dibujarCierre(page, ctx, datos, cursor);
    }
  }

  if (cierreEnPaginaAparte) {
    const page = doc.addPage([A4_ANCHO, A4_ALTO]);
    const cursor = dibujarCabeceraContinuacion(page, ctx, datos);
    dibujarCierre(page, ctx, datos, cursor);
  }

  // Pie con la paginación, ya conocido el total.
  doc.getPages().forEach((page, indice) => {
    escribirDerecha(
      page,
      `Página ${indice + 1} de ${totalPaginas}`,
      COL_IMPORTE_FIN,
      MARGEN - 20,
      ctx.normal,
      8,
      GRIS,
    );
  });

  return doc.save();
}
