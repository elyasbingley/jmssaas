-- Real Estate & Strata module - Batch 2: the NTE (Not-To-Exceed) budget
-- guardrail's PM approval link, and agency-compliant invoicing support.
--
-- NTE approval reuses the exact token pattern already built for quote/
-- invoice digital acceptance (quote_invoice_approval migration) rather than
-- a new mechanism: a random token on job_cards, a SECURITY DEFINER "read by
-- token" RPC and a SECURITY DEFINER "resolve by token" RPC, granted to
-- anon since the PM clicking an emailed link has no session at all. Unlike
-- quote/invoice approval this only has one resolution (approve) per the
-- spec's own wording ("Once PM approves... unblock job completion") - no
-- decline path, since a PM declining doesn't change anything the job needs
-- to do differently (the job stays blocked either way until either the
-- charged amount comes back under the limit or the PM does approve).

alter table public.job_cards
  add column nte_variation_token text unique,
  add column nte_variation_token_expires_at timestamptz,
  add column nte_variation_resolved_at timestamptz;

-- Called from the app (mobile's "Request NTE Variation" button) - SECURITY
-- INVOKER, so the UPDATE is still subject to the existing "job_cards:
-- update own or admin" RLS policy (admin, or the job's assigned
-- technician). Re-issues a fresh token/expiry every call rather than
-- reusing an existing one like generate_quote_approval_link does - unlike a
-- quote (whose total is locked once sent), a real-estate job's charged
-- total can keep changing between one variation request and the next as
-- more parts/labour get added, so a stale token from an earlier, smaller
-- overage shouldn't stay valid.
create or replace function public.generate_job_nte_variation_link(p_job_id uuid)
returns text
language plpgsql
as $$
declare
  v_token text;
  v_updated int;
begin
  v_token := encode(gen_random_bytes(32), 'hex');

  update public.job_cards
  set nte_variation_token = v_token,
      nte_variation_token_expires_at = now() + interval '30 days',
      nte_variation_resolved_at = null
  where id = p_job_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Job % not found or not permitted', p_job_id;
  end if;

  return v_token;
end;
$$;

-- Public, token-authenticated read for the approval page - SECURITY
-- DEFINER since the PM is unauthenticated. current_total_cents is computed
-- live (sum of every quote/invoice linked to this job via job_card_id, the
-- same "total charged" figure JobDetail.tsx's own Job Costing tab and the
-- NTE guardrail check itself use) rather than a snapshot taken when the
-- link was generated, so the PM always sees the real current figure even
-- if more line items were added after the email went out.
create or replace function public.get_nte_variation_for_approval(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.job_cards;
  v_tenant public.tenants;
  v_agency public.agencies;
  v_property public.properties;
  v_current_total_cents bigint;
begin
  select * into v_job from public.job_cards where nte_variation_token = p_token;
  if v_job.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_job.nte_variation_token_expires_at is not null and v_job.nte_variation_token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;

  select * into v_tenant from public.tenants where id = v_job.tenant_id;
  if v_job.agency_id is not null then
    select * into v_agency from public.agencies where id = v_job.agency_id;
  end if;
  if v_job.property_id is not null then
    select * into v_property from public.properties where id = v_job.property_id;
  end if;

  select coalesce(sum(total_cents), 0)
  into v_current_total_cents
  from (
    select total_cents from public.quotes where job_card_id = v_job.id
    union all
    select total_cents from public.invoices where job_card_id = v_job.id
  ) charged;

  return jsonb_build_object(
    'company_name', v_tenant.name,
    'job_number', v_job.number,
    'job_title', v_job.title,
    'work_order_number', v_job.work_order_number,
    'agency_name', v_agency.name,
    'property_address', case when v_property.id is not null then v_property.address_line1 || ', ' || v_property.suburb else null end,
    'nte_limit_cents', v_job.nte_limit_cents,
    'current_total_cents', v_current_total_cents,
    'already_resolved', v_job.nte_variation_resolved_at is not null,
    'nte_exceeded_approved', v_job.nte_exceeded_approved
  );
end;
$$;

create or replace function public.approve_nte_variation_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.job_cards;
begin
  select * into v_job from public.job_cards where nte_variation_token = p_token;
  if v_job.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_job.nte_variation_token_expires_at is not null and v_job.nte_variation_token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_job.nte_variation_resolved_at is not null then
    return jsonb_build_object('error', 'already_resolved');
  end if;

  update public.job_cards
  set nte_exceeded_approved = true, nte_variation_resolved_at = now()
  where id = v_job.id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.generate_job_nte_variation_link(uuid) to authenticated;

revoke execute on function public.get_nte_variation_for_approval(text) from public;
revoke execute on function public.approve_nte_variation_by_token(text) from public;
grant execute on function public.get_nte_variation_for_approval(text) to anon, authenticated;
grant execute on function public.approve_nte_variation_by_token(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- New manual trigger_key for the "Request NTE Variation" button - same
-- shape as job_review_request/job_on_the_way (mobile inserts a
-- scheduled_communications row directly with the link already rendered
-- into rendered_body, not a DB-trigger-scheduled reminder).
-- ---------------------------------------------------------------------------

-- Full cumulative lists, matching every prior migration's redefinition of
-- these two functions (each one is a complete snapshot, not a delta) -
-- this migration just appends job_nte_variation_request to both.
--
-- NOTE (found while writing this migration, not fixed here - out of scope
-- for this batch): communication_templates has no unique constraint
-- covering (tenant_id, trigger_key[, type]), and its seed function's
-- INSERT has no ON CONFLICT guard, unlike communication_rules' `on
-- conflict (tenant_id, trigger_key) do nothing`. Every migration that
-- redefines seed_default_communication_templates and then re-calls it in
-- its own backfill DO block (below) re-inserts the FULL list for every
-- tenant that already existed at that point - for a tenant that has
-- existed since early in this schema's history, that means duplicate
-- template rows accumulate with every migration that touches this
-- function. This migration follows the same established (imperfect)
-- pattern rather than unilaterally changing shared seeding behaviour as a
-- side effect of an unrelated feature - see docs/SETUP.md's write-up for
-- this batch for the full explanation and a suggested fix.
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
    (p_tenant_id, 'job_nte_variation_request', 0, 'hours', 'after', 'email')
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
     '<a href="{nte_approval_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Approve Variation</a>');
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
