-- Xero two-way sync (ServiceM8-style).
--
-- Before this: "Sync to Xero" pushed one invoice at a time, and a payment
-- recorded in Xero only came back if a Xero webhook (set up separately in
-- the Xero developer portal) reported the invoice as fully paid.
--
-- Now the xero-sync Edge Function runs a "sweep" for each connected company
-- every 10 minutes (pg_cron), straight after any Xero webhook, and on demand
-- ("Sync now" / "Sync to Xero"):
--   1. invoices flagged here (xero_needs_sync) are pushed to Xero - new
--      ones as soon as they're out of draft, changed ones again, voided
--      ones voided in Xero;
--   2. payments taken in the app (Tap to Pay, online card, cash, transfer,
--      ...) are added to the Xero invoice, into the Xero account chosen for
--      that method in Settings (tenants.xero_payment_accounts);
--   3. payments removed here are removed in Xero (xero_payment_deletions);
--   4. payments made in Xero (part or full) come back as payments here
--      (method 'xero'); Xero showing the invoice paid by other means
--      (credit note etc.) settles the rest; Xero voiding it voids it here
--      when no payments are recorded against it here.
--
-- Nothing is ever sent back the way it came: a payment that came from Xero
-- is never pushed to Xero (xero_skip), and the database writes the sweep
-- makes on Xero's behalf (jms.from_xero) don't flag anything to push again.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.payments drop constraint payments_method_check;
alter table public.payments
  add constraint payments_method_check check (method in ('tap_to_pay', 'card_online', 'card', 'cash', 'bank_transfer', 'cheque', 'other', 'xero')),
  add column source text not null default 'app' check (source in ('app', 'xero')),
  add column xero_payment_id text,
  -- What Xero actually holds for this payment (can differ from
  -- amount_cents by a few cents when Xero's invoice total rounds
  -- differently - see the xero-sync function).
  add column xero_amount_cents bigint,
  add column xero_synced_at timestamptz,
  add column xero_sync_error text,
  add column xero_sync_failed_at timestamptz,
  -- Never send this one to Xero (it came from Xero, or it's a placeholder
  -- for a payment made outside the app).
  add column xero_skip boolean not null default false;

create unique index payments_xero_payment_id_key on public.payments (xero_payment_id) where xero_payment_id is not null;

-- Payments recorded before two-way sync existed are not sent to Xero: the
-- invoices they belong to were reconciled in Xero by hand until now.
update public.payments set xero_skip = true;

alter table public.invoices
  add column xero_needs_sync boolean not null default false,
  add column xero_sync_failed_at timestamptz,
  -- Xero's own total and status for the invoice, as of the last sync.
  add column xero_total_cents bigint,
  add column xero_status text;

create index invoices_xero_needs_sync_idx on public.invoices (tenant_id) where xero_needs_sync;
create index invoices_xero_invoice_id_idx on public.invoices (tenant_id, xero_invoice_id) where xero_invoice_id is not null;

alter table public.tenants
  -- Push invoices to Xero automatically once they're sent (vs only from
  -- the "Sync to Xero" button).
  add column xero_auto_sync boolean not null default true,
  -- Which Xero account each payment method lands in:
  -- { "stripe": {"id": "...", "name": "..."}, "card": ..., "cash": ...,
  --   "bank_transfer": ..., "cheque": ..., "other": ... }
  -- "stripe" covers Tap to Pay and online card payments. A method with no
  -- account isn't sent to Xero.
  add column xero_payment_accounts jsonb not null default '{}'::jsonb;

alter table public.xero_connections
  add column last_pulled_at timestamptz,
  add column sweep_lease_until timestamptz,
  add column last_sweep_at timestamptz,
  add column last_sweep_error text,
  -- Xero permissions the payment sync needs that this connection wasn't
  -- granted (connected before they were asked for) - shown in Settings as
  -- "reconnect Xero".
  add column missing_scopes text[] not null default '{}';

