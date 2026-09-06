-- Cost of Ops module - a new Settings section modelling the "Cost of
-- Operations Calculator" spreadsheet (Tradies Success Academy): what it
-- actually costs per hour/day/month to run the business, and what charge-out
-- rate/margin that implies, split across 5 tabs (Operating Expenses, Labour,
-- Cost of Operations, Profitability, Quote Checker).
--
-- This is sensitive financial data - unlike agencies/properties (tenant-wide
-- read, admin-only write), every table here is admin-only on SELECT too, not
-- just writes. There's no separate "owner" role in this schema (user_role is
-- just admin|technician - see init_schema.sql), so "owner/admin" maps
-- directly onto the existing is_admin() check used everywhere else for
-- admin-gated writes.
--
-- All the actual COO/labour-cost/profitability math is computed client-side
-- from these raw rows (packages/shared/src/cost-of-ops.ts), same as Job
-- Costing and the Analytics module - nothing here is ever stored, matching
-- the brief's own "always calculate live, never stored". This is a
-- deliberately different choice from the membership discount engine's
-- Postgres functions, which persist their result onto the quote/invoice row
-- for consistent redisplay - there's nothing to persist here.

create type public.cost_of_ops_role_type as enum ('owner', 'field_staff', 'apprentice', 'admin', 'subcontractor');
create type public.cost_of_ops_pay_type as enum ('salary', 'hourly');

-- ---------------------------------------------------------------------------
-- cost_of_ops_settings - one row per tenant.
-- ---------------------------------------------------------------------------

create table public.cost_of_ops_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,
  ordinary_hours_per_week numeric not null default 38,
  weekend_days_per_year integer not null default 105,
  public_holidays_per_year integer not null default 13,
  annual_leave_days integer not null default 20,
  sick_days integer not null default 10,
  rain_shutdown_days integer not null default 10,
  estimated_efficiency_rate numeric not null default 0.80,
  target_labour_profit_margin numeric not null default 0.15,
  -- "Actual Charge Rate (ex GST)" on the Profitability tab - no sensible
  -- default, the tenant sets this to their real rate.
  actual_charge_rate_cents bigint not null default 0,
  materials_avg_monthly_spend_cents bigint not null default 0,
  materials_avg_markup numeric not null default 0,
  contractors_weekly_spend_cents bigint not null default 0,
  contractors_weekly_hours numeric not null default 0,
  vehicles_owned integer not null default 0,
  vehicle_holding_cost_cents bigint not null default 0,
  buffer_percent numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_cost_of_ops_settings_updated_at
  before update on public.cost_of_ops_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- operating_expenses - line items, including the "Adjustments" section
-- (Extra Employee Costs / Debt Repayments) as ordinary rows with
-- is_default_category = false, so the Total Operating Expense sum just
-- naturally includes them without special-casing.
-- ---------------------------------------------------------------------------

create table public.operating_expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  account_name text not null,
  monthly_amount_cents bigint not null default 0,
  budget_amount_cents bigint,
  is_default_category boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index operating_expenses_tenant_id_idx on public.operating_expenses (tenant_id);

create trigger set_operating_expenses_updated_at
  before update on public.operating_expenses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- labour_cost_entries - the labour roster, one row per person/slot.
-- ---------------------------------------------------------------------------

create table public.labour_cost_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role_type public.cost_of_ops_role_type not null,
  -- Link to a real Munus user where one exists, instead of re-entering their
  -- name - nullable because subcontractors (and any ad-hoc entry) don't have
  -- a profiles row at all.
  profile_id uuid references public.profiles (id) on delete set null,
  name text,
  pay_type public.cost_of_ops_pay_type not null default 'hourly',
  -- Owners (salary-based):
  annual_salary_cents bigint,
  superannuation_cents bigint,
  -- Field staff / apprentices / admin / subcontractors (hourly-rate roles):
  hourly_rate_cents bigint,
  superannuation_rate numeric,
  allowance_cents bigint,
  billable_hours_per_week numeric not null default 0,
  non_billable_hours_per_week numeric not null default 0,
  -- Apprentices only - "% of a full billable resource".
  apprentice_utilisation numeric,
  -- Subcontractors only.
  subcontractor_charge_out_rate_cents bigint,
  subcontractor_travel_allow_cents bigint,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index labour_cost_entries_tenant_id_idx on public.labour_cost_entries (tenant_id);
create index labour_cost_entries_profile_id_idx on public.labour_cost_entries (profile_id);

create trigger set_labour_cost_entries_updated_at
  before update on public.labour_cost_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS - admin-only on SELECT as well as writes (unlike agencies/properties'
-- tenant-wide read), since this is business financial data no technician
-- should be able to read even via a direct API call.
-- ---------------------------------------------------------------------------

alter table public.cost_of_ops_settings enable row level security;

