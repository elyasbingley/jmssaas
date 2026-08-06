-- Fixes a real, actively-harmful bug reported directly: clients were
-- receiving 2-5 copies of the same automated email. Root cause, found
-- while building the Real Estate & Strata module (see that module's own
-- migrations' comments) but not fixed at the time: `communication_templates`
-- had no unique constraint over (tenant_id, trigger_key, type), and
-- `seed_default_communication_templates`'s INSERT had no `ON CONFLICT`
-- guard, unlike `communication_rules`' own `unique (tenant_id, trigger_key)`
-- + `on conflict ... do nothing`. Every migration that redefined
-- `seed_default_communication_templates` and then re-called it in its own
-- backfill DO block (seven of them by now) re-inserted the FULL template
-- list for every tenant that already existed at that point - for any
-- tenant that's existed since early in this schema's history, duplicate
-- rows accumulated with every one of those seven migrations.
--
-- This is also *why* duplicates caused duplicate sends, not just duplicate
-- rows sitting unused in a settings screen: every call site that actually
-- queues a send - schedule_quote_communications/schedule_invoice_
-- communications (this migration file, further down), schedule_job_prep_
-- checklist/schedule_job_completion_summary, schedule_maintenance_reminder,
-- process-retention-campaigns, process-real-estate-maintenance, and mobile's
-- queueScheduledCommunication - all LOOP over every row that matches
-- (tenant_id, trigger_key, is_active, channel), inserting one
-- scheduled_communications row (one send) per matching row. Duplicate
-- template rows meant duplicate sends, automatically, everywhere.
--
-- Fix, in order:
--   1. De-duplicate existing rows per (tenant_id, trigger_key, type),
--      keeping the one most likely to be a genuine admin edit rather than
--      an untouched reseed copy - a row's own `set_updated_at` trigger only
--      fires on UPDATE, so `updated_at > created_at` is a reliable signal
--      "someone used Edit Message on this exact row" the other duplicates
--      (only ever INSERTed, never updated) won't have. Ties fall back to
--      most recently updated, then earliest created (the original seed).
--   2. Add the missing unique constraint - the same shape communication_
--      rules already has, just extended with `type` since a trigger_key
--      can legitimately have one sms row AND one email row.
--   3. Redefine seed_default_communication_templates with an `on conflict
--      ... do nothing` guard, so no future migration's backfill (or a
--      second manual call) can ever recreate this.
-- `scheduled_communications.template_id` is `on delete set null` (see this
-- same migration file above), so deleting a duplicate never breaks an
-- already-scheduled/sent row - its own rendered_subject/rendered_body are
-- already stored on that row independently of the template it came from.

with ranked as (
  select
    id,
    row_number() over (
      partition by tenant_id, trigger_key, type
      order by (updated_at > created_at) desc, updated_at desc, created_at asc, id asc
    ) as rn
  from public.communication_templates
)
delete from public.communication_templates
where id in (select id from ranked where rn > 1);

alter table public.communication_templates
  add constraint communication_templates_tenant_trigger_type_key unique (tenant_id, trigger_key, type);

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
     'Hi {client_first_name}, it''s been a while since your last job with {company_name}! Get in touch on {company_phone} if there''s anything we can help with.'),
    (p_tenant_id, 'job_nte_variation_request', 'NTE Variation Request', 'email', 'field',
     'Budget approval needed - {job_title}',
     'Hi, the job "{job_title}" ({job_number}) is now over its approved not-to-exceed budget of {nte_limit} - current total is {nte_current_total}, exceeding it by {nte_exceeded_by}. Please review and approve to allow the job to be completed.<br><br>' ||
     '<a href="{nte_approval_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Approve Variation</a>'),
    (p_tenant_id, 'property_maintenance_due', 'Property Maintenance Due', 'email', 'field',
     'Upcoming maintenance - {property_address}',
     'Hi {pm_first_name}, property {property_address} is due for its scheduled roof/gutter inspection around {property_maintenance_due_date}. Let us know if you''d like us to book this in.')
  on conflict (tenant_id, trigger_key, type) do nothing;
end;
$$;
