-- Usage credit daily rollup + per-request ledger (Vera credit caps).

create table if not exists public.usage_credit_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  session_id text,
  usage_date date not null,
  credits_used int not null default 0,
  openai_input_tokens bigint not null default 0,
  openai_output_tokens bigint not null default 0,
  openai_reasoning_tokens bigint not null default 0,
  serper_calls int not null default 0,
  weather_calls int not null default 0,
  reasoning_streams int not null default 0,
  voice_turns int not null default 0,
  search_turns int not null default 0,
  image_pdf_reasoning_turns int not null default 0,
  updated_at timestamptz not null default now(),
  constraint usage_credit_daily_principal check (
    user_id is not null or (session_id is not null and session_id <> '')
  )
);

create unique index if not exists usage_credit_daily_user_date_idx
  on public.usage_credit_daily (user_id, usage_date)
  where user_id is not null;

create unique index if not exists usage_credit_daily_session_date_idx
  on public.usage_credit_daily (session_id, usage_date)
  where user_id is null;

create index if not exists usage_credit_daily_date_idx
  on public.usage_credit_daily (usage_date desc);

create table if not exists public.usage_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  session_id text,
  request_id text,
  credit_action text not null,
  credits_delta int not null,
  estimated_cost_usd numeric(12, 6),
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_credit_ledger_user_created_idx
  on public.usage_credit_ledger (user_id, created_at desc)
  where user_id is not null;

create index if not exists usage_credit_ledger_session_created_idx
  on public.usage_credit_ledger (session_id, created_at desc)
  where session_id is not null;

alter table public.usage_credit_daily enable row level security;
alter table public.usage_credit_ledger enable row level security;

grant all on table public.usage_credit_daily to service_role;
grant all on table public.usage_credit_ledger to service_role;
