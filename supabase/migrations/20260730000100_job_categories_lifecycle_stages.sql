-- Service categories (a simple tag on a job, e.g. "Roof Restoration",
-- "Gutter Cleaning") and customizable job lifecycle stages (an admin-
-- configurable, ordered pipeline - e.g. "Enquiry" / "Quote Sent" /
-- "Deposit Paid" / "In Progress" - distinct from the existing job_cards
-- `status` enum). Both tables follow the same shape/RLS pattern already
-- established by price_book_categories: tenant-scoped, admin-only writes,
-- tenant-wide read.
--
-- `status` (job_status enum: new/scheduled/in_progress/completed/invoiced)
-- is NOT replaced or removed here - too much of the app already keys off
-- it (the Schedule/dispatch board's "unassigned" filter, Job Costing,
-- RLS-adjacent status chips on the job detail screen). `lifecycle_stage_id`
-- is a separate, independently admin-customizable pipeline layered on top;
-- the two are not kept in sync with each other after this migration's one-
-- time backfill - see docs/SETUP.md for that judgment call spelled out.

create table public.service_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_service_categories_updated_at
  before update on public.service_categories
  for each row execute function public.set_updated_at();

create index service_categories_tenant_id_idx on public.service_categories (tenant_id);

create table public.job_lifecycle_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  position integer not null,
  color text,
  is_system_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_lifecycle_stages_updated_at
  before update on public.job_lifecycle_stages
  for each row execute function public.set_updated_at();

create index job_lifecycle_stages_tenant_id_idx on public.job_lifecycle_stages (tenant_id);

alter table public.job_cards
  add column service_category_id uuid references public.service_categories (id) on delete set null,
  add column lifecycle_stage_id uuid references public.job_lifecycle_stages (id) on delete set null;

create index job_cards_service_category_id_idx on public.job_cards (service_category_id);
create index job_cards_lifecycle_stage_id_idx on public.job_cards (lifecycle_stage_id);

-- ---------------------------------------------------------------------------
-- Default stages, seeded for every tenant - names chosen to match the
-- existing job_status enum values exactly (1:1), so the backfill below is
-- unambiguous. is_system_default marks these as the built-in set an admin
-- can still rename/recolor/reorder/delete like any other stage (nothing in
-- the schema locks them); it's just a flag for the UI to use if it ever
-- wants to warn before deleting one.
-- ---------------------------------------------------------------------------

create or replace function public.seed_default_lifecycle_stages(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.job_lifecycle_stages (tenant_id, name, position, is_system_default)
  values
    (p_tenant_id, 'New', 1, true),
    (p_tenant_id, 'Scheduled', 2, true),
    (p_tenant_id, 'In Progress', 3, true),
    (p_tenant_id, 'Completed', 4, true),
    (p_tenant_id, 'Invoiced', 5, true);
end;
$$;

-- Backfill for every tenant that already exists.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_lifecycle_stages(t.id);
  end loop;
end;
$$;

-- Auto-seed for any tenant created after this migration, same reasoning as
-- every other "written as if there were many tenants" piece of this schema
-- even though Phase 1 only has one.
create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
as $$
begin
  perform public.seed_default_lifecycle_stages(new.id);
  return new;
end;
$$;

create trigger seed_lifecycle_stages_on_tenant_insert
  after insert on public.tenants
  for each row execute function public.handle_new_tenant();

-- One-time backfill: link each existing job_card to the default stage
-- matching its current status enum value, for that job's own tenant.
update public.job_cards jc
set lifecycle_stage_id = ls.id
from public.job_lifecycle_stages ls
where ls.tenant_id = jc.tenant_id
  and ls.is_system_default = true
  and ls.name = (
    case jc.status
      when 'new' then 'New'
      when 'scheduled' then 'Scheduled'
      when 'in_progress' then 'In Progress'
      when 'completed' then 'Completed'
      when 'invoiced' then 'Invoiced'
    end
  );

-- ---------------------------------------------------------------------------
-- RLS - tenant-wide read (everyone needs to see category tags/stage
-- badges), admin-only write, matching price_book_categories exactly.
-- ---------------------------------------------------------------------------

alter table public.service_categories enable row level security;

create policy "service_categories: tenant read" on public.service_categories
  for select using (tenant_id = public.current_tenant_id());

create policy "service_categories: admin writes - insert" on public.service_categories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "service_categories: admin writes - update" on public.service_categories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "service_categories: admin writes - delete" on public.service_categories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.job_lifecycle_stages enable row level security;

create policy "job_lifecycle_stages: tenant read" on public.job_lifecycle_stages
  for select using (tenant_id = public.current_tenant_id());

create policy "job_lifecycle_stages: admin writes - insert" on public.job_lifecycle_stages
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "job_lifecycle_stages: admin writes - update" on public.job_lifecycle_stages
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "job_lifecycle_stages: admin writes - delete" on public.job_lifecycle_stages
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
