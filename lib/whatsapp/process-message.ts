import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/send";
import {
  handleLocationMessage,
  handleTextMessage,
  type WhatsAppLocation,
  type WorkerRow,
} from "@/lib/whatsapp/time-entry";

// Estructura (parcial) del payload de webhook de la Cloud API de Meta.
type WhatsAppMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  location?: WhatsAppLocation;
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
    .limit(1)
    .maybeSingle();

  if (workerError) {
    throw new Error(`Error buscando worker: ${workerError.message}`);
  }

  const worker = data as WorkerRow | null;

  if (!worker) {
    console.warn(`[whatsapp] Mensaje de teléfono no registrado: ${message.from}`);
    await sendWhatsAppText(
      message.from,
      "Este número no está dado de alta en ninguna empresa. Contacta con tu responsable para poder fichar.",
    );
    return;
  }

  const text = message.type === "text" ? (message.text?.body ?? "") : null;

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
    reply = await handleTextMessage(admin, worker, text ?? "");
  } else if (message.type === "location" && message.location) {
    reply = await handleLocationMessage(admin, worker, message.location);
  } else {
    console.log(`[whatsapp] Mensaje de tipo ${message.type} sin flujo asociado`);
  }

  if (reply) {
    await sendWhatsAppText(message.from, reply);
  }
}
