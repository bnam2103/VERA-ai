-- VERA Behavioral Analytics MVP: lightweight usage events (metadata only).

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  session_id text not null,
  request_id text,
  event_type text not null,
  event_props jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_session_created_idx
  on public.usage_events (session_id, created_at desc);

create index if not exists usage_events_type_created_idx
  on public.usage_events (event_type, created_at desc);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc)
  where user_id is not null;

alter table public.usage_events enable row level security;

grant all on table public.usage_events to service_role;
