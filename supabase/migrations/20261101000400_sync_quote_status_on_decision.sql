-- Fixes a real gap: accept_quote_by_token/decline_quote_by_token have only
-- ever updated approval_status (sent/viewed/accepted/declined) - the badge
-- on QuoteDetail's own page - never quotes.status (draft/sent/accepted/
-- declined/expired), the column the Quotes list and the Analytics page's
-- Quote Conversion chart actually read. So a client accepting or
-- declining online never showed up anywhere except that one badge until
-- someone in the office noticed and manually clicked the matching Status
-- button on the quote - the two fields had no sync between them at all.
-- Same functions, same bodies, this just also sets status to match in
-- the same UPDATE - no behaviour changes for any existing caller, every
-- existing check/return shape is untouched.

create or replace function public.accept_quote_by_token(
  p_token text,
  p_name text,
  p_signature_svg text default null,
  p_included_optional_item_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_items jsonb;
  v_totals record;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_quote.token_expires_at is not null and v_quote.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.status = 'expired' or (v_quote.expiry_date is not null and v_quote.expiry_date < current_date) then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_quote.approval_status);
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    return jsonb_build_object('error', 'name_required');
  end if;

  update public.quote_line_items
  set is_included = case when is_optional then (id = any(p_included_optional_item_ids)) else true end
  where quote_id = v_quote.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'quantity', quantity,
        'unit_price_cents', unit_price_cents,
        'waived_amount_cents', waived_amount_cents,
        'gst_applicable', gst_applicable
      )
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = v_quote.id and is_included = true;

  select * into v_totals from public.calculate_line_item_totals(v_items);

  update public.quotes
  set status = 'accepted',
      approval_status = 'accepted',
      accepted_at = now(),
      accepted_by_name = trim(p_name),
      accepted_signature_svg = nullif(p_signature_svg, ''),
      subtotal_cents = v_totals.subtotal_cents,
      gst_cents = v_totals.gst_cents,
      total_cents = v_totals.total_cents - v_quote.membership_discount_cents
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
  if v_quote.status = 'expired' or (v_quote.expiry_date is not null and v_quote.expiry_date < current_date) then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_quote.approval_status);
  end if;

  update public.quotes
  set status = 'declined',
      approval_status = 'declined',
      declined_at = now(),
      decline_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$$;
