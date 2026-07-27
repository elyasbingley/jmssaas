-- Customisable SMS/Email communication & automation engine. Three tables:
--
--   communication_rules - one row per trigger_key per tenant, admin-
--     configurable timing/channel/quiet-hours. Seeded with sensible
--     defaults per tenant (same "seeded defaults, fully admin-editable"
--     shape as job_lifecycle_stages), covering the trigger_keys this
--     migration knows how to actually fire: quote_stage_1, quote_stage_2,
--     invoice_pre_due, invoice_overdue_1, job_review_request,
--     job_on_the_way. Nothing in the schema restricts trigger_key to this
--     set - an admin can add more of either table from the app - but only
--     these six are ever auto-scheduled by the triggers below (the last
--     two are manually triggered from the app, not date-driven).
--
--   communication_templates - the actual SMS/email copy for a trigger_key,
--     admin-editable, containing {token} placeholders. Rendered client-side
--     for previews by packages/shared/src/placeholders.ts; the dispatcher
--     Edge Function (supabase/functions/process-scheduled-comms) has its
--     own Deno-native copy of the same token logic, since Edge Functions
--     can't import code from outside their own directory - see that
--     function's comment.
--
--   scheduled_communications - the actual send queue. rendered_subject/
--     rendered_body start as a straight copy of the template at schedule
--     time and get overwritten with the final rendered text just before
--     actual send (see the dispatcher) - so a still-pending row shows the
--     template as it existed when scheduled, and a sent row shows exactly
--     what the client received even if the template was edited afterwards.
--     trigger_key is duplicated here (not just reachable via template_id)
--     for two reasons: it survives a template being deleted
--     (template_id is ON DELETE SET NULL), and it lets the scheduling
--     triggers below cheaply check "has this entity already been
--     scheduled for this trigger_key" without joining through
--     communication_templates.
--
-- Two kinds of trigger, both AFTER UPDATE on quotes/invoices:
--
--   1. Auto-SCHEDULING (schedule_quote_communications/
--      schedule_invoice_communications) - NOT explicitly requested, but
--      required for the feature to do anything at all: the original spec
--      only described auto-*cancellation*, with nothing that ever inserts
--      the initial scheduled_communications row. Fires when a quote/
--      invoice transitions to status = 'sent', scheduling a row for every
--      enabled rule + matching template for that tenant. Quote follow-ups
--      are offset from "now" (the moment it's sent); invoice reminders are
--      offset from due_date, since that's the meaningful reference date
--      for a payment reminder, not the send date.
--
--   2. Auto-CANCELLATION (cancel_pending_quote_communications/
--      cancel_pending_invoice_communications), as specified: a quote's
--      approval_status becoming accepted/declined, or an invoice's status
--      becoming paid, cancels that entity's still-pending
--      scheduled_communications. Note quotes.approval_status (client-
--      facing acceptance via the approval link) is what's watched here,
--      not quotes.status (the separate admin-controlled draft/sent/.../
--      enum) - accept_quote_by_token only ever touches approval_status,
--      confirmed by reading that function in the quote_invoice_approval
--      migration.
--
-- Quiet hours have no per-tenant timezone to anchor against - this schema
-- has no tenants.timezone column, and adding one for a single-region (AU)
-- business the rest of this app already assumes (GST math, en-AU date
-- formatting, Sydney fallback map region) would be solving a problem this
-- product doesn't have yet. The dispatcher Edge Function hardcodes
-- Australia/Sydney for quiet-hours comparison - see its own comment.

-- phone: needed for {company_phone} - tenants had no phone column before
-- this (email/website/logo_url were added separately in the invoice_pdf_
-- rebrand migration, phone never was). google_review_link: needed for
-- {google_review_link} - with nowhere to persist this token's value, it
-- would always render empty; exposed as a field on the Automation &
-- Messaging Settings screen (mobile) rather than Company Details, since
-- it's specifically a messaging concern, not a general company detail.
alter table public.tenants
  add column phone text,
  add column google_review_link text;

create table public.communication_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  trigger_key text not null,
  is_enabled boolean not null default true,
  delay_offset_value integer not null default 0,
  delay_offset_unit text not null default 'days' check (delay_offset_unit in ('hours', 'days')),
  delay_direction text not null default 'after' check (delay_direction in ('before', 'after')),
  channel text not null default 'sms' check (channel in ('sms', 'email', 'both')),
  quiet_hours_start time not null default '08:00:00',
  quiet_hours_end time not null default '18:00:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, trigger_key)
);

create trigger set_communication_rules_updated_at
  before update on public.communication_rules
  for each row execute function public.set_updated_at();

create index communication_rules_tenant_id_idx on public.communication_rules (tenant_id);

create table public.communication_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  trigger_key text not null,
  name text not null,
  type text not null check (type in ('sms', 'email')),
  category text not null check (category in ('quote', 'invoice', 'booking', 'field')),
  subject text,
  body text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, trigger_key) references public.communication_rules (tenant_id, trigger_key) on delete cascade
);

