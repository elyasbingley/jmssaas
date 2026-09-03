-- Membership Module - Batch 3: communications. Five new trigger_keys,
-- seeded the same way every trigger_key in this schema is (full-cumulative
-- redefinition of seed_default_communication_rules/
-- seed_default_communication_templates - each one is a complete snapshot,
-- not a delta - matching every prior migration back to
-- subcontractor_management.sql, the latest redefinition as of this batch).
-- Uses the now-fixed `on conflict (tenant_id, trigger_key, type) do
-- nothing` guard on templates (see fix_duplicate_communication_templates.sql
-- - some earlier migrations' own comments describe this as still-broken,
-- but that was fixed before this batch; this migration follows the
-- corrected, current behaviour).
--
-- Firing mechanism, matching the shape each already-established pattern
-- uses for the same kind of event:
--
--   - membership_welcome fires on a client_memberships INSERT (status =
--     'active' at creation) - same idea as schedule_quote_communications,
--     just AFTER INSERT instead of AFTER UPDATE since enrolling is a
--     creation event, not a status transition on an existing row.
--   - membership_payment_failed/membership_cancelled fire on a client_
--     memberships UPDATE where status transitions to past_due/cancelled -
--     same AFTER UPDATE trigger shape as cancel_pending_invoice_
--     communications, but scheduling a new send instead of cancelling
--     pending ones. Deliberately NOT deduplicated against a prior send for
--     the same trigger_key (unlike quote_stage_1/quote_stage_2's "already
--     scheduled for this quote" guard) - a membership can flap active ->
--     past_due -> active -> past_due again over its life, and each
--     transition is genuinely new information the member should hear
--     about, not a single one-shot document lifecycle event.
--   - membership_renewal_upcoming (~14 days before current_period_end) and
--     membership_annual_benefit_reminder (~60 days left, an included
--     benefit still unused) have no "row just changed" event to hook -
--     same gap property_maintenance_due had - so they're queued by a new
--     cron-swept Edge Function (process-membership-reminders), same shape
--     as process-real-estate-maintenance: this migration only adds the
--     trigger_key/rule/template plumbing, the function itself is a
--     separate file alongside this migration.
--
-- membership_annual_benefit_reminder sends ONE combined reminder per
-- membership per period (not one per unused benefit type) - the
-- {membership_benefit_type} token is resolved to a joined label ("annual
-- roof inspection and annual plumbing check") at send time by process-
-- scheduled-comms, computed live against membership_benefit_usage rather
-- than trusted from queue time, same "recompute, don't trust a snapshot"
-- reasoning as property_maintenance_due's own due-date recomputation. This
-- sidesteps needing a benefit-type-specific idempotency key on
-- scheduled_communications (which has no such column) - idempotency here
-- is just "has ANY membership_annual_benefit_reminder been queued for this
-- membership since its current_period_start".

alter table public.scheduled_communications
  drop constraint scheduled_communications_entity_type_check;

alter table public.scheduled_communications
  add constraint scheduled_communications_entity_type_check
  check (entity_type in ('quote', 'invoice', 'job', 'calendar_event', 'client', 'property_asset', 'referral_partner', 'report', 'purchase_order', 'subcontractor', 'client_membership'));

-- ---------------------------------------------------------------------------
-- Full cumulative seed functions (26 existing + 5 new = 31 trigger_keys).
-- ---------------------------------------------------------------------------

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
    (p_tenant_id, 'maintenance_reminder', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'dormant_client_reengagement', 365, 'days', 'after', 'email'),
    (p_tenant_id, 'job_nte_variation_request', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'property_maintenance_due', 30, 'days', 'before', 'email'),
    (p_tenant_id, 'referral_lead_received', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'referral_job_completed', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'referral_monthly_digest', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'report_sent', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'subcontractor_quote_request', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'subcontractor_work_order', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'subcontractor_compliance_expired', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'membership_welcome', 0, 'hours', 'after', 'email'),
    -- delay_offset_value is the reminder window in days before
    -- current_period_end, read directly by process-membership-reminders -
    -- same role property_maintenance_due's own offset plays.
    (p_tenant_id, 'membership_renewal_upcoming', 14, 'days', 'before', 'email'),
    (p_tenant_id, 'membership_payment_failed', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'membership_cancelled', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'membership_annual_benefit_reminder', 60, 'days', 'before', 'email')
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
     'Hi {client_first_name}, it''s been a while since your last job with {company_name}! Get in touch on {company_phone} if there''s anything we can help with.'),
    (p_tenant_id, 'job_nte_variation_request', 'NTE Variation Request', 'email', 'field',
     'Budget approval needed - {job_title}',
     'Hi, the job "{job_title}" ({job_number}) is now over its approved not-to-exceed budget of {nte_limit} - current total is {nte_current_total}, exceeding it by {nte_exceeded_by}. Please review and approve to allow the job to be completed.<br><br>' ||
     '<a href="{nte_approval_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Approve Variation</a>'),
    (p_tenant_id, 'property_maintenance_due', 'Property Maintenance Due', 'email', 'field',
     'Upcoming maintenance - {property_address}',
     'Hi {pm_first_name}, property {property_address} is due for its scheduled roof/gutter inspection around {property_maintenance_due_date}. Let us know if you''d like us to book this in.'),
    (p_tenant_id, 'referral_lead_received', 'Referral Received', 'email', 'partner',
     'Thanks for the referral!',
     'Hi {partner_first_name}, thanks for referring {referred_client_name}! We have reached out to them and will keep you posted.'),
    (p_tenant_id, 'referral_job_completed', 'Referred Job Won', 'email', 'partner',
     'Great news - the job you referred is complete',
     'Hi {partner_first_name}, great news! The job referred for {referred_client_name} has been completed ({job_value}). Thank you for your support!'),
    (p_tenant_id, 'referral_monthly_digest', 'Monthly Referral Digest', 'email', 'partner',
     'Your monthly referral summary',
     'Hi {partner_first_name}, here''s a summary of the business you referred us this month: {digest_jobs_count} job(s) closed, totalling {digest_total_value}. Thank you for your continued support!'),
    (p_tenant_id, 'report_sent', 'Report Delivery', 'email', 'field',
     '{report_title} - {company_name}',
     'Hi {client_first_name}, please find your {report_title} report from {company_name} attached below.<br><br>' ||
     '<a href="{report_pdf_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View / Download Report</a>'),
    (p_tenant_id, 'subcontractor_quote_request', 'Subcontractor Quote Request', 'email', 'field',
     'Quote request - {job_title}',
     'Hi {subcontractor_contact_first_name}, we''d like a quote for the following work: {job_title} at {job_address}.<br><br>' ||
     '<a href="{po_quote_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View scope & submit your quote</a>'),
    (p_tenant_id, 'subcontractor_work_order', 'Subcontractor Work Order', 'email', 'field',
     'Purchase Order {po_number} from {company_name}',
     'Hi {subcontractor_contact_first_name}, please find Purchase Order {po_number} for {job_title} attached below - total {po_total}.<br><br>' ||
     '<a href="{po_pdf_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View Purchase Order</a>'),
    (p_tenant_id, 'subcontractor_compliance_expired', 'Compliance Document Expired', 'email', 'field',
     'Action needed - your compliance documents have expired',
     'Hi {subcontractor_contact_first_name}, your {expired_doc_type} for {subcontractor_company_name} expired on {expired_doc_expiry_date}. Please send us an updated Certificate of Currency or license to continue receiving work orders from {company_name}.'),
    (p_tenant_id, 'membership_welcome', 'Membership Welcome', 'email', 'field',
     'Welcome to {company_name} Membership!',
     'Hi {client_first_name}, welcome to {company_name}''s membership program! Your {membership_plan_name} membership is now active - no call-out fees, {membership_discount_percent}% off repairs and installations, priority scheduling, and included annual roof and plumbing checks. Your membership renews on {membership_renewal_date}. Thanks for joining us!'),
    (p_tenant_id, 'membership_renewal_upcoming', 'Membership Renewal Upcoming', 'email', 'field',
     'Your {company_name} membership renews soon',
     'Hi {client_first_name}, just a heads up - your {membership_plan_name} membership with {company_name} renews on {membership_renewal_date} at {membership_annual_price}. No action needed if your payment details are up to date.'),
    (p_tenant_id, 'membership_payment_failed', 'Membership Payment Failed', 'email', 'field',
     'Action needed - your {company_name} membership payment failed',
     'Hi {client_first_name}, we weren''t able to process the payment for your {membership_plan_name} membership with {company_name}. Please update your payment details to keep your membership benefits active.'),
    (p_tenant_id, 'membership_cancelled', 'Membership Cancelled', 'email', 'field',
     'Your {company_name} membership has been cancelled',
     'Hi {client_first_name}, this confirms your {membership_plan_name} membership with {company_name} has been cancelled. We''d love to have you back any time - just give us a call on {company_phone}.'),
    (p_tenant_id, 'membership_annual_benefit_reminder', 'Membership Benefit Reminder', 'email', 'field',
     'Don''t miss your included {membership_benefit_type}',
     'Hi {client_first_name}, as a {company_name} member you have an included {membership_benefit_type} that hasn''t been used yet this year, and your membership period ends {membership_renewal_date}. Get in touch to book it in before it resets!')
  on conflict (tenant_id, trigger_key, type) do nothing;
end;
$$;

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
-- Event-driven triggers on client_memberships.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_membership_welcome_communication()
returns trigger
language plpgsql
as $$
declare
  tmpl record;
  v_client public.clients;
begin
  if new.status = 'active' then
    select * into v_client from public.clients where id = new.client_id;

    for tmpl in
      select ct.* from public.communication_templates ct
      join public.communication_rules r on r.tenant_id = ct.tenant_id and r.trigger_key = ct.trigger_key
      where ct.tenant_id = new.tenant_id and ct.trigger_key = 'membership_welcome' and ct.is_active = true
        and r.is_enabled = true and (r.channel = 'both' or r.channel = ct.type)
    loop
      insert into public.scheduled_communications
        (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
      values (
        new.tenant_id, 'client_membership', new.id, 'membership_welcome', tmpl.id, tmpl.type,
        coalesce(v_client.email, ''), tmpl.subject, tmpl.body, now()
      );
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_membership_welcome_communication_trigger
  after insert on public.client_memberships
  for each row execute function public.schedule_membership_welcome_communication();

create or replace function public.schedule_membership_status_communications()
returns trigger
language plpgsql
as $$
declare
  v_trigger_key text;
  tmpl record;
  v_client public.clients;
begin
  if new.status = 'past_due' and new.status is distinct from old.status then
    v_trigger_key := 'membership_payment_failed';
  elsif new.status = 'cancelled' and new.status is distinct from old.status then
    v_trigger_key := 'membership_cancelled';
  else
    return new;
  end if;

  select * into v_client from public.clients where id = new.client_id;

  for tmpl in
    select ct.* from public.communication_templates ct
    join public.communication_rules r on r.tenant_id = ct.tenant_id and r.trigger_key = ct.trigger_key
    where ct.tenant_id = new.tenant_id and ct.trigger_key = v_trigger_key and ct.is_active = true
      and r.is_enabled = true and (r.channel = 'both' or r.channel = ct.type)
  loop
    insert into public.scheduled_communications
      (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
    values (
      new.tenant_id, 'client_membership', new.id, v_trigger_key, tmpl.id, tmpl.type,
      coalesce(v_client.email, ''), tmpl.subject, tmpl.body, now()
    );
  end loop;

  return new;
end;
$$;

create trigger schedule_membership_status_communications_trigger
  after update on public.client_memberships
  for each row execute function public.schedule_membership_status_communications();
