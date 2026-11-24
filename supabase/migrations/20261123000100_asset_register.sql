-- Asset register for every client (not just real estate properties).
--
-- property_assets already held assets for agency properties and, since the
-- client_assets migration, for direct clients. This turns it into a proper
-- register:
--
--   asset_types            types you manage in Settings (hot water, roof,
--                          gutters, backflow...), each with its own fields,
--                          default warranties, service plan, "replace
--                          around" age and reminder lead time
--   property_assets        + type, site address, install date, location,
--                          status (active / removed), where it came from
--   asset_warranties       manufacturer and workmanship warranties
--   asset_services         several services per asset, each with its own
--                          interval, last done and next due
--   asset_service_records  the history: a service ticked off on a job
--   asset_files            photos (data plate) and documents
--   asset_warranty_claims  claims lodged against a warranty
--
-- Assets also come in automatically: a price book item marked "creates an
-- asset" adds one to the client when the job is completed
-- (create_assets_from_job).
--
-- Reminders: the Due lists live on the desktop. The optional texts reuse the
-- Follow-ups engine (sequences asset_service / asset_replacement, off until
-- switched on) - asset_reminders_enrol queues them, process-follow-ups sends
-- them inside 8:30am-6pm with the same stop rules. Agency properties keep
-- reminding the property manager (process-real-estate-maintenance), now
-- from the service plans instead of the old gutter-clean fields.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.try_date(p text)
returns date
language plpgsql
immutable
as $$
begin
  if p is null or btrim(p) = '' then
    return null;
  end if;
  return p::date;
exception when others then
  return null;
end;
$$;

-- Months, from a number of years that may be fractional (0.25 = 3 months).
create or replace function public.years_to_months(p numeric)
returns int
language sql
immutable
as $$
  select round(coalesce(p, 0) * 12)::int
$$;

-- ---------------------------------------------------------------------------
-- Asset types
-- ---------------------------------------------------------------------------

create table public.asset_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  icon text,
  -- The older 4-way grouping (plumbing / roofing / hvac / general) that
  -- reports and the property screens still group by.
  category public.property_asset_category not null default 'general',
  -- [{key, label, type: text|number|date|select, options?: [..]}]
  fields jsonb not null default '[]'::jsonb,
  -- [{name, interval_months}]
  default_services jsonb not null default '[]'::jsonb,
  -- [{kind: manufacturer|workmanship, label, years}]
  default_warranties jsonb not null default '[]'::jsonb,
  -- Flag for replacement this many years after it was installed.
  replace_after_years numeric(5, 2) check (replace_after_years is null or replace_after_years > 0),
  -- How far ahead services and replacements show as due (and get a text).
  lead_days int not null default 28 check (lead_days between 0 and 365),
  sort_order int not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index asset_types_tenant_idx on public.asset_types (tenant_id);
