create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  whatsapp_message_id text,
  chat_id text not null,
  contact_number text,
  contact_name text,
  message_body text,
  message_type text not null default 'text',
  media_url text,
  direction text not null check (direction in ('inbound', 'outbound')),
  timestamp timestamptz not null default now(),
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_messages_business_timestamp_idx
on public.whatsapp_messages (business_slug, timestamp desc);

create index if not exists whatsapp_messages_chat_idx
on public.whatsapp_messages (business_slug, chat_id);

create table if not exists public.whatsapp_sessions (
  business_slug text primary key,
  status text not null default 'disconnected',
  last_qr_at timestamptz,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  updated_at timestamptz not null default now()
);
