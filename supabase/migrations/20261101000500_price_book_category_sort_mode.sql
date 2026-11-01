-- Price Book category sort order is customisable (sort_order already
-- existed on price_book_categories) but there was no way to switch to
-- alphabetical order, and nothing in the UI let an admin edit sort_order at
-- all - new categories just got appended. This adds a per-tenant toggle
-- between "custom" (admin-controlled sort_order, editable via a reorder UI)
-- and "alphabetical" (always A-Z by name, sort_order ignored).
--
-- One row per tenant, same shape as cost_of_ops_settings - the app upserts
-- it lazily on first change rather than backfilling one per existing
-- tenant, so a missing row just means "default: custom" client-side.

create type public.price_book_sort_mode as enum ('custom', 'alphabetical');

create table public.price_book_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,
  category_sort_mode public.price_book_sort_mode not null default 'custom',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_price_book_settings_updated_at
  before update on public.price_book_settings
  for each row execute function public.set_updated_at();

alter table public.price_book_settings enable row level security;

create policy "price_book_settings: tenant read" on public.price_book_settings
  for select using (tenant_id = public.current_tenant_id());

create policy "price_book_settings: admin writes - insert" on public.price_book_settings
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "price_book_settings: admin writes - update" on public.price_book_settings
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
