-- Xero integration, Phase 1 (one-way push: this app -> Xero). Deliberately
-- not a two-way sync yet - see xero-sync Edge Function's own comment for
-- why that's staged separately (Phase 2, once this is proven reliable
-- against a real Xero org).
--
-- xero_connections holds the OAuth2 tokens for a tenant's connected Xero
-- organisation. These are real bearer credentials for real accounting
-- data - deliberately given NO RLS policies at all (RLS is enabled with
-- zero grants to anon/authenticated), so only the service role (Edge
-- Functions) can ever read/write this table directly. The desktop app
-- never touches it directly - it only ever calls the SECURITY DEFINER
-- RPCs below, which return connection status/org name but never the
-- tokens themselves.
create table public.xero_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) unique,
  xero_tenant_id text not null,
  xero_org_name text,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  connected_by uuid references public.profiles (id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_xero_connections_updated_at
  before update on public.xero_connections
  for each row execute function public.set_updated_at();

alter table public.xero_connections enable row level security;

-- Short-lived CSRF-protection rows for the OAuth handshake: xero-oauth-start
-- (authenticated) creates one, xero-oauth-callback (public, reached by
-- Xero's own redirect with no session) consumes it to recover which
-- tenant initiated the connection. Same "no RLS grants, service-role only"
-- lockdown as xero_connections - a forged state value should never be
-- guessable, but there's no reason to expose this table to clients at all.
create table public.xero_oauth_states (
  state text primary key,
  tenant_id uuid not null references public.tenants (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.xero_oauth_states enable row level security;

-- Client <-> Xero Contact / Invoice <-> Xero Invoice mapping. Nullable:
-- unsynced rows just have no Xero counterpart yet. xero_sync_error holds
-- the last push failure's message (e.g. a Xero validation error) so the
-- UI can show *why* a sync failed, cleared back to null on the next
-- successful sync.
alter table public.clients
  add column xero_contact_id text;

alter table public.invoices
  add column xero_invoice_id text,
  add column xero_synced_at timestamptz,
  add column xero_sync_error text;

-- Which Xero chart-of-accounts code sales line items post against -
-- varies per business/chart of accounts, so this is admin-configurable
-- from Company Settings rather than hardcoded. Defaults to '200', Xero's
-- standard default "Sales" code for an AU organisation's default chart -
-- a reasonable starting point, not a guarantee it matches this tenant's
-- actual chart (they're told to check/change it in Company Settings).
alter table public.tenants
  add column xero_sales_account_code text not null default '200';

create or replace function public.get_xero_connection_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.current_tenant_id();
  v_connection public.xero_connections;
begin
  select * into v_connection from public.xero_connections where tenant_id = v_tenant_id;
  if v_connection.id is null then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object(
    'connected', true,
    'org_name', v_connection.xero_org_name,
    'connected_at', v_connection.connected_at
  );
end;
$$;

create or replace function public.disconnect_xero()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can disconnect Xero';
  end if;
  delete from public.xero_connections where tenant_id = public.current_tenant_id();
end;
$$;

revoke execute on function public.get_xero_connection_status() from public;
revoke execute on function public.disconnect_xero() from public;
grant execute on function public.get_xero_connection_status() to authenticated;
grant execute on function public.disconnect_xero() to authenticated;
