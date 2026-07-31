import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="flex items-center justify-between border-b border-gray-100 pb-5">
        <div className="flex items-baseline gap-8">
          <h1 className="text-lg font-medium tracking-tight text-gray-900">Panel</h1>
          <nav className="flex gap-5 text-sm text-gray-400">
            <Link href="/dashboard" className="transition-colors hover:text-gray-900">
              Hoy
            </Link>
            <Link
              href="/dashboard/turnos"
              className="transition-colors hover:text-gray-900"
            >
              Turnos
            </Link>
            <Link
              href="/dashboard/fichajes"
              className="transition-colors hover:text-gray-900"
            >
              Fichajes
            </Link>
            <Link
              href="/dashboard/operarios"
              className="transition-colors hover:text-gray-900"
            >
              Operarios
            </Link>
            <Link
              href="/dashboard/clientes"
              className="transition-colors hover:text-gray-900"
            >
              Clientes
            </Link>
            <Link
              href="/dashboard/centros"
              className="transition-colors hover:text-gray-900"
            >
              Centros
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-400">{user.email}</span>
          <LogoutButton />
        </div>
      </header>
      <main className="mt-8">{children}</main>
    </div>
  );
}
