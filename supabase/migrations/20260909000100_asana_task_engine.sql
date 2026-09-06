-- Asana-style project management layered onto the existing tasks table -
-- projects, Kanban sections, subtasks, dependencies, custom fields, and an
-- activity log. Deliberate scope decisions, spelled out here rather than
-- scattered across comments below:
--
-- - `tasks.status` (todo/in_progress/done) is NOT replaced - same
--   reasoning as job_lifecycle_stages alongside job_cards.status (see the
--   job_categories_lifecycle_stages migration's own comment): too much
--   already keys off it (the Complete button, mobile's quick-cycle chip,
--   subtask rollup, the dependency guardrail's "mark complete" check).
--   `section_id` below is a separate, purely organisational Kanban-column
--   position within a project, independent of completion state - moving a
--   card to a "Done"-looking section does not itself flip `status`, the
--   same way moving a job to a "Completed"-named lifecycle stage doesn't
--   either. An admin who wants that behaviour names a section "Done" and
--   drags the completed card there themselves.
-- - The JMS "Job" link reuses the *existing* `job_card_id` column (this
--   schema's job entity is `job_cards`, not a separate `jobs` table) -
--   `client_id`/`property_id` below are genuinely new.
-- - No new `task_comments` table - the existing `task_notes` table
--   already is exactly that (author + body + timestamp, already
--   PowerSync-synced for offline mobile use per the ux_overhaul
--   migration), so it's reused as the comment half of the "Activity &
--   Comment Feed" rather than duplicated. `task_activity_logs` below is
--   the system-generated half (field-change history), populated by a
--   trigger rather than scattered application-side insert calls at every
--   mutation site - one place to get right, not N.
-- - No project-membership/collaborator table and no notification wiring
--   for milestone completion - there's no existing "who's on this
--   project" concept to notify, and building one plus wiring it into the
--   communication/dispatch engine is a separate feature in its own right.
--   Milestone completion still gets its own `task_activity_logs` entry
--   (field_name = 'milestone_completed'), just not a push/email.

create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.task_custom_field_type as enum ('text', 'number', 'dropdown', 'date');

-- ---------------------------------------------------------------------------
-- task_projects / task_sections - same tenant-scoped, admin-writes/tenant-
-- reads shape as job_lifecycle_stages/service_categories.
-- ---------------------------------------------------------------------------

create table public.task_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  description text,
  color_hex text not null default '#3B82F6',
  icon text not null default 'folder',
  view_type text not null default 'BOARD' check (view_type in ('BOARD', 'LIST', 'CALENDAR', 'TIMELINE')),
  is_archived boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_task_projects_updated_at
  before update on public.task_projects
  for each row execute function public.set_updated_at();

create index task_projects_tenant_id_idx on public.task_projects (tenant_id);

create table public.task_sections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  project_id uuid not null references public.task_projects (id) on delete cascade,
  name text not null,
  position_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index task_sections_project_id_idx on public.task_sections (project_id);

-- ---------------------------------------------------------------------------
-- tasks - new columns for project/board membership, subtasks, priority,
-- milestones, scheduling, effort tracking, and the client/property JMS
-- links (job linking reuses the existing job_card_id column).
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column project_id uuid references public.task_projects (id) on delete set null,
  add column section_id uuid references public.task_sections (id) on delete set null,
  add column parent_task_id uuid references public.tasks (id) on delete cascade,
  add column priority public.task_priority not null default 'medium',
  add column is_milestone boolean not null default false,
  add column start_date date,
  add column position_order integer not null default 0,
  add column estimated_hours numeric(6, 2),
  add column actual_hours numeric(6, 2),
  add column client_id uuid references public.clients (id) on delete set null,
  add column property_id uuid references public.properties (id) on delete set null;

create index tasks_project_id_idx on public.tasks (project_id);
create index tasks_section_id_idx on public.tasks (section_id);
create index tasks_parent_task_id_idx on public.tasks (parent_task_id);
create index tasks_client_id_idx on public.tasks (client_id);
create index tasks_property_id_idx on public.tasks (property_id);

-- ---------------------------------------------------------------------------
-- task_dependencies - "blocking_task_id blocks dependent_task_id". Directed
-- edge, no self-loops, no duplicate edges.
-- ---------------------------------------------------------------------------

create table public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  blocking_task_id uuid not null references public.tasks (id) on delete cascade,
  dependent_task_id uuid not null references public.tasks (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint task_dependencies_no_self_loop check (blocking_task_id <> dependent_task_id),
  constraint task_dependencies_unique_edge unique (blocking_task_id, dependent_task_id)
);

create index task_dependencies_blocking_idx on public.task_dependencies (blocking_task_id);
create index task_dependencies_dependent_idx on public.task_dependencies (dependent_task_id);

-- ---------------------------------------------------------------------------
-- task_custom_fields (per-project field definitions) / task_custom_field_
-- values (per-task values, one row per task+field). Only one of value_text/
-- value_number/value_date is populated, matching the field's own field_type
-- - left as three nullable columns rather than a single jsonb value so
-- NUMBER/DATE fields stay natively sortable/filterable in SQL.
-- ---------------------------------------------------------------------------

create table public.task_custom_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  project_id uuid not null references public.task_projects (id) on delete cascade,
  name text not null,
  field_type public.task_custom_field_type not null default 'text',
  -- Array of option strings, DROPDOWN fields only - e.g. ["Roof", "Gutters"].
  options jsonb,
  position_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_task_custom_fields_updated_at
  before update on public.task_custom_fields
  for each row execute function public.set_updated_at();

create index task_custom_fields_project_id_idx on public.task_custom_fields (project_id);

create table public.task_custom_field_values (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  task_id uuid not null references public.tasks (id) on delete cascade,
  custom_field_id uuid not null references public.task_custom_fields (id) on delete cascade,
  value_text text,
  value_number numeric,
  value_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_custom_field_values_unique unique (task_id, custom_field_id)
);

create trigger set_task_custom_field_values_updated_at
  before update on public.task_custom_field_values
  for each row execute function public.set_updated_at();

create index task_custom_field_values_task_id_idx on public.task_custom_field_values (task_id);

-- ---------------------------------------------------------------------------
-- task_activity_logs - system-generated field-change history, populated by
-- the trigger below rather than application code at each mutation site.
-- Read-only from the client's point of view.
-- ---------------------------------------------------------------------------

create table public.task_activity_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  task_id uuid not null references public.tasks (id) on delete cascade,
  actor_id uuid references public.profiles (id),
  field_name text not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

create index task_activity_logs_task_id_idx on public.task_activity_logs (task_id);

create or replace function public.log_task_activity()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'status', old.status::text, new.status::text);
  end if;
  if new.priority is distinct from old.priority then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'priority', old.priority::text, new.priority::text);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'assigned_to', old.assigned_to::text, new.assigned_to::text);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'due_date', old.due_date::text, new.due_date::text);
  end if;
  if new.section_id is distinct from old.section_id then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'section_id', old.section_id::text, new.section_id::text);
  end if;
  -- Milestone completion gets its own distinct log entry (rather than
  -- just falling out of the status change above) so the activity feed
  -- reads as "Milestone completed", not a generic status change - see
  -- this migration's own top comment on why this doesn't also fire a
  -- notification.
  if new.is_milestone and new.status = 'done' and old.status is distinct from 'done' then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'milestone_completed', null, new.title);
  end if;
  return new;
