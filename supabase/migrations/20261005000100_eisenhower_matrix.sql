-- Eisenhower Matrix (Urgent x Important) as an enhancement of the existing
-- tasks module - not a parallel system. Two independent nullable booleans
-- rather than a single "quadrant" enum: both null means "Unsorted" (never
-- classified), and each axis can be set/cleared independently of the other.
-- The quadrant itself (Do First / Schedule / Delegate / Eliminate) is a
-- pure function of these two columns, computed client-side in
-- packages/shared - not stored here, since it's a trivial derivation with
-- no cross-row logic (unlike e.g. notes' wikilink graph, which genuinely
-- needed a trigger).
--
-- Named is_urgent/is_important rather than urgent/important to stay
-- unambiguous next to task_priority's own 'urgent' enum value
-- (asana_task_engine migration) - that's a separate, pre-existing concept
-- (effort/severity ranking) and this is not meant to be read as touching it.
--
-- No new RLS policies: these are just more columns on public.tasks, so they
-- inherit that table's existing "select/update: admin or assigned_to =
-- auth.uid(); insert/delete: admin only" policies automatically. No new
-- PowerSync sync-rule changes either - tasks already syncs via `select *`
-- in every bucket that includes it; the local schema.ts Table definition is
-- updated separately to pick these columns up.

alter table public.tasks
  add column is_urgent boolean,
  add column is_important boolean;

-- Per-tenant "how many days out counts as urgent" for the due-date-driven
-- auto-suggestion (shown to the user, never silently applied - an explicit
-- is_urgent/is_important choice always wins and is never overwritten by the
-- suggestion). Plain column on tenants, matching how every other
-- single-value per-tenant setting already lives here (phone,
-- google_review_link, abn, ...) rather than a new generic settings table.
alter table public.tenants
  add column task_urgency_threshold_days integer not null default 2;

-- Extend the existing field-change activity log (asana_task_engine
-- migration) to also log matrix classification changes, same as every
-- other tracked field on tasks (status/priority/assigned_to/due_date/
-- section_id).
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
  if new.is_urgent is distinct from old.is_urgent then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'is_urgent', old.is_urgent::text, new.is_urgent::text);
  end if;
  if new.is_important is distinct from old.is_important then
    insert into public.task_activity_logs (tenant_id, task_id, actor_id, field_name, old_value, new_value)
    values (new.tenant_id, new.id, auth.uid(), 'is_important', old.is_important::text, new.is_important::text);
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
