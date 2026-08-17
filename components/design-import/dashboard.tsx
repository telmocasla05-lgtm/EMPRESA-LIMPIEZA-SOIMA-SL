'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  CalendarDays,
  Clock,
  Users,
  Building2,
  MapPin,
  ReceiptEuro,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

/* ------------------------------------------------------------------ *
 * Digital Power — shell del panel + pestaña "Hoy"
 * Tailwind con valores arbitrarios: no requiere tocar tailwind.config.
 * Fuente Manrope: cárgala en app/layout.tsx (ver nota al final).
 * ------------------------------------------------------------------ */

/* ---------------------------------- tokens ---------------------------------- */

const T = {
  ink: 'text-[#16130f]',
  muted: 'text-[#6b6560]',
  line: 'border-[#e7e4e0]',
  card: 'bg-white border border-[#e7e4e0] rounded-2xl shadow-[0_1px_2px_rgba(22,19,15,.05)]',
  shSm: 'shadow-[0_1px_2px_rgba(22,19,15,.05)]',
  shMd: 'shadow-[0_4px_16px_rgba(22,19,15,.06),0_1px_3px_rgba(22,19,15,.04)]',
  focus:
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ec3013] focus-visible:rounded-lg',
} as const;

/* -------------------------------- primitivas -------------------------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-full font-semibold ' +
    'transition-[transform,box-shadow,background-color,border-color] duration-150 ' +
    'hover:-translate-y-px active:translate-y-0 disabled:opacity-45 ' +
    'disabled:pointer-events-none motion-reduce:transition-none motion-reduce:hover:translate-y-0 ' +
    T.focus;

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-[18px] py-2.5 text-[15px]',
    lg: 'px-[30px] py-4 text-[17px]',
  } as const;

  // Las clases van escritas enteras a propósito: Tailwind escanea el texto del
  // archivo, así que una clase construida por concatenación no se genera.
  const variants = {
    primary:
      'text-white border-0 bg-[linear-gradient(140deg,#ff5a38,#ec3013)] ' +
      'shadow-[0_4px_14px_rgba(236,48,19,.24)] hover:shadow-[0_8px_22px_rgba(236,48,19,.32)]',
    secondary:
      'bg-white border border-[#e7e4e0] text-[#16130f] ' +
      'shadow-[0_1px_2px_rgba(22,19,15,.05)] hover:border-[#d8d3ce] ' +
      'hover:shadow-[0_4px_16px_rgba(22,19,15,.06),0_1px_3px_rgba(22,19,15,.04)]',
    ghost:
      'bg-transparent border border-transparent text-[#6b6560] hover:bg-[#f1f0ee] hover:text-[#16130f]',
    danger:
      'bg-transparent border border-transparent text-[#b8240d] hover:bg-[#fef1ee]',
  } as const;

  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />;
}

export function StatusPill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'info' | 'off';
  children: React.ReactNode;
}) {
  const tones = {
    ok: 'bg-[#e8f6ee] text-[#1f7a4d] border-[#b9dfc9]',
    warn: 'bg-[#fffaf0] text-[#8a5a18] border-[#f3ddb6]',
    info: 'bg-[#eef4fd] text-[#1f4d8a] border-[#c3d7f2]',
    off: 'bg-[#f1f0ee] text-[#6b6560] border-[#e7e4e0]',
  } as const;
  return (
    <span
      className={`inline-block rounded-full border px-[11px] py-1 text-[13px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  tone = 'neutral',
  action,
}: {
  title: string;
  body: string;
  tone?: 'neutral' | 'ok';
  action?: React.ReactNode;
}) {
  return (
    <div className={`${T.card} px-6 py-12 text-center`}>
      <p className={`m-0 text-[17px] font-semibold ${tone === 'ok' ? 'text-[#1f7a4d]' : T.ink}`}>
        {title}
      </p>
      <p className={`mt-2 text-[15px] ${T.muted}`}>{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-xl bg-[#f1f0ee] motion-reduce:animate-none ${className}`}
    />
  );
}

/* ---------------------------------- shell ---------------------------------- */

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Hoy', icon: Activity },
  { href: '/dashboard/turnos', label: 'Turnos', icon: CalendarDays },
  { href: '/dashboard/fichajes', label: 'Fichajes', icon: Clock },
  { href: '/dashboard/operarios', label: 'Operarios', icon: Users },
  { href: '/dashboard/clientes', label: 'Clientes', icon: Building2 },
  { href: '/dashboard/centros', label: 'Centros', icon: MapPin },
  { href: '/dashboard/facturas', label: 'Facturas', icon: ReceiptEuro },
  { href: '/dashboard/incidencias', label: 'Incidencias', icon: TriangleAlert },
];

