import { createClient } from "@/lib/supabase/server";
import { urlFirmadaFotoIncidencia } from "@/lib/whatsapp/media";

// Foto de una incidencia (SPEC-incidencias.md 2.6).
//
// El bucket `incidencias` es privado, igual que `facturas`: esta ruta valida
// la sesión, deja que la RLS decida si la incidencia es de la company del
// usuario (una de otra empresa sencillamente no aparece) y redirige a una URL
// firmada de 60 s. Sirve tanto para la miniatura del listado como para la foto
// grande del detalle, así que el <img> del panel apunta siempre aquí.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("No autorizado", { status: 401 });

  const { data, error } = await supabase
    .from("incidents")
    .select("photo_url")
    .eq("id", id)
    .maybeSingle();

  if (error) return new Response(error.message, { status: 500 });
  if (!data) return new Response("Incidencia no encontrada", { status: 404 });
  if (!data.photo_url) {
    return new Response("Esta incidencia no tiene foto", { status: 404 });
  }

  return Response.redirect(await urlFirmadaFotoIncidencia(supabase, data.photo_url), 302);
}
