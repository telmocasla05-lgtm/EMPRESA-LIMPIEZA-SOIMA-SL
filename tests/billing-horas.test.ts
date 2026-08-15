import { describe, expect, it } from "vitest";
import { madridInstant } from "@/lib/dates";
import {
  calcularHorasFacturables,
  emparejarJornadas,
  MAX_JORNADA_MINUTES,
  minutosAHoras,
  redondeoHalfUp,
  type CentroRow,
  type TimeEntryRow,
} from "@/lib/billing/horas";

// Los tests corren con TZ=UTC (vitest.config.ts), así que las horas se
// construyen siempre con madridInstant: si el cálculo dependiera de la zona
// de la máquina, aquí se vería.

const CENTRO_A = "centro-a";
const CENTRO_B = "centro-b";
const CENTRO_AJENO = "centro-de-otro-cliente";

const centros: CentroRow[] = [
  { id: CENTRO_A, name: "Oficina Centro" },
  { id: CENTRO_B, name: "Nave Norte" },
];

const JULIO = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };

let contador = 0;

function fichaje(
  type: "entrada" | "salida",
  fecha: string,
  hora: string,
  extra: Partial<TimeEntryRow> = {},
): TimeEntryRow {
  contador += 1;
  return {
    id: `fichaje-${contador}`,
    worker_id: "worker-1",
    center_id: CENTRO_A,
    type,
    valid: true,
    created_at: madridInstant(fecha, hora).toISOString(),
    ...extra,
  };
}

// Una jornada completa: entrada y salida el mismo día, salvo que se indique
// otra fecha de salida.
function jornada(
  fecha: string,
  desde: string,
  hasta: string,
  extra: Partial<TimeEntryRow> = {},
  fechaSalida = fecha,
): TimeEntryRow[] {
  return [
    fichaje("entrada", fecha, desde, extra),
    fichaje("salida", fechaSalida, hasta, extra),
  ];
}

function calcular(entries: TimeEntryRow[], periodo = JULIO) {
  return calcularHorasFacturables({ entries, centros, ...periodo });
}

describe("redondeo (SPEC 4.5)", () => {
  it("redondea half up sobre el valor absoluto", () => {
    expect(redondeoHalfUp(0.5)).toBe(1);
    expect(redondeoHalfUp(1.4)).toBe(1);
    expect(redondeoHalfUp(1.5)).toBe(2);
  });

  it("no devuelve -0 en los negativos, a diferencia de Math.round", () => {
    // Math.round(-0.5) es -0: rompería los importes de una rectificativa.
    expect(Object.is(Math.round(-0.5), -0)).toBe(true);
    expect(redondeoHalfUp(-0.5)).toBe(-1);
    expect(redondeoHalfUp(-1.5)).toBe(-2);
  });

  it("convierte minutos a horas con 2 decimales", () => {
    // 38 h 15 min, el ejemplo del SPEC.
    expect(minutosAHoras(2295)).toBe(38.25);
    expect(minutosAHoras(480)).toBe(8);
    expect(minutosAHoras(0)).toBe(0);
    // Minutos que no caen redondos.
    expect(minutosAHoras(2497)).toBe(41.62);
    expect(minutosAHoras(145)).toBe(2.42);
  });
});

