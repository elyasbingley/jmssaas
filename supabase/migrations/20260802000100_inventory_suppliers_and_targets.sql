-- Adds suppliers and moves reorder_threshold from inventory_levels to
-- inventory_items, alongside a new ideal_stock target. "Reorder threshold
-- 4, ideal stock 10, supplier Bunnings" for a tube of clear silicone is
-- described as a property of the ITEM, not of any one location - the same
-- item should alert/reorder the same way regardless of which location is
-- running low, so these move to inventory_items rather than staying a
-- per-(location, item) value on inventory_levels. No admin-facing UI ever
-- exposed a way to set a per-location threshold differently from the
-- hardcoded default of 5 (see the inventory screen's handleAdjust), so
-- nothing real is lost by dropping that column.
--
-- inventory_suppliers follows the same shape/RLS as inventory_categories -
-- a flat, admin-managed, tenant-wide-read list (no hierarchy needed here,
-- unlike categories/subcategories).

create table public.inventory_suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_inventory_suppliers_updated_at
  before update on public.inventory_suppliers
  for each row execute function public.set_updated_at();

create index inventory_suppliers_tenant_id_idx on public.inventory_suppliers (tenant_id);

alter table public.inventory_items
  add column supplier_id uuid references public.inventory_suppliers (id) on delete set null,
  add column ideal_stock integer not null default 0,
  add column reorder_threshold integer not null default 5;

create index inventory_items_supplier_id_idx on public.inventory_items (supplier_id);

alter table public.inventory_levels
  drop column reorder_threshold;

alter table public.inventory_suppliers enable row level security;

create policy "inventory_suppliers: tenant read" on public.inventory_suppliers
  for select using (tenant_id = public.current_tenant_id());

create policy "inventory_suppliers: admin writes - insert" on public.inventory_suppliers
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_suppliers: admin writes - update" on public.inventory_suppliers
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inventory_suppliers: admin writes - delete" on public.inventory_suppliers
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