create trigger set_communication_templates_updated_at
  before update on public.communication_templates
  for each row execute function public.set_updated_at();

create index communication_templates_tenant_id_idx on public.communication_templates (tenant_id);
create index communication_templates_trigger_key_idx on public.communication_templates (tenant_id, trigger_key);

create table public.scheduled_communications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  entity_type text not null check (entity_type in ('quote', 'invoice', 'job', 'calendar_event')),
  entity_id uuid not null,
  trigger_key text not null,
  template_id uuid references public.communication_templates (id) on delete set null,
  channel text not null check (channel in ('sms', 'email')),
  recipient_phone_or_email text not null,
  rendered_subject text,
  rendered_body text not null,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled', 'failed')),
  sent_at timestamptz,
  cancellation_reason text,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index scheduled_communications_tenant_id_idx on public.scheduled_communications (tenant_id);
create index scheduled_communications_entity_idx on public.scheduled_communications (entity_type, entity_id);
create index scheduled_communications_dispatch_idx on public.scheduled_communications (status, scheduled_for);

-- ---------------------------------------------------------------------------
-- Seed functions - same pattern as seed_default_lifecycle_stages.
-- ---------------------------------------------------------------------------

create or replace function public.seed_default_communication_rules(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_rules (tenant_id, trigger_key, delay_offset_value, delay_offset_unit, delay_direction, channel)
  values
    (p_tenant_id, 'quote_stage_1', 3, 'days', 'after', 'sms'),
    (p_tenant_id, 'quote_stage_2', 7, 'days', 'after', 'sms'),
    (p_tenant_id, 'invoice_pre_due', 2, 'days', 'before', 'sms'),
    (p_tenant_id, 'invoice_overdue_1', 3, 'days', 'after', 'sms'),
    (p_tenant_id, 'job_review_request', 0, 'hours', 'after', 'sms'),
    (p_tenant_id, 'job_on_the_way', 0, 'hours', 'after', 'sms')
  on conflict (tenant_id, trigger_key) do nothing;
end;
$$;

create or replace function public.seed_default_communication_templates(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.communication_templates (tenant_id, trigger_key, name, type, category, body)
  values
    (p_tenant_id, 'quote_stage_1', 'Quote Follow-up (first)', 'sms', 'quote',
     'Hi {client_first_name}, just checking in on quote {quote_number} for {quote_total} from {company_name}. Any questions, just ask! View it here: {quote_approval_link}'),
    (p_tenant_id, 'quote_stage_2', 'Quote Follow-up (second)', 'sms', 'quote',
     'Hi {client_first_name}, your quote {quote_number} from {company_name} is still open. Call {company_phone} if you''d like to go ahead.'),
    (p_tenant_id, 'invoice_pre_due', 'Invoice Due Soon', 'sms', 'invoice',
     'Hi {client_first_name}, a reminder that invoice {invoice_number} ({invoice_total}) from {company_name} is due {invoice_due_date}. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'invoice_overdue_1', 'Invoice Overdue', 'sms', 'invoice',
     'Hi {client_first_name}, invoice {invoice_number} ({invoice_total}) from {company_name} was due {invoice_due_date} and is now overdue. Pay here: {invoice_payment_link}'),
    (p_tenant_id, 'job_review_request', 'Job Review Request', 'sms', 'field',
     'Hi {client_first_name}, thanks for choosing {company_name}! We''d love your feedback: {google_review_link}'),
    (p_tenant_id, 'job_on_the_way', 'On The Way', 'sms', 'field',
     '{tech_first_name} from {company_name} is on the way to {site_address}, arriving in about {eta_minutes} minutes.');
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

-- Extends the existing handle_new_tenant() (see the
-- job_categories_lifecycle_stages migration) rather than adding a second
-- trigger on tenants - the trigger seed_lifecycle_stages_on_tenant_insert
-- already calls this function on every new tenant, so replacing its body
-- is enough; no new trigger needed.
create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
as $$
begin
  perform public.seed_default_lifecycle_stages(new.id);
  perform public.seed_default_communication_rules(new.id);
  perform public.seed_default_communication_templates(new.id);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Auto-scheduling - fires when a quote/invoice transitions TO 'sent'.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_quote_communications()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_offset interval;
  v_scheduled_for timestamptz;
begin
  if new.status = 'sent' and new.status is distinct from old.status then
    select * into v_client from public.clients where id = new.client_id;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id
        and trigger_key in ('quote_stage_1', 'quote_stage_2')
        and is_enabled = true
    loop
      -- Idempotency: never double-schedule the same trigger_key for the
      -- same quote (e.g. an admin flipping status back to draft and
      -- resending shouldn't stack duplicate follow-ups).
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'quote' and entity_id = new.id and trigger_key = r.trigger_key
      ) then
        continue;
      end if;

      v_offset := make_interval(
        days => case when r.delay_offset_unit = 'days' then r.delay_offset_value else 0 end,
        hours => case when r.delay_offset_unit = 'hours' then r.delay_offset_value else 0 end
      );
      v_scheduled_for := case when r.delay_direction = 'before' then now() - v_offset else now() + v_offset end;

      for tmpl in
        select * from public.communication_templates ct
        where ct.tenant_id = new.tenant_id and ct.trigger_key = r.trigger_key and ct.is_active = true
          and (r.channel = 'both' or r.channel = ct.type)
      loop
        insert into public.scheduled_communications
          (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
        values (
          new.tenant_id, 'quote', new.id, r.trigger_key, tmpl.id, tmpl.type,
          case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
          tmpl.subject, tmpl.body, v_scheduled_for
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_quote_communications_trigger
  after update on public.quotes
  for each row execute function public.schedule_quote_communications();

create or replace function public.schedule_invoice_communications()
returns trigger
language plpgsql
as $$
declare
  r record;
  tmpl record;
  v_client public.clients;
  v_offset interval;
  v_reference timestamptz;
  v_scheduled_for timestamptz;
begin
  if new.status = 'sent' and new.status is distinct from old.status and new.due_date is not null then
    select * into v_client from public.clients where id = new.client_id;
    v_reference := new.due_date::timestamptz;

    for r in
      select * from public.communication_rules
      where tenant_id = new.tenant_id
        and trigger_key in ('invoice_pre_due', 'invoice_overdue_1')
        and is_enabled = true
    loop
      if exists (
        select 1 from public.scheduled_communications
        where entity_type = 'invoice' and entity_id = new.id and trigger_key = r.trigger_key
      ) then
        continue;
      end if;

      v_offset := make_interval(
        days => case when r.delay_offset_unit = 'days' then r.delay_offset_value else 0 end,
        hours => case when r.delay_offset_unit = 'hours' then r.delay_offset_value else 0 end
      );
      v_scheduled_for := case when r.delay_direction = 'before' then v_reference - v_offset else v_reference + v_offset end;

      for tmpl in
        select * from public.communication_templates ct
        where ct.tenant_id = new.tenant_id and ct.trigger_key = r.trigger_key and ct.is_active = true
          and (r.channel = 'both' or r.channel = ct.type)
      loop
        insert into public.scheduled_communications
          (tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for)
        values (
          new.tenant_id, 'invoice', new.id, r.trigger_key, tmpl.id, tmpl.type,
          case when tmpl.type = 'sms' then coalesce(v_client.phone, '') else coalesce(v_client.email, '') end,
          tmpl.subject, tmpl.body, v_scheduled_for
        );
      end loop;
    end loop;
  end if;
  return new;
end;
$$;

create trigger schedule_invoice_communications_trigger
  after update on public.invoices
  for each row execute function public.schedule_invoice_communications();

-- ---------------------------------------------------------------------------
-- Auto-cancellation - as specified.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_pending_quote_communications()
returns trigger
language plpgsql
as $$
begin
  if new.approval_status in ('accepted', 'declined')
     and new.approval_status is distinct from old.approval_status then
    update public.scheduled_communications
    set status = 'cancelled', cancellation_reason = 'Quote status updated'
    where entity_type = 'quote' and entity_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

create trigger cancel_pending_quote_communications_trigger
  after update on public.quotes
  for each row execute function public.cancel_pending_quote_communications();

create or replace function public.cancel_pending_invoice_communications()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'paid' and new.status is distinct from old.status then
    update public.scheduled_communications
    set status = 'cancelled', cancellation_reason = 'Invoice paid'
    where entity_type = 'invoice' and entity_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

create trigger cancel_pending_invoice_communications_trigger
  after update on public.invoices
  for each row execute function public.cancel_pending_invoice_communications();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.communication_rules enable row level security;

create policy "communication_rules: tenant read" on public.communication_rules
  for select using (tenant_id = public.current_tenant_id());

create policy "communication_rules: admin writes - insert" on public.communication_rules
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "communication_rules: admin writes - update" on public.communication_rules
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "communication_rules: admin writes - delete" on public.communication_rules
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.communication_templates enable row level security;

create policy "communication_templates: tenant read" on public.communication_templates
  for select using (tenant_id = public.current_tenant_id());

create policy "communication_templates: admin writes - insert" on public.communication_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "communication_templates: admin writes - update" on public.communication_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "communication_templates: admin writes - delete" on public.communication_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Tenant-wide read/insert (matches clients - "small crew, everyone needs
-- to be able to log an outbound message", since On The Way/review-request
-- are technician actions from the field), admin-only update/delete. The
-- scheduling/cancellation triggers above insert/update as the function
-- owner, bypassing RLS regardless of these policies - they only govern
-- direct client-side writes.
alter table public.scheduled_communications enable row level security;

create policy "scheduled_communications: tenant isolation - select" on public.scheduled_communications
  for select using (tenant_id = public.current_tenant_id());

create policy "scheduled_communications: tenant isolation - insert" on public.scheduled_communications
  for insert with check (tenant_id = public.current_tenant_id());

create policy "scheduled_communications: admin writes - update" on public.scheduled_communications
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "scheduled_communications: admin writes - delete" on public.scheduled_communications
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
