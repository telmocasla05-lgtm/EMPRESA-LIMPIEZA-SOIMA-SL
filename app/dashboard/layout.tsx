import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardNav } from "./nav";
import { LogoutButton } from "./logout-button";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-gray-50/80">
      {/* Barra lateral (escritorio) */}
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-56 flex-col border-r border-gray-200/60 bg-white px-3 py-5 md:flex">
        <div className="px-3 pb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
            Digital Power
          </p>
          <p className="mt-0.5 text-sm font-medium text-gray-900">Panel</p>
        </div>
        <DashboardNav />
        <div className="mt-auto space-y-2 border-t border-gray-100 px-3 pt-4">
          <p className="truncate text-xs text-gray-400" title={user.email ?? ""}>
            {user.email}
          </p>
          <LogoutButton />
        </div>
      </aside>

      {/* Cabecera compacta (móvil) */}
      <header className="sticky top-0 z-10 border-b border-gray-200/60 bg-white/90 px-4 py-3 backdrop-blur md:hidden">
        <div className="flex items-center justify-between pb-2">
          <p className="text-sm font-medium text-gray-900">Digital Power</p>
          <LogoutButton />
        </div>
        <DashboardNav horizontal />
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 md:ml-56 md:px-10 md:py-10">
        {children}
      </main>
    </div>
  );
}
