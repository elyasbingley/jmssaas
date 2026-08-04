-- Dynamic Reports & Safety Documentation Engine (SafetyCulture-style):
-- build, execute, and sign off on custom forms (SWMS, JSAs, roof audits,
-- site inspections) with photos, signatures, and dynamic pass/fail +
-- risk-matrix logic. Lives entirely in the desktop app, same "no field-
-- technician surface" scope decision the B2B & Referrals module made -
-- see this migration's RLS section for what that means concretely.
--
-- report_categories -> report_subcategories -> report_templates is a
-- fixed three-level taxonomy (category, subcategory, template) exactly as
-- specced - admin-managed reference data, same shape as price_book_
-- categories -> price_book_items.
--
-- report_templates.structure_schema is a jsonb array of sections, each
-- with an array of fields (id/type/label/required/...) - see
-- packages/shared/src/reports.ts for the exact shape both apps share.
-- Nothing in Postgres validates its internal shape (same "no fixed
-- columns for a form-builder JSON blob" tradeoff property_assets.attributes
-- already makes) - zod validates it at the app boundary instead.
--
-- report_instances.form_data is the executed answers, keyed by field id -
-- same reasoning, same tradeoff.
--
-- Storage: a single new "report-files" bucket holds every report's photos
-- and compiled PDF, under `<tenant_id>/<report_instance_id>/<filename>` -
-- deliberately NOT reusing the existing job-files bucket even for
-- job-linked reports, because job-files' download code
-- (JobDetail.tsx/TaskDetail.tsx) hardcodes bucket "job-files" - keeping
-- reports in their own bucket means a report generated standalone and
-- LATER linked to a job never needs its underlying file moved. "Auto-
-- attach the PDF to the Job's Documents & Attachments" (the spec's own
-- wording) becomes "the linked report + its PDF shows up in the Job
-- Card's own Reports & Safety section" rather than a duplicate row in
-- job_files - that section IS this content's attachment surface,
-- documented here since it's a deliberate reading of the spec rather
-- than a literal one.

create type public.report_field_type as enum ('pass_fail', 'risk_matrix', 'photo', 'text', 'long_text', 'meter_reading', 'signature');
create type public.report_instance_status as enum ('draft', 'completed', 'archived');
create type public.report_signer_role as enum ('technician', 'client', 'sub_contractor', 'site_supervisor');

-- ---------------------------------------------------------------------------
-- report_categories / report_subcategories / report_templates
-- ---------------------------------------------------------------------------

create table public.report_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  description text,
  icon text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_report_categories_updated_at
  before update on public.report_categories
  for each row execute function public.set_updated_at();

create index report_categories_tenant_id_idx on public.report_categories (tenant_id);

