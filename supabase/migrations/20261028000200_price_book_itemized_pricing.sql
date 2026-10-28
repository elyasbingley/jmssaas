-- Price Book gets the full itemized cost-rate/charge-rate/margin split
-- that quote_line_items/invoice_line_items already have - deliberately
-- deferred when unit/warranty_text were added (see the price_book_unit_
-- warranty migration's own comment: "left for a later pass if wanted").
-- This is that pass.
--
-- quantity is new here (quote/invoice lines already had one - it's the
-- document line's own multiplier) and means something slightly different
-- on a catalogue entry: it's the benchmark denominator the itemized
-- total was priced at, e.g. "I did 70lm of ridge re-bed for $X total
-- labour+materials" -> quantity=70, unit='lm' -> this entry becomes a
-- $X/70 per-lm rate, the same mechanism computeItemizedLinePricing
-- already uses for a quote/invoice line (see that function's own
-- comment). gst_applicable is new too, carried through to a new quote/
-- invoice line the same way unit/warranty_text already are, rather than
-- every catalogue-sourced line defaulting to AddLineItemBar's own
-- hardcoded true regardless of what the catalogue item actually is.
alter table public.price_book_items
  add column quantity numeric(12, 2) not null default 1,
  add column gst_applicable boolean not null default true,
  add column pricing_model text not null default 'legacy' check (pricing_model in ('legacy', 'itemized')),
  add column labour_cost_rate_cents bigint,
  add column labour_charge_out_rate_cents bigint,
  add column material_margin_percent numeric,
  add column subcontractor_margin_percent numeric,
  add column waste_percent numeric,
  add column contingency_percent numeric,
  add column tip_fees_cents bigint,
  add column equipment_hire_cents bigint,
  add column travel_cost_cents bigint,
  add column is_subcontracted boolean not null default false,
  add column subcontractor_cost_cents bigint not null default 0;

alter table public.price_book_item_variations
  add column quantity numeric(12, 2) not null default 1,
  add column gst_applicable boolean not null default true,
  add column pricing_model text not null default 'legacy' check (pricing_model in ('legacy', 'itemized')),
  add column labour_cost_rate_cents bigint,
  add column labour_charge_out_rate_cents bigint,
  add column material_margin_percent numeric,
  add column subcontractor_margin_percent numeric,
  add column waste_percent numeric,
  add column contingency_percent numeric,
  add column tip_fees_cents bigint,
  add column equipment_hire_cents bigint,
  add column travel_cost_cents bigint,
  add column is_subcontracted boolean not null default false,
  add column subcontractor_cost_cents bigint not null default 0;

-- Crew/materials child tables, one pair per parent - a price book item and
-- its variations are separate rows (a variation isn't a diff against the
-- parent, see that table's own original comment), so each needs its own
-- children exactly like quote_line_items/invoice_line_items each got their
-- own quote_line_item_crew/invoice_line_item_crew pair rather than sharing
-- one polymorphic table.
create table public.price_book_item_crew (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  price_book_item_id uuid not null references public.price_book_items (id) on delete cascade,
  labour_cost_entry_id uuid references public.labour_cost_entries (id) on delete set null,
  worker_name text not null,
  cost_rate_cents bigint not null default 0,
  charge_out_rate_cents bigint not null default 0,
  hours numeric(8, 2) not null default 0,
  sort_order int not null default 0
);

create index price_book_item_crew_tenant_id_idx on public.price_book_item_crew (tenant_id);
create index price_book_item_crew_item_id_idx on public.price_book_item_crew (price_book_item_id);

create table public.price_book_item_materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  price_book_item_id uuid not null references public.price_book_items (id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_cost_cents bigint not null default 0,
  sort_order int not null default 0
);

create index price_book_item_materials_tenant_id_idx on public.price_book_item_materials (tenant_id);
create index price_book_item_materials_item_id_idx on public.price_book_item_materials (price_book_item_id);

create table public.price_book_item_variation_crew (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  price_book_item_variation_id uuid not null references public.price_book_item_variations (id) on delete cascade,
  labour_cost_entry_id uuid references public.labour_cost_entries (id) on delete set null,
  worker_name text not null,
  cost_rate_cents bigint not null default 0,
  charge_out_rate_cents bigint not null default 0,
  hours numeric(8, 2) not null default 0,
  sort_order int not null default 0
);

create index price_book_item_variation_crew_tenant_id_idx on public.price_book_item_variation_crew (tenant_id);
create index price_book_item_variation_crew_variation_id_idx on public.price_book_item_variation_crew (price_book_item_variation_id);

create table public.price_book_item_variation_materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  price_book_item_variation_id uuid not null references public.price_book_item_variations (id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_cost_cents bigint not null default 0,
  sort_order int not null default 0
);

create index price_book_item_variation_materials_tenant_id_idx on public.price_book_item_variation_materials (tenant_id);
create index price_book_item_variation_materials_variation_id_idx on public.price_book_item_variation_materials (price_book_item_variation_id);

-- RLS - same "tenant read, admin writes" shape as price_book_items/
-- price_book_item_variations themselves (and quote_line_item_crew/
-- materials' own, for that matter).
alter table public.price_book_item_crew enable row level security;
alter table public.price_book_item_materials enable row level security;
alter table public.price_book_item_variation_crew enable row level security;
alter table public.price_book_item_variation_materials enable row level security;

create policy "price_book_item_crew: tenant read" on public.price_book_item_crew
  for select using (tenant_id = public.current_tenant_id());
create policy "price_book_item_crew: admin writes - insert" on public.price_book_item_crew
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_crew: admin writes - update" on public.price_book_item_crew
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_crew: admin writes - delete" on public.price_book_item_crew
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_item_materials: tenant read" on public.price_book_item_materials
  for select using (tenant_id = public.current_tenant_id());
create policy "price_book_item_materials: admin writes - insert" on public.price_book_item_materials
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_materials: admin writes - update" on public.price_book_item_materials
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_materials: admin writes - delete" on public.price_book_item_materials
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_item_variation_crew: tenant read" on public.price_book_item_variation_crew
  for select using (tenant_id = public.current_tenant_id());
create policy "price_book_item_variation_crew: admin writes - insert" on public.price_book_item_variation_crew
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_variation_crew: admin writes - update" on public.price_book_item_variation_crew
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_variation_crew: admin writes - delete" on public.price_book_item_variation_crew
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_item_variation_materials: tenant read" on public.price_book_item_variation_materials
  for select using (tenant_id = public.current_tenant_id());
create policy "price_book_item_variation_materials: admin writes - insert" on public.price_book_item_variation_materials
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_variation_materials: admin writes - update" on public.price_book_item_variation_materials
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "price_book_item_variation_materials: admin writes - delete" on public.price_book_item_variation_materials
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
