-- Additional contacts on a job beyond the client itself (a second
-- homeowner, a tenant, an on-site foreman...) - a job may have any number
-- of these regardless of whether it's a Real Estate & Strata job. Distinct
-- from property_managers (real_estate_strata migration), which only ever
-- applies to is_real_estate_job jobs.

create table public.job_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  name text not null,
  role_label text,
  phone text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index job_contacts_tenant_id_idx on public.job_contacts (tenant_id);
create index job_contacts_job_card_id_idx on public.job_contacts (job_card_id);

-- Same "visibility follows the parent job card" shape as job_notes/
-- job_files (see rls_policies migration) - unlike those two, an assigned
-- technician can also update/delete a contact they got wrong, since this
-- is a structured record rather than an append-only log entry.

alter table public.job_contacts enable row level security;

create policy "job_contacts: select via parent job" on public.job_contacts
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_contacts.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_contacts: insert via parent job" on public.job_contacts
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_contacts.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_contacts: update via parent job" on public.job_contacts
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_contacts.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_contacts: delete via parent job" on public.job_contacts
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_contacts.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
