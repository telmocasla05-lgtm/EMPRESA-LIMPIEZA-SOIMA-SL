import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  generarPdfFactura,
  textoSeguro,
  type DatosFacturaPdf,
  type LineaPdf,
} from "@/lib/billing/pdf";

// pdf-lib no expone el texto ya escrito, así que para comprobar el contenido
// hay que leerlo del propio fichero: descomprimir los flujos (van en Flate),
// sacar lo que va entre paréntesis —que es como se codifica el texto en los
// operadores Tj/TJ— y devolverlo a Unicode desde WinAnsi.
function textoDelPdf(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const crudo = buf.toString("latin1");
  const flujos: string[] = [];

  // El lookbehind evita casar el "stream" que hay dentro de "endstream".
  const marca = /(?<![A-Za-z])stream\r?\n/g;
  let encontrado: RegExpExecArray | null;
  while ((encontrado = marca.exec(crudo)) !== null) {
    const inicio = encontrado.index + encontrado[0].length;
    const fin = crudo.indexOf("endstream", inicio);
    if (fin === -1) continue;
    const datos = buf.subarray(inicio, fin);
    try {
      flujos.push(inflateSync(datos).toString("latin1"));
    } catch {
      flujos.push(datos.toString("latin1"));
    }
  }

  // pdf-lib escribe el texto como cadena hexadecimal <4661...>, no como
  // literal entre paréntesis; se aceptan las dos formas.
  const octetos: number[] = [];
  const cadenas = /\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]+>/g;
  let trozo: RegExpExecArray | null;

  while ((trozo = cadenas.exec(flujos.join("\n"))) !== null) {
    const texto = trozo[0];
    if (texto.startsWith("(")) {
      const literal = texto
        .slice(1, -1)
        .replace(/\\([0-7]{1,3})/g, (_, oct: string) =>
          String.fromCharCode(parseInt(oct, 8)),
        )
        .replace(/\\([()\\])/g, "$1");
      for (const char of literal) octetos.push(char.charCodeAt(0));
    } else {
      const hex = texto.slice(1, -1).replace(/\s+/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) {
        octetos.push(parseInt(hex.slice(i, i + 2), 16));
      }
    }
    octetos.push(32); // separador entre cadenas
  }

  // Cada octeto es un byte WinAnsi: € es 0x80, que en latin1 no existe, así
  // que hay que decodificar con windows-1252.
  return new TextDecoder("windows-1252").decode(Buffer.from(octetos));
}

