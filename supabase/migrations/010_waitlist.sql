-- VERA beta waitlist signups.
-- Rows are inserted by the FastAPI POST /api/waitlist endpoint (service role).
-- Do not grant insert to anon/authenticated — unauthenticated clients must not write directly.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  source text default 'landing',
  status text not null default 'pending',
  user_agent text,
  referrer text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.waitlist is
  'Beta waitlist emails; written by backend POST /api/waitlist (service role), not by browser clients.';

create index if not exists waitlist_created_at_idx on public.waitlist (created_at desc);

alter table public.waitlist enable row level security;

-- No insert/select policies for anon or authenticated; backend uses service_role.

drop trigger if exists waitlist_set_updated_at on public.waitlist;
create trigger waitlist_set_updated_at
  before update on public.waitlist
  for each row execute function public.set_updated_at();

grant all on table public.waitlist to service_role;