create trigger set_asset_types_updated_at before update on public.asset_types for each row execute function public.set_updated_at();
alter table public.asset_types enable row level security;
create policy "asset_types: tenant read" on public.asset_types for select using (tenant_id = public.current_tenant_id());
create policy "asset_types: admin insert" on public.asset_types for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "asset_types: admin update" on public.asset_types for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "asset_types: admin delete" on public.asset_types for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- The starting list. Every one of these can be edited, archived or added to
-- in Settings > Asset types.
create or replace function public.seed_asset_types(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.asset_types (tenant_id, name, icon, category, fields, default_services, default_warranties, replace_after_years, sort_order)
  select p_tenant_id, v.name, v.icon, v.category::public.property_asset_category, v.fields::jsonb, v.services::jsonb, v.warranties::jsonb, v.replace_years, v.sort_order
  from (values
    ('Hot water system', '🚿', 'plumbing',
     '[{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model","type":"text"},{"key":"serial_number","label":"Serial number","type":"text"},{"key":"fuel_type","label":"Type","type":"select","options":["Electric storage","Gas storage","Gas continuous flow","Heat pump","Solar"]},{"key":"capacity_litres","label":"Capacity (litres)","type":"number"}]',
     '[{"name":"Relief valve check","interval_months":12},{"name":"Anode inspection","interval_months":60}]',
     '[{"kind":"workmanship","label":"Workmanship","years":10}]', 10, 1),
    ('Roof', '🏠', 'roofing',
     '[{"key":"roof_type","label":"Roof type","type":"select","options":["Concrete tile","Terracotta tile","Colorbond / metal","Slate","Other"]},{"key":"colour","label":"Colour","type":"text"},{"key":"area_m2","label":"Area (m²)","type":"number"},{"key":"ridge_condition","label":"Ridge condition","type":"text"},{"key":"screw_condition","label":"Screw condition","type":"text"}]',
     '[{"name":"Roof inspection","interval_months":24}]', '[]', 25, 2),
    ('Gutters & downpipes', '🌧️', 'roofing',
     '[{"key":"material","label":"Material","type":"select","options":["Colorbond","Zincalume","PVC","Copper","Other"]},{"key":"colour","label":"Colour","type":"text"},{"key":"length_m","label":"Gutter length (m)","type":"number"},{"key":"gutter_guard","label":"Gutter guard","type":"select","options":["Yes","No"]}]',
     '[{"name":"Gutter clean","interval_months":12}]', '[]', 20, 3),
    ('Backflow device', '🔁', 'plumbing',
     '[{"key":"device_type","label":"Device type","type":"select","options":["RPZD","Testable double check (DCV)","Single check","Vacuum breaker","Other"]},{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model","type":"text"},{"key":"serial_number","label":"Serial number","type":"text"},{"key":"size_mm","label":"Size (mm)","type":"number"}]',
     '[{"name":"Annual backflow test","interval_months":12}]', '[]', null, 4),
    ('Pump', '⚙️', 'plumbing',
     '[{"key":"pump_type","label":"Pump type","type":"select","options":["Rainwater / pressure","Sewer / grey water","Stormwater / sump","Circulating","Other"]},{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model","type":"text"},{"key":"serial_number","label":"Serial number","type":"text"}]',
     '[{"name":"Pump service","interval_months":24}]', '[]', 10, 5),
    ('Rainwater tank', '🛢️', 'plumbing',
     '[{"key":"material","label":"Material","type":"select","options":["Poly","Colorbond / steel","Concrete","Other"]},{"key":"capacity_litres","label":"Capacity (litres)","type":"number"}]',
     '[{"name":"Tank and first-flush clean","interval_months":24}]', '[]', null, 6),
    ('Water filter', '💧', 'plumbing',
     '[{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model","type":"text"},{"key":"cartridge","label":"Cartridge","type":"text"}]',
     '[{"name":"Cartridge change","interval_months":12}]', '[]', null, 7),
    ('Tempering valve', '🌡️', 'plumbing',
     '[{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model","type":"text"}]',
     '[{"name":"Tempering valve service","interval_months":60}]', '[]', null, 8),
    ('Skylight', '☀️', 'roofing',
     '[{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model / size","type":"text"}]',
     '[{"name":"Skylight check","interval_months":24}]', '[]', 20, 9),
    ('Whirlybird / roof vent', '🌀', 'roofing',
     '[{"key":"brand","label":"Brand","type":"text"}]',
     '[{"name":"Vent check","interval_months":36}]', '[]', 15, 10),
    ('Solar panel bird-proofing', '🐦', 'roofing',
     '[{"key":"mesh","label":"Mesh","type":"text"}]',
     '[{"name":"Bird-proofing check","interval_months":24}]', '[]', null, 11),
    ('Air conditioning', '❄️', 'hvac',
     '[{"key":"brand","label":"Brand","type":"text"},{"key":"model","label":"Model","type":"text"},{"key":"serial_number","label":"Serial number","type":"text"}]',
     '[{"name":"Filter clean and service","interval_months":12}]', '[]', 15, 12),
    ('Other', '🔧', 'general', '[]', '[]', '[]', null, 99)
  ) as v(name, icon, category, fields, services, warranties, replace_years, sort_order)
  where not exists (select 1 from public.asset_types t where t.tenant_id = p_tenant_id and lower(t.name) = lower(v.name));
end;
$$;

revoke execute on function public.seed_asset_types(uuid) from public, anon, authenticated;
select public.seed_asset_types(id) from public.tenants;

create or replace function public.seed_asset_types_on_tenant_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_asset_types(new.id);
  return new;
end;
$$;

create trigger seed_asset_types_on_tenant_insert after insert on public.tenants
  for each row execute function public.seed_asset_types_on_tenant_insert();

-- ---------------------------------------------------------------------------
-- The assets themselves
-- ---------------------------------------------------------------------------

alter table public.property_assets
  add column asset_type_id uuid references public.asset_types (id) on delete set null,
  -- For a client's asset: which of their addresses it's at (null = their
  -- main address).
  add column site_id uuid references public.client_sites (id) on delete set null,
  add column installed_on date,
  -- When the exact date isn't known ("about 2014").
  add column install_year int check (install_year is null or install_year between 1900 and 2200),
  -- Where it is at the address ("garage", "back of house").
  add column location text,
  add column notes text,
  add column status text not null default 'active' check (status in ('active', 'removed')),
  add column removed_on date,
  add column removed_reason text,
  add column replaced_by_asset_id uuid references public.property_assets (id) on delete set null,
  -- Set when the asset came from a job's price book item.
  add column installed_by_job_id uuid references public.job_cards (id) on delete set null,
  add column source_line_key text,
  -- Added automatically from a job - the tech still needs to add the serial
  -- number and a data plate photo.
  add column needs_details boolean not null default false,
  add column replacement_reminded_at timestamptz,
  add column created_by uuid references public.profiles (id) on delete set null;

create unique index property_assets_source_line_key_idx on public.property_assets (source_line_key) where source_line_key is not null;
create index property_assets_type_idx on public.property_assets (asset_type_id);
create index property_assets_site_idx on public.property_assets (site_id);

-- Technicians add and update assets on site (the phone app); only admins
-- delete.
drop policy if exists "property_assets: admin writes - insert" on public.property_assets;
drop policy if exists "property_assets: admin writes - update" on public.property_assets;
create policy "property_assets: tenant insert" on public.property_assets for insert with check (tenant_id = public.current_tenant_id());
create policy "property_assets: tenant update" on public.property_assets for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());