create table public.report_subcategories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  category_id uuid not null references public.report_categories (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_report_subcategories_updated_at
  before update on public.report_subcategories
  for each row execute function public.set_updated_at();

create index report_subcategories_tenant_id_idx on public.report_subcategories (tenant_id);
create index report_subcategories_category_id_idx on public.report_subcategories (category_id);

create table public.report_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  subcategory_id uuid not null references public.report_subcategories (id) on delete cascade,
  title text not null,
  description text,
  is_swms boolean not null default false,
  structure_schema jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_report_templates_updated_at
  before update on public.report_templates
  for each row execute function public.set_updated_at();

create index report_templates_tenant_id_idx on public.report_templates (tenant_id);
create index report_templates_subcategory_id_idx on public.report_templates (subcategory_id);

-- ---------------------------------------------------------------------------
-- report_instances / report_signatures
-- ---------------------------------------------------------------------------

create table public.report_instances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  template_id uuid not null references public.report_templates (id),
  -- Standalone-or-linked, either direction (Workflow 2): a report can be
  -- created with no job at all, gain one later via "Link to Job", or start
  -- linked from the Job Card's own "Create New Report" action.
  job_card_id uuid references public.job_cards (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  created_by uuid references public.profiles (id),
  status public.report_instance_status not null default 'draft',
  form_data jsonb not null default '{}'::jsonb,
  geo_location jsonb,
  pdf_storage_path text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_report_instances_updated_at
  before update on public.report_instances
  for each row execute function public.set_updated_at();

create index report_instances_tenant_id_idx on public.report_instances (tenant_id);
create index report_instances_template_id_idx on public.report_instances (template_id);
create index report_instances_job_card_id_idx on public.report_instances (job_card_id);
create index report_instances_client_id_idx on public.report_instances (client_id);

create table public.report_signatures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  report_instance_id uuid not null references public.report_instances (id) on delete cascade,
  signer_name text not null,
  signer_role public.report_signer_role not null default 'technician',
  signature_svg_data text not null,
  signed_at timestamptz not null default now()
);

create index report_signatures_tenant_id_idx on public.report_signatures (tenant_id);
create index report_signatures_report_instance_id_idx on public.report_signatures (report_instance_id);

-- ---------------------------------------------------------------------------
-- Storage: report-files bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('report-files', 'report-files', false)
on conflict (id) do nothing;

create policy "report-files: tenant read" on storage.objects
  for select using (
    bucket_id = 'report-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

create policy "report-files: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'report-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "report-files: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'report-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- RLS - every new table is admin-managed (no field-technician surface for
-- this module, same scope decision as agencies/referral_partners).
-- ---------------------------------------------------------------------------

alter table public.report_categories enable row level security;
create policy "report_categories: tenant read" on public.report_categories
  for select using (tenant_id = public.current_tenant_id());
create policy "report_categories: admin writes - insert" on public.report_categories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_categories: admin writes - update" on public.report_categories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_categories: admin writes - delete" on public.report_categories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.report_subcategories enable row level security;
create policy "report_subcategories: tenant read" on public.report_subcategories
  for select using (tenant_id = public.current_tenant_id());
create policy "report_subcategories: admin writes - insert" on public.report_subcategories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_subcategories: admin writes - update" on public.report_subcategories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_subcategories: admin writes - delete" on public.report_subcategories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.report_templates enable row level security;
create policy "report_templates: tenant read" on public.report_templates
  for select using (tenant_id = public.current_tenant_id());
create policy "report_templates: admin writes - insert" on public.report_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_templates: admin writes - update" on public.report_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_templates: admin writes - delete" on public.report_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.report_instances enable row level security;
create policy "report_instances: tenant read" on public.report_instances
  for select using (tenant_id = public.current_tenant_id());
create policy "report_instances: admin writes - insert" on public.report_instances
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_instances: admin writes - update" on public.report_instances
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_instances: admin writes - delete" on public.report_instances
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.report_signatures enable row level security;
create policy "report_signatures: tenant read" on public.report_signatures
  for select using (tenant_id = public.current_tenant_id());
create policy "report_signatures: admin writes - insert" on public.report_signatures
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "report_signatures: admin writes - delete" on public.report_signatures
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- Automation: "Send via Email" (manual, like quote_sent/invoice_sent - not
-- a DB trigger, the user chooses when to send a finished report). New
-- trigger_key + widened entity_type, same drop/re-add pattern as every
-- previous addition. Category 'field' already covers client-facing
-- operational messages (job_review_request, job_prep_checklist, ...) - a
-- report email fits that same bucket, no new category needed this time.
-- ---------------------------------------------------------------------------

alter table public.scheduled_communications
  drop constraint scheduled_communications_entity_type_check;

alter table public.scheduled_communications
  add constraint scheduled_communications_entity_type_check
  check (entity_type in ('quote', 'invoice', 'job', 'calendar_event', 'client', 'property_asset', 'referral_partner', 'report'));

-- Full cumulative lists again (established pattern - see the
-- fix_duplicate_communication_templates migration for why the templates
-- insert has an ON CONFLICT guard, and every migration since keeps it).
-- Redefining rather than a one-off backfill insert also means a NEW
-- tenant created after this migration - via handle_new_tenant(), which
-- calls both of these - gets 'report_sent' seeded automatically too, not
-- just existing tenants.

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
    -- Manual send, like quote_sent/invoice_sent - the user chooses when
    -- to email a finished report, so delay/direction are unused here too.
    (p_tenant_id, 'report_sent', 0, 'hours', 'after', 'email')
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
     '<a href="{report_pdf_link}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">View / Download Report</a>')
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
