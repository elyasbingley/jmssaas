-- Google Calendar two-way sync. Design mirrors the Xero integration
-- (20260830000100_xero_integration.sql) but per-PROFILE instead of
-- per-tenant: each user (admin or technician) connects their own Google
-- account, not one shared business calendar. See docs/SETUP.md for the
-- full Google Cloud Console setup this requires.

-- ---------------------------------------------------------------------------
-- google_calendar_connections - one row per connected profile. Real OAuth2
-- bearer credentials, same "zero RLS grants, service-role only" lockdown as
-- xero_connections - the app never reads tokens directly, only via the
-- SECURITY DEFINER RPC below (which returns connection status, never
-- tokens). Disconnect deliberately goes through an Edge Function (not a
-- bare RPC like Xero's disconnect_xero()) since it needs to call Google's
-- channels.stop() over HTTP, which plain SQL can't do.
-- ---------------------------------------------------------------------------

create table public.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  profile_id uuid not null references public.profiles (id) on delete cascade unique,
  google_account_email text,
  google_calendar_id text not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  -- Google's incremental-sync cursor (events.list's syncToken) - lets the
  -- webhook/reconcile jobs pull only what changed since last time instead
  -- of re-scanning the whole calendar. Null until the first full sync
  -- completes.
  sync_token text,
  -- events.watch() push-notification channel bookkeeping. Channels expire
  -- (Google doesn't guarantee the requested expiration is honoured, can be
  -- shorter) and aren't renewable in place - stop the old one, start a new
  -- one. Null until the first watch channel is created.
  channel_id uuid,
  channel_resource_id text,
  channel_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_google_calendar_connections_updated_at
  before update on public.google_calendar_connections
  for each row execute function public.set_updated_at();

create index google_calendar_connections_tenant_id_idx on public.google_calendar_connections (tenant_id);

alter table public.google_calendar_connections enable row level security;

-- Same CSRF-state pattern as xero_oauth_states, keyed to the connecting
-- profile (not just the tenant) since any tenant member can start their own
-- connect flow, not just admins.
create table public.google_oauth_states (
  state text primary key,
  tenant_id uuid not null references public.tenants (id),
  profile_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.google_oauth_states enable row level security;

-- ---------------------------------------------------------------------------
-- calendar_events extensions
-- ---------------------------------------------------------------------------

alter table public.calendar_events
  -- 'app': created in this app (job schedules, manual entries) - two-way
  -- synced with Google when the resolved assignee has a connection.
  -- 'google_personal': imported from a technician's own Google Calendar,
  -- never created here. For a 'google_personal' row, title/description/
  -- location/guests on THIS table are always the literal placeholder
  -- 'Busy'/null, regardless of what the real Google event says - the real
  -- content lives only in calendar_event_personal_details below, which
  -- only the owning profile can read. This means calendar_events itself
  -- never needs any redaction logic: every caller sees exactly the row
  -- that's actually stored, tenant-wide read stays exactly as it already
  -- was, and only 'app'-sourced rows are writable by end users (enforced
  -- below) - Google is the sole source of truth for 'google_personal'
  -- rows, written only by the sync Edge Functions (service role, which
  -- bypasses RLS entirely).
  add column source text not null default 'app' check (source in ('app', 'google_personal')),
  add column owner_profile_id uuid references public.profiles (id),
  -- Which connection's Google Calendar this event is synced to - needed
  -- because google_calendar_id alone doesn't say whose stored credentials
  -- to use for the API call, and because reassigning a job to a different
  -- technician means deleting from the old connection's calendar and
  -- recreating in the new one, not just PATCHing.
  add column google_calendar_connection_id uuid references public.google_calendar_connections (id) on delete set null;

create index calendar_events_owner_profile_id_idx on public.calendar_events (owner_profile_id);
create index calendar_events_google_calendar_connection_id_idx on public.calendar_events (google_calendar_connection_id);

-- Tighten writes: only 'app'-sourced rows are writable by an ordinary
-- authenticated user. Letting an admin's blanket is_admin() update/delete
-- reach into a 'google_personal' row would corrupt data that Google
-- overwrites again on the next sync anyway.
drop policy "calendar_events: admin creates" on public.calendar_events;
create policy "calendar_events: admin creates" on public.calendar_events
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin() and source = 'app');

