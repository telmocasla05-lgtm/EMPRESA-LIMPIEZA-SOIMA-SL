-- Responsable por tipo de incidencia y traza del aviso
-- (SPEC-incidencias.md 2.3, 2.5 y 5.1).
--
-- Una fila por tipo y company: quién recibe el WhatsApp cuando entra una
-- incidencia de esa clase. No hay fila para 'sin_clasificar' a propósito: una
-- incidencia que la IA no pudo tipificar no tiene dueño natural, así que avisa
-- siempre al teléfono de la empresa (companies.phone), igual que cuando el
-- tipo no tiene responsable configurado.

create table public.incident_responsibles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Los cuatro tipos de negocio. 'sin_clasificar' es un estado técnico, no un
  -- tipo con responsable (ver comentario de arriba).
  type text not null
    check (type in ('material_roto', 'falta_stock', 'desperfecto', 'seguridad')),
  name text not null check (length(trim(name)) > 0),
  -- Formato internacional, con o sin '+', igual que workers.phone.
  phone text not null check (length(trim(phone)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Un solo responsable por tipo (decisión 5): con dos, el aviso tendría que
  -- elegir, y elegir mal es peor que avisar al teléfono de la empresa.
  unique (company_id, type)
);

create index incident_responsibles_company_id_idx
  on public.incident_responsibles (company_id);

-- Traza del aviso: a qué teléfono se avisó y cuándo. Sirve para no repetirlo y
-- para que el panel pueda marcar "aviso pendiente" cuando el envío falló.
alter table public.incidents add column notified_phone text;
alter table public.incidents add column notified_at timestamptz;

alter table public.incident_responsibles enable row level security;

-- Los responsables los ve toda la company (el manager necesita saber a quién
-- se avisó), pero solo el admin los cambia: quien recibe los avisos de
-- seguridad no es una decisión de gestión diaria.
create policy "incident_responsibles_select" on public.incident_responsibles
  for select using (company_id = public.user_company_id());

create policy "incident_responsibles_write_admin" on public.incident_responsibles
  for all using (
    company_id = public.user_company_id() and public.user_role() = 'admin'
  )
  with check (
    company_id = public.user_company_id() and public.user_role() = 'admin'
  );
