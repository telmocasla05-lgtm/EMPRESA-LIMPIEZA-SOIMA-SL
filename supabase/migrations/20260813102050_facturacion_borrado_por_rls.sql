-- Proteger la numeración en el borrado con RLS en vez de con un trigger.
--
-- La migración anterior impedía borrar una factura emitida o anulada con un
-- trigger before delete. El efecto no buscado: ese trigger también se dispara
-- en las cascadas, así que borrar una company con facturas emitidas fallaba
-- (companies -> invoices es on delete cascade), y el borrado de datos con
-- service_role quedaba bloqueado.
--
-- La política de RLS consigue lo mismo donde importa —un admin no puede dejar
-- un hueco en la numeración desde el panel— sin afectar a las cascadas ni a
-- service_role, que es código propio del servidor.

drop trigger invoices_borrado_solo_borrador_trg on public.invoices;
drop function public.invoices_borrado_solo_borrador();

drop policy "invoices_delete_admin" on public.invoices;

create policy "invoices_delete_admin" on public.invoices
  for delete using (
    company_id = public.user_company_id()
    and public.user_role() = 'admin'
    -- Un borrador no consume número: borrarlo no deja huecos. Una factura
    -- emitida sí, y una anulada debe quedar registrada como tal (decisión 9).
    and status = 'borrador'
  );
