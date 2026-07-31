import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CentrosView } from "./centros-view";

export default async function CentrosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <CentrosView />;
}
