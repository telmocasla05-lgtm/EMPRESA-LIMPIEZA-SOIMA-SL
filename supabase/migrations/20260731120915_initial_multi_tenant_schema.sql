-- Esquema inicial multi-tenant.
-- Toda tabla de datos lleva company_id not null y política RLS que aísla
-- por company (ver CLAUDE.md). Las altas de companies y profiles se hacen
-- con service_role (onboarding), por eso no tienen política de insert.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin', 'manager'))
);

create table public.workers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  full_name text not null,
  phone text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, phone)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  contact_name text,
  contact_phone text,
  hourly_rate numeric(8, 2),
  created_at timestamptz not null default now()
);

create table public.centers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null,
  address text,
  latitude double precision,
  longitude double precision,
  radius_meters integer not null default 200,
  created_at timestamptz not null default now()
);

create index profiles_company_id_idx on public.profiles (company_id);
create index workers_company_id_idx on public.workers (company_id);
create index clients_company_id_idx on public.clients (company_id);
create index centers_company_id_idx on public.centers (company_id);
create index centers_client_id_idx on public.centers (client_id);

-- Company del usuario autenticado. SECURITY DEFINER para que al evaluarse
-- dentro de otras políticas no dispare la RLS de profiles (recursión).
create or replace function public.user_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select company_id from public.profiles where id = (select auth.uid())
$$;

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.workers enable row level security;
alter table public.clients enable row level security;
alter table public.centers enable row level security;

-- companies: solo se ve/edita la propia.
create policy "companies_select_own" on public.companies
  for select using (id = public.user_company_id());

create policy "companies_update_own" on public.companies
  for update using (id = public.user_company_id())
  with check (id = public.user_company_id());

-- profiles: lectura dentro de la company; cada usuario edita solo su perfil
-- sin poder cambiarse de company.
create policy "profiles_select_same_company" on public.profiles
  for select using (company_id = public.user_company_id());

create policy "profiles_update_own" on public.profiles
  for update using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and company_id = public.user_company_id());

-- Tablas de datos: aislamiento total por company (select/insert/update/delete).
create policy "workers_tenant_isolation" on public.workers
  for all using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());

create policy "clients_tenant_isolation" on public.clients
  for all using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());

create policy "centers_tenant_isolation" on public.centers
  for all using (company_id = public.user_company_id())
  with check (company_id = public.user_company_id());
