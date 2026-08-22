-- Job Card "Quote Tools" - four site-estimating tools layered onto a job
-- card, alongside the existing roof measurement tool (job_measurements,
-- see the roof_measurements migration): a linear-distance measurer
-- (gutters/fencing/piping runs), an on-site material tally counter, a
-- concrete volume calculator, and a material order form. Deliberate scope
-- decisions, spelled out here rather than scattered across comments below:
--
-- - All four reference `job_cards` (this schema's job entity), not a
--   `jobs` table - same correction the Asana task engine migration's own
--   comment already made about this recurring spec-writer assumption.
-- - No new `communication_logs` table for "Save to Job Notes" - the
--   existing `job_notes` table (author + body + timestamp, already used
--   by job_measurements' own "Save & Append to Job Card" flow) is exactly
--   that, so every tool's "save a summary to job notes" action inserts
--   into `job_notes` directly rather than a duplicate table.
-- - RLS mirrors `job_measurements` exactly (visibility/write follow the
--   parent `job_cards` row: admin sees/edits everything, a technician
--   only their own assigned job's records) - the same "job-scoped field
--   data" shape as notes/files/measurements.
-- - `job_concrete_calculations` has no `updated_at`/update policy,
--   matching the spec's own column list (created_at only, no updated_at)
--   - a recalculation is a new row, not an edit-in-place, same
--   append-style-history reasoning as job_measurements' own facets.
-- - `job_material_orders.order_number` is server-assigned via the
--   existing generic `next_reference_number()` helper (same mechanism as
--   job/quote/invoice numbers), not client-supplied - "MAT-001",
--   "MAT-002", ... - scoped unique per tenant like quote/invoice numbers.
-- - `pdf_url` is a plain nullable column, populated only if/when a real
--   PDF-generation-and-storage pipeline is wired up for material orders -
--   out of scope for this pass (desktop's own PDF "export" everywhere
--   else, e.g. the Inventory shopping list, is a browser print dialog,
--   not a stored file). "Email order to supplier" reuses the existing
--   EmailComposeModal + queueAndSendEmail plumbing with the order details
--   in the message body, same as the job card's own free-form email
--   button, rather than a new attachment pipeline.

create table public.job_linear_measurements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  title text not null,
  -- Array of { id, label, coordinates: [{lat,lng}], length_meters } - a
  -- segment has no independent lifecycle outside its parent set (never
  -- queried/joined on its own), same reasoning as job_measurements.facets.
  segments jsonb not null default '[]'::jsonb,
  total_length_meters numeric(10, 2) not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_linear_measurements_updated_at
  before update on public.job_linear_measurements
  for each row execute function public.set_updated_at();

create index job_linear_measurements_tenant_id_idx on public.job_linear_measurements (tenant_id);
create index job_linear_measurements_job_card_id_idx on public.job_linear_measurements (job_card_id);

create table public.job_material_tallies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  tally_name text,
  -- Array of { id, name, count, category } - counted items, same
  -- no-independent-lifecycle reasoning as segments/facets above.
  items jsonb not null default '[]'::jsonb,
  saved_to_notes boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_material_tallies_updated_at
  before update on public.job_material_tallies
  for each row execute function public.set_updated_at();

create index job_material_tallies_tenant_id_idx on public.job_material_tallies (tenant_id);
create index job_material_tallies_job_card_id_idx on public.job_material_tallies (job_card_id);

create table public.job_concrete_calculations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  calculation_name text not null,
  length_meters numeric(8, 2) not null,
  width_meters numeric(8, 2) not null,
  depth_meters numeric(8, 3) not null,
  waste_percentage numeric(5, 2) not null default 10.00,
  total_cubic_meters numeric(10, 3) not null,
  estimated_bags_20kg integer not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index job_concrete_calculations_tenant_id_idx on public.job_concrete_calculations (tenant_id);
create index job_concrete_calculations_job_card_id_idx on public.job_concrete_calculations (job_card_id);

create type public.material_order_status as enum ('DRAFT', 'ORDERED', 'DELIVERED', 'CANCELLED');

create table public.job_material_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  order_number text not null,
  supplier_name text,
  delivery_date date,
  -- Array of { item_name, quantity, unit_type, notes } - a line item has
  -- no independent lifecycle outside its parent order, same reasoning as
  -- every other jsonb array in this migration.
  line_items jsonb not null default '[]'::jsonb,
  status public.material_order_status not null default 'DRAFT',
  pdf_url text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_material_orders_order_number_unique unique (tenant_id, order_number)
);

create trigger set_job_material_orders_updated_at
  before update on public.job_material_orders
  for each row execute function public.set_updated_at();

create index job_material_orders_tenant_id_idx on public.job_material_orders (tenant_id);
create index job_material_orders_job_card_id_idx on public.job_material_orders (job_card_id);

create or replace function public.assign_material_order_number()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is null or new.order_number = '' then
    new.order_number := public.next_reference_number(new.tenant_id, 'material_order', 'MAT-', 3);
  end if;
  return new;
end;
$$;

create trigger assign_material_order_number_trigger
  before insert on public.job_material_orders
  for each row execute function public.assign_material_order_number();

-- ---------------------------------------------------------------------------
-- RLS - mirrors job_measurements exactly: visible/writable via the parent
-- job_cards row's own admin-or-assigned-technician rule.
-- ---------------------------------------------------------------------------

alter table public.job_linear_measurements enable row level security;

create policy "job_linear_measurements: select via parent job" on public.job_linear_measurements
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_linear_measurements.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_linear_measurements: insert via parent job" on public.job_linear_measurements
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_linear_measurements.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_linear_measurements: update via parent job" on public.job_linear_measurements
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_linear_measurements.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_linear_measurements: admin deletes" on public.job_linear_measurements
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.job_material_tallies enable row level security;

create policy "job_material_tallies: select via parent job" on public.job_material_tallies
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_material_tallies.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_material_tallies: insert via parent job" on public.job_material_tallies
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_material_tallies.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_material_tallies: update via parent job" on public.job_material_tallies
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_material_tallies.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_material_tallies: admin deletes" on public.job_material_tallies
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.job_concrete_calculations enable row level security;

create policy "job_concrete_calculations: select via parent job" on public.job_concrete_calculations
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_concrete_calculations.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_concrete_calculations: insert via parent job" on public.job_concrete_calculations
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_concrete_calculations.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_concrete_calculations: admin deletes" on public.job_concrete_calculations
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.job_material_orders enable row level security;

create policy "job_material_orders: select via parent job" on public.job_material_orders
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_material_orders.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_material_orders: insert via parent job" on public.job_material_orders
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_material_orders.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_material_orders: update via parent job" on public.job_material_orders
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.job_cards jc where jc.id = job_material_orders.job_card_id and (public.is_admin() or jc.assigned_technician_id = auth.uid()))
  );

create policy "job_material_orders: admin deletes" on public.job_material_orders
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
