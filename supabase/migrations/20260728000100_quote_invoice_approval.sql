-- Quote/invoice digital acceptance. A client-facing, unauthenticated web
-- page (served by the "approve" Supabase Edge Function - see
-- supabase/functions/approve/) lets a client view a quote/invoice by a
-- random token and accept or decline it. Everything that actually mutates
-- data lives in SECURITY DEFINER functions here, not in the Edge Function
-- itself - the function is a thin HTML/form layer, all validation
-- (token exists, not expired, not already resolved) and the actual writes
-- happen in Postgres, the same "server is the source of truth" pattern
-- already used for replace_quote_line_items/convert_quote_to_invoice.
--
-- approval_status is deliberately separate from the existing `status`
-- column on both tables (draft/sent/paid/... for invoices, draft/sent/
-- accepted/... for quotes) - that column already means something else
-- (the internal workflow state), this one specifically tracks the
-- client's response to being sent the document. A quote's own `status`
-- enum happens to already have "accepted"/"declined" values that look
-- similar, but conflating the two would mean the admin manually flipping
-- `status` to "accepted" (which the existing UI lets them do freely, with
-- no token or client action involved) would incorrectly imply the client
-- had actually approved it, and would also incorrectly trip the
-- immutability trigger below. Kept fully separate on purpose.

create type public.document_approval_status as enum ('sent', 'viewed', 'accepted', 'declined');

alter table public.quotes
  add column approval_status public.document_approval_status,
  add column access_token text unique,
  add column token_expires_at timestamptz,
  add column viewed_at timestamptz,
  add column accepted_at timestamptz,
  add column accepted_by_name text,
  add column declined_at timestamptz,
  add column decline_reason text;

alter table public.invoices
  add column approval_status public.document_approval_status,
  add column access_token text unique,
  add column token_expires_at timestamptz,
  add column viewed_at timestamptz,
  add column accepted_at timestamptz,
  add column accepted_by_name text,
  add column declined_at timestamptz,
  add column decline_reason text;