-- Payments removed here that need removing in Xero.
create table public.xero_payment_deletions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  xero_payment_id text not null unique,
  created_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text
);

alter table public.xero_payment_deletions enable row level security;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace function public.from_xero()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('jms.from_xero', true), '') = 'on';
$$;

-- Placeholders for money received outside the app, and payments that came
-- from Xero, are never sent to Xero.
create or replace function public.payments_xero_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'xero' or new.method = 'xero' or new.reference in ('Marked as paid', 'Paid before payment tracking') then
    new.xero_skip := true;
  end if;
  return new;
end;
$$;

create trigger payments_xero_defaults_trigger
  before insert on public.payments
  for each row execute function public.payments_xero_defaults();

-- A payment that's in Xero and is removed here gets removed in Xero too.
create or replace function public.payments_queue_xero_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.xero_payment_id is not null and not public.from_xero() then
    insert into public.xero_payment_deletions (tenant_id, xero_payment_id)
    values (old.tenant_id, old.xero_payment_id)
    on conflict (xero_payment_id) do nothing;
  end if;
  return null;
end;
$$;

create trigger payments_queue_xero_deletion_trigger
  after delete on public.payments
  for each row execute function public.payments_queue_xero_deletion();

-- Flags an invoice for the next sweep to push:
--  * not in Xero yet and just out of draft (sent, or paid straight away);
--  * in Xero and something Xero shows has changed (totals, dates, client,
--    PO number), or it's been voided here.
-- Only for companies connected to Xero with automatic sync on.
create or replace function public.invoices_flag_xero_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.from_xero() or new.status = 'draft' then
    return new;
  end if;
  if not exists (
    select 1 from public.xero_connections c join public.tenants t on t.id = c.tenant_id
    where c.tenant_id = new.tenant_id and t.xero_auto_sync
  ) then
    return new;
  end if;

  if new.xero_invoice_id is null then
    -- Only at the moment it leaves draft: an older invoice that never went
    -- to Xero (maybe because it was typed into Xero by hand) isn't pushed
    -- just because something about it changes now.
    if new.status <> 'void' and (tg_op = 'INSERT' or old.status = 'draft') then
      new.xero_needs_sync := true;
    end if;
  elsif tg_op = 'UPDATE' and (
       (new.status = 'void' and old.status <> 'void')
    or (new.status <> 'void' and (
         new.total_cents is distinct from old.total_cents
      or new.subtotal_cents is distinct from old.subtotal_cents
      or new.issue_date is distinct from old.issue_date
      or new.due_date is distinct from old.due_date
      or new.client_id is distinct from old.client_id
      or new.po_number is distinct from old.po_number))
  ) then
    new.xero_needs_sync := true;
    new.xero_sync_failed_at := null;
  end if;
  return new;
end;
$$;

create trigger invoices_flag_xero_sync_trigger
  before insert or update on public.invoices
  for each row execute function public.invoices_flag_xero_sync();

-- ---------------------------------------------------------------------------
-- What the xero-sync function calls (service role only)
-- ---------------------------------------------------------------------------

-- One sweep at a time per company (a webhook, the 10-minute schedule and a
-- "Sync now" can all arrive together). Returns false if one is running.
create or replace function public.xero_claim_sweep(p_tenant_id uuid, p_seconds int default 240)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.xero_connections
  set sweep_lease_until = now() + make_interval(secs => p_seconds)
  where tenant_id = p_tenant_id and (sweep_lease_until is null or sweep_lease_until < now());
  return found;
end;
$$;

