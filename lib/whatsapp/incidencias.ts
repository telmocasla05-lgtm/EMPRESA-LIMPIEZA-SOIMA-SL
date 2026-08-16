import { type SupabaseClient } from "@supabase/supabase-js";
import {
  clasificarIncidencia,
  ETIQUETAS_TIPO,
  type Clasificacion,
} from "@/lib/ia/clasificar-incidencia";
import { transcribirAudio } from "@/lib/ia/transcribir-audio";
import {
  descargarMedia,
  subirFotoIncidencia,
  type MediaDescargada,
  type MediaEntrante,
} from "@/lib/whatsapp/media";
import { type WorkerRow } from "@/lib/whatsapp/time-entry";

// Alta de una incidencia desde WhatsApp (SPEC-incidencias.md 3.2).
//
// La regla de oro manda sobre todo lo demás: **no perder nunca un reporte**.
// Si falla la descarga del adjunto, la transcripción, la clasificación o la
// subida a Storage, la incidencia se abre igual y el panel enseña lo que falta.
// Solo un error de la propia inserción corta el flujo.
//
// La company_id sale siempre del worker, nunca del payload de Meta.

const TEXTO_SIN_CLASIFICAR =
  "⚠️ No he entendido bien tu mensaje, así que lo he registrado como incidencia para que tu responsable lo revise.";

const TEXTO_SIN_DESCRIPCION =
  "📷 Recibido, he abierto una incidencia.\n" +
  "¿Me cuentas en una frase qué ha pasado? Así tu responsable sabrá qué necesitas.";

type MensajeEntrante = {
  // Lo que escribió el operario: texto suelto o pie de foto.
  texto?: string | null;
  media?: MediaEntrante | null;
};

export async function registrarIncidencia(
  admin: SupabaseClient,
  worker: WorkerRow,
  mensaje: MensajeEntrante,
): Promise<string> {
  const adjunto = mensaje.media ? await descargar(mensaje.media) : null;

  // Un audio no se puede clasificar tal cual: primero se transcribe, y la
  // transcripción hace de descripción si el operario no escribió nada.
  const transcripcion =
    adjunto && mensaje.media?.kind === "audio" ? await transcribirAudio(adjunto) : null;

  const descripcion = [mensaje.texto?.trim(), transcripcion?.trim()]
    .filter(Boolean)
    .join("\n");

  const foto = mensaje.media?.kind === "image" ? adjunto : null;

  // Sin nada que leer no se gasta una llamada a la IA: entra sin clasificar y
  // el bot le pide al operario que lo cuente.
  const clasificacion: Clasificacion = descripcion
    ? await clasificarIncidencia(descripcion, foto)
    : { tipo: "sin_clasificar", urgency: "normal", resumen: "" };

  console.log(
    `[incidencias] Tipo "${clasificacion.tipo}" (${clasificacion.urgency}) para el worker ${worker.id}: ${clasificacion.resumen || clasificacion.error}`,
  );

  const centerId = await centroDelOperario(admin, worker.id);

  const { data, error } = await admin
    .from("incidents")
    .insert({
      company_id: worker.company_id,
      worker_id: worker.id,
      center_id: centerId,
      type: clasificacion.tipo,
      urgency: clasificacion.urgency,
      status: "open",
      description: descripcion || null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Error abriendo incidencia: ${error.message}`);
  }

  const incidentId = (data as { id: string }).id;
  console.log(`[incidencias] Incidencia ${incidentId} abierta para el worker ${worker.id}`);

  if (foto && mensaje.media) {
    await guardarFoto(admin, incidentId, worker.company_id, mensaje.media.id, foto);
  }

  return respuesta(clasificacion, Boolean(descripcion));
}

// El centro es el del fichaje de entrada abierto, con el mismo patrón que usa
// el flujo de fichaje para leer el último movimiento del operario. Si el
// último fichaje es una salida (o no hay ninguno), la incidencia queda sin
// centro y el jefe se lo asigna desde el panel (decisión 4).
async function centroDelOperario(
  admin: SupabaseClient,
  workerId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("time_entries")
    // Los fichajes pendientes de revisión (valid = false) cuentan: el operario
    // está donde está aunque su entrada esté por confirmar.
    .select("type, center_id")
    .eq("worker_id", workerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // No merece tumbar la incidencia: se abre sin centro.
    console.error(`[incidencias] Error buscando el centro del operario: ${error.message}`);
    return null;
  }

  const ultimo = data as { type: string; center_id: string | null } | null;
  if (ultimo?.type !== "entrada") {
    console.log(`[incidencias] El worker ${workerId} no tiene entrada abierta: sin centro`);
    return null;
  }

  return ultimo.center_id;
}

async function descargar(media: MediaEntrante): Promise<MediaDescargada | null> {
  try {
    return await descargarMedia(media.id);
  } catch (error) {
    console.error(`[incidencias] No se pudo descargar el media ${media.id}:`, error);
    return null;
  }
}

async function guardarFoto(
  admin: SupabaseClient,
  incidentId: string,
  companyId: string,
  mediaId: string,
  foto: MediaDescargada,
) {
  try {
    const path = await subirFotoIncidencia(
      admin,
      { companyId, incidentId, mediaId },
      foto,
    );

    const { error } = await admin
      .from("incidents")
      .update({ photo_url: path })
      .eq("id", incidentId);
    if (error) throw new Error(error.message);

    console.log(`[incidencias] Foto de la incidencia ${incidentId} guardada en ${path}`);
  } catch (error) {
    // La incidencia ya está creada: perder la foto no puede perder el reporte.
    console.error(`[incidencias] No se pudo guardar la foto de ${incidentId}:`, error);
  }
}

function respuesta(clasificacion: Clasificacion, hayDescripcion: boolean): string {
  if (clasificacion.tipo !== "sin_clasificar") {
    return `📋 Incidencia registrada: ${ETIQUETAS_TIPO[clasificacion.tipo]}. Nos ponemos en ello.`;
  }

  return hayDescripcion ? TEXTO_SIN_CLASIFICAR : TEXTO_SIN_DESCRIPCION;
}
