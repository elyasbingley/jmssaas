-- Multi-location inventory tracking: `inventory_locations` is a physical
-- place stock lives (a ute, the main warehouse, a shelf), `inventory_levels`
-- is the quantity of a given price_book_items row held at a given location -
-- the same catalogue item price book already uses for quote/invoice line
-- items, reused here rather than a separate "inventory item" catalogue, so
-- "add this to the job" and "we're low on this" both point at one canonical
-- item.
--
-- RLS deliberately splits the two tables differently:
--   - inventory_locations (setting up "Ute 1"/"Main Warehouse") is
--     occasional setup/configuration, so it follows the admin-write,
--     tenant-read shape already used for price_book_categories and
--     job_lifecycle_stages.
--   - inventory_levels (the day-to-day +/- quantity taps a technician makes
--     from their truck) follows the tenant-wide-write shape already used for
--     clients - "small crew, everyone needs to be able to update it", not an
--     admin-gated action. Deleting a stock line (removing an item from a
--     location entirely) stays admin-only, matching the clients precedent's
--     own delete/write split.

create table public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_inventory_locations_updated_at
  before update on public.inventory_locations
  for each row execute function public.set_updated_at();

create index inventory_locations_tenant_id_idx on public.inventory_locations (tenant_id);

create table public.inventory_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  location_id uuid not null references public.inventory_locations (id) on delete cascade,
  item_id uuid not null references public.price_book_items (id) on delete cascade,
  quantity integer not null default 0,
  reorder_threshold integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, item_id)
);

create trigger set_inventory_levels_updated_at
  before update on public.inventory_levels
  for each row execute function public.set_updated_at();

create index inventory_levels_tenant_id_idx on public.inventory_levels (tenant_id);
create index inventory_levels_location_id_idx on public.inventory_levels (location_id);
create index inventory_levels_item_id_idx on public.inventory_levels (item_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.inventory_locations enable row level security;

create policy "inventory_locations: tenant read" on public.inventory_locations
  for select using (tenant_id = public.current_tenant_id());

create policy "inventory_locations: admin writes - insert" on public.inventory_locations
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_locations: admin writes - update" on public.inventory_locations
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_locations: admin writes - delete" on public.inventory_locations
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.inventory_levels enable row level security;

create policy "inventory_levels: tenant isolation - select" on public.inventory_levels
  for select using (tenant_id = public.current_tenant_id());

create policy "inventory_levels: tenant isolation - insert" on public.inventory_levels
  for insert with check (tenant_id = public.current_tenant_id());

create policy "inventory_levels: tenant isolation - update" on public.inventory_levels
  for update using (tenant_id = public.current_tenant_id());

create policy "inventory_levels: admin deletes" on public.inventory_levels
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
