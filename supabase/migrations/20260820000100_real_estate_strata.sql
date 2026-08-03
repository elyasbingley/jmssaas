-- Real Estate & Strata module: manages high-volume property-management
-- agency work (McGrath-style residential rent-roll agencies, and strata/body
-- corporate managers) as a layer on top of the existing job/quote/invoice
-- schema, not a replacement for it - a real-estate job is still a normal
-- `job_cards` row, just tagged with extra agency/property metadata.
--
-- Five new tables (agencies -> property_managers -> properties ->
-- property_assets, plus key_logs) and six new columns on job_cards. RLS
-- follows two different established shapes depending on who edits the data:
--
--   - agencies/property_managers/properties/property_assets are back-office
--     reference data an admin maintains (same shape as price_book_*:
--     tenant-wide read, admin-only write) - a field technician reads a
--     property's access notes/tenant contact/asset history but doesn't
--     create or edit agencies or properties from the field.
--   - key_logs is the opposite: a technician actively updates key status
--     from the field (picked up -> in van -> returned), so it follows the
--     job_notes/job_files shape instead - visibility and write access follow
--     the parent job_cards row (admin, or the assigned technician).
--
-- Money here is nte_limit_cents (bigint, cents) rather than the spec's
-- plain decimal dollar amount, to match every other money column in this
-- schema (quotes/invoices/line items all store cents as bigint to avoid
-- float rounding on GST math) - kept consistent rather than introducing a
-- one-off decimal column.

create type public.agency_type as enum ('real_estate', 'strata');
create type public.property_type as enum ('residential', 'commercial', 'strata_common_property', 'strata_lot');
create type public.property_asset_category as enum ('plumbing', 'roofing', 'hvac', 'general');
create type public.key_log_status as enum ('at_office', 'picked_up', 'in_van', 'returned');

-- ---------------------------------------------------------------------------
-- agencies
-- ---------------------------------------------------------------------------

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  type public.agency_type not null default 'real_estate',
  billing_email text,
  phone text,
  payment_terms_days int not null default 30,
  require_work_order_num boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_agencies_updated_at
  before update on public.agencies
  for each row execute function public.set_updated_at();

create index agencies_tenant_id_idx on public.agencies (tenant_id);

-- ---------------------------------------------------------------------------
-- property_managers
-- ---------------------------------------------------------------------------

create table public.property_managers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  agency_id uuid not null references public.agencies (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  -- Unique per-tenant rather than the spec's bare globally-unique email -
  -- a bare `unique` would let one tenant's PM email collide with another
  -- tenant's and block the second insert outright, which has nothing to do
  -- with this app's own data integrity (this schema has no cross-tenant
  -- concept of "the same person").
  email text,
  mobile text,
  work_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_property_managers_updated_at
  before update on public.property_managers
  for each row execute function public.set_updated_at();

create index property_managers_tenant_id_idx on public.property_managers (tenant_id);
create index property_managers_agency_id_idx on public.property_managers (agency_id);
create unique index property_managers_tenant_email_idx on public.property_managers (tenant_id, email) where email is not null;

-- ---------------------------------------------------------------------------
-- properties
-- ---------------------------------------------------------------------------

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  agency_id uuid not null references public.agencies (id) on delete cascade,
  property_manager_id uuid references public.property_managers (id) on delete set null,
  address_line1 text not null,
  suburb text not null,
  state text not null,
  postcode text not null,
  property_type public.property_type not null default 'residential',
  strata_plan_number text,
  owner_landlord_name text,
  tenant_name text,
  tenant_phone text,
  tenant_email text,
  access_notes text,
  key_tag_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_properties_updated_at
  before update on public.properties
  for each row execute function public.set_updated_at();

create index properties_tenant_id_idx on public.properties (tenant_id);
create index properties_agency_id_idx on public.properties (agency_id);
create index properties_property_manager_id_idx on public.properties (property_manager_id);
create index properties_suburb_idx on public.properties (suburb);

-- ---------------------------------------------------------------------------
-- property_assets
-- ---------------------------------------------------------------------------

create table public.property_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  property_id uuid not null references public.properties (id) on delete cascade,
  category public.property_asset_category not null default 'general',
  asset_name text not null,
  -- Plumbing: brand, model, serial_number, fuel_type, capacity_litres,
  -- installation_date, warranty_expiry_date. Roofing: roof_type,
  -- roof_age_years, last_gutter_clean_date, gutter_clean_interval_months,
  -- screw_condition, ridge_condition. Deliberately schemaless (unlike every
  -- other structured column in this schema) since the two categories'
  -- fields don't overlap at all and HVAC/general assets will want yet a
  -- third shape - a fixed column set would mean most rows have most
  -- columns null. The Recurring Maintenance Engine's due-date sweep (see
  -- the later migration adding that) reads last_gutter_clean_date/
  -- gutter_clean_interval_months out of this jsonb directly.
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_property_assets_updated_at
  before update on public.property_assets
  for each row execute function public.set_updated_at();

