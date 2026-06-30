-- Phase 0: optional client-side idempotency key for usage_events.

alter table public.usage_events
  add column if not exists client_event_id text;

create unique index if not exists usage_events_session_client_event_uidx
  on public.usage_events (session_id, client_event_id)
  where client_event_id is not null;
