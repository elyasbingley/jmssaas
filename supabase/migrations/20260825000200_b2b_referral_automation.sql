-- B2B Partner & Referral Tracking - automated partner appreciation
-- workflows (Sub-tab 4). Three new trigger_keys reusing the existing
-- communication_rules/communication_templates/scheduled_communications
-- engine, same as every other automated email in this schema:
--
--   referral_lead_received  - fired the moment a job is tagged with a
--                              referral partner (new job with the partner
--                              set, or an existing job later attributed).
--   referral_job_completed  - fired when that job's invoice is marked paid
--                              (same transition calculate_referral_fee_on_
--                              invoice_paid already keys off).
--   referral_monthly_digest - NOT event-triggered - swept once a month by
--                              a new Edge Function (process-referral-
--                              digest), same shape as process-retention-
--                              campaigns/process-real-estate-maintenance.
--                              Body is fully pre-rendered by that function
--                              before insert (no per-tenant DB trigger has
--                              a "once a month" clock to key off), so the
--                              dispatcher's token substitution is a no-op
--                              for this one - see that Edge Function's own
--                              comment.
--
-- entity_type gains 'referral_partner' (same drop/re-add pattern as every
-- previous addition). entity_id is a job_cards.id for the first two
-- trigger_keys (mirrors how entity_type='job' already resolves client
-- context via job.client_id - here the dispatcher resolves partner
-- context via job.referral_partner_id, plus the client/invoice on that
-- same job) and a referral_partners.id for the digest (no single job to
-- point at - see that function's own comment for why a bare partner
-- lookup is a safe, unambiguous fallback in buildEntityContext).
--
-- category also gains 'partner' - the existing four values (quote/
-- invoice/booking/field) don't have a natural fit for a message sent to a
-- referral partner rather than a client, so this is a new bucket rather
-- than overloading 'field'.

alter table public.scheduled_communications
  drop constraint scheduled_communications_entity_type_check;

alter table public.scheduled_communications
  add constraint scheduled_communications_entity_type_check
  check (entity_type in ('quote', 'invoice', 'job', 'calendar_event', 'client', 'property_asset', 'referral_partner'));

alter table public.communication_templates
  drop constraint communication_templates_category_check;

alter table public.communication_templates
  add constraint communication_templates_category_check
  check (category in ('quote', 'invoice', 'booking', 'field', 'partner'));

-- ---------------------------------------------------------------------------
-- referral_lead_received - job_cards insert/update, referral_partner_id
-- newly set.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_referral_lead_received()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_partner public.referral_partners;
begin
  if new.referral_partner_id is not null
     and (tg_op = 'INSERT' or old.referral_partner_id is distinct from new.referral_partner_id) then
    select * into v_partner from public.referral_partners where id = new.referral_partner_id;
    if v_partner.id is null then
      return new;
    end if;

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
          coalesce(v_partner.email, ''), tmpl.subject, tmpl.body, now()
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_referral_lead_received_trigger
  after insert or update on public.job_cards
  for each row execute function public.schedule_referral_lead_received();

-- ---------------------------------------------------------------------------
-- referral_job_completed - invoices, status -> paid, linked job has a
-- referral partner. Companion to calculate_referral_fee_on_invoice_paid
-- (same guard), kept as a separate trigger function rather than folded into
-- that one - fee calculation is pure data and should never be skipped or
-- fail because of an email-scheduling issue, and vice versa.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_referral_job_completed()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_job public.job_cards;
  v_partner public.referral_partners;
begin
  if new.status = 'paid' and old.status is distinct from new.status and new.job_card_id is not null then
    select * into v_job from public.job_cards where id = new.job_card_id;
    if v_job.id is null or v_job.referral_partner_id is null then
      return new;
    end if;
    select * into v_partner from public.referral_partners where id = v_job.referral_partner_id;
    if v_partner.id is null then
      return new;
    end if;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id and trigger_key = 'referral_job_completed' and is_enabled = true
    loop
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'referral_partner' and entity_id = v_job.id and trigger_key = r.trigger_key
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
          new.tenant_id, 'referral_partner', v_job.id, r.trigger_key, tmpl.id, tmpl.type,
          coalesce(v_partner.email, ''), tmpl.subject, tmpl.body, now()
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_referral_job_completed_trigger
  after update on public.invoices
  for each row execute function public.schedule_referral_job_completed();

-- ---------------------------------------------------------------------------
-- Seed rules/templates - full cumulative lists again (established pattern -
-- see the fix_duplicate_communication_templates migration for why the
-- templates insert has an ON CONFLICT guard now).
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
    -- delay_offset_value/unit/direction are unused for this one - see
    -- process-referral-digest's own comment, it runs on its own monthly
    -- schedule regardless of what's set here. is_enabled/channel still
    -- apply (a tenant can turn the digest off or switch it to sms/both
    -- like any other rule).
    (p_tenant_id, 'referral_monthly_digest', 0, 'days', 'after', 'email')
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
     'Hi {partner_first_name}, here''s a summary of the business you referred us this month: {digest_jobs_count} job(s) closed, totalling {digest_total_value}. Thank you for your continued support!')
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
