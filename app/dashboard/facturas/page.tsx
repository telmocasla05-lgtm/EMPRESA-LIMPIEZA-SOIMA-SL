import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FacturasView } from "./facturas-view";

export default async function FacturasPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <FacturasView />;
}
