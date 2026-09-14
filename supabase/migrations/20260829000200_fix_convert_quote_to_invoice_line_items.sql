-- Fixes a real regression from this branch's own
-- 20260828000100_client_contacts_sites_workdrive.sql: that migration's
-- create-or-replace of convert_quote_to_invoice (to carry site_id across
-- from quote to invoice) was written against the *original*
-- 20260721000100_atomic_line_item_rpcs.sql body - the old item_type/
-- unit_price_cents-only line item shape - not the current one from
-- 20260724000100_line_item_redesign.sql (labour_rate_cents/labour_hours/
-- material_cost_cents/markup_percent, item_type column dropped entirely).
-- create or replace fully replaces a function's body, so that migration
-- silently reverted "Convert to invoice" to reference a column
-- (quote_line_items.item_type) that hasn't existed since 20260724000100 -
-- surfaced as "column \"item_type\" does not exist" (42703) the first time
-- anyone actually converted a quote after this branch's migrations ran.
--
-- This redefinition is 20260724000100's body, unchanged, with only
-- site_id added to the invoices insert (the one genuinely new thing this
-- branch needed).
create or replace function public.convert_quote_to_invoice(
  p_quote_id uuid,
  p_due_date date,
  p_invoice_number text default null
)
returns uuid
language plpgsql
as $$
declare
  v_quote public.quotes;
  v_items jsonb;
  v_totals record;
  v_invoice_id uuid := gen_random_uuid();
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'description', description,
        'quantity', quantity,
        'labour_rate_cents', labour_rate_cents,
        'labour_hours', labour_hours,
        'material_cost_cents', material_cost_cents,
        'markup_percent', markup_percent,
        'unit_price_cents', unit_price_cents,
        'gst_applicable', gst_applicable,
        'sort_order', sort_order
      )
      order by sort_order
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = p_quote_id;

  select * into v_totals from public.calculate_line_item_totals(v_items);

  insert into public.invoices (
    id, tenant_id, client_id, job_card_id, quote_id, site_id, invoice_number, status,
    issue_date, due_date, subtotal_cents, gst_cents, total_cents, notes, created_by
  ) values (
    v_invoice_id, v_quote.tenant_id, v_quote.client_id, v_quote.job_card_id, v_quote.id, v_quote.site_id, p_invoice_number, 'draft',
    current_date, p_due_date, v_totals.subtotal_cents, v_totals.gst_cents, v_totals.total_cents, v_quote.notes, auth.uid()
  );

  insert into public.invoice_line_items (
    id, tenant_id, invoice_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_quote.tenant_id,
    v_invoice_id,
    description,
    quantity,
    labour_rate_cents,
    labour_hours,
    material_cost_cents,
    markup_percent,
    unit_price_cents,
    gst_applicable,
    sort_order
  from public.quote_line_items
  where quote_id = p_quote_id;

  return v_invoice_id;
end;
$$;
