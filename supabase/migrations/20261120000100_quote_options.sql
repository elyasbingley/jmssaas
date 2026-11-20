-- Quote options (Good / Better / Best) and "client viewed your quote" alerts.
--
-- A quote can now offer alternatives - e.g. Repair / Restore / Replace -
-- each with its own lines and price, and the client picks one on their
-- quote link when accepting. Lines that apply whichever option is chosen
-- (call-out fee, scaffolding) go in the shared section once
-- (quote_line_items.option_id is null) and count towards every option.
-- Optional extras (is_optional) work inside options and the shared
-- section as before.
--
-- quote_options holds each option's name, description, "recommended" flag
-- and its total (shared lines + its own, with the client's optional extras
-- and any membership discount), kept up to date by
-- refresh_quote_option_totals.
--
-- The quote's own subtotal/gst/total - what lists, Analytics, the deposit
-- and the job show - is the chosen option's once the client (or the office)
-- has chosen, and the recommended option's (or the first's) until then.
-- A quote with no options works exactly as before.
--
-- When the quote becomes an invoice, only the shared lines and the chosen
-- option's lines go across.

-- ---------------------------------------------------------------------------
-- Tables and columns
-- ---------------------------------------------------------------------------

create table public.quote_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  name text not null,
  description text,
  is_recommended boolean not null default false,
  sort_order int not null default 0,
  subtotal_cents bigint not null default 0,
  gst_cents bigint not null default 0,
  membership_discount_cents bigint not null default 0,
  total_cents bigint not null default 0,
  created_at timestamptz not null default now()
);

create index quote_options_quote_id_idx on public.quote_options (quote_id);
create index quote_options_tenant_id_idx on public.quote_options (tenant_id);
-- At most one recommended option per quote.
create unique index quote_options_one_recommended on public.quote_options (quote_id) where is_recommended;

alter table public.quote_options enable row level security;

create policy "quote_options: tenant read" on public.quote_options
  for select using (tenant_id = public.current_tenant_id());
create policy "quote_options: admin writes - insert" on public.quote_options
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "quote_options: admin writes - update" on public.quote_options
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "quote_options: admin writes - delete" on public.quote_options
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.quote_line_items
  add column option_id uuid references public.quote_options (id) on delete cascade;

create index quote_line_items_option_id_idx on public.quote_line_items (option_id);

-- Whether the line is part of what the quote currently counts as: true for
-- shared lines and the chosen (else recommended, else first) option's,
-- false for the other options'. Job costing, Analytics and the job page
-- add up only these, so a quote's three options aren't counted three
-- times. Always true on a quote with no options. Kept up to date by
-- refresh_quote_option_totals.
alter table public.quote_line_items
  add column in_quote_total boolean not null default true;

alter table public.quotes
  add column chosen_option_id uuid references public.quote_options (id) on delete set null,
  -- "Client viewed your quote" alerts (see record_quote_view).
  add column last_viewed_at timestamptz,
  add column last_view_notified_at timestamptz;

-- ---------------------------------------------------------------------------
-- Option totals
-- ---------------------------------------------------------------------------

