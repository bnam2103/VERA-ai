-- VERA Phase 4b: account-linked work checklist items (per auth user).

create table if not exists public.checklist_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null,
  text text not null default '',
  completed boolean not null default false,
  parent_id text,
  sort_order integer not null default 0,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

create index if not exists checklist_items_user_sort_idx
  on public.checklist_items (user_id, sort_order);

drop trigger if exists checklist_items_set_updated_at on public.checklist_items;
create trigger checklist_items_set_updated_at
  before update on public.checklist_items
  for each row execute function public.set_updated_at();

alter table public.checklist_items enable row level security;

drop policy if exists "checklist_items_select_own" on public.checklist_items;
create policy "checklist_items_select_own"
  on public.checklist_items for select
  using (auth.uid() = user_id);

drop policy if exists "checklist_items_insert_own" on public.checklist_items;
create policy "checklist_items_insert_own"
  on public.checklist_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "checklist_items_update_own" on public.checklist_items;
create policy "checklist_items_update_own"
  on public.checklist_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "checklist_items_delete_own" on public.checklist_items;
create policy "checklist_items_delete_own"
  on public.checklist_items for delete
  using (auth.uid() = user_id);

grant all on table public.checklist_items to service_role;
grant select, insert, update, delete on table public.checklist_items to authenticated;
