-- Phase 3 of the "bug fixes, price book, line-item redesign, PDF generation,
-- nav restructure" pass: the price book is a reusable catalogue of priced
-- services, organised into categories, that a quote/invoice line item can be
-- created from (see the "Add Line Item" search wiring in the app). A price
-- book item's breakdown fields mirror a line item's exactly (description,
-- labour rate/hours, material cost, markup%) since it's a template for one,
-- not a line item itself - no quantity or GST flag here, those only make
-- sense once an item is actually added to a specific quote/invoice.
--
-- RLS follows the same shape already used for quotes/quote_line_items:
-- tenant-wide read, admin-only write. Price book data carries the same
-- margin-revealing fields (labour rate, material cost, markup%) that Phase 2
-- keeps out of the client-facing line item view - that concealment is a
-- UI-level split (LineItemEditor vs LineItemSummary), not an RLS one, same
-- as quote_line_items today, so this is consistent with existing precedent
-- rather than a new gap.

create table public.price_book_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_price_book_categories_updated_at
  before update on public.price_book_categories
  for each row execute function public.set_updated_at();

create index price_book_categories_tenant_id_idx on public.price_book_categories (tenant_id);

create table public.price_book_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  category_id uuid not null references public.price_book_categories (id) on delete cascade,
  description text not null,
  labour_rate_cents bigint not null default 0,
  labour_hours numeric(10, 2) not null default 0,
  material_cost_cents bigint not null default 0,
  markup_percent numeric(6, 2) not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_price_book_items_updated_at
  before update on public.price_book_items
  for each row execute function public.set_updated_at();

create index price_book_items_tenant_id_idx on public.price_book_items (tenant_id);
create index price_book_items_category_id_idx on public.price_book_items (category_id);

-- A variation is a named alternative pricing of the same underlying item
-- (e.g. "Standard" vs "Premium" for a client/efficiency-rate difference) -
-- its own labour/material/markup override, not a diff against the parent.
create table public.price_book_item_variations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  price_book_item_id uuid not null references public.price_book_items (id) on delete cascade,
  name text not null,
  labour_rate_cents bigint not null default 0,
  labour_hours numeric(10, 2) not null default 0,
  material_cost_cents bigint not null default 0,
  markup_percent numeric(6, 2) not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_price_book_item_variations_updated_at
  before update on public.price_book_item_variations
  for each row execute function public.set_updated_at();

create index price_book_item_variations_tenant_id_idx on public.price_book_item_variations (tenant_id);
create index price_book_item_variations_item_id_idx on public.price_book_item_variations (price_book_item_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.price_book_categories enable row level security;

create policy "price_book_categories: tenant read" on public.price_book_categories
  for select using (tenant_id = public.current_tenant_id());

create policy "price_book_categories: admin writes - insert" on public.price_book_categories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_categories: admin writes - update" on public.price_book_categories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_categories: admin writes - delete" on public.price_book_categories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.price_book_items enable row level security;

create policy "price_book_items: tenant read" on public.price_book_items
  for select using (tenant_id = public.current_tenant_id());

create policy "price_book_items: admin writes - insert" on public.price_book_items
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_items: admin writes - update" on public.price_book_items
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_items: admin writes - delete" on public.price_book_items
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.price_book_item_variations enable row level security;

create policy "price_book_item_variations: tenant read" on public.price_book_item_variations
  for select using (tenant_id = public.current_tenant_id());

create policy "price_book_item_variations: admin writes - insert" on public.price_book_item_variations
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_item_variations: admin writes - update" on public.price_book_item_variations
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_item_variations: admin writes - delete" on public.price_book_item_variations
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
