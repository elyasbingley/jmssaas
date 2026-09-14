-- Channels: Facebook Messenger, live via a per-tenant OAuth "Connect" flow
-- (facebook-oauth-start/facebook-oauth-callback, a straight port of
-- xero-oauth-start/xero-oauth-callback's pattern - see that migration's own
-- comment for the shape this follows).
--
-- Unlike Twilio (a platform account this app's own operator controls),
-- Messenger requires each tenant to grant this app access to THEIR OWN
-- Facebook Page - hence the OAuth dance per tenant, same reason Xero needs
-- one per tenant.
--
-- facebook_connections holds the resulting Page Access Token - a real
-- bearer credential - so it gets the exact same lockdown as xero_connections:
-- RLS enabled with zero grants to anon/authenticated, service-role only.
-- The desktop/mobile app never touches it directly, only the
-- get_facebook_connection_status()/disconnect_facebook() SECURITY DEFINER
-- RPCs below, which never return the token itself.
create table public.facebook_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) unique,
  page_id text not null unique,
  page_name text,
  page_access_token text not null,
  connected_by uuid references public.profiles (id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_facebook_connections_updated_at
  before update on public.facebook_connections
  for each row execute function public.set_updated_at();

alter table public.facebook_connections enable row level security;

-- Same short-lived CSRF-protection role as xero_oauth_states: created by
-- facebook-oauth-start (authenticated), consumed by facebook-oauth-callback
-- (public, reached by Facebook's own redirect with no session) to recover
-- which tenant this connection belongs to.
create table public.facebook_oauth_states (
  state text primary key,
  tenant_id uuid not null references public.tenants (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.facebook_oauth_states enable row level security;

create or replace function public.get_facebook_connection_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.current_tenant_id();
  v_connection public.facebook_connections;
begin
  select * into v_connection from public.facebook_connections where tenant_id = v_tenant_id;
  if v_connection.id is null then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object(
    'connected', true,
    'page_name', v_connection.page_name,
    'connected_at', v_connection.connected_at
  );
end;
$$;

create or replace function public.disconnect_facebook()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.current_tenant_id();
begin
  if not public.is_admin() then
    raise exception 'Only an admin can disconnect Messenger';
  end if;
  delete from public.facebook_connections where tenant_id = v_tenant_id;
  update public.channel_connections
    set status = 'not_connected', config = '{}'::jsonb, connected_at = null
    where tenant_id = v_tenant_id and channel_type = 'messenger';
end;
$$;

revoke execute on function public.get_facebook_connection_status() from public;
revoke execute on function public.disconnect_facebook() from public;
grant execute on function public.get_facebook_connection_status() to authenticated;
grant execute on function public.disconnect_facebook() to authenticated;
