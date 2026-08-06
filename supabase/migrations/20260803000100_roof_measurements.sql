-- Built-in satellite roof measurement tool: a technician (or admin) draws
-- one or more roof facets as polygons over a satellite map, sets a pitch
-- per facet, and saves the result against the job. job_measurements is an
-- append-style history table like job_notes (each save is a new row, not
-- an update-in-place single record per job) - a roof can legitimately be
-- re-measured over time (extension, revised quote, dispute), and keeping
-- every past measurement is more useful than overwriting the last one.
--
-- `facets` stores the full per-facet breakdown (id, name, pitch_degrees,
-- flat_area_sqm, true_area_sqm, coordinates) as jsonb rather than a child
-- table - a facet has no independent lifecycle of its own (it's never
-- queried, filtered or joined against outside its parent measurement), so
-- a normalised child table would add migration/RLS/PowerSync overhead for
-- no real benefit. total_flat_area_sqm/total_true_area_sqm are stored
-- redundantly (derivable by summing facets) purely so the Jobs
-- list/detail screens and any future reporting can read one flat number
-- without parsing jsonb.
--
-- RLS mirrors job_notes/job_files exactly (visibility and write access
-- follow the parent job_cards row - admin sees/edits everything, a
-- technician only their own assigned job's measurements) since this is
-- the same "job-scoped field data" shape as notes and photos. Unlike
-- job_notes (append-only, no update policy) but like an editable record,
-- an update policy is included - a technician mid-measurement may need to
-- fix a mis-tapped point or re-save after adjusting a pitch, not just
-- create a new row every time. Delete is admin-only, matching job_files.

create table public.job_measurements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  title text not null default 'Roof Measurement',
  facets jsonb not null default '[]'::jsonb,
  total_flat_area_sqm numeric(10, 2) not null default 0,
  total_true_area_sqm numeric(10, 2) not null default 0,
  snapshot_path text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_measurements_updated_at
  before update on public.job_measurements
  for each row execute function public.set_updated_at();

create index job_measurements_tenant_id_idx on public.job_measurements (tenant_id);
create index job_measurements_job_card_id_idx on public.job_measurements (job_card_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.job_measurements enable row level security;

create policy "job_measurements: select via parent job" on public.job_measurements
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_measurements.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_measurements: insert via parent job" on public.job_measurements
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_measurements.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_measurements: update via parent job" on public.job_measurements
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_measurements.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_measurements: admin deletes" on public.job_measurements
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