// "Hoy" vive en /dashboard, que es prefijo de todo lo demás: solo marca cuando
// la ruta coincide exacta. El resto marca también en sus subpáginas, para que
// el detalle de una incidencia no deje la navegación sin ningún activo.
function esActiva(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardShell({
  email,
  onSignOut,
  children,
}: {
  email: string;
  onSignOut?: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className={`flex min-h-screen bg-[#f8f9fb] font-sans ${T.ink} max-[900px]:block`}>
      <aside
        className={`flex w-[244px] flex-none flex-col border-r border-[#e7e4e0] bg-white
                    sticky top-0 h-screen
                    max-[900px]:static max-[900px]:h-auto max-[900px]:w-auto
                    max-[900px]:border-r-0 max-[900px]:border-b`}
      >
        <div className="flex items-center gap-2.5 border-b border-[#e7e4e0] p-5">
          <span
            aria-hidden
            className="h-[26px] w-[26px] flex-none rounded-lg bg-[linear-gradient(140deg,#ff6a4d,#ec3013)] shadow-[0_2px_8px_rgba(236,48,19,.3)]"
          />
          <span className="text-[16.5px] font-extrabold tracking-[-0.03em]">Digital Power</span>
        </div>

        <nav
          aria-label="Principal"
          className="flex flex-col gap-0.5 p-3 max-[900px]:flex-row max-[900px]:gap-1 max-[900px]:overflow-x-auto"
        >
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = esActiva(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[15px]
                            no-underline transition-colors duration-150 whitespace-nowrap
                            max-[900px]:rounded-full ${T.focus} ${
                  active
                    ? 'bg-[#fef1ee] font-semibold text-[#16130f] shadow-[inset_0_0_0_1px_rgba(236,48,19,.14)]'
                    : 'font-medium text-[#6b6560] hover:bg-[#f1f0ee] hover:text-[#16130f]'
                }`}
              >
                <Icon size={17} strokeWidth={2} aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>

        <div
          className="mt-auto flex flex-col gap-1.5 border-t border-[#e7e4e0] px-5 py-4
                     max-[900px]:flex-row max-[900px]:items-center max-[900px]:justify-between"
        >
          <span className={`truncate text-[13px] ${T.muted}`}>{email}</span>
          <button
            type="button"
            onClick={onSignOut}
            className={`self-start whitespace-nowrap text-[13px] font-semibold underline ${T.focus}`}
          >
            Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-8 px-10 py-14 max-[760px]:px-5 max-[760px]:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <header className="flex flex-wrap items-baseline gap-4">
      <h1 className="m-0 text-[34px] font-extrabold leading-[1.05] tracking-[-0.035em]">{title}</h1>
      {meta ? <p className={`m-0 text-base ${T.muted}`}>{meta}</p> : null}
    </header>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="m-0 text-xl font-bold tracking-[-0.025em]">{children}</h2>;
}

/* ------------------------------ pestaña "Hoy" ------------------------------ */

export type FichadoAhora = {
  id: string;
  operario: string;
  centro: string;
  horaEntrada: string; // "08:02"
  horasHoy: string; // "3 h 58 min"
};

export type PendienteRevision = {
  id: string;
  operario: string;
  centro: string;
  tipo: 'entrada' | 'salida'; // el diseño solo contemplaba entradas
  hora: string; // "08:41"
  motivo: string; // "fuera del radio GPS (a 230 m del centro)"
};

export function MetricCard({
  label,
  value,
  footnote,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: number | string;
  footnote: string;
  tone?: 'neutral' | 'warn' | 'danger';
  // Si se pasa, la tarjeta entera es un enlace (la vista Hoy lleva así al
  // listado de incidencias ya filtrado).
  href?: string;
}) {
  const bordes = {
    neutral: '',
    warn: 'border-l-[3px] border-l-[#d9973c]',
    danger: 'border-l-[3px] border-l-[#ec3013]',
  } as const;
  const cifras = {
    neutral: '',
    warn: 'text-[#d9973c]',
    danger: 'text-[#ec3013]',
  } as const;

  const contenido = (
    <>
      <p className={`m-0 text-[13px] font-medium ${T.muted}`}>{label}</p>
      <p
        className={`m-0 mt-2.5 text-[50px] font-extrabold leading-none tracking-[-0.04em] tabular-nums ${cifras[tone]}`}
      >
        {value}
      </p>
      <p className={`m-0 mt-2.5 text-sm ${T.muted}`}>{footnote}</p>
    </>
  );

  const clases = `block rounded-3xl border border-[#e7e4e0] bg-white p-[26px] no-underline ${T.ink} ${T.shSm} ${bordes[tone]}`;

  // La sombra del hover va escrita entera: Tailwind no genera clases
  // construidas por concatenación (ver la nota de Button).
  if (href) {
    return (
      <Link
        href={href}
        className={`${clases} transition-shadow duration-150 ${T.focus}
                    hover:shadow-[0_4px_16px_rgba(22,19,15,.06),0_1px_3px_rgba(22,19,15,.04)]`}
      >
        {contenido}
      </Link>
    );
  }
  return <div className={clases}>{contenido}</div>;
}

export function TodayDashboard({
  fecha,
  fichados,
  pendientes,
  operariosActivos,
  loading = false,
  onMarcarValido,
}: {
  fecha: string;
  fichados: FichadoAhora[];
  pendientes: PendienteRevision[];
  operariosActivos: number;
  loading?: boolean;
  onMarcarValido?: (id: string) => void | Promise<void>;
}) {
  const [resueltos, setResueltos] = useState<string[]>([]);
  const visibles = useMemo(
    () => pendientes.filter((p) => !resueltos.includes(p.id)),
    [pendientes, resueltos],
  );

  // Se oculta la tarjeta al instante, pero si el guardado falla se devuelve a
  // la lista: si no, el fichaje pendiente desaparece sin haberse validado.
  const marcar = async (id: string) => {
    setResueltos((r) => [...r, id]);
    try {
      await onMarcarValido?.(id);
    } catch {
      setResueltos((r) => r.filter((pendiente) => pendiente !== id));
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Hoy" meta={fecha} />
        <div aria-label="Cargando el resumen de hoy" className="flex flex-col gap-6">
          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            <Skeleton className="h-[136px]" />
            <Skeleton className="h-[136px]" />
          </div>
          <Skeleton className="h-[220px]" />
          <p className={`m-0 text-[15px] ${T.muted}`}>Cargando el resumen de hoy…</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Hoy" meta={fecha} />

      <section aria-label="Resumen" className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        <MetricCard
          label="Operarios fichados ahora"
          value={fichados.length}
          footnote={`de ${operariosActivos} operarios activos`}
        />
        <MetricCard
          label="Fichajes pendientes de revisión"
          value={visibles.length}
          footnote={visibles.length > 0 ? 'Requieren tu revisión' : 'Nada que revisar'}
          tone={visibles.length > 0 ? 'warn' : 'neutral'}
        />
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Fichados ahora mismo</SectionTitle>

        {fichados.length === 0 ? (
          <EmptyState
            title="No hay nadie fichado en este momento."
            body="Cuando un operario fiche por WhatsApp, aparecerá aquí al instante."
          />
        ) : (
          <>
            {/* escritorio */}
            <div className={`hidden overflow-hidden min-[761px]:block ${T.card}`}>
              <table className="w-full border-separate border-spacing-0 text-[15px]">
                <thead>
                  <tr>
                    {['Operario', 'Centro', 'Hora de entrada', 'Horas acumuladas hoy'].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className={`border-b border-[#e7e4e0] bg-[#fcfcfd] px-4 py-[13px] text-left text-[13px] font-semibold ${T.muted}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fichados.map((f, i) => (
                    <tr key={f.id} className="transition-colors duration-150 hover:bg-[#fcfcfd]">
                      {[f.operario, f.centro, f.horaEntrada, f.horasHoy].map((cell, j) => (
                        <td
                          key={j}
                          className={`px-4 py-[15px] ${
                            i === fichados.length - 1 ? '' : 'border-b border-[#f1f0ee]'
                          } ${j === 0 ? 'font-semibold' : ''} ${j >= 2 ? 'tabular-nums' : ''}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* móvil */}
            <div className="flex flex-col gap-3 min-[761px]:hidden">
              {fichados.map((f) => (
                <div key={f.id} className={`${T.card} rounded-xl! p-4`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-base font-bold">{f.operario}</span>
                    <span className="text-[15px] tabular-nums">{f.horaEntrada}</span>
                  </div>
                  <div className={`mt-1.5 flex justify-between gap-3 text-sm ${T.muted}`}>
                    <span>{f.centro}</span>
                    <span className="tabular-nums">{f.horasHoy} hoy</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Pendientes de revisión</SectionTitle>

        {visibles.length === 0 ? (
          <EmptyState
            tone="ok"
            title="Todo en orden ✓"
            body="No hay fichajes pendientes de revisión."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {visibles.map((p) => (
              <div
                key={p.id}
                className={`flex flex-wrap items-center gap-4 rounded-2xl border border-[#f3ddb6]
                            border-l-[3px] border-l-[#d9973c] bg-[#fffaf0] px-5 py-[18px] ${T.shSm}`}
              >
                <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                  <span className="text-base font-bold">
                    {p.operario} · {p.centro}
                  </span>
                  <span className="text-[14.5px] text-[#8a5a18]">
                    {p.tipo === 'entrada' ? 'Entrada' : 'Salida'} a las {p.hora} — {p.motivo}
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <Button variant="secondary" onClick={() => marcar(p.id)}>
                    Marcar válido
                  </Button>
                  <Link
                    href={`/dashboard/fichajes?fichaje=${p.id}`}
                    className={`inline-flex items-center rounded-full px-[18px] py-2.5 text-[15px]
                                font-semibold text-[#6b6560] no-underline transition-colors
                                duration-150 hover:bg-[#f1f0ee] hover:text-[#16130f] ${T.focus}`}
                  >
                    Ver fichaje
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export default TodayDashboard;
