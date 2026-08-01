-- Ausencias: turnos que empezaron hace más de 20 minutos sin fichaje de
-- entrada del worker. Las detecta el cron /api/cron/ausencias (cada 15 min),
-- que escribe con service_role y avisa por WhatsApp al teléfono de la company.
-- notified = true cuando el aviso ya salió: garantiza no avisar dos veces.

create table public.absences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,
  worker_id uuid not null references public.workers (id) on delete cascade,
  center_id uuid not null references public.centers (id) on delete cascade,
  date date not null,
  notified boolean not null default false,
  detected_at timestamptz not null default now(),
  -- Un turno solo puede generar una ausencia (evita duplicados entre pasadas).
  constraint absences_shift_unique unique (shift_id)
);

create index absences_company_id_date_idx on public.absences (company_id, date);
create index absences_date_notified_idx on public.absences (date) where not notified;

alter table public.absences enable row level security;

-- El cron escribe con service_role; los jefes solo leen las de su company.
create policy "absences_select_own_company" on public.absences
  for select using (company_id = public.user_company_id());

-- Emitir cambios por Realtime para la vista "Hoy" (respeta la RLS).
alter publication supabase_realtime add table public.absences;
