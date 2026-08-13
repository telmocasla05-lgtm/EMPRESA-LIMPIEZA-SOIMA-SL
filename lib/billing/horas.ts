// Horas facturables de un cliente en un periodo (SPEC-facturacion.md, sección 4).
//
// Lógica pura, sin base de datos: el llamante trae los fichajes y los centros.
// Fechas siempre en Europe/Madrid vía lib/dates.ts (CLAUDE.md).
//
// La regla de oro del SPEC es no facturar a ciegas: una jornada que no se
// puede calcular con certeza no suma horas y además genera una incidencia que
// bloquea la emisión de ese cliente hasta que un jefe la resuelva.

import { madridDateOf } from "@/lib/dates";

// Una jornada de más de 16 h no es creíble: es un fichaje mal cerrado.
export const MAX_JORNADA_MINUTES = 16 * 60;

// Margen de lectura a cada lado del periodo, en milisegundos.
//
// Por la derecha cierra una jornada nocturna que empieza el día 31 y termina
// el 1 del mes siguiente (decisión 13). El SPEC solo pide este lado.
//
// Por la izquierda es un añadido: sin él, la salida de una jornada que empezó
// el último día del mes anterior entra en la ventana sin su entrada y parece
// una salida suelta, generando un `salida_sin_entrada` falso que bloquearía el
// mes entero. Emparejando también hacia atrás, esa jornada se cierra bien y se
// descarta después por fecha, que es lo correcto: pertenece al mes anterior.
const MARGEN_MS = 24 * 60 * 60 * 1000;

export type TimeEntryRow = {
  id: string;
  worker_id: string;
  center_id: string | null;
  type: string; // 'entrada' | 'salida'
  valid: boolean;
  created_at: string;
};

export type CentroRow = {
  id: string;
  name: string;
};

export type IncidenciaCodigo =
  | "entrada_sin_salida"
  | "salida_sin_entrada"
  | "fichaje_no_valido"
  | "sin_centro"
  | "centro_distinto"
  | "duracion_excesiva"
  // No está en la tabla del SPEC (4.2): cubre la entrada y la salida fichadas
  // en el mismo minuto, que daría una jornada de 0 h.
  | "duracion_cero";

export type Incidencia = {
  codigo: IncidenciaCodigo;
  worker_id: string;
  // Centro al que se atribuye: el de la entrada y, si no hay, el de la salida.
  // Null = no se puede atribuir a ningún cliente (bandeja "Sin asignar").
  center_id: string | null;
  work_date: string;
  entry_in_id: string | null;
  entry_out_id: string | null;
};

export type Jornada = {
  entry_in_id: string;
  entry_out_id: string;
  worker_id: string;
  center_id: string;
  // Fecha Madrid de la ENTRADA: decide a qué mes se imputa la jornada.
  work_date: string;
  minutes: number;
};

export type CentroHoras = {
  center_id: string;
  center_name: string;
  minutes: number;
  hours: number;
  jornadas: Jornada[];
};

export type HorasFacturables = {
  // Solo centros con jornadas facturables: un centro sin actividad no genera
  // línea de factura (decisión 7 aplicada a nivel de centro).
  porCentro: CentroHoras[];
  totalMinutes: number;
  totalHours: number;
  incidencias: Incidencia[];
  bloqueada: boolean;
};

// Redondeo comercial: opera sobre el valor absoluto y restaura el signo.
// Math.round(-0.5) devuelve -0 en JavaScript, que rompería los importes
// negativos de una rectificativa (SPEC 4.5).
export function redondeoHalfUp(value: number): number {
  return (value < 0 ? -1 : 1) * Math.round(Math.abs(value));
}

// Minutos a horas con 2 decimales. Se pasa por centésimas enteras para no
// acumular decimales en coma flotante (SPEC 4.5).
export function minutosAHoras(minutes: number): number {
  return redondeoHalfUp((minutes * 100) / 60) / 100;
}

function esEntrada(entry: TimeEntryRow): boolean {
  return entry.type === "entrada";
}

function incidencia(
  codigo: IncidenciaCodigo,
  entrada: TimeEntryRow | null,
  salida: TimeEntryRow | null,
): Incidencia {
  const referencia = entrada ?? salida!;
  return {
    codigo,
    worker_id: referencia.worker_id,
    center_id: entrada?.center_id ?? salida?.center_id ?? null,
    work_date: madridDateOf(referencia.created_at),
    entry_in_id: entrada?.id ?? null,
    entry_out_id: salida?.id ?? null,
  };
}

// Empareja cada entrada con su salida, por operario y en orden cronológico.
// Devuelve las jornadas facturables y las incidencias de todo lo que no lo es.
//
// Recibe los fichajes de TODOS los centros de la company, no solo los del
// cliente que se está facturando: un operario puede entrar en el centro de un
// cliente y salir en el de otro, y eso solo se detecta viendo la secuencia
// completa de ese operario.
export function emparejarJornadas(entries: TimeEntryRow[]): {
  jornadas: Jornada[];
  incidencias: Incidencia[];
} {
  const jornadas: Jornada[] = [];
  const incidencias: Incidencia[] = [];

  const porOperario = new Map<string, TimeEntryRow[]>();
  for (const entry of entries) {
    const propias = porOperario.get(entry.worker_id);
    if (propias) propias.push(entry);
    else porOperario.set(entry.worker_id, [entry]);
  }

  for (const propias of porOperario.values()) {
    const ordenadas = [...propias].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    );

    let abierta: TimeEntryRow | null = null;

    for (const entry of ordenadas) {
      if (esEntrada(entry)) {
        // Dos entradas seguidas: la anterior se quedó sin cerrar.
        if (abierta) incidencias.push(incidencia("entrada_sin_salida", abierta, null));
        abierta = entry;
        continue;
      }

      if (!abierta) {
        incidencias.push(incidencia("salida_sin_entrada", null, entry));
        continue;
      }

      const cerrada = cerrarJornada(abierta, entry);
      if ("codigo" in cerrada) incidencias.push(cerrada);
      else jornadas.push(cerrada);
      abierta = null;
    }

    // Se acabaron los fichajes del operario y seguía dentro.
    if (abierta) incidencias.push(incidencia("entrada_sin_salida", abierta, null));
  }

  return { jornadas, incidencias };
}

