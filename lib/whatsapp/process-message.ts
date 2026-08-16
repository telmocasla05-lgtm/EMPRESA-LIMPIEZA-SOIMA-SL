import { type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { registrarIncidencia } from "@/lib/whatsapp/incidencias";
import { classifyIntent } from "@/lib/whatsapp/intent";
import { type MediaEntrante } from "@/lib/whatsapp/media";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import {
  handleLocationMessage,
  handleTextMessage,
  parseIntent,
  type WhatsAppLocation,
  type WorkerRow,
} from "@/lib/whatsapp/time-entry";

const PEDIR_ACLARACION =
  "🤔 No sé si quieres fichar o reportar una incidencia.\n" +
  "Para fichar escribe *entro* o *salgo*. Si es una incidencia, cuéntame en una frase qué ha pasado.";

// Adjunto de la Cloud API: el id sirve para descargarlo de la Graph API.
type WhatsAppMedia = { id: string; mime_type?: string; caption?: string };

// Estructura (parcial) del payload de webhook de la Cloud API de Meta.
type WhatsAppMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  location?: WhatsAppLocation;
  image?: WhatsAppMedia;
  audio?: WhatsAppMedia;
};

export type WhatsAppWebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        messages?: WhatsAppMessage[];
      };
    }[];
  }[];
};

export async function processWebhookPayload(payload: WhatsAppWebhookPayload) {
  const messages =
    payload.entry
      ?.flatMap((entry) => entry.changes ?? [])
      .flatMap((change) => change.value?.messages ?? []) ?? [];

  for (const message of messages) {
    await processIncomingMessage(message);
  }
}

async function processIncomingMessage(message: WhatsAppMessage) {
  const admin = createAdminClient();

  // Meta manda el teléfono sin "+" (p. ej. "34600111222"); en workers.phone
  // puede estar guardado con o sin prefijo "+".
  const { data, error: workerError } = await admin
    .from("workers")
    .select("id, company_id, pending_action")
    .in("phone", [message.from, `+${message.from}`])
    .limit(2);

  if (workerError) {
    throw new Error(`Error buscando worker: ${workerError.message}`);
  }

  const matches = (data ?? []) as WorkerRow[];

  // workers.phone es único por company, no a nivel global: el mismo número
  // puede estar de alta en dos empresas. Meta solo manda el teléfono, así que
  // no hay forma de saber a cuál pertenece el fichaje; registrarlo en una
  // cualquiera lo metería en la company equivocada.
  if (matches.length > 1) {
    console.error(
      `[whatsapp] Teléfono ${message.from} dado de alta en varias empresas: mensaje no procesado`,
    );
    await sendWhatsAppText(
      message.from,
      "Tu número está dado de alta en más de una empresa y no puedo saber en cuál estás fichando. Contacta con tu responsable.",
    );
    return;
  }

  const worker = matches[0] ?? null;

  if (!worker) {
    console.warn(`[whatsapp] Mensaje de teléfono no registrado: ${message.from}`);
    await sendWhatsAppText(
      message.from,
      "Este número no está dado de alta en ninguna empresa. Contacta con tu responsable para poder fichar.",
    );
    return;
  }

  // El pie de foto también es texto del operario: se guarda en el mensaje y
  // sirve para clasificar la incidencia.
  const text =
    message.type === "text"
      ? (message.text?.body ?? "")
      : (message.image?.caption ?? null);

  const { error: insertError } = await admin.from("whatsapp_messages").insert({
    company_id: worker.company_id,
    worker_id: worker.id,
    phone: message.from,
    direction: "inbound",
    type: message.type,
    content: text,
    raw_payload: message,
  });

  if (insertError) {
    throw new Error(`Error guardando mensaje: ${insertError.message}`);
  }

  console.log(`[whatsapp] Mensaje ${message.id} de ${message.from} guardado`);

  let reply: string | null = null;

  if (message.type === "text") {
    reply = await routeTextMessage(admin, worker, text ?? "");
  } else if (message.type === "location" && message.location) {
    reply = await handleLocationMessage(admin, worker, message.location);
  } else if (message.type === "image" || message.type === "audio") {
    // Una foto o un audio solo pueden ser un reporte: para fichar hace falta
    // ubicación. El audio se transcribe y la foto se pasa a la IA con el pie
    // de foto, si lo hay.
    reply = await registrarIncidencia(admin, worker, {
      texto: text,
      media: mediaDelMensaje(message),
    });
  } else {
    console.log(`[whatsapp] Mensaje de tipo ${message.type} sin flujo asociado`);
  }

  if (reply) {
    await sendWhatsAppText(message.from, reply);
  }
}

// Decide qué es un mensaje de texto antes de tratarlo como fichaje.
async function routeTextMessage(
  admin: SupabaseClient,
  worker: WorkerRow,
  text: string,
): Promise<string> {
  // Las palabras clave mandan siempre: "entro" no puede depender de que un
  // servicio externo esté disponible, y así el caso más frecuente no gasta ni
  // una llamada a la IA.
  if (parseIntent(text)) {
    return handleTextMessage(admin, worker, text);
  }

  const { intent, motivo, error } = await classifyIntent(text);
  console.log(
    `[whatsapp] Intención "${intent}" para «${text}»: ${error ?? motivo}`,
  );

  switch (intent) {
    case "fichaje":
      // Habla de su fichaje pero sin la palabra clave: handleTextMessage
      // responde con la ayuda (*entro* / *salgo*) sin registrar nada.
      return handleTextMessage(admin, worker, text);
    case "incidencia":
      // Segunda llamada a la IA, esta vez para el tipo y la urgencia: son dos
      // preguntas distintas (qué es el mensaje / qué clase de problema es) y
      // separarlas deja el fichaje fuera del prompt de incidencias.
      return registrarIncidencia(admin, worker, { texto: text });
    case "desconocido":
      return PEDIR_ACLARACION;
  }
}

function mediaDelMensaje(message: WhatsAppMessage): MediaEntrante | null {
  const media = message.image ?? message.audio;
  if (!media) return null;

  return {
    kind: message.image ? "image" : "audio",
    id: media.id,
    mimeType: media.mime_type ?? null,
  };
}
