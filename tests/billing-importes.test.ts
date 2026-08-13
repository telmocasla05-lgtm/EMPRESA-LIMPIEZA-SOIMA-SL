import { describe, expect, it } from "vitest";
import { type CentroHoras } from "@/lib/billing/horas";
import {
  calcularTotales,
  eurosACentimos,
  formatCentimos,
  formatEuros,
  formatFecha,
  formatHoras,
  formatMes,
  formatPorcentaje,
  horasCentesimas,
  importeLineaCentimos,
} from "@/lib/billing/importes";

function centro(name: string, minutes: number, id = name): CentroHoras {
  return {
    center_id: id,
    center_name: name,
    minutes,
    hours: minutes / 60,
    jornadas: [],
  };
}

describe("aritmética en enteros (SPEC 4.5)", () => {
  it("convierte minutos a centésimas de hora", () => {
    expect(horasCentesimas(2295)).toBe(3825); // 38 h 15 min
    expect(horasCentesimas(2490)).toBe(4150); // 41 h 30 min
    expect(horasCentesimas(1320)).toBe(2200); // 22 h
  });

  it("calcula el importe de línea con las horas ya redondeadas", () => {
    // Los tres ejemplos del PDF del SPEC (sección 7).
    expect(importeLineaCentimos(3825, 1400)).toBe(53550); // 535,50 €
    expect(importeLineaCentimos(4150, 1500)).toBe(62250); // 622,50 €
    expect(importeLineaCentimos(2200, 1350)).toBe(29700); // 297,00 €
  });

  it("reproduce el total del ejemplo del SPEC", () => {
    const totales = calcularTotales({
      porCentro: [centro("Oficina Centro", 2295)],
      totalMinutes: 2295,
      hourlyRate: 14,
      vatRate: 21,
    });

    expect(totales.lineas[0].hours).toBe(38.25);
    expect(totales.lineas[0].amount).toBe(535.5);
    expect(totales.subtotalCentimos).toBe(53550);
  });

  it("suma varias líneas y aplica el IVA sobre la base", () => {
    // 1.455,00 € de base -> 305,55 € de IVA -> 1.760,55 € (PDF del SPEC).
    const totales = calcularTotales({
      porCentro: [centro("A", 2295), centro("B", 2490), centro("C", 1320)],
      totalMinutes: 2295 + 2490 + 1320,
      hourlyRate: 14,
      vatRate: 21,
    });

    // Con una tarifa única las líneas no dan los importes del ejemplo, pero
    // la mecánica de base/IVA/total sí se comprueba aquí.
    expect(totales.ivaCentimos).toBe(
      Math.round((totales.subtotalCentimos * 21) / 100),
    );
    expect(totales.totalCentimos).toBe(
      totales.subtotalCentimos + totales.ivaCentimos,
    );
  });

  it("da 0 de IVA en un cliente exento", () => {
    const totales = calcularTotales({
      porCentro: [centro("A", 600)],
      totalMinutes: 600,
      hourlyRate: 12,
      vatRate: 0,
    });

    expect(totales.subtotalCentimos).toBe(12000);
    expect(totales.ivaCentimos).toBe(0);
    expect(totales.totalCentimos).toBe(12000);
    expect(totales.total).toBe(120);
  });

  it("no acumula error de coma flotante en muchas líneas", () => {
    // 60 líneas de 2 h 25 min a 13,37 €/h.
    const centros = Array.from({ length: 60 }, (_, i) =>
      centro(`Centro ${i}`, 145, `c${i}`),
    );
    const totales = calcularTotales({
      porCentro: centros,
      totalMinutes: 145 * 60,
      hourlyRate: 13.37,
      vatRate: 21,
    });

    const unaLinea = importeLineaCentimos(242, 1337);
    expect(totales.subtotalCentimos).toBe(unaLinea * 60);
    // Enteros exactos: nada de 0,30000000000000004.
    expect(Number.isInteger(totales.subtotalCentimos)).toBe(true);
    expect(Number.isInteger(totales.ivaCentimos)).toBe(true);
  });

  it("el total de horas sale de los minutos, no de sumar las líneas", () => {
    const totales = calcularTotales({
      porCentro: [centro("A", 145), centro("B", 145)],
      totalMinutes: 290,
      hourlyRate: 10,
      vatRate: 21,
    });

    expect(totales.lineas[0].hours).toBe(2.42);
    expect(totales.lineas[1].hours).toBe(2.42);
    expect(totales.totalHours).toBe(4.83);
  });

  it("convierte euros a céntimos sin perder el medio céntimo", () => {
    expect(eurosACentimos(14)).toBe(1400);
    expect(eurosACentimos(13.37)).toBe(1337);
    expect(eurosACentimos(0)).toBe(0);
  });
});

describe("formato español (SPEC 7)", () => {
  it("pone coma decimal y punto de miles", () => {
    expect(formatCentimos(145500)).toBe("1.455,00");
    expect(formatCentimos(53550)).toBe("535,50");
    expect(formatCentimos(0)).toBe("0,00");
    expect(formatCentimos(5)).toBe("0,05");
    expect(formatCentimos(123456789)).toBe("1.234.567,89");
  });

  it("mantiene el punto de miles en los números de 4 cifras", () => {
    // Intl con es-ES devolvería "1455,00": por eso se formatea a mano.
    expect(formatCentimos(100000)).toBe("1.000,00");
  });

  it("formatea importes negativos (rectificativas)", () => {
    expect(formatCentimos(-53550)).toBe("-535,50");
    expect(formatEuros(-53550)).toBe("-535,50 €");
  });

  it("pone el € al final", () => {
    expect(formatEuros(145500)).toBe("1.455,00 €");
  });

  it("formatea horas con 2 decimales", () => {
    expect(formatHoras(38.25)).toBe("38,25");
    expect(formatHoras(8)).toBe("8,00");
  });

  it("formatea el porcentaje sin decimales inútiles", () => {
    expect(formatPorcentaje(21)).toBe("21 %");
    expect(formatPorcentaje(0)).toBe("0 %");
    expect(formatPorcentaje(21.5)).toBe("21,5 %");
  });

  it("formatea fechas y meses", () => {
    expect(formatFecha("2026-08-01")).toBe("01/08/2026");
    expect(formatFecha("2026-12-31")).toBe("31/12/2026");
    expect(formatMes("2026-07-01")).toBe("julio de 2026");
    expect(formatMes("2026-01-15")).toBe("enero de 2026");
  });
});
