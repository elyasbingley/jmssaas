-- Removes job_cards.status entirely, folding it into lifecycle_stage_id.
--
-- The job_categories_lifecycle_stages migration deliberately kept the two
-- side by side, on the reasoning that "too much of the app already keys
-- off [status]." Since then, every one of those call sites (Schedule/
-- Dispatch board's unassigned filter, Job Costing, status chips on the
-- job detail screen) has also grown a lifecycle_stage_id picker right next
-- to it - two controls doing the same job, which is exactly the
-- "these are the exact same thing" observation this migration acts on.
--
-- `is_closed` on job_lifecycle_stages is the one new concept this needs -
-- the two Postgres triggers that used to key off the literal string
-- 'completed' (schedule_job_completion_summary, schedule_maintenance_
-- reminder) need *some* way to know "this stage means the job is done",
-- and a tenant can rename/reorder/delete the default stages freely, so a
-- hardcoded stage name would be exactly as fragile as the status enum it's
-- replacing. Seeded true for the two default stages that used to mean
-- "done" (Completed, Invoiced) - false for everything else, including any
-- custom stage a tenant adds later (an admin can flip it on a custom
-- "Job Finished" stage the same way).

alter table public.job_lifecycle_stages
  add column is_closed boolean not null default false;

update public.job_lifecycle_stages
set is_closed = true
where is_system_default = true and name in ('Completed', 'Invoiced');

create or replace function public.seed_default_lifecycle_stages(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.job_lifecycle_stages (tenant_id, name, position, is_system_default, is_closed)
  values
    (p_tenant_id, 'New', 1, true, false),
    (p_tenant_id, 'Scheduled', 2, true, false),
    (p_tenant_id, 'In Progress', 3, true, false),
    (p_tenant_id, 'Completed', 4, true, true),
    (p_tenant_id, 'Invoiced', 5, true, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Rewire the two triggers that used to fire on "new.status = 'completed'
-- and new.status is distinct from old.status" - now firing on "the job's
-- stage just became a closed one, having not been closed before." That
-- "wasn't closed before" half matters just as much as it did with status:
-- without it, any later edit to an already-completed job (a note, a
-- re-save) would refire these every time.
--
-- This is also a real behavior improvement, not just a rename: the old
-- literal 'completed' check would silently never fire for a job whose
-- pipeline skips straight from an in-progress-equivalent stage to an
-- Invoiced-equivalent one (a tenant that customizes their stages to not
-- have a separate "Completed" step). Keying off is_closed instead fires
-- correctly the first time the job lands in *either* closed default stage,
-- or any custom stage an admin has marked is_closed.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_job_completion_summary()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_new_closed boolean;
  v_old_closed boolean;
begin
  select coalesce(is_closed, false) into v_new_closed from public.job_lifecycle_stages where id = new.lifecycle_stage_id;
  select coalesce(is_closed, false) into v_old_closed from public.job_lifecycle_stages where id = old.lifecycle_stage_id;

  if coalesce(v_new_closed, false) and not coalesce(v_old_closed, false) then
    select * into v_client from public.clients where id = new.client_id;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id and trigger_key = 'job_completion_summary' and is_enabled = true
    loop
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'job' and entity_id = new.id and trigger_key = r.trigger_key
      ) then
        continue;
      end if;

      for tmpl in
        select * from public.communication_templates ct
        where ct.tenant_id = new.tenant_id and ct.trigger_key = r.trigger_key and ct.is_active = true
          and (r.channel = 'both' or r.channel = ct.type)
      loop
        insert into public.scheduled_communications
          (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
        values (
          new.tenant_id, 'job', new.id, r.trigger_key, tmpl.id, tmpl.type,
          case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
          tmpl.subject, tmpl.body, now()
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.schedule_maintenance_reminder()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_interval_months integer;
  v_scheduled_for timestamptz;
  v_new_closed boolean;
  v_old_closed boolean;
begin
  select coalesce(is_closed, false) into v_new_closed from public.job_lifecycle_stages where id = new.lifecycle_stage_id;
  select coalesce(is_closed, false) into v_old_closed from public.job_lifecycle_stages where id = old.lifecycle_stage_id;

  if coalesce(v_new_closed, false) and not coalesce(v_old_closed, false) and new.service_category_id is not null then
    select maintenance_interval_months into v_interval_months
    from public.service_categories where id = new.service_category_id;

    if v_interval_months is not null then
      for r in
        select * from public.communication_rules
        where tenant_id = new.tenant_id and trigger_key = 'maintenance_reminder' and is_enabled = true
      loop
        if exists (
          select 1 from public.scheduled_communications
          where entity_type = 'job' and entity_id = new.id and trigger_key = r.trigger_key
        ) then
          continue;
        end if;

        select * into v_client from public.clients where id = new.client_id;
        v_scheduled_for := now() + make_interval(months => v_interval_months);

        for tmpl in
          select * from public.communication_templates ct
          where ct.tenant_id = new.tenant_id and ct.trigger_key = r.trigger_key and ct.is_active = true
            and (r.channel = 'both' or r.channel = ct.type)
        loop
          insert into public.scheduled_communications
            (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
          values (
            new.tenant_id, 'job', new.id, r.trigger_key, tmpl.id, tmpl.type,
            case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
            tmpl.subject, tmpl.body, v_scheduled_for
          );
        end loop;
      end loop;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Default a new job to its tenant's first-position stage when one isn't
-- given, so lifecycle_stage_id is never left null the way status never
-- used to be (status had a NOT NULL DEFAULT 'new' - lifecycle_stage_id up
-- to now was just an optional tag). Both apps' "New job" forms already let
-- an admin leave stage blank, so this has to be enforced here rather than
-- relied on client-side.
-- ---------------------------------------------------------------------------

create or replace function public.default_job_lifecycle_stage()
returns trigger
language plpgsql
as $$
begin
  if new.lifecycle_stage_id is null then
    select id into new.lifecycle_stage_id
    from public.job_lifecycle_stages
    where tenant_id = new.tenant_id
    order by position asc
    limit 1;
  end if;
  return new;
end;
$$;

create trigger default_job_lifecycle_stage_trigger
  before insert on public.job_cards
  for each row execute function public.default_job_lifecycle_stage();

-- One last backfill pass for any job_card that still has no stage (the
-- original migration's backfill matched by status name, so this should be
-- a no-op in practice, but a dropped status column is exactly the wrong
-- place to discover an edge case left it null).
update public.job_cards jc
set lifecycle_stage_id = (
  select ls.id from public.job_lifecycle_stages ls
  where ls.tenant_id = jc.tenant_id
  order by ls.position asc
  limit 1
)
where jc.lifecycle_stage_id is null;

-- ---------------------------------------------------------------------------
-- Drop status - job_status is only ever used on this one column (verified:
-- no other table/trigger/RLS policy references it), so it's safe to drop
-- the enum type along with it, not just the column.
-- ---------------------------------------------------------------------------

drop index if exists public.job_cards_status_idx;
alter table public.job_cards drop column status;
drop type public.job_status;
