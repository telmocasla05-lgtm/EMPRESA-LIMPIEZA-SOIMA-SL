# Limpieza SaaS — Digital Power

SaaS multi-tenant para empresas de limpieza. Panel web (jefes) + WhatsApp (operarios).

## Stack
- Next.js 15 (App Router) + TypeScript estricto + Tailwind
- Supabase: Postgres + Auth + Storage. Cliente en lib/supabase/
- WhatsApp Business API (Cloud API de Meta). Helpers en lib/whatsapp/

## Comandos
- npm run dev — desarrollo
- npm run test — tests (Vitest). Ejecuta solo el test afectado, no toda la suite
- npm run typecheck — SIEMPRE al terminar una serie de cambios
- npx supabase migration new <nombre> — nueva migración

## Reglas multi-tenant (IMPORTANTE)
- TODA tabla de datos lleva columna company_id (uuid, not null)
- TODA tabla lleva política RLS filtrando por company_id. Sin excepciones
- NUNCA usar la clave service_role en código accesible desde el cliente
- Cambios de esquema SOLO vía migración en supabase/migrations/

## Reglas WhatsApp
- Todo envío de mensaje pasa por lib/whatsapp/send.ts (con reintentos y logging)
- El webhook debe responder 200 en menos de 5 segundos: procesar en background
- Flujos de conversación documentados en docs/whatsapp-flows.md

## Estilo
- ES modules, imports destructurados
- Textos de interfaz y WhatsApp en español
- Fechas siempre en zona Europe/Madrid

## Límites
- No tocar migraciones ya aplicadas (crear migración nueva)
- No instalar librerías nuevas sin proponerlo antes
