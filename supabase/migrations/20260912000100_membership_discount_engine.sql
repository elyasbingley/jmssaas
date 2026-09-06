-- Membership Module - Batch 2: the discount engine. Threads the active
-- membership's call-out-fee waiver and percentage discount into the
-- EXISTING totals machinery (calculate_line_item_totals/
-- replace_quote_line_items/replace_invoice_line_items/
-- convert_quote_to_invoice) rather than computing it client-side, because
-- this schema's own invariant (confirmed by atomic_line_item_rpcs.sql's own
-- header comment) is that quote/invoice totals are ALWAYS recomputed
-- server-side from the line items actually being stored, never trusted
-- from the client. A membership discount that only existed in a client-
-- side calculation would silently disagree with that rule the moment
-- anyone re-saved a line item.
--
-- Design decisions worth calling out:
--
--   1. Call-out-fee waiver is NOT applied by zeroing a line's own
--      unit_price_cents (that would be a lossy, one-way transformation -
--      turning a manual override back off would have no way to recover the
--      original catalogue price). Instead each line item gains
--      `waived_amount_cents` (0 normally; set to the line's own subtotal
--      when it's flagged `is_callout_fee` and the client's active
--      membership plan waives it) - `unit_price_cents` itself never
--      changes, and calculate_line_item_totals now simply subtracts
--      waived_amount_cents before computing a line's subtotal/GST
--      contribution. Fully reversible: turning a membership discount
--      override off just re-derives waived_amount_cents from scratch from
--      the unchanged catalogue prices.
--
--   2. `is_callout_fee` is a per-line-item flag copied at save time, not a
--      live join back to price_book_items - quote_line_items/
--      invoice_line_items already have no reference to the price book item
--      they came from at all (description/quantity/rates are already a
--      flattened copy, per line_item_redesign.sql), so this follows the
--      same existing shape rather than introducing the first live
--      cross-reference.
--
--   3. GST is computed on the NET (post-waiver) amount per line - a fully
--      waived call-out fee shouldn't carry GST either. The percentage
--      discount, by contrast, is applied as a lump-sum reduction to the
--      GST-inclusive total (subtotal_cents + gst_cents -
--      membership_discount_cents) rather than recomputed back through
--      GST - simpler, and consistent with how this app already treats a
--      discount as a final adjustment rather than a tax-inclusive
--      recalculation anywhere else in the schema. Worth revisiting if the
--      person wants the discount itself to reduce the taxable amount.
--
--   4. Overriding the discount (`membership_discount_overridden`) means
--      "hands off the membership auto-logic entirely for this document" -
--      once set, replace_*_line_items stops touching membership_discount_
--      percent/cents/client_membership_id and stops auto-deriving
--      waived_amount_cents, trusting exactly what's submitted instead
--      (mirroring nte_exceeded_approved's "sticky flag that survives
--      further edits" shape). Turning it back off re-runs the normal auto
--      path immediately (via set_quote/invoice_membership_discount_override
--      calling replace_*_line_items itself) rather than waiting for the
--      next line-item edit.
--
--   5. The eligible-for-discount subtotal explicitly excludes is_callout_fee
--      lines regardless of whether this particular membership happens to
--      waive the call-out fee - "excluding any line item flagged
--      is_callout_fee" is a general exclusion rule per the spec, not just
--      an accident of the waived amount already being zero.

-- ---------------------------------------------------------------------------
-- quotes / invoices: membership linkage + discount figures
-- ---------------------------------------------------------------------------

alter table public.quotes
  add column client_membership_id uuid references public.client_memberships (id) on delete set null,
  add column membership_discount_percent numeric(5, 2) not null default 0,
  add column membership_discount_cents bigint not null default 0,
  add column membership_discount_overridden boolean not null default false;

alter table public.invoices
  add column client_membership_id uuid references public.client_memberships (id) on delete set null,
  add column membership_discount_percent numeric(5, 2) not null default 0,
  add column membership_discount_cents bigint not null default 0,
  add column membership_discount_overridden boolean not null default false;

-- ---------------------------------------------------------------------------
-- quote_line_items / invoice_line_items: per-line waiver bookkeeping
-- ---------------------------------------------------------------------------

alter table public.quote_line_items
  add column is_callout_fee boolean not null default false,
  add column waived_amount_cents bigint not null default 0;

alter table public.invoice_line_items
  add column is_callout_fee boolean not null default false,
  add column waived_amount_cents bigint not null default 0;

-- ---------------------------------------------------------------------------
-- calculate_line_item_totals: now waiver-aware. Same signature/return type
-- as before (line_item_redesign.sql never re-touched this function, so this
-- is still its original atomic_line_item_rpcs.sql body) - only the body
-- changes, to subtract waived_amount_cents (defaulting to 0 when a caller
-- omits it, so any code path not yet passing the new field behaves exactly
-- as before).
-- ---------------------------------------------------------------------------

create or replace function public.calculate_line_item_totals(p_items jsonb)
returns table (subtotal_cents bigint, gst_cents bigint, total_cents bigint)
language sql
stable
as $$
  with lines as (
    select
      round((item ->> 'quantity')::numeric * (item ->> 'unit_price_cents')::numeric)::bigint
        - coalesce((item ->> 'waived_amount_cents')::bigint, 0) as line_subtotal_cents,
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
-- apply_membership_adjustments: the one place that looks up a client's
-- active membership and decides what each line item's waived_amount_cents
-- should be, plus the document-level percentage discount. Returns the
-- items unchanged (waived_amount_cents forced to 0, no discount) when the
-- client has no active membership - so callers don't need their own
-- membership-or-not branch, just always call this in the non-overridden
-- path.
-- ---------------------------------------------------------------------------

create or replace function public.apply_membership_adjustments(p_items jsonb, p_client_id uuid, p_tenant_id uuid)
returns table (
  adjusted_items jsonb,
  membership_discount_percent numeric,
  membership_discount_cents bigint,
  client_membership_id uuid
)
language plpgsql
stable
as $$
declare
  v_membership record;
begin
  select cm.id as membership_id, mp.discount_percent, mp.waive_callout_fee
  into v_membership
  from public.client_memberships cm
  join public.membership_plans mp on mp.id = cm.membership_plan_id
  where cm.client_id = p_client_id
    and cm.tenant_id = p_tenant_id
    and cm.status = 'active'
  limit 1;

  if v_membership.membership_id is null then
    return query
    select
      coalesce(jsonb_agg(
        (item - 'waived_amount_cents' - 'is_callout_fee')
          || jsonb_build_object(
               'is_callout_fee', coalesce((item ->> 'is_callout_fee')::boolean, false),
               'waived_amount_cents', 0
             )
        order by (item ->> 'sort_order')::int
      ), '[]'::jsonb),
      0::numeric,
      0::bigint,
      null::uuid
    from jsonb_array_elements(p_items) as item;
    return;
  end if;

  return query
  with computed as (
    select
      item,
      coalesce((item ->> 'is_callout_fee')::boolean, false) as is_callout_fee,
      round((item ->> 'quantity')::numeric * (item ->> 'unit_price_cents')::numeric)::bigint as line_subtotal_cents
    from jsonb_array_elements(p_items) as item
  ),
  adjusted as (
    select
      item, is_callout_fee, line_subtotal_cents,
      case when is_callout_fee and v_membership.waive_callout_fee then line_subtotal_cents else 0 end as line_waived_amount_cents
    from computed
  )
  select
    (
      select coalesce(jsonb_agg(
        (a.item - 'waived_amount_cents' - 'is_callout_fee')
          || jsonb_build_object('is_callout_fee', a.is_callout_fee, 'waived_amount_cents', a.line_waived_amount_cents)
        order by (a.item ->> 'sort_order')::int
      ), '[]'::jsonb)
      from adjusted a
    ),
    v_membership.discount_percent,
    (
      select coalesce(round(sum(line_subtotal_cents - line_waived_amount_cents) * v_membership.discount_percent / 100), 0)::bigint
      from adjusted
      where not is_callout_fee
    ),
    v_membership.membership_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- replace_quote_line_items / replace_invoice_line_items: branch on
-- membership_discount_overridden. Same current column set as
-- line_item_redesign.sql's versions (description/quantity/labour_rate_
-- cents/labour_hours/material_cost_cents/markup_percent/unit_price_cents/
-- gst_applicable/sort_order) plus the two new is_callout_fee/
-- waived_amount_cents columns.
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
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents
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
    coalesce((item ->> 'waived_amount_cents')::bigint, 0)
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
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents
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
    coalesce((item ->> 'waived_amount_cents')::bigint, 0)
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

-- ---------------------------------------------------------------------------
-- convert_quote_to_invoice: same signature/column set as
-- 20260829000200_fix_convert_quote_to_invoice_line_items.sql's version
-- (p_quote_id, p_due_date, p_invoice_number default null; carries site_id
-- across). Membership status is re-checked live for the new invoice
-- rather than copying the quote's cached discount figures - the client's
-- membership could have started, lapsed, or changed plan between quoting
-- and converting, same "never trust a snapshot when the current row is one
-- query away" reasoning get_nte_variation_for_approval's own
-- current_total_cents already uses. A freshly created invoice always
-- starts with membership_discount_overridden = false (its column default),
-- so this always runs the auto path.
-- ---------------------------------------------------------------------------

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
        'is_callout_fee', is_callout_fee
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
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents
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
    coalesce((item ->> 'waived_amount_cents')::bigint, 0)
  from jsonb_array_elements(v_adjustment.adjusted_items) as item;

  return v_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin override controls. SECURITY INVOKER (the default, deliberately, as
-- every other function in this file) - the direct `update ... quotes`/
-- `update ... invoices` inside is subject to those tables' existing
-- "admin writes - update" RLS policy, same protection replace_quote_line_
-- items/replace_invoice_line_items already rely on rather than adding a
-- second, redundant admin check here.
-- ---------------------------------------------------------------------------

create or replace function public.set_quote_membership_discount_override(
  p_quote_id uuid,
  p_overridden boolean,
  p_membership_discount_percent numeric default null,
  p_membership_discount_cents bigint default null
)
returns void
language plpgsql
as $$
declare
  v_quote public.quotes;
  v_items jsonb;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  if p_overridden then
    update public.quotes
    set membership_discount_overridden = true,
        membership_discount_percent = coalesce(p_membership_discount_percent, v_quote.membership_discount_percent),
        membership_discount_cents = coalesce(p_membership_discount_cents, v_quote.membership_discount_cents),
        total_cents = v_quote.subtotal_cents + v_quote.gst_cents - coalesce(p_membership_discount_cents, v_quote.membership_discount_cents)
    where id = p_quote_id;
  else
    update public.quotes set membership_discount_overridden = false where id = p_quote_id;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'description', description, 'quantity', quantity,
          'labour_rate_cents', labour_rate_cents, 'labour_hours', labour_hours,
          'material_cost_cents', material_cost_cents, 'markup_percent', markup_percent,
          'unit_price_cents', unit_price_cents, 'gst_applicable', gst_applicable,
          'sort_order', sort_order, 'is_callout_fee', is_callout_fee
        )
        order by sort_order
      ),
      '[]'::jsonb
    )
    into v_items
    from public.quote_line_items where quote_id = p_quote_id;

    -- Re-runs the normal auto path immediately (fresh waived_amount_cents
    -- derived from the unchanged catalogue prices), rather than leaving the
    -- quote showing stale overridden figures until the next line-item edit.
    perform public.replace_quote_line_items(p_quote_id, v_items);
  end if;
