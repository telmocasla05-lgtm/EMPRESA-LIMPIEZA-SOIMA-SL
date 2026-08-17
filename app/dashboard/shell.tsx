"use client";

import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/design-import/dashboard";
import { createClient } from "@/lib/supabase/client";

// El shell del diseño es un componente cliente (usa usePathname para marcar la
// pestaña activa) y recibe onSignOut como función, así que el cierre de sesión
// vive aquí y no en el layout de servidor.
export function PanelShell({
  email,
  children,
}: Readonly<{ email: string; children: React.ReactNode }>) {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <DashboardShell email={email} onSignOut={handleLogout}>
      {children}
    </DashboardShell>
  );
}
