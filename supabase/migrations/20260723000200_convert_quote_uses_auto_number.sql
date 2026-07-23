-- convert_quote_to_invoice previously required the caller to supply
-- p_invoice_number, which the mobile app collected via a manual text input.
-- Now that invoice numbers are auto-assigned (see the assign_invoice_number
-- trigger in 20260723000100_ux_overhaul.sql), the parameter becomes optional
-- and defaults to NULL so a plain INSERT with no explicit invoice_number
-- lets that trigger assign one, exactly like every other invoice insert.

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

-- Drop the old 3-arg overload (p_quote_id, p_invoice_number, p_due_date) -
-- the parameter order changed (p_due_date moved before the now-optional
-- p_invoice_number, since Postgres requires parameters with defaults to
-- come last), so this is a genuinely different signature, not a replacement
-- of the same one. Leaving both would leave the app free to accidentally
-- call the old positional order and silently swap due_date/invoice_number.
drop function if exists public.convert_quote_to_invoice(uuid, text, date);

grant execute on function public.convert_quote_to_invoice(uuid, date, text) to authenticated;
