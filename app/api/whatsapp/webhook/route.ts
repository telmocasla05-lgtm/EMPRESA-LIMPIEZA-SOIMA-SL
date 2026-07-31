import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import {
  processWebhookPayload,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/process-message";

// Verificación del webhook (Meta la hace una vez al configurarlo).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && verifyToken && token === verifyToken && challenge) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Verificación fallida", { status: 403 });
}

// Meta exige responder 200 en menos de 5 segundos: se valida la firma,
// se responde ya, y el procesado corre en background con after().
export async function POST(request: Request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.error("[whatsapp] Falta WHATSAPP_APP_SECRET: no se puede validar la firma");
    return new Response("Configuración incompleta", { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!isValidSignature(rawBody, signature, appSecret)) {
    console.warn("[whatsapp] Webhook con firma inválida rechazado");
    return new Response("Firma inválida", { status: 401 });
  }

  after(async () => {
    try {
      const payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
      await processWebhookPayload(payload);
    } catch (error) {
      console.error("[whatsapp] Error procesando webhook:", error);
    }
  });

  return new Response("OK", { status: 200 });
}

function isValidSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");

  return received.length === expected.length && timingSafeEqual(received, expected);
}
