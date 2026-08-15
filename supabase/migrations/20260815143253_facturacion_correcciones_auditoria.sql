-- Dos correcciones de la auditoría del módulo de facturación.
--
-- 1. invoice_time_entries no tenía políticas de escritura, así que emitir
--    desde el panel (cliente de la SESIÓN, como manda actions.ts) fallaba
--    siempre con 42501 al escribir la trazabilidad.
-- 2. next_invoice_number es SECURITY DEFINER y estaba concedida a
--    authenticated sin comprobar la company: cualquier usuario podía gastar
--    números del contador de OTRA empresa y dejarle un hueco permanente.

-- ---------------------------------------------------------------------------
-- 1. Escritura de la trazabilidad
-- ---------------------------------------------------------------------------

-- El SPEC (sección 3) daba por hecho que esto lo escribiría el servidor con
-- service_role. Se hace al revés: la emisión entera va con el cliente de la
-- sesión para que sea la RLS —y no el código— la que exija que quien emite es
-- admin de esa company. Las políticas replican las de invoice_lines, con la
-- misma comprobación de coherencia de company sobre las claves foráneas
-- (patrón de 20260801135819_rls_coherencia_company.sql).
create policy "invoice_time_entries_insert_admin" on public.invoice_time_entries
  for insert with check (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
    and exists (
      select 1
      from public.invoices i
      where i.id = invoice_id and i.company_id = public.user_company_id()
    )
    and exists (
      select 1
      from public.time_entries te
      where te.id = entry_in_id and te.company_id = public.user_company_id()
    )
    and (
      entry_out_id is null
      or exists (
        select 1
        from public.time_entries te
        where te.id = entry_out_id and te.company_id = public.user_company_id()
      )
    )
  );

-- Delete: al reemitir hay que poder rehacer la trazabilidad entera, porque un
-- upsert deja vivas las jornadas que ya no entran en la factura.
create policy "invoice_time_entries_delete_admin" on public.invoice_time_entries
  for delete using (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
  );

-- Sin política de update a propósito: la trazabilidad no se corrige fila a
-- fila, se borra y se reescribe (lib/billing/factura.ts).

-- ---------------------------------------------------------------------------
-- 2. El contador solo se toca desde la propia company
-- ---------------------------------------------------------------------------

-- Misma firma y mismo comportamiento; lo único que cambia es que ahora
-- comprueba de quién es el contador antes de incrementarlo.
--
-- emitir_factura es SECURITY INVOKER, así que un admin emitiendo desde el
-- panel llega aquí con su propio auth.uid() y tiene que seguir pudiendo.
-- service_role (cron mensual y tests) no tiene auth.uid() y pasa de largo.
create or replace function public.next_invoice_number(p_company uuid, p_series text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number integer;
begin
  if (select auth.uid()) is not null
     and p_company is distinct from public.user_company_id() then
    raise exception 'No se pueden gastar números de factura de otra company';
  end if;

  -- on conflict do update bloquea la fila: dos emisiones simultáneas se
  -- serializan y nunca obtienen el mismo número.
  insert into public.invoice_counters (company_id, series, last_number)
  values (p_company, p_series, 1)
  on conflict (company_id, series)
    do update set last_number = public.invoice_counters.last_number + 1
  returning last_number into v_number;

  return v_number;
end;
$$;

revoke execute on function public.next_invoice_number(uuid, text) from public;
grant execute on function public.next_invoice_number(uuid, text)
  to authenticated, service_role;