// Una jornada cerrada solo es facturable si los dos fichajes son válidos, los
// dos tienen el mismo centro y la duración es creíble (SPEC 4.1). El orden de
// las comprobaciones fija qué incidencia se ve primero cuando falla más de
// una: primero la validez, que es la decisión explícita del SPEC (decisión 3).
function cerrarJornada(
  entrada: TimeEntryRow,
  salida: TimeEntryRow,
): Jornada | Incidencia {
  if (!entrada.valid || !salida.valid) {
    return incidencia("fichaje_no_valido", entrada, salida);
  }
  if (!entrada.center_id || !salida.center_id) {
    return incidencia("sin_centro", entrada, salida);
  }
  if (entrada.center_id !== salida.center_id) {
    return incidencia("centro_distinto", entrada, salida);
  }

  // Diferencia de instantes reales: un cambio de hora no la altera.
  const minutes = redondeoHalfUp(
    (new Date(salida.created_at).getTime() -
      new Date(entrada.created_at).getTime()) /
      60_000,
  );

  if (minutes <= 0) return incidencia("duracion_cero", entrada, salida);
  if (minutes > MAX_JORNADA_MINUTES) {
    return incidencia("duracion_excesiva", entrada, salida);
  }

  return {
    entry_in_id: entrada.id,
    entry_out_id: salida.id,
    worker_id: entrada.worker_id,
    center_id: entrada.center_id,
    work_date: madridDateOf(entrada.created_at),
    minutes,
  };
}

// Horas facturables de un cliente en un periodo.
//
// `entries` deben ser los fichajes de la company que caen entre el día
// anterior al periodo y el día siguiente a su fin (ver MARGEN_MS); esta
// función recorta por su cuenta lo que sobre.
// `centros` son los del cliente que se factura: define qué se le atribuye.
export function calcularHorasFacturables({
  entries,
  centros,
  periodStart,
  periodEnd,
}: {
  entries: TimeEntryRow[];
  centros: CentroRow[];
  periodStart: string;
  periodEnd: string;
}): HorasFacturables {
  const nombrePorCentro = new Map(centros.map((c) => [c.id, c.name]));

  const desde = new Date(`${periodStart}T00:00:00Z`).getTime() - MARGEN_MS;
  const hasta = new Date(`${periodEnd}T00:00:00Z`).getTime() + 2 * MARGEN_MS;
  const enVentana = entries.filter((entry) => {
    const instante = new Date(entry.created_at).getTime();
    return instante >= desde && instante <= hasta;
  });

  const { jornadas, incidencias } = emparejarJornadas(enVentana);

  // Dentro del periodo por la fecha Madrid de la entrada: una jornada que
  // empieza el 31 a las 22:00 y acaba el 1 a las 06:00 se factura entera en el
  // mes de la entrada y no reaparece al calcular el mes siguiente.
  const delPeriodo = <T extends { work_date: string }>(items: T[]) =>
    items.filter(
      (item) => item.work_date >= periodStart && item.work_date <= periodEnd,
    );

  const propias = delPeriodo(jornadas).filter((jornada) =>
    nombrePorCentro.has(jornada.center_id),
  );
  const incidenciasPropias = delPeriodo(incidencias).filter(
    (item) => item.center_id !== null && nombrePorCentro.has(item.center_id),
  );

  const porCentroId = new Map<string, Jornada[]>();
  for (const jornada of propias) {
    const acumuladas = porCentroId.get(jornada.center_id);
    if (acumuladas) acumuladas.push(jornada);
    else porCentroId.set(jornada.center_id, [jornada]);
  }

  const porCentro: CentroHoras[] = [...porCentroId.entries()]
    .map(([center_id, jornadasCentro]) => {
      const minutes = jornadasCentro.reduce((suma, j) => suma + j.minutes, 0);
      return {
        center_id,
        center_name: nombrePorCentro.get(center_id)!,
        minutes,
        hours: minutosAHoras(minutes),
        jornadas: [...jornadasCentro].sort((a, b) =>
          a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0,
        ),
      };
    })
    // Por nombre de centro, como las líneas de la factura (SPEC 4.4).
    .sort((a, b) => a.center_name.localeCompare(b.center_name, "es"));

  const totalMinutes = porCentro.reduce((suma, c) => suma + c.minutes, 0);

  return {
    porCentro,
    totalMinutes,
    // Desde los minutos totales, no sumando las horas ya redondeadas de cada
    // centro: puede diferir en 0,01 h de esa suma y es correcto (SPEC 4.5).
    totalHours: minutosAHoras(totalMinutes),
    incidencias: incidenciasPropias,
    // Toda incidencia bloquea la emisión de la factura de su cliente (4.2).
    bloqueada: incidenciasPropias.length > 0,
  };
}
