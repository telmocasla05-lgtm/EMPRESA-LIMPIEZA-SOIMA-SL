-- Módulo de incidencias (SPEC-incidencias.md).
--
-- Un operario reporta un problema por WhatsApp (texto y/o foto); queda
-- registrado con tipo, urgencia y estado, y el jefe lo gestiona desde el panel
-- hasta resolverlo. incident_updates guarda el historial de notas: es lo que
-- convierte "resuelta" en algo auditable (quién escribió qué y cuándo).
--
-- Las incidencias las inserta el webhook con service_role, que se salta la RLS.
-- El panel solo lee y actualiza, y para eso están las políticas de abajo.

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  worker_id uuid not null references public.workers (id) on delete cascade,
  -- Nullable: se deduce del fichaje de entrada abierto del operario, y puede
  -- reportar sin estar fichado (SPEC-incidencias.md, decisión 4).
  center_id uuid references public.centers (id) on delete set null,

  -- 'sin_clasificar' no es un tipo de negocio: es el estado técnico de una
  -- incidencia que la IA no pudo tipificar (fallo, foto sola, audio). El panel
  -- la marca como pendiente de clasificar y el jefe la corrige.
  type text not null default 'sin_clasificar'
    check (type in ('material_roto', 'falta_stock', 'desperfecto',
                    'seguridad', 'sin_clasificar')),
  -- Automática por tipo: seguridad = alta, el resto = normal (decisión 6).
  urgency text not null default 'normal' check (urgency in ('alta', 'normal')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved')),

  -- Lo que escribió el operario. Null si solo mandó una foto y aún no describe.
  description text,
  -- Ruta dentro del bucket privado `incidencias`, NO una URL pública:
  -- <company_id>/<incident_id>/<fichero>. El panel la sirve firmada a 60 s.
  photo_url text,

  -- Jefe que se ha hecho cargo. Null mientras nadie la coge.
  assigned_to uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  -- Resolver sin fecha de resolución dejaría el estado sin significado: no se
  -- podría medir cuánto tardó en cerrarse ni ordenar por cierre.
  constraint incidents_resolved_at_coherente
    check (status <> 'resolved' or resolved_at is not null)
);

-- Historial de notas de una incidencia (seguimiento y nota de cierre).
-- Lleva company_id propio, redundante con el de la incidencia y a propósito:
-- permite que la política RLS filtre sin join a incidents (mismo criterio que
-- invoice_lines).
create table public.incident_updates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  incident_id uuid not null references public.incidents (id) on delete cascade,
  note text not null check (length(trim(note)) > 0),
  -- Nullable: si se borra el usuario que la escribió, la nota se conserva.
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index incidents_company_id_idx on public.incidents (company_id);
create index incidents_status_idx on public.incidents (company_id, status);
create index incidents_worker_id_idx on public.incidents (worker_id);
create index incidents_center_id_idx on public.incidents (center_id);
create index incident_updates_company_id_idx on public.incident_updates (company_id);
create index incident_updates_incident_id_idx on public.incident_updates (incident_id);

alter table public.incidents enable row level security;
alter table public.incident_updates enable row level security;

-- Aislamiento por company. El with check replica el patrón de coherencia de
-- 20260801135819: la clave foránea garantiza que el worker y el centro existen,
-- pero no a qué company pertenecen, así que sin estas subconsultas un usuario
-- podría crear una incidencia con su company_id apuntando al operario de otra
-- empresa. Los avisos de WhatsApp se envían con service_role leyendo esas
-- filas, de modo que una incidencia cruzada acabaría notificando al teléfono
-- de otra empresa.
create policy "incidents_tenant_isolation" on public.incidents
  for all using (company_id = public.user_company_id())
  with check (
    company_id = public.user_company_id()
    and exists (
      select 1
      from public.workers w
      where w.id = worker_id and w.company_id = public.user_company_id()
    )
    and (
      center_id is null
      or exists (
        select 1
        from public.centers c
        where c.id = center_id and c.company_id = public.user_company_id()
      )
    )
    and (
      assigned_to is null
      or exists (
        select 1
        from public.profiles p
        where p.id = assigned_to and p.company_id = public.user_company_id()
      )
    )
  );

-- Las notas siguen a su incidencia: sin poder ver la incidencia no se puede
-- escribir en ella, aunque se acierte el company_id.
create policy "incident_updates_tenant_isolation" on public.incident_updates
  for all using (company_id = public.user_company_id())
  with check (
    company_id = public.user_company_id()
    and exists (
      select 1
      from public.incidents i
      where i.id = incident_id and i.company_id = public.user_company_id()
    )
  );

-- Bucket privado para las fotos, mismo criterio que `facturas`: nunca se
-- expone público, la descarga va por un route handler que valida la sesión y
-- devuelve una URL firmada de 60 s. Las fotos las sube el webhook con
-- service_role, así que no hace falta política de escritura.
insert into storage.buckets (id, name, public)
values ('incidencias', 'incidencias', false)
on conflict (id) do nothing;

create policy "incidencias_select_own_company" on storage.objects
  for select using (
    bucket_id = 'incidencias'
    and (storage.foldername(name))[1] = public.user_company_id()::text
  );
