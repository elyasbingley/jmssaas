-- Fixes three reported bugs in the B2B & Referrals automated partner
-- workflows (see the b2b_referral_automation migration for the original
-- three trigger_keys).
--
-- 1. referral_lead_received never fired from the obvious way to test/use
--    it - creating a referral partner. It only fired when a *job* got
--    tagged with an existing partner (entity_id = job.id), which reads
--    fine as "we've engaged with the lead they sent" but not as "lead
--    received" the moment the partner itself is added. Adding a second
--    trigger on referral_partners insert so both paths queue the same
--    trigger_key/template - a partner tagged onto a job soon after being
--    created may now get two "thanks for the referral"-shaped emails
--    (different entity_id per trigger - job_cards/referral_partners ids
--    never collide, so the existing per-entity dedup guard doesn't cover
--    this pair), which reads as an acceptable trade-off against "never
--    fires from the obvious first thing an admin tries."
--
--    The existing seeded body ("thanks for referring
--    {referred_client_name}!") assumed a referred client already exists,
--    which isn't true yet at partner-creation time - reworded so it reads
--    naturally either way, and reworded on any tenant's already-seeded row
--    too, but only where it still holds the exact old default text (never
--    a tenant's own edit - same conservative match-then-update the
--    fix_duplicate_communication_templates migration used).
--
-- 2. referral_job_completed ("Job Won / Completed" per the UI label) only
--    fired when the referred job's *invoice* was marked paid - never when
--    the job itself reached a closed lifecycle stage (Completed/Invoiced,
--    or any custom stage an admin marks is_closed). A job finished with no
--    invoice ever explicitly marked paid in the app (paid outside it, or
--    no invoice raised) never notified the partner despite genuinely being
--    "won/completed". Adds a second trigger on job_cards, same is_closed
--    transition schedule_job_completion_summary already keys off - both
--    triggers share entity_id = job.id, so the existing per-entity dedup
--    guard naturally prevents a double-send regardless of which fires
--    first.
--
-- 3. (process-referral-digest's $0-digest bug is fixed directly in that
--    Edge Function, not here - no schema change needed for it.)

-- ---------------------------------------------------------------------------
-- 1. referral_lead_received also fires on referral_partners insert.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_referral_lead_received_on_partner_insert()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
begin
  for r in
    select * from public.communication_rules
    where tenant_id = new.tenant_id and trigger_key = 'referral_lead_received' and is_enabled = true
  loop
    if exists (
      select 1 from public.scheduled_communications
      where entity_type = 'referral_partner' and entity_id = new.id and trigger_key = r.trigger_key
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
        new.tenant_id, 'referral_partner', new.id, r.trigger_key, tmpl.id, tmpl.type,
        coalesce(new.email, ''), tmpl.subject, tmpl.body, now()
      );
    end loop;
  end loop;
  return new;
end;
$$;

create trigger schedule_referral_lead_received_on_partner_insert_trigger
  after insert on public.referral_partners
  for each row execute function public.schedule_referral_lead_received_on_partner_insert();

-- Reword the default template so it reads naturally whether it fired from
-- a bare partner-insert (no referred client yet, entity_id = partner.id -
-- buildEntityContext's fallback branch leaves referred_client_name null)
-- or the original job-tagged path.
update public.communication_templates
set body = 'Hi {partner_first_name}, thanks for the referral! We''ve got it and will keep you posted.'
where trigger_key = 'referral_lead_received'
  and type = 'email'
  and body = 'Hi {partner_first_name}, thanks for referring {referred_client_name}! We have reached out to them and will keep you posted.';

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
     'Hi {partner_first_name}, thanks for the referral! We''ve got it and will keep you posted.'),
    (p_tenant_id, 'referral_job_completed', 'Referred Job Won', 'email', 'partner',
     'Great news - the job you referred is complete',
     'Hi {partner_first_name}, great news! The job referred for {referred_client_name} has been completed ({job_value}). Thank you for your support!'),
    (p_tenant_id, 'referral_monthly_digest', 'Monthly Referral Digest', 'email', 'partner',
     'Your monthly referral summary',
     'Hi {partner_first_name}, here''s a summary of the business you referred us this month: {digest_jobs_count} job(s) closed, totalling {digest_total_value}. Thank you for your continued support!')
  on conflict (tenant_id, trigger_key, type) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. referral_job_completed also fires when the referred job itself
--    reaches a closed lifecycle stage, not only when its invoice is paid.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_referral_job_completed_on_job_closed()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_partner public.referral_partners;
  v_new_closed boolean;
  v_old_closed boolean;
begin
  if new.referral_partner_id is null then
    return new;
  end if;

  select coalesce(is_closed, false) into v_new_closed from public.job_lifecycle_stages where id = new.lifecycle_stage_id;
  select coalesce(is_closed, false) into v_old_closed from public.job_lifecycle_stages where id = old.lifecycle_stage_id;

  if coalesce(v_new_closed, false) and not coalesce(v_old_closed, false) then
    select * into v_partner from public.referral_partners where id = new.referral_partner_id;
    if v_partner.id is null then
      return new;
    end if;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id and trigger_key = 'referral_job_completed' and is_enabled = true
    loop
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'referral_partner' and entity_id = new.id and trigger_key = r.trigger_key
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
          new.tenant_id, 'referral_partner', new.id, r.trigger_key, tmpl.id, tmpl.type,
          coalesce(v_partner.email, ''), tmpl.subject, tmpl.body, now()
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_referral_job_completed_on_job_closed_trigger
  after update on public.job_cards
  for each row execute function public.schedule_referral_job_completed_on_job_closed();
