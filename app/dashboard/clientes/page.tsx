import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClientesView } from "./clientes-view";

export default async function ClientesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <ClientesView />;
}
