-- Explicit user feedback + daily feedback bonus credits.

alter table public.usage_credit_daily
  add column if not exists bonus_credits int not null default 0;

create table if not exists public.explicit_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  session_id text,
  usage_date date not null,
  rating int not null check (rating between 1 and 5),
  reason text not null,
  categories text[] not null default '{}',
  contact_ok boolean not null default false,
  user_agent text,
  app_version text,
  route_context text,
  granted_bonus_credits int not null default 0,
  created_at timestamptz not null default now(),
  constraint explicit_feedback_principal check (
    user_id is not null or (session_id is not null and session_id <> '')
  )
);

create index if not exists explicit_feedback_user_date_idx
  on public.explicit_feedback (user_id, usage_date desc)
  where user_id is not null;

create index if not exists explicit_feedback_session_date_idx
  on public.explicit_feedback (session_id, usage_date desc)
  where user_id is null;

create unique index if not exists explicit_feedback_bonus_user_date_idx
  on public.explicit_feedback (user_id, usage_date)
  where user_id is not null and granted_bonus_credits > 0;

create unique index if not exists explicit_feedback_bonus_session_date_idx
  on public.explicit_feedback (session_id, usage_date)
  where user_id is null and granted_bonus_credits > 0;

alter table public.explicit_feedback enable row level security;

grant all on table public.explicit_feedback to service_role;
