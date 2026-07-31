-- Fichajes de operarios vía WhatsApp.
-- valid = false significa "pendiente de revisión por un jefe": fuera de
-- radio, doble entrada sin salida, o salida sin entrada previa.

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  worker_id uuid not null references public.workers (id) on delete cascade,
  center_id uuid references public.centers (id) on delete set null,
  type text not null check (type in ('entrada', 'salida')),
  latitude double precision,
  longitude double precision,
  valid boolean not null default true,
  created_at timestamptz not null default now()
);

create index time_entries_company_id_idx
  on public.time_entries (company_id);
create index time_entries_worker_id_created_at_idx
  on public.time_entries (worker_id, created_at desc);

alter table public.time_entries enable row level security;

-- El webhook escribe con service_role. Los jefes leen y pueden corregir
-- (p. ej. validar fichajes pendientes de revisión) solo en su company.
create policy "time_entries_select_own_company" on public.time_entries
  for select using (company_id = public.user_company_id());

create policy "time_entries_update_own_company" on public.time_entries
  for update using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());

-- Estado conversacional del fichaje: acción que espera una ubicación.
alter table public.workers
  add column pending_action text check (pending_action in ('entrada', 'salida'));
