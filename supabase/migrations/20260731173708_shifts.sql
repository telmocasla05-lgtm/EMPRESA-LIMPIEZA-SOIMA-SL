-- Turnos planificados de los operarios.
-- notified = true cuando ya se envió el aviso de WhatsApp del día anterior.

-- Necesaria para el exclusion constraint que mezcla igualdad (uuid) y rangos.
create extension if not exists btree_gist;

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  worker_id uuid not null references public.workers (id) on delete cascade,
  center_id uuid not null references public.centers (id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  notified boolean not null default false,
  created_at timestamptz not null default now(),
  constraint shifts_end_after_start check (end_time > start_time),
  -- Un worker no puede tener dos turnos que se solapen. Rango semiabierto:
  -- un turno que acaba a las 14:00 y otro que empieza a las 14:00 conviven.
  constraint shifts_no_overlap exclude using gist (
    worker_id with =,
    tsrange((date + start_time), (date + end_time), '[)') with &&
  )
);

create index shifts_company_id_date_idx on public.shifts (company_id, date);
create index shifts_worker_id_date_idx on public.shifts (worker_id, date);
create index shifts_date_notified_idx on public.shifts (date) where not notified;

alter table public.shifts enable row level security;

create policy "shifts_tenant_isolation" on public.shifts
  for all using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());
