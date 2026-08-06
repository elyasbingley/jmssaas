-- Decouples inventory from the price book catalogue and gives it its own
-- two-level, fully customisable category hierarchy instead. The
-- inventory_stock_control migration originally pointed inventory_levels at
-- price_book_items, reasoning that quote/invoice pricing items and
-- physical stock items were "the same underlying thing" - in practice
-- they're not: inventory tracks materials/tools (a tube of silicone, a
-- cordless drill) that are never priced or put on a quote, so that
-- assumption was wrong and is reversed here in favour of a standalone
-- catalogue.
--
-- The hierarchy an admin builds is: inventory_categories (top level, e.g.
-- "Material", "Tools", "First Aid Kit") -> inventory_subcategories
-- (optional second level under a category, e.g. "Roofing"/"Plumbing"/
-- "Tapware" under Material, or "Power Tools"/"Hand Tools" under Tools) ->
-- inventory_items (the actual thing being stocked, e.g. "Silicone tube -
-- clear"). subcategory_id is nullable on inventory_items because not
-- every category needs a second level (a "First Aid Kit" category might
-- just hold items directly, with no subcategories at all).
--
-- RLS mirrors price_book_categories/price_book_items exactly - tenant-wide
-- read, admin-only write - since these are catalogue/setup data (what
-- items and categories exist), not the day-to-day quantity numbers.
-- inventory_levels itself (already tenant-wide writable per the prior
-- migration) is unaffected by this - only what item_id points at changes.

create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  color text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_inventory_categories_updated_at
  before update on public.inventory_categories
  for each row execute function public.set_updated_at();

create index inventory_categories_tenant_id_idx on public.inventory_categories (tenant_id);

create table public.inventory_subcategories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  category_id uuid not null references public.inventory_categories (id) on delete cascade,
  name text not null,
  color text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_inventory_subcategories_updated_at
  before update on public.inventory_subcategories
  for each row execute function public.set_updated_at();

create index inventory_subcategories_tenant_id_idx on public.inventory_subcategories (tenant_id);
create index inventory_subcategories_category_id_idx on public.inventory_subcategories (category_id);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  category_id uuid not null references public.inventory_categories (id) on delete cascade,
  subcategory_id uuid references public.inventory_subcategories (id) on delete set null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_inventory_items_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

create index inventory_items_tenant_id_idx on public.inventory_items (tenant_id);
create index inventory_items_category_id_idx on public.inventory_items (category_id);
create index inventory_items_subcategory_id_idx on public.inventory_items (subcategory_id);

-- ---------------------------------------------------------------------------
-- Repoint inventory_levels.item_id at inventory_items instead of
-- price_book_items. No real stock data exists to migrate yet (this whole
-- feature was still being wired up to PowerSync when this need came up),
-- so existing rows are cleared rather than attempting to remap a
-- price_book_items id to a nonexistent inventory_items id.
-- ---------------------------------------------------------------------------

delete from public.inventory_levels;

alter table public.inventory_levels
  drop constraint inventory_levels_item_id_fkey;

alter table public.inventory_levels
  add constraint inventory_levels_item_id_fkey
  foreign key (item_id) references public.inventory_items (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.inventory_categories enable row level security;

create policy "inventory_categories: tenant read" on public.inventory_categories
  for select using (tenant_id = public.current_tenant_id());

create policy "inventory_categories: admin writes - insert" on public.inventory_categories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_categories: admin writes - update" on public.inventory_categories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_categories: admin writes - delete" on public.inventory_categories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.inventory_subcategories enable row level security;

create policy "inventory_subcategories: tenant read" on public.inventory_subcategories
  for select using (tenant_id = public.current_tenant_id());

create policy "inventory_subcategories: admin writes - insert" on public.inventory_subcategories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_subcategories: admin writes - update" on public.inventory_subcategories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_subcategories: admin writes - delete" on public.inventory_subcategories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.inventory_items enable row level security;

create policy "inventory_items: tenant read" on public.inventory_items
  for select using (tenant_id = public.current_tenant_id());

create policy "inventory_items: admin writes - insert" on public.inventory_items
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_items: admin writes - update" on public.inventory_items
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_items: admin writes - delete" on public.inventory_items
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
