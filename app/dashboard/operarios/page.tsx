import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OperariosView } from "./operarios-view";

export default async function OperariosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <OperariosView />;
}
