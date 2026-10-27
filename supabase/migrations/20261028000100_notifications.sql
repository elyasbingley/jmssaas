-- Notifications - the Notifications tab's real backing store (see
-- apps/mobile/app/(tabs)/notifications/index.tsx's own placeholder
-- comment for the originally-scoped list: Channels messages/emails, quote
-- acceptances, task reminders, job booking reminders, stale jobs). This
-- pass wires up the first one (Channels) plus the general-purpose
-- primitive (notifications table, push_tokens, the send-notification Edge
-- Function) every later type reuses - deliberately not Channels-specific
-- itself.
--
-- One row per (tenant, recipient profile) rather than one tenant-wide row
-- + a separate read-receipts join table - simpler, and the per-tenant
-- notification volume here is small (small businesses, not a social feed
-- at scale) so the normal "N rows for N recipients" duplication costs
-- nothing that matters.
--
-- Supabase-direct (polled, same as Channels' own list - see that fix's
-- own commit), not PowerSync-synced: notifications are inherently an
-- "online, right now" concept (the whole point is a timely nudge, backed
-- by a push notification for when the app isn't even open), nothing
-- about them needs offline access, and keeping them off PowerSync avoids
-- another manual "redeploy powersync/sync-rules.yaml via the dashboard"
-- step a tenant could forget - see the notes-disappearing bug this
-- session already hit from exactly that.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  profile_id uuid not null references public.profiles (id),
  -- 'channel_message' for now; 'quote_accepted'/'task_due'/'job_booking_
  -- reminder'/'stale_job' etc. land the same way as those are built.
  type text not null,
  title text not null,
  body text not null,
  -- Deep-link target, shape depends on `type` - e.g. {"conversation_id":
  -- "..."} for channel_message. The app, not the database, knows how to
  -- route each type; this stays a free-form bag on purpose (same
  -- reasoning as channel_connections.config) so a new notification type
  -- never needs a schema change here.
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_profile_id_idx on public.notifications (profile_id, created_at desc);
create index notifications_profile_unread_idx on public.notifications (profile_id) where read_at is null;

alter table public.notifications enable row level security;

create policy "notifications: select own" on public.notifications
  for select using (profile_id = auth.uid());
-- Marking read/unread is the only client-side write - everything else
-- (who gets notified, title/body/data) is decided server-side by
-- send-notification, never by the client, so there's no insert/delete
-- policy at all here.
create policy "notifications: update own (mark read)" on public.notifications
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- Expo push tokens - one row per device per profile (the same person
-- signed in on a phone and a tablet gets both). A token can legitimately
-- move to a different profile (e.g. a shared/handed-down device, or the
-- same user reinstalling and Expo issuing a fresh token for an old
-- install) - `unique (token)` with upsert-by-token in the app (not
-- upsert-by-profile_id) is what keeps a stale token from double-firing
-- to whoever registered it last.
create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  profile_id uuid not null references public.profiles (id),
  token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_push_tokens_updated_at
  before update on public.push_tokens
  for each row execute function public.set_updated_at();

create index push_tokens_profile_id_idx on public.push_tokens (profile_id);
create index push_tokens_tenant_id_idx on public.push_tokens (tenant_id);

alter table public.push_tokens enable row level security;

-- A device registers/removes its own token; nothing reads this table back
-- client-side (send-notification, service-role, is the only reader) so
-- there's no select policy.
create policy "push_tokens: insert own" on public.push_tokens
  for insert with check (profile_id = auth.uid() and tenant_id = public.current_tenant_id());
create policy "push_tokens: update own" on public.push_tokens
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy "push_tokens: delete own" on public.push_tokens
  for delete using (profile_id = auth.uid());
