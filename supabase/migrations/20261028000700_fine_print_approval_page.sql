-- Adds fine_print_text to get_quote_for_approval/get_invoice_for_approval's
-- returned jsonb, same way notes already flows through - see the
-- fine_print_templates migration. No other change; redefines both
-- functions in full since create or replace function has no column-add
-- equivalent for a plpgsql function's return shape.

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
        'image_url', image_url,
        'warranty_text', warranty_text
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
    'fine_print_text', v_quote.fine_print_text,
    'accepted_by_name', v_quote.accepted_by_name,
    'decline_reason', v_quote.decline_reason,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'client_name', v_client.name,
    'line_items', v_items
  );
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
      jsonb_build_object(
        'id', id,
        'description', description,
        'quantity', quantity,
        'unit_price_cents', unit_price_cents,
        'bundle_name', bundle_name,
        'image_url', image_url,
        'warranty_text', warranty_text
      )
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
    'fine_print_text', v_invoice.fine_print_text,
    'accepted_by_name', v_invoice.accepted_by_name,
    'decline_reason', v_invoice.decline_reason,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'client_name', v_client.name,
    'line_items', v_items
  );
end;
$$;
