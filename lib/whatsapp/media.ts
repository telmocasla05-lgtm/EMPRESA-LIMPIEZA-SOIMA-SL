// Descarga de fotos y audios de la Cloud API de Meta y subida al bucket
// privado `incidencias` (SPEC-incidencias.md 3.4).
//
// Mismos criterios que lib/whatsapp/send.ts: 3 intentos, backoff exponencial,
// timeout por intento y los 4xx que no son 429 no se reintentan.

import { type SupabaseClient } from "@supabase/supabase-js";

const GRAPH_API_URL = "https://graph.facebook.com/v23.0";
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 500;
// WhatsApp ya comprime, así que en la práctica no se toca. Está para que un
// fichero enorme no se cargue entero en memoria del proceso del webhook.
const MAX_BYTES = 8 * 1024 * 1024;

export const BUCKET_INCIDENCIAS = "incidencias";

export type MediaDescargada = {
  // Uint8Array<ArrayBuffer>, no el genérico por defecto: sin fijarlo, Blob()
  // lo rechaza porque podría venir de un SharedArrayBuffer.
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
};

// Los adjuntos que pueden llegar en un mensaje entrante.
export type MediaEntrante = {
  kind: "image" | "audio";
  id: string;
  mimeType: string | null;
};

export async function descargarMedia(mediaId: string): Promise<MediaDescargada> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    throw new Error("Falta WHATSAPP_TOKEN");
  }

  // 1) Metadatos: devuelven la URL real del fichero y su tipo.
  const metadatos = await fetchConReintentos(`${GRAPH_API_URL}/${mediaId}`, token);
  const { url, mime_type: mimeType } = (await metadatos.json()) as {
    url?: string;
    mime_type?: string;
  };

  if (!url) {
    throw new Error(`Meta no devolvió URL para el media ${mediaId}`);
  }

  // 2) Los bytes. Esa URL caduca en minutos: hay que bajarla ahora, no
  // guardarla para después.
  const fichero = await fetchConReintentos(url, token);
  const buffer = await fichero.arrayBuffer();

  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(
      `El fichero ${mediaId} pesa ${buffer.byteLength} bytes (máximo ${MAX_BYTES})`,
    );
  }

  return {
    bytes: new Uint8Array(buffer),
    mimeType: mimeType ?? "application/octet-stream",
  };
}

// Sube la foto al bucket privado y devuelve la ruta interna (nunca una URL
// pública: el panel la sirve firmada a 60 s).
export async function subirFotoIncidencia(
  admin: SupabaseClient,
  incidencia: { companyId: string; incidentId: string; mediaId: string },
  media: MediaDescargada,
): Promise<string> {
  const path = `${incidencia.companyId}/${incidencia.incidentId}/${incidencia.mediaId}.${extension(media.mimeType)}`;

  const { error } = await admin.storage
    .from(BUCKET_INCIDENCIAS)
    .upload(path, media.bytes, { contentType: media.mimeType });

  if (error) {
    throw new Error(`Error subiendo la foto de la incidencia: ${error.message}`);
  }

  return path;
}

// Enlace temporal a una foto del bucket privado. El bucket nunca se expone:
// esta URL es la única forma de verla fuera del panel.
export async function urlFirmadaFotoIncidencia(
  supabase: SupabaseClient,
  photoPath: string,
  segundos = 60,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET_INCIDENCIAS)
    .createSignedUrl(photoPath, segundos);

  if (error) throw new Error(error.message);
  return data.signedUrl;
}

function extension(mimeType: string): string {
  const conocidas: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/amr": "amr",
  };
  // El mime de WhatsApp puede venir con parámetros ("audio/ogg; codecs=opus").
  return conocidas[mimeType.split(";")[0]!.trim()] ?? "bin";
}

async function fetchConReintentos(url: string, token: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      console.warn(`[media] Intento ${attempt}/${MAX_ATTEMPTS} fallido:`, error);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) return response;

    const detalle = await response.text();
    const error = new Error(`Graph API ${response.status}: ${detalle}`);

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw error;
    }

    lastError = error;
    console.warn(`[media] Intento ${attempt}/${MAX_ATTEMPTS} fallido:`, error.message);
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }

  throw lastError;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
