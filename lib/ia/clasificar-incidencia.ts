// Clasificación del tipo y la urgencia de una incidencia con la API de Claude
// (SPEC-incidencias.md 4). Vive aparte de lib/whatsapp/intent.ts porque
// resuelve otra pregunta: intent decide *qué es* el mensaje, esto decide *qué
// tipo de incidencia* es una vez ya se sabe que lo es.

import Anthropic from "@anthropic-ai/sdk";
import {
  TIPOS,
  type TipoIncidencia,
  type UrgenciaIncidencia,
} from "@/lib/incidencias/tipos";
import { type MediaDescargada } from "@/lib/whatsapp/media";

export type Clasificacion = {
  tipo: TipoIncidencia;
  urgency: UrgenciaIncidencia;
  // Frase de la IA resumiendo la incidencia: se registra en logs para poder
  // ajustar el prompt viendo por qué se equivocó. No se guarda en la tabla.
  resumen: string;
  // Relleno solo cuando la clasificación falló y se aplicó el criterio de
  // reserva (sin_clasificar, urgencia normal).
  error?: string;
};

const MODEL = "claude-opus-5";
// En Opus 5 el pensamiento está activo por defecto y cuenta contra max_tokens.
const MAX_TOKENS = 2000;
// El operario está esperando: pasados 8 s se da la llamada por perdida.
const TIMEOUT_MS = 8_000;

// Formatos que acepta la API de visión. WhatsApp manda jpeg, pero el mime lo
// decide el cliente del operario y no cuesta nada comprobarlo.
const IMAGENES_SOPORTADAS = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// El prompt vive aquí, separado del flujo, para poder afinarlo sin tocar la
// lógica del webhook. Debe ser idéntico byte a byte en cada llamada:
// cualquier interpolación (nombre de empresa, fecha, id) rompería la caché.
export const INCIDENCIA_SYSTEM_PROMPT = `Eres el clasificador de incidencias de una empresa de limpieza.

Los operarios reportan por WhatsApp los problemas que se encuentran en los centros donde trabajan: escriben una frase, mandan una foto, o graban una nota de voz que llega ya transcrita.

Clasifica la incidencia en uno de estos tipos:

- "material_roto": una herramienta o máquina de limpieza que se ha estropeado. Ejemplos: "se ha roto la fregona", "la aspiradora echa humo", "el carro ha perdido una rueda".
- "falta_stock": se ha agotado un producto o consumible. Ejemplos: "no queda papel en los baños", "se ha acabado la lejía", "faltan bolsas de basura".
- "desperfecto": algo del edificio del cliente está dañado o no funciona. Ejemplos: "hay un cristal partido en la entrada", "el grifo del baño gotea", "una persiana no sube".
- "seguridad": hay riesgo para las personas. Ejemplos: "hay un cable pelado en el pasillo", "el suelo está mojado y sin señalizar", "huele a gas", "la salida de emergencia está bloqueada".
- "sin_clasificar": no hay información suficiente para decidir, o no encaja en ninguno de los cuatro anteriores.

Y asigna la urgencia:

- "alta": hay riesgo para las personas, o el centro no se puede limpiar hasta que se resuelva.
- "normal": todo lo demás.

Reglas:
- Toda incidencia de tipo "seguridad" es de urgencia alta.
- Si hay foto, úsala: puede aclarar lo que el texto no dice, o desmentirlo.
- Ante la duda entre dos tipos, elige el que implique más riesgo.
- El mensaje puede estar mal escrito, sin tildes o sin signos de puntuación: clasifícalo igual.
- Tú solo clasificas. No respondas al operario ni le des instrucciones.`;

const INCIDENCIA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tipo", "urgencia", "resumen"],
  properties: {
    tipo: {
      type: "string",
      enum: TIPOS,
    },
    urgencia: {
      type: "string",
      enum: ["alta", "normal"],
    },
    resumen: {
      type: "string",
      description: "Una frase de como mucho 100 caracteres, en español",
    },
  },
} as const;

let cliente: Anthropic | null = null;
let faltaClaveAvisada = false;

function getCliente(apiKey: string): Anthropic {
  cliente ??= new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  return cliente;
}

export async function clasificarIncidencia(
  descripcion: string,
  foto?: MediaDescargada | null,
): Promise<Clasificacion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (!faltaClaveAvisada) {
      console.error(
        "[incidencias] Falta ANTHROPIC_API_KEY: no se clasifican las incidencias",
      );
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
          text: INCIDENCIA_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        // Elegir entre cinco etiquetas no necesita razonamiento profundo, y
        // "low" recorta latencia y coste.
        effort: "low",
        // El esquema lo garantiza la API: nada de pedir JSON en el prompt.
        format: { type: "json_schema", schema: INCIDENCIA_SCHEMA },
      },
      messages: [{ role: "user", content: contenido(descripcion, foto) }],
    });

    // Se comprueba antes de leer content: en un rechazo viene vacío.
    if (response.stop_reason === "refusal") {
      return reserva("La IA rechazó clasificar la incidencia");
    }

    const bloque = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!bloque) {
      return reserva("Respuesta de la IA sin bloque de texto");
    }

    const { tipo, urgencia, resumen } = JSON.parse(bloque.text) as {
      tipo: TipoIncidencia;
      urgencia: UrgenciaIncidencia;
      resumen: string;
    };

    if (!TIPOS.includes(tipo)) {
      return reserva(`Tipo no reconocido: ${tipo}`);
    }

    return {
      tipo,
      // Decisión 6 del SPEC: seguridad es siempre alta, lo diga o no la IA.
      urgency: tipo === "seguridad" || urgencia === "alta" ? "alta" : "normal",
      resumen: resumen ?? "",
    };
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error("[incidencias] Error clasificando la incidencia:", detalle);
    return reserva(detalle);
  }
}

function contenido(
  descripcion: string,
  foto?: MediaDescargada | null,
): Anthropic.MessageParam["content"] {
  if (!foto || !IMAGENES_SOPORTADAS.includes(foto.mimeType.split(";")[0]!.trim())) {
    return descripcion;
  }

  return [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: foto.mimeType.split(";")[0]!.trim() as "image/jpeg",
        data: Buffer.from(foto.bytes).toString("base64"),
      },
    },
    { type: "text", text: descripcion },
  ];
}

// Si la IA no contesta, la incidencia se abre igual (decisión 10): queda sin
// clasificar y el jefe la tipifica desde el panel.
function reserva(error: string): Clasificacion {
  return {
    tipo: "sin_clasificar",
    urgency: "normal",
    resumen: "",
    error,
  };
}