describe("emparejarJornadas (SPEC 4.1)", () => {
  it("empareja una entrada con su salida", () => {
    const { jornadas, incidencias } = emparejarJornadas(
      jornada("2026-07-06", "08:00", "16:00"),
    );

    expect(incidencias).toEqual([]);
    expect(jornadas).toHaveLength(1);
    expect(jornadas[0].minutes).toBe(480);
    expect(jornadas[0].work_date).toBe("2026-07-06");
    expect(jornadas[0].center_id).toBe(CENTRO_A);
  });

  it("una entrada sin salida no genera horas y sí incidencia", () => {
    const { jornadas, incidencias } = emparejarJornadas([
      fichaje("entrada", "2026-07-06", "08:00"),
    ]);

    expect(jornadas).toEqual([]);
    expect(incidencias).toHaveLength(1);
    expect(incidencias[0].codigo).toBe("entrada_sin_salida");
    expect(incidencias[0].entry_out_id).toBeNull();
  });

  it("una salida suelta genera salida_sin_entrada", () => {
    const { jornadas, incidencias } = emparejarJornadas([
      fichaje("salida", "2026-07-06", "16:00"),
    ]);

    expect(jornadas).toEqual([]);
    expect(incidencias).toHaveLength(1);
    expect(incidencias[0].codigo).toBe("salida_sin_entrada");
    expect(incidencias[0].entry_in_id).toBeNull();
  });

  it("dos entradas seguidas: la primera queda huérfana y la segunda se cierra", () => {
    const primera = fichaje("entrada", "2026-07-06", "08:00");
    const segunda = fichaje("entrada", "2026-07-06", "10:00");
    const salida = fichaje("salida", "2026-07-06", "14:00");

    const { jornadas, incidencias } = emparejarJornadas([primera, segunda, salida]);

    expect(incidencias).toHaveLength(1);
    expect(incidencias[0].codigo).toBe("entrada_sin_salida");
    expect(incidencias[0].entry_in_id).toBe(primera.id);

    expect(jornadas).toHaveLength(1);
    expect(jornadas[0].entry_in_id).toBe(segunda.id);
    expect(jornadas[0].minutes).toBe(240);
  });

  it("empareja por operario, sin mezclar a dos que se solapan", () => {
    const entries = [
      fichaje("entrada", "2026-07-06", "08:00", { worker_id: "ana" }),
      fichaje("entrada", "2026-07-06", "09:00", { worker_id: "luis" }),
      fichaje("salida", "2026-07-06", "16:00", { worker_id: "ana" }),
      fichaje("salida", "2026-07-06", "17:00", { worker_id: "luis" }),
    ];

    const { jornadas, incidencias } = emparejarJornadas(entries);

    expect(incidencias).toEqual([]);
    expect(jornadas).toHaveLength(2);
    expect(jornadas.every((j) => j.minutes === 480)).toBe(true);
  });

  it("ordena por created_at aunque lleguen desordenados", () => {
    const [entrada, salida] = jornada("2026-07-06", "08:00", "16:00");
    const { jornadas, incidencias } = emparejarJornadas([salida, entrada]);

    expect(incidencias).toEqual([]);
    expect(jornadas[0].minutes).toBe(480);
  });

  it("una jornada de 20 h es duracion_excesiva", () => {
    const { jornadas, incidencias } = emparejarJornadas(
      jornada("2026-07-06", "04:00", "00:00", {}, "2026-07-07"),
    );

    expect(jornadas).toEqual([]);
    expect(incidencias[0].codigo).toBe("duracion_excesiva");
  });

  // La frontera exacta del límite: doblar turno son 16 h clavadas y se
  // factura; un minuto más ya es un fichaje mal cerrado. Sin este test, dar la
  // vuelta al operador de horas.ts (> por >=) no rompería nada.
  it("16 h exactas se facturan y 16 h y 1 min son duracion_excesiva", () => {
    const justo = emparejarJornadas(jornada("2026-07-06", "06:00", "22:00"));
    expect(justo.incidencias).toEqual([]);
    expect(justo.jornadas[0].minutes).toBe(MAX_JORNADA_MINUTES);

    const pasado = emparejarJornadas(jornada("2026-07-07", "06:00", "22:01"));
    expect(pasado.jornadas).toEqual([]);
    expect(pasado.incidencias[0].codigo).toBe("duracion_excesiva");
  });

  // Los fichajes reales llegan de WhatsApp con created_at al segundo, no en
  // minutos redondos: este redondeo es el único que se aplica a datos de
  // producción.
  it("redondea a minutos los segundos del fichaje", () => {
    const conSegundos = (desde: string, hasta: string) => {
      const [entrada, salida] = jornada("2026-07-06", "08:00", "16:00");
      return emparejarJornadas([
        { ...entrada, created_at: `2026-07-06T${desde}Z` },
        { ...salida, created_at: `2026-07-06T${hasta}Z` },
      ]).jornadas[0].minutes;
    };

    // 7 h 30 min 29 s → 450 min; 30 s justos → 451 (half up).
    expect(conSegundos("06:00:00.000", "13:30:29.000")).toBe(450);
    expect(conSegundos("06:00:00.000", "13:30:30.000")).toBe(451);
    expect(conSegundos("06:00:00.000", "13:30:31.000")).toBe(451);
  });

  it("entrar y salir en el mismo minuto es duracion_cero", () => {
    const { jornadas, incidencias } = emparejarJornadas(
      jornada("2026-07-06", "08:00", "08:00"),
    );

    expect(jornadas).toEqual([]);
    expect(incidencias[0].codigo).toBe("duracion_cero");
  });

  it("entrar en un centro y salir en otro es centro_distinto", () => {
    const entries = [
      fichaje("entrada", "2026-07-06", "08:00", { center_id: CENTRO_A }),
      fichaje("salida", "2026-07-06", "16:00", { center_id: CENTRO_B }),
    ];

    const { jornadas, incidencias } = emparejarJornadas(entries);

    expect(jornadas).toEqual([]);
    expect(incidencias[0].codigo).toBe("centro_distinto");
    // Se atribuye al centro de la entrada.
    expect(incidencias[0].center_id).toBe(CENTRO_A);
  });

  it("un fichaje sin centro es sin_centro", () => {
    const entries = [
      fichaje("entrada", "2026-07-06", "08:00", { center_id: null }),
      fichaje("salida", "2026-07-06", "16:00", { center_id: CENTRO_A }),
    ];

    const { jornadas, incidencias } = emparejarJornadas(entries);

    expect(jornadas).toEqual([]);
    expect(incidencias[0].codigo).toBe("sin_centro");
    // Sin centro en la entrada, se atribuye por el de la salida.
    expect(incidencias[0].center_id).toBe(CENTRO_A);
  });

  it("la validez se comprueba antes que el centro", () => {
    // Fichaje inválido Y sin centro: manda fichaje_no_valido (decisión 3).
    const entries = [
      fichaje("entrada", "2026-07-06", "08:00", { valid: false, center_id: null }),
      fichaje("salida", "2026-07-06", "16:00", { center_id: CENTRO_A }),
    ];

    expect(emparejarJornadas(entries).incidencias[0].codigo).toBe(
      "fichaje_no_valido",
    );
  });

  it("cuenta los minutos reales en el día de 25 h de octubre", () => {
    // El 25/10/2026 los relojes atrasan a las 03:00: de 00:00 a 08:00 locales
    // pasan 9 horas reales, no 8.
    const { jornadas } = emparejarJornadas(
      jornada("2026-10-25", "00:00", "08:00"),
    );

    expect(jornadas[0].minutes).toBe(540);
    expect(minutosAHoras(jornadas[0].minutes)).toBe(9);
  });
});

