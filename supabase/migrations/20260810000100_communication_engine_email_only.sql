-- SMS was removed from the communication engine after the Twilio
-- integration proved unreliable to stand up in practice (auth, phone
-- number formatting, and quiet-hours interactions never fully settled -
-- see supabase/functions/process-scheduled-comms's own comment). Rather
-- than dropping the sms/both options from the channel/type check
-- constraints - a real schema change a future SMS provider would just
-- have to reverse - this migration only flips the DATA: every existing
-- tenant's seeded rules/templates move to channel/type = 'email', and the
-- seed functions are updated so every new tenant does too. An admin can
-- still manually set a rule's channel back to 'sms' from the mobile app,
-- but nothing sends through that path right now (see the dispatcher).
--
-- communication_templates.subject was null on every sms-type template
-- (sms has no subject line) - a sensible default subject is backfilled
-- per trigger_key here, since an email without one degrades to
-- process-scheduled-comms's "(no subject)" fallback otherwise.

update public.communication_rules
set channel = 'email'
where channel in ('sms', 'both');

update public.communication_templates
set type = 'email',
    subject = coalesce(subject, case trigger_key
      when 'quote_stage_1' then 'Following up on your quote'
      when 'quote_stage_2' then 'Your quote is still open'
      when 'invoice_pre_due' then 'Invoice due soon'
      when 'invoice_overdue_1' then 'Invoice overdue'
      when 'job_review_request' then 'How did we do?'
      when 'job_on_the_way' then 'We''re on the way'
      else name
    end)
where type = 'sms';

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
    (p_tenant_id, 'job_on_the_way', 0, 'hours', 'after', 'email')
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
    (p_tenant_id, 'quote_stage_1', 'Quote Follow-up (first)', 'email', 'quote',
     'Following up on your quote',
     'Hi {client_first_name}, just checking in on quote {quote_number} for {quote_total} from {company_name}. Any questions, just ask! View it here: {quote_approval_link}'),
    (p_tenant_id, 'quote_stage_2', 'Quote Follow-up (second)', 'email', 'quote',
     'Your quote is still open',
     'Hi {client_first_name}, your quote {quote_number} from {company_name} is still open. Call {company_phone} if you''d like to go ahead.'),
    (p_tenant_id, 'invoice_pre_due', 'Invoice Due Soon', 'email', 'invoice',
     'Invoice due soon',
     'Hi {client_first_name}, a reminder that invoice {invoice_number} ({invoice_total}) from {company_name} is due {invoice_due_date}. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_overdue_1', 'Invoice Overdue', 'email', 'invoice',
     'Invoice overdue',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} was due {invoice_due_date} and is now overdue. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'job_review_request', 'Job Review Request', 'email', 'field',
     'How did we do?',
     'Hi {client_first_name}, thanks for choosing {company_name}! We''d love your feedback: {google_review_link}'),
    (p_tenant_id, 'job_on_the_way', 'On The Way', 'email', 'field',
     'We''re on the way',
     '{tech_first_name} from {company_name} is on the way to {site_address}, arriving in about {eta_minutes} minutes.');
end;
$$;
