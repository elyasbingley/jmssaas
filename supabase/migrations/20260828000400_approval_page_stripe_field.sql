-- Expose stripe_checkout_url (and the real invoice.status, distinct from
-- approval_status) from get_invoice_for_approval, so the public approval
-- page can tell "accepted and already has a payment link" and "accepted
-- and paid" apart from a plain re-fetch, without a second round trip.
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
    'payment_status', v_invoice.status,
    'stripe_checkout_url', v_invoice.stripe_checkout_url,
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