-- ---------------------------------------------------------------------------
-- Immutability once accepted. Postgres-level, not a UI courtesy: a BEFORE
-- trigger on the line item tables rejects every insert/update/delete once
-- the parent document is accepted (this is what actually stops
-- replace_quote_line_items/replace_invoice_line_items - both SECURITY
-- INVOKER, so RLS alone wouldn't have caught this since the admin still
-- has a valid "admin writes" policy; the trigger fires regardless of who's
-- calling), and a second trigger on quotes/invoices themselves blocks
-- changes to the money columns specifically (not the whole row - notes,
-- due_date etc. can still be edited after acceptance, only the figures the
-- client agreed to can't move).
-- ---------------------------------------------------------------------------

create or replace function public.enforce_accepted_document_money_lock()
returns trigger
language plpgsql
as $$
begin
  if old.approval_status = 'accepted' then
    if new.subtotal_cents is distinct from old.subtotal_cents
       or new.gst_cents is distinct from old.gst_cents
       or new.total_cents is distinct from old.total_cents then
      raise exception 'This document has been accepted by the client - its totals can no longer be changed';
    end if;
  end if;
  return new;
end;
$$;

create trigger quotes_enforce_accepted_money_lock
  before update on public.quotes
  for each row execute function public.enforce_accepted_document_money_lock();

create trigger invoices_enforce_accepted_money_lock
  before update on public.invoices
  for each row execute function public.enforce_accepted_document_money_lock();

create or replace function public.enforce_accepted_quote_line_items_lock()
returns trigger
language plpgsql
as $$
declare
  v_approval_status public.document_approval_status;
begin
  select approval_status into v_approval_status from public.quotes where id = coalesce(new.quote_id, old.quote_id);
  if v_approval_status = 'accepted' then
    raise exception 'This quote has been accepted by the client - its line items can no longer be changed';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger quote_line_items_enforce_accepted_lock
  before insert or update or delete on public.quote_line_items
  for each row execute function public.enforce_accepted_quote_line_items_lock();

create or replace function public.enforce_accepted_invoice_line_items_lock()
returns trigger
language plpgsql
as $$
declare
  v_approval_status public.document_approval_status;
begin
  select approval_status into v_approval_status from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if v_approval_status = 'accepted' then
    raise exception 'This invoice has been accepted by the client - its line items can no longer be changed';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger invoice_line_items_enforce_accepted_lock
  before insert or update or delete on public.invoice_line_items
  for each row execute function public.enforce_accepted_invoice_line_items_lock();

-- ---------------------------------------------------------------------------
-- Link generation, called from the app by an admin. SECURITY INVOKER (the
-- default) - the UPDATE inside is still subject to the existing "quotes:
-- admin writes - update" / "invoices: admin writes - update" RLS policies,
-- so a non-admin or cross-tenant call just affects 0 rows and hits the
-- explicit check below rather than silently doing nothing. Only creates a
-- token if one doesn't already exist yet, matching the brief - regenerating
-- an expired link isn't handled here (see docs/SETUP.md known-gaps).
-- ---------------------------------------------------------------------------

create or replace function public.generate_quote_approval_link(p_quote_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_token text;
  v_updated int;
begin
  select access_token into v_existing_token from public.quotes where id = p_quote_id;
  if v_existing_token is not null then
    return v_existing_token;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  update public.quotes
  set access_token = v_token,
      token_expires_at = now() + interval '30 days',
      approval_status = coalesce(approval_status, 'sent')
  where id = p_quote_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Quote % not found or not permitted', p_quote_id;
  end if;

  return v_token;
end;
$$;

create or replace function public.generate_invoice_approval_link(p_invoice_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_token text;
  v_updated int;
begin
  select access_token into v_existing_token from public.invoices where id = p_invoice_id;
  if v_existing_token is not null then
    return v_existing_token;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  update public.invoices
  set access_token = v_token,
      token_expires_at = now() + interval '30 days',
      approval_status = coalesce(approval_status, 'sent')
  where id = p_invoice_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Invoice % not found or not permitted', p_invoice_id;
  end if;

  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public, token-authenticated access for the Edge Function - SECURITY
-- DEFINER since the caller is genuinely unauthenticated (no auth.uid(), no
-- tenant), so RLS on quotes/invoices would otherwise reject every read and
-- write outright. The token itself is the credential; every function here
-- re-checks expiry and current approval_status before doing anything, so a
-- stale/guessed/reused request can't do more than the state machine allows.
-- `set search_path = public` pins name resolution so a search_path swap
-- can't redirect these to an attacker-controlled function/table.
-- ---------------------------------------------------------------------------

create or replace function public.get_quote_for_approval(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_tenant public.tenants;
  v_client public.clients;
  v_items jsonb;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_quote.token_expires_at is not null and v_quote.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;

  if v_quote.viewed_at is null then
    update public.quotes
    set viewed_at = now(),
        approval_status = case when approval_status = 'sent' then 'viewed' else approval_status end
    where id = v_quote.id
    returning * into v_quote;
  end if;

  select * into v_tenant from public.tenants where id = v_quote.tenant_id;
  select * into v_client from public.clients where id = v_quote.client_id;

  -- description/quantity/unit_price_cents only - never labour_rate_cents/
  -- material_cost_cents/markup_percent, same rule as the PDF export and the
  -- in-app LineItemSummary: a client-facing view never sees the cost
  -- breakdown behind a line's price.
  select coalesce(
    jsonb_agg(
      jsonb_build_object('description', description, 'quantity', quantity, 'unit_price_cents', unit_price_cents)
      order by sort_order
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = v_quote.id;

  return jsonb_build_object(
    'quote_number', v_quote.quote_number,
    'status', v_quote.approval_status,
    'issue_date', v_quote.issue_date,
    'expiry_date', v_quote.expiry_date,
    'subtotal_cents', v_quote.subtotal_cents,
    'gst_cents', v_quote.gst_cents,
    'total_cents', v_quote.total_cents,
    'notes', v_quote.notes,
    'accepted_by_name', v_quote.accepted_by_name,
    'decline_reason', v_quote.decline_reason,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'client_name', v_client.name,
    'line_items', v_items
  );
end;
$$;

create or replace function public.accept_quote_by_token(p_token text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_quote.token_expires_at is not null and v_quote.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_quote.approval_status);
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    return jsonb_build_object('error', 'name_required');
  end if;

  update public.quotes
  set approval_status = 'accepted', accepted_at = now(), accepted_by_name = trim(p_name)
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.decline_quote_by_token(p_token text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_quote.token_expires_at is not null and v_quote.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_quote.approval_status);
  end if;

  update public.quotes
  set approval_status = 'declined', declined_at = now(), decline_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.get_invoice_for_approval(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_tenant public.tenants;
  v_client public.clients;
  v_items jsonb;
begin
  select * into v_invoice from public.invoices where access_token = p_token;
  if v_invoice.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_invoice.token_expires_at is not null and v_invoice.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;

  if v_invoice.viewed_at is null then
    update public.invoices
    set viewed_at = now(),
        approval_status = case when approval_status = 'sent' then 'viewed' else approval_status end
    where id = v_invoice.id
    returning * into v_invoice;
  end if;

  select * into v_tenant from public.tenants where id = v_invoice.tenant_id;
  select * into v_client from public.clients where id = v_invoice.client_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('description', description, 'quantity', quantity, 'unit_price_cents', unit_price_cents)
      order by sort_order
    ),
    '[]'::jsonb
  )
  into v_items
  from public.invoice_line_items
  where invoice_id = v_invoice.id;

  return jsonb_build_object(
    'invoice_number', v_invoice.invoice_number,
    'status', v_invoice.approval_status,
    'issue_date', v_invoice.issue_date,
    'due_date', v_invoice.due_date,
    'subtotal_cents', v_invoice.subtotal_cents,
    'gst_cents', v_invoice.gst_cents,
    'total_cents', v_invoice.total_cents,
    'notes', v_invoice.notes,
    'accepted_by_name', v_invoice.accepted_by_name,
    'decline_reason', v_invoice.decline_reason,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'client_name', v_client.name,
    'line_items', v_items
  );
end;
$$;

create or replace function public.accept_invoice_by_token(p_token text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where access_token = p_token;
  if v_invoice.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_invoice.token_expires_at is not null and v_invoice.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_invoice.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_invoice.approval_status);
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    return jsonb_build_object('error', 'name_required');
  end if;

  update public.invoices
  set approval_status = 'accepted', accepted_at = now(), accepted_by_name = trim(p_name)
  where id = v_invoice.id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.decline_invoice_by_token(p_token text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where access_token = p_token;
  if v_invoice.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_invoice.token_expires_at is not null and v_invoice.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_invoice.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_invoice.approval_status);
  end if;

  update public.invoices
  set approval_status = 'declined', declined_at = now(), decline_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_invoice.id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.generate_quote_approval_link(uuid) to authenticated;
grant execute on function public.generate_invoice_approval_link(uuid) to authenticated;

-- Revoked from public and granted only to anon/authenticated - these are
-- the only functions in the schema meant to be callable with no session at
-- all, so that's spelled out explicitly rather than relying on Postgres's
-- default "grant execute to public" for a new function.
revoke execute on function public.get_quote_for_approval(text) from public;
revoke execute on function public.accept_quote_by_token(text, text) from public;
revoke execute on function public.decline_quote_by_token(text, text) from public;
revoke execute on function public.get_invoice_for_approval(text) from public;
revoke execute on function public.accept_invoice_by_token(text, text) from public;
revoke execute on function public.decline_invoice_by_token(text, text) from public;

grant execute on function public.get_quote_for_approval(text) to anon, authenticated;
grant execute on function public.accept_quote_by_token(text, text) to anon, authenticated;
grant execute on function public.decline_quote_by_token(text, text) to anon, authenticated;
grant execute on function public.get_invoice_for_approval(text) to anon, authenticated;
grant execute on function public.accept_invoice_by_token(text, text) to anon, authenticated;
grant execute on function public.decline_invoice_by_token(text, text) to anon, authenticated;
