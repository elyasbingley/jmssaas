-- Two additions to the Real Estate & Strata module:
--
-- 1. property_tenants - properties.tenant_name/tenant_phone/tenant_email
--    only ever supported a single occupant. Rather than replace those flat
--    columns (they're read from 14+ places - PDFs, the public approval
--    page, mobile, InvoiceDetail, RecurringMaintenanceEngine), this adds a
--    parallel table for every ADDITIONAL tenant beyond that one, same shape
--    as client_contacts.
--
-- 2. agencies.client_id - closes the "double handling" gap where an agency
--    and its billing client were two completely unlinked records. Nullable
--    so existing agencies aren't broken; once set, job creation can derive
--    client_id from the agency instead of requiring it to be picked by hand.

create table public.property_tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  property_id uuid not null references public.properties (id) on delete cascade,
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create index property_tenants_tenant_id_idx on public.property_tenants (tenant_id);
create index property_tenants_property_id_idx on public.property_tenants (property_id);

alter table public.property_tenants enable row level security;

create policy "property_tenants: tenant read" on public.property_tenants
  for select using (tenant_id = public.current_tenant_id());

create policy "property_tenants: admin writes - insert" on public.property_tenants
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "property_tenants: admin writes - update" on public.property_tenants
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "property_tenants: admin writes - delete" on public.property_tenants
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.agencies add column client_id uuid references public.clients (id) on delete set null;
