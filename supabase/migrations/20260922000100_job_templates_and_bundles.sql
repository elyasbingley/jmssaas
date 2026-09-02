-- Job Templates - a reusable starting point for a new job (name, service
-- category, lifecycle stage, description), picked from Jobs.tsx's "New Job"
-- modal instead of filling every field by hand each time. The template's
-- own `name` doubles as the new job's default title (still editable before
-- saving) - no separate title field, since the person's brief didn't call
-- for one and a template is generally named for what it is anyway (e.g.
-- "Hot Water System Replacement").
--
-- Line Item Bundles - a reusable set of line items (e.g. everything a hot
-- water system replacement needs) inserted together into a quote/invoice
-- in one click, rather than added one at a time. Each bundle item is either
-- a standalone custom line (own description/rate/hours/cost, edited only
-- here) or linked to an existing Price Book item via price_book_item_id -
-- when linked, the bundle always uses that item's CURRENT catalogue price
-- at insertion time (see AddLineItemBar's own comment), not a stale copy
-- frozen when the bundle was authored, so price_book_item_id is the only
-- thing that matters for a linked item - description stays null and the
-- rate/hours/cost/markup columns stay at their zero default, all ignored.
--
-- Both tables follow the same shape/RLS already established by
-- price_book_categories/service_categories: tenant-scoped, admin-only
-- writes, tenant-wide read.

create table public.job_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  service_category_id uuid references public.service_categories (id) on delete set null,
  lifecycle_stage_id uuid references public.job_lifecycle_stages (id) on delete set null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_templates_updated_at
  before update on public.job_templates
  for each row execute function public.set_updated_at();

create index job_templates_tenant_id_idx on public.job_templates (tenant_id);

alter table public.job_templates enable row level security;

create policy "job_templates: tenant read" on public.job_templates
  for select using (tenant_id = public.current_tenant_id());

create policy "job_templates: admin writes - insert" on public.job_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "job_templates: admin writes - update" on public.job_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "job_templates: admin writes - delete" on public.job_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------

create table public.line_item_bundles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_line_item_bundles_updated_at
  before update on public.line_item_bundles
  for each row execute function public.set_updated_at();

create index line_item_bundles_tenant_id_idx on public.line_item_bundles (tenant_id);

create table public.line_item_bundle_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  bundle_id uuid not null references public.line_item_bundles (id) on delete cascade,
  -- Set for a catalogue-linked item (description/rate/hours/cost below are
  -- ignored - see the header comment); null for a standalone custom item,
  -- which uses those columns directly instead.
  price_book_item_id uuid references public.price_book_items (id) on delete set null,
  description text,
  labour_rate_cents bigint not null default 0,
  labour_hours numeric(10, 2) not null default 0,
  material_cost_cents bigint not null default 0,
  markup_percent numeric(6, 2) not null default 0,
  -- How many of this item a use of the bundle adds (e.g. 2x expansion
  -- valves) - price_book_items itself has no quantity concept (it's a unit
  -- template), so this always lives on the bundle item regardless of
  -- whether it's linked or standalone.
  quantity numeric(10, 2) not null default 1,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_item_bundle_items_owner_check
    check (price_book_item_id is not null or (description is not null and length(trim(description)) > 0))
);

create trigger set_line_item_bundle_items_updated_at
  before update on public.line_item_bundle_items
  for each row execute function public.set_updated_at();

create index line_item_bundle_items_tenant_id_idx on public.line_item_bundle_items (tenant_id);
create index line_item_bundle_items_bundle_id_idx on public.line_item_bundle_items (bundle_id);

alter table public.line_item_bundles enable row level security;
alter table public.line_item_bundle_items enable row level security;

create policy "line_item_bundles: tenant read" on public.line_item_bundles
  for select using (tenant_id = public.current_tenant_id());

create policy "line_item_bundles: admin writes - insert" on public.line_item_bundles
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "line_item_bundles: admin writes - update" on public.line_item_bundles
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "line_item_bundles: admin writes - delete" on public.line_item_bundles
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "line_item_bundle_items: tenant read" on public.line_item_bundle_items
  for select using (tenant_id = public.current_tenant_id());

create policy "line_item_bundle_items: admin writes - insert" on public.line_item_bundle_items
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "line_item_bundle_items: admin writes - update" on public.line_item_bundle_items
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "line_item_bundle_items: admin writes - delete" on public.line_item_bundle_items
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
