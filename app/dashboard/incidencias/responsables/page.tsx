import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResponsablesView } from "./responsables-view";

// Quién recibe el WhatsApp de cada tipo de incidencia (SPEC-incidencias.md 6.3).
// La pantalla la ve toda la company; editar es solo de admin, y eso lo impone
// la RLS: aquí el rol solo sirve para no enseñar botones que van a fallar.
export default async function ResponsablesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [{ data: profile }, { data: company }] = await Promise.all([
    supabase.from("profiles").select("role, company_id").eq("id", user.id).single(),
    supabase.from("companies").select("phone").limit(1).maybeSingle(),
  ]);

  return (
    <ResponsablesView
      esAdmin={profile?.role === "admin"}
      telefonoEmpresa={(company?.phone as string | null) ?? null}
    />
  );
}
