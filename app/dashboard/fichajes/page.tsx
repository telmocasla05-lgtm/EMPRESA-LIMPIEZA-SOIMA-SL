import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FichajesView } from "./fichajes-view";

export default async function FichajesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <FichajesView />;
}