describe("calcularHorasFacturables: mes normal", () => {
  it("suma las jornadas del mes y las agrupa por centro", () => {
    const entries = [
      ...jornada("2026-07-06", "08:00", "16:00"),
      ...jornada("2026-07-07", "08:00", "16:00"),
      ...jornada("2026-07-08", "08:00", "14:00"),
    ];

    const resultado = calcular(entries);

    expect(resultado.bloqueada).toBe(false);
    expect(resultado.incidencias).toEqual([]);
    expect(resultado.porCentro).toHaveLength(1);
    expect(resultado.porCentro[0].center_id).toBe(CENTRO_A);
    expect(resultado.porCentro[0].center_name).toBe("Oficina Centro");
    expect(resultado.porCentro[0].minutes).toBe(480 + 480 + 360);
    expect(resultado.porCentro[0].hours).toBe(22);
    expect(resultado.porCentro[0].jornadas).toHaveLength(3);
    expect(resultado.totalMinutes).toBe(1320);
    expect(resultado.totalHours).toBe(22);
  });

  it("deja fuera las jornadas de otro mes", () => {
    const entries = [
      ...jornada("2026-06-15", "08:00", "16:00"),
      ...jornada("2026-07-06", "08:00", "16:00"),
      ...jornada("2026-08-03", "08:00", "16:00"),
    ];

    const resultado = calcular(entries);

    expect(resultado.totalMinutes).toBe(480);
    expect(resultado.porCentro[0].jornadas[0].work_date).toBe("2026-07-06");
  });

  it("un cliente sin ninguna jornada no da horas ni bloquea", () => {
    const resultado = calcular([]);

    expect(resultado.porCentro).toEqual([]);
    expect(resultado.totalHours).toBe(0);
    expect(resultado.bloqueada).toBe(false);
  });
});

