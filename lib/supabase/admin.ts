import { createClient } from "@supabase/supabase-js";

// Cliente con service_role: se salta la RLS. SOLO para código de servidor
// (webhooks, jobs). Nunca importar desde componentes ni código que llegue
// al cliente (ver CLAUDE.md).
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
