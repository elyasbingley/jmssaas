-- Atomic writes for quote/invoice line items, called via supabase-js's
-- .rpc(). Previously the app did delete-then-reinsert as two separate
-- REST calls from app/quotes/[id].tsx and app/invoices/[id].tsx; a failure
-- between the two left a quote/invoice with mismatched or missing line
-- items. Wrapping each operation in a single plpgsql function makes it one
-- transaction.
--
-- All three functions are SECURITY INVOKER (the default - no `security
-- definer` here deliberately), so they run with the calling user's own
-- privileges and are still subject to the existing RLS policies on
-- quotes/invoices/*_line_items (tenant-wide read, admin-only write). A
-- technician calling these gets the same "row violates row-level security
-- policy" rejection they'd get from a direct insert/update today - nothing
-- about the authorization model changes, only the atomicity.

-- ---------------------------------------------------------------------------
-- Shared GST math, mirroring packages/shared/src/money.ts's
-- calculateDocumentTotals exactly (AU GST = 10%; each line's subtotal is
-- round(quantity * unit_price_cents), each line's GST is round(subtotal *
-- 0.1) when gst_applicable). This is the single source of truth for
-- quote/invoice totals server-side - totals are always recomputed from the
-- line items actually being stored, never trusted from the client, for
-- both the replace_* functions below and convert_quote_to_invoice.
-- ---------------------------------------------------------------------------

create or replace function public.calculate_line_item_totals(p_items jsonb)
returns table (subtotal_cents bigint, gst_cents bigint, total_cents bigint)
language sql
stable
as $$
  with lines as (
    select
      round((item ->> 'quantity')::numeric * (item ->> 'unit_price_cents')::numeric)::bigint as line_subtotal_cents,
      (item ->> 'gst_applicable')::boolean as gst_applicable
    from jsonb_array_elements(p_items) as item
  ),
  totals as (
    select
      coalesce(sum(line_subtotal_cents), 0)::bigint as subtotal_cents,
      coalesce(sum(case when gst_applicable then round(line_subtotal_cents * 0.1) else 0 end), 0)::bigint as gst_cents
    from lines
  )
  select subtotal_cents, gst_cents, subtotal_cents + gst_cents as total_cents
  from totals
$$;

-- ---------------------------------------------------------------------------
-- Two separate functions (not one parameterized by table name) to avoid
-- dynamic SQL - the line item shape is identical for quotes and invoices,
-- but keeping them as plain static SQL is easier to read, easier to keep
-- RLS-safe, and isn't meaningfully more code than a dynamic version would
-- be once you account for the format()/EXECUTE plumbing.
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
    id, tenant_id, quote_id, item_type, description, quantity, unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_tenant_id,
    p_quote_id,
    (item ->> 'item_type')::public.line_item_type,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
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
    id, tenant_id, invoice_id, item_type, description, quantity, unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_tenant_id,
    p_invoice_id,
    (item ->> 'item_type')::public.line_item_type,
    item ->> 'description',
    (item ->> 'quantity')::numeric,
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

-- ---------------------------------------------------------------------------
-- Convert a quote to an invoice: reads the quote + its line items, creates
-- the invoice, and copies the line items across, all in one transaction.
-- Totals are recomputed from the copied line items (via
-- calculate_line_item_totals) rather than accepted as a parameter, so an
-- invoice's totals can never disagree with its own line items regardless of
-- what the calling client believed the quote's totals were.
-- ---------------------------------------------------------------------------

create or replace function public.convert_quote_to_invoice(
  p_quote_id uuid,
  p_invoice_number text,
  p_due_date date
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
        'item_type', item_type,
        'description', description,
        'quantity', quantity,
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
    id, tenant_id, invoice_id, item_type, description, quantity, unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_quote.tenant_id,
    v_invoice_id,
    item_type,
    description,
    quantity,
    unit_price_cents,
    gst_applicable,
    sort_order
  from public.quote_line_items
  where quote_id = p_quote_id;

  return v_invoice_id;
end;
$$;

grant execute on function public.calculate_line_item_totals(jsonb) to authenticated;
grant execute on function public.replace_quote_line_items(uuid, jsonb) to authenticated;
grant execute on function public.replace_invoice_line_items(uuid, jsonb) to authenticated;
grant execute on function public.convert_quote_to_invoice(uuid, text, date) to authenticated;
