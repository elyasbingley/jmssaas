-- "Subby box" - track subcontractor cost directly on a quote/invoice line
-- item (rather than only through the separate Purchase Order module), so
-- Job Costing and the Analytics module can fold subcontractor cost into
-- job profitability, not just labour + material.
--
-- subcontractor_cost_cents is PER UNIT, same convention as
-- material_cost_cents - multiplied by quantity wherever cost is summed, and
-- included in computeLineItemUnitPriceCents' pre-markup cost basis so a
-- subcontracted line can be priced (cost + markup) from the subcontractor's
-- cost alone, with $0 labour_rate_cents/labour_hours.

alter table public.quote_line_items
  add column is_subcontracted boolean not null default false,
  add column subcontractor_cost_cents bigint not null default 0;

alter table public.invoice_line_items
  add column is_subcontracted boolean not null default false,
  add column subcontractor_cost_cents bigint not null default 0;

-- ---------------------------------------------------------------------------
-- replace_quote_line_items / replace_invoice_line_items / convert_quote_to_
-- invoice: full cumulative redefinition (same convention as every other
-- migration that's touched these), adding is_subcontracted/subcontractor_
-- cost_cents to the insert column list and jsonb extraction.
-- apply_membership_adjustments itself needs no change - it only strips and
-- rebuilds the is_callout_fee/waived_amount_cents keys on each item,
-- passing every other key (these two included) through untouched.
-- ---------------------------------------------------------------------------

create or replace function public.replace_quote_line_items(p_quote_id uuid, p_items jsonb)
returns void
language plpgsql
as $$
declare
  v_quote public.quotes;
  v_totals record;
  v_adjustment record;
  v_final_items jsonb;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  if v_quote.membership_discount_overridden then
    v_final_items := p_items;
  else
    select * into v_adjustment
    from public.apply_membership_adjustments(p_items, v_quote.client_id, v_quote.tenant_id);
    v_final_items := v_adjustment.adjusted_items;
  end if;

  delete from public.quote_line_items where quote_id = p_quote_id;

  insert into public.quote_line_items (
    id, tenant_id, quote_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
    is_subcontracted, subcontractor_cost_cents
  )
  select
    gen_random_uuid(),
    v_quote.tenant_id,
    p_quote_id,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
    coalesce((item ->> 'labour_rate_cents')::bigint, 0),
    coalesce((item ->> 'labour_hours')::numeric, 0),
    coalesce((item ->> 'material_cost_cents')::bigint, 0),
    coalesce((item ->> 'markup_percent')::numeric, 0),
    (item ->> 'unit_price_cents')::bigint,
    (item ->> 'gst_applicable')::boolean,
    coalesce((item ->> 'sort_order')::int, (ordinality - 1)::int),
    coalesce((item ->> 'is_callout_fee')::boolean, false),
    coalesce((item ->> 'waived_amount_cents')::bigint, 0),
    coalesce((item ->> 'is_subcontracted')::boolean, false),
    coalesce((item ->> 'subcontractor_cost_cents')::bigint, 0)
  from jsonb_array_elements(v_final_items) with ordinality as t(item, ordinality);

  select * into v_totals from public.calculate_line_item_totals(v_final_items);

  if v_quote.membership_discount_overridden then
    update public.quotes
    set subtotal_cents = v_totals.subtotal_cents,
        gst_cents = v_totals.gst_cents,
        total_cents = v_totals.subtotal_cents + v_totals.gst_cents - v_quote.membership_discount_cents
    where id = p_quote_id;
  else
    update public.quotes
    set subtotal_cents = v_totals.subtotal_cents,
        gst_cents = v_totals.gst_cents,
        total_cents = v_totals.subtotal_cents + v_totals.gst_cents - v_adjustment.membership_discount_cents,
        membership_discount_percent = v_adjustment.membership_discount_percent,
        membership_discount_cents = v_adjustment.membership_discount_cents,
        client_membership_id = v_adjustment.client_membership_id
    where id = p_quote_id;
  end if;
end;
$$;

create or replace function public.replace_invoice_line_items(p_invoice_id uuid, p_items jsonb)
returns void
language plpgsql
as $$
declare
  v_invoice public.invoices;
  v_totals record;
  v_adjustment record;
  v_final_items jsonb;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice.id is null then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  if v_invoice.membership_discount_overridden then
    v_final_items := p_items;
  else
    select * into v_adjustment
    from public.apply_membership_adjustments(p_items, v_invoice.client_id, v_invoice.tenant_id);
    v_final_items := v_adjustment.adjusted_items;
  end if;

  delete from public.invoice_line_items where invoice_id = p_invoice_id;

  insert into public.invoice_line_items (
    id, tenant_id, invoice_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
    is_subcontracted, subcontractor_cost_cents
  )
  select
    gen_random_uuid(),
    v_invoice.tenant_id,
    p_invoice_id,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
    coalesce((item ->> 'labour_rate_cents')::bigint, 0),
    coalesce((item ->> 'labour_hours')::numeric, 0),
    coalesce((item ->> 'material_cost_cents')::bigint, 0),
    coalesce((item ->> 'markup_percent')::numeric, 0),
    (item ->> 'unit_price_cents')::bigint,
    (item ->> 'gst_applicable')::boolean,
    coalesce((item ->> 'sort_order')::int, (ordinality - 1)::int),
    coalesce((item ->> 'is_callout_fee')::boolean, false),
    coalesce((item ->> 'waived_amount_cents')::bigint, 0),
    coalesce((item ->> 'is_subcontracted')::boolean, false),
    coalesce((item ->> 'subcontractor_cost_cents')::bigint, 0)
  from jsonb_array_elements(v_final_items) with ordinality as t(item, ordinality);

  select * into v_totals from public.calculate_line_item_totals(v_final_items);

  if v_invoice.membership_discount_overridden then
    update public.invoices
    set subtotal_cents = v_totals.subtotal_cents,
        gst_cents = v_totals.gst_cents,
        total_cents = v_totals.subtotal_cents + v_totals.gst_cents - v_invoice.membership_discount_cents
    where id = p_invoice_id;
  else
    update public.invoices
    set subtotal_cents = v_totals.subtotal_cents,
        gst_cents = v_totals.gst_cents,
        total_cents = v_totals.subtotal_cents + v_totals.gst_cents - v_adjustment.membership_discount_cents,
        membership_discount_percent = v_adjustment.membership_discount_percent,
        membership_discount_cents = v_adjustment.membership_discount_cents,
        client_membership_id = v_adjustment.client_membership_id
    where id = p_invoice_id;
  end if;
end;
$$;

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
  v_adjustment record;
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
        'sort_order', sort_order,
        'is_callout_fee', is_callout_fee,
        'is_subcontracted', is_subcontracted,
        'subcontractor_cost_cents', subcontractor_cost_cents
      )
      order by sort_order
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = p_quote_id;

  select * into v_adjustment
  from public.apply_membership_adjustments(v_items, v_quote.client_id, v_quote.tenant_id);

  select * into v_totals from public.calculate_line_item_totals(v_adjustment.adjusted_items);

  insert into public.invoices (
    id, tenant_id, client_id, job_card_id, quote_id, site_id, invoice_number, status,
    issue_date, due_date, subtotal_cents, gst_cents, total_cents, notes, created_by,
    membership_discount_percent, membership_discount_cents, client_membership_id
  ) values (
    v_invoice_id, v_quote.tenant_id, v_quote.client_id, v_quote.job_card_id, v_quote.id, v_quote.site_id, p_invoice_number, 'draft',
    current_date, p_due_date, v_totals.subtotal_cents, v_totals.gst_cents,
    v_totals.subtotal_cents + v_totals.gst_cents - v_adjustment.membership_discount_cents,
    v_quote.notes, auth.uid(),
    v_adjustment.membership_discount_percent, v_adjustment.membership_discount_cents, v_adjustment.client_membership_id
  );

  insert into public.invoice_line_items (
    id, tenant_id, invoice_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
    is_subcontracted, subcontractor_cost_cents
  )
  select
    gen_random_uuid(),
    v_quote.tenant_id,
    v_invoice_id,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
    coalesce((item ->> 'labour_rate_cents')::bigint, 0),
    coalesce((item ->> 'labour_hours')::numeric, 0),
    coalesce((item ->> 'material_cost_cents')::bigint, 0),
    coalesce((item ->> 'markup_percent')::numeric, 0),
    (item ->> 'unit_price_cents')::bigint,
    (item ->> 'gst_applicable')::boolean,
    (item ->> 'sort_order')::int,
    coalesce((item ->> 'is_callout_fee')::boolean, false),
    coalesce((item ->> 'waived_amount_cents')::bigint, 0),
    coalesce((item ->> 'is_subcontracted')::boolean, false),
    coalesce((item ->> 'subcontractor_cost_cents')::bigint, 0)
  from jsonb_array_elements(v_adjustment.adjusted_items) as item;

  return v_invoice_id;
end;
$$;
