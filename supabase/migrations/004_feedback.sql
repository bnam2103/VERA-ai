-- VERA Feedback MVP: thumbs up/down on main chat assistant replies.

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  session_id text not null,
  request_id text,
  turn_id text,
  rating text not null check (rating in ('up', 'down')),
  note text check (note is null or char_length(note) <= 500),
  user_input_excerpt text check (
    user_input_excerpt is null or char_length(user_input_excerpt) <= 1000
  ),
  assistant_response_excerpt text check (
    assistant_response_excerpt is null or char_length(assistant_response_excerpt) <= 1000
  ),
  source text not null default 'main_chat'
    check (source in ('main_chat', 'reasoning_panel')),
  created_at timestamptz not null default now()
);

create index if not exists feedback_user_created_idx
  on public.feedback (user_id, created_at desc);

create index if not exists feedback_session_created_idx
  on public.feedback (session_id, created_at desc);

create index if not exists feedback_request_id_idx
  on public.feedback (request_id)
  where request_id is not null;

alter table public.feedback enable row level security;

drop policy if exists "feedback_select_own" on public.feedback;
create policy "feedback_select_own"
  on public.feedback for select
  using (auth.uid() = user_id);

grant all on table public.feedback to service_role;
grant select, insert on table public.feedback to authenticated;
