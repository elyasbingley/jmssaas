-- Brings get_quote_for_approval/get_invoice_for_approval's returned jsonb
-- up to what the redesigned approval-page.html needs: tenant branding
-- fields (ABN/license/email/website/business address) for the header,
-- the client's company_name/client_type for a company client's "Attn:
-- {contact}" line, the job's site (client_sites row, via site_id) for the
-- new Site/Property Address column, and each line item's unit (already
-- used by the desktop/mobile PDF paths' "1 job"/"3 each" suffix).
--
-- Also restores payment_status/stripe_checkout_url on get_invoice_for_
-- approval - added by the approval_page_stripe_field migration, then
-- silently dropped by a later create-or-replace (optional_bundled_line_
-- items or one after it) that redefined the whole function from an older
-- copy without carrying those two fields forward. Without payment_status,
-- the page's own "this invoice has already been paid" check
-- (doc.payment_status === "paid") could never fire on initial load.
-- redefines both functions in full since create or replace function has
-- no column-add equivalent for a plpgsql function's return shape.

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
  v_site public.client_sites;
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
  if v_quote.site_id is not null then
    select * into v_site from public.client_sites where id = v_quote.site_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'description', description,
        'quantity', quantity,
        'unit', unit,
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
    'tenant_abn', v_tenant.abn,
    'tenant_license_number', v_tenant.license_number,
    'tenant_email', v_tenant.email,
    'tenant_website', v_tenant.website,
    'tenant_address_line1', v_tenant.business_address_line1,
    'tenant_address_line2', v_tenant.business_address_line2,
    'tenant_suburb', v_tenant.business_suburb,
    'tenant_state', v_tenant.business_state,
    'tenant_postcode', v_tenant.business_postcode,
    'client_name', v_client.name,
    'client_company_name', v_client.company_name,
    'client_type', v_client.client_type,
    'client_email', v_client.email,
    'client_phone', v_client.phone,
    'client_address_line1', v_client.address_line1,
    'client_address_line2', v_client.address_line2,
    'client_suburb', v_client.suburb,
    'client_state', v_client.state,
    'client_postcode', v_client.postcode,
    'site_label', v_site.label,
    'site_address_line1', v_site.address_line1,
    'site_address_line2', v_site.address_line2,
    'site_suburb', v_site.suburb,
    'site_state', v_site.state,
    'site_postcode', v_site.postcode,
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
  v_site public.client_sites;
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
  if v_invoice.site_id is not null then
    select * into v_site from public.client_sites where id = v_invoice.site_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'description', description,
        'quantity', quantity,
        'unit', unit,
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
    'payment_status', v_invoice.status,
    'stripe_checkout_url', v_invoice.stripe_checkout_url,
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
    'tenant_abn', v_tenant.abn,
    'tenant_license_number', v_tenant.license_number,
    'tenant_email', v_tenant.email,
    'tenant_website', v_tenant.website,
    'tenant_address_line1', v_tenant.business_address_line1,
    'tenant_address_line2', v_tenant.business_address_line2,
    'tenant_suburb', v_tenant.business_suburb,
    'tenant_state', v_tenant.business_state,
    'tenant_postcode', v_tenant.business_postcode,
    'client_name', v_client.name,
    'client_company_name', v_client.company_name,
    'client_type', v_client.client_type,
    'client_email', v_client.email,
    'client_phone', v_client.phone,
    'client_address_line1', v_client.address_line1,
    'client_address_line2', v_client.address_line2,
    'client_suburb', v_client.suburb,
    'client_state', v_client.state,
    'client_postcode', v_client.postcode,
    'site_label', v_site.label,
    'site_address_line1', v_site.address_line1,
    'site_address_line2', v_site.address_line2,
    'site_suburb', v_site.suburb,
    'site_state', v_site.state,
    'site_postcode', v_site.postcode,
    'line_items', v_items
  );
end;
$$;