function datos(overrides: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf {
  return {
    empresa: {
      name: "Facturación Ñoño S.L.",
      tax_id: "B12345678",
      address: "Calle Mayor 1",
      postal_code: "28001",
      city: "Madrid",
      province: "Madrid",
      iban: "ES91 2100 0418 4502 0005 1332",
    },
    cliente: {
      name: "Cliente Ejemplo S.A.",
      tax_id: "A87654321",
      address: "Avenida de la Paz 20",
      postal_code: "08001",
      city: "Barcelona",
      province: "Barcelona",
    },
    invoice_number: "2026/0001",
    issue_date: "2026-08-01",
    due_date: "2026-08-31",
    period_start: "2026-07-01",
    vat_rate: 21,
    payment_method: "transferencia",
    payment_terms_days: 30,
    kind: "ordinaria",
    lineas: [
      { description: "Limpieza — Oficina Centro (01/07–14/07)", hours: 38.25, hourly_rate: 14, amount: 535.5 },
      { description: "Limpieza — Oficina Centro (15/07–31/07)", hours: 41.5, hourly_rate: 15, amount: 622.5 },
      { description: "Limpieza — Nave Norte", hours: 22, hourly_rate: 13.5, amount: 297 },
    ],
    subtotalCentimos: 145500,
    ivaCentimos: 30555,
    totalCentimos: 176055,
    ...overrides,
  };
}

describe("textoSeguro (WinAnsi)", () => {
  it("deja pasar acentos, ñ, º y €", () => {
    expect(textoSeguro("Facturación Ñoño 3º 1.455,00 €")).toBe(
      "Facturación Ñoño 3º 1.455,00 €",
    );
  });

  it("conserva la raya y el guion largo del SPEC", () => {
    expect(textoSeguro("Limpieza — Oficina (01/07–14/07)")).toBe(
      "Limpieza — Oficina (01/07–14/07)",
    );
  });

  it("transcribe lo que WinAnsi no puede escribir en vez de reventar", () => {
    // ā no existe en CP1252: se queda en 'a' en vez de romper la emisión.
    expect(textoSeguro("Rāma")).toBe("Rama");
    // Sin equivalente latino, interrogante.
    expect(textoSeguro("北京")).toBe("??");
  });
});

describe("generarPdfFactura", () => {
  it("genera un PDF no vacío con los datos de empresa, cliente e importes", async () => {
    const bytes = await generarPdfFactura(datos());

    expect(bytes.length).toBeGreaterThan(1000);
    // Cabecera de fichero PDF.
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");

    const texto = textoDelPdf(bytes);

    // Empresa (con ñ y acento, el caso de codificación del SPEC).
    expect(texto).toContain("Facturación Ñoño S.L.");
    expect(texto).toContain("B12345678");
    expect(texto).toContain("Calle Mayor 1");
    expect(texto).toContain("28001 Madrid (Madrid)");

    // Cliente.
    expect(texto).toContain("Cliente Ejemplo S.A.");
    expect(texto).toContain("A87654321");

    // Número, fechas y periodo.
    expect(texto).toContain("FACTURA");
    expect(texto).toContain("2026/0001");
    expect(texto).toContain("01/08/2026");
    expect(texto).toContain("31/08/2026");
    expect(texto).toContain("julio de 2026");

    // Desglose por centro.
    expect(texto).toContain("Nave Norte");
    expect(texto).toContain("38,25");
    expect(texto).toContain("535,50 €");
    expect(texto).toContain("622,50 €");
    expect(texto).toContain("297,00 €");

    // Totales del ejemplo del SPEC.
    expect(texto).toContain("Base imponible");
    expect(texto).toContain("1.455,00 €");
    expect(texto).toContain("IVA 21 %");
    expect(texto).toContain("305,55 €");
    expect(texto).toContain("TOTAL");
    expect(texto).toContain("1.760,55 €");

    // Cobro.
    expect(texto).toContain("transferencia");
    expect(texto).toContain("ES91 2100 0418 4502 0005 1332");
  });

  it("es A4 vertical y de una sola página con pocas líneas", async () => {
    const doc = await PDFDocument.load(await generarPdfFactura(datos()));

    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
  });

  it("una factura de 60 líneas ocupa más de una página y las numera", async () => {
    const lineas: LineaPdf[] = Array.from({ length: 60 }, (_, i) => ({
      description: `Limpieza — Centro ${i + 1} (01/07–31/07)`,
      hours: 10,
      hourly_rate: 14,
      amount: 140,
    }));

    const bytes = await generarPdfFactura(datos({ lineas }));
    const doc = await PDFDocument.load(bytes);

    expect(doc.getPageCount()).toBeGreaterThan(1);

    const texto = textoDelPdf(bytes);
    expect(texto).toContain(`Página 1 de ${doc.getPageCount()}`);
    expect(texto).toContain(`Página ${doc.getPageCount()} de ${doc.getPageCount()}`);
    // La cabecera de la tabla se repite en cada página.
    expect(texto.match(/Concepto/g)?.length).toBe(doc.getPageCount());
    // Y el total aparece una sola vez, al final.
    expect(texto.match(/Base imponible/g)?.length).toBe(1);
  });

  it("marca las rectificativas y a qué factura rectifican", async () => {
    const bytes = await generarPdfFactura(
      datos({
        kind: "rectificativa",
        invoice_number: "R-2026/0001",
        rectifica: { invoice_number: "2026/0007", issue_date: "2026-07-01" },
      }),
    );

    const texto = textoDelPdf(bytes);
    expect(texto).toContain("FACTURA RECTIFICATIVA");
    expect(texto).toContain("R-2026/0001");
    expect(texto).toContain("Rectifica a 2026/0007");
  });

  it("aguanta un cliente exento y sin datos opcionales", async () => {
    const bytes = await generarPdfFactura(
      datos({
        vat_rate: 0,
        ivaCentimos: 0,
        totalCentimos: 145500,
        due_date: null,
        payment_method: null,
        payment_terms_days: null,
        empresa: { ...datos().empresa, iban: null, province: null },
      }),
    );

    const texto = textoDelPdf(bytes);
    expect(texto).toContain("IVA 0 %");
    expect(texto).not.toContain("Vencimiento");
  });
});
