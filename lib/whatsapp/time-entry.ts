import { type SupabaseClient } from "@supabase/supabase-js";
import { formatHora } from "@/lib/dates";

export type PendingAction = "entrada" | "salida";

export type WorkerRow = {
  id: string;
  company_id: string;
  pending_action: PendingAction | null;
};

export type WhatsAppLocation = {
  latitude: number;
  longitude: number;
};

type CenterRow = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
};

const ENTRADA_KEYWORDS = new Set(["entro", "entrada", "hola"]);
const SALIDA_KEYWORDS = new Set(["salgo", "salida", "me voy"]);

export function parseIntent(text: string): PendingAction | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[¡!¿?.,;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (ENTRADA_KEYWORDS.has(normalized)) return "entrada";
  if (SALIDA_KEYWORDS.has(normalized)) return "salida";
  return null;
}

export async function handleTextMessage(
  admin: SupabaseClient,
  worker: WorkerRow,
  text: string,
): Promise<string> {
  const intent = parseIntent(text);

  if (!intent) {
    return "No te he entendido. Escribe *entro* para fichar la entrada o *salgo* para fichar la salida.";
  }

  const { error } = await admin
    .from("workers")
    .update({ pending_action: intent })
    .eq("id", worker.id);
  if (error) {
    throw new Error(`Error guardando acción pendiente: ${error.message}`);
  }

  return `📍 Para registrar tu ${intent}, comparte tu ubicación: toca el clip (📎) → Ubicación → Enviar tu ubicación actual.`;
}

export async function handleLocationMessage(
  admin: SupabaseClient,
  worker: WorkerRow,
  location: WhatsAppLocation,
): Promise<string> {
  const intent = worker.pending_action;
  if (!intent) {
    return "Primero dime qué quieres fichar: escribe *entro* o *salgo* y después comparte tu ubicación.";
  }

  const { data: centers, error: centersError } = await admin
    .from("centers")
    .select("id, name, latitude, longitude, radius_meters")
    .eq("company_id", worker.company_id);
  if (centersError) {
    throw new Error(`Error buscando centros: ${centersError.message}`);
  }

  const located = ((centers ?? []) as CenterRow[]).filter(
    (center) => center.latitude !== null && center.longitude !== null,
  );

  if (located.length === 0) {
    await clearPendingAction(admin, worker.id);
    return "Tu empresa no tiene centros de trabajo configurados. Contacta con tu responsable.";
  }

  const nearest = located
    .map((center) => ({
      center,
      distance: haversineMeters(
        location.latitude,
        location.longitude,
        center.latitude!,
        center.longitude!,
      ),
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  const inRadius = nearest.distance <= nearest.center.radius_meters;

  const { data: lastEntry, error: lastError } = await admin
    .from("time_entries")
    .select("type")
    .eq("worker_id", worker.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) {
    throw new Error(`Error consultando el último fichaje: ${lastError.message}`);
  }

  let anomaly: "doble_entrada" | "salida_sin_entrada" | null = null;
  if (intent === "entrada" && lastEntry?.type === "entrada") {
    anomaly = "doble_entrada";
  }
  if (intent === "salida" && lastEntry?.type !== "entrada") {
    anomaly = "salida_sin_entrada";
  }

  const valid = inRadius && anomaly === null;

  const { error: insertError } = await admin.from("time_entries").insert({
    company_id: worker.company_id,
    worker_id: worker.id,
    center_id: nearest.center.id,
    type: intent,
    latitude: location.latitude,
    longitude: location.longitude,
    valid,
  });
  if (insertError) {
    throw new Error(`Error registrando fichaje: ${insertError.message}`);
  }

  await clearPendingAction(admin, worker.id);

  const label = intent === "entrada" ? "Entrada" : "Salida";
  const hora = formatHora(new Date());

  if (valid) {
    return `✅ ${label} registrada en ${nearest.center.name} a las ${hora}`;
  }

  const warnings: string[] = [];
  if (!inRadius) {
    warnings.push(
      `Estás a ${Math.round(nearest.distance)} m de ${nearest.center.name} (radio permitido: ${nearest.center.radius_meters} m).`,
    );
  }
  if (anomaly === "doble_entrada") {
    warnings.push("Ya tenías una entrada sin salida.");
  }
  if (anomaly === "salida_sin_entrada") {
    warnings.push("No constaba ninguna entrada abierta.");
  }

  return `⚠️ ${warnings.join(" ")} ${label} registrada en ${nearest.center.name} a las ${hora}, pendiente de revisión.`;
}

async function clearPendingAction(admin: SupabaseClient, workerId: string) {
  const { error } = await admin
    .from("workers")
    .update({ pending_action: null })
    .eq("id", workerId);
  if (error) {
    throw new Error(`Error limpiando acción pendiente: ${error.message}`);
  }
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
