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
    <div className="mx-auto max-w-5xl p-6">
      <header className="flex items-center justify-between border-b border-gray-200 pb-4">
        <div className="flex items-baseline gap-6">
          <h1 className="text-xl font-semibold">Panel</h1>
          <nav className="flex gap-4 text-sm text-gray-600">
            <Link href="/dashboard" className="hover:text-gray-900 hover:underline">
              Hoy
            </Link>
            <Link
              href="/dashboard/fichajes"
              className="hover:text-gray-900 hover:underline"
            >
              Fichajes
            </Link>
            <Link
              href="/dashboard/operarios"
              className="hover:text-gray-900 hover:underline"
            >
              Operarios
            </Link>
            <Link
              href="/dashboard/clientes"
              className="hover:text-gray-900 hover:underline"
            >
              Clientes
            </Link>
            <Link
              href="/dashboard/centros"
              className="hover:text-gray-900 hover:underline"
            >
              Centros
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user.email}</span>
          <LogoutButton />
        </div>
      </header>
      <main className="mt-6">{children}</main>
    </div>
  );
}
