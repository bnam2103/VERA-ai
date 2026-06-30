-- VERA Phase 1 fix: grant PostgREST roles access to custom tables.
-- Run this in Supabase SQL Editor if /api/profile returns 42501 permission denied.
--
-- Symptom:
--   {"code":"42501","message":"permission denied for table profiles"}
--   hint: GRANT SELECT ON public.profiles TO service_role

grant all on table public.profiles to service_role;
grant all on table public.memories to service_role;
grant all on table public.user_settings to service_role;

grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.memories to authenticated;
grant select, insert, update, delete on table public.user_settings to authenticated;

-- Backfill profile row for users created before handle_new_user() trigger existed.
insert into public.profiles (id)
select u.id
from auth.users u
where not exists (
  select 1 from public.profiles p where p.id = u.id
)
on conflict (id) do nothing;

insert into public.user_settings (user_id)
select u.id
from auth.users u
where not exists (
  select 1 from public.user_settings s where s.user_id = u.id
)
on conflict (user_id) do nothing;
