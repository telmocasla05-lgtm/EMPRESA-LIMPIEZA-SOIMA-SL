import { redirect } from "next/navigation";
import { ESTADOS } from "@/lib/incidencias/estado";
import { createClient } from "@/lib/supabase/server";
import { IncidenciasView, type FiltroEstado } from "./incidencias-view";

const FILTROS_VALIDOS: FiltroEstado[] = ["sin_resolver", "todas", ...ESTADOS];

// Listado de incidencias (SPEC-incidencias.md 6.1).
//
// El filtro de estado se puede fijar por query string (?estado=sin_resolver):
// así la tarjeta de la vista Hoy enlaza directamente a lo que está contando.
export default async function IncidenciasPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { estado } = await searchParams;
  const inicial = FILTROS_VALIDOS.find((valido) => valido === estado) ?? "sin_resolver";

  return <IncidenciasView estadoInicial={inicial} />;
}