-- The date an asset counts as installed: the exact date, or 1 July of the
-- year when only the year is known.
create or replace function public.asset_installed_date(p_installed_on date, p_install_year int)
returns date
language sql
immutable
as $$
  select coalesce(p_installed_on, case when p_install_year is not null then make_date(p_install_year, 7, 1) end)
$$;

-- ---------------------------------------------------------------------------
-- Warranties, services, history, files, claims
-- ---------------------------------------------------------------------------

create table public.asset_warranties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  asset_id uuid not null references public.property_assets (id) on delete cascade,
  kind text not null check (kind in ('manufacturer', 'workmanship')),
  -- "Cylinder", "Parts", "Labour", "Workmanship"...
  label text not null default '',
  starts_on date,
  expires_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.asset_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  asset_id uuid not null references public.property_assets (id) on delete cascade,
  name text not null,
  interval_months int check (interval_months is null or interval_months between 1 and 600),
  last_done_on date,
  next_due_on date,
  notes text,
  -- Which due date a reminder text has already gone out for (so each due
  -- date gets one), and the same for the property manager's reminder.
  reminded_for date,
  pm_reminded_for date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.asset_service_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  asset_id uuid not null references public.property_assets (id) on delete cascade,
  -- Null for a general note or one-off work on the asset.
  service_id uuid references public.asset_services (id) on delete set null,
  job_card_id uuid references public.job_cards (id) on delete set null,
  done_on date not null default current_date,
  done_by uuid references public.profiles (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create table public.asset_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  asset_id uuid not null references public.property_assets (id) on delete cascade,
  kind text not null default 'photo' check (kind in ('photo', 'document')),
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  caption text,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.asset_warranty_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  asset_id uuid not null references public.property_assets (id) on delete cascade,
  warranty_id uuid references public.asset_warranties (id) on delete set null,
  job_card_id uuid references public.job_cards (id) on delete set null,
  lodged_on date not null default current_date,
  -- Who it's lodged with: "Rheem", "Reece", "our workmanship".
  claim_with text,
  reference text,
  status text not null default 'lodged' check (status in ('lodged', 'approved', 'declined', 'completed')),
  parts_supplied text,
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index asset_warranties_asset_idx on public.asset_warranties (asset_id);
create index asset_services_asset_idx on public.asset_services (asset_id);
create index asset_services_due_idx on public.asset_services (next_due_on);
create index asset_service_records_asset_idx on public.asset_service_records (asset_id);
create index asset_service_records_job_idx on public.asset_service_records (job_card_id);
create index asset_files_asset_idx on public.asset_files (asset_id);
create index asset_warranty_claims_asset_idx on public.asset_warranty_claims (asset_id);

create trigger set_asset_warranties_updated_at before update on public.asset_warranties for each row execute function public.set_updated_at();
create trigger set_asset_services_updated_at before update on public.asset_services for each row execute function public.set_updated_at();
create trigger set_asset_warranty_claims_updated_at before update on public.asset_warranty_claims for each row execute function public.set_updated_at();

alter table public.asset_warranties enable row level security;
alter table public.asset_services enable row level security;
alter table public.asset_service_records enable row level security;
alter table public.asset_files enable row level security;
alter table public.asset_warranty_claims enable row level security;

-- Everyone in the company reads and records (techs on the phone); deleting
-- is for admins, or the person who added a record or file.
create policy "asset_warranties: tenant read" on public.asset_warranties for select using (tenant_id = public.current_tenant_id());
create policy "asset_warranties: tenant insert" on public.asset_warranties for insert with check (tenant_id = public.current_tenant_id());
create policy "asset_warranties: tenant update" on public.asset_warranties for update using (tenant_id = public.current_tenant_id());
create policy "asset_warranties: admin delete" on public.asset_warranties for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "asset_services: tenant read" on public.asset_services for select using (tenant_id = public.current_tenant_id());
create policy "asset_services: tenant insert" on public.asset_services for insert with check (tenant_id = public.current_tenant_id());
create policy "asset_services: tenant update" on public.asset_services for update using (tenant_id = public.current_tenant_id());
create policy "asset_services: admin delete" on public.asset_services for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "asset_service_records: tenant read" on public.asset_service_records for select using (tenant_id = public.current_tenant_id());
create policy "asset_service_records: tenant insert" on public.asset_service_records for insert with check (tenant_id = public.current_tenant_id());
create policy "asset_service_records: tenant update" on public.asset_service_records for update using (tenant_id = public.current_tenant_id() and (public.is_admin() or done_by = auth.uid()));
create policy "asset_service_records: delete own or admin" on public.asset_service_records for delete using (tenant_id = public.current_tenant_id() and (public.is_admin() or done_by = auth.uid()));
create policy "asset_files: tenant read" on public.asset_files for select using (tenant_id = public.current_tenant_id());
create policy "asset_files: tenant insert" on public.asset_files for insert with check (tenant_id = public.current_tenant_id());
create policy "asset_files: tenant update" on public.asset_files for update using (tenant_id = public.current_tenant_id());
create policy "asset_files: delete own or admin" on public.asset_files for delete using (tenant_id = public.current_tenant_id() and (public.is_admin() or uploaded_by = auth.uid()));
create policy "asset_warranty_claims: tenant read" on public.asset_warranty_claims for select using (tenant_id = public.current_tenant_id());
create policy "asset_warranty_claims: tenant insert" on public.asset_warranty_claims for insert with check (tenant_id = public.current_tenant_id());
create policy "asset_warranty_claims: tenant update" on public.asset_warranty_claims for update using (tenant_id = public.current_tenant_id());
create policy "asset_warranty_claims: admin delete" on public.asset_warranty_claims for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Asset photos and documents live in the job-files bucket under
-- <tenant>/asset-<asset id>/ (same bucket as job and leak check photos).
create policy "job-files: tenant read asset files" on storage.objects
  for select using (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and (storage.foldername(name))[2] like 'asset-%'
    and exists (
      select 1 from public.property_assets a
      where a.id::text = substring((storage.foldername(name))[2] from 7) and a.tenant_id = public.current_tenant_id()
    )
  );
create policy "job-files: tenant upload asset files" on storage.objects
  for insert with check (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and (storage.foldername(name))[2] like 'asset-%'
    and exists (
      select 1 from public.property_assets a
      where a.id::text = substring((storage.foldername(name))[2] from 7) and a.tenant_id = public.current_tenant_id()
    )
  );

-- A service's next due date follows from when it was last done; a new
-- service with no history counts from the install date (rolled forward to
-- the next one from today for an older asset). Changing the last
-- done date or the interval recalculates it; otherwise an edited due date
-- is kept.
create or replace function public.asset_service_next_due()
returns trigger
language plpgsql
as $$
declare
  v_installed date;
begin
  if tg_op = 'UPDATE' and (
    (new.last_done_on is not distinct from old.last_done_on and new.interval_months is not distinct from old.interval_months)
    -- a due date typed in with the same edit wins
    or new.next_due_on is distinct from old.next_due_on
  ) then
    return new;
  end if;
  if new.interval_months is null then
    return new;
  end if;
  if new.last_done_on is not null then
    new.next_due_on := (new.last_done_on + make_interval(months => new.interval_months))::date;
  elsif new.next_due_on is null or tg_op = 'UPDATE' then
    select public.asset_installed_date(installed_on, install_year) into v_installed from public.property_assets where id = new.asset_id;
    if v_installed is not null then
      -- The first due date after install - or, for an older asset with no
      -- service recorded, the next one from today (a 2016 hot water system
      -- isn't shown as nine years overdue).
      new.next_due_on := (v_installed + make_interval(months => new.interval_months))::date;
      if new.next_due_on < current_date then
        new.next_due_on := (v_installed + make_interval(months => new.interval_months * ceil(
          ((extract(year from age(current_date, v_installed)) * 12 + extract(month from age(current_date, v_installed))) + 1) / new.interval_months::numeric
        )::int))::date;
        if new.next_due_on < current_date then
          new.next_due_on := (new.next_due_on + make_interval(months => new.interval_months))::date;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger asset_service_next_due before insert or update on public.asset_services
  for each row execute function public.asset_service_next_due();

-- Ticking a service off moves its last done date on (never backwards).
create or replace function public.asset_service_record_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.service_id is not null then
    update public.asset_services
    set last_done_on = greatest(coalesce(last_done_on, new.done_on), new.done_on)
    where id = new.service_id;
  end if;
  return new;
end;
$$;

create trigger asset_service_record_done after insert on public.asset_service_records
  for each row execute function public.asset_service_record_done();

-- Taking a tick back off (deleted the same day by mistake) puts the last
-- done date back to the latest remaining record.
create or replace function public.asset_service_record_undone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.service_id is not null then
    update public.asset_services s
    set last_done_on = (select max(done_on) from public.asset_service_records r where r.service_id = s.id)
    where s.id = old.service_id;
  end if;
  return old;
end;
$$;

create trigger asset_service_record_undone after delete on public.asset_service_records
  for each row execute function public.asset_service_record_undone();

-- ---------------------------------------------------------------------------
-- Price book: items that create an asset when installed
-- ---------------------------------------------------------------------------

alter table public.price_book_items
  add column creates_asset_type_id uuid references public.asset_types (id) on delete set null,
  -- Filled in on the new asset: {"brand":"Rheem","model":"Stellar 330"}.
  add column asset_attributes jsonb,
  -- Overrides the type's warranties: [{kind, label, years}].
  add column asset_warranties jsonb;

-- Adds the type's services and the warranties to a new asset.
create or replace function public.asset_apply_defaults(p_asset_id uuid, p_warranties jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.property_assets;
  t public.asset_types;
  v_installed date;
begin
  select * into a from public.property_assets where id = p_asset_id;
  select * into t from public.asset_types where id = a.asset_type_id;
  if t.id is null then
    return;
  end if;
  v_installed := public.asset_installed_date(a.installed_on, a.install_year);
  insert into public.asset_services (tenant_id, asset_id, name, interval_months)
  select a.tenant_id, a.id, s ->> 'name', nullif(s ->> 'interval_months', '')::int
  from jsonb_array_elements(t.default_services) s
  where nullif(btrim(s ->> 'name'), '') is not null;
  insert into public.asset_warranties (tenant_id, asset_id, kind, label, starts_on, expires_on)
  select a.tenant_id, a.id, coalesce(w ->> 'kind', 'manufacturer'), coalesce(w ->> 'label', ''), v_installed,
    case when v_installed is not null and nullif(w ->> 'years', '') is not null
      then (v_installed + make_interval(months => public.years_to_months((w ->> 'years')::numeric)))::date end
  from jsonb_array_elements(coalesce(p_warranties, t.default_warranties)) w
  where coalesce(w ->> 'kind', 'manufacturer') in ('manufacturer', 'workmanship');
end;
$$;

revoke execute on function public.asset_apply_defaults(uuid, jsonb) from public, anon, authenticated;

-- Adds the assets a completed job installed: its invoice lines (or, with no
-- invoice yet, its accepted quote's included lines) whose price book item
-- is marked "creates an asset". Safe to run again - each line makes its
-- assets once. Returns how many were added.
create or replace function public.create_assets_from_job(p_job_card_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.job_cards;
  l record;
  n int;
  i int;
  v_id uuid;
  v_count int := 0;
  v_today date := (now() at time zone 'Australia/Sydney')::date;
begin
  select * into j from public.job_cards where id = p_job_card_id;
  if j.id is null then
    return 0;
  end if;
  for l in
    with invoice_lines as (
      select li.id, li.description, li.quantity, li.unit, li.price_book_item_id
      from public.invoice_line_items li join public.invoices inv on inv.id = li.invoice_id
      where inv.job_card_id = j.id and inv.status <> 'void'
    ),
    quote_lines as (
      select li.id, li.description, li.quantity, li.unit, li.price_book_item_id
      from public.quote_line_items li join public.quotes q on q.id = li.quote_id
      where q.job_card_id = j.id and q.status = 'accepted' and li.is_included and coalesce(li.in_quote_total, true)
        and not exists (select 1 from invoice_lines)
    )
    select x.*, p.creates_asset_type_id, p.asset_attributes, p.asset_warranties, p.description as item_description
    from (select * from invoice_lines union all select * from quote_lines) x
    join public.price_book_items p on p.id = x.price_book_item_id
    where p.creates_asset_type_id is not null
  loop
    -- "2 skylights" is two assets; "45 m of gutter" is one.
    n := case
      when (l.unit is null or lower(btrim(l.unit)) in ('', 'each', 'ea', 'item', 'items', 'unit', 'units', 'no', 'no.'))
           and l.quantity = floor(l.quantity) and l.quantity between 1 and 10 then l.quantity::int
      else 1
    end;
    for i in 1..n loop
      insert into public.property_assets (
        tenant_id, property_id, client_id, site_id, category, asset_type_id, asset_name, attributes,
        installed_on, installed_by_job_id, source_line_key, needs_details
      )
      select j.tenant_id, j.property_id, case when j.property_id is null then j.client_id end,
        case when j.property_id is null then j.site_id end,
        t.category, t.id,
        left(coalesce(nullif(btrim(split_part(l.item_description, E'\n', 1)), ''), nullif(btrim(split_part(l.description, E'\n', 1)), ''), t.name), 120),
        coalesce(l.asset_attributes, '{}'::jsonb),
        v_today, j.id, l.id::text || '#' || i, true
      from public.asset_types t where t.id = l.creates_asset_type_id
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then
        perform public.asset_apply_defaults(v_id, l.asset_warranties);
        v_count := v_count + 1;
      end if;
      v_id := null;
    end loop;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.create_assets_from_job(uuid) from public, anon;
grant execute on function public.create_assets_from_job(uuid) to authenticated;

create or replace function public.create_assets_on_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_closed boolean;
  v_old_closed boolean;
begin
  select coalesce(is_closed, false) into v_new_closed from public.job_lifecycle_stages where id = new.lifecycle_stage_id;
  select coalesce(is_closed, false) into v_old_closed from public.job_lifecycle_stages where id = old.lifecycle_stage_id;
  if coalesce(v_new_closed, false) and not coalesce(v_old_closed, false) then
    perform public.create_assets_from_job(new.id);
  end if;
  return new;
exception when others then
  -- Never let the register stop a job being completed.
  raise warning 'assets not created for job %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger create_assets_on_job_completion after update of lifecycle_stage_id on public.job_cards
  for each row execute function public.create_assets_on_job_completion();

-- ---------------------------------------------------------------------------
-- Move the existing assets over
-- ---------------------------------------------------------------------------

update public.property_assets a
set asset_type_id = t.id
from public.asset_types t
where t.tenant_id = a.tenant_id and a.asset_type_id is null
  and t.name = case a.category when 'plumbing' then 'Hot water system' when 'roofing' then 'Roof' when 'hvac' then 'Air conditioning' else 'Other' end;

update public.property_assets
set installed_on = public.try_date(attributes ->> 'installation_date'),
    install_year = case
      when public.try_date(attributes ->> 'installation_date') is null and (attributes ->> 'roof_age_years') ~ '^\d+(\.\d+)?$'
      then extract(year from created_at)::int - round((attributes ->> 'roof_age_years')::numeric)::int
    end;

insert into public.asset_warranties (tenant_id, asset_id, kind, label, starts_on, expires_on)
select tenant_id, id, 'manufacturer', 'Manufacturer', installed_on, public.try_date(attributes ->> 'warranty_expiry_date')
from public.property_assets
where public.try_date(attributes ->> 'warranty_expiry_date') is not null;

-- Each existing asset gets its type's service plan; a recorded gutter
-- clean schedule becomes its own "Gutter clean" service with its history.
insert into public.asset_services (tenant_id, asset_id, name, interval_months)
select a.tenant_id, a.id, s ->> 'name', (s ->> 'interval_months')::int
from public.property_assets a join public.asset_types t on t.id = a.asset_type_id
cross join jsonb_array_elements(t.default_services) s;

insert into public.asset_services (tenant_id, asset_id, name, interval_months, last_done_on)
select tenant_id, id, 'Gutter clean',
  case when (attributes ->> 'gutter_clean_interval_months') ~ '^\d+$' then (attributes ->> 'gutter_clean_interval_months')::int else 12 end,
  public.try_date(attributes ->> 'last_gutter_clean_date')
from public.property_assets
where public.try_date(attributes ->> 'last_gutter_clean_date') is not null or (attributes ->> 'gutter_clean_interval_months') ~ '^\d+$';

-- ---------------------------------------------------------------------------
-- Reminder texts (Follow-ups engine)
-- ---------------------------------------------------------------------------

alter table public.follow_up_sequences drop constraint follow_up_sequences_key_check;
alter table public.follow_up_sequences add constraint follow_up_sequences_key_check
  check (key in ('storm_checklist', 'storm_morning', 'quote_quiet', 'asset_service', 'asset_replacement'));

create or replace function public.seed_asset_reminder_sequences(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq uuid;
begin
  if not exists (select 1 from public.follow_up_sequences where tenant_id = p_tenant_id and key = 'asset_service') then
    insert into public.follow_up_sequences (tenant_id, key, name) values (p_tenant_id, 'asset_service', 'Service due') returning id into v_seq;
    insert into public.follow_up_steps (tenant_id, sequence_id, position, day_offset, label, body) values
      (p_tenant_id, v_seq, 0, 0, 'Service reminder',
       'Hi {first_name}, Elyas here. It''s time for a service on your {items} at {address}. Want me to book you in? Reply with a day that suits. Reply STOP to opt out');
  end if;
  if not exists (select 1 from public.follow_up_sequences where tenant_id = p_tenant_id and key = 'asset_replacement') then
    insert into public.follow_up_sequences (tenant_id, key, name) values (p_tenant_id, 'asset_replacement', 'Due for replacement') returning id into v_seq;
    insert into public.follow_up_steps (tenant_id, sequence_id, position, day_offset, label, body) values
      (p_tenant_id, v_seq, 0, 0, 'Replacement reminder',
       'Hi {first_name}, Elyas here. Your {item} at {address} is now {age} years old, which is about when they start to fail. Worth replacing it before it does? Reply and I''ll send you a fixed price. Reply STOP to opt out');
  end if;
end;
$$;

revoke execute on function public.seed_asset_reminder_sequences(uuid) from public, anon, authenticated;
select public.seed_asset_reminder_sequences(id) from public.tenants;

create or replace function public.seed_asset_reminders_on_tenant_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_asset_reminder_sequences(new.id);
  return new;
end;
$$;

-- Named to run after the follow-up seeding trigger (alphabetical order).
create trigger seed_follow_up_sequences_on_tenant_insert_z_assets after insert on public.tenants
  for each row execute function public.seed_asset_reminders_on_tenant_insert();

-- "hot water system", "a, b and c"
create or replace function public.asset_label(p_asset public.property_assets)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case when t.name ~ '^[A-Z][a-z]' then lower(left(t.name, 1)) || substr(t.name, 2) else t.name end
     from public.asset_types t where t.id = p_asset.asset_type_id and t.name <> 'Other'),
    p_asset.asset_name)
$$;

create or replace function public.join_and(p text[])
returns text
language sql
immutable
as $$
  select case
    when coalesce(array_length(p, 1), 0) = 0 then ''
    when array_length(p, 1) = 1 then p[1]
    else array_to_string(p[1:array_length(p, 1) - 1], ', ') || ' and ' || p[array_length(p, 1)]
  end
$$;

-- Where a client's asset is: the site's address, or the client's own.
create or replace function public.asset_address(p_asset public.property_assets)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select nullif(concat_ws(', ', nullif(btrim(s.address_line1), ''), nullif(btrim(s.suburb), '')), '') from public.client_sites s where s.id = p_asset.site_id),
    (select nullif(concat_ws(', ', nullif(btrim(c.address_line1), ''), nullif(btrim(c.suburb), '')), '') from public.clients c where c.id = p_asset.client_id),
    (select nullif(concat_ws(', ', nullif(btrim(p.address_line1), ''), nullif(btrim(p.suburb), '')), '') from public.properties p where p.id = p_asset.property_id),
    'your place'
  )
$$;

-- Queues the reminder texts that are due. Called by process-follow-ups on
-- every run (cheap when there's nothing to do). Only clients' own assets -
-- agency properties remind the property manager instead. A text only
-- starts if the sequence is on (or the client's mobile is a test number);
-- each due date and each replacement is texted once.
--   Service: services due within the type's lead time (default 4 weeks),
--   or up to 7 days overdue - anything older is for the office to chase
--   from the Due list, not a surprise text. One text per client and
--   address, listing everything due there.
--   Replacement: assets within the lead time of their "replace around"
--   age, once each.
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

-- follow_up_enrol allows one active run of a sequence per mobile, so a
-- double sign-up doesn't text twice. Asset reminders have their own
-- once-per-due-date guard instead, and a client with two houses gets a
-- text for each, so they're exempt like quotes.
-- (Written out in full - patching a stored function's text by
-- find-and-replace fails on databases whose migrations were pushed with
-- Windows line endings.)
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
    where sequence_id = v_seq.id and status = 'active' and phone = v_phone and p_key not in ('quote_quiet', 'asset_service', 'asset_replacement')
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

-- Test runs of the new sequences need sample asset details.
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
                       'item', 'hot water system', 'age', '11'),
    now(), true, auth.uid()
  );
  return v_id;
end;
$$;
