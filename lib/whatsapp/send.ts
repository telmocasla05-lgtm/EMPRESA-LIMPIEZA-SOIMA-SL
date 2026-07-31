const GRAPH_API_URL = "https://graph.facebook.com/v23.0";
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 500;

// Todo envío de mensajes de WhatsApp pasa por aquí (ver CLAUDE.md):
// reintentos con backoff, timeout por intento y logging.
export async function sendWhatsAppText(to: string, body: string) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${GRAPH_API_URL}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Error de red o timeout: reintentable.
      lastError = error;
      console.warn(`[whatsapp] Intento ${attempt}/${MAX_ATTEMPTS} fallido para ${to}:`, error);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      console.log(`[whatsapp] Enviado a ${to} (intento ${attempt})`);
      return;
    }

    const errorBody = await response.text();
    const error = new Error(`WhatsApp API ${response.status}: ${errorBody}`);

    // Errores 4xx (salvo 429) no se arreglan reintentando.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      console.error(`[whatsapp] Error no recuperable enviando a ${to}:`, error.message);
      throw error;
    }

    lastError = error;
    console.warn(`[whatsapp] Intento ${attempt}/${MAX_ATTEMPTS} fallido para ${to}:`, error.message);
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }

  console.error(`[whatsapp] Envío a ${to} agotó los ${MAX_ATTEMPTS} intentos`);
  throw lastError;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