create index property_assets_tenant_id_idx on public.property_assets (tenant_id);
create index property_assets_property_id_idx on public.property_assets (property_id);

-- ---------------------------------------------------------------------------
-- key_logs
-- ---------------------------------------------------------------------------

create table public.key_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  property_id uuid not null references public.properties (id) on delete cascade,
  job_id uuid references public.job_cards (id) on delete set null,
  technician_id uuid references public.profiles (id) on delete set null,
  key_tag_number text not null,
  status public.key_log_status not null default 'at_office',
  picked_up_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_key_logs_updated_at
  before update on public.key_logs
  for each row execute function public.set_updated_at();

create index key_logs_tenant_id_idx on public.key_logs (tenant_id);
create index key_logs_property_id_idx on public.key_logs (property_id);
create index key_logs_job_id_idx on public.key_logs (job_id);
create index key_logs_status_idx on public.key_logs (status);

-- ---------------------------------------------------------------------------
-- job_cards extensions
-- ---------------------------------------------------------------------------

alter table public.job_cards
  add column is_real_estate_job boolean not null default false,
  add column agency_id uuid references public.agencies (id) on delete set null,
  add column property_manager_id uuid references public.property_managers (id) on delete set null,
  -- Not in the original field list, but the workflow spec itself requires
  -- "the app auto-suggests/links the matching Property" - without a column
  -- to hold that link, the Property Profile's "Job & Compliance History"
  -- tab and the Key Management Dashboard's "Property Address" column would
  -- have no way to find a job's property at all.
  add column property_id uuid references public.properties (id) on delete set null,
  add column work_order_number text,
  add column nte_limit_cents bigint,
  add column nte_exceeded_approved boolean not null default false;

create index job_cards_agency_id_idx on public.job_cards (agency_id);
create index job_cards_property_id_idx on public.job_cards (property_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.agencies enable row level security;

create policy "agencies: tenant read" on public.agencies
  for select using (tenant_id = public.current_tenant_id());

create policy "agencies: admin writes - insert" on public.agencies
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "agencies: admin writes - update" on public.agencies
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "agencies: admin writes - delete" on public.agencies
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.property_managers enable row level security;

create policy "property_managers: tenant read" on public.property_managers
  for select using (tenant_id = public.current_tenant_id());

create policy "property_managers: admin writes - insert" on public.property_managers
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "property_managers: admin writes - update" on public.property_managers
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "property_managers: admin writes - delete" on public.property_managers
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.properties enable row level security;

create policy "properties: tenant read" on public.properties
  for select using (tenant_id = public.current_tenant_id());

create policy "properties: admin writes - insert" on public.properties
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "properties: admin writes - update" on public.properties
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "properties: admin writes - delete" on public.properties
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.property_assets enable row level security;

create policy "property_assets: tenant read" on public.property_assets
  for select using (tenant_id = public.current_tenant_id());

create policy "property_assets: admin writes - insert" on public.property_assets
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "property_assets: admin writes - update" on public.property_assets
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "property_assets: admin writes - delete" on public.property_assets
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- key_logs: admin sees/manages every key; a technician sees and edits only
-- key logs tied to a job assigned to them - same shape as job_notes/
-- job_files (visibility follows the parent job), except job_id is nullable
-- here (a key can be logged out to a property ahead of a job existing, or
-- kept as a standing "who has this key" record independent of any one
-- job), so the technician branch only applies when job_id is actually set.
alter table public.key_logs enable row level security;

create policy "key_logs: select own or admin" on public.key_logs
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      public.is_admin()
      or exists (
        select 1 from public.job_cards jc
        where jc.id = key_logs.job_id and jc.assigned_technician_id = auth.uid()
      )
    )
  );

create policy "key_logs: insert own or admin" on public.key_logs
  for insert with check (
    tenant_id = public.current_tenant_id()
    and (
      public.is_admin()
      or exists (
        select 1 from public.job_cards jc
        where jc.id = key_logs.job_id and jc.assigned_technician_id = auth.uid()
      )
    )
  );

create policy "key_logs: update own or admin" on public.key_logs
  for update using (
    tenant_id = public.current_tenant_id()
    and (
      public.is_admin()
      or exists (
        select 1 from public.job_cards jc
        where jc.id = key_logs.job_id and jc.assigned_technician_id = auth.uid()
      )
    )
  );

create policy "key_logs: admin deletes" on public.key_logs
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
