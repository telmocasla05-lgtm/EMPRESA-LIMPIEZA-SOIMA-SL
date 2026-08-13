-- Emisión atómica de una factura (SPEC-facturacion.md 5.2, paso 8).
--
-- Pedir el número y marcar la factura como emitida tienen que ocurrir en la
-- misma transacción. Hechos como dos llamadas seguidas desde el servidor, un
-- fallo entre medias dejaría un número gastado sin factura, es decir un hueco
-- en la numeración, que es justo lo que prohíbe la decisión 9.
--
-- SECURITY INVOKER (el valor por defecto): la RLS sigue aplicándose, así que
-- solo un admin de la company puede emitir. El `for update` serializa dos
-- emisiones simultáneas de la MISMA factura, y next_invoice_number() —con su
-- `on conflict do update`, que bloquea la fila del contador— serializa dos
-- emisiones distintas de la misma serie.

create or replace function public.emitir_factura(
  p_invoice_id uuid,
  p_issue_date date,
  p_due_date date
)
returns public.invoices
language plpgsql
set search_path = ''
as $$
declare
  factura public.invoices;
  v_series text;
  v_number integer;
begin
  select * into factura
  from public.invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'La factura % no existe o no es accesible', p_invoice_id;
  end if;

  if factura.status <> 'borrador' then
    raise exception 'La factura % ya no es un borrador (está %)',
      p_invoice_id, factura.status;
  end if;

  -- Serie anual por empresa; las rectificativas llevan contador propio.
  v_series := case
    when factura.kind = 'rectificativa' then 'R-' || to_char(p_issue_date, 'YYYY')
    else to_char(p_issue_date, 'YYYY')
  end;

  v_number := public.next_invoice_number(factura.company_id, v_series);

  update public.invoices
  set status = 'emitida',
      series = v_series,
      number = v_number,
      invoice_number = v_series || '/' || lpad(v_number::text, 4, '0'),
      issue_date = p_issue_date,
      due_date = p_due_date,
      issued_at = now(),
      issued_by = (select auth.uid())
  where id = p_invoice_id
  returning * into factura;

  return factura;
end;
$$;

revoke execute on function public.emitir_factura(uuid, date, date) from public;
grant execute on function public.emitir_factura(uuid, date, date)
  to authenticated, service_role;
