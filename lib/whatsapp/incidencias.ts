import { type SupabaseClient } from "@supabase/supabase-js";
import { type WorkerRow } from "@/lib/whatsapp/time-entry";

// Alta mínima de una incidencia desde WhatsApp. La company_id sale siempre del
// worker, nunca del payload de Meta.
//
// De momento se abre con los valores por defecto de la tabla
// (type = 'sin_clasificar', urgency = 'normal', status = 'open'): la
// clasificación del tipo, el centro deducido del fichaje abierto, la foto en
// Storage y el aviso al responsable son el resto del módulo de incidencias
// (SPEC-incidencias.md), todavía sin implementar.
export async function abrirIncidencia(
  admin: SupabaseClient,
  worker: WorkerRow,
  description: string | null,
) {
  const { error } = await admin.from("incidents").insert({
    company_id: worker.company_id,
    worker_id: worker.id,
    description,
  });

  if (error) {
    throw new Error(`Error abriendo incidencia: ${error.message}`);
  }

  console.log(`[incidencias] Incidencia abierta para el worker ${worker.id}`);
}
