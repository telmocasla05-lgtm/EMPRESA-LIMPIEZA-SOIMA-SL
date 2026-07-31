import { type SupabaseClient } from "@supabase/supabase-js";

// Company del usuario autenticado, vía su profile. Necesario en los inserts
// del panel: la RLS exige company_id = la del usuario.
export async function getOwnCompanyId(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error("Sesión no válida. Vuelve a iniciar sesión.");
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", user.id)
    .single();
  if (error) {
    throw new Error(`No se pudo obtener tu empresa: ${error.message}`);
  }
  return data.company_id as string;
}
