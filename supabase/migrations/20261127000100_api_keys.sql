-- JMS API keys: for outside tools (Nebula and the like) to work with JMS
-- through the jms-api function - REST with an OpenAPI spec, and MCP.
--
-- An admin creates a key in Settings > API keys and ticks what it may do:
--   read      look up clients, jobs, quotes, invoices, the price book, the
--             team and who's booked when
--   jobs      create jobs and book them (date, time, technician)
--   notes     add job notes
--   quotes    create draft quotes (never sent - that's done in JMS)
--   messages  text and email clients (logged in Channels, STOP respected)
-- No key can take payments or delete anything.
--
-- Only a SHA-256 hash of the key is stored; the key itself is shown once,
-- when it's created. Every call is logged (api_request_log) and a key can
-- be revoked at any time. Work a key does is recorded as done by the admin
-- who created it.
--
-- Also here: a job counts as booked once it's on the calendar. JMS books
-- jobs as calendar events (Dispatch, a job's "Add to calendar") rather than
-- job_cards.scheduled_at, so the follow-up "a job is booked" stop rule and
-- recurring visits' skip rule now look at both. (Functions written out in
-- full - see the asset_register migration on why.)

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{read}'
    check (scopes <@ array['read', 'jobs', 'notes', 'quotes', 'messages']::text[] and cardinality(scopes) > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_tenant_idx on public.api_keys (tenant_id);

alter table public.api_keys enable row level security;
-- Admins see their company's keys (never the key itself, only its hash).
-- Created and revoked through the functions below.
create policy "api_keys: admin read" on public.api_keys
  for select using (tenant_id = public.current_tenant_id() and public.is_admin());

create table public.api_request_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  api_key_id uuid references public.api_keys (id) on delete set null,
  action text not null,
  via text not null check (via in ('rest', 'mcp')),
  ok boolean not null,
  status int not null,
  summary text,
  created_at timestamptz not null default now()
);

create index api_request_log_key_idx on public.api_request_log (api_key_id, created_at desc);
create index api_request_log_tenant_idx on public.api_request_log (tenant_id, created_at desc);

alter table public.api_request_log enable row level security;
create policy "api_request_log: admin read" on public.api_request_log
  for select using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Creates a key and returns it - the only time it's ever shown.
create or replace function public.create_api_key(p_name text, p_scopes text[])
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_key text;
  v_id uuid;
begin
  if v_tenant is null or not public.is_admin() then
    raise exception 'Only an admin can create API keys';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'Give the key a name, e.g. Nebula';
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0 then
    raise exception 'Tick at least one thing the key can do';
  end if;
  if not (p_scopes <@ array['read', 'jobs', 'notes', 'quotes', 'messages']::text[]) then
    raise exception 'Unknown permission';
  end if;
  v_key := 'jms_' || encode(gen_random_bytes(24), 'hex');
  insert into public.api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by)
  values (v_tenant, btrim(p_name), left(v_key, 12), encode(digest(v_key, 'sha256'), 'hex'),
          (select array_agg(distinct s order by s) from unnest(p_scopes) s), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_key);
end;
$$;

revoke execute on function public.create_api_key(text, text[]) from public, anon;
grant execute on function public.create_api_key(text, text[]) to authenticated;

create or replace function public.revoke_api_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can revoke API keys';
  end if;
  update public.api_keys set revoked_at = now()
  where id = p_id and tenant_id = public.current_tenant_id() and revoked_at is null;
end;
$$;

revoke execute on function public.revoke_api_key(uuid) from public, anon;
grant execute on function public.revoke_api_key(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Booked = on the calendar (or scheduled_at set)
-- ---------------------------------------------------------------------------

create or replace function public.job_is_booked(p_job_card_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.job_cards where id = p_job_card_id and scheduled_at is not null)
      or exists (select 1 from public.calendar_events where job_card_id = p_job_card_id)
$$;

grant execute on function public.job_is_booked(uuid) to authenticated;

create or replace function public.follow_up_booked_jobs(p_client_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(j.id), '{}')
  from public.job_cards j
  left join public.job_lifecycle_stages s on s.id = j.lifecycle_stage_id
  where j.client_id = p_client_id
    and (
      j.scheduled_at is not null
      or exists (select 1 from public.calendar_events ce where ce.job_card_id = j.id)
      or (
        j.recurring_service_id is null
        and s.position > (select min(position) from public.job_lifecycle_stages f where f.tenant_id = j.tenant_id)
      )
    )
$$;

revoke execute on function public.follow_up_booked_jobs(uuid) from public, anon, authenticated;

create or replace function public.recurring_skip_visit(p_job_card_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.job_cards;
begin
  select * into j from public.job_cards where id = p_job_card_id;
  if j.id is null or j.tenant_id <> public.current_tenant_id() or not public.is_admin() then
    raise exception 'Only an admin can skip a visit';
  end if;
  if j.recurring_service_id is null then
    raise exception 'This job isn''t a recurring visit';
  end if;
  if public.job_is_booked(j.id) then
    raise exception 'This visit is already booked - take it off the calendar first, or just delete the job';
  end if;
  if exists (select 1 from public.invoices where job_card_id = j.id and status <> 'draft') then
    raise exception 'This visit has an invoice that has been sent - it can''t be skipped';
  end if;
  if exists (select 1 from public.payments where job_card_id = j.id) then
    raise exception 'This visit has a payment against it - it can''t be skipped';
  end if;
  update public.follow_up_enrolments set status = 'stopped', stop_reason = 'manual', stopped_at = now()
  where job_card_id = j.id and status = 'active';
  delete from public.invoices where job_card_id = j.id and status = 'draft';
  delete from public.job_cards where id = j.id;
end;
$$;

revoke execute on function public.recurring_skip_visit(uuid) from public, anon;
grant execute on function public.recurring_skip_visit(uuid) to authenticated;
