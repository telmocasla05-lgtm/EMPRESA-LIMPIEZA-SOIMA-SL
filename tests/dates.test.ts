import { describe, expect, it } from "vitest";
import {
  addDays,
  formatDuracion,
  formatHora,
  madridDateOf,
  madridDayStart,
  madridHourOf,
  madridInstant,
  madridNextDayStart,
  madridToday,
  mondayOf,
  monthPeriod,
  previousMonth,
} from "@/lib/dates";

// De estas conversiones dependen el margen de gracia de las ausencias
// (isPastGrace), la ventana de presencia (hasCheckedIn) y la hora que ve el
// operario al fichar. El reloj de los tests va en UTC (vitest.config.ts), así
// que un fallo de zona horaria se nota aquí.

describe("madridInstant", () => {
  it("convierte hora local de verano (CEST, +2)", () => {
    expect(madridInstant("2026-08-03", "09:00").toISOString()).toBe(
      "2026-08-03T07:00:00.000Z",
    );
  });

  it("convierte hora local de invierno (CET, +1)", () => {
    expect(madridInstant("2026-01-15", "09:00").toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("acierta en la madrugada del domingo en que se adelanta el reloj", () => {
    // 29/03/2026: a las 02:00 locales el reloj salta a las 03:00. Las 01:30
    // todavía son CET (+1); calcular el desfase sobre el instante aproximado
    // las daba una hora antes de lo debido.
    expect(madridInstant("2026-03-29", "01:30").toISOString()).toBe(
      "2026-03-29T00:30:00.000Z",
    );
  });

  it("resuelve hacia adelante una hora local que no existe", () => {
    // Las 02:30 de ese domingo no existen: se toman como las 03:30 (CEST).
    expect(madridInstant("2026-03-29", "02:30").toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("acierta en el domingo en que se atrasa el reloj", () => {
    expect(madridInstant("2026-10-25", "03:30").toISOString()).toBe(
      "2026-10-25T02:30:00.000Z",
    );
  });
});

describe("límites del día natural de Madrid", () => {
  it("el día empieza a las 22:00 UTC del día anterior en verano", () => {
    expect(madridDayStart("2026-08-03").toISOString()).toBe(
      "2026-08-02T22:00:00.000Z",
    );
    expect(madridNextDayStart("2026-08-03").toISOString()).toBe(
      "2026-08-03T22:00:00.000Z",
    );
  });

  it("el día empieza a las 23:00 UTC del día anterior en invierno", () => {
    expect(madridDayStart("2026-01-15").toISOString()).toBe(
      "2026-01-14T23:00:00.000Z",
    );
  });

  it("un instante nocturno UTC ya cuenta como el día siguiente en Madrid", () => {
    expect(madridDateOf("2026-08-03T22:30:00Z")).toBe("2026-08-04");
    expect(madridDateOf("2026-01-15T23:30:00Z")).toBe("2026-01-16");
    expect(madridToday()).toBe(madridDateOf(new Date()));
  });
});

describe("formato de hora", () => {
  it("muestra la hora de Madrid, no la UTC", () => {
    expect(formatHora("2026-08-03T07:00:00Z")).toBe("09:00");
    expect(formatHora("2026-01-15T08:00:00Z")).toBe("09:00");
  });

  it("pasada la medianoche de Madrid muestra la hora del día nuevo", () => {
    expect(formatHora("2026-08-03T22:30:00Z")).toBe("00:30");
    expect(madridHourOf("2026-08-03T22:30:00Z")).toBe(0);
  });
});

describe("aritmética de calendario", () => {
  it("suma y resta días sobre la fecha", () => {
    expect(addDays("2026-08-03", 1)).toBe("2026-08-04");
    expect(addDays("2026-08-03", -1)).toBe("2026-08-02");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("mondayOf devuelve el lunes de esa semana", () => {
    expect(mondayOf("2026-08-03")).toBe("2026-08-03"); // ya es lunes
    expect(mondayOf("2026-08-06")).toBe("2026-08-03"); // jueves
    expect(mondayOf("2026-08-02")).toBe("2026-07-27"); // domingo
  });

  it("formatDuracion redondea a minutos y nunca da negativos", () => {
    expect(formatDuracion(3_900_000)).toBe("1 h 05 min");
    expect(formatDuracion(0)).toBe("0 h 00 min");
    expect(formatDuracion(-5_000)).toBe("0 h 00 min");
  });
});

describe("periodos mensuales de facturación", () => {
  it("monthPeriod cubre el mes entero, sea de 28, 30 o 31 días", () => {
    expect(monthPeriod("2026-07")).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    expect(monthPeriod("2026-04").periodEnd).toBe("2026-04-30");
    expect(monthPeriod("2026-02").periodEnd).toBe("2026-02-28");
    expect(monthPeriod("2028-02").periodEnd).toBe("2028-02-29"); // bisiesto
    expect(monthPeriod("2026-12").periodEnd).toBe("2026-12-31"); // cambio de año
  });

  it("monthPeriod rechaza un mes que no existe", () => {
    expect(() => monthPeriod("2026-13")).toThrow(/no válido/);
    expect(() => monthPeriod("julio")).toThrow(/no válido/);
  });

  it("previousMonth retrocede un mes, también en enero", () => {
    expect(previousMonth("2026-08-15")).toBe("2026-07");
    expect(previousMonth("2026-03-01")).toBe("2026-02");
    // El cierre del 1 de enero factura diciembre del año anterior.
    expect(previousMonth("2027-01-01")).toBe("2026-12");
  });
});