-- Recomputes every option's total, then sets the quote's own totals to the
-- chosen option's (or the recommended one's, or the first's). Does nothing
-- to a quote with no options.
create or replace function public.refresh_quote_option_totals(p_quote_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_option public.quote_options;
  v_items jsonb;
  v_totals record;
  v_adjustment record;
  v_discount bigint;
  v_headline public.quote_options;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null or not exists (select 1 from public.quote_options where quote_id = p_quote_id) then
    return;
  end if;
  -- Called from replace_quote_line_items as the signed-in user: only for
  -- their own company's quotes.
  if auth.uid() is not null and v_quote.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Quote not found';
  end if;

  for v_option in select * from public.quote_options where quote_id = p_quote_id loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'quantity', quantity,
             'unit_price_cents', unit_price_cents,
             'waived_amount_cents', waived_amount_cents,
             'gst_applicable', gst_applicable,
             'is_callout_fee', is_callout_fee,
             'sort_order', sort_order)), '[]'::jsonb)
    into v_items
    from public.quote_line_items
    where quote_id = p_quote_id and is_included and (option_id is null or option_id = v_option.id);

    select * into v_totals from public.calculate_line_item_totals(v_items);
    if v_quote.membership_discount_overridden then
      v_discount := v_quote.membership_discount_cents;
    else
      select * into v_adjustment from public.apply_membership_adjustments(v_items, v_quote.client_id, v_quote.tenant_id);
      v_discount := coalesce(v_adjustment.membership_discount_cents, 0);
    end if;

    update public.quote_options
    set subtotal_cents = v_totals.subtotal_cents,
        gst_cents = v_totals.gst_cents,
        membership_discount_cents = v_discount,
        total_cents = v_totals.subtotal_cents + v_totals.gst_cents - v_discount
    where id = v_option.id;
  end loop;

  select * into v_headline from public.quote_options
  where quote_id = p_quote_id
  order by (id = v_quote.chosen_option_id) desc, is_recommended desc, sort_order, created_at
  limit 1;

  update public.quote_line_items
  set in_quote_total = (option_id is null or option_id = v_headline.id)
  where quote_id = p_quote_id and in_quote_total is distinct from (option_id is null or option_id = v_headline.id);

  update public.quotes
  set subtotal_cents = v_headline.subtotal_cents,
      gst_cents = v_headline.gst_cents,
      membership_discount_cents = v_headline.membership_discount_cents,
      total_cents = v_headline.total_cents
  where id = p_quote_id
    and (subtotal_cents, gst_cents, membership_discount_cents, total_cents)
        is distinct from (v_headline.subtotal_cents, v_headline.gst_cents, v_headline.membership_discount_cents, v_headline.total_cents);
end;
$$;

