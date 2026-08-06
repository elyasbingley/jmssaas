-- Two RPC changes to support signature capture and Stripe payment:
--
--   1. accept_quote_by_token/accept_invoice_by_token gain an optional
--      p_signature_svg param (a base64 PNG data URI, same convention as
--      report_signatures - see the SignaturePad.tsx comment), stored into
--      the accepted_signature_svg column added in the previous migration.
--      Dropped and recreated (rather than a bare create-or-replace) so the
--      old 2-arg overload doesn't linger alongside the new 3-arg one.
--
--   2. mark_invoice_paid_by_stripe - called by the stripe-webhook Edge
--      Function (service role) when Stripe reports a checkout session for
--      this invoice completed. SECURITY DEFINER + revoked from
--      anon/authenticated, same lockdown as the by_token functions, since
--      this is only ever meant to be called with the service role key from
--      a webhook that already verified Stripe's signature - never from a
--      browser.

drop function if exists public.accept_quote_by_token(text, text);

create function public.accept_quote_by_token(p_token text, p_name text, p_signature_svg text default null)
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
  set approval_status = 'accepted', accepted_at = now(), accepted_by_name = trim(p_name),
      accepted_signature_svg = nullif(p_signature_svg, '')
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$$;

drop function if exists public.accept_invoice_by_token(text, text);

create function public.accept_invoice_by_token(p_token text, p_name text, p_signature_svg text default null)
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
  set approval_status = 'accepted', accepted_at = now(), accepted_by_name = trim(p_name),
      accepted_signature_svg = nullif(p_signature_svg, '')
  where id = v_invoice.id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.accept_quote_by_token(text, text, text) from public;
revoke execute on function public.accept_invoice_by_token(text, text, text) from public;
grant execute on function public.accept_quote_by_token(text, text, text) to anon, authenticated;
grant execute on function public.accept_invoice_by_token(text, text, text) to anon, authenticated;

create or replace function public.mark_invoice_paid_by_stripe(
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text
)
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

  update public.invoices
  set status = 'paid', stripe_payment_intent_id = p_stripe_payment_intent_id
  where id = v_invoice.id;

  return jsonb_build_object('ok', true, 'invoice_id', v_invoice.id);
end;
$$;

revoke execute on function public.mark_invoice_paid_by_stripe(text, text) from public;
