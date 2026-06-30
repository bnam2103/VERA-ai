-- VERA Phase: account-linked Work Mode reasoning workspace (tabs/spaces only).

create table if not exists public.work_mode_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  schema_version int not null default 1,
  active_lane_id text,
  max_tabs int not null default 8,
  client_revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.work_mode_workspace_tabs (
  user_id uuid not null references auth.users (id) on delete cascade,
  lane_id text not null,
  sort_order int not null default 0,
  title text not null default 'Untitled',
  lane_label text,
  is_active boolean not null default false,
  closed boolean not null default false,
  summary text,
  registry jsonb not null default '{}'::jsonb,
  messages jsonb not null default '[]'::jsonb,
  rendered_html text,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, lane_id),
  constraint work_mode_workspace_tabs_summary_len check (
    summary is null or char_length(summary) <= 4000
  ),
  constraint work_mode_workspace_tabs_rendered_html_len check (
    rendered_html is null or char_length(rendered_html) <= 120000
  )
);

create index if not exists work_mode_workspace_tabs_user_sort_idx
  on public.work_mode_workspace_tabs (user_id, sort_order);

drop trigger if exists work_mode_workspaces_set_updated_at on public.work_mode_workspaces;
create trigger work_mode_workspaces_set_updated_at
  before update on public.work_mode_workspaces
  for each row execute function public.set_updated_at();

drop trigger if exists work_mode_workspace_tabs_set_updated_at on public.work_mode_workspace_tabs;
create trigger work_mode_workspace_tabs_set_updated_at
  before update on public.work_mode_workspace_tabs
  for each row execute function public.set_updated_at();

alter table public.work_mode_workspaces enable row level security;
alter table public.work_mode_workspace_tabs enable row level security;

drop policy if exists "work_mode_workspaces_select_own" on public.work_mode_workspaces;
create policy "work_mode_workspaces_select_own"
  on public.work_mode_workspaces for select
  using (auth.uid() = user_id);

drop policy if exists "work_mode_workspaces_insert_own" on public.work_mode_workspaces;
create policy "work_mode_workspaces_insert_own"
  on public.work_mode_workspaces for insert
  with check (auth.uid() = user_id);

drop policy if exists "work_mode_workspaces_update_own" on public.work_mode_workspaces;
create policy "work_mode_workspaces_update_own"
  on public.work_mode_workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "work_mode_workspaces_delete_own" on public.work_mode_workspaces;
create policy "work_mode_workspaces_delete_own"
  on public.work_mode_workspaces for delete
  using (auth.uid() = user_id);

drop policy if exists "work_mode_workspace_tabs_select_own" on public.work_mode_workspace_tabs;
create policy "work_mode_workspace_tabs_select_own"
  on public.work_mode_workspace_tabs for select
  using (auth.uid() = user_id);

drop policy if exists "work_mode_workspace_tabs_insert_own" on public.work_mode_workspace_tabs;
create policy "work_mode_workspace_tabs_insert_own"
  on public.work_mode_workspace_tabs for insert
  with check (auth.uid() = user_id);

drop policy if exists "work_mode_workspace_tabs_update_own" on public.work_mode_workspace_tabs;
create policy "work_mode_workspace_tabs_update_own"
  on public.work_mode_workspace_tabs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "work_mode_workspace_tabs_delete_own" on public.work_mode_workspace_tabs;
create policy "work_mode_workspace_tabs_delete_own"
  on public.work_mode_workspace_tabs for delete
  using (auth.uid() = user_id);

grant all on table public.work_mode_workspaces to service_role;
grant all on table public.work_mode_workspace_tabs to service_role;
grant select, insert, update, delete on table public.work_mode_workspaces to authenticated;
grant select, insert, update, delete on table public.work_mode_workspace_tabs to authenticated;
