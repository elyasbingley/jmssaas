-- Deleting a job card, and job numbers that follow the jobs that exist.
--
-- 1. Numbering. Jobs used to take the next value of an ever-increasing
--    per-tenant counter (tenant_counters, see the ux_overhaul migration),
--    so deleting J106 and J107 left the next new job as J108. Now a new job
--    takes the highest existing job number + 1: delete the newest jobs and
--    their numbers are used again. A number freed in the middle (deleting
--    J103 while J104 exists) is not reused - only the top of the sequence
--    moves back.
--
--    Concurrency: the ux_overhaul migration's warning still applies - jobs
--    arrive from phones via PowerSync uploads as well as from desktop, so
--    two can be inserted at the same moment. A per-tenant transaction-level
--    advisory lock makes the "read the highest number, use the next one"
--    step one-at-a-time per company; each read happens after the previous
--    insert has committed, so two jobs can never be given the same number.
--
--    Quotes, invoices and tasks keep their counters unchanged.
--
-- 2. delete_job_card(id) and job_card_delete_preview(id). Deleting a job
--    through a plain DELETE either fails on a foreign key (quotes, invoices
--    and purchase orders don't cascade) or leaves things behind that still
--    act on it: pending automated SMS/emails for the job keep firing with
--    blank job details, and its calendar bookings keep sending reminders.
--    The function does the whole thing in one transaction:
--      - refuses if the job has an invoice, a purchase order, or a quote
--        that has left draft (sent/accepted/declined/expired) - those are
--        records a client or supplier has seen;
--      - deletes the job's draft quotes (never sent to anyone);
--      - deletes its calendar bookings;
--      - cancels pending automated messages for the job, its draft quotes
--        and its bookings;
--      - deletes the job. Its notes, photos and files, measurements, leak
--        checks, material orders and tasks go with it (existing ON DELETE
--        CASCADE rules). Logged timesheet hours, linked forms, inbox
--        messages and key logs are kept, unlinked.
--    It returns what the app still has to tidy outside the database:
--    calendar bookings to remove from Google Calendar, and file paths to
--    remove from storage.
--
--    Both run as the calling user (SECURITY INVOKER), so the existing RLS
--    policies decide who can delete - admins, in their own company.

-- ---------------------------------------------------------------------------
-- 1. Numbering
-- ---------------------------------------------------------------------------

create or replace function public.next_job_card_number(p_tenant_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next int;
begin
  perform pg_advisory_xact_lock(hashtextextended('job_card_number:' || p_tenant_id::text, 0));
  select coalesce(max((substring(number from '^J([0-9]+)$'))::int), 0) + 1
  into v_next
  from public.job_cards
  where tenant_id = p_tenant_id;
  return 'J' || lpad(v_next::text, 3, '0');
end;
$$;

create or replace function public.assign_job_card_number()
returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    new.number := public.next_job_card_number(new.tenant_id);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Delete
-- ---------------------------------------------------------------------------

create or replace function public.job_card_delete_preview(p_job_card_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_job public.job_cards;
begin
  select * into v_job from public.job_cards where id = p_job_card_id;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;

  return jsonb_build_object(
    'number', v_job.number,
    'blocking_invoices', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', invoice_number, 'status', status) order by invoice_number), '[]')
      from public.invoices where job_card_id = p_job_card_id
    ),
    'blocking_quotes', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', quote_number, 'status', status) order by quote_number), '[]')
      from public.quotes where job_card_id = p_job_card_id and status <> 'draft'
    ),
    'blocking_purchase_orders', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', po_number) order by po_number), '[]')
      from public.purchase_orders where job_card_id = p_job_card_id
    ),
    'draft_quotes', (select count(*) from public.quotes where job_card_id = p_job_card_id and status = 'draft'),
    'calendar_events', (select count(*) from public.calendar_events where job_card_id = p_job_card_id),
    'tasks', (select count(*) from public.tasks where job_card_id = p_job_card_id),
    'notes', (select count(*) from public.job_notes where job_card_id = p_job_card_id),
    'files', (select count(*) from public.job_files where job_card_id = p_job_card_id),
    'pending_messages', (
      select count(*) from public.scheduled_communications
      where status = 'pending' and entity_type = 'job' and entity_id = p_job_card_id
    ),
    'timesheet_minutes', (
      select coalesce(round(sum(extract(epoch from (coalesce(ended_at, now()) - started_at)) / 60)), 0)
      from public.timesheet_activities where job_card_id = p_job_card_id
    ),
    -- What the next new job will be numbered once this one is gone.
    'next_number_after', (
      select 'J' || lpad((coalesce(max((substring(number from '^J([0-9]+)$'))::int), 0) + 1)::text, 3, '0')
      from public.job_cards where tenant_id = v_job.tenant_id and id <> p_job_card_id
    )
  );