describe("calcularHorasFacturables: fichajes no válidos mezclados", () => {
  it("excluye las horas del fichaje no válido pero cuenta las demás", () => {
    const entries = [
      ...jornada("2026-07-06", "08:00", "16:00"),
      ...jornada("2026-07-07", "08:00", "16:00", { valid: false }),
      ...jornada("2026-07-08", "08:00", "16:00"),
    ];

    const resultado = calcular(entries);

    // Solo las dos jornadas válidas.
    expect(resultado.totalMinutes).toBe(960);
    expect(resultado.totalHours).toBe(16);
    expect(resultado.porCentro[0].jornadas).toHaveLength(2);

    // Y la no válida bloquea la emisión (decisión 3).
    expect(resultado.incidencias).toHaveLength(1);
    expect(resultado.incidencias[0].codigo).toBe("fichaje_no_valido");
    expect(resultado.bloqueada).toBe(true);
  });

  it("acumula varias incidencias distintas del mismo cliente", () => {
    const entries = [
      ...jornada("2026-07-06", "08:00", "16:00"),
      fichaje("entrada", "2026-07-07", "08:00"),
      ...jornada("2026-07-09", "08:00", "16:00", { valid: false }),
    ];

    const resultado = calcular(entries);

    expect(resultado.totalMinutes).toBe(480);
    expect(resultado.incidencias.map((i) => i.codigo).sort()).toEqual([
      "entrada_sin_salida",
      "fichaje_no_valido",
    ]);
    expect(resultado.bloqueada).toBe(true);
  });

  it("una incidencia sin centro no se atribuye a este cliente", () => {
    // Los dos fichajes sin centro: va a la bandeja "Sin asignar" (SPEC 4.2),
    // no a la factura de este cliente.
    const entries = [
      ...jornada("2026-07-06", "08:00", "16:00"),
      ...jornada("2026-07-07", "08:00", "16:00", { center_id: null }),
    ];

    const resultado = calcular(entries);

    expect(resultado.totalMinutes).toBe(480);
    expect(resultado.incidencias).toEqual([]);
    expect(resultado.bloqueada).toBe(false);
  });
});

describe("calcularHorasFacturables: centro sin fichajes", () => {
  it("un centro sin actividad no aparece en el desglose", () => {
    const entries = jornada("2026-07-06", "08:00", "16:00", {
      center_id: CENTRO_A,
    });

    const resultado = calcular(entries);

    // CENTRO_B es del cliente pero no tuvo actividad: sin línea de factura.
    expect(resultado.porCentro).toHaveLength(1);
    expect(resultado.porCentro.map((c) => c.center_id)).not.toContain(CENTRO_B);
    expect(resultado.totalHours).toBe(8);
  });

  it("ningún centro con actividad deja el desglose vacío", () => {
    const resultado = calcularHorasFacturables({
      entries: [],
      centros,
      ...JULIO,
    });

    expect(resultado.porCentro).toEqual([]);
    expect(resultado.totalMinutes).toBe(0);
  });
});

