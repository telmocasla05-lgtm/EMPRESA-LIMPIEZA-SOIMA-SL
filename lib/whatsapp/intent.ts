import Anthropic from "@anthropic-ai/sdk";

export type MessageIntent = "fichaje" | "incidencia" | "desconocido";

export type IntentResult = {
  intent: MessageIntent;
  // Frase de la IA explicando la decisión: se registra en logs para poder
  // ajustar el prompt viendo por qué se equivocó.
  motivo: string;
  // Relleno solo cuando la clasificación falló y se aplicó el criterio de
  // reserva (ver INTENCION_DE_RESERVA).
  error?: string;
};

const MODEL = "claude-opus-5";
// En Opus 5 el pensamiento está activo por defecto y cuenta contra max_tokens.
// 2000 da holgura de sobra para un JSON de dos campos.
const MAX_TOKENS = 2000;
// El webhook responde 200 al instante y clasifica en background (after()),
// pero el operario está esperando: pasados 8 s se da la llamada por perdida.
const TIMEOUT_MS = 8_000;

// Si la IA no contesta no se puede saber qué quería el operario. Entre callar
// y abrir una incidencia de más, se abre de más: un reporte perdido (un cable
// pelado, un suelo mojado) cuesta mucho más que un aviso sobrante, que el jefe
// cierra desde el panel en un clic.
const INTENCION_DE_RESERVA: MessageIntent = "incidencia";

// El prompt vive aquí, separado del flujo, para poder afinarlo sin tocar la
// lógica del webhook. Debe ser idéntico byte a byte en cada llamada: cualquier
// interpolación (nombre de empresa, fecha, id) rompería la caché del prompt.
export const INTENT_SYSTEM_PROMPT = `Eres el clasificador de mensajes entrantes de una empresa de limpieza.

Los operarios escriben por WhatsApp a la aplicación de la empresa. Sus mensajes sirven para dos cosas: fichar la entrada o la salida del turno, o reportar una incidencia en el centro donde trabajan.

Clasifica el mensaje del operario en una de estas tres intenciones:

- "fichaje": quiere registrar su entrada o su salida, o habla de su fichaje. Ejemplos: "entro", "ya estoy en el centro", "acabo por hoy", "me marcho a casa", "se me ha olvidado fichar la salida".
- "incidencia": informa de un problema en el centro. Cuatro familias: material roto, falta de producto o stock, desperfecto en el edificio y riesgo de seguridad. Ejemplos: "se ha roto la fregona", "no queda papel en los baños", "hay un cristal partido en la entrada", "hay un cable pelado en el pasillo".
- "desconocido": todo lo demás. Saludos y cortesías ("gracias", "ok", "vale"), mensajes personales, preguntas de nóminas, turnos o vacaciones, y cualquier mensaje demasiado ambiguo para decidir entre fichaje e incidencia.

Reglas:
- Ante la duda entre "fichaje" e "incidencia", responde "desconocido". El sistema le preguntará al operario, y eso es preferible a fichar por error o a abrir una incidencia que no existe.
- Un mensaje que describe un problema es una incidencia aunque no pida nada explícitamente.
- Un mensaje puede estar mal escrito, sin tildes o sin signos de puntuación: clasifícalo igual.
- Tú solo clasificas. No respondas al operario ni le des instrucciones.`;

const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intencion", "motivo"],
  properties: {
    intencion: {
      type: "string",
      enum: ["fichaje", "incidencia", "desconocido"],
    },
    motivo: {
      type: "string",
      description:
        "Una frase de como mucho 100 caracteres, en español, explicando la elección",
    },
  },
} as const;

let cliente: Anthropic | null = null;
let faltaClaveAvisada = false;

function getCliente(apiKey: string): Anthropic {
  cliente ??= new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  return cliente;
}

export async function classifyIntent(text: string): Promise<IntentResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Un aviso por proceso: con la clave sin configurar, cada mensaje entrante
    // llenaría los logs con la misma línea.
    if (!faltaClaveAvisada) {
      console.error("[intent] Falta ANTHROPIC_API_KEY: no se clasifican los mensajes");
      faltaClaveAvisada = true;
    }
    return reserva("Falta ANTHROPIC_API_KEY");
  }

  try {
    const response = await getCliente(apiKey).messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: INTENT_SYSTEM_PROMPT,
          // Solo tiene efecto si el prompt crece por encima del mínimo
          // cacheable; puesto aquí para que crecerlo salga gratis.
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        // Elegir entre tres etiquetas no necesita razonamiento profundo, y
        // "low" recorta latencia y coste.
        effort: "low",
        // El esquema lo garantiza la API: nada de pedir JSON en el prompt.
        format: { type: "json_schema", schema: INTENT_SCHEMA },
      },
      messages: [{ role: "user", content: text }],
    });

    // Se comprueba antes de leer content: en un rechazo viene vacío.
    if (response.stop_reason === "refusal") {
      return reserva("La IA rechazó clasificar el mensaje");
    }

    const bloque = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!bloque) {
      return reserva("Respuesta de la IA sin bloque de texto");
    }

    const { intencion, motivo } = JSON.parse(bloque.text) as {
      intencion: MessageIntent;
      motivo: string;
    };

    if (!["fichaje", "incidencia", "desconocido"].includes(intencion)) {
      return reserva(`Intención no reconocida: ${intencion}`);
    }

    return { intent: intencion, motivo };
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error("[intent] Error clasificando el mensaje:", detalle);
    return reserva(detalle);
  }
}

function reserva(error: string): IntentResult {
  return {
    intent: INTENCION_DE_RESERVA,
    motivo: "No se pudo clasificar el mensaje",
    error,
  };
}