create policy "cost_of_ops_settings: admin only - select" on public.cost_of_ops_settings
  for select using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "cost_of_ops_settings: admin only - insert" on public.cost_of_ops_settings
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "cost_of_ops_settings: admin only - update" on public.cost_of_ops_settings
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "cost_of_ops_settings: admin only - delete" on public.cost_of_ops_settings
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.operating_expenses enable row level security;

create policy "operating_expenses: admin only - select" on public.operating_expenses
  for select using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "operating_expenses: admin only - insert" on public.operating_expenses
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "operating_expenses: admin only - update" on public.operating_expenses
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "operating_expenses: admin only - delete" on public.operating_expenses
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.labour_cost_entries enable row level security;

create policy "labour_cost_entries: admin only - select" on public.labour_cost_entries
  for select using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "labour_cost_entries: admin only - insert" on public.labour_cost_entries
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "labour_cost_entries: admin only - update" on public.labour_cost_entries
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "labour_cost_entries: admin only - delete" on public.labour_cost_entries
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed functions - same "auto-seed via handle_new_tenant + one-time
-- backfill" pattern as seed_default_lifecycle_stages/seed_default_
-- communication_rules: no separate "Activate Cost of Ops" step, the module
-- just appears already populated for every tenant, current and future.
-- ---------------------------------------------------------------------------

create or replace function public.seed_default_cost_of_ops_settings(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.cost_of_ops_settings (tenant_id)
  values (p_tenant_id)
  on conflict (tenant_id) do nothing;
end;
$$;

create or replace function public.seed_default_operating_expenses(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  if exists (select 1 from public.operating_expenses where tenant_id = p_tenant_id) then
    return;
  end if;

  insert into public.operating_expenses (tenant_id, account_name, is_default_category, sort_order)
  values
    (p_tenant_id, 'Accounting Fees', true, 1),
    (p_tenant_id, 'Admin - Contractors', true, 2),
    (p_tenant_id, 'Advertising - Email', true, 3),
    (p_tenant_id, 'Advertising - Facebook', true, 4),
    (p_tenant_id, 'Advertising - Google', true, 5),
    (p_tenant_id, 'Advertising - SEO', true, 6),
    (p_tenant_id, 'Bank Fees', true, 7),
    (p_tenant_id, 'Merchant Fees', true, 8),
    (p_tenant_id, 'Bookkeeping', true, 9),
    (p_tenant_id, 'Cleaning', true, 10),
    (p_tenant_id, 'Commissions Paid', true, 11),
    (p_tenant_id, 'Donations', true, 12),
    (p_tenant_id, 'Entertainment', true, 13),
    (p_tenant_id, 'Filing Fees', true, 14),
    (p_tenant_id, 'Licencing', true, 15),
    (p_tenant_id, 'Insurance', true, 16),
    (p_tenant_id, 'Interest Expense', true, 17),
    (p_tenant_id, 'Legal Expenses', true, 18),
    (p_tenant_id, 'Light/Power/Heating', true, 19),
    (p_tenant_id, 'Minor Equipment/Replacements', true, 20),
    (p_tenant_id, 'Motor Vehicle Expenses - Fuel & Oil', true, 21),
    (p_tenant_id, 'Motor Vehicle Expenses - Repairs & Maintenance', true, 22),
    (p_tenant_id, 'Motor Vehicle Expenses - Registration', true, 23),
    (p_tenant_id, 'Motor Vehicle Expenses - Insurance', true, 24),
    (p_tenant_id, 'Motor Vehicle Expenses - Tolls', true, 25),
    (p_tenant_id, 'Office Expense', true, 26),
    (p_tenant_id, 'Rent', true, 27),
    (p_tenant_id, 'Repairs and Maintenance', true, 28),
    (p_tenant_id, 'Staff Amenities', true, 29),
    (p_tenant_id, 'Subscriptions & Memberships', true, 30),
    (p_tenant_id, 'Telephone & Internet', true, 31),
    (p_tenant_id, 'Training & Conferences', true, 32),
    (p_tenant_id, 'Travel', true, 33),
    (p_tenant_id, 'Uniforms & Protective Clothing', true, 34),
    (p_tenant_id, 'Workcover Insurance', true, 35),
    -- Adjustments section from the reference tool - same table, just not
    -- flagged as a "standard category" so the UI can group them separately.
    (p_tenant_id, 'Extra Employee Costs', false, 36),
    (p_tenant_id, 'Debt Repayments (excl. MV finance)', false, 37);
end;
$$;

create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
as $$
begin
  perform public.seed_default_lifecycle_stages(new.id);
  perform public.seed_default_communication_rules(new.id);
  perform public.seed_default_communication_templates(new.id);
  perform public.seed_default_cost_of_ops_settings(new.id);
  perform public.seed_default_operating_expenses(new.id);
  return new;
end;
$$;

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_cost_of_ops_settings(t.id);
    perform public.seed_default_operating_expenses(t.id);
  end loop;
end;
$$;
