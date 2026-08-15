-- Escritura del bucket privado `facturas` desde el panel.
--
-- 20260813103601 creó el bucket con política de SELECT, que basta para
-- descargar. Pero al emitir desde el panel (botón "Emitir") el PDF se sube con
-- la sesión del usuario, no con service_role, y sin política de escritura esa
-- subida falla: la factura quedaba emitida y correcta con el PDF pendiente
-- (SPEC-facturacion.md 5.2, paso 10).
--
-- Mismo criterio que en `invoices`: leer lo ve toda la company, escribir solo
-- el admin. La primera carpeta de la ruta es el company_id
-- (<company_id>/<año>/<numero>.pdf), que es lo que compara la política.
--
-- update además de insert porque la subida usa upsert: al reintentar un PDF
-- que ya existe, storage actualiza el objeto en vez de crearlo.

create policy "facturas_insert_admin" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'facturas'
    and (storage.foldername(name))[1] = public.user_company_id()::text
    and public.user_role() = 'admin'
  );

create policy "facturas_update_admin" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'facturas'
    and (storage.foldername(name))[1] = public.user_company_id()::text
    and public.user_role() = 'admin'
  )
  with check (
    bucket_id = 'facturas'
    and (storage.foldername(name))[1] = public.user_company_id()::text
    and public.user_role() = 'admin'
  );
