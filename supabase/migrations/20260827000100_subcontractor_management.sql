-- Subcontractor Management & Procurement module: manage subcontractor
-- companies/contacts, enforce trade/compliance standards (licenses,
-- insurances), assign preference tiers (1-5), issue Purchase Orders/Work
-- Orders/Quote Requests, and track cost-paid-vs-revenue-generated margin.
-- Lives under a new "Operations" sidebar section, desktop-only - same
-- "no field-technician surface" scope decision B2B & Referrals and the
-- Reports engine already made (see those migrations' own comments).
--
-- Money: `_cents` bigint throughout, not the spec's plain decimal, same
-- reasoning as every other money column in this schema.
--
-- purchase_orders doubles as BOTH a "Quote Request" and a "Work Order/PO"
-- (the spec's own Workflow 2 and Workflow 3 create what is structurally
-- the same row - job, subcontractor, contact, line items, a dollar total -
-- just at different points in a shared lifecycle) rather than two
-- separate tables: `is_quote_request` marks which flow created it, and
-- `status` gains a `quoted` state (between `sent` and `accepted`) that
-- only a quote request ever passes through - the moment a subcontractor
-- submits their price via the external link, this exact row becomes the
-- PO admin can review/approve to a real Work Order. This mirrors how a
-- quote already converts into an invoice elsewhere in this schema, just
-- without a separate destination table since a PO's shape doesn't change
-- across that transition, only its status and total_cost_cents do.

create type public.subcontractor_trade as enum (
  'plumber', 'roofer', 'electrician', 'hvac', 'painter', 'carpenter', 'plasterer', 'cleaner', 'other'
);
create type public.subcontractor_status as enum ('active', 'inactive', 'compliance_hold');
create type public.subcontractor_doc_type as enum (
  'public_liability', 'workers_comp', 'trade_license', 'white_card', 'safety_induction', 'other'
);
create type public.purchase_order_status as enum ('draft', 'sent', 'quoted', 'accepted', 'completed', 'paid', 'cancelled');

-- ---------------------------------------------------------------------------
-- subcontractor_companies
-- ---------------------------------------------------------------------------

create table public.subcontractor_companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  company_name text not null,
  abn text,
  -- Array, not a single enum value - the Directory's own "Trade Filter
  -- Multi-Select" only makes sense if one subbie can legitimately cover
  -- more than one trade (e.g. a plumber who also does gas fitting).
  trades public.subcontractor_trade[] not null default '{}',
  preference_tier smallint not null default 3 check (preference_tier between 1 and 5),
  payment_terms_days int not null default 30,
  -- Never set to 'compliance_hold' directly by the app - only
  -- recompute_subcontractor_compliance_status (trigger + daily sweep,
  -- below) ever writes that value, so it stays a true reflection of
  -- compliance_docs rather than something an admin's dropdown could drift
  -- out of sync with. The desktop UI only offers Active/Inactive; compliance
  -- hold is shown as a derived banner instead.
  status public.subcontractor_status not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_subcontractor_companies_updated_at
  before update on public.subcontractor_companies
  for each row execute function public.set_updated_at();

create index subcontractor_companies_tenant_id_idx on public.subcontractor_companies (tenant_id);

-- ---------------------------------------------------------------------------
-- subcontractor_contacts
-- ---------------------------------------------------------------------------

create table public.subcontractor_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  subcontractor_id uuid not null references public.subcontractor_companies (id) on delete cascade,
  first_name text not null,
  last_name text,
  role_title text,
  email text not null,
  mobile text,
  work_phone text,
  is_primary_contact boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_subcontractor_contacts_updated_at
  before update on public.subcontractor_contacts
  for each row execute function public.set_updated_at();

create index subcontractor_contacts_tenant_id_idx on public.subcontractor_contacts (tenant_id);
create index subcontractor_contacts_subcontractor_id_idx on public.subcontractor_contacts (subcontractor_id);

-- ---------------------------------------------------------------------------
-- subcontractor_compliance_docs
-- ---------------------------------------------------------------------------

create table public.subcontractor_compliance_docs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  subcontractor_id uuid not null references public.subcontractor_companies (id) on delete cascade,
  doc_type public.subcontractor_doc_type not null default 'other',
  doc_number text,
  storage_path text not null,
  issue_date date,
  expiry_date date,
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_subcontractor_compliance_docs_updated_at
  before update on public.subcontractor_compliance_docs
  for each row execute function public.set_updated_at();

create index subcontractor_compliance_docs_tenant_id_idx on public.subcontractor_compliance_docs (tenant_id);
create index subcontractor_compliance_docs_subcontractor_id_idx on public.subcontractor_compliance_docs (subcontractor_id);

-- ---------------------------------------------------------------------------
-- purchase_orders
-- ---------------------------------------------------------------------------

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  po_number text,
  job_card_id uuid not null references public.job_cards (id),
  subcontractor_id uuid not null references public.subcontractor_companies (id),
  contact_id uuid references public.subcontractor_contacts (id) on delete set null,
  is_quote_request boolean not null default false,
  status public.purchase_order_status not null default 'draft',
  line_items jsonb not null default '[]'::jsonb,
  total_cost_cents bigint not null default 0,
  -- Nullable - a bare Quote Request has no client price yet (Workflow 2's
  -- margin calc only applies once a real Work Order sets this).
  billed_to_client_cents bigint,
  access_token text,
  token_expires_at timestamptz,
  quoted_at timestamptz,
  pdf_storage_path text,
  issued_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_purchase_orders_updated_at
  before update on public.purchase_orders
  for each row execute function public.set_updated_at();

create index purchase_orders_tenant_id_idx on public.purchase_orders (tenant_id);
create index purchase_orders_job_card_id_idx on public.purchase_orders (job_card_id);
create index purchase_orders_subcontractor_id_idx on public.purchase_orders (subcontractor_id);
create unique index purchase_orders_access_token_key on public.purchase_orders (access_token) where access_token is not null;
create unique index purchase_orders_tenant_po_number_key on public.purchase_orders (tenant_id, po_number) where po_number is not null;

create or replace function public.assign_po_number()
returns trigger
language plpgsql
as $$
begin
  if new.po_number is null or new.po_number = '' then
    new.po_number := public.next_reference_number(new.tenant_id, 'purchase_order', 'PO', 4);
  end if;
  return new;
end;
$$;

create trigger assign_purchase_orders_number
  before insert on public.purchase_orders
  for each row execute function public.assign_po_number();

-- ---------------------------------------------------------------------------
-- Storage: subcontractor-files bucket (compliance doc uploads + compiled
-- PO PDFs), same tenant-scoped admin-only shape as "report-files".
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('subcontractor-files', 'subcontractor-files', false)
on conflict (id) do nothing;

create policy "subcontractor-files: tenant read" on storage.objects
  for select using (
    bucket_id = 'subcontractor-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

create policy "subcontractor-files: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'subcontractor-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "subcontractor-files: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'subcontractor-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- Compliance lockout (Workflow 4). Recomputed two ways:
--   1. Immediately, by a trigger, whenever a compliance doc is inserted/
--      updated/deleted for a subcontractor (an admin uploads a renewed
--      certificate -> hold clears the moment they save it, not the next
--      day).
--   2. Once a day, by a new Edge Function (process-subcontractor-
--      compliance, deployed separately - see docs/SETUP.md) that re-checks
--      every subcontractor and sends the reminder email - this catches a
--      document that silently crosses its expiry_date with nobody having
--      touched the row that day, which the trigger alone can never see.
-- A subcontractor is on hold if ANY of its compliance docs has a past
-- expiry_date - the spec's examples are insurances/licenses specifically,
-- but every doc_type here carries the same expiry_date column with the
-- same real-world consequence (an expired White Card is still a genuine
-- compliance problem), so this doesn't special-case by doc_type.
-- ---------------------------------------------------------------------------

create or replace function public.recompute_subcontractor_compliance_status(p_subcontractor_id uuid)
returns void
language plpgsql
as $$
declare
  v_has_expired boolean;
begin
  select exists (
    select 1 from public.subcontractor_compliance_docs
    where subcontractor_id = p_subcontractor_id
      and expiry_date is not null
      and expiry_date < current_date
  ) into v_has_expired;

  update public.subcontractor_companies
  set status = case
    when v_has_expired then 'compliance_hold'
    when status = 'compliance_hold' then 'active'
    else status
  end
  where id = p_subcontractor_id;
end;
$$;

create or replace function public.trg_recompute_subcontractor_compliance()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_subcontractor_compliance_status(old.subcontractor_id);
    return old;
  end if;
  perform public.recompute_subcontractor_compliance_status(new.subcontractor_id);
  return new;
end;
$$;

create trigger recompute_compliance_on_doc_change
  after insert or update or delete on public.subcontractor_compliance_docs
  for each row execute function public.trg_recompute_subcontractor_compliance();

-- ---------------------------------------------------------------------------
-- RLS - admin-managed throughout (no field-technician surface).
-- ---------------------------------------------------------------------------

alter table public.subcontractor_companies enable row level security;
create policy "subcontractor_companies: tenant read" on public.subcontractor_companies
  for select using (tenant_id = public.current_tenant_id());
create policy "subcontractor_companies: admin writes - insert" on public.subcontractor_companies
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "subcontractor_companies: admin writes - update" on public.subcontractor_companies
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "subcontractor_companies: admin writes - delete" on public.subcontractor_companies
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.subcontractor_contacts enable row level security;
create policy "subcontractor_contacts: tenant read" on public.subcontractor_contacts
  for select using (tenant_id = public.current_tenant_id());
create policy "subcontractor_contacts: admin writes - insert" on public.subcontractor_contacts
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "subcontractor_contacts: admin writes - update" on public.subcontractor_contacts
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "subcontractor_contacts: admin writes - delete" on public.subcontractor_contacts
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.subcontractor_compliance_docs enable row level security;
create policy "subcontractor_compliance_docs: tenant read" on public.subcontractor_compliance_docs
  for select using (tenant_id = public.current_tenant_id());
create policy "subcontractor_compliance_docs: admin writes - insert" on public.subcontractor_compliance_docs
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "subcontractor_compliance_docs: admin writes - update" on public.subcontractor_compliance_docs
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "subcontractor_compliance_docs: admin writes - delete" on public.subcontractor_compliance_docs
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.purchase_orders enable row level security;
create policy "purchase_orders: tenant read" on public.purchase_orders
  for select using (tenant_id = public.current_tenant_id());
create policy "purchase_orders: admin writes - insert" on public.purchase_orders
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "purchase_orders: admin writes - update" on public.purchase_orders
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "purchase_orders: admin writes - delete" on public.purchase_orders
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- Public, token-authenticated access for the external "Quote Request"
-- submission link (Workflow 3) - same SECURITY DEFINER shape as
-- generate_quote_approval_link/get_quote_for_approval/accept_quote_by_token
-- in the quote_invoice_approval migration, extended to a new "po_quote"
-- doc type in the shared approve Edge Function + approval-page.html.
-- ---------------------------------------------------------------------------

create or replace function public.generate_po_quote_link(p_po_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_token text;
  v_updated int;
begin
  select access_token into v_existing_token from public.purchase_orders where id = p_po_id;
  if v_existing_token is not null then
    return v_existing_token;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  update public.purchase_orders
  set access_token = v_token,
      token_expires_at = now() + interval '30 days'
  where id = p_po_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Purchase order % not found or not permitted', p_po_id;
  end if;

  return v_token;
end;
$$;

create or replace function public.get_po_quote_for_approval(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders;
  v_tenant public.tenants;
  v_subcontractor public.subcontractor_companies;
  v_job public.job_cards;
  v_client public.clients;
begin
  select * into v_po from public.purchase_orders where access_token = p_token;
  if v_po.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_po.token_expires_at is not null and v_po.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;

  select * into v_tenant from public.tenants where id = v_po.tenant_id;
  select * into v_subcontractor from public.subcontractor_companies where id = v_po.subcontractor_id;
  select * into v_job from public.job_cards where id = v_po.job_card_id;
  if v_job.id is not null then
    select * into v_client from public.clients where id = v_job.client_id;
  end if;

  return jsonb_build_object(
    'po_number', v_po.po_number,
    'status', v_po.status,
    'total_cost_cents', v_po.total_cost_cents,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'subcontractor_company_name', v_subcontractor.company_name,
    'job_title', v_job.title,
    'job_address', v_client.address_line1,
    'line_items', v_po.line_items
  );
end;
$$;

create or replace function public.submit_po_quote_by_token(p_token text, p_amount_cents bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders;
begin
  select * into v_po from public.purchase_orders where access_token = p_token;
  if v_po.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_po.token_expires_at is not null and v_po.token_expires_at < now() then
    return jsonb_build_object('error', 'expired');
  end if;
  if v_po.status not in ('draft', 'sent') then
    return jsonb_build_object('error', 'already_resolved', 'status', v_po.status);
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    return jsonb_build_object('error', 'amount_required');
  end if;

  update public.purchase_orders
  set total_cost_cents = p_amount_cents, status = 'quoted', quoted_at = now()
  where id = v_po.id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.generate_po_quote_link(uuid) to authenticated;
revoke execute on function public.get_po_quote_for_approval(text) from public;
revoke execute on function public.submit_po_quote_by_token(text, bigint) from public;
grant execute on function public.get_po_quote_for_approval(text) to anon, authenticated;
grant execute on function public.submit_po_quote_by_token(text, bigint) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Automation: entity_type/category widened, three new trigger_keys.
-- subcontractor_quote_request/subcontractor_work_order are manual sends
-- (like quote_sent/invoice_sent/report_sent) - entity_id is the
-- purchase_orders row. subcontractor_compliance_expired is queued by the
-- daily sweep Edge Function, one row per contact - entity_id is the
-- subcontractor_companies row (see that function's own comment for why
-- its idempotency check can't reuse the generic "already scheduled for
-- this entity" shape every other trigger_key uses).
-- ---------------------------------------------------------------------------

alter table public.scheduled_communications
  drop constraint scheduled_communications_entity_type_check;

alter table public.scheduled_communications
  add constraint scheduled_communications_entity_type_check
  check (entity_type in ('quote', 'invoice', 'job', 'calendar_event', 'client', 'property_asset', 'referral_partner', 'report', 'purchase_order', 'subcontractor'));

create or replace function public.seed_default_communication_rules(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_rules (tenant_id, trigger_key, delay_offset_value, delay_offset_unit, delay_direction, channel)
  values
    (p_tenant_id, 'quote_stage_1', 3, 'days', 'after', 'email'),
    (p_tenant_id, 'quote_stage_2', 7, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_pre_due', 2, 'days', 'before', 'email'),
    (p_tenant_id, 'invoice_overdue_1', 3, 'days', 'after', 'email'),
    (p_tenant_id, 'job_review_request', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'job_on_the_way', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'quote_expiring_soon', 7, 'days', 'before', 'email'),
    (p_tenant_id, 'quote_expired', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_due_today', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_overdue_14', 14, 'days', 'after', 'email'),
    (p_tenant_id, 'invoice_payment_received', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'quote_sent', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'invoice_sent', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'job_prep_checklist', 24, 'hours', 'before', 'email'),
    (p_tenant_id, 'job_completion_summary', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'maintenance_reminder', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'dormant_client_reengagement', 365, 'days', 'after', 'email'),
    (p_tenant_id, 'job_nte_variation_request', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'property_maintenance_due', 30, 'days', 'before', 'email'),
    (p_tenant_id, 'referral_lead_received', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'referral_job_completed', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'referral_monthly_digest', 0, 'days', 'after', 'email'),
    (p_tenant_id, 'report_sent', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'subcontractor_quote_request', 0, 'hours', 'after', 'email'),
    (p_tenant_id, 'subcontractor_work_order', 0, 'hours', 'after', 'email'),
    -- Fired by the daily process-subcontractor-compliance sweep - delay/
    -- direction unused, same as referral_monthly_digest's own note.
    (p_tenant_id, 'subcontractor_compliance_expired', 0, 'days', 'after', 'email')
  on conflict (tenant_id, trigger_key) do nothing;
end;
$$;

create or replace function public.seed_default_communication_templates(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_templates (tenant_id, trigger_key, name, type, category, subject, body)
  values
    (p_tenant_id, 'quote_sent', 'Quote Delivery', 'email', 'quote',
     'Your quote from {company_name}',
     'Hi {client_first_name}, thanks for the opportunity! Your quote {quote_number} for {quote_total} from {company_name} is ready to view. Any questions, just ask.<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'invoice_sent', 'Invoice Delivery', 'email', 'invoice',
     'Invoice {invoice_number} from {company_name}',
     'Hi {client_first_name}, your invoice {invoice_number} for {invoice_total} from {company_name} is ready. Due {invoice_due_date}. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'quote_stage_1', 'Quote Follow-up (first)', 'email', 'quote',
     'Following up on your quote',
     'Hi {client_first_name}, just checking in on quote {quote_number} for {quote_total} from {company_name}. Any questions, just ask!<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'quote_stage_2', 'Quote Follow-up (second)', 'email', 'quote',
     'Your quote is still open',
     'Hi {client_first_name}, your quote {quote_number} from {company_name} is still open. Call {company_phone} if you''d like to go ahead, or use the buttons below.<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'quote_expiring_soon', 'Quote Expiring Soon', 'email', 'quote',
     'Your quote expires soon - lock in your price',
     'Hi {client_first_name}, quote {quote_number} for {quote_total} from {company_name} expires on {quote_expiry_date}. Lock in your price before it changes.<br><br>' ||
     '<a href="{quote_accept_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:8px;">Accept Quote</a>' ||
     '<a href="{quote_decline_link}" style="background:#f3f4f6;color:#b91c1c;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Decline</a>'),
    (p_tenant_id, 'quote_expired', 'Quote Expired', 'email', 'quote',
     'Your quote has expired',
     'Hi {client_first_name}, quote {quote_number} from {company_name} expired on {quote_expiry_date}. Would you like us to reissue it with updated pricing? Just reply to this email or call {company_phone}.'),
    (p_tenant_id, 'invoice_pre_due', 'Invoice Due Soon', 'email', 'invoice',
     'Invoice due soon',
     'Hi {client_first_name}, a reminder that invoice {invoice_number} ({invoice_total}) from {company_name} is due {invoice_due_date}. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_due_today', 'Invoice Due Today', 'email', 'invoice',
     'Your invoice is due today',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} is due today. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_overdue_1', 'Invoice Overdue', 'email', 'invoice',
     'Invoice overdue',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} was due {invoice_due_date} and is now overdue. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_overdue_14', 'Invoice Seriously Overdue', 'email', 'invoice',
     'Invoice significantly overdue',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} was due {invoice_due_date} and is now well overdue. Please arrange payment as soon as possible, or contact us on {company_phone} to discuss. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_payment_received', 'Payment Received', 'email', 'invoice',
     'Payment received - thank you',
     'Hi {client_first_name}, thanks - we''ve received your payment of {invoice_total} for invoice {invoice_number}. This confirms the invoice is now paid in full.'),
    (p_tenant_id, 'job_review_request', 'Job Review Request', 'email', 'field',
     'How did we do?',
     'Hi {client_first_name}, thanks for choosing {company_name}! We''d love your feedback: {google_review_link}'),
    (p_tenant_id, 'job_on_the_way', 'On The Way', 'email', 'field',
     'We''re on the way',
     '{tech_first_name} from {company_name} is on the way to {site_address}, arriving in about {eta_minutes} minutes.'),
    (p_tenant_id, 'job_prep_checklist', 'Prep Your Site', 'email', 'field',
     'Getting ready for your appointment',
     'Hi {client_first_name}, just a reminder that {company_name} will be at {site_address} on {booking_date} at {booking_start_time} for {job_title}. To help us get started quickly: please ensure clear access to the work area, secure any pets, and have someone available if we need access inside. See you soon!'),
    (p_tenant_id, 'job_completion_summary', 'Job Complete', 'email', 'field',
     'Job complete',
     'Hi {client_first_name}, we''ve completed {job_title} at {site_address}. Thanks for choosing {company_name}! If you have any questions about the work, just reply to this email or call {company_phone}.'),
    (p_tenant_id, 'maintenance_reminder', 'Maintenance Reminder', 'email', 'field',
     'Time for your regular maintenance check',
     'Hi {client_first_name}, it''s about time for your regular maintenance check with {company_name}. Reply to this email or call {company_phone} to book it in.'),
    (p_tenant_id, 'dormant_client_reengagement', 'We Miss You', 'email', 'field',
     'It''s been a while!',
     'Hi {client_first_name}, it''s been a while since your last job with {company_name}! Get in touch on {company_phone} if there''s anything we can help with.'),
    (p_tenant_id, 'job_nte_variation_request', 'NTE Variation Request', 'email', 'field',
     'Budget approval needed - {job_title}',
     'Hi, the job "{job_title}" ({job_number}) is now over its approved not-to-exceed budget of {nte_limit} - current total is {nte_current_total}, exceeding it by {nte_exceeded_by}. Please review and approve to allow the job to be completed.<br><br>' ||
     '<a href="{nte_approval_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Approve Variation</a>'),
    (p_tenant_id, 'property_maintenance_due', 'Property Maintenance Due', 'email', 'field',
     'Upcoming maintenance - {property_address}',
     'Hi {pm_first_name}, property {property_address} is due for its scheduled roof/gutter inspection around {property_maintenance_due_date}. Let us know if you''d like us to book this in.'),
    (p_tenant_id, 'referral_lead_received', 'Referral Received', 'email', 'partner',
     'Thanks for the referral!',
     'Hi {partner_first_name}, thanks for referring {referred_client_name}! We have reached out to them and will keep you posted.'),
    (p_tenant_id, 'referral_job_completed', 'Referred Job Won', 'email', 'partner',
     'Great news - the job you referred is complete',
     'Hi {partner_first_name}, great news! The job referred for {referred_client_name} has been completed ({job_value}). Thank you for your support!'),
    (p_tenant_id, 'referral_monthly_digest', 'Monthly Referral Digest', 'email', 'partner',
     'Your monthly referral summary',
     'Hi {partner_first_name}, here''s a summary of the business you referred us this month: {digest_jobs_count} job(s) closed, totalling {digest_total_value}. Thank you for your continued support!'),
    (p_tenant_id, 'report_sent', 'Report Delivery', 'email', 'field',
     '{report_title} - {company_name}',
     'Hi {client_first_name}, please find your {report_title} report from {company_name} attached below.<br><br>' ||
     '<a href="{report_pdf_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View / Download Report</a>'),
    (p_tenant_id, 'subcontractor_quote_request', 'Subcontractor Quote Request', 'email', 'field',
     'Quote request - {job_title}',
     'Hi {subcontractor_contact_first_name}, we''d like a quote for the following work: {job_title} at {job_address}.<br><br>' ||
     '<a href="{po_quote_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View scope & submit your quote</a>'),
    (p_tenant_id, 'subcontractor_work_order', 'Subcontractor Work Order', 'email', 'field',
     'Purchase Order {po_number} from {company_name}',
     'Hi {subcontractor_contact_first_name}, please find Purchase Order {po_number} for {job_title} attached below - total {po_total}.<br><br>' ||
     '<a href="{po_pdf_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View Purchase Order</a>'),
    (p_tenant_id, 'subcontractor_compliance_expired', 'Compliance Document Expired', 'email', 'field',
     'Action needed - your compliance documents have expired',
     'Hi {subcontractor_contact_first_name}, your {expired_doc_type} for {subcontractor_company_name} expired on {expired_doc_expiry_date}. Please send us an updated Certificate of Currency or license to continue receiving work orders from {company_name}.')
  on conflict (tenant_id, trigger_key, type) do nothing;
end;
$$;

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_communication_rules(t.id);
    perform public.seed_default_communication_templates(t.id);
  end loop;
end;
$$;
