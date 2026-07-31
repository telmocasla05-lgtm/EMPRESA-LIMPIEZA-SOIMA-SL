-- Auditoría de correcciones manuales de fichajes y Realtime para el panel.

alter table public.time_entries
  add column edited_by uuid references public.profiles (id) on delete set null,
  add column edited_at timestamptz;

-- Emitir cambios de time_entries por Supabase Realtime (respeta la RLS:
-- cada suscriptor solo recibe filas de su company).
alter publication supabase_realtime add table public.time_entries;