-- replace_quote_line_items runs as the signed-in user and calls this, so
-- they need to be able to run it (it only recomputes derived totals, and
-- checks the company above).
revoke execute on function public.refresh_quote_option_totals(uuid) from public, anon;
grant execute on function public.refresh_quote_option_totals(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Saving a quote's lines (and options)
-- ---------------------------------------------------------------------------

-- Same as before, plus:
--  * p_options (optional): the quote's options as
--    [{ id, name, description, is_recommended, sort_order }]. Options not in
--    the list are removed. Leave it out (null) to keep the options as they
--    are - callers that don't know about options (older phone builds) still
--    work, as long as their lines carry option_id through.
--  * each line's option_id: which option it belongs to (null = shared).
--    An option_id that isn't one of this quote's options puts the line in
--    the shared section.
drop function public.replace_quote_line_items(uuid, jsonb);

create or replace function public.replace_quote_line_items(p_quote_id uuid, p_items jsonb, p_options jsonb default null)
returns void
language plpgsql
as $function$
declare
  v_quote public.quotes;
  v_totals record;
  v_adjustment record;
  v_final_items jsonb;
  v_included_items jsonb;
  v_item jsonb;
  v_option jsonb;
  v_ordinality int := 0;
  v_line_item_id uuid;
  v_option_id uuid;
  v_has_options boolean;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  if p_options is not null then
    if jsonb_typeof(p_options) <> 'array' then
      raise exception 'p_options must be a list';
    end if;
    if (select count(*) from jsonb_array_elements(p_options) o where coalesce((o ->> 'is_recommended')::boolean, false)) > 1 then
      raise exception 'Only one option can be recommended';
    end if;
    if exists (select 1 from jsonb_array_elements(p_options) o where nullif(trim(o ->> 'name'), '') is null) then
      raise exception 'Every option needs a name';
    end if;
    -- Lines go first (they're replaced below anyway), then the options
    -- that were removed.
    delete from public.quote_line_items where quote_id = p_quote_id;
    delete from public.quote_options
    where quote_id = p_quote_id
      and id not in (select (o ->> 'id')::uuid from jsonb_array_elements(p_options) o where o ->> 'id' is not null);
    -- Clear the recommended flag first so moving it between options never
    -- trips the one-recommended index part way through.
    update public.quote_options set is_recommended = false where quote_id = p_quote_id and is_recommended;
    for v_option in select * from jsonb_array_elements(p_options) loop
      insert into public.quote_options (id, tenant_id, quote_id, name, description, is_recommended, sort_order)
      values (
        coalesce((v_option ->> 'id')::uuid, gen_random_uuid()),
        v_quote.tenant_id, p_quote_id,
        trim(v_option ->> 'name'),
        nullif(trim(coalesce(v_option ->> 'description', '')), ''),
        coalesce((v_option ->> 'is_recommended')::boolean, false),
        coalesce((v_option ->> 'sort_order')::int, 0)
      )
      on conflict (id) do update
        set name = excluded.name,
            description = excluded.description,
            is_recommended = excluded.is_recommended,
            sort_order = excluded.sort_order
      where public.quote_options.quote_id = p_quote_id;
    end loop;
  end if;
  v_has_options := exists (select 1 from public.quote_options where quote_id = p_quote_id);

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
    v_option_id := (select o.id from public.quote_options o where o.quote_id = p_quote_id and o.id = nullif(v_item ->> 'option_id', '')::uuid);

    insert into public.quote_line_items (
      id, tenant_id, quote_id, option_id, description, quantity, unit,
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
      v_option_id,
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

  if not v_quote.membership_discount_overridden then
    update public.quotes
    set membership_discount_percent = v_adjustment.membership_discount_percent,
        client_membership_id = v_adjustment.client_membership_id
    where id = p_quote_id;
  end if;

  if v_has_options then
    -- Each option's total, and the quote's from the recommended/chosen one.
    perform public.refresh_quote_option_totals(p_quote_id);
    return;
  end if;

  -- No options: totals as before. An optional item starting unchecked
  -- isn't in the total until the client opts into it.
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
        membership_discount_cents = v_adjustment.membership_discount_cents
    where id = p_quote_id;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Choosing an option
-- ---------------------------------------------------------------------------

-- The office records which option the client went with (accepted over the
-- phone, in person...). Null clears it. Not once the client has accepted
-- online - that choice is part of what they signed.
create or replace function public.choose_quote_option(p_quote_id uuid, p_option_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can choose the option';
  end if;
  select * into v_quote from public.quotes where id = p_quote_id and tenant_id = public.current_tenant_id() for update;
  if v_quote.id is null then
    raise exception 'Quote not found';
  end if;
  if v_quote.approval_status = 'accepted' then
    raise exception 'The client has accepted this quote online - the option they chose can''t be changed';
  end if;
  if p_option_id is not null and not exists (select 1 from public.quote_options where id = p_option_id and quote_id = p_quote_id) then
    raise exception 'That option isn''t on this quote';
  end if;
  update public.quotes set chosen_option_id = p_option_id where id = p_quote_id;
  perform public.refresh_quote_option_totals(p_quote_id);
end;
$$;

revoke execute on function public.choose_quote_option(uuid, uuid) from public, anon;
grant execute on function public.choose_quote_option(uuid, uuid) to authenticated;

-- Accepting online: the client picks an option (p_option_id) when the quote
-- has options. Their optional extras are taken from the shared section and
-- that option. Everything else as before.
drop function public.accept_quote_by_token(text, text, text, uuid[]);

create or replace function public.accept_quote_by_token(
  p_token text,
  p_name text,
  p_signature_svg text default null,
  p_included_optional_item_ids uuid[] default '{}'::uuid[],
  p_option_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_quote public.quotes;
  v_items jsonb;
  v_totals record;
  v_has_options boolean;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_quote.token_expires_at is not null and v_quote.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.status = 'expired' or (v_quote.expiry_date is not null and v_quote.expiry_date < current_date) then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_quote.approval_status);
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    return jsonb_build_object('error', 'name_required');
  end if;

  v_has_options := exists (select 1 from public.quote_options where quote_id = v_quote.id);
  if v_has_options then
    if p_option_id is null or not exists (select 1 from public.quote_options where id = p_option_id and quote_id = v_quote.id) then
      return jsonb_build_object('error', 'option_required');
    end if;

    update public.quote_line_items
    set is_included = case when is_optional then (id = any(p_included_optional_item_ids)) else true end
    where quote_id = v_quote.id and (option_id is null or option_id = p_option_id);

    update public.quotes set chosen_option_id = p_option_id where id = v_quote.id;
    perform public.refresh_quote_option_totals(v_quote.id);

    update public.quotes
    set status = 'accepted',
        approval_status = 'accepted',
        accepted_at = now(),
        accepted_by_name = trim(p_name),
        accepted_signature_svg = nullif(p_signature_svg, '')
    where id = v_quote.id;
    return jsonb_build_object('ok', true);
  end if;

  update public.quote_line_items
  set is_included = case when is_optional then (id = any(p_included_optional_item_ids)) else true end
  where quote_id = v_quote.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'quantity', quantity,
        'unit_price_cents', unit_price_cents,
        'waived_amount_cents', waived_amount_cents,
        'gst_applicable', gst_applicable
      )
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = v_quote.id and is_included = true;

  select * into v_totals from public.calculate_line_item_totals(v_items);

  update public.quotes
  set status = 'accepted',
      approval_status = 'accepted',
      accepted_at = now(),
      accepted_by_name = trim(p_name),
      accepted_signature_svg = nullif(p_signature_svg, ''),
      subtotal_cents = v_totals.subtotal_cents,
      gst_cents = v_totals.gst_cents,
      total_cents = v_totals.total_cents - v_quote.membership_discount_cents
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$function$;

grant execute on function public.accept_quote_by_token(text, text, text, uuid[], uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Quote -> invoice: only the shared lines and the chosen option's
-- ---------------------------------------------------------------------------

-- The latest version of this function (20261116000300_analytics_tracking)
-- with two changes: an invoice needs the client's option chosen first, and
-- only shared lines and that option's lines are copied. Written out in
-- full rather than patched by find-and-replace, because the live copy's
-- text can differ (e.g. Windows line endings when it was pushed from a PC)
-- and the patch then refuses to apply.
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
  -- Quote options: an invoice is for the option the client went with.
  if v_quote.chosen_option_id is null and exists (select 1 from public.quote_options where quote_id = p_quote_id) then
    raise exception 'Choose which option the client went with before creating the invoice';
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
  where quote_id = p_quote_id and is_included = true and (option_id is null or option_id = v_quote.chosen_option_id);

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
-- The client's quote link
-- ---------------------------------------------------------------------------

-- The options, which line belongs to which, and the chosen one - merged
-- into get_quote_for_approval's result by the approve function.
create or replace function public.get_quote_options_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null or (v_quote.token_expires_at is not null and v_quote.token_expires_at < now()) then
    return null;
  end if;
  if not exists (select 1 from public.quote_options where quote_id = v_quote.id) then
    return null;
  end if;
  return jsonb_build_object(
    'chosen_option_id', v_quote.chosen_option_id,
    'options', (
      select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'description', description, 'is_recommended', is_recommended,
        'subtotal_cents', subtotal_cents, 'gst_cents', gst_cents,
        'membership_discount_cents', membership_discount_cents, 'total_cents', total_cents
      ) order by sort_order, created_at)
      from public.quote_options where quote_id = v_quote.id
    ),
    'line_item_options', (
      select coalesce(jsonb_object_agg(id::text, option_id), '{}'::jsonb)
      from public.quote_line_items where quote_id = v_quote.id and option_id is not null
    )
  );
end;
$$;

revoke execute on function public.get_quote_options_by_token(text) from public;
grant execute on function public.get_quote_options_by_token(text) to anon, authenticated;

-- Called each time the client's quote link loads. Returns true when the
-- office should get a "viewed" alert: the first time it's opened, and when
-- the client comes back to it a day or more after they last looked - never
-- more than one alert a day per quote, and none once it's been accepted or
-- declined.
create or replace function public.record_quote_view(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_notify boolean;
  v_return_visit boolean;
begin
  select * into v_quote from public.quotes where access_token = p_token for update;
  if v_quote.id is null or (v_quote.token_expires_at is not null and v_quote.token_expires_at < now()) then
    return jsonb_build_object('notify', false);
  end if;

  v_return_visit := v_quote.last_view_notified_at is not null;
  v_notify := coalesce(v_quote.approval_status::text, '') not in ('accepted', 'declined')
    and (
      v_quote.last_view_notified_at is null
      or (v_quote.last_viewed_at < now() - interval '1 day' and v_quote.last_view_notified_at < now() - interval '1 day')
    );

  update public.quotes
  set last_viewed_at = now(),
      last_view_notified_at = case when v_notify then now() else last_view_notified_at end
  where id = v_quote.id;

  return jsonb_build_object('notify', v_notify, 'return_visit', v_return_visit, 'quote_id', v_quote.id, 'tenant_id', v_quote.tenant_id, 'quote_number', v_quote.quote_number);
end;
$$;

revoke execute on function public.record_quote_view(text) from public, anon, authenticated;
