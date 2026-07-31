import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-7 bg-gray-50/80 p-8 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gray-400">
        Digital Power
      </p>
      <h1 className="max-w-xl text-4xl font-medium tracking-tight text-gray-900">
        Gestión de limpieza
        <span className="block text-gray-400">sin papeles.</span>
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-gray-500">
        Turnos, fichajes por WhatsApp y avisos automáticos para tu equipo,
        todo en un solo panel.
      </p>
      <Link
        href="/login"
        className="rounded-lg bg-gray-900 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700"
      >
        Entrar al panel
      </Link>
    </main>
  );
}
