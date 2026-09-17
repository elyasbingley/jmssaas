-- Fix: get_quote_for_approval/accept_quote_by_token/decline_quote_by_token
-- checked the approval link's own token_expires_at (a 30-day security
-- expiry on the link itself) but never the quote's own expiry_date (the
-- business "this price is only valid until X" date, set on QuoteDetail/
-- QuoteNew and shown on the approval page as "Expiry date"). A client
-- sitting on a link past expiry_date but still within the 30-day token
-- window could view, accept, or decline a quote whose pricing may no
-- longer be valid - expiry_date was fetched and displayed on the approval
-- page but never actually enforced anywhere server-side.
--
-- Also honors quotes.status = 'expired' (the manual status an admin can
-- set from the desktop/mobile Quote status dropdown, entirely separate
-- from approval_status) - that flag was equally unenforced against these
-- token-based RPCs before this fix, so a quote an admin had manually
-- marked Expired could still be silently accepted via a stale link.
--
-- Returns the same 'error': 'expired' shape the token check already
-- returns, so supabase/static/approval-page.html's existing
-- `data.error === "expired"` handling (all three call sites) covers this
-- with no client-side change needed.

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
  if v_quote.status = 'expired' or (v_quote.expiry_date is not null and v_quote.expiry_date < current_date) then
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

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'description', description,
        'quantity', quantity,
        'unit_price_cents', unit_price_cents,
        'gst_applicable', gst_applicable,
        'waived_amount_cents', waived_amount_cents,
        'is_optional', is_optional,
        'is_included', is_included,
        'bundle_name', bundle_name,
        'image_url', image_url
      )
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

drop function if exists public.accept_quote_by_token(text, text, text, uuid[]);

create function public.accept_quote_by_token(
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

  -- v_quote.membership_discount_cents is whatever replace_quote_line_items
  -- last computed and stored (see its own known-limitation comment at the
  -- top of the optional-bundled-line-items migration re: optional items) -
  -- carried through here rather than dropped, so a member client's quote
  -- doesn't silently lose its discount the moment it's accepted.
  update public.quotes
  set approval_status = 'accepted',
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

revoke execute on function public.accept_quote_by_token(text, text, text, uuid[]) from public;
grant execute on function public.accept_quote_by_token(text, text, text, uuid[]) to anon, authenticated;

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
  set approval_status = 'declined', declined_at = now(), decline_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$$;
