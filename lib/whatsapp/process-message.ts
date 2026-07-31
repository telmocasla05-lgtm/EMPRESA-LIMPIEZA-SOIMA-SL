import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

// Estructura (parcial) del payload de webhook de la Cloud API de Meta.
type WhatsAppMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
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
  const { data: worker, error: workerError } = await admin
    .from("workers")
    .select("id, company_id")
    .in("phone", [message.from, `+${message.from}`])
    .limit(1)
    .maybeSingle();

  if (workerError) {
    throw new Error(`Error buscando worker: ${workerError.message}`);
  }

  if (!worker) {
    console.warn(`[whatsapp] Mensaje de teléfono no registrado: ${message.from}`);
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

  if (text !== null) {
    await sendWhatsAppText(message.from, `Recibido: ${text}`);
  }
}
