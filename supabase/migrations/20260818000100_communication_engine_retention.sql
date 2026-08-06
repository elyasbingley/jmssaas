-- Retention campaigns, per the "Customer Retention & Recurring Revenue"
-- section of the email automation feature list:
--
--   maintenance_reminder      - a recurring nudge N months after a
--                                completed job, where N varies PER SERVICE
--                                CATEGORY (aircon winterisation might be 6
--                                months, an annual pest spray 12, ...).
--   dormant_client_reengagement - a nudge when a client hasn't had a job
--                                in a configurable number of days.
--
-- Both are a genuinely different shape from every trigger_key built so
-- far, which all fire off a single row's insert/update event.
-- maintenance_reminder still fits that shape (it's scheduled the moment a
-- job is marked completed, just with a long delay) - the only wrinkle is
-- that the delay has to vary per service_category, which a single
-- tenant-wide communication_rules row can't express (that table is one row
-- per tenant+trigger_key, not per-category). Solved with a new
-- service_categories.maintenance_interval_months column instead - an
-- admin sets it per category (in Job Setup, alongside the category's name/
-- color), null meaning "no recurring reminder for this category".
-- communication_rules still gets a 'maintenance_reminder' row (for
-- is_enabled/channel/quiet_hours), but its delay_offset_value/unit/
-- direction are UNUSED for this trigger_key - the real interval always
-- comes from the completed job's own service_categories row.
--
-- dormant_client_reengagement has no completed-job (or any other single
-- row) event to hook into at all - "12 months of silence" only becomes
-- true by the calendar advancing, not by anything changing in the
-- database. This is handled by a brand new Edge Function
-- (supabase/functions/process-retention-campaigns), invoked on its own
-- daily pg_cron schedule (separate from process-scheduled-comms's 5-
-- minute sweep - there's no need to check "has it been a year" every 5
-- minutes), which does the "sweep every client, check if they're dormant"
-- work and queues a scheduled_communications row when appropriate. The
-- ACTUAL sending of that row still goes through the existing process-
-- scheduled-comms cron sweep, same as everything else - the new function
-- only detects and queues.
--
-- Since a dormant client isn't a quote/invoice/job, scheduled_
-- communications.entity_type needs a 5th value: 'client'. The check
-- constraint is widened here (not recreated as a bigger table change -
-- the column itself is untouched) - see below. Idempotency for this one
-- is different too: rather than "has this exact trigger_key ever been
-- scheduled for this entity" (which would mean a client only EVER gets one
-- re-engagement email, ever, even if they come back and go dormant again
-- years later), it's "has one been scheduled since their most recent job"
-- - see process-retention-campaigns's own comment.

alter table public.service_categories
  add column maintenance_interval_months integer;

alter table public.scheduled_communications
  drop constraint scheduled_communications_entity_type_check;

alter table public.scheduled_communications
  add constraint scheduled_communications_entity_type_check
  check (entity_type in ('quote', 'invoice', 'job', 'calendar_event', 'client'));

