-- Job lifecycle emails, per the "Pre-Job & Site Preparation" / "Post-Job &
-- Quality Assurance" sections of the email automation feature list:
--
--   job_prep_checklist    - auto-scheduled, offset (default 24h) BEFORE
--                            job_cards.scheduled_at
--   job_completion_summary - auto-scheduled, immediately when job_cards
--                            .status becomes 'completed'
--
-- Two items from that same section are deliberately NOT built here:
--
--   "Meet Your Technician" bio - there's no bio/photo/accreditation field
--   anywhere on a technician's profile in this schema, so this would need
--   its own data model addition first, not just an email trigger. Left for
--   a future pass.
--
--   The 1-3 vs 4-5 star "Smart Feedback & Review Gatekeeper" - the biggest
--   deferred piece: it needs a public, token-authenticated rating page
--   (same shape as the quote/invoice approval page), a new table to store
--   feedback, and a routing decision (redirect to Google/Facebook vs. an
--   internal form) - meaningfully more new infrastructure than anything
--   else in this migration, which only reuses the existing trigger/
--   dispatch machinery. job_review_request (manual, existing) still just
--   links straight to {google_review_link} with no gatekeeping in front of
--   it, same as before this migration.
--
-- job_prep_checklist is the first trigger_key scheduled off a *job_cards*
-- column rather than a quote/invoice send or a status transition, and the
-- first one that has to handle being RESCHEDULED - schedule_job_lifecycle_
-- communications fires on every job_cards insert/update, and whenever
-- scheduled_at actually changes (including from null to a real value, or
-- back to null), any still-pending job_prep_checklist row for that job is
-- cancelled and a fresh one scheduled against the new time. Without this,
-- rescheduling a job would either leave a prep reminder firing at the old,
-- wrong time, or never update at all.
--
-- job_completion_summary reuses the exact same shape as invoice_payment_
-- received (immediate, fired by a status transition) - see that
-- migration's trigger for the precedent.

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
    (p_tenant_id, 'job_completion_summary', 0, 'hours', 'after', 'email')
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
     'Hi {client_first_name}, we''ve completed {job_title} at {site_address}. Thanks for choosing {company_name}! If you have any questions about the work, just reply to this email or call {company_phone}.');
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
-- job_prep_checklist - offset from job_cards.scheduled_at, reschedule-safe.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_job_prep_checklist()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_old_scheduled_at timestamptz;
  v_offset interval;
  v_scheduled_for timestamptz;
begin
  v_old_scheduled_at := case when TG_OP = 'UPDATE' then old.scheduled_at else null end;

  if new.scheduled_at is distinct from v_old_scheduled_at then
    -- The job's time changed (first scheduled, rescheduled, or cleared) -
    -- whatever was pending under the old time is now wrong, cancel it.
    update public.scheduled_communications
    set status = 'cancelled', cancellation_reason = 'Job rescheduled'
    where entity_type = 'job' and entity_id = new.id and trigger_key = 'job_prep_checklist' and status = 'pending';

    if new.scheduled_at is not null then
      select * into v_client from public.clients where id = new.client_id;

      for r in
        select * from public.communication_rules
        where tenant_id = new.tenant_id and trigger_key = 'job_prep_checklist' and is_enabled = true
      loop
        v_offset := make_interval(
          days => case when r.delay_offset_unit = 'days' then r.delay_offset_value else 0 end,
          hours => case when r.delay_offset_unit = 'hours' then r.delay_offset_value else 0 end
        );
        v_scheduled_for := case when r.delay_direction = 'before' then new.scheduled_at - v_offset else new.scheduled_at + v_offset end;

        -- A job booked for very soon (e.g. tomorrow, with a 24h-before
        -- rule) can compute a scheduled_for already in the past - skip
        -- rather than let the cron sweep fire it immediately the moment it
        -- next runs, which would read as a stale/confusing "reminder" for
        -- a visit that's basically already happening.
        if v_scheduled_for < now() then
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
            tmpl.subject, tmpl.body, v_scheduled_for
          );
        end loop;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

create trigger schedule_job_prep_checklist_trigger
  after insert or update on public.job_cards
  for each row execute function public.schedule_job_prep_checklist();

-- ---------------------------------------------------------------------------
-- job_completion_summary - immediate, same shape as invoice_payment_received.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_job_completion_summary()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
begin
  if new.status = 'completed' and new.status is distinct from old.status then
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

create trigger schedule_job_completion_summary_trigger
  after update on public.job_cards
  for each row execute function public.schedule_job_completion_summary();
