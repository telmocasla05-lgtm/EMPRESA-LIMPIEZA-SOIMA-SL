-- Datos fiscales y almacén de PDFs (SPEC-facturacion.md 2.1 y 3).
--
-- companies y clients no tenían nada para emitir una factura legal. Estas
-- columnas son obligatorias para EMITIR, no para guardar la ficha: se dejan
-- nullable y la validación vive en el código de emisión, que avisa de lo que
-- falta enlazando a la pantalla correspondiente.

alter table public.companies
  add column tax_id text,
  add column address text,
  add column postal_code text,
  add column city text,
  add column province text,
  add column iban text,
  add column logo_path text;

alter table public.clients
  add column tax_id text,
  add column address text,
  add column postal_code text,
  add column city text,
  add column province text,
  -- 0 es válido: clientes exentos de IVA.
  add column vat_rate numeric(5, 2) not null default 21.00,
  add column payment_terms_days integer not null default 30,
  add column payment_method text not null default 'transferencia'
    check (payment_method in ('transferencia', 'domiciliacion', 'efectivo', 'otro'));

-- Bucket privado para los PDFs. Ruta: <company_id>/<año>/<numero>.pdf
-- La descarga va por un route handler que valida la sesión y devuelve una URL
-- firmada de 60 s; el bucket nunca se expone ni se sirve público.
insert into storage.buckets (id, name, public)
values ('facturas', 'facturas', false)
on conflict (id) do nothing;

-- Cada company solo ve la carpeta que lleva su id.
create policy "facturas_select_own_company" on storage.objects
  for select using (
    bucket_id = 'facturas'
    and (storage.foldername(name))[1] = public.user_company_id()::text
  );
