-- Extends the communication engine's quote/invoice reminder ladder with
-- five new trigger_keys, per the "Quote Reminders & Conversion" / "Payment
-- & Invoicing Escalations" sections of the email automation feature list:
--
--   quote_expiring_soon    - 7 days BEFORE quote.expiry_date
--   quote_expired          - on quote.expiry_date itself
--   invoice_due_today      - on invoice.due_date itself
--   invoice_overdue_14     - 14 days AFTER invoice.due_date
--   invoice_payment_received - immediately when invoice.status -> 'paid'
--
-- The first four slot into the existing "auto-scheduled when the parent
-- quote/invoice is sent" shape (schedule_quote_communications/
-- schedule_invoice_communications, both replaced below) - quote_stage_1/2
-- already prove the pattern for send-date-relative offsets, invoice_pre_due/
-- invoice_overdue_1 already prove it for due-date-relative offsets.
-- quote_expiring_soon/quote_expired are new in ONE respect:
-- schedule_quote_communications previously only ever used now() (the send
-- moment) as its reference date - these two need expiry_date instead, so
-- the reference is now picked per trigger_key inside the loop instead of
-- being a single value computed once. A quote with no expiry_date (it's a
-- nullable field) simply skips these two trigger_keys - there's nothing to
-- count down from.
--
-- invoice_payment_received is genuinely new shape: it isn't scheduled when
-- the invoice is SENT, it's scheduled when the invoice is PAID, with zero
-- delay (fire immediately). A new trigger (schedule_invoice_payment_
-- receipt, AFTER UPDATE on invoices) handles this, watching the same
-- `status = 'paid'` transition as the existing cancel_pending_invoice_
-- communications trigger. Both fire on the same event; Postgres runs
-- multiple triggers for the same table/event in alphabetical order by
-- trigger name, and 'cancel_pending_invoice_communications_trigger' sorts
-- before 'schedule_invoice_payment_receipt_trigger', so the cancellation
-- (which cancels this invoice's still-pending rows) always runs BEFORE the
-- receipt row is inserted - the brand new receipt row is never at risk of
-- being immediately cancelled by the sibling trigger. This ordering is
-- relied on rather than re-derived defensively (e.g. excluding
-- 'invoice_payment_received' from the cancellation's WHERE clause) since
-- it's simpler and Postgres's alphabetical-ordering rule for same-event
-- triggers is documented, stable behavior, not an implementation detail
-- likely to change.
--
-- "Instant Receipt & Certificate Delivery" from the feature list also asks
-- for the paid PDF invoice and compliance certificates attached to this
-- email - NOT done here. PDF generation in this app is currently client-
-- side only (apps/mobile/lib/pdf.ts, run on the admin's own device to
-- share/print), there's no server-side PDF generation this Edge Function
-- could call, and compliance certificates aren't a concept that exists
-- anywhere in this schema yet. Building a Deno-side PDF pipeline is a
-- meaningfully separate project, deliberately deferred - see docs/SETUP.md.

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
    (p_tenant_id, 'invoice_payment_received', 0, 'hours', 'after', 'email')
  on conflict (tenant_id, trigger_key) do nothing;
end;
$$;

-- {quote_accept_link}/{quote_decline_link} are new tokens (see
-- packages/shared/src/placeholders.ts and the dispatcher's Deno port) -
-- one-click action links, distinct from the existing generic
-- {quote_approval_link} which just opens the quote for viewing. Only
-- quote_stage_1/quote_stage_2/quote_expiring_soon get them: the quote is
-- still genuinely acceptable at those points. quote_expired deliberately
-- does NOT include them - accept_quote_by_token/decline_quote_by_token
-- (see the quote_invoice_approval migration) only ever check the
-- approval TOKEN's own 30-day token_expires_at, never the quote's own
-- business expiry_date, so an accept button on an "expired" email would
-- actually still succeed server-side even though the price is meant to no
-- longer be honoured - a real gap, left unfixed here (out of scope for a
-- template-copy pass), avoided by simply not offering the button on this
-- one email. See docs/SETUP.md.
create or replace function public.seed_default_communication_templates(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_templates (tenant_id, trigger_key, name, type, category, subject, body)
  values
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
     '{tech_first_name} from {company_name} is on the way to {site_address}, arriving in about {eta_minutes} minutes.');
end;
$$;

-- Backfill: every existing tenant gets the 5 new rules/templates too, not
-- just tenants created from here on - both seed functions are idempotent
-- (on conflict do nothing / trigger_key uniqueness), so calling them again
-- for a tenant that already has the original 6 just adds the 5 new rows.
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
-- Auto-scheduling - extended to cover the 2 new quote trigger_keys (which
-- need quote.expiry_date as their reference instead of the send moment)
-- and 2 new invoice trigger_keys (which fit the existing due_date-relative
-- shape with no other changes).
-- ---------------------------------------------------------------------------

create or replace function public.schedule_quote_communications()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_offset interval;
  v_reference timestamptz;
  v_scheduled_for timestamptz;
begin
  if new.status = 'sent' and new.status is distinct from old.status then
    select * into v_client from public.clients where id = new.client_id;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id
        and trigger_key in ('quote_stage_1', 'quote_stage_2', 'quote_expiring_soon', 'quote_expired')
        and is_enabled = true
    loop
      -- quote_expiring_soon/quote_expired count down to expiry_date, which
      -- is nullable - nothing to schedule against if it's not set.
      if r.trigger_key in ('quote_expiring_soon', 'quote_expired') and new.expiry_date is null then
        continue;
      end if;

      -- Idempotency: never double-schedule the same trigger_key for the
      -- same quote (e.g. an admin flipping status back to draft and
      -- resending shouldn't stack duplicate follow-ups).
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'quote' and entity_id = new.id and trigger_key = r.trigger_key
      ) then
        continue;
      end if;

      v_reference := case
        when r.trigger_key in ('quote_expiring_soon', 'quote_expired') then new.expiry_date::timestamptz
        else now()
      end;

      v_offset := make_interval(
        days => case when r.delay_offset_unit = 'days' then r.delay_offset_value else 0 end,
        hours => case when r.delay_offset_unit = 'hours' then r.delay_offset_value else 0 end
      );
      v_scheduled_for := case when r.delay_direction = 'before' then v_reference - v_offset else v_reference + v_offset end;

      for tmpl in
        select * from public.communication_templates ct
        where ct.tenant_id = new.tenant_id and ct.trigger_key = r.trigger_key and ct.is_active = true
          and (r.channel = 'both' or r.channel = ct.type)
      loop
        insert into public.scheduled_communications
          (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
        values (
          new.tenant_id, 'quote', new.id, r.trigger_key, tmpl.id, tmpl.type,
          case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
          tmpl.subject, tmpl.body, v_scheduled_for
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.schedule_invoice_communications()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_offset interval;
  v_reference timestamptz;
  v_scheduled_for timestamptz;
begin
  if new.status = 'sent' and new.status is distinct from old.status and new.due_date is not null then
    select * into v_client from public.clients where id = new.client_id;
    v_reference := new.due_date::timestamptz;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id
        and trigger_key in ('invoice_pre_due', 'invoice_due_today', 'invoice_overdue_1', 'invoice_overdue_14')
        and is_enabled = true
    loop
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'invoice' and entity_id = new.id and trigger_key = r.trigger_key
      ) then
        continue;
      end if;

      v_offset := make_interval(
        days => case when r.delay_offset_unit = 'days' then r.delay_offset_value else 0 end,
        hours => case when r.delay_offset_unit = 'hours' then r.delay_offset_value else 0 end
      );
      v_scheduled_for := case when r.delay_direction = 'before' then v_reference - v_offset else v_reference + v_offset end;

      for tmpl in
        select * from public.communication_templates ct
        where ct.tenant_id = new.tenant_id and ct.trigger_key = r.trigger_key and ct.is_active = true
          and (r.channel = 'both' or r.channel = ct.type)
      loop
        insert into public.scheduled_communications
          (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
        values (
          new.tenant_id, 'invoice', new.id, r.trigger_key, tmpl.id, tmpl.type,
          case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
          tmpl.subject, tmpl.body, v_scheduled_for
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment receipt - fires immediately when an invoice is marked paid, a
-- different shape from the "sent" trigger above (see this file's header
-- comment on trigger firing order vs. cancel_pending_invoice_communications).
-- ---------------------------------------------------------------------------

create or replace function public.schedule_invoice_payment_receipt()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
begin
  if new.status = 'paid' and new.status is distinct from old.status then
    select * into v_client from public.clients where id = new.client_id;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id
        and trigger_key = 'invoice_payment_received'
        and is_enabled = true
    loop
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'invoice' and entity_id = new.id and trigger_key = r.trigger_key
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
          new.tenant_id, 'invoice', new.id, r.trigger_key, tmpl.id, tmpl.type,
          case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
          tmpl.subject, tmpl.body, now()
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_invoice_payment_receipt_trigger
  after update on public.invoices
  for each row execute function public.schedule_invoice_payment_receipt();
