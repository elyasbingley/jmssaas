-- Payments: deposits, part payments and Tap to Pay.
--
-- Before this, an invoice was either paid or not (invoices.status = 'paid'),
-- and the only way money came in through the app was one Stripe Checkout
-- link for the whole invoice total.
--
-- Now every payment is a row in public.payments - cash, bank transfer,
-- cheque, card online (Stripe Checkout), Tap to Pay on the phone (Stripe
-- Terminal), or "other". An invoice's amount paid is the sum of its rows,
-- and an invoice turns 'paid' by itself once that covers the total (and
-- back to 'sent'/'overdue' if a payment is removed). Every existing
-- trigger that keys off status -> 'paid' (payment receipt, referral fee,
-- reminder cancelling, Xero) keeps working exactly as before.
--
-- Deposits are payments against a quote. A quote can ask for a deposit as a
-- % of its total or a fixed amount (company default % in Settings, changed
-- per quote). When the quote becomes an invoice, its deposits move onto the
-- invoice and count towards it.
--
-- No card surcharge anywhere: card payments are charged at the invoice
-- amount (surcharging isn't allowed in Australia any more).
--
-- Writes go only through the functions below (record_payment,
-- delete_payment, and record_stripe_payment for the Edge Functions), so
-- the checks live in one place. Clients read payments through RLS.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column default_deposit_percent numeric(5, 2) not null default 0
    check (default_deposit_percent >= 0 and default_deposit_percent <= 100),
  add column stripe_terminal_location_id text;

alter table public.quotes
  add column deposit_percent numeric(5, 2) check (deposit_percent > 0 and deposit_percent <= 100),
  add column deposit_fixed_cents bigint check (deposit_fixed_cents > 0),
  add column deposit_paid_cents bigint not null default 0,
  add constraint quotes_one_deposit_kind check (deposit_percent is null or deposit_fixed_cents is null);

alter table public.invoices
  add column amount_paid_cents bigint not null default 0,
  -- What the cached Checkout link (stripe_checkout_url) charges and when it
  -- was made, so a link for an old balance is never handed out again.
  add column stripe_checkout_amount_cents bigint,
  add column stripe_checkout_created_at timestamptz;

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid references public.clients (id),
  job_card_id uuid references public.job_cards (id) on delete set null,
  -- A deposit starts on the quote; once the quote has an invoice it also
  -- points at that invoice. An invoice payment only has invoice_id.
  quote_id uuid references public.quotes (id),
  invoice_id uuid references public.invoices (id),
  kind text not null default 'payment' check (kind in ('deposit', 'payment')),
  method text not null check (method in ('tap_to_pay', 'card_online', 'card', 'cash', 'bank_transfer', 'cheque', 'other')),
  amount_cents bigint not null check (amount_cents > 0),
  paid_at timestamptz not null default now(),
  reference text,
  notes text,
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  recorded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (quote_id is not null or invoice_id is not null)
);

create index payments_tenant_id_idx on public.payments (tenant_id);
create index payments_invoice_id_idx on public.payments (invoice_id);
create index payments_quote_id_idx on public.payments (quote_id);
create index payments_job_card_id_idx on public.payments (job_card_id);
-- One row per Stripe charge, however many times Stripe or the phone reports it.
create unique index payments_stripe_payment_intent_id_key on public.payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

alter table public.payments enable row level security;