end;
$$;

create or replace function public.delete_job_card(p_job_card_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_job public.job_cards;
  v_blockers text[];
  v_draft_quote_ids uuid[];
  v_event_ids uuid[];
  v_events jsonb;
  v_paths jsonb;
  v_deleted int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete a job';
  end if;

  select * into v_job from public.job_cards where id = p_job_card_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;

  select array_agg(label order by label) into v_blockers from (
    select 'invoice ' || invoice_number as label from public.invoices where job_card_id = p_job_card_id
    union all
    select 'quote ' || quote_number || ' (' || status || ')' from public.quotes where job_card_id = p_job_card_id and status <> 'draft'
    union all
    select 'purchase order ' || coalesce(po_number, '(no number)') from public.purchase_orders where job_card_id = p_job_card_id
  ) b;
  if v_blockers is not null then
    raise exception 'Job % can''t be deleted because it has %', v_job.number, array_to_string(v_blockers, ', ')
      using hint = 'Invoices, purchase orders and quotes that have been sent are kept as records, so their job is kept too.';
  end if;

  select array_agg(id) into v_draft_quote_ids from public.quotes where job_card_id = p_job_card_id;
  select array_agg(id),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'google_event_id', google_event_id, 'google_calendar_connection_id', google_calendar_connection_id)), '[]')
    into v_event_ids, v_events
  from public.calendar_events where job_card_id = p_job_card_id;

  -- Collected before the cascade removes the rows that hold them.
  select coalesce(jsonb_agg(path), '[]') into v_paths from (
    select storage_path as path from public.job_files where job_card_id = p_job_card_id
    union
    select storage_path from public.job_leak_check_item_files where job_card_id = p_job_card_id
    union
    select f.storage_path from public.task_files f join public.tasks t on t.id = f.task_id where t.job_card_id = p_job_card_id
  ) p where path is not null;

  update public.scheduled_communications
  set status = 'cancelled', cancellation_reason = 'Job ' || coalesce(v_job.number, '') || ' was deleted'
  where status = 'pending'
    and (
      (entity_type = 'job' and entity_id = p_job_card_id)
      or (entity_type = 'quote' and entity_id = any (coalesce(v_draft_quote_ids, '{}')))
      or (entity_type = 'calendar_event' and entity_id = any (coalesce(v_event_ids, '{}')))
    );

  -- job_cards.quote_id points at a quote and quotes.job_card_id points
  -- back, so the link from the job side is cleared before either goes.
  update public.job_cards set quote_id = null, invoice_id = null where id = p_job_card_id and (quote_id is not null or invoice_id is not null);
  delete from public.quotes where id = any (coalesce(v_draft_quote_ids, '{}'));
  delete from public.calendar_events where id = any (coalesce(v_event_ids, '{}'));

  delete from public.job_cards where id = p_job_card_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'Job % could not be deleted', v_job.number;
  end if;

  return jsonb_build_object(
    'number', v_job.number,
    'deleted_draft_quotes', coalesce(array_length(v_draft_quote_ids, 1), 0),
    'calendar_events', v_events,
    'storage_paths', v_paths
  );
end;
$$;

grant execute on function public.job_card_delete_preview(uuid) to authenticated;
grant execute on function public.delete_job_card(uuid) to authenticated;