drop policy "calendar_events: admin or linked assignee updates" on public.calendar_events;
create policy "calendar_events: admin or linked assignee updates" on public.calendar_events
  for update using (
    tenant_id = public.current_tenant_id()
    and source = 'app'
    and (
      public.is_admin()
      or exists (
        select 1 from public.job_cards jc
        where jc.id = calendar_events.job_card_id and jc.assigned_technician_id = auth.uid()
      )
      or exists (
        select 1 from public.tasks t
        where t.id = calendar_events.task_id and t.assigned_to = auth.uid()
      )
    )
  );

drop policy "calendar_events: admin deletes" on public.calendar_events;
create policy "calendar_events: admin deletes" on public.calendar_events
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin() and source = 'app');

-- ---------------------------------------------------------------------------
-- calendar_event_personal_details - the REAL title/description/location/
-- guests of a 'google_personal' calendar_events row, split into its own
-- table with a plain "owner reads own" RLS policy, instead of redacting
-- columns in a view. This was a deliberate design change from an earlier
-- draft that tried a redacting view over calendar_events plus a REVOKE of
-- base-table SELECT: verified empirically (spun up a real Postgres 16
-- instance and tested it) that revoking base-table SELECT from
-- `authenticated` breaks ordinary UPDATE/DELETE/INSERT...RETURNING too,
-- since Postgres needs SELECT privilege to evaluate a WHERE clause or
-- return affected rows - it would have broken the app's own write path,
-- not just closed the intended read gap. This table sidesteps that
-- entirely: calendar_events' own grants/RLS are completely unchanged from
-- before this migration (still plain tenant-wide read), so no existing
-- read or write call site anywhere in either app breaks. A profile only
-- ever queries this table for their OWN calendar (RLS scopes every
-- unfiltered `select *` to just their own rows), then merges the real
-- title/description back in client-side for events they own; everyone
-- else's personal events show only whatever calendar_events itself
-- literally contains, which is always the 'Busy' placeholder.
-- ---------------------------------------------------------------------------

create table public.calendar_event_personal_details (
  calendar_event_id uuid primary key references public.calendar_events (id) on delete cascade,
  owner_profile_id uuid not null references public.profiles (id),
  title text not null,
  description text,
  location text,
  guests text,
  created_at timestamptz not null default now()
);

create index calendar_event_personal_details_owner_profile_id_idx
  on public.calendar_event_personal_details (owner_profile_id);

alter table public.calendar_event_personal_details enable row level security;

create policy "calendar_event_personal_details: owner reads own" on public.calendar_event_personal_details
  for select using (owner_profile_id = auth.uid());

-- No insert/update/delete policies - only the sync Edge Functions (service
-- role) ever write here, same lockdown shape as google_calendar_connections.

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Self-serve, not admin-gated - unlike Xero, any tenant member connects
-- their own account, so this reports the CALLING user's own connection.
create or replace function public.get_google_calendar_connection_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection public.google_calendar_connections;
begin
  select * into v_connection from public.google_calendar_connections where profile_id = auth.uid();
  if v_connection.id is null then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object(
    'connected', true,
    'email', v_connection.google_account_email,
    'connected_at', v_connection.connected_at
  );
end;
$$;

-- Admin-visible roster of which tenant members have connected Google
-- Calendar - email + connected_at only, never tokens. Lets an admin see at
-- a glance who still needs to connect, without granting any access to
-- credentials.
create or replace function public.list_google_calendar_connections()
returns table (profile_id uuid, full_name text, email text, google_account_email text, connected_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list Google Calendar connections';
  end if;
  return query
    select p.id, p.full_name, p.email, c.google_account_email, c.connected_at
    from public.profiles p
    left join public.google_calendar_connections c on c.profile_id = p.id
    where p.tenant_id = public.current_tenant_id()
    order by p.full_name;
end;
$$;

revoke execute on function public.get_google_calendar_connection_status() from public;
revoke execute on function public.list_google_calendar_connections() from public;
grant execute on function public.get_google_calendar_connection_status() to authenticated;
grant execute on function public.list_google_calendar_connections() to authenticated;