create policy "payments: tenant read" on public.payments
  for select using (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Deposit maths
-- ---------------------------------------------------------------------------

create or replace function public.quote_deposit_due_cents(p_quote public.quotes)
returns bigint
language sql
immutable
as $$
  select case
    when p_quote.deposit_fixed_cents is not null then least(p_quote.deposit_fixed_cents, greatest(p_quote.total_cents, 0))
    when p_quote.deposit_percent is not null then round(greatest(p_quote.total_cents, 0) * p_quote.deposit_percent / 100)::bigint
    else 0
  end;
$$;

-- New quotes ask for the company's default deposit unless they say otherwise.
create or replace function public.set_quote_default_deposit()
returns trigger
language plpgsql
as $$
declare
  v_percent numeric(5, 2);
begin
  if new.deposit_percent is null and new.deposit_fixed_cents is null then
    select default_deposit_percent into v_percent from public.tenants where id = new.tenant_id;
    if coalesce(v_percent, 0) > 0 then
      new.deposit_percent := v_percent;
    end if;
  end if;
  return new;
end;
$$;

create trigger set_quote_default_deposit_trigger
  before insert on public.quotes
  for each row execute function public.set_quote_default_deposit();

-- ---------------------------------------------------------------------------
-- Keeping totals in step
-- ---------------------------------------------------------------------------

-- The status an invoice should have for what's been paid against it.
create or replace function public.invoice_status_for_payments(p_status public.invoice_status, p_total bigint, p_paid bigint, p_due date)
returns public.invoice_status
language sql
stable
as $$
  select case
    when p_status = 'void' then p_status
    when p_total > 0 and p_paid >= p_total then 'paid'::public.invoice_status
    when p_status = 'paid' then case when p_due is not null and p_due < current_date then 'overdue'::public.invoice_status else 'sent'::public.invoice_status end
    else p_status
  end;
$$;

create or replace function public.refresh_invoice_payments(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid bigint;
  v_last_paid_at timestamptz;
begin
  -- Nothing to keep in step on an invoice that's being deleted (see
  -- invoices_release_payments) - updating it would also clash with the
  -- delete itself.
  if p_invoice_id is null or p_invoice_id::text = coalesce(current_setting('jms.deleting_invoice', true), '') then
    return;
  end if;
  select coalesce(sum(amount_cents), 0), max(paid_at) into v_paid, v_last_paid_at
  from public.payments where invoice_id = p_invoice_id;

  update public.invoices i
  set amount_paid_cents = v_paid,
      status = public.invoice_status_for_payments(i.status, i.total_cents, v_paid, i.due_date),
      paid_at = case
        when public.invoice_status_for_payments(i.status, i.total_cents, v_paid, i.due_date) = 'paid'
          then case when i.status = 'paid' then coalesce(i.paid_at, v_last_paid_at) else coalesce(v_last_paid_at, now()) end
        else null
      end,
      -- The cached Checkout link was for the old balance.
      stripe_checkout_url = case when i.amount_paid_cents is distinct from v_paid then null else i.stripe_checkout_url end,
      stripe_checkout_amount_cents = case when i.amount_paid_cents is distinct from v_paid then null else i.stripe_checkout_amount_cents end
  where i.id = p_invoice_id
    and (i.amount_paid_cents is distinct from v_paid
         or i.status is distinct from public.invoice_status_for_payments(i.status, i.total_cents, v_paid, i.due_date));
end;
$$;

create or replace function public.refresh_quote_payments(p_quote_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_quote_id is null then
    return;
  end if;
  update public.quotes q
  set deposit_paid_cents = coalesce((select sum(amount_cents) from public.payments where quote_id = p_quote_id), 0)
  where q.id = p_quote_id
    and q.deposit_paid_cents is distinct from coalesce((select sum(amount_cents) from public.payments where quote_id = p_quote_id), 0);
end;
$$;

revoke execute on function public.refresh_invoice_payments(uuid) from public, anon, authenticated;
revoke execute on function public.refresh_quote_payments(uuid) from public, anon, authenticated;

-- Fills in the company, client and job from the quote/invoice, and puts a
-- deposit straight onto the quote's invoice if one already exists.
create or replace function public.payments_fill_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_invoice public.invoices;
begin
  if new.quote_id is not null then
    select * into v_quote from public.quotes where id = new.quote_id;
    if new.invoice_id is null then
      select id into new.invoice_id from public.invoices
      where quote_id = new.quote_id and status <> 'void'
      order by created_at desc limit 1;
    end if;
  end if;
  if new.invoice_id is not null then
    select * into v_invoice from public.invoices where id = new.invoice_id;
  end if;
  new.tenant_id := coalesce(v_invoice.tenant_id, v_quote.tenant_id, new.tenant_id);
  new.client_id := coalesce(new.client_id, v_invoice.client_id, v_quote.client_id);
  new.job_card_id := coalesce(new.job_card_id, v_invoice.job_card_id, v_quote.job_card_id);
  return new;
end;
$$;

create trigger payments_fill_links_trigger
  before insert on public.payments
  for each row execute function public.payments_fill_links();

create or replace function public.payments_refresh_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.refresh_invoice_payments(old.invoice_id);
    perform public.refresh_quote_payments(old.quote_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id then
      perform public.refresh_invoice_payments(new.invoice_id);
    end if;
    if tg_op = 'INSERT' or new.quote_id is distinct from old.quote_id then
      perform public.refresh_quote_payments(new.quote_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger payments_refresh_totals_trigger
  after insert or update or delete on public.payments
  for each row execute function public.payments_refresh_totals();

-- When a quote becomes an invoice (convert_quote_to_invoice, or an invoice
-- linked to the quote any other way), its deposits move onto the invoice.
create or replace function public.invoices_claim_quote_deposits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.quote_id is not null and new.status <> 'void'
     and (tg_op = 'INSERT' or new.quote_id is distinct from old.quote_id) then
    update public.payments set invoice_id = new.id
    where quote_id = new.quote_id and invoice_id is null;
  end if;
  return null;
end;
$$;

create trigger invoices_claim_quote_deposits_trigger
  after insert or update of quote_id on public.invoices
  for each row execute function public.invoices_claim_quote_deposits();

-- Deleting an invoice: deposits it carried go back to just their quote (a
-- new invoice from that quote picks them up again); a payment taken on
-- the invoice itself means it can't be deleted until that's removed.
create or replace function public.invoices_release_payments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.payments where invoice_id = old.id and quote_id is null) then
    raise exception 'Invoice % has payments recorded against it - remove them first', old.invoice_number;
  end if;
  perform set_config('jms.deleting_invoice', old.id::text, true);
  update public.payments set invoice_id = null where invoice_id = old.id;
  perform set_config('jms.deleting_invoice', '', true);
  return old;
end;
$$;

create trigger invoices_release_payments_trigger
  before delete on public.invoices
  for each row execute function public.invoices_release_payments();

-- The total changed after payments came in (line items edited): settle the
-- status against the new total.
create or replace function public.invoices_settle_on_total_change()
returns trigger
language plpgsql
as $$
declare
  v_status public.invoice_status;
begin
  if new.total_cents is distinct from old.total_cents and new.amount_paid_cents > 0 then
    v_status := public.invoice_status_for_payments(new.status, new.total_cents, new.amount_paid_cents, new.due_date);
    if v_status is distinct from new.status then
      new.status := v_status;
      new.paid_at := case when v_status = 'paid' then coalesce(new.paid_at, now()) else null end;
    end if;
  end if;
  return new;
end;
$$;

create trigger invoices_settle_on_total_change_trigger
  before update of total_cents on public.invoices
  for each row execute function public.invoices_settle_on_total_change();

-- Someone changed the paid status by hand (the status buttons, Xero, the
-- old Stripe path) rather than by recording a payment:
--  * marked paid: the rest of the balance is recorded as a payment
--    ("Marked as paid"), so the payments list and amount paid agree with
--    the status;
--  * un-marked: that "Marked as paid" payment is taken back off.
-- pg_trigger_depth() = 1 means the status change came straight from an
-- update statement, not from refresh_invoice_payments reacting to a
-- payment being added or removed - those must not undo each other.
create or replace function public.invoices_record_manual_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() <> 1 or new.status is not distinct from old.status then
    return null;
  end if;
  if new.status = 'paid' and new.total_cents > new.amount_paid_cents then
    insert into public.payments (tenant_id, invoice_id, kind, method, amount_cents, paid_at, reference, recorded_by)
    values (new.tenant_id, new.id, 'payment', 'other', new.total_cents - new.amount_paid_cents, coalesce(new.paid_at, now()), 'Marked as paid', auth.uid());
  elsif old.status = 'paid' and new.status <> 'paid' then
    delete from public.payments
    where invoice_id = new.id and method = 'other' and reference = 'Marked as paid';
  end if;
  return null;
end;
$$;

create trigger invoices_record_manual_paid_trigger
  after update of status on public.invoices
  for each row execute function public.invoices_record_manual_paid();

-- ---------------------------------------------------------------------------
-- Writing payments
-- ---------------------------------------------------------------------------

-- The checks every payment goes through. Returns the invoice the payment
-- lands on (null for a deposit on a quote with no invoice yet).
create or replace function public.check_payment_target(p_tenant_id uuid, p_invoice_id uuid, p_quote_id uuid, p_amount_cents bigint, p_allow_over boolean)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_quote public.quotes;
  v_balance bigint;
begin
  if (p_invoice_id is null) = (p_quote_id is null) then
    raise exception 'Choose an invoice or a quote for this payment';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter an amount more than $0';
  end if;

  if p_invoice_id is not null then
    select * into v_invoice from public.invoices where id = p_invoice_id and tenant_id = p_tenant_id;
    if v_invoice.id is null then
      raise exception 'Invoice not found';
    end if;
    if v_invoice.status = 'void' then
      raise exception 'Invoice % is void', v_invoice.invoice_number;
    end if;
    v_balance := greatest(v_invoice.total_cents - v_invoice.amount_paid_cents, 0);
    if v_balance = 0 and not p_allow_over then
      raise exception 'Invoice % is already paid in full', v_invoice.invoice_number;
    end if;
  else
    select * into v_quote from public.quotes where id = p_quote_id and tenant_id = p_tenant_id;
    if v_quote.id is null then
      raise exception 'Quote not found';
    end if;
    if v_quote.status = 'draft' then
      raise exception 'Send the quote before taking a deposit on it';
    end if;
    if v_quote.status in ('declined', 'expired') then
      raise exception 'Quote % is %', v_quote.quote_number, v_quote.status;
    end if;
    v_balance := greatest(v_quote.total_cents - v_quote.deposit_paid_cents, 0);
    if v_balance = 0 and not p_allow_over then
      raise exception 'Quote % is already paid in full', v_quote.quote_number;
    end if;
  end if;

  if p_amount_cents > v_balance and not p_allow_over then
    raise exception 'That''s more than the $% still owing', to_char(v_balance / 100.0, 'FM999,999,990.00');
  end if;
end;
$$;

revoke execute on function public.check_payment_target(uuid, uuid, uuid, bigint, boolean) from public, anon, authenticated;

-- Cash, bank transfer, cheque, card on another machine, other. Anyone in
-- the company can record one (a tech taking cash on site); only an admin
-- can remove one.
create or replace function public.record_payment(
  p_invoice_id uuid default null,
  p_quote_id uuid default null,
  p_amount_cents bigint default null,
  p_method text default 'bank_transfer',
  p_paid_at timestamptz default null,
  p_reference text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then
    raise exception 'Not signed in';
  end if;
  if p_method not in ('card', 'cash', 'bank_transfer', 'cheque', 'other') then
    raise exception 'Card payments through Stripe are recorded automatically';
  end if;
  if p_paid_at is not null and p_paid_at > now() + interval '1 day' then
    raise exception 'The payment date can''t be in the future';
  end if;
  perform public.check_payment_target(v_tenant, p_invoice_id, p_quote_id, p_amount_cents, false);

  insert into public.payments (tenant_id, invoice_id, quote_id, kind, method, amount_cents, paid_at, reference, notes, recorded_by)
  values (
    v_tenant, p_invoice_id, p_quote_id,
    case when p_quote_id is not null then 'deposit' else 'payment' end,
    p_method, p_amount_cents, coalesce(p_paid_at, now()),
    nullif(trim(p_reference), ''), nullif(trim(p_notes), ''), auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object('payment_id', v_id);
end;
$$;

revoke execute on function public.record_payment(uuid, uuid, bigint, text, timestamptz, text, text) from public, anon;
grant execute on function public.record_payment(uuid, uuid, bigint, text, timestamptz, text, text) to authenticated;

create or replace function public.delete_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can remove a payment';
  end if;
  delete from public.payments where id = p_payment_id and tenant_id = public.current_tenant_id();
  if not found then
    raise exception 'Payment not found';
  end if;
end;
$$;

revoke execute on function public.delete_payment(uuid) from public, anon;
grant execute on function public.delete_payment(uuid) to authenticated;

-- For the Edge Functions (service role) once Stripe says the money is in:
-- Checkout (card_online) and Tap to Pay. Safe to call more than once for
-- the same charge - the payment intent id makes it a no-op. Over-payment
-- is still recorded (the money was taken) rather than lost.
create or replace function public.record_stripe_payment(
  p_tenant_id uuid,
  p_invoice_id uuid,
  p_quote_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_stripe_payment_intent_id text,
  p_stripe_checkout_session_id text default null,
  p_recorded_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tenant uuid := p_tenant_id;
begin
  if p_method not in ('card_online', 'tap_to_pay') then
    raise exception 'Unknown Stripe payment method %', p_method;
  end if;
  if p_stripe_payment_intent_id is null then
    raise exception 'A Stripe payment needs its payment intent id';
  end if;

  select id into v_id from public.payments where stripe_payment_intent_id = p_stripe_payment_intent_id;
  if v_id is not null then
    return jsonb_build_object('payment_id', v_id, 'already_recorded', true);
  end if;

  if v_tenant is null then
    v_tenant := coalesce(
      (select tenant_id from public.invoices where id = p_invoice_id),
      (select tenant_id from public.quotes where id = p_quote_id)
    );
  end if;
  perform public.check_payment_target(v_tenant, p_invoice_id, p_quote_id, p_amount_cents, true);

  insert into public.payments (tenant_id, invoice_id, quote_id, kind, method, amount_cents, paid_at, stripe_payment_intent_id, stripe_checkout_session_id, recorded_by)
  values (
    v_tenant, p_invoice_id, p_quote_id,
    case when p_quote_id is not null then 'deposit' else 'payment' end,
    p_method, p_amount_cents, now(), p_stripe_payment_intent_id, p_stripe_checkout_session_id, p_recorded_by
  )
  on conflict (stripe_payment_intent_id) where stripe_payment_intent_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.payments where stripe_payment_intent_id = p_stripe_payment_intent_id;
    return jsonb_build_object('payment_id', v_id, 'already_recorded', true);
  end if;

  if p_invoice_id is not null then
    update public.invoices set stripe_payment_intent_id = p_stripe_payment_intent_id where id = p_invoice_id;
  end if;
  return jsonb_build_object('payment_id', v_id);
end;
$$;

revoke execute on function public.record_stripe_payment(uuid, uuid, uuid, bigint, text, text, text, uuid) from public, anon, authenticated;

-- The old Checkout path now records a payment for the session's invoice.
create or replace function public.mark_invoice_paid_by_stripe(p_stripe_checkout_session_id text, p_stripe_payment_intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where stripe_checkout_session_id = p_stripe_checkout_session_id;
  if v_invoice.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_stripe_payment_intent_id is not null and v_invoice.total_cents > v_invoice.amount_paid_cents then
    perform public.record_stripe_payment(v_invoice.tenant_id, v_invoice.id, null, v_invoice.total_cents - v_invoice.amount_paid_cents,
      'card_online', p_stripe_payment_intent_id, p_stripe_checkout_session_id, null);
  elsif v_invoice.status <> 'paid' then
    update public.invoices set status = 'paid', stripe_payment_intent_id = p_stripe_payment_intent_id where id = v_invoice.id;
  end if;
  return jsonb_build_object('ok', true, 'invoice_id', v_invoice.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The client's approval page
-- ---------------------------------------------------------------------------

-- Added to what get_quote_for_approval / get_invoice_for_approval return
-- (the approve function merges it in), so the page can show the deposit,
-- what's been paid and what's left.
create or replace function public.get_payment_summary_by_token(p_type text, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_invoice public.invoices;
  v_payments jsonb;
begin
  if p_type = 'quote' then
    select * into v_quote from public.quotes where access_token = p_token;
    if v_quote.id is null or (v_quote.token_expires_at is not null and v_quote.token_expires_at < now()) then
      return null;
    end if;
    return jsonb_build_object(
      'deposit_due_cents', public.quote_deposit_due_cents(v_quote),
      'deposit_paid_cents', v_quote.deposit_paid_cents,
      'deposit_remaining_cents', greatest(public.quote_deposit_due_cents(v_quote) - v_quote.deposit_paid_cents, 0),
      'deposit_percent', v_quote.deposit_percent
    );
  elsif p_type = 'invoice' then
    select * into v_invoice from public.invoices where access_token = p_token;
    if v_invoice.id is null or (v_invoice.token_expires_at is not null and v_invoice.token_expires_at < now()) then
      return null;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('amount_cents', amount_cents, 'paid_at', paid_at, 'kind', kind, 'method', method) order by paid_at), '[]'::jsonb)
    into v_payments from public.payments where invoice_id = v_invoice.id;
    return jsonb_build_object(
      'amount_paid_cents', v_invoice.amount_paid_cents,
      'balance_cents', greatest(v_invoice.total_cents - v_invoice.amount_paid_cents, 0),
      'payments', v_payments
    );
  end if;
  return null;
end;
$$;

revoke execute on function public.get_payment_summary_by_token(text, text) from public;
grant execute on function public.get_payment_summary_by_token(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Existing paid invoices get a payment row, so totals add up from day one.
-- (updated_at is left alone - nothing about these invoices really changed.)
-- ---------------------------------------------------------------------------

alter table public.invoices disable trigger set_invoices_updated_at;

insert into public.payments (tenant_id, client_id, job_card_id, invoice_id, kind, method, amount_cents, paid_at, reference, stripe_payment_intent_id, stripe_checkout_session_id)
select
  i.tenant_id, i.client_id, i.job_card_id, i.id, 'payment',
  case when i.stripe_payment_intent_id is not null then 'card_online' else 'other' end,
  i.total_cents,
  coalesce(i.paid_at, i.updated_at),
  'Paid before payment tracking',
  i.stripe_payment_intent_id,
  i.stripe_checkout_session_id
from public.invoices i
where i.status = 'paid' and i.total_cents > 0;

alter table public.invoices enable trigger set_invoices_updated_at;
