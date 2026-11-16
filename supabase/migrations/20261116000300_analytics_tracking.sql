-- Data the rebuilt Analytics section needs that nothing recorded before:
--
-- 1. job_cards.completed_at was a column nobody ever wrote, so "jobs
--    completed in a period" had no date to key off. A trigger now stamps
--    it when a job first lands in a closed lifecycle stage (same is_closed
--    flag the completion-summary/maintenance triggers use) and clears it
--    if the job is reopened. Existing closed jobs are backfilled from
--    their earliest issued invoice, else updated_at - an estimate, the
--    real date was never stored.
-- 2. job_cards.callback_of_job_card_id marks a job as a return visit for
--    an earlier one - the basis of First Time Fix Rate.
-- 3. quote/invoice line items record which Price Book item they came
--    from (Price Book Usage). Existing lines are backfilled where the
--    description matches exactly one Price Book item (or "Item
--    (Variation)") for the same tenant - a line whose description was
--    edited, or that matches two items, stays unlinked.
-- 4. quotes.lost_reason_category - a fixed list the office picks from,
--    so lost quotes can be counted by reason (decline_reason, the
--    client's own free text from the approval page, can't be grouped).
-- 5. tenants.fy_revenue_target_cents - the financial-year revenue goal.

-- ---------------------------------------------------------------------------
-- 1. completed_at
-- ---------------------------------------------------------------------------

create or replace function public.set_job_completed_at()
returns trigger
language plpgsql
as $$
declare
  v_closed boolean;
begin
  select coalesce(is_closed, false) into v_closed
  from public.job_lifecycle_stages where id = new.lifecycle_stage_id;

  if coalesce(v_closed, false) then
    if new.completed_at is null then
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

-- Named to sort after default_job_lifecycle_stage_trigger (BEFORE triggers
-- fire in name order), so a job inserted with no stage has its default
-- stage filled in before this reads it.
create trigger set_job_completed_at_trigger
  before insert or update of lifecycle_stage_id on public.job_cards
  for each row execute function public.set_job_completed_at();

-- User triggers off for the backfill: it is bookkeeping, not an edit, so it
-- must not bump updated_at or run the job-update communication triggers.
alter table public.job_cards disable trigger user;

update public.job_cards jc
set completed_at = coalesce(
  (
    select min(i.issue_date)::timestamptz
    from public.invoices i
    where i.job_card_id = jc.id and i.status not in ('draft', 'void')
  ),
  jc.updated_at
)
from public.job_lifecycle_stages ls
where ls.id = jc.lifecycle_stage_id
  and ls.is_closed = true
  and jc.completed_at is null;

alter table public.job_cards enable trigger user;

create index job_cards_completed_at_idx on public.job_cards (completed_at);

-- ---------------------------------------------------------------------------
-- 2. Callback link
-- ---------------------------------------------------------------------------

alter table public.job_cards
  add column callback_of_job_card_id uuid references public.job_cards (id) on delete set null,
  add constraint job_cards_callback_not_self check (callback_of_job_card_id is null or callback_of_job_card_id <> id);

create index job_cards_callback_of_job_card_id_idx on public.job_cards (callback_of_job_card_id);

-- ---------------------------------------------------------------------------
-- 3. Price Book link on line items
-- ---------------------------------------------------------------------------

alter table public.quote_line_items
  add column price_book_item_id uuid references public.price_book_items (id) on delete set null;
alter table public.invoice_line_items
  add column price_book_item_id uuid references public.price_book_items (id) on delete set null;

create index quote_line_items_price_book_item_id_idx on public.quote_line_items (price_book_item_id);
create index invoice_line_items_price_book_item_id_idx on public.invoice_line_items (price_book_item_id);

-- User triggers off here too: the accepted-document lock triggers reject
-- any update to an accepted quote's/invoice's line items, and most
-- historical lines belong to exactly those documents. Linking a line to
-- its Price Book item changes nothing the client agreed to.
alter table public.quote_line_items disable trigger user;
alter table public.invoice_line_items disable trigger user;

with candidates as (
  select tenant_id, id as item_id, lower(trim(description)) as label
  from public.price_book_items
  union all
  select i.tenant_id, i.id, lower(trim(i.description || ' (' || v.name || ')'))
  from public.price_book_item_variations v
  join public.price_book_items i on i.id = v.price_book_item_id
),
unambiguous as (
  select tenant_id, label, min(item_id::text)::uuid as item_id
  from candidates
  group by tenant_id, label
  having count(distinct item_id) = 1
)
update public.quote_line_items li
set price_book_item_id = u.item_id
from unambiguous u
where u.tenant_id = li.tenant_id and u.label = lower(trim(li.description));

with candidates as (
  select tenant_id, id as item_id, lower(trim(description)) as label
  from public.price_book_items
  union all
  select i.tenant_id, i.id, lower(trim(i.description || ' (' || v.name || ')'))
  from public.price_book_item_variations v
  join public.price_book_items i on i.id = v.price_book_item_id
),
unambiguous as (
  select tenant_id, label, min(item_id::text)::uuid as item_id
  from candidates
  group by tenant_id, label
  having count(distinct item_id) = 1
)
update public.invoice_line_items li
set price_book_item_id = u.item_id
from unambiguous u
where u.tenant_id = li.tenant_id and u.label = lower(trim(li.description));

alter table public.quote_line_items enable trigger user;
alter table public.invoice_line_items enable trigger user;

-- The three functions that write line items, each identical to its
-- line_item_rework_schema definition except for carrying
-- price_book_item_id through. The replace_* pair resolve the id through
-- price_book_items (same tenant) rather than inserting it raw, so a
-- Price Book item deleted while a quote was open saves as an unlinked
-- line instead of failing the whole save on the foreign key.

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
      warranty_text, internal_notes, price_book_item_id
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
      nullif(v_item ->> 'internal_notes', ''),
      (select pb.id from public.price_book_items pb
        where pb.id = nullif(v_item ->> 'price_book_item_id', '')::uuid and pb.tenant_id = v_quote.tenant_id)
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
      warranty_text, internal_notes, price_book_item_id
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
      nullif(v_item ->> 'internal_notes', ''),
      (select pb.id from public.price_book_items pb
        where pb.id = nullif(v_item ->> 'price_book_item_id', '')::uuid and pb.tenant_id = v_invoice.tenant_id)
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

create or replace function public.convert_quote_to_invoice(p_quote_id uuid, p_due_date date, p_invoice_number text DEFAULT NULL::text)
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
        'internal_notes', internal_notes,
        'price_book_item_id', price_book_item_id
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
      warranty_text, internal_notes, price_book_item_id
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
      v_item ->> 'internal_notes',
      (v_item ->> 'price_book_item_id')::uuid
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
-- 4. Lost reason
-- ---------------------------------------------------------------------------

alter table public.quotes
  add column lost_reason_category text
    check (lost_reason_category in ('price', 'competitor', 'timing', 'no_response', 'scope_changed', 'not_needed', 'other'));

-- ---------------------------------------------------------------------------
-- 5. Financial-year revenue target
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column fy_revenue_target_cents bigint check (fy_revenue_target_cents is null or fy_revenue_target_cents >= 0);
