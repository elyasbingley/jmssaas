-- Recurring jobs: ongoing service work (gutter cleans, backflow tests,
-- filter changes - any service) set up from a job with "Make this
-- recurring".
--
-- A recurring service remembers the client, address, title, description,
-- category and line items of the job it was made from, plus how often it
-- repeats (every N weeks or months, counted from each due date so a late
-- visit doesn't push the schedule out) and when the next one is due.
--
-- Lead time (4 weeks by default) before each due date, recurring_jobs_
-- generate() - run by process-follow-ups on every sweep - creates the next
-- job:
--   * in a "To book" stage (created after the first stage if missing);
--   * with a draft invoice carrying the saved line items, so it's ready to
--     send once done (drafts never go to Xero);
--   * with an optional confirm text to the client (follow-up sequence
--     "recurring_confirm", off until switched on) - replies land in
--     Channels for the office to book;
-- and the office is notified. Prices stay as saved until changed on the
-- recurring service.
--
-- A recurring service can look after an asset's service (asset register):
-- completing the job ticks that service off, and the asset's own "service
-- due" text is skipped so the client isn't texted twice.
--
-- "Skip this visit" removes an unbooked visit (job and draft invoice); the
-- next one still comes round on schedule.
--
-- Functions changed here are written out in full - patching a stored
-- function's text by find-and-replace fails on databases whose migrations
-- were pushed with Windows line endings.

create table public.recurring_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  site_id uuid references public.client_sites (id) on delete set null,
  is_real_estate_job boolean not null default false,
  agency_id uuid references public.agencies (id) on delete set null,
  property_manager_id uuid references public.property_managers (id) on delete set null,
  property_id uuid references public.properties (id) on delete set null,
  source_job_id uuid references public.job_cards (id) on delete set null,
  title text not null check (btrim(title) <> ''),
  description text,
  service_category_id uuid references public.service_categories (id) on delete set null,
  interval_count int not null check (interval_count between 1 and 104),
  interval_unit text not null check (interval_unit in ('week', 'month')),
  next_due_on date not null,
  lead_days int not null default 28 check (lead_days between 0 and 365),
  -- Same shape replace_invoice_line_items takes (crew/materials included).
  line_items jsonb not null default '[]'::jsonb check (jsonb_typeof(line_items) = 'array'),
  asset_service_id uuid references public.asset_services (id) on delete set null,
  confirm_text boolean not null default true,
  status text not null default 'active' check (status in ('active', 'paused', 'stopped')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recurring_services_tenant_due_idx on public.recurring_services (tenant_id, status, next_due_on);
create index recurring_services_client_idx on public.recurring_services (client_id);
create index recurring_services_source_job_idx on public.recurring_services (source_job_id);
create trigger set_recurring_services_updated_at before update on public.recurring_services
  for each row execute function public.set_updated_at();

alter table public.recurring_services enable row level security;
create policy "recurring_services: tenant read" on public.recurring_services
  for select using (tenant_id = public.current_tenant_id());
create policy "recurring_services: admin insert" on public.recurring_services
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "recurring_services: admin update" on public.recurring_services
  for update using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "recurring_services: admin delete" on public.recurring_services
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.job_cards
  add column recurring_service_id uuid references public.recurring_services (id) on delete set null,
  add column recurring_due_on date;
-- One job per visit, however often the sweep runs.
create unique index job_cards_recurring_visit_idx on public.job_cards (recurring_service_id, recurring_due_on)
  where recurring_service_id is not null;

alter table public.tenants
  add column recurring_stage_id uuid references public.job_lifecycle_stages (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Dates
-- ---------------------------------------------------------------------------

create or replace function public.recurring_add_interval(p_day date, p_count int, p_unit text)
returns date
language sql
immutable
as $$
  select (p_day + case when p_unit = 'week' then make_interval(weeks => p_count) else make_interval(months => p_count) end)::date
$$;

-- ---------------------------------------------------------------------------
-- Line items to repeat: the job's latest invoice (not void), else its
-- accepted quote's included lines - the same source create_assets_from_job
-- uses. Runs with the caller's own access (the desktop reads it when
-- making a job recurring).
-- ---------------------------------------------------------------------------

create or replace function public.recurring_line_items_from_job(p_job_card_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with inv as (
    select i.id from public.invoices i
    where i.job_card_id = p_job_card_id and i.status <> 'void'
    order by i.created_at desc limit 1
  ),
  invoice_lines as (
    select li.sort_order,
      (to_jsonb(li) - 'id' - 'tenant_id' - 'invoice_id' - 'waived_amount_cents')
      || jsonb_build_object(
        'crew', coalesce((select jsonb_agg(to_jsonb(c) - 'id' - 'tenant_id' - 'invoice_line_item_id' order by c.sort_order) from public.invoice_line_item_crew c where c.invoice_line_item_id = li.id), '[]'::jsonb),
        'materials', coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'tenant_id' - 'invoice_line_item_id' order by m.sort_order) from public.invoice_line_item_materials m where m.invoice_line_item_id = li.id), '[]'::jsonb)
      ) as item
    from public.invoice_line_items li
    where li.invoice_id = (select id from inv)
  ),
  quote_lines as (
    select li.sort_order,
      (to_jsonb(li) - 'id' - 'tenant_id' - 'quote_id' - 'waived_amount_cents' - 'is_optional' - 'is_included' - 'option_id' - 'in_quote_total')
      || jsonb_build_object(
        'crew', coalesce((select jsonb_agg(to_jsonb(c) - 'id' - 'tenant_id' - 'quote_line_item_id' order by c.sort_order) from public.quote_line_item_crew c where c.quote_line_item_id = li.id), '[]'::jsonb),
        'materials', coalesce((select jsonb_agg(to_jsonb(m) - 'id' - 'tenant_id' - 'quote_line_item_id' order by m.sort_order) from public.quote_line_item_materials m where m.quote_line_item_id = li.id), '[]'::jsonb)
      ) as item
    from public.quote_line_items li
    join public.quotes q on q.id = li.quote_id
    where q.job_card_id = p_job_card_id and q.status = 'accepted' and li.is_included and coalesce(li.in_quote_total, true)
      and not exists (select 1 from inv)
  )
  select coalesce(jsonb_agg(item order by sort_order), '[]'::jsonb)
  from (select * from invoice_lines union all select * from quote_lines) x
