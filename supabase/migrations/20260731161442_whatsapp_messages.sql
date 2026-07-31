-- Mensajes de WhatsApp (entrantes y salientes), aislados por company.
-- El webhook escribe con service_role; los usuarios del panel solo leen
-- los mensajes de su company.

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  worker_id uuid references public.workers (id) on delete set null,
  phone text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  type text not null,
  content text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now()
);

create index whatsapp_messages_company_id_idx
  on public.whatsapp_messages (company_id);
create index whatsapp_messages_worker_id_idx
  on public.whatsapp_messages (worker_id);

alter table public.whatsapp_messages enable row level security;

create policy "whatsapp_messages_select_own_company" on public.whatsapp_messages
  for select using (company_id = public.user_company_id());
