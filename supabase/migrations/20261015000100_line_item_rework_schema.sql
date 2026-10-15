-- Quote & Invoice line item rework - schema + RPC stage.
--
-- Adds the fields needed for itemised, cost-accurate quoting: split
-- labour cost/charge-out rates, a material margin % separate from the old
-- blended markup_percent, waste/contingency % allowances, flat-dollar
-- allowances (tip fees, equipment/scaffold hire, travel), a client-visible
-- warranty field, and office-only internal notes. Itemised materials and
-- multi-worker crew lines get real child tables (quote/invoice_line_item_
-- crew/materials), matching this schema's existing convention of real
-- tables over JSONB for anything relational (quote_line_items, price_book_
-- item_variations, etc.).
--
-- Everything here is purely additive: every new column is nullable (or
-- carries a default that reproduces today's behaviour), and historical
-- quote/invoice line items are never touched or reinterpreted - the same
-- discipline 20260724000100_line_item_redesign.sql followed for the
-- original labour/material/markup split. The shared priceBreakdownSchema
-- (Price Book items/variations, Line Item Bundles) is deliberately left
-- alone; those get the equivalent rework in a later stage.
--
-- pricing_model ('legacy' | 'itemized') is an explicit flag rather than
-- inferring "new model in use" from which columns are non-null - Job
-- Costing/Analytics need an unambiguous signal for which formula produced
-- a line's unit_price_cents, and relying on null-ness would misfire the
-- moment a new-model line happens to have, say, a zero material margin.
--
-- The GST/subtotal pipeline (calculate_line_item_totals, money.ts's
-- lineItemSubtotalCents/lineItemGstCents/calculateDocumentTotals) needs no
-- changes at all: it already only reads quantity/unit_price_cents/
-- gst_applicable/waived_amount_cents, and the server already never
-- recomputes unit_price_cents from the cost breakdown - it trusts whatever
-- the client (the new calc engine) submits, same as every other pricing
-- field today. The new cost-breakdown columns and child tables are stored
-- and passed through, nothing more.

-- ---------------------------------------------------------------------------
-- New columns on quote_line_items / invoice_line_items.
-- ---------------------------------------------------------------------------

alter table public.quote_line_items
  add column pricing_model text not null default 'legacy' check (pricing_model in ('legacy', 'itemized')),
  add column unit text,
  add column labour_cost_rate_cents bigint,
  add column labour_charge_out_rate_cents bigint,
  add column material_margin_percent numeric,
  add column subcontractor_margin_percent numeric,
  add column waste_percent numeric,
  add column contingency_percent numeric,
  add column tip_fees_cents bigint,
  add column equipment_hire_cents bigint,
  add column travel_cost_cents bigint,
  add column warranty_text text,
  add column internal_notes text;

alter table public.invoice_line_items
  add column pricing_model text not null default 'legacy' check (pricing_model in ('legacy', 'itemized')),
  add column unit text,
  add column labour_cost_rate_cents bigint,
  add column labour_charge_out_rate_cents bigint,
  add column material_margin_percent numeric,
  add column subcontractor_margin_percent numeric,
  add column waste_percent numeric,
  add column contingency_percent numeric,
  add column tip_fees_cents bigint,
  add column equipment_hire_cents bigint,
  add column travel_cost_cents bigint,
  add column warranty_text text,
  add column internal_notes text;

-- ---------------------------------------------------------------------------
-- Crew lines: more than one worker per line item, each at their own cost/
-- charge-out rate and hours. labour_cost_entry_id is an optional link back
-- to the Cost of Ops labour roster, so a crew row can default its cost rate
-- from a real staff member's entry instead of the office re-typing it -
-- nullable because a crew row can also be an ad-hoc worker with no Cost of
-- Ops entry at all.
-- ---------------------------------------------------------------------------

create table public.quote_line_item_crew (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  quote_line_item_id uuid not null references public.quote_line_items (id) on delete cascade,
  labour_cost_entry_id uuid references public.labour_cost_entries (id) on delete set null,
  worker_name text not null,
  cost_rate_cents bigint not null default 0,
  charge_out_rate_cents bigint not null default 0,
  hours numeric(8, 2) not null default 0,
  sort_order int not null default 0
);

create index quote_line_item_crew_tenant_id_idx on public.quote_line_item_crew (tenant_id);
create index quote_line_item_crew_line_item_id_idx on public.quote_line_item_crew (quote_line_item_id);

create table public.invoice_line_item_crew (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  invoice_line_item_id uuid not null references public.invoice_line_items (id) on delete cascade,
  labour_cost_entry_id uuid references public.labour_cost_entries (id) on delete set null,
  worker_name text not null,
  cost_rate_cents bigint not null default 0,
  charge_out_rate_cents bigint not null default 0,
  hours numeric(8, 2) not null default 0,
  sort_order int not null default 0
);

create index invoice_line_item_crew_tenant_id_idx on public.invoice_line_item_crew (tenant_id);
create index invoice_line_item_crew_line_item_id_idx on public.invoice_line_item_crew (invoice_line_item_id);

-- ---------------------------------------------------------------------------
-- Itemised materials: a small sub-table of item/qty/unit cost per line,
-- replacing the single material_cost_cents figure for lines using the new
-- model (material_cost_cents stays on the parent row for legacy lines).
-- ---------------------------------------------------------------------------

create table public.quote_line_item_materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  quote_line_item_id uuid not null references public.quote_line_items (id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_cost_cents bigint not null default 0,
  sort_order int not null default 0
);

create index quote_line_item_materials_tenant_id_idx on public.quote_line_item_materials (tenant_id);
create index quote_line_item_materials_line_item_id_idx on public.quote_line_item_materials (quote_line_item_id);

create table public.invoice_line_item_materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  invoice_line_item_id uuid not null references public.invoice_line_items (id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_cost_cents bigint not null default 0,
  sort_order int not null default 0
);

create index invoice_line_item_materials_tenant_id_idx on public.invoice_line_item_materials (tenant_id);
create index invoice_line_item_materials_line_item_id_idx on public.invoice_line_item_materials (invoice_line_item_id);

-- ---------------------------------------------------------------------------
-- RLS: same "tenant read, admin writes" shape as quote_line_items/
-- invoice_line_items themselves. No separate accepted-document lock
-- trigger is needed on these child tables - the only code path that ever
-- writes them is replace_quote_line_items/replace_invoice_line_items
-- (and convert_quote_to_invoice for invoice children), and those already
-- delete-then-reinsert the parent line item first, which
-- enforce_accepted_quote_line_items_lock/enforce_accepted_invoice_line_
-- items_lock blocks outright on an accepted document before any child row
-- is touched.
-- ---------------------------------------------------------------------------

alter table public.quote_line_item_crew enable row level security;

create policy "quote_line_item_crew: tenant read" on public.quote_line_item_crew
  for select using (tenant_id = public.current_tenant_id());

create policy "quote_line_item_crew: admin writes - insert" on public.quote_line_item_crew
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quote_line_item_crew: admin writes - update" on public.quote_line_item_crew
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quote_line_item_crew: admin writes - delete" on public.quote_line_item_crew
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.quote_line_item_materials enable row level security;

create policy "quote_line_item_materials: tenant read" on public.quote_line_item_materials
  for select using (tenant_id = public.current_tenant_id());

create policy "quote_line_item_materials: admin writes - insert" on public.quote_line_item_materials
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quote_line_item_materials: admin writes - update" on public.quote_line_item_materials
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quote_line_item_materials: admin writes - delete" on public.quote_line_item_materials
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.invoice_line_item_crew enable row level security;

create policy "invoice_line_item_crew: tenant read" on public.invoice_line_item_crew
  for select using (tenant_id = public.current_tenant_id());

create policy "invoice_line_item_crew: admin writes - insert" on public.invoice_line_item_crew
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoice_line_item_crew: admin writes - update" on public.invoice_line_item_crew
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoice_line_item_crew: admin writes - delete" on public.invoice_line_item_crew
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.invoice_line_item_materials enable row level security;

create policy "invoice_line_item_materials: tenant read" on public.invoice_line_item_materials
  for select using (tenant_id = public.current_tenant_id());

create policy "invoice_line_item_materials: admin writes - insert" on public.invoice_line_item_materials
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoice_line_item_materials: admin writes - update" on public.invoice_line_item_materials
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoice_line_item_materials: admin writes - delete" on public.invoice_line_item_materials
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- replace_quote_line_items / replace_invoice_line_items: switched from a
-- single bulk INSERT...SELECT to a per-item loop, because inserting each
-- item's crew/materials children needs that item's freshly-generated line
-- item id, which only exists once the parent row has actually been
-- inserted. Every other behaviour (membership adjustment, optional-item
-- total filtering, totals recompute) is unchanged.
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
  v_included_items jsonb;
  v_item jsonb;
  v_ordinality int := 0;
  v_line_item_id uuid;
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

  for v_item in select * from jsonb_array_elements(v_final_items)
  loop
    v_ordinality := v_ordinality + 1;

    insert into public.quote_line_items (
      id, tenant_id, quote_id, description, quantity, unit,
      labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
      unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
      is_subcontracted, subcontractor_cost_cents, is_optional, is_included, bundle_name, image_url,
      pricing_model, labour_cost_rate_cents, labour_charge_out_rate_cents,
      material_margin_percent, subcontractor_margin_percent,
      waste_percent, contingency_percent, tip_fees_cents, equipment_hire_cents, travel_cost_cents,
      warranty_text, internal_notes
    ) values (
      gen_random_uuid(),
      v_quote.tenant_id,
      p_quote_id,
      v_item ->> 'description',
      (v_item ->> 'quantity')::numeric,
      nullif(v_item ->> 'unit', ''),
      coalesce((v_item ->> 'labour_rate_cents')::bigint, 0),
      coalesce((v_item ->> 'labour_hours')::numeric, 0),
      coalesce((v_item ->> 'material_cost_cents')::bigint, 0),
      coalesce((v_item ->> 'markup_percent')::numeric, 0),
      (v_item ->> 'unit_price_cents')::bigint,
      (v_item ->> 'gst_applicable')::boolean,
      coalesce((v_item ->> 'sort_order')::int, v_ordinality - 1),
      coalesce((v_item ->> 'is_callout_fee')::boolean, false),
      coalesce((v_item ->> 'waived_amount_cents')::bigint, 0),
      coalesce((v_item ->> 'is_subcontracted')::boolean, false),
      coalesce((v_item ->> 'subcontractor_cost_cents')::bigint, 0),
      coalesce((v_item ->> 'is_optional')::boolean, false),
      coalesce((v_item ->> 'is_included')::boolean, not coalesce((v_item ->> 'is_optional')::boolean, false)),
      nullif(v_item ->> 'bundle_name', ''),
      nullif(v_item ->> 'image_url', ''),
      coalesce(v_item ->> 'pricing_model', 'legacy'),
      (v_item ->> 'labour_cost_rate_cents')::bigint,
      (v_item ->> 'labour_charge_out_rate_cents')::bigint,
      (v_item ->> 'material_margin_percent')::numeric,
      (v_item ->> 'subcontractor_margin_percent')::numeric,
      (v_item ->> 'waste_percent')::numeric,
      (v_item ->> 'contingency_percent')::numeric,
      (v_item ->> 'tip_fees_cents')::bigint,
      (v_item ->> 'equipment_hire_cents')::bigint,
      (v_item ->> 'travel_cost_cents')::bigint,
      nullif(v_item ->> 'warranty_text', ''),
      nullif(v_item ->> 'internal_notes', '')
    )
    returning id into v_line_item_id;

    insert into public.quote_line_item_crew (
      id, tenant_id, quote_line_item_id, labour_cost_entry_id, worker_name,
      cost_rate_cents, charge_out_rate_cents, hours, sort_order
    )
    select
      gen_random_uuid(),
      v_quote.tenant_id,
      v_line_item_id,
      (crew ->> 'labour_cost_entry_id')::uuid,
      crew ->> 'worker_name',
      coalesce((crew ->> 'cost_rate_cents')::bigint, 0),
      coalesce((crew ->> 'charge_out_rate_cents')::bigint, 0),
      coalesce((crew ->> 'hours')::numeric, 0),
      coalesce((crew ->> 'sort_order')::int, (c_ord - 1)::int)
    from jsonb_array_elements(coalesce(v_item -> 'crew', '[]'::jsonb)) with ordinality as t(crew, c_ord);

    insert into public.quote_line_item_materials (
      id, tenant_id, quote_line_item_id, description, quantity, unit_cost_cents, sort_order
    )
    select
      gen_random_uuid(),
      v_quote.tenant_id,
      v_line_item_id,
      material ->> 'description',
      coalesce((material ->> 'quantity')::numeric, 1),
      coalesce((material ->> 'unit_cost_cents')::bigint, 0),
      coalesce((material ->> 'sort_order')::int, (m_ord - 1)::int)
    from jsonb_array_elements(coalesce(v_item -> 'materials', '[]'::jsonb)) with ordinality as t(material, m_ord);
  end loop;

  -- Same is_included filter accept_quote_by_token uses at acceptance time -
  -- an optional item starting unchecked shouldn't be baked into the total
  -- the office sees (or what's printed/emailed) before the client has had
  -- any chance to opt into it.
  select coalesce(jsonb_agg(item), '[]'::jsonb)
  into v_included_items
  from jsonb_array_elements(v_final_items) as item
  where coalesce((item ->> 'is_included')::boolean, not coalesce((item ->> 'is_optional')::boolean, false));

  select * into v_totals from public.calculate_line_item_totals(v_included_items);

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
  v_item jsonb;
  v_ordinality int := 0;
  v_line_item_id uuid;
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

  for v_item in select * from jsonb_array_elements(v_final_items)
  loop
    v_ordinality := v_ordinality + 1;

    insert into public.invoice_line_items (
      id, tenant_id, invoice_id, description, quantity, unit,
      labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
      unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
      is_subcontracted, subcontractor_cost_cents, bundle_name, image_url,
      pricing_model, labour_cost_rate_cents, labour_charge_out_rate_cents,
      material_margin_percent, subcontractor_margin_percent,
      waste_percent, contingency_percent, tip_fees_cents, equipment_hire_cents, travel_cost_cents,
      warranty_text, internal_notes
    ) values (
      gen_random_uuid(),
      v_invoice.tenant_id,
      p_invoice_id,
      v_item ->> 'description',
      (v_item ->> 'quantity')::numeric,
      nullif(v_item ->> 'unit', ''),
      coalesce((v_item ->> 'labour_rate_cents')::bigint, 0),
      coalesce((v_item ->> 'labour_hours')::numeric, 0),
      coalesce((v_item ->> 'material_cost_cents')::bigint, 0),
      coalesce((v_item ->> 'markup_percent')::numeric, 0),
      (v_item ->> 'unit_price_cents')::bigint,
      (v_item ->> 'gst_applicable')::boolean,
      coalesce((v_item ->> 'sort_order')::int, v_ordinality - 1),
      coalesce((v_item ->> 'is_callout_fee')::boolean, false),
      coalesce((v_item ->> 'waived_amount_cents')::bigint, 0),
      coalesce((v_item ->> 'is_subcontracted')::boolean, false),
      coalesce((v_item ->> 'subcontractor_cost_cents')::bigint, 0),
      nullif(v_item ->> 'bundle_name', ''),
      nullif(v_item ->> 'image_url', ''),
      coalesce(v_item ->> 'pricing_model', 'legacy'),
      (v_item ->> 'labour_cost_rate_cents')::bigint,
      (v_item ->> 'labour_charge_out_rate_cents')::bigint,
      (v_item ->> 'material_margin_percent')::numeric,
      (v_item ->> 'subcontractor_margin_percent')::numeric,
      (v_item ->> 'waste_percent')::numeric,
      (v_item ->> 'contingency_percent')::numeric,
      (v_item ->> 'tip_fees_cents')::bigint,
      (v_item ->> 'equipment_hire_cents')::bigint,
      (v_item ->> 'travel_cost_cents')::bigint,
      nullif(v_item ->> 'warranty_text', ''),
      nullif(v_item ->> 'internal_notes', '')
    )
    returning id into v_line_item_id;

    insert into public.invoice_line_item_crew (
      id, tenant_id, invoice_line_item_id, labour_cost_entry_id, worker_name,
      cost_rate_cents, charge_out_rate_cents, hours, sort_order
    )
    select
      gen_random_uuid(),
      v_invoice.tenant_id,
      v_line_item_id,
      (crew ->> 'labour_cost_entry_id')::uuid,
      crew ->> 'worker_name',
      coalesce((crew ->> 'cost_rate_cents')::bigint, 0),
      coalesce((crew ->> 'charge_out_rate_cents')::bigint, 0),
      coalesce((crew ->> 'hours')::numeric, 0),
      coalesce((crew ->> 'sort_order')::int, (c_ord - 1)::int)
    from jsonb_array_elements(coalesce(v_item -> 'crew', '[]'::jsonb)) with ordinality as t(crew, c_ord);

    insert into public.invoice_line_item_materials (
      id, tenant_id, invoice_line_item_id, description, quantity, unit_cost_cents, sort_order
    )
    select
      gen_random_uuid(),
      v_invoice.tenant_id,
      v_line_item_id,
      material ->> 'description',
      coalesce((material ->> 'quantity')::numeric, 1),
      coalesce((material ->> 'unit_cost_cents')::bigint, 0),
      coalesce((material ->> 'sort_order')::int, (m_ord - 1)::int)
    from jsonb_array_elements(coalesce(v_item -> 'materials', '[]'::jsonb)) with ordinality as t(material, m_ord);
  end loop;

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
-- convert_quote_to_invoice: the quote_line_items -> jsonb build now carries
-- each row's own id (previously omitted - nothing needed to reference an
-- individual item before this). apply_membership_adjustments preserves
-- unknown JSON keys untouched (it only ever touches waived_amount_cents/
-- is_callout_fee), so the id survives into v_adjustment.adjusted_items and
-- is used purely to copy that quote line's crew/materials children across
-- to the newly-created invoice line item - it's never written to the
-- invoice_line_items row itself (which gets its own fresh id, same as
-- before).
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
  v_item jsonb;
  v_quote_line_item_id uuid;
  v_invoice_line_item_id uuid;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'description', description,
        'quantity', quantity,
        'unit', unit,
        'labour_rate_cents', labour_rate_cents,
        'labour_hours', labour_hours,
        'material_cost_cents', material_cost_cents,
        'markup_percent', markup_percent,
        'unit_price_cents', unit_price_cents,
        'gst_applicable', gst_applicable,
        'sort_order', sort_order,
        'is_callout_fee', is_callout_fee,
        'is_subcontracted', is_subcontracted,
        'subcontractor_cost_cents', subcontractor_cost_cents,
        'bundle_name', bundle_name,
        'image_url', image_url,
        'pricing_model', pricing_model,
        'labour_cost_rate_cents', labour_cost_rate_cents,
        'labour_charge_out_rate_cents', labour_charge_out_rate_cents,
        'material_margin_percent', material_margin_percent,
        'subcontractor_margin_percent', subcontractor_margin_percent,
        'waste_percent', waste_percent,
        'contingency_percent', contingency_percent,
        'tip_fees_cents', tip_fees_cents,
        'equipment_hire_cents', equipment_hire_cents,
        'travel_cost_cents', travel_cost_cents,
        'warranty_text', warranty_text,
        'internal_notes', internal_notes
      )
      order by sort_order
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = p_quote_id and is_included = true;

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

  for v_item in select * from jsonb_array_elements(v_adjustment.adjusted_items)
  loop
    v_quote_line_item_id := (v_item ->> 'id')::uuid;

    insert into public.invoice_line_items (
      id, tenant_id, invoice_id, description, quantity, unit,
      labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
      unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
      is_subcontracted, subcontractor_cost_cents, bundle_name, image_url,
      pricing_model, labour_cost_rate_cents, labour_charge_out_rate_cents,
      material_margin_percent, subcontractor_margin_percent,
      waste_percent, contingency_percent, tip_fees_cents, equipment_hire_cents, travel_cost_cents,
      warranty_text, internal_notes
    )
    values (
      gen_random_uuid(),
      v_quote.tenant_id,
      v_invoice_id,
      v_item ->> 'description',
      (v_item ->> 'quantity')::numeric,
      v_item ->> 'unit',
      coalesce((v_item ->> 'labour_rate_cents')::bigint, 0),
      coalesce((v_item ->> 'labour_hours')::numeric, 0),
      coalesce((v_item ->> 'material_cost_cents')::bigint, 0),
      coalesce((v_item ->> 'markup_percent')::numeric, 0),
      (v_item ->> 'unit_price_cents')::bigint,
      (v_item ->> 'gst_applicable')::boolean,
      (v_item ->> 'sort_order')::int,
      coalesce((v_item ->> 'is_callout_fee')::boolean, false),
      coalesce((v_item ->> 'waived_amount_cents')::bigint, 0),
      coalesce((v_item ->> 'is_subcontracted')::boolean, false),
      coalesce((v_item ->> 'subcontractor_cost_cents')::bigint, 0),
      v_item ->> 'bundle_name',
      v_item ->> 'image_url',
      coalesce(v_item ->> 'pricing_model', 'legacy'),
      (v_item ->> 'labour_cost_rate_cents')::bigint,
      (v_item ->> 'labour_charge_out_rate_cents')::bigint,
      (v_item ->> 'material_margin_percent')::numeric,
      (v_item ->> 'subcontractor_margin_percent')::numeric,
      (v_item ->> 'waste_percent')::numeric,
      (v_item ->> 'contingency_percent')::numeric,
      (v_item ->> 'tip_fees_cents')::bigint,
      (v_item ->> 'equipment_hire_cents')::bigint,
      (v_item ->> 'travel_cost_cents')::bigint,
      v_item ->> 'warranty_text',
      v_item ->> 'internal_notes'
    )
    returning id into v_invoice_line_item_id;

    if v_quote_line_item_id is not null then
      insert into public.invoice_line_item_crew (
        id, tenant_id, invoice_line_item_id, labour_cost_entry_id, worker_name,
        cost_rate_cents, charge_out_rate_cents, hours, sort_order
      )
      select
        gen_random_uuid(), v_quote.tenant_id, v_invoice_line_item_id, labour_cost_entry_id, worker_name,
        cost_rate_cents, charge_out_rate_cents, hours, sort_order
      from public.quote_line_item_crew
      where quote_line_item_id = v_quote_line_item_id;

      insert into public.invoice_line_item_materials (
        id, tenant_id, invoice_line_item_id, description, quantity, unit_cost_cents, sort_order
      )
      select
        gen_random_uuid(), v_quote.tenant_id, v_invoice_line_item_id, description, quantity, unit_cost_cents, sort_order
      from public.quote_line_item_materials
      where quote_line_item_id = v_quote_line_item_id;
    end if;
  end loop;

  return v_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_quote_for_approval / get_invoice_for_approval: gain warranty_text -
-- the one new field the client is meant to see, printed right under the
-- line's description (same client-facing convention bundle_name/image_url
-- already follow). The itemised materials/crew breakdown and internal_
-- notes are deliberately NOT added here - they're office-only, same
-- treatment as the existing labour/material cost fields, which have never
-- been exposed to this function.
-- ---------------------------------------------------------------------------

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
    'accepted_by_name', v_invoice.accepted_by_name,
    'decline_reason', v_invoice.decline_reason,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'client_name', v_client.name,
    'line_items', v_items
  );
end;
$$;
