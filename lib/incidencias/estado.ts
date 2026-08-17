// Estado de una incidencia y su ciclo de vida en el panel.
//
// En la base el estado es una sola columna (`incidents.status`) con tres
// valores; aquí viven las etiquetas en español, los colores y qué transiciones
// ofrece el panel. Módulo sin dependencias de Supabase para poder testearlo.

export type EstadoIncidencia = "open" | "in_progress" | "resolved";

export const ESTADOS: EstadoIncidencia[] = ["open", "in_progress", "resolved"];

export const ETIQUETA_ESTADO: Record<EstadoIncidencia, string> = {
  open: "Abierta",
  in_progress: "En curso",
  resolved: "Resuelta",
};

export const TONO_ESTADO: Record<EstadoIncidencia, "ok" | "warn" | "info"> = {
  open: "warn",
  in_progress: "info",
  resolved: "ok",
};

// Avance normal: abierta → en curso → resuelta. Volver atrás también se
// ofrece (reabrir): una incidencia que se dio por resuelta y no lo estaba es
// un caso real, y sin botón acabaría abriéndose otra duplicada.
export const SIGUIENTES_ESTADOS: Record<EstadoIncidencia, EstadoIncidencia[]> = {
  open: ["in_progress", "resolved"],
  in_progress: ["resolved", "open"],
  resolved: ["in_progress"],
};

// Texto que queda en el historial al cambiar de estado. Siempre se escribe
// una nota, aunque el jefe no comente nada: sin ella, el historial no diría
// quién movió la incidencia ni cuándo, que es justo para lo que existe.
export function notaDeCambioDeEstado(
  anterior: EstadoIncidencia,
  nuevo: EstadoIncidencia,
  comentario?: string,
): string {
  const cabecera = `Estado: ${ETIQUETA_ESTADO[anterior]} → ${ETIQUETA_ESTADO[nuevo]}`;
  const texto = comentario?.trim();
  return texto ? `${cabecera}\n${texto}` : cabecera;
}

// Una incidencia "sin resolver" es la que sigue dando trabajo: abierta o en
// curso. Es el filtro por defecto del listado y el contador de la vista Hoy.
export function sinResolver(estado: string): boolean {
  return estado !== "resolved";
}

// Umbral de la tarjeta de la vista Hoy: a partir de dos días sin cerrar, la
// incidencia deja de ser "en trámite" y pasa a ser un olvido.
export const HORAS_ESTANCADA = 48;

export type IncidenciaResumible = { status: string; created_at: string };

export type ResumenIncidencias = {
  abiertas: number;
  estancadas: number;
};

// Cuántas incidencias siguen sin resolver y cuántas de ellas llevan más de
// 48 h abiertas. Se cuenta desde created_at (cuándo la reportó el operario),
// no desde el último cambio de estado: lo que le importa al jefe es cuánto
// lleva esperando quien la reportó.
export function resumenIncidencias(
  incidencias: IncidenciaResumible[],
  ahora: Date = new Date(),
): ResumenIncidencias {
  const limite = ahora.getTime() - HORAS_ESTANCADA * 60 * 60 * 1000;
  const pendientes = incidencias.filter((incidencia) => sinResolver(incidencia.status));

  return {
    abiertas: pendientes.length,
    estancadas: pendientes.filter(
      (incidencia) => new Date(incidencia.created_at).getTime() < limite,
    ).length,
  };
}