-- The result of pushing an invoice: its Xero id/total/status, or the error.
create or replace function public.xero_record_invoice_sync(
  p_invoice_id uuid,
  p_xero_invoice_id text,
  p_xero_total_cents bigint,
  p_xero_status text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('jms.from_xero', 'on', true);
  if p_error is null then
    update public.invoices
    set xero_invoice_id = coalesce(p_xero_invoice_id, xero_invoice_id),
        xero_total_cents = p_xero_total_cents,
        xero_status = p_xero_status,
        xero_synced_at = now(),
        xero_sync_error = null,
        xero_sync_failed_at = null,
        xero_needs_sync = false
    where id = p_invoice_id;
  else
    update public.invoices
    set xero_sync_error = p_error, xero_sync_failed_at = now()
    where id = p_invoice_id;
  end if;
  perform set_config('jms.from_xero', '', true);
end;
$$;

-- A payment made in Xero. Returns what happened:
--   'imported', 'exists' (already here - e.g. one this app sent),
--   'removed_here' (deleted here, waiting to be deleted in Xero),
--   'already_paid' (nothing owing here - not imported, so nothing is
--   counted twice), 'no_invoice'.
-- A real payment replaces any placeholder for money received outside the
-- app ("Marked as paid" / "Paid before payment tracking") on the invoice:
-- Xero is the record for those.
create or replace function public.xero_import_payment(
  p_invoice_id uuid,
  p_xero_payment_id text,
  p_amount_cents bigint,
  p_paid_on date,
  p_reference text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_paid bigint;
begin
  if exists (select 1 from public.payments where xero_payment_id = p_xero_payment_id) then
    return 'exists';
  end if;
  if exists (select 1 from public.xero_payment_deletions where xero_payment_id = p_xero_payment_id) then
    return 'removed_here';
  end if;
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    return 'no_invoice';
  end if;

  perform set_config('jms.from_xero', 'on', true);
  delete from public.payments
  where invoice_id = p_invoice_id and xero_payment_id is null
    and reference in ('Marked as paid', 'Paid before payment tracking');

  select coalesce(sum(amount_cents), 0) into v_paid from public.payments where invoice_id = p_invoice_id;
  if v_paid >= v_invoice.total_cents and v_invoice.total_cents > 0 then
    perform set_config('jms.from_xero', '', true);
    return 'already_paid';
  end if;

  insert into public.payments (tenant_id, invoice_id, kind, method, amount_cents, paid_at, reference, source, xero_payment_id, xero_amount_cents, xero_synced_at, xero_skip)
  values (
    v_invoice.tenant_id, p_invoice_id, 'payment', 'xero', p_amount_cents,
    (p_paid_on + time '12:00') at time zone 'Australia/Sydney',
    nullif(trim(coalesce(p_reference, '')), ''), 'xero', p_xero_payment_id, p_amount_cents, now(), true
  );
  perform set_config('jms.from_xero', '', true);
  return 'imported';
end;
$$;

-- A payment deleted in Xero. One that came from Xero is deleted here too;
-- one this app took (Tap to Pay, cash, ...) stays here - the money was
-- really received - and is marked so it isn't sent to Xero again.
create or replace function public.xero_payment_removed(p_xero_payment_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where xero_payment_id = p_xero_payment_id;
  if v_payment.id is null then
    return 'unknown';
  end if;
  perform set_config('jms.from_xero', 'on', true);
  if v_payment.source = 'xero' then
    delete from public.payments where id = v_payment.id;
    perform set_config('jms.from_xero', '', true);
    return 'deleted';
  end if;
  update public.payments
  set xero_payment_id = null, xero_amount_cents = null, xero_skip = true,
      xero_sync_error = 'Deleted in Xero - not sent to Xero again'
  where id = v_payment.id;
  perform set_config('jms.from_xero', '', true);
  return 'unlinked';
end;
$$;

-- Xero shows the invoice paid, but payments here don't cover it (paid off
-- with a credit note, written off, or Xero's total is a few cents less):
-- record the rest so the two agree.
create or replace function public.xero_settle_invoice(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_balance bigint;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null or v_invoice.status = 'void' then
    return 'nothing';
  end if;
  if v_invoice.status = 'paid' then
    perform set_config('jms.from_xero', 'on', true);
    update public.invoices set xero_status = 'PAID' where id = p_invoice_id and xero_status is distinct from 'PAID';
    perform set_config('jms.from_xero', '', true);
    return 'nothing';
  end if;
  v_balance := v_invoice.total_cents - v_invoice.amount_paid_cents;
  perform set_config('jms.from_xero', 'on', true);
  if v_balance > 0 then
    insert into public.payments (tenant_id, invoice_id, kind, method, amount_cents, paid_at, reference, source, xero_synced_at, xero_skip)
    values (v_invoice.tenant_id, p_invoice_id, 'payment', 'xero', v_balance, now(), 'Settled in Xero', 'xero', now(), true);
  else
    update public.invoices set status = 'paid' where id = p_invoice_id;
  end if;
  update public.invoices set xero_status = 'PAID' where id = p_invoice_id;
  perform set_config('jms.from_xero', '', true);
  return 'settled';
end;
$$;

-- Xero voided the invoice: void it here, unless payments are recorded
-- against it here - then just flag it for someone to look at.
create or replace function public.xero_void_invoice(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null or v_invoice.status = 'void' then
    return 'nothing';
  end if;
  perform set_config('jms.from_xero', 'on', true);
  if exists (select 1 from public.payments where invoice_id = p_invoice_id) then
    update public.invoices
    set xero_status = 'VOIDED',
        xero_sync_error = 'Voided in Xero, but payments are recorded against it here - check it and void it here if that''s right'
    where id = p_invoice_id;
    perform set_config('jms.from_xero', '', true);
    return 'has_payments';
  end if;
  update public.invoices set status = 'void', xero_status = 'VOIDED', xero_needs_sync = false where id = p_invoice_id;
  perform set_config('jms.from_xero', '', true);
  return 'voided';
end;
$$;

revoke execute on function public.xero_claim_sweep(uuid, int) from public, anon, authenticated;
revoke execute on function public.xero_record_invoice_sync(uuid, text, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.xero_import_payment(uuid, text, bigint, date, text) from public, anon, authenticated;
revoke execute on function public.xero_payment_removed(text) from public, anon, authenticated;
revoke execute on function public.xero_settle_invoice(uuid) from public, anon, authenticated;
revoke execute on function public.xero_void_invoice(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Adds the sync's health to what Settings shows.
create or replace function public.get_xero_connection_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.current_tenant_id();
  v_connection public.xero_connections;
begin
  select * into v_connection from public.xero_connections where tenant_id = v_tenant_id;
  if v_connection.id is null then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object(
    'connected', true,
    'org_name', v_connection.xero_org_name,
    'connected_at', v_connection.connected_at,
    'last_sweep_at', v_connection.last_sweep_at,
    'last_sweep_error', v_connection.last_sweep_error,
    'missing_scopes', to_jsonb(v_connection.missing_scopes),
    'pending_invoices', (select count(*) from public.invoices where tenant_id = v_tenant_id and xero_needs_sync),
    'invoice_errors', (select count(*) from public.invoices where tenant_id = v_tenant_id and xero_needs_sync and xero_sync_error is not null),
    'pending_payments', (
      select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id
      where p.tenant_id = v_tenant_id and p.source = 'app' and not p.xero_skip and p.xero_payment_id is null
        and i.xero_invoice_id is not null
    ),
    'payment_errors', (
      select count(*) from public.payments p
      where p.tenant_id = v_tenant_id and not p.xero_skip and p.xero_payment_id is null and p.xero_sync_error is not null
    )
  );
end;
$$;

-- Turning automatic sync on picks up every sent invoice not yet in Xero
-- from the last 30 days, so nothing sent while it was off is missed.
create or replace function public.tenants_xero_auto_sync_backfill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.xero_auto_sync and not old.xero_auto_sync then
    update public.invoices
    set xero_needs_sync = true
    where tenant_id = new.id and xero_invoice_id is null and status in ('sent', 'overdue', 'paid')
      and issue_date >= current_date - 30;
  end if;
  return null;
end;
$$;

create trigger tenants_xero_auto_sync_backfill_trigger
  after update of xero_auto_sync on public.tenants
  for each row execute function public.tenants_xero_auto_sync_backfill();
