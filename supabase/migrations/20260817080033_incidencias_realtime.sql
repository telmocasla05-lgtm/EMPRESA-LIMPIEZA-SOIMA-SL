-- Realtime para el panel de incidencias (SPEC-incidencias.md 6.1).
--
-- Mismo criterio que time_entries y absences: la publicación respeta la RLS,
-- así que cada suscriptor solo recibe las filas de su company.
--
-- Las dos tablas hacen falta: incidents porque el estado lo cambian varios
-- jefes a la vez desde el panel, e incident_updates porque el historial de
-- una incidencia abierta en dos pestañas tiene que crecer en las dos.

alter publication supabase_realtime add table public.incidents;
alter publication supabase_realtime add table public.incident_updates;