create or replace function public.seed_default_communication_rules(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_rules (tenant_id, trigger_key, delay_offset_value, delay_offset_unit, delay_direction, channel)
  values
    (p_tenant_id, 'quote_stage_1', 3, 'days', 'after', 'email'),
    (p_tenant_id, 'quote_stage_2', 7, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_pre_due', 2, 'days', 'before', 'email'),
    (p_tenant_id, 'invoice_overdue_1', 3, 'days', 'after', 'email'),
    (p_tenant_id, 'job_review_request', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'job_on_the_way', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'quote_expiring_soon', 7, 'days', 'before', 'email'),
    (p_tenant_id, 'quote_expired', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_due_today', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_overdue_14', 14, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_payment_received', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'quote_sent', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'invoice_sent', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'job_prep_checklist', 24, 'hours', 'before', 'email'),
    (p_tenant_id, 'job_completion_summary', 0, 'hours', 'after', 'email'),
    -- delay_offset_value/unit/direction unused - see this migration's
    -- header comment. Kept at a harmless default rather than nullable, so
    -- every other trigger_key can keep assuming these columns are always
    -- populated.
    (p_tenant_id, 'maintenance_reminder', 0, 'days', 'after', 'email'),
    -- delay_offset_value/unit here ARE used - this is the "how many days
    -- of no bookings counts as dormant" setting, read directly by
    -- process-retention-campaigns. delay_direction is unused (always
    -- conceptually "after" their last job).
    (p_tenant_id, 'dormant_client_reengagement', 365, 'days', 'after', 'email')
  on conflict (tenant_id, trigger_key) do nothing;
end;
$$;

create or replace function public.seed_default_communication_templates(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_templates (tenant_id, trigger_key, name, type, category, subject, body)
  values
    (p_tenant_id, 'quote_sent', 'Quote Delivery', 'email', 'quote',
     'Your quote from {company_name}',
     'Hi {client_first_name}, thanks for the opportunity! Your quote {quote_number} for {quote_total} from {company_name} is ready to view. Any questions, just ask.<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'invoice_sent', 'Invoice Delivery', 'email', 'invoice',
     'Invoice {invoice_number} from {company_name}',
     'Hi {client_first_name}, your invoice {invoice_number} for {invoice_total} from {company_name} is ready. Due {invoice_due_date}. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'quote_stage_1', 'Quote Follow-up (first)', 'email', 'quote',
     'Following up on your quote',
     'Hi {client_first_name}, just checking in on quote {quote_number} for {quote_total} from {company_name}. Any questions, just ask!<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'quote_stage_2', 'Quote Follow-up (second)', 'email', 'quote',
     'Your quote is still open',
     'Hi {client_first_name}, your quote {quote_number} from {company_name} is still open. Call {company_phone} if you''d like to go ahead, or use the buttons below.<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'quote_expiring_soon', 'Quote Expiring Soon', 'email', 'quote',
     'Your quote expires soon - lock in your price',
     'Hi {client_first_name}, quote {quote_number} for {quote_total} from {company_name} expires on {quote_expiry_date}. Lock in your price before it changes.<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'quote_expired', 'Quote Expired', 'email', 'quote',
     'Your quote has expired',
     'Hi {client_first_name}, quote {quote_number} from {company_name} expired on {quote_expiry_date}. Would you like us to reissue it with updated pricing? Just reply to this email or call {company_phone}.'),
    (p_tenant_id, 'invoice_pre_due', 'Invoice Due Soon', 'email', 'invoice',
     'Invoice due soon',
     'Hi {client_first_name}, a reminder that invoice {invoice_number} ({invoice_total}) from {company_name} is due {invoice_due_date}. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_due_today', 'Invoice Due Today', 'email', 'invoice',
     'Your invoice is due today',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} is due today. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_overdue_1', 'Invoice Overdue', 'email', 'invoice',
     'Invoice overdue',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} was due {invoice_due_date} and is now overdue. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_overdue_14', 'Invoice Seriously Overdue', 'email', 'invoice',
     'Invoice significantly overdue',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} was due {invoice_due_date} and is now well overdue. Please arrange payment as soon as possible, or contact us on {company_phone} to discuss. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_payment_received', 'Payment Received', 'email', 'invoice',
     'Payment received - thank you',
     'Hi {client_first_name}, thanks - we''ve received your payment of {invoice_total} for invoice {invoice_number}. This confirms the invoice is now paid in full.'),
    (p_tenant_id, 'job_review_request', 'Job Review Request', 'email', 'field',
     'How did we do?',
     'Hi {client_first_name}, thanks for choosing {company_name}! We''d love your feedback: {google_review_link}'),
    (p_tenant_id, 'job_on_the_way', 'On The Way', 'email', 'field',
     'We''re on the way',
     '{tech_first_name} from {company_name} is on the way to {site_address}, arriving in about {eta_minutes} minutes.'),
    (p_tenant_id, 'job_prep_checklist', 'Prep Your Site', 'email', 'field',
     'Getting ready for your appointment',
     'Hi {client_first_name}, just a reminder that {company_name} will be at {site_address} on {booking_date} at {booking_start_time} for {job_title}. To help us get started quickly: please ensure clear access to the work area, secure any pets, and have someone available if we need access inside. See you soon!'),
    (p_tenant_id, 'job_completion_summary', 'Job Complete', 'email', 'field',
     'Job complete',
     'Hi {client_first_name}, we''ve completed {job_title} at {site_address}. Thanks for choosing {company_name}! If you have any questions about the work, just reply to this email or call {company_phone}.'),
    (p_tenant_id, 'maintenance_reminder', 'Maintenance Reminder', 'email', 'field',
     'Time for your regular maintenance check',
     'Hi {client_first_name}, it''s about time for your regular maintenance check with {company_name}. Reply to this email or call {company_phone} to book it in.'),
    (p_tenant_id, 'dormant_client_reengagement', 'We Miss You', 'email', 'field',
     'It''s been a while!',
     'Hi {client_first_name}, it''s been a while since your last job with {company_name}! Get in touch on {company_phone} if there''s anything we can help with.');
end;
$$;

-- Backfill: existing tenants get the 2 new trigger_keys too (idempotent -
-- same reasoning as every earlier migration's identical backfill).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_communication_rules(t.id);
    perform public.seed_default_communication_templates(t.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- maintenance_reminder - fires when a job is completed, IF its service
-- category has a maintenance_interval_months set.
-- ---------------------------------------------------------------------------

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
begin
  if new.status = 'completed' and new.status is distinct from old.status and new.service_category_id is not null then
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

create trigger schedule_maintenance_reminder_trigger
  after update on public.job_cards
  for each row execute function public.schedule_maintenance_reminder();
