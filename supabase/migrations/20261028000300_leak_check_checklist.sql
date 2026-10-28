-- Leak Check Checklist - a job tool for a residential plumbing leak
-- inspection (water meter test, taps, toilets, under-sink/basin plumbing,
-- hot water systems, visible pipes). Every home has a different number of
-- fixtures, so this is two layers like line_item_bundles/job_templates:
--
-- - leak_check_templates (+ _template_categories/_template_items): admin-
--   managed, tenant-wide read, a library of named starting-point checklists
--   (e.g. "Quick Check" vs "Full Inspection"). Categories are themselves
--   part of the template (not a fixed hardcoded set) so a tenant can add a
--   category a standard inspection doesn't cover (e.g. irrigation). Same
--   shape/RLS as job_templates/line_item_bundles.
--
-- - job_leak_checks (+ _categories/_items/_item_files): one per inspection
--   run on a job (append-style like job_measurements, not one row per job -
--   a property can legitimately be re-checked). Seeded by copying a chosen
--   template's categories/items onto the job the moment it's started, then
--   freely edited from there - add/remove a fixture row, mark a result,
--   add a category on the fly - exactly like a bundle's items are copied
--   into a quote and then become that quote's own rows. Items that don't
--   fit a fixed template-copy model (two different homes never have the
--   same number of taps) are why this needs its own rows per fixture
--   rather than a fixed set of boolean columns.
--
-- item_type distinguishes the one structured item (the water meter test:
-- shut everything off, read the meter, wait, read again) from every other
-- fixture row (result + notes + photos): 'water_meter' uses
-- meter_start_reading/meter_end_reading/meter_wait_minutes, 'standard' uses
-- result. Both share one table rather than two - same "one row, mode-
-- dependent optional columns" convention price_book_items already uses for
-- legacy vs itemized pricing, rather than a join for what's fundamentally
-- one concept (a checklist item) with two shapes.
--
-- job_card_id is denormalized onto every child row (categories/items/
-- item_files), not just job_leak_checks itself - same convention as task_
-- notes/task_files carrying their own job_card_id alongside task_id. It's
-- what lets PowerSync's sync rules scope "every row belonging to a job
-- assigned to me" without a multi-hop join, which the sync-rules.yaml
-- header comment already notes isn't confirmed to be supported. Set by the
-- application at insert time (copied from the parent job_leak_check), the
-- same way task_notes/task_files do it - no trigger needed since a leak
-- check is never moved to a different job after creation.
--
-- RLS on every table here mirrors job_measurements exactly (admin or the
-- job's assigned technician can read/write; delete is admin-only) - this is
-- the same "job-scoped field data" shape. Child tables use their own
-- denormalized job_card_id directly rather than joining through
-- job_leak_checks, which keeps every policy here a plain one-hop exists()
-- against job_cards, identical in shape to job_measurements' own.
--
-- share_token (on job_leak_checks) and the public-share RPC/page that reads
-- it are deliberately NOT built in this migration - see the get_quote_for_
-- approval/access_token pattern in the quote_invoice_approval migration,
-- which this will mirror in a later pass: a nullable `text unique` token,
-- generated on demand (not at row-creation time) by a dedicated RPC.

create table public.leak_check_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  description text,
  is_archived boolean not null default false,
  sort_order int not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_leak_check_templates_updated_at
  before update on public.leak_check_templates
  for each row execute function public.set_updated_at();

create index leak_check_templates_tenant_id_idx on public.leak_check_templates (tenant_id);

create table public.leak_check_template_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  template_id uuid not null references public.leak_check_templates (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_leak_check_template_categories_updated_at
  before update on public.leak_check_template_categories
  for each row execute function public.set_updated_at();

create index leak_check_template_categories_tenant_id_idx on public.leak_check_template_categories (tenant_id);
create index leak_check_template_categories_template_id_idx on public.leak_check_template_categories (template_id);

create table public.leak_check_template_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  template_id uuid not null references public.leak_check_templates (id) on delete cascade,
  category_id uuid not null references public.leak_check_template_categories (id) on delete cascade,
  item_type text not null default 'standard' check (item_type in ('standard', 'water_meter')),
  label text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_leak_check_template_items_updated_at
  before update on public.leak_check_template_items
  for each row execute function public.set_updated_at();

create index leak_check_template_items_tenant_id_idx on public.leak_check_template_items (tenant_id);
create index leak_check_template_items_template_id_idx on public.leak_check_template_items (template_id);
create index leak_check_template_items_category_id_idx on public.leak_check_template_items (category_id);

-- ---------------------------------------------------------------------------

create table public.job_leak_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  template_id uuid references public.leak_check_templates (id) on delete set null,
  title text not null default 'Leak Check',
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  share_token text unique,
  shared_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_leak_checks_updated_at
  before update on public.job_leak_checks
  for each row execute function public.set_updated_at();

create index job_leak_checks_tenant_id_idx on public.job_leak_checks (tenant_id);
create index job_leak_checks_job_card_id_idx on public.job_leak_checks (job_card_id);

create table public.job_leak_check_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  leak_check_id uuid not null references public.job_leak_checks (id) on delete cascade,
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_leak_check_categories_updated_at
  before update on public.job_leak_check_categories
  for each row execute function public.set_updated_at();

create index job_leak_check_categories_tenant_id_idx on public.job_leak_check_categories (tenant_id);
create index job_leak_check_categories_leak_check_id_idx on public.job_leak_check_categories (leak_check_id);
create index job_leak_check_categories_job_card_id_idx on public.job_leak_check_categories (job_card_id);

create table public.job_leak_check_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  leak_check_id uuid not null references public.job_leak_checks (id) on delete cascade,
  category_id uuid not null references public.job_leak_check_categories (id) on delete cascade,
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  item_type text not null default 'standard' check (item_type in ('standard', 'water_meter')),
  label text not null,
  result text check (result in ('pass', 'fail', 'na')),
  notes text,
  -- water_meter rows only - see header comment. nullable/unused on a
  -- 'standard' row.
  meter_start_reading numeric(10, 3),
  meter_end_reading numeric(10, 3),
  meter_wait_minutes numeric(6, 2),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_leak_check_items_updated_at
  before update on public.job_leak_check_items
  for each row execute function public.set_updated_at();

create index job_leak_check_items_tenant_id_idx on public.job_leak_check_items (tenant_id);
create index job_leak_check_items_leak_check_id_idx on public.job_leak_check_items (leak_check_id);
create index job_leak_check_items_category_id_idx on public.job_leak_check_items (category_id);
create index job_leak_check_items_job_card_id_idx on public.job_leak_check_items (job_card_id);

-- Photo attachments per item - same shape as job_files/task_files
-- (metadata row; the bytes live in Storage/PowerSync's attachment queue).
create table public.job_leak_check_item_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  item_id uuid not null references public.job_leak_check_items (id) on delete cascade,
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index job_leak_check_item_files_tenant_id_idx on public.job_leak_check_item_files (tenant_id);
create index job_leak_check_item_files_item_id_idx on public.job_leak_check_item_files (item_id);
create index job_leak_check_item_files_job_card_id_idx on public.job_leak_check_item_files (job_card_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.leak_check_templates enable row level security;
alter table public.leak_check_template_categories enable row level security;
alter table public.leak_check_template_items enable row level security;

create policy "leak_check_templates: tenant read" on public.leak_check_templates
  for select using (tenant_id = public.current_tenant_id());
create policy "leak_check_templates: admin writes - insert" on public.leak_check_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "leak_check_templates: admin writes - update" on public.leak_check_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "leak_check_templates: admin writes - delete" on public.leak_check_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "leak_check_template_categories: tenant read" on public.leak_check_template_categories
  for select using (tenant_id = public.current_tenant_id());
create policy "leak_check_template_categories: admin writes - insert" on public.leak_check_template_categories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "leak_check_template_categories: admin writes - update" on public.leak_check_template_categories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "leak_check_template_categories: admin writes - delete" on public.leak_check_template_categories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "leak_check_template_items: tenant read" on public.leak_check_template_items
  for select using (tenant_id = public.current_tenant_id());
create policy "leak_check_template_items: admin writes - insert" on public.leak_check_template_items
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "leak_check_template_items: admin writes - update" on public.leak_check_template_items
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "leak_check_template_items: admin writes - delete" on public.leak_check_template_items
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------

alter table public.job_leak_checks enable row level security;
alter table public.job_leak_check_categories enable row level security;
alter table public.job_leak_check_items enable row level security;
alter table public.job_leak_check_item_files enable row level security;

create policy "job_leak_checks: select via parent job" on public.job_leak_checks
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_checks.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_checks: insert via parent job" on public.job_leak_checks
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_checks.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_checks: update via parent job" on public.job_leak_checks
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_checks.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_checks: admin deletes" on public.job_leak_checks
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "job_leak_check_categories: select via parent job" on public.job_leak_check_categories
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_categories.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_categories: insert via parent job" on public.job_leak_check_categories
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_categories.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_categories: update via parent job" on public.job_leak_check_categories
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_categories.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_categories: delete via parent job" on public.job_leak_check_categories
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_categories.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_leak_check_items: select via parent job" on public.job_leak_check_items
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_items.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_items: insert via parent job" on public.job_leak_check_items
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_items.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_items: update via parent job" on public.job_leak_check_items
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_items.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_items: delete via parent job" on public.job_leak_check_items
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_items.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_leak_check_item_files: select via parent job" on public.job_leak_check_item_files
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_item_files.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_item_files: insert via parent job" on public.job_leak_check_item_files
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_item_files.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
create policy "job_leak_check_item_files: delete via parent job" on public.job_leak_check_item_files
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_leak_check_item_files.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