$$;

grant execute on function public.recurring_line_items_from_job(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The "To book" stage new visits go into: kept on the tenant, found by
-- name, or created straight after the first stage.
-- ---------------------------------------------------------------------------

create or replace function public.recurring_ensure_stage(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_first int;
begin
  select s.id into v_id from public.tenants t join public.job_lifecycle_stages s on s.id = t.recurring_stage_id
  where t.id = p_tenant_id and s.tenant_id = p_tenant_id;
  if v_id is not null then
    return v_id;
  end if;
  select id into v_id from public.job_lifecycle_stages
  where tenant_id = p_tenant_id and lower(btrim(name)) = 'to book' order by position limit 1;
  if v_id is null then
    select min(position) into v_first from public.job_lifecycle_stages where tenant_id = p_tenant_id;
    update public.job_lifecycle_stages set position = position + 1
    where tenant_id = p_tenant_id and position > coalesce(v_first, 0);
    insert into public.job_lifecycle_stages (tenant_id, name, position, color, is_closed)
    values (p_tenant_id, 'To book', coalesce(v_first, 0) + 1, '#f59e0b', false)
    returning id into v_id;
  end if;
  update public.tenants set recurring_stage_id = v_id where id = p_tenant_id;
  return v_id;
end;
$$;

revoke execute on function public.recurring_ensure_stage(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- One visit: the job, its draft invoice and the confirm text.
-- ---------------------------------------------------------------------------

create or replace function public.recurring_create_job(p_service_id uuid, p_due date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.recurring_services;
  c public.clients;
  v_job uuid;
  v_invoice uuid;
  v_address text;
  v_service text;
begin
  select * into s from public.recurring_services where id = p_service_id;
  if s.id is null then
    return null;
  end if;
  select id into v_job from public.job_cards where recurring_service_id = s.id and recurring_due_on = p_due;
  if v_job is not null then
    return v_job;
  end if;
  select * into c from public.clients where id = s.client_id;

  insert into public.job_cards (
    tenant_id, client_id, site_id, title, description, service_category_id, lifecycle_stage_id,
    is_real_estate_job, agency_id, property_manager_id, property_id, created_by,
    recurring_service_id, recurring_due_on
  ) values (
    s.tenant_id, s.client_id, s.site_id, s.title, s.description, s.service_category_id, public.recurring_ensure_stage(s.tenant_id),
    s.is_real_estate_job, s.agency_id, s.property_manager_id, s.property_id, s.created_by,
    s.id, p_due
  )
  returning id into v_job;

  if jsonb_array_length(s.line_items) > 0 then
    insert into public.invoices (tenant_id, client_id, job_card_id, site_id, status, issue_date, created_by)
    values (s.tenant_id, s.client_id, v_job, s.site_id, 'draft', p_due, s.created_by)
    returning id into v_invoice;
    perform public.replace_invoice_line_items(v_invoice, s.line_items);
  end if;

  -- Agency properties are booked through the property manager, not texted.
  if s.confirm_text and s.property_id is null and not coalesce(s.is_real_estate_job, false) and c.phone is not null then
    v_address := coalesce(
      (select nullif(concat_ws(', ', nullif(btrim(cs.address_line1), ''), nullif(btrim(cs.suburb), '')), '') from public.client_sites cs where cs.id = s.site_id),
      nullif(concat_ws(', ', nullif(btrim(c.address_line1), ''), nullif(btrim(c.suburb), '')), ''),
      'your place');
    v_service := case when s.title ~ '^[A-Z][a-z]' then lower(left(s.title, 1)) || substr(s.title, 2) else s.title end;
    perform public.follow_up_enrol(s.tenant_id, 'recurring_confirm', c.phone, c.id, v_job, null, null,
      jsonb_build_object('first_name', public.follow_up_first_name(c), 'service', v_service, 'address', v_address,
                         'due_date', to_char(p_due, 'FMDD FMMonth')));
  end if;
  return v_job;
end;
$$;

revoke execute on function public.recurring_create_job(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The sweep: every active service whose next visit is within its lead
-- time gets that visit's job, and moves on to the following due date. A
-- service that fell well behind (paused for a while) catches up to its
-- latest due date rather than creating every missed visit. Returns the
-- new jobs so process-follow-ups can tell the office.
-- ---------------------------------------------------------------------------

create or replace function public.recurring_jobs_generate()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_today date := (now() at time zone 'Australia/Sydney')::date;
  v_due date;
  v_job uuid;
  v_new jsonb := '[]'::jsonb;
  v_rounds int;
begin
  for s in
    select rs.* from public.recurring_services rs
    join public.clients c on c.id = rs.client_id
    where rs.status = 'active' and rs.next_due_on - rs.lead_days <= v_today
    order by rs.next_due_on
    for update of rs skip locked
  loop
    v_due := s.next_due_on;
    while public.recurring_add_interval(v_due, s.interval_count, s.interval_unit) <= v_today loop
      v_due := public.recurring_add_interval(v_due, s.interval_count, s.interval_unit);
    end loop;
    v_rounds := 0;
    -- A weekly service with four weeks' lead gets each visit in that window.
    while v_due - s.lead_days <= v_today and v_rounds < 12 loop
      v_rounds := v_rounds + 1;
      begin
        if not exists (select 1 from public.job_cards where recurring_service_id = s.id and recurring_due_on = v_due) then
          v_job := public.recurring_create_job(s.id, v_due);
          v_new := v_new || jsonb_build_object('tenant_id', s.tenant_id, 'job_card_id', v_job, 'title', s.title,
            'client', (select name from public.clients where id = s.client_id), 'due_on', v_due);
        end if;
      exception when others then
        raise warning 'recurring_jobs_generate: service % visit % failed: %', s.id, v_due, sqlerrm;
        exit;
      end;
      v_due := public.recurring_add_interval(v_due, s.interval_count, s.interval_unit);
    end loop;
    update public.recurring_services set next_due_on = v_due where id = s.id and next_due_on < v_due;
  end loop;
  return v_new;
end;
$$;

revoke execute on function public.recurring_jobs_generate() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Skip a visit (admin): removes the unbooked job and its draft invoice and
-- stops its confirm text. The schedule carries on.
-- ---------------------------------------------------------------------------

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
  if j.scheduled_at is not null then
    raise exception 'This visit is already booked - unbook it first, or just delete the job';
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

-- ---------------------------------------------------------------------------
-- Asset register: completing a visit ticks off the asset service it looks
-- after (which moves that service's next due date on).
-- ---------------------------------------------------------------------------

create or replace function public.recurring_tick_asset_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.asset_services;
begin
  if new.recurring_service_id is null or new.lifecycle_stage_id is not distinct from old.lifecycle_stage_id then
    return new;
  end if;
  if not exists (select 1 from public.job_lifecycle_stages where id = new.lifecycle_stage_id and is_closed)
     or exists (select 1 from public.job_lifecycle_stages where id = old.lifecycle_stage_id and is_closed) then
    return new;
  end if;
  begin
    select s.* into v_service from public.asset_services s
    join public.recurring_services rs on rs.asset_service_id = s.id
    join public.property_assets a on a.id = s.asset_id and a.status = 'active'
    where rs.id = new.recurring_service_id;
    if v_service.id is not null and not exists (
      select 1 from public.asset_service_records where job_card_id = new.id and service_id = v_service.id
    ) then
      insert into public.asset_service_records (tenant_id, asset_id, service_id, job_card_id, done_on, done_by)
      values (new.tenant_id, v_service.asset_id, v_service.id, new.id,
              (coalesce(new.completed_at, now()) at time zone 'Australia/Sydney')::date, new.assigned_technician_id);
    end if;
  exception when others then
    -- Never stop a job being completed.
    raise warning 'recurring_tick_asset_service: job %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger recurring_tick_asset_service
  after update of lifecycle_stage_id on public.job_cards
  for each row execute function public.recurring_tick_asset_service();

-- ---------------------------------------------------------------------------
-- Follow-ups: the confirm text
-- ---------------------------------------------------------------------------

alter table public.follow_up_sequences drop constraint follow_up_sequences_key_check;
alter table public.follow_up_sequences add constraint follow_up_sequences_key_check
  check (key in ('storm_checklist', 'storm_morning', 'quote_quiet', 'asset_service', 'asset_replacement', 'recurring_confirm'));

create or replace function public.seed_recurring_confirm_sequence(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq uuid;
begin
  if not exists (select 1 from public.follow_up_sequences where tenant_id = p_tenant_id and key = 'recurring_confirm') then
    insert into public.follow_up_sequences (tenant_id, key, name) values (p_tenant_id, 'recurring_confirm', 'Recurring job due') returning id into v_seq;
    insert into public.follow_up_steps (tenant_id, sequence_id, position, day_offset, label, body) values
      (p_tenant_id, v_seq, 0, 0, 'Booking check',
       'Hi {first_name}, Elyas here. Your {service} at {address} is due around {due_date}. Does that suit? Reply with a day that works and I''ll book you in. Reply STOP to opt out');
  end if;
end;
$$;

revoke execute on function public.seed_recurring_confirm_sequence(uuid) from public, anon, authenticated;
select public.seed_recurring_confirm_sequence(id) from public.tenants;

create or replace function public.seed_recurring_confirm_on_tenant_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_recurring_confirm_sequence(new.id);
  return new;
end;
$$;

-- Named to run after the follow-up sequences' own seeding trigger.
create trigger seed_follow_up_sequences_on_tenant_insert_z_recurring
  after insert on public.tenants
  for each row execute function public.seed_recurring_confirm_on_tenant_insert();

-- A new visit sitting in "To book" isn't a booking: only once it's given a
-- time does it count (so it doesn't stop the client's other follow-ups).
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
      or (
        j.recurring_service_id is null
        and s.position > (select min(position) from public.job_lifecycle_stages f where f.tenant_id = j.tenant_id)
      )
    )
$$;

revoke execute on function public.follow_up_booked_jobs(uuid) from public, anon, authenticated;

-- Each recurring visit has its own guard (one job per due date), and a
-- client can have several services, so the confirm text is exempt from
-- one-active-run-per-mobile like quotes and asset reminders.
create or replace function public.follow_up_enrol(
  p_tenant_id uuid,
  p_key text,
  p_phone text,
  p_client_id uuid,
  p_job_card_id uuid,
  p_quote_id uuid,
  p_email text,
  p_vars jsonb,
  p_anchor timestamptz default now(),
  p_force_test boolean default false,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq public.follow_up_sequences;
  v_phone text := public.au_mobile_e164(p_phone);
  v_test boolean;
  v_test_numbers text[];
  v_first_day int;
  v_id uuid;
begin
  if v_phone is null then
    return null;
  end if;
  select * into v_seq from public.follow_up_sequences where tenant_id = p_tenant_id and key = p_key;
  if v_seq.id is null then
    return null;
  end if;
  select follow_up_test_numbers into v_test_numbers from public.tenants where id = p_tenant_id;
  v_test := p_force_test or v_phone = any (coalesce(v_test_numbers, '{}'));
  if not (v_seq.enabled or v_test) then
    return null;
  end if;
  if not v_test and p_client_id is not null and exists (select 1 from public.clients where id = p_client_id and marketing_opt_out) then
    return null;
  end if;
  if not v_test and exists (
    select 1 from public.follow_up_enrolments
    where sequence_id = v_seq.id and status = 'active' and phone = v_phone and p_key not in ('quote_quiet', 'asset_service', 'asset_replacement', 'recurring_confirm')
  ) then
    return null;
  end if;

  select day_offset into v_first_day from public.follow_up_steps where sequence_id = v_seq.id order by position limit 1;

  insert into public.follow_up_enrolments (
    tenant_id, sequence_id, client_id, job_card_id, quote_id, phone, email, vars, is_test,
    enrolled_at, next_due_at, booked_baseline, created_by
  ) values (
    p_tenant_id, v_seq.id, p_client_id, p_job_card_id, p_quote_id, v_phone, nullif(btrim(coalesce(p_email, '')), ''),
    coalesce(p_vars, '{}'::jsonb), v_test, p_anchor,
    case when coalesce(v_first_day, 0) = 0 then p_anchor else public.follow_up_due_at(p_anchor, v_first_day) end,
    case when p_client_id is null then '{}' else public.follow_up_booked_jobs(p_client_id) end,
    p_created_by
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Asset services looked after by a recurring job are left to that job's
-- confirm text.
create or replace function public.asset_reminders_enrol()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  r record;
  v_today date := (now() at time zone 'Australia/Sydney')::date;
  v_enrolment uuid;
  v_services int := 0;
  v_replacements int := 0;
begin
  for g in
    with due as (
      select a.tenant_id, a.client_id, a.site_id, a.id as asset_id, s.id as service_id,
        c.phone, public.follow_up_first_name(c) as first_name,
        public.asset_label(a) || ' (' || lower(s.name) || ')' as item,
        public.asset_address(a) as address
      from public.asset_services s
      join public.property_assets a on a.id = s.asset_id
      join public.clients c on c.id = a.client_id
      left join public.asset_types t on t.id = a.asset_type_id
      where a.status = 'active' and a.client_id is not null and not coalesce(c.marketing_opt_out, false)
        and s.next_due_on is not null
        and s.next_due_on between v_today - 7 and v_today + coalesce(t.lead_days, 28)
        and s.reminded_for is distinct from s.next_due_on
        -- A service a recurring job looks after gets its own confirm text.
        and not exists (select 1 from public.recurring_services rs where rs.asset_service_id = s.id and rs.status = 'active')
    )
    select tenant_id, client_id, site_id, min(phone) as phone, min(first_name) as first_name, min(address) as address,
      array_agg(service_id) as service_ids, array_agg(distinct item order by item) as items
    from due
    group by tenant_id, client_id, site_id
  loop
    v_enrolment := public.follow_up_enrol(g.tenant_id, 'asset_service', g.phone, g.client_id, null, null, null,
      jsonb_build_object('first_name', g.first_name, 'items', public.join_and(g.items), 'address', g.address));
    if v_enrolment is not null then
      update public.asset_services set reminded_for = next_due_on where id = any (g.service_ids);
      v_services := v_services + 1;
    end if;
  end loop;

  for r in
    select a.id, a.tenant_id, a.client_id, c.phone, public.follow_up_first_name(c) as first_name,
      public.asset_label(a) as item, public.asset_address(a) as address,
      floor(extract(epoch from age(v_today, public.asset_installed_date(a.installed_on, a.install_year))) / (365.25 * 86400))::int as age_years
    from public.property_assets a
    join public.asset_types t on t.id = a.asset_type_id
    join public.clients c on c.id = a.client_id
    where a.status = 'active' and a.client_id is not null and a.replacement_reminded_at is null
      and not coalesce(c.marketing_opt_out, false)
      and t.replace_after_years is not null
      and public.asset_installed_date(a.installed_on, a.install_year) is not null
      and (public.asset_installed_date(a.installed_on, a.install_year) + make_interval(months => public.years_to_months(t.replace_after_years)))::date - t.lead_days <= v_today
  loop
    v_enrolment := public.follow_up_enrol(r.tenant_id, 'asset_replacement', r.phone, r.client_id, null, null, null,
      jsonb_build_object('first_name', r.first_name, 'item', r.item, 'address', r.address, 'age', r.age_years::text));
    if v_enrolment is not null then
      update public.property_assets set replacement_reminded_at = now() where id = r.id;
      v_replacements := v_replacements + 1;
    end if;
  end loop;

  return jsonb_build_object('service', v_services, 'replacement', v_replacements);
end;
$$;

revoke execute on function public.asset_reminders_enrol() from public, anon, authenticated;

-- Test runs need sample recurring details too.
create or replace function public.start_follow_up_test(p_key text, p_phone text, p_suburb text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
  v_phone text := public.au_mobile_e164(p_phone);
  v_name text;
  v_id uuid;
begin
  if v_phone is null then
    raise exception 'Enter your mobile number to test with';
  end if;
  if not v_phone = any (coalesce((select t.follow_up_test_numbers from public.tenants t where t.id = v_tenant), '{}'::text[])) then
    raise exception 'Add % as a test number first', p_phone;
  end if;
  select split_part(btrim(full_name), ' ', 1) into v_name from public.profiles where id = auth.uid();
  v_id := public.follow_up_enrol(
    v_tenant, p_key, v_phone, null, null, null, (select email from public.profiles where id = auth.uid()),
    jsonb_build_object('first_name', coalesce(nullif(v_name, ''), 'there'), 'suburb', coalesce(nullif(btrim(p_suburb), ''), 'Blacktown'),
                       'job', 'roof leak repair', 'quote_total', '$650.00',
                       'items', 'hot water system (relief valve check) and gutters (gutter clean)', 'address', '4 Sample St, Blacktown',
                       'item', 'hot water system', 'age', '11',
                       'service', 'gutter clean', 'due_date', to_char((now() at time zone 'Australia/Sydney')::date + 28, 'FMDD FMMonth')),
    now(), true, auth.uid()
  );
  return v_id;
end;
$$;

-- PowerSync: phones don't sync recurring services; the new job_cards
-- columns travel with job_cards as usual.
