// Aritmética del dinero de una factura (SPEC-facturacion.md 4.5).
//
// Nada de sumas de decimales en coma flotante: todo se calcula con enteros
// —minutos, centésimas de hora y céntimos— y solo se divide al presentar.

import { minutosAHoras, redondeoHalfUp, type CentroHoras } from "@/lib/billing/horas";

export type LineaCalculada = {
  center_id: string;
  center_name: string;
  description: string;
  minutes: number;
  hours: number;
  hourly_rate: number;
  amount: number;
  importeCentimos: number;
};

export type TotalesFactura = {
  lineas: LineaCalculada[];
  totalMinutes: number;
  totalHours: number;
  subtotalCentimos: number;
  ivaCentimos: number;
  totalCentimos: number;
  subtotal: number;
  vatAmount: number;
  total: number;
};

// Centésimas de hora de un total de minutos: el entero con el que se
// multiplica la tarifa.
export function horasCentesimas(minutes: number): number {
  return redondeoHalfUp((minutes * 100) / 60);
}

export function eurosACentimos(euros: number): number {
  return redondeoHalfUp(euros * 100);
}

// Importe de una línea, en céntimos.
//
// OJO: el SPEC escribe `redondeoHalfUp(horasCentesimas × tarifaCentimos /
// 10000)`, y ese divisor es una errata. horasCentesimas × tarifaCentimos son
// euros × 10.000, así que para llegar a céntimos (euros × 100) hay que dividir
// entre 100, no entre 10.000. Con 10.000 el ejemplo del propio SPEC —38,25 h ×
// 14,00 € = 535,50 €— daría 536 € y se perderían los céntimos. Dividiendo
// entre 100 salen exactamente los números del PDF de la sección 7.
export function importeLineaCentimos(
  centesimas: number,
  tarifaCentimos: number,
): number {
  return redondeoHalfUp((centesimas * tarifaCentimos) / 100);
}

// El importe se calcula con las horas YA redondeadas a 2 decimales, no con los
// minutos exactos: así el cliente multiplica lo que ve impreso y le cuadra al
// céntimo (SPEC 4.5).
export function calcularTotales({
  porCentro,
  totalMinutes,
  hourlyRate,
  vatRate,
  descripcion,
}: {
  porCentro: CentroHoras[];
  totalMinutes: number;
  hourlyRate: number;
  vatRate: number;
  descripcion?: (centro: CentroHoras) => string;
}): TotalesFactura {
  const tarifaCentimos = eurosACentimos(hourlyRate);

  const lineas: LineaCalculada[] = porCentro.map((centro) => {
    const centesimas = horasCentesimas(centro.minutes);
    const importeCentimos = importeLineaCentimos(centesimas, tarifaCentimos);
    return {
      center_id: centro.center_id,
      center_name: centro.center_name,
      description: descripcion
        ? descripcion(centro)
        : `Limpieza — ${centro.center_name}`,
      minutes: centro.minutes,
      hours: centesimas / 100,
      hourly_rate: tarifaCentimos / 100,
      amount: importeCentimos / 100,
      importeCentimos,
    };
  });

  const subtotalCentimos = lineas.reduce((s, l) => s + l.importeCentimos, 0);
  const ivaCentimos = redondeoHalfUp((subtotalCentimos * vatRate) / 100);
  const totalCentimos = subtotalCentimos + ivaCentimos;

  return {
    lineas,
    totalMinutes,
    // Desde los minutos del periodo, no sumando las horas ya redondeadas de
    // cada línea: puede diferir en 0,01 h y es correcto (SPEC 4.5).
    totalHours: minutosAHoras(totalMinutes),
    subtotalCentimos,
    ivaCentimos,
    totalCentimos,
    subtotal: subtotalCentimos / 100,
    vatAmount: ivaCentimos / 100,
    total: totalCentimos / 100,
  };
}

// ---------------------------------------------------------------------------
// Formato español: decimales con coma, miles con punto, € al final.
// ---------------------------------------------------------------------------

// Se formatea a mano en vez de con Intl: la configuración regional de es-ES
// omite el separador de miles en los números de 4 cifras (1455 en vez de
// 1.455), y el PDF del SPEC lo lleva siempre.
export function formatCentimos(centimos: number): string {
  const negativo = centimos < 0;
  const abs = Math.abs(Math.round(centimos));
  const enteros = String(Math.floor(abs / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ".",
  );
  const decimales = String(abs % 100).padStart(2, "0");
  return `${negativo ? "-" : ""}${enteros},${decimales}`;
}

export function formatEuros(centimos: number): string {
  return `${formatCentimos(centimos)} €`;
}

// Horas con 2 decimales: 38,25
export function formatHoras(hours: number): string {
  return formatCentimos(redondeoHalfUp(hours * 100));
}

// 21 % / 21,5 % / 0 %
export function formatPorcentaje(rate: number): string {
  const texto = formatCentimos(redondeoHalfUp(rate * 100))
    .replace(/,00$/, "")
    .replace(/(,\d)0$/, "$1");
  return `${texto} %`;
}

export function formatFecha(isoDate: string): string {
  const [anio, mes, dia] = isoDate.slice(0, 10).split("-");
  return `${dia}/${mes}/${anio}`;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// 'julio de 2026', para la línea "Periodo facturado".
export function formatMes(isoDate: string): string {
  const [anio, mes] = isoDate.slice(0, 10).split("-");
  return `${MESES[Number(mes) - 1]} de ${anio}`;
}
