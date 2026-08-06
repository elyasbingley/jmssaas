-- Phase 2 of the "bug fixes, price book, line-item redesign, PDF generation,
-- nav restructure" pass: replaces the old item_type/unit_price_cents-only
-- line item shape with a labour/material/markup breakdown matching the
-- reference quote/invoice template. Confirmed with the person (the
-- reference formula had no quantity term, but a quantity box was also
-- requested separately):
--
--   Line Total = Qty x [(Labour Rate x Hours + Material Cost) x (1 + Markup%)]
--
-- unit_price_cents is kept as a column, not dropped - it now holds that
-- bracketed per-unit price, computed client-side (see packages/shared/src/
-- money.ts's computeLineItemUnitPriceCents) and persisted as-is. Because of
-- that, calculate_line_item_totals below needs zero changes to its own
-- math: it already does subtotal = round(quantity * unit_price_cents), and
-- that stays true - only what feeds unit_price_cents changed. This
-- migration itself doesn't even re-touch that function's definition.

alter table public.quote_line_items
  add column labour_rate_cents bigint not null default 0,
  add column labour_hours numeric(10, 2) not null default 0,
  add column material_cost_cents bigint not null default 0,
  add column markup_percent numeric(6, 2) not null default 0;

alter table public.invoice_line_items
  add column labour_rate_cents bigint not null default 0,
  add column labour_hours numeric(10, 2) not null default 0,
  add column material_cost_cents bigint not null default 0,
  add column markup_percent numeric(6, 2) not null default 0;

-- Backfill existing rows. There's no way to losslessly reconstruct a
-- labour/material/markup breakdown that was never captured, so the judgment
-- call (per the person's own suggested default) is: treat the existing
-- unit_price_cents as pure material cost, with zero labour/markup. Since
-- unit_price_cents = (0 * 0 + material_cost_cents) * (1 + 0/100) reduces to
-- exactly material_cost_cents under that mapping, unit_price_cents itself
-- doesn't need to change - existing quote/invoice totals are unaffected to
-- the cent by this migration.
update public.quote_line_items set material_cost_cents = unit_price_cents;
update public.invoice_line_items set material_cost_cents = unit_price_cents;

alter table public.quote_line_items drop column item_type;
alter table public.invoice_line_items drop column item_type;

drop type if exists public.line_item_type;

-- ---------------------------------------------------------------------------
-- Atomic RPCs: bodies only need to read/write the new breakdown columns
-- instead of item_type. calculate_line_item_totals is untouched (not
-- re-declared here at all) - see the comment above.
-- ---------------------------------------------------------------------------

create or replace function public.replace_quote_line_items(p_quote_id uuid, p_items jsonb)
returns void
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_totals record;
begin
  select tenant_id into v_tenant_id from public.quotes where id = p_quote_id;
  if v_tenant_id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  delete from public.quote_line_items where quote_id = p_quote_id;

  insert into public.quote_line_items (
    id, tenant_id, quote_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_tenant_id,
    p_quote_id,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
    coalesce((item ->> 'labour_rate_cents')::bigint, 0),
    coalesce((item ->> 'labour_hours')::numeric, 0),
    coalesce((item ->> 'material_cost_cents')::bigint, 0),
    coalesce((item ->> 'markup_percent')::numeric, 0),
    (item ->> 'unit_price_cents')::bigint,
    (item ->> 'gst_applicable')::boolean,
    coalesce((item ->> 'sort_order')::int, (ordinality - 1)::int)
  from jsonb_array_elements(p_items) with ordinality as t(item, ordinality);

  select * into v_totals from public.calculate_line_item_totals(p_items);

  update public.quotes
  set subtotal_cents = v_totals.subtotal_cents,
      gst_cents = v_totals.gst_cents,
      total_cents = v_totals.total_cents
  where id = p_quote_id;
end;
$$;

create or replace function public.replace_invoice_line_items(p_invoice_id uuid, p_items jsonb)
returns void
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_totals record;
begin
  select tenant_id into v_tenant_id from public.invoices where id = p_invoice_id;
  if v_tenant_id is null then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  delete from public.invoice_line_items where invoice_id = p_invoice_id;

  insert into public.invoice_line_items (
    id, tenant_id, invoice_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_tenant_id,
    p_invoice_id,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
    coalesce((item ->> 'labour_rate_cents')::bigint, 0),
    coalesce((item ->> 'labour_hours')::numeric, 0),
    coalesce((item ->> 'material_cost_cents')::bigint, 0),
    coalesce((item ->> 'markup_percent')::numeric, 0),
    (item ->> 'unit_price_cents')::bigint,
    (item ->> 'gst_applicable')::boolean,
    coalesce((item ->> 'sort_order')::int, (ordinality - 1)::int)
  from jsonb_array_elements(p_items) with ordinality as t(item, ordinality);

  select * into v_totals from public.calculate_line_item_totals(p_items);

  update public.invoices
  set subtotal_cents = v_totals.subtotal_cents,
      gst_cents = v_totals.gst_cents,
      total_cents = v_totals.total_cents
  where id = p_invoice_id;
end;
$$;

-- Same signature as 20260723000200_convert_quote_uses_auto_number.sql
-- (p_quote_id, p_due_date, p_invoice_number default null) - only the body
-- changes, to carry the new breakdown columns across from quote to invoice.
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
    id, tenant_id, client_id, job_card_id, quote_id, invoice_number, status,
    issue_date, due_date, subtotal_cents, gst_cents, total_cents, notes, created_by
  ) values (
    v_invoice_id, v_quote.tenant_id, v_quote.client_id, v_quote.job_card_id, v_quote.id, p_invoice_number, 'draft',
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

grant execute on function public.replace_quote_line_items(uuid, jsonb) to authenticated;
grant execute on function public.replace_invoice_line_items(uuid, jsonb) to authenticated;
grant execute on function public.convert_quote_to_invoice(uuid, date, text) to authenticated;
