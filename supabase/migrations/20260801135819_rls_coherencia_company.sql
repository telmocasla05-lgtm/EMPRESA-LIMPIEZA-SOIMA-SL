-- Coherencia de company entre tablas relacionadas.
--
-- Las políticas anteriores solo comprobaban el company_id de la propia fila.
-- Las claves foráneas verifican que el id exista, pero no a qué company
-- pertenece, y no se ven afectadas por la RLS: un usuario autenticado podía
-- insertar un turno con su company_id apuntando al worker o al centro de otra
-- empresa. Los crons leen esas filas con service_role (se saltan la RLS), de
-- modo que un turno cruzado habría enviado un WhatsApp al teléfono de un
-- operario de otra empresa.
--
-- Las subconsultas se evalúan con los permisos del usuario, así que la RLS de
-- workers/clients/centers ya oculta las filas ajenas; la condición sobre
-- company_id lo deja explícito.

drop policy "shifts_tenant_isolation" on public.shifts;

create policy "shifts_tenant_isolation" on public.shifts
  for all using (company_id = public.user_company_id())
  with check (
    company_id = public.user_company_id()
    and exists (
      select 1
      from public.workers w
      where w.id = worker_id and w.company_id = public.user_company_id()
    )
    and exists (
      select 1
      from public.centers c
      where c.id = center_id and c.company_id = public.user_company_id()
    )
  );

drop policy "centers_tenant_isolation" on public.centers;

create policy "centers_tenant_isolation" on public.centers
  for all using (company_id = public.user_company_id())
  with check (
    company_id = public.user_company_id()
    and exists (
      select 1
      from public.clients cl
      where cl.id = client_id and cl.company_id = public.user_company_id()
    )
  );

-- Los fichajes los inserta el webhook con service_role; el panel solo los
-- corrige (validar, cambiar hora o centro), y esa corrección no puede
-- reapuntar el fichaje a un operario o un centro de otra empresa. center_id es
-- nullable: queda a null cuando se borra el centro.
drop policy "time_entries_update_own_company" on public.time_entries;

create policy "time_entries_update_own_company" on public.time_entries
  for update using (company_id = public.user_company_id())
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
  );
