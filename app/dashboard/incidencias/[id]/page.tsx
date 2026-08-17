import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  IncidenciaDetalle,
  type ActualizacionIncidencia,
  type IncidenciaDetallada,
} from "./incidencia-detalle";

// Detalle de una incidencia (SPEC-incidencias.md 6.1).
//
// Sin filtro por company: la RLS ya la limita a la del usuario, así que una
// incidencia de otra empresa sencillamente no aparece y sale un 404.
export default async function IncidenciaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: incidencia } = await supabase
    .from("incidents")
    .select(
      "id, company_id, type, urgency, status, description, photo_url, created_at, " +
        "resolved_at, notified_at, notified_phone, workers ( full_name ), centers ( name )",
    )
    .eq("id", id)
    .maybeSingle();
  if (!incidencia) notFound();

  const { data: actualizaciones } = await supabase
    .from("incident_updates")
    .select("id, note, created_at, profiles ( full_name )")
    .eq("incident_id", id)
    .order("created_at", { ascending: true });

  return (
    <IncidenciaDetalle
      inicial={incidencia as unknown as IncidenciaDetallada}
      actualizacionesIniciales={
        (actualizaciones ?? []) as unknown as ActualizacionIncidencia[]
      }
    />
  );
}