end;
$$;

create trigger log_task_activity_trigger
  after update on public.tasks
  for each row execute function public.log_task_activity();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.task_projects enable row level security;

create policy "task_projects: tenant read" on public.task_projects
  for select using (tenant_id = public.current_tenant_id());

create policy "task_projects: admin writes - insert" on public.task_projects
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "task_projects: admin writes - update" on public.task_projects
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "task_projects: admin writes - delete" on public.task_projects
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.task_sections enable row level security;

create policy "task_sections: tenant read" on public.task_sections
  for select using (tenant_id = public.current_tenant_id());

create policy "task_sections: admin writes - insert" on public.task_sections
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "task_sections: admin writes - update" on public.task_sections
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "task_sections: admin writes - delete" on public.task_sections
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.task_custom_fields enable row level security;

create policy "task_custom_fields: tenant read" on public.task_custom_fields
  for select using (tenant_id = public.current_tenant_id());

create policy "task_custom_fields: admin writes - insert" on public.task_custom_fields
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "task_custom_fields: admin writes - update" on public.task_custom_fields
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "task_custom_fields: admin writes - delete" on public.task_custom_fields
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- task_dependencies / task_custom_field_values / task_activity_logs all
-- follow task_notes/task_files' own "visible/writable via the parent
-- task's own admin-or-assigned rule" shape - a technician can see and
-- manage these for a task assigned to them, same as they already can for
-- that task's notes/files.

alter table public.task_dependencies enable row level security;

create policy "task_dependencies: select via blocking or dependent task" on public.task_dependencies
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      exists (select 1 from public.tasks t where t.id = task_dependencies.blocking_task_id and (public.is_admin() or t.assigned_to = auth.uid()))
      or exists (select 1 from public.tasks t where t.id = task_dependencies.dependent_task_id and (public.is_admin() or t.assigned_to = auth.uid()))
    )
  );

create policy "task_dependencies: insert via dependent task" on public.task_dependencies
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_dependencies.dependent_task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

create policy "task_dependencies: delete via dependent task" on public.task_dependencies
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_dependencies.dependent_task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

alter table public.task_custom_field_values enable row level security;

create policy "task_custom_field_values: select via parent task" on public.task_custom_field_values
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_custom_field_values.task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

create policy "task_custom_field_values: insert via parent task" on public.task_custom_field_values
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_custom_field_values.task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

create policy "task_custom_field_values: update via parent task" on public.task_custom_field_values
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_custom_field_values.task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

create policy "task_custom_field_values: delete via parent task" on public.task_custom_field_values
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_custom_field_values.task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

alter table public.task_activity_logs enable row level security;

create policy "task_activity_logs: select via parent task" on public.task_activity_logs
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_activity_logs.task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );

-- Insert only ever happens via the trigger above, fired by the same
-- session whose UPDATE on tasks already had to satisfy that table's own
-- admin-or-assigned RLS check - so this mirrors that same rule rather
-- than needing a security-definer trigger function.
create policy "task_activity_logs: insert via parent task" on public.task_activity_logs
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.tasks t where t.id = task_activity_logs.task_id and (public.is_admin() or t.assigned_to = auth.uid()))
  );
