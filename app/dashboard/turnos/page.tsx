import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TurnosView } from "./turnos-view";

export default async function TurnosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <TurnosView />;
}
