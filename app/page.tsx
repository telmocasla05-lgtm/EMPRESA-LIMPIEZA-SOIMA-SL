import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <p className="text-xs font-medium uppercase tracking-[0.25em] text-gray-400">
        Digital Power
      </p>
      <h1 className="max-w-md text-2xl font-medium tracking-tight text-gray-900">
        Gestión de limpieza sin papeles
      </h1>
      <p className="max-w-sm text-sm text-gray-500">
        Turnos, fichajes por WhatsApp y avisos automáticos para tu equipo.
      </p>
      <Link
        href="/login"
        className="rounded-full bg-blue-100 px-6 py-2.5 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-200"
      >
        Entrar al panel
      </Link>
    </main>
  );
}
