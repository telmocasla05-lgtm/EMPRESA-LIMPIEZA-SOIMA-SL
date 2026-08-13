-- Facturación: cabeceras, líneas, trazabilidad hasta el fichaje y contador de
-- numeración (SPEC-facturacion.md, secciones 2 y 3).
--
-- Ideas que impone este esquema:
--  - Toda tabla lleva company_id y RLS que aísla por company (CLAUDE.md).
--  - Leer es de toda la company; escribir es exclusivo de admin. Los manager
--    ven el módulo en lectura y resuelven incidencias corrigiendo fichajes.
--  - La tarifa vive en la LÍNEA, no en la cabecera: un centro que cambia de
--    precio a mitad de mes produce dos líneas (decisión 6).
--  - Los datos del cliente se congelan al emitir: una factura no puede cambiar
--    porque después se edite la ficha del cliente.
--  - Lo emitido es inmutable salvo paid_at, notes y pdf_path (triggers al final).
--  - La numeración es correlativa y sin huecos por empresa y serie.

-- Rol del usuario autenticado. Mismo patrón que user_company_id(): SECURITY
-- DEFINER para que al evaluarse dentro de otras políticas no dispare la RLS de
-- profiles (recursión).
create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Cabeceras
-- ---------------------------------------------------------------------------

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- restrict: un cliente con facturas no se borra, se deja de usar.
  client_id uuid not null references public.clients (id) on delete restrict,

  kind text not null default 'ordinaria'
    check (kind in ('ordinaria', 'rectificativa')),
  rectifies_invoice_id uuid references public.invoices (id) on delete restrict,

  period_start date not null,
  period_end date not null,          -- inclusivo: último día del mes

  status text not null default 'borrador'
    check (status in ('borrador', 'emitida', 'anulada')),

  -- Numeración: null mientras es borrador.
  series text,                       -- '2026' | 'R-2026'
  number integer,
  invoice_number text,               -- '2026/0001', para mostrar y buscar
  issue_date date,                   -- fecha de factura (Madrid)
  due_date date,
  issued_at timestamptz,
  issued_by uuid references public.profiles (id) on delete set null,

  -- Datos congelados al emitir.
  client_name text not null,
  client_tax_id text,
  client_address text,
  vat_rate numeric(5, 2) not null,
  payment_method text,
  payment_terms_days integer,

  total_hours numeric(10, 2) not null default 0,
  subtotal numeric(12, 2) not null default 0,
  vat_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,

  pdf_path text,
  paid_at timestamptz,
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,

  constraint invoices_number_unique unique (company_id, series, number),
  constraint invoices_emitida_completa check (
    status <> 'emitida'
    or (series is not null and number is not null and issue_date is not null)
  ),
  constraint invoices_rectificativa_referencia check (
    (kind = 'rectificativa') = (rectifies_invoice_id is not null)
  )
);

-- Un solo borrador/factura viva por cliente y periodo (las rectificativas van
-- aparte). Hace idempotente al cron del día 1.
create unique index invoices_periodo_unico_idx
  on public.invoices (company_id, client_id, period_start)
  where kind = 'ordinaria' and status <> 'anulada';

create index invoices_company_period_idx
  on public.invoices (company_id, period_start desc);
create index invoices_pendientes_cobro_idx
  on public.invoices (company_id, due_date)
  where status = 'emitida' and paid_at is null;

-- ---------------------------------------------------------------------------
-- Líneas: una por centro y tramo de tarifa
-- ---------------------------------------------------------------------------

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  -- set null: si se borra el centro la línea sobrevive con su nombre congelado.
  center_id uuid references public.centers (id) on delete set null,
  center_name text not null,         -- congelado
  description text not null,         -- 'Limpieza — Oficina Centro (01/03–14/03)'
  period_from date not null,
  period_to date not null,
  minutes integer not null,          -- minutos reales, para auditar
  hours numeric(10, 2) not null,     -- minutes/60 redondeado a 2 decimales
  hourly_rate numeric(8, 2) not null,
  amount numeric(12, 2) not null,    -- hours × hourly_rate
  position integer not null
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, position);
create index invoice_lines_company_id_idx on public.invoice_lines (company_id);