describe("calcularHorasFacturables: jornada que cruza la medianoche", () => {
  it("cuenta entera la jornada nocturna dentro del mes", () => {
    const entries = jornada("2026-07-06", "22:00", "06:00", {}, "2026-07-07");

    const resultado = calcular(entries);

    expect(resultado.totalMinutes).toBe(480);
    expect(resultado.totalHours).toBe(8);
    expect(resultado.porCentro[0].jornadas[0].work_date).toBe("2026-07-06");
  });

  it("la jornada del 31 se imputa al mes de la entrada y no se repite", () => {
    // Entra el 31/03 a las 22:00 y sale el 01/04 a las 06:00 (decisión 13).
    const entries = jornada("2026-03-31", "22:00", "06:00", {}, "2026-04-01");

    const marzo = calcular(entries, {
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
    });
    expect(marzo.totalMinutes).toBe(480);
    expect(marzo.totalHours).toBe(8);
    expect(marzo.porCentro[0].jornadas[0].work_date).toBe("2026-03-31");

    // En abril no vuelve a aparecer...
    const abril = calcular(entries, {
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
    });
    expect(abril.totalMinutes).toBe(0);
    expect(abril.porCentro).toEqual([]);

    // ...y su salida no se confunde con una salida suelta, que bloquearía
    // abril con una incidencia falsa.
    expect(abril.incidencias).toEqual([]);
    expect(abril.bloqueada).toBe(false);
  });
});

describe("calcularHorasFacturables: cliente con varios centros", () => {
  it("desglosa por centro y ordena por nombre", () => {
    const entries = [
      ...jornada("2026-07-06", "08:00", "16:00", { center_id: CENTRO_A }),
      ...jornada("2026-07-07", "08:00", "16:00", { center_id: CENTRO_A }),
      ...jornada("2026-07-08", "09:00", "14:00", { center_id: CENTRO_B }),
    ];

    const resultado = calcular(entries);

    expect(resultado.porCentro).toHaveLength(2);
    // "Nave Norte" antes que "Oficina Centro" (SPEC 4.4).
    expect(resultado.porCentro.map((c) => c.center_name)).toEqual([
      "Nave Norte",
      "Oficina Centro",
    ]);
    expect(resultado.porCentro[0].minutes).toBe(300);
    expect(resultado.porCentro[0].hours).toBe(5);
    expect(resultado.porCentro[1].minutes).toBe(960);
    expect(resultado.porCentro[1].hours).toBe(16);
    expect(resultado.totalMinutes).toBe(1260);
    expect(resultado.totalHours).toBe(21);
  });

  it("no cuenta los centros de otro cliente", () => {
    const entries = [
      ...jornada("2026-07-06", "08:00", "16:00", { center_id: CENTRO_A }),
      ...jornada("2026-07-07", "08:00", "16:00", { center_id: CENTRO_AJENO }),
    ];

    const resultado = calcular(entries);

    expect(resultado.porCentro).toHaveLength(1);
    expect(resultado.totalMinutes).toBe(480);
    // Ni sus incidencias: son problema de la factura del otro cliente.
    expect(resultado.incidencias).toEqual([]);
  });

  it("el total sale de los minutos, no de sumar las horas ya redondeadas", () => {
    // 2 h 25 min en cada centro. Por línea 2,42 h (suman 4,84), pero el total
    // real de 290 min son 4,83 h. La diferencia de 0,01 es correcta y
    // esperada (SPEC 4.5).
    const entries = [
      ...jornada("2026-07-06", "08:00", "10:25", { center_id: CENTRO_A }),
      ...jornada("2026-07-07", "08:00", "10:25", { center_id: CENTRO_B }),
    ];

    const resultado = calcular(entries);

    expect(resultado.porCentro[0].hours).toBe(2.42);
    expect(resultado.porCentro[1].hours).toBe(2.42);
    expect(resultado.totalMinutes).toBe(290);
    expect(resultado.totalHours).toBe(4.83);

    const sumaDeLineas = resultado.porCentro.reduce((s, c) => s + c.hours, 0);
    expect(Number(sumaDeLineas.toFixed(2))).toBe(4.84);
  });
});
