-- Optional and bundled line items on quotes - lets a client tick optional
-- extras on/off on the public approval page before accepting (the total
-- updates live in the browser, but the FINAL total is always recomputed and
-- persisted server-side at accept time, never trusted from the client), and
-- group related line items under a named heading (bundle_name) with an
-- optional per-item image, both of which also show on the PDF.
--
-- Design decisions (confirmed): an optional item starts UNCHECKED (an
-- upsell the client opts into, not a default-included item they'd have to
-- deselect); optionality is always per line item, never a whole-bundle
-- toggle; a bundle is purely a presentation grouping (its price is the sum
-- of its member line items, no separate bundle-level price).
--
-- is_optional/is_included only make sense on quote_line_items - by the
-- time something's an invoice, optional items have already been resolved
-- (see convert_quote_to_invoice below, which drops any unselected optional
-- item entirely rather than carrying is_included through). bundle_name/
-- image_url are presentation-only, so both tables get them for parity in
-- the PDF/print output.
--
-- Known limitation: apply_membership_adjustments' discount-percent
-- calculation sums every non-callout-fee line regardless of is_included, so
-- a member client's discount is computed against the FULL scope (optional
-- extras included) rather than just what's actually included at the time -
-- a narrow edge case (a member viewing a quote with optional items) not
-- addressed here rather than risking a change to the discount engine's own
-- well-exercised math for the much more common non-optional case.

alter table public.quote_line_items
  add column is_optional boolean not null default false,
  add column is_included boolean not null default true,
  add column bundle_name text,
  add column image_url text;

alter table public.invoice_line_items
  add column bundle_name text,
  add column image_url text;

-- Same "public bucket, tenant/admin-scoped writes" shape as price-book-
-- images and company-logos - has to be public since the anonymous approval
-- page and the emailed/downloaded PDF both need to load it with no auth.
insert into storage.buckets (id, name, public)
values ('line-item-images', 'line-item-images', true)
on conflict (id) do nothing;

create policy "line-item-images: public read" on storage.objects
  for select using (bucket_id = 'line-item-images');

create policy "line-item-images: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'line-item-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "line-item-images: admin updates" on storage.objects
  for update using (
    bucket_id = 'line-item-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "line-item-images: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'line-item-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- replace_quote_line_items / replace_invoice_line_items: full cumulative
-- redefinition, adding bundle_name/image_url to both, plus is_optional/
-- is_included to quote_line_items only. is_included defaults to the
-- negation of is_optional when not explicitly sent (an ordinary item is
-- always included; an optional one starts unchecked) - the desktop/mobile
-- editors always send both explicitly together in practice, this default is
-- just a safety net. Once a quote is actually accepted,
-- enforce_accepted_quote_line_items_lock blocks this function from running
-- on it at all, so there's no risk of clobbering a client's already-made
-- selection - is_included before that point is purely the office's own
-- authoring default.
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
    is_subcontracted, subcontractor_cost_cents, is_optional, is_included, bundle_name, image_url
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
    coalesce((item ->> 'subcontractor_cost_cents')::bigint, 0),
    coalesce((item ->> 'is_optional')::boolean, false),
    coalesce((item ->> 'is_included')::boolean, not coalesce((item ->> 'is_optional')::boolean, false)),
    nullif(item ->> 'bundle_name', ''),
    nullif(item ->> 'image_url', '')
  from jsonb_array_elements(v_final_items) with ordinality as t(item, ordinality);

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
    is_subcontracted, subcontractor_cost_cents, bundle_name, image_url
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
    coalesce((item ->> 'subcontractor_cost_cents')::bigint, 0),
    nullif(item ->> 'bundle_name', ''),
    nullif(item ->> 'image_url', '')
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
-- get_quote_for_approval / get_invoice_for_approval: line items now carry
-- id (needed so the page can reference "which item" in the accept payload -
-- previously omitted entirely, since nothing needed to reference an
-- individual item before), is_optional, is_included (the office's current
-- default - what the checkbox starts as), bundle_name, image_url.
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
        'image_url', image_url
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
        'image_url', image_url
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

-- ---------------------------------------------------------------------------
-- accept_quote_by_token: gains p_included_optional_item_ids - the set of
-- optional line items the client had ticked at the moment they hit Accept.
-- Order matters here: quote_line_items.is_included is updated FIRST (while
-- quotes.approval_status is still whatever it was - 'sent'/'viewed', not yet
-- 'accepted'), so enforce_accepted_quote_line_items_lock's check still
-- passes; only then does the quotes row itself flip to 'accepted', in the
-- SAME statement that also writes the freshly recomputed subtotal/gst/total -
-- enforce_accepted_document_money_lock only rejects a *subsequent* update
-- once old.approval_status is already 'accepted', so this one write-through
-- is unaffected by its own lock.
--
-- The client only ever sends a set of ids, never a dollar figure - the
-- actual amounts are looked up fresh from quote_line_items and run through
-- the same calculate_line_item_totals every other save path uses, so a
-- tampered request can at most change which real items are included, never
-- fabricate a price.
-- ---------------------------------------------------------------------------

drop function if exists public.accept_quote_by_token(text, text, text);

create function public.accept_quote_by_token(
  p_token text,
  p_name text,
  p_signature_svg text default null,
  p_included_optional_item_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_items jsonb;
  v_totals record;
begin
  select * into v_quote from public.quotes where access_token = p_token;
  if v_quote.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_quote.token_expires_at is not null and v_quote.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_quote.approval_status in ('accepted', 'declined') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_quote.approval_status);
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    return jsonb_build_object('error', 'name_required');
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

  -- v_quote.membership_discount_cents is whatever replace_quote_line_items
  -- last computed and stored (see its own known-limitation comment at the
  -- top of this file re: optional items) - carried through here rather than
  -- dropped, so a member client's quote doesn't silently lose its discount
  -- the moment it's accepted.
  update public.quotes
  set approval_status = 'accepted',
      accepted_at = now(),
      accepted_by_name = trim(p_name),
      accepted_signature_svg = nullif(p_signature_svg, ''),
      subtotal_cents = v_totals.subtotal_cents,
      gst_cents = v_totals.gst_cents,
      total_cents = v_totals.total_cents - v_quote.membership_discount_cents
  where id = v_quote.id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.accept_quote_by_token(text, text, text, uuid[]) from public;
grant execute on function public.accept_quote_by_token(text, text, text, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- convert_quote_to_invoice: only carries over line items the client (or the
-- office, for a quote never sent through the approval flow at all - is_
-- included defaults to true, so an ordinary non-optional item is unaffected)
-- actually left included. A declined optional extra never reaches the
-- invoice at all, rather than showing up as a $0 or ghost line.
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
        'is_callout_fee', is_callout_fee,
        'is_subcontracted', is_subcontracted,
        'subcontractor_cost_cents', subcontractor_cost_cents,
        'bundle_name', bundle_name,
        'image_url', image_url
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

  insert into public.invoice_line_items (
    id, tenant_id, invoice_id, description, quantity,
    labour_rate_cents, labour_hours, material_cost_cents, markup_percent,
    unit_price_cents, gst_applicable, sort_order, is_callout_fee, waived_amount_cents,
    is_subcontracted, subcontractor_cost_cents, bundle_name, image_url
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
    coalesce((item ->> 'subcontractor_cost_cents')::bigint, 0),
    item ->> 'bundle_name',
    item ->> 'image_url'
  from jsonb_array_elements(v_adjustment.adjusted_items) as item;

  return v_invoice_id;
end;
$$;
