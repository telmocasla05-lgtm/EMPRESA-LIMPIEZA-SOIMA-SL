// Transcripción de las notas de voz que manda el operario, con Whisper.
//
// Es el único punto del proyecto que habla con OpenAI (Whisper es suyo); la
// clasificación sigue siendo de Claude, en lib/ia/clasificar-incidencia.ts.
// Se llama por HTTP directamente para no añadir una dependencia nueva
// (CLAUDE.md pide proponerlas antes).
//
// OJO: SPEC-incidencias.md dejó los audios fuera de alcance (decisión 9). Esto
// va por delante de esa decisión; el resto del flujo no cambia.

import { type MediaDescargada } from "@/lib/whatsapp/media";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "whisper-1";
// El operario está esperando la confirmación: pasados 15 s se da por perdida
// y la incidencia se abre igual, sin descripción.
const TIMEOUT_MS = 15_000;

let faltaClaveAvisada = false;

// Devuelve null si no se pudo transcribir: la incidencia se abre igual y el
// bot le pide al operario que la cuente por escrito (regla de oro del SPEC:
// no perder nunca un reporte).
export async function transcribirAudio(
  audio: MediaDescargada,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Un aviso por proceso: sin la clave, cada audio llenaría los logs con la
    // misma línea.
    if (!faltaClaveAvisada) {
      console.error("[whisper] Falta OPENAI_API_KEY: no se transcriben los audios");
      faltaClaveAvisada = true;
    }
    return null;
  }

  const form = new FormData();
  form.append("file", new Blob([audio.bytes], { type: audio.mimeType }), nombre(audio));
  form.append("model", MODEL);
  // Los operarios hablan español: fijarlo evita que un audio corto o con ruido
  // se detecte como otro idioma y salga una transcripción inservible.
  form.append("language", "es");

  try {
    const response = await fetch(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const detalle = await response.text();
      console.error(`[whisper] Error ${response.status} transcribiendo:`, detalle);
      return null;
    }

    const { text } = (await response.json()) as { text?: string };
    const transcripcion = text?.trim();

    if (!transcripcion) {
      console.warn("[whisper] Transcripción vacía");
      return null;
    }

    console.log(`[whisper] Audio transcrito: «${transcripcion}»`);
    return transcripcion;
  } catch (error) {
    console.error("[whisper] Error transcribiendo el audio:", error);
    return null;
  }
}

// Whisper decide el decodificador por la extensión del nombre de fichero, no
// por el mime: sin extensión rechaza los .ogg de WhatsApp.
function nombre(audio: MediaDescargada): string {
  const extensiones: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
  };
  const base = audio.mimeType.split(";")[0]!.trim();
  return `audio.${extensiones[base] ?? "ogg"}`;
}
