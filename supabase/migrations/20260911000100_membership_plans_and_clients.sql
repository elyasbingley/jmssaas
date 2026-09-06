-- Membership Module (Munus) - Batch 1: schema + RLS. A layer on top of the
-- existing client/job/quote/invoice schema, not a replacement for it - a
-- member is still a normal `clients` row, just linked to a
-- `client_memberships` row the same way a real-estate job is still a
-- normal `job_cards` row just tagged with agency/property metadata (see
-- real_estate_strata.sql's own header comment).
--
-- Three new tables. RLS follows the same two shapes real_estate_strata
-- established, split by who edits the data:
--
--   - membership_plans is back-office reference data an admin maintains -
--     same shape as price_book_categories/price_book_items: tenant-wide
--     read, admin-only write. A field technician needs to read the plan's
--     benefit values (to tell a member what's included) but doesn't create
--     or edit the plan itself.
--   - client_memberships is the opposite in one sense (an actual
--     enrollment record, not reference data) but the same RLS shape in
--     practice: tenant-wide read (a technician on a job needs to see "this
--     client is a Member, no call-out fee" for job context - same
--     reasoning as key_logs/properties being field-readable), admin-only
--     write. Enrollment/cancellation goes through Stripe Checkout / the
--     membership Stripe webhook (Batch 4) - a service-role write bypasses
--     RLS entirely, so this policy only ever governs direct client-side
--     writes, same caveat scheduled_communications' own RLS comment makes.
--   - membership_benefit_usage sits with job_notes/scheduled_communications
--     instead: a technician logs a benefit's use from the field, so it's
--     tenant-wide insert (matching scheduled_communications' own "small
--     crew, everyone needs to log an outbound/field action" shape),
--     admin-only update/delete.
--
-- Money in cents (bigint), matching every other money column in this
-- schema. tenant_id + an updated_at trigger on every table that has one,
-- matching every prior migration. No business logic here yet (discount
-- engine is Batch 2, communications are Batch 3, Stripe Connect is Batch
-- 4) - same "schema first, empty of behaviour" shape as real_estate_
-- strata.sql's own Batch 1.

create type public.membership_status as enum ('active', 'past_due', 'cancelled', 'expired');
create type public.membership_benefit_type as enum ('annual_roof_inspection', 'annual_plumbing_check');

-- ---------------------------------------------------------------------------
-- membership_plans
-- ---------------------------------------------------------------------------

create table public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null default 'Membership',
  annual_price_cents bigint not null,
  stripe_price_id text,
  discount_percent numeric(5, 2) not null default 0,
  waive_callout_fee boolean not null default true,
  priority_scheduling boolean not null default true,
  same_day_response boolean not null default false,
  annual_roof_inspections_included int not null default 1,
  annual_plumbing_checks_included int not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_membership_plans_updated_at
  before update on public.membership_plans
  for each row execute function public.set_updated_at();

create index membership_plans_tenant_id_idx on public.membership_plans (tenant_id);

-- One active plan per tenant, for now. This partial unique index is the
-- ONLY thing standing between this and multi-tier support (e.g. a
-- "Silver"/"Gold" pair per tenant) - every other piece of this schema
-- (client_memberships.membership_plan_id, benefits_snapshot, the Batch 2
-- discount-engine lookup by client_id) already works unchanged with
-- multiple concurrent active plans per tenant. Dropping this one index is
-- the entire migration a multi-tier follow-up would need on this table.
create unique index membership_plans_one_active_per_tenant_idx
  on public.membership_plans (tenant_id)
  where is_active;

-- ---------------------------------------------------------------------------
-- client_memberships
-- ---------------------------------------------------------------------------

create table public.client_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id),
  membership_plan_id uuid not null references public.membership_plans (id),
  status public.membership_status not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text unique,
  current_period_start date,
  current_period_end date,
  price_paid_cents bigint not null,
  -- Copy of the plan's benefit values at signup time, so a later plan
  -- price/benefit change doesn't retroactively alter an existing member's
  -- terms mid-period - the plan can change under a member without
  -- silently changing what they're entitled to until their next renewal
  -- re-snapshots it. Deliberately schemaless (like property_assets.
  -- attributes) since it's a point-in-time copy of whatever the plan
  -- columns looked like at signup, not a structured column set of its own.
  benefits_snapshot jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_client_memberships_updated_at
  before update on public.client_memberships
  for each row execute function public.set_updated_at();

create index client_memberships_tenant_id_idx on public.client_memberships (tenant_id);
create index client_memberships_client_id_idx on public.client_memberships (client_id);
create index client_memberships_membership_plan_id_idx on public.client_memberships (membership_plan_id);
create index client_memberships_status_idx on public.client_memberships (status);

-- A client can't hold two simultaneous active memberships.
create unique index client_memberships_one_active_per_client_idx
  on public.client_memberships (client_id)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- membership_benefit_usage
-- ---------------------------------------------------------------------------

create table public.membership_benefit_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_membership_id uuid not null references public.client_memberships (id) on delete cascade,
  benefit_type public.membership_benefit_type not null,
  job_card_id uuid references public.job_cards (id) on delete set null,
  period_start date not null,
  period_end date not null,
  used_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index membership_benefit_usage_tenant_id_idx on public.membership_benefit_usage (tenant_id);
create index membership_benefit_usage_client_membership_id_idx on public.membership_benefit_usage (client_membership_id);

-- This is the actual mechanism preventing the same included benefit being
-- used twice in one billing year - the app must handle a violation here
-- gracefully ("already used this period") and should check proactively
-- before attempting the insert (a get_membership_benefit_availability-style
-- read, added alongside the UI that calls it) so the UI can offer "book as
-- billable instead" rather than just erroring on the constraint.
create unique index membership_benefit_usage_one_per_period_idx
  on public.membership_benefit_usage (client_membership_id, benefit_type, period_start);

-- ---------------------------------------------------------------------------
-- price_book_items: mark which catalogue item(s) represent a call-out fee,
-- so the discount engine (Batch 2) can zero-price it separately from the
-- percentage discount rather than double up the two.
-- ---------------------------------------------------------------------------

alter table public.price_book_items
  add column is_callout_fee boolean not null default false;

-- ---------------------------------------------------------------------------
-- tenants: Stripe Connect account linkage. These two columns alone do
-- nothing yet - the onboarding Edge Function is Batch 4 - same "schema
-- lands before the integration that populates it" ordering xero_
-- integration.sql used for its own connection columns.
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column stripe_connect_account_id text,
  add column stripe_connect_onboarded boolean not null default false;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.membership_plans enable row level security;

create policy "membership_plans: tenant read" on public.membership_plans
  for select using (tenant_id = public.current_tenant_id());

create policy "membership_plans: admin writes - insert" on public.membership_plans
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "membership_plans: admin writes - update" on public.membership_plans
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "membership_plans: admin writes - delete" on public.membership_plans
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.client_memberships enable row level security;

create policy "client_memberships: tenant read" on public.client_memberships
  for select using (tenant_id = public.current_tenant_id());

create policy "client_memberships: admin writes - insert" on public.client_memberships
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "client_memberships: admin writes - update" on public.client_memberships
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "client_memberships: admin writes - delete" on public.client_memberships
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Tenant-wide read/insert (matches scheduled_communications - a technician
-- logging a benefit's use from the field is the same shape as On The
-- Way/review-request being technician-inserted), admin-only update/delete.
alter table public.membership_benefit_usage enable row level security;

create policy "membership_benefit_usage: tenant read" on public.membership_benefit_usage
  for select using (tenant_id = public.current_tenant_id());

create policy "membership_benefit_usage: tenant insert" on public.membership_benefit_usage
  for insert with check (tenant_id = public.current_tenant_id());

create policy "membership_benefit_usage: admin writes - update" on public.membership_benefit_usage
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "membership_benefit_usage: admin writes - delete" on public.membership_benefit_usage
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