-- ---------------------------------------------------------------------------
-- Trazabilidad: qué jornadas concretas entraron en cada factura
-- ---------------------------------------------------------------------------

create table public.invoice_time_entries (
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  -- restrict: un fichaje ya facturado no se borra, para poder justificar la
  -- factura años después.
  entry_in_id uuid not null references public.time_entries (id) on delete restrict,
  entry_out_id uuid not null references public.time_entries (id) on delete restrict,
  company_id uuid not null references public.companies (id) on delete cascade,
  center_id uuid references public.centers (id) on delete set null,
  worker_id uuid not null references public.workers (id) on delete restrict,
  work_date date not null,           -- fecha Madrid de la entrada
  minutes integer not null,
  primary key (invoice_id, entry_in_id)
);

create index invoice_time_entries_entry_in_idx
  on public.invoice_time_entries (entry_in_id);
create index invoice_time_entries_company_id_idx
  on public.invoice_time_entries (company_id);

-- ---------------------------------------------------------------------------
-- Numeración correlativa sin huecos
-- ---------------------------------------------------------------------------

create table public.invoice_counters (
  company_id uuid not null references public.companies (id) on delete cascade,
  series text not null,
  last_number integer not null default 0,
  primary key (company_id, series)
);

-- on conflict do update bloquea la fila: dos emisiones simultáneas se
-- serializan y nunca obtienen el mismo número.
create or replace function public.next_invoice_number(p_company uuid, p_series text)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.invoice_counters (company_id, series, last_number)
  values (p_company, p_series, 1)
  on conflict (company_id, series)
    do update set last_number = public.invoice_counters.last_number + 1
  returning last_number;
$$;