end;
$$;

create or replace function public.set_invoice_membership_discount_override(
  p_invoice_id uuid,
  p_overridden boolean,
  p_membership_discount_percent numeric default null,
  p_membership_discount_cents bigint default null
)
returns void
language plpgsql
as $$
declare
  v_invoice public.invoices;
  v_items jsonb;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice.id is null then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  if p_overridden then
    update public.invoices
    set membership_discount_overridden = true,
        membership_discount_percent = coalesce(p_membership_discount_percent, v_invoice.membership_discount_percent),
        membership_discount_cents = coalesce(p_membership_discount_cents, v_invoice.membership_discount_cents),
        total_cents = v_invoice.subtotal_cents + v_invoice.gst_cents - coalesce(p_membership_discount_cents, v_invoice.membership_discount_cents)
    where id = p_invoice_id;
  else
    update public.invoices set membership_discount_overridden = false where id = p_invoice_id;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'description', description, 'quantity', quantity,
          'labour_rate_cents', labour_rate_cents, 'labour_hours', labour_hours,
          'material_cost_cents', material_cost_cents, 'markup_percent', markup_percent,
          'unit_price_cents', unit_price_cents, 'gst_applicable', gst_applicable,
          'sort_order', sort_order, 'is_callout_fee', is_callout_fee
        )
        order by sort_order
      ),
      '[]'::jsonb
    )
    into v_items
    from public.invoice_line_items where invoice_id = p_invoice_id;

    perform public.replace_invoice_line_items(p_invoice_id, v_items);
  end if;
end;
$$;

grant execute on function public.apply_membership_adjustments(jsonb, uuid, uuid) to authenticated;
grant execute on function public.set_quote_membership_discount_override(uuid, boolean, numeric, bigint) to authenticated;
grant execute on function public.set_invoice_membership_discount_override(uuid, boolean, numeric, bigint) to authenticated;