-- Por defecto Postgres concede EXECUTE a PUBLIC: anon no debe poder gastar
-- números de factura.
revoke execute on function public.next_invoice_number(uuid, text) from public;
grant execute on function public.next_invoice_number(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_time_entries enable row level security;
alter table public.invoice_counters enable row level security;

-- invoices: lee la company entera, escribe solo admin. El with check verifica
-- además que el cliente sea de la misma company (patrón de
-- 20260801135819_rls_coherencia_company.sql): la clave foránea comprueba que
-- el id exista, pero no de quién es.
create policy "invoices_select_own_company" on public.invoices
  for select using (company_id = public.user_company_id());

create policy "invoices_insert_admin" on public.invoices
  for insert with check (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
    and exists (
      select 1
      from public.clients cl
      where cl.id = client_id and cl.company_id = public.user_company_id()
    )
  );

create policy "invoices_update_admin" on public.invoices
  for update using (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
  )
  with check (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
    and exists (
      select 1
      from public.clients cl
      where cl.id = client_id and cl.company_id = public.user_company_id()
    )
  );

create policy "invoices_delete_admin" on public.invoices
  for delete using (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
  );

-- invoice_lines: igual, comprobando que la factura y el centro son de la
-- company del usuario.
create policy "invoice_lines_select_own_company" on public.invoice_lines
  for select using (company_id = public.user_company_id());

create policy "invoice_lines_insert_admin" on public.invoice_lines
  for insert with check (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
    and exists (
      select 1
      from public.invoices i
      where i.id = invoice_id and i.company_id = public.user_company_id()
    )
    and (
      center_id is null
      or exists (
        select 1
        from public.centers c
        where c.id = center_id and c.company_id = public.user_company_id()
      )
    )
  );

create policy "invoice_lines_update_admin" on public.invoice_lines
  for update using (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
  )
  with check (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
    and exists (
      select 1
      from public.invoices i
      where i.id = invoice_id and i.company_id = public.user_company_id()
    )
    and (
      center_id is null
      or exists (
        select 1
        from public.centers c
        where c.id = center_id and c.company_id = public.user_company_id()
      )
    )
  );

create policy "invoice_lines_delete_admin" on public.invoice_lines
  for delete using (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
  );

-- invoice_time_entries: solo lectura desde el panel. Lo escribe el servidor
-- con service_role al emitir, así que no lleva políticas de escritura.
create policy "invoice_time_entries_select_own_company" on public.invoice_time_entries
  for select using (company_id = public.user_company_id());

-- invoice_counters: RLS activada y ninguna política. No es una tabla de
-- negocio consultable: solo la tocan service_role y next_invoice_number()
-- (security definer, que se salta la RLS).

-- ---------------------------------------------------------------------------
-- Inmutabilidad de lo emitido
-- ---------------------------------------------------------------------------

-- Tras emitir solo pueden cambiar paid_at, notes y pdf_path. Se añade la
-- transición emitida -> anulada, que el SPEC (5.3) exige para el caso de una
-- rectificativa que deja el total a cero y que la redacción del trigger en la
-- sección 3 no contempla.
--
-- La comprobación iguala esos campos y compara las filas enteras, en vez de
-- listar columna por columna: cualquier columna que se añada en el futuro
-- queda protegida sin tocar este trigger.
create or replace function public.invoices_inmutabilidad()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  fila_antigua public.invoices;
  fila_nueva public.invoices;
begin
  if old.status = 'anulada' then
    raise exception 'La factura % está anulada y no admite cambios',
      coalesce(old.invoice_number, old.id::text);
  end if;

  if old.status <> 'emitida' then
    return new;
  end if;

  fila_antigua := old;
  fila_nueva := new;

  fila_nueva.paid_at := fila_antigua.paid_at;
  fila_nueva.notes := fila_antigua.notes;
  fila_nueva.pdf_path := fila_antigua.pdf_path;

  if fila_nueva.status = 'anulada' then
    fila_nueva.status := fila_antigua.status;
  end if;

  if fila_nueva is distinct from fila_antigua then
    raise exception
      'La factura % ya está emitida: solo se pueden cambiar el cobro, las notas o el PDF',
      coalesce(old.invoice_number, old.id::text);
  end if;

  return new;
end;
$$;

create trigger invoices_inmutabilidad_trg
  before update on public.invoices
  for each row execute function public.invoices_inmutabilidad();

-- Una factura emitida o anulada no se borra: dejaría un hueco en la
-- numeración (decisión 9). Los borradores sí, porque no consumen número.
create or replace function public.invoices_borrado_solo_borrador()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'borrador' then
    raise exception
      'La factura % no se puede borrar porque ya está %; su número quedaría libre',
      coalesce(old.invoice_number, old.id::text), old.status;
  end if;
  return old;
end;
$$;

create trigger invoices_borrado_solo_borrador_trg
  before delete on public.invoices
  for each row execute function public.invoices_borrado_solo_borrador();

-- Las líneas solo se tocan mientras la factura es un borrador.
create or replace function public.invoice_lines_solo_borrador()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  id_factura uuid;
  estado text;
begin
  if tg_op = 'DELETE' then
    id_factura := old.invoice_id;
  else
    id_factura := new.invoice_id;
  end if;

  select i.status into estado
  from public.invoices i
  where i.id = id_factura;

  -- Sin fila: la factura se está borrando y esto es su cascada. Nada que
  -- proteger (el borrado de la cabecera ya tiene su propio trigger).
  if estado is null or estado = 'borrador' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception
    'No se pueden modificar las líneas de una factura %: solo en borrador', estado;
end;
$$;

create trigger invoice_lines_solo_borrador_trg
  before insert or update or delete on public.invoice_lines
  for each row execute function public.invoice_lines_solo_borrador();
