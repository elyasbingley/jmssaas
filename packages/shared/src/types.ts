// Mirrors supabase/migrations/20260720000100_init_schema.sql.
// Keep in sync by hand for Phase 1; consider `supabase gen types typescript`
// once the schema stabilises.

import type { ReportFormData, ReportStructureSchema } from "./reports";

export type UserRole = "admin" | "technician";

export type TaskStatus = "todo" | "in_progress" | "done";

export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "expired";

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

// Tracks the client's response to the digital approval link, entirely
// separate from the `status` column above (which is the internal
// draft/sent/paid/... workflow state an admin can change freely at any
// time). Null until an approval link has ever been generated.
export type ApprovalStatus = "sent" | "viewed" | "accepted" | "declined";

export type TemplateType = "quote" | "invoice";

// abn/business address/license/bank fields were added specifically to
// support the PDF export's company block and bank details section (see
// money-generating docs/SETUP.md Phase 5/6 notes) - all optional since a
// tenant can exist (and use the rest of the app) without ever filling them
// in, they just won't show up on an exported PDF until it does.
export interface Tenant {
  id: string;
  name: string;
  abn: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  business_address_line1: string | null;
  business_address_line2: string | null;
  business_suburb: string | null;
  business_state: string | null;
  business_postcode: string | null;
  license_number: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_bsb: string | null;
  // Used by the {google_review_link} placeholder token - see the
  // communication_engine migration. Set from the Automation & Messaging
  // Settings screen, not Company Details, since it's specifically a
  // messaging concern.
  google_review_link: string | null;
  // Which Xero chart-of-accounts code sales line items post against - see
  // the xero_integration migration's own comment on why this is
  // configurable rather than a fixed guess.
  xero_sales_account_code: string;
  // Admin-customizable calendar event colors by category - see
  // CalendarCategoryColors and the calendar_recurrence_and_colors
  // migration's own comment on why this is a single jsonb column rather
  // than one column per category.
  calendar_category_colors: CalendarCategoryColors;
  // Stripe Connect (Express) - see the membership_plans_and_clients
  // migration. Null/false until the tenant completes onboarding via
  // stripe-connect-onboard; membership payments settle directly into this
  // connected account, entirely separate from the platform-level
  // STRIPE_SECRET_KEY the existing invoice-payment Stripe code uses.
  stripe_connect_account_id: string | null;
  stripe_connect_onboarded: boolean;
  created_at: string;
}

export interface Profile {
  id: string;
  tenant_id: string;
  role: UserRole;
  full_name: string;
  email: string;
  phone: string | null;
  // Free-text position/title (e.g. "Foreman", "Office Manager") - purely
  // organisational, distinct from `role` which is the fixed admin/
  // technician value every RLS policy and permission check keys off.
  job_title: string | null;
  created_at: string;
  updated_at: string;
}

export type ClientType = "individual" | "company";

export interface Client {
  id: string;
  tenant_id: string;
  // "Individual" clients (regular COD homeowners): this is the client's own
  // full name. "Company" clients: this is the primary contact person's name
  // - the company's own name lives in company_name instead, so a company
  // client can never be created with just a person's name in the company
  // slot (or vice versa).
  name: string;
  client_type: ClientType;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  // Primary business address, distinct from ClientSite (which models
  // per-job site addresses - a client can have several, this is just one).
  address_line1: string | null;
  address_line2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  // Link to that client's WorkDrive folder, pasted in by hand - this app
  // never talks to WorkDrive itself, it's just a stored URL.
  workdrive_url: string | null;
  // Set the first time this client is pushed to Xero (as a Contact) via
  // an invoice sync - reused on every later sync instead of creating a
  // duplicate Xero Contact each time.
  xero_contact_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// A client (especially a company client) can have several people you deal
// with beyond the one name/email/phone on the clients row itself.
export interface ClientContact {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  created_at: string;
}

export interface ClientSite {
  id: string;
  tenant_id: string;
  client_id: string;
  label: string | null;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  is_primary: boolean;
  notes: string | null;
  created_at: string;
}

export interface JobCard {
  id: string;
  tenant_id: string;
  client_id: string;
  site_id: string | null;
  // Auto-assigned by a Postgres trigger on insert (see the ux_overhaul
  // migration) - null on a device until this row round-trips through a
  // sync after creation (see docs/SETUP.md known-gaps for why).
  number: string | null;
  title: string;
  description: string | null;
  assigned_technician_id: string | null;
  quote_id: string | null;
  invoice_id: string | null;
  scheduled_at: string | null;
  completed_at: string | null;
  service_category_id: string | null;
  // The job's place in its tenant's customizable pipeline - this replaced a
  // separate fixed `status` enum (new/scheduled/in_progress/completed/
  // invoiced) that job_lifecycle_stages originally existed alongside; see
  // the job_status_lifecycle_consolidation migration for why they were
  // folded into this one field instead of kept in sync with each other.
  // Never null in practice - a BEFORE INSERT trigger defaults it to the
  // tenant's lowest-position stage - but nullable here since the FK is
  // ON DELETE SET NULL (deleting a stage shouldn't cascade-delete jobs).
  lifecycle_stage_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Real Estate & Strata module fields (see the real_estate_strata
  // migration) - a real estate job is still a normal JobCard, just tagged
  // with this extra agency/property metadata. All null/false for an
  // ordinary (non-agency) job.
  is_real_estate_job: boolean;
  agency_id: string | null;
  property_manager_id: string | null;
  property_id: string | null;
  work_order_number: string | null;
  nte_limit_cents: number | null;
  nte_exceeded_approved: boolean;
  // B2B & Referral Tracking module (see the b2b_referral_tracking
  // migration) - a referred job is still a normal JobCard, just tagged
  // with which referral_partners row sent it. referral_fee_amount_cents is
  // computed automatically when the linked invoice is marked paid (see
  // calculate_referral_fee_on_invoice_paid); referral_fee_paid is a manual
  // "we actually paid the partner out" flag, never flipped by the system.
  referral_partner_id: string | null;
  referral_fee_paid: boolean;
  referral_fee_amount_cents: number | null;
  // Link to this job's WorkDrive folder, pasted in by hand - same idea as
  // clients.workdrive_url, just scoped to one job instead of the client.
  workdrive_url: string | null;
}

// ---------------------------------------------------------------------------
// Real Estate & Strata module - mirrors the real_estate_strata migration.
// ---------------------------------------------------------------------------

export type AgencyType = "real_estate" | "strata";

export interface Agency {
  id: string;
  tenant_id: string;
  name: string;
  type: AgencyType;
  billing_email: string | null;
  phone: string | null;
  payment_terms_days: number;
  require_work_order_num: boolean;
  // The client record this agency bills jobs against - set once per agency
  // (linked to an existing client, or a new one auto-created alongside the
  // agency) so job creation can derive client_id automatically instead of
  // requiring it to be picked separately every time.
  client_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyManager {
  id: string;
  tenant_id: string;
  agency_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile: string | null;
  work_phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type PropertyType = "residential" | "commercial" | "strata_common_property" | "strata_lot";

export interface Property {
  id: string;
  tenant_id: string;
  agency_id: string;
  property_manager_id: string | null;
  address_line1: string;
  suburb: string;
  state: string;
  postcode: string;
  property_type: PropertyType;
  strata_plan_number: string | null;
  owner_landlord_name: string | null;
  owner_landlord_phone: string | null;
  owner_landlord_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
  access_notes: string | null;
  key_tag_number: string | null;
  created_at: string;
  updated_at: string;
}

// Additional occupants beyond the single tenant_name/phone/email on
// Property itself (which stays as-is - it's read from PDFs, the public
// approval page, mobile, and invoicing). This covers share-house /
// multi-occupant properties.
export interface PropertyTenant {
  id: string;
  tenant_id: string;
  property_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export type PropertyAssetCategory = "plumbing" | "roofing" | "hvac" | "general";

// Deliberately schemaless per-category fields - see the migration's own
// comment for why a fixed column set doesn't fit here. Every field
// optional; the UI only shows the subset relevant to the asset's category.
export interface PropertyAssetAttributes {
  brand?: string;
  model?: string;
  serial_number?: string;
  fuel_type?: "gas" | "electric" | "solar";
  capacity_litres?: number;
  installation_date?: string;
  warranty_expiry_date?: string;
  roof_type?: "colorbond" | "tile" | "slate";
  roof_age_years?: number;
  last_gutter_clean_date?: string;
  gutter_clean_interval_months?: number;
  screw_condition?: string;
  ridge_condition?: string;
}

export interface PropertyAsset {
  id: string;
  tenant_id: string;
  property_id: string;
  category: PropertyAssetCategory;
  asset_name: string;
  attributes: PropertyAssetAttributes;
  created_at: string;
  updated_at: string;
}

export type KeyLogStatus = "at_office" | "picked_up" | "in_van" | "returned";

export interface KeyLog {
  id: string;
  tenant_id: string;
  property_id: string;
  job_id: string | null;
  technician_id: string | null;
  key_tag_number: string;
  status: KeyLogStatus;
  picked_up_at: string | null;
  returned_at: string | null;
  created_at: string;
  updated_at: string;
}

// A simple tag on a job (e.g. "Roof Restoration", "Gutter Cleaning") -
// admin-managed, tenant-wide, purely descriptive (no behavior keys off it),
// with one exception: maintenance_interval_months (see the
// communication_engine_retention migration) - when set, a job in this
// category completing schedules a maintenance_reminder email that many
// months later. Null means no recurring reminder for this category.
export interface ServiceCategory {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  maintenance_interval_months: number | null;
  created_at: string;
  updated_at: string;
}

// An admin-configurable, ordered pipeline (e.g. "Enquiry" / "Quote Sent" /
// "Deposit Paid" / "In Progress") - the sole tag/pipeline on a job now that
// the old fixed status enum was folded into this (see the
// job_status_lifecycle_consolidation migration).
export interface JobLifecycleStage {
  id: string;
  tenant_id: string;
  name: string;
  position: number;
  color: string | null;
  is_system_default: boolean;
  // Marks a stage as "the job is done" for the two triggers that used to
  // key off status = 'completed' (schedule_job_completion_summary,
  // schedule_maintenance_reminder) - true for the default Completed/
  // Invoiced stages, false for everything else including any custom stage
  // an admin adds, unless they flip this on for it too.
  is_closed: boolean;
  created_at: string;
  updated_at: string;
}

export interface JobNote {
  id: string;
  tenant_id: string;
  job_card_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface JobFile {
  id: string;
  tenant_id: string;
  job_card_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  tenant_id: string;
  job_card_id: string | null;
  // Auto-assigned by a Postgres trigger on insert - see JobCard.number.
  number: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  assigned_to: string | null;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Asana-style project engine (see the asana_task_engine migration).
  // section_id is a purely organisational Kanban-column position within
  // project_id - independent of `status` above, which still drives
  // completion everywhere it always has (see the migration's own comment).
  project_id: string | null;
  section_id: string | null;
  // Subtasks are ordinary tasks rows with parent_task_id set - no separate
  // subtask table.
  parent_task_id: string | null;
  priority: TaskPriority;
  is_milestone: boolean;
  start_date: string | null;
  position_order: number;
  estimated_hours: number | null;
  actual_hours: number | null;
  // JMS entity links - job linking reuses job_card_id above, these two are
  // the new ones.
  client_id: string | null;
  property_id: string | null;
}

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type TaskProjectViewType = "BOARD" | "LIST" | "CALENDAR" | "TIMELINE";

export interface TaskProject {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  color_hex: string;
  icon: string;
  view_type: TaskProjectViewType;
  is_archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSection {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  position_order: number;
  created_at: string;
}

// A directed edge: blocking_task_id blocks dependent_task_id.
export interface TaskDependency {
  id: string;
  tenant_id: string;
  blocking_task_id: string;
  dependent_task_id: string;
  created_at: string;
}

export type TaskCustomFieldType = "text" | "number" | "dropdown" | "date";

export interface TaskCustomField {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  field_type: TaskCustomFieldType;
  // Option strings, DROPDOWN fields only - e.g. ["Roof", "Gutters"]. Null
  // for every other field_type.
  options: string[] | null;
  position_order: number;
  created_at: string;
  updated_at: string;
}

// One row per task+custom_field pair - only the column matching the
// field's own field_type is populated, the other two stay null.
export interface TaskCustomFieldValue {
  id: string;
  tenant_id: string;
  task_id: string;
  custom_field_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  created_at: string;
  updated_at: string;
}

// System-generated field-change history - populated by the
// log_task_activity trigger, never inserted directly from the client. See
// TaskNote for the human-authored comment half of the activity feed.
export interface TaskActivityLog {
  id: string;
  tenant_id: string;
  task_id: string;
  actor_id: string | null;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface TaskNote {
  id: string;
  tenant_id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface TaskFile {
  id: string;
  tenant_id: string;
  task_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface Template {
  id: string;
  tenant_id: string;
  type: TemplateType;
  name: string;
  default_line_items: LineItemInput[];
  terms_text: string | null;
  created_at: string;
  updated_at: string;
}

// Line Total = Qty x [(Labour Rate x Hours + Material Cost) x (1 + Markup%)]
// (confirmed with the person - the reference formula had no quantity term,
// but quantity was also requested as its own field; quantity multiplies the
// whole bracketed amount). unit_price_cents holds that bracketed per-unit
// price - it's a derived value (see money.ts's computeLineItemUnitPriceCents),
// not directly user-entered, kept as a real column/field so the existing
// subtotal math (quantity * unit_price_cents) doesn't need to change at all.
export interface LineItemInput {
  description: string;
  quantity: number;
  labour_rate_cents: number;
  labour_hours: number;
  material_cost_cents: number;
  markup_percent: number;
  unit_price_cents: number;
  gst_applicable: boolean;
  sort_order: number;
  // Membership discount engine (see the membership_discount_engine
  // migration) - is_callout_fee is a flag copied at add-time (from a
  // price_book_items row, or set manually), waived_amount_cents is
  // server-computed at save time, never client-set for a non-overridden
  // document. unit_price_cents itself never changes because of a waiver -
  // see calculate_line_item_totals's own comment on why waiving subtracts
  // rather than zeroes. Both optional here (rather than required, even
  // though the DB columns are NOT NULL) so every existing line-item-editor
  // call site across desktop/mobile that builds one of these objects
  // without them still compiles - the server defaults a missing
  // is_callout_fee to false and waived_amount_cents to 0 either way (see
  // replace_quote_line_items/replace_invoice_line_items's own coalesce).
  is_callout_fee?: boolean;
  waived_amount_cents?: number;
}

export interface Quote {
  id: string;
  tenant_id: string;
  client_id: string;
  job_card_id: string | null;
  // Which of the client's addresses (client_sites) this quote is for - null
  // falls back to the client's own primary address, same as before this
  // column existed.
  site_id: string | null;
  template_id: string | null;
  quote_number: string;
  status: QuoteStatus;
  issue_date: string;
  expiry_date: string | null;
  subtotal_cents: number;
  gst_cents: number;
  total_cents: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  approval_status: ApprovalStatus | null;
  access_token: string | null;
  token_expires_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  accepted_by_name: string | null;
  // Proof of acceptance captured on the public approval page - a drawn
  // signature stamped onto the document itself, not just a typed name (see
  // the quote_invoice_signature migration).
  accepted_signature_svg: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  referral_partner_id: string | null;
  referral_fee_paid: boolean;
  referral_fee_amount_cents: number | null;
  // Client-supplied purchase order reference - optional, any client type
  // (not the real-estate/strata-only job_cards.work_order_number). Shown
  // on the PDF only when set.
  po_number: string | null;
  // Membership discount engine (see the membership_discount_engine
  // migration) - client_membership_id/membership_discount_percent/cents
  // are auto-set from the client's active membership on every line-item
  // save, UNLESS membership_discount_overridden is true, in which case an
  // admin has taken manual control and these stay exactly as they last
  // set them (see set_quote_membership_discount_override).
  client_membership_id: string | null;
  membership_discount_percent: number;
  membership_discount_cents: number;
  membership_discount_overridden: boolean;
}

export interface QuoteLineItem extends LineItemInput {
  id: string;
  tenant_id: string;
  quote_id: string;
}

export interface Invoice {
  id: string;
  tenant_id: string;
  client_id: string;
  job_card_id: string | null;
  quote_id: string | null;
  // Which of the client's addresses (client_sites) this invoice is for -
  // null falls back to the client's own primary address.
  site_id: string | null;
  invoice_number: string;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string | null;
  subtotal_cents: number;
  gst_cents: number;
  total_cents: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  approval_status: ApprovalStatus | null;
  access_token: string | null;
  token_expires_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  accepted_by_name: string | null;
  accepted_signature_svg: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  // Stripe Checkout - see the stripe_payments migration. stripe_checkout_url
  // is (re)generated by the approve Edge Function the first time an
  // accepted, unpaid invoice's payment link is requested, and reused until
  // it expires or the invoice is paid.
  stripe_checkout_url: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  // Set once, the first time status transitions to 'paid' - see
  // set_invoice_paid_at in the b2b_referral_tracking migration. Not
  // cleared if status ever moves off 'paid' again.
  paid_at: string | null;
  // Xero sync (Phase 1, one-way push - see the xero-sync Edge Function's
  // own comment). xero_invoice_id is null until the first successful
  // sync, then reused on every later sync (an update, not a duplicate).
  // xero_sync_error holds the last failed sync's message, cleared back to
  // null on the next successful one.
  xero_invoice_id: string | null;
  xero_synced_at: string | null;
  xero_sync_error: string | null;
  // Real-estate/strata jobs: redirects who this invoice is billed to (PDF
  // Bill To name/contact + the email composer's default recipient) from
  // the job's agency/PM client row to the property's owner_landlord_*
  // contact fields instead - see InvoiceDetail.tsx's "Bill to" control.
  // False (the default) is identical to this app's pre-existing behaviour.
  bill_to_landlord: boolean;
  // Client-supplied purchase order reference - optional, any client type
  // (not the real-estate/strata-only job_cards.work_order_number). Shown
  // on the PDF only when set.
  po_number: string | null;
  // Membership discount engine - see Quote's own identical fields.
  client_membership_id: string | null;
  membership_discount_percent: number;
  membership_discount_cents: number;
  membership_discount_overridden: boolean;
}

export interface InvoiceLineItem extends LineItemInput {
  id: string;
  tenant_id: string;
  invoice_id: string;
}

export interface PriceBookCategory {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  // Shown as the tile's background image (name overlaid at the bottom)
  // instead of the plain color swatch, when set.
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

// The template a quote/invoice line item gets created from, not a line item
// itself - no quantity or gst_applicable, those only apply once something's
// actually added to a specific quote/invoice.
export interface PriceBookItem {
  id: string;
  tenant_id: string;
  category_id: string;
  description: string;
  labour_rate_cents: number;
  labour_hours: number;
  material_cost_cents: number;
  markup_percent: number;
  sort_order: number;
  // Shown as the tile's background image (name overlaid at the bottom)
  // instead of the plain color swatch, when set.
  image_url: string | null;
  // Marks which catalogue item(s) represent a call-out fee, so the
  // membership discount engine can zero-price it for a member client
  // separately from the percentage discount - see the
  // membership_plans_and_clients migration. Optional here (the DB column
  // is NOT NULL default false) so existing price-book editor call sites
  // that build this object without it still compile - not yet surfaced as
  // an editable toggle anywhere in the UI (see docs/SETUP.md's own
  // write-up on this gap).
  is_callout_fee?: boolean;
  created_at: string;
  updated_at: string;
}

export interface PriceBookItemVariation {
  id: string;
  tenant_id: string;
  price_book_item_id: string;
  name: string;
  labour_rate_cents: number;
  labour_hours: number;
  material_cost_cents: number;
  markup_percent: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type CalendarEventSource = "app" | "google_personal";

// The four categories the calendar UI actually distinguishes with color -
// derived from an event's own fields (job_card_id -> "job", task_id ->
// "task", source='google_personal' -> "personal", anything else ->
// "general"), not a free-form field of its own. See
// packages/shared/src/calendar-recurrence.ts's categoryForEvent().
export type CalendarEventCategory = "job" | "task" | "personal" | "general";

export type CalendarCategoryColors = Record<CalendarEventCategory, string>;

export const DEFAULT_CALENDAR_CATEGORY_COLORS: CalendarCategoryColors = {
  job: "#1d4ed8",
  task: "#16a34a",
  personal: "#f59e0b",
  general: "#6b7280",
};

// Recurrence frequency + interval + how the series ends. Deliberately far
// simpler than an RFC 5545 RRULE string - this app only ever needs to
// generate a finite list of occurrence dates up front (see
// generateRecurrenceOccurrences in calendar-recurrence.ts), never parse
// an arbitrary externally-authored rule, so there's no value in the full
// RRULE grammar's complexity.
export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  // Only meaningful for freq: 'weekly' - 0 (Sunday) through 6 (Saturday).
  // Defaults to the start date's own weekday when omitted.
  byWeekday?: number[];
  endType: "never" | "on" | "after";
  // ISO date (yyyy-mm-dd), required when endType is 'on'.
  endDate?: string;
  // Occurrence count including the first, required when endType is 'after'.
  count?: number;
}

export interface CalendarEvent {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  location: string | null;
  guests: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  job_card_id: string | null;
  task_id: string | null;
  google_calendar_id: string | null;
  google_event_id: string | null;
  last_synced_at: string | null;
  // 'app': created in this app, two-way synced with Google when the
  // resolved assignee has connected their calendar. 'google_personal':
  // imported from a technician's own Google Calendar - title/description/
  // location/guests on this row are always "Busy"/null regardless of
  // source, since the real content only exists in
  // CalendarEventPersonalDetails, which RLS restricts to the owning
  // profile. See supabase/migrations/20260902000100_google_calendar_sync.sql.
  source: CalendarEventSource;
  owner_profile_id: string | null;
  google_calendar_connection_id: string | null;
  // Every occurrence of a recurring event is its own independent row with
  // the same recurrence_rule/recurrence_group_id (denormalized, not a
  // single "series master") - see the calendar_recurrence_and_colors
  // migration's own comment on why. Both null for a non-recurring event.
  recurrence_rule: RecurrenceRule | null;
  recurrence_group_id: string | null;
  // Directly overrides the derived category/color (see categoryForEvent
  // in calendar-recurrence.ts) - null means "derive it as usual from
  // job_card_id/task_id/source". Only 'job' | 'task' | 'general' are
  // valid here, never 'personal' - see the calendar_category_override
  // migration's own check constraint.
  category_override: Exclude<CalendarEventCategory, "personal"> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// The real title/description/location/guests of a 'google_personal'
// CalendarEvent - only ever readable by its owner (RLS: owner_profile_id =
// auth.uid()), so an unfiltered fetch of this table always safely returns
// just the caller's own rows. The app merges these back onto the matching
// CalendarEvent client-side for events the viewer owns; every other
// google_personal row is displayed exactly as calendar_events itself has
// it (the "Busy" placeholder), with no further redaction needed.
export interface CalendarEventPersonalDetails {
  calendar_event_id: string;
  owner_profile_id: string;
  title: string;
  description: string | null;
  location: string | null;
  guests: string | null;
  created_at: string;
}

// Status shape returned by get_google_calendar_connection_status() -
// intentionally never includes tokens, only enough to drive a "Connect" vs
// "Connected as {email}" UI.
export interface GoogleCalendarConnectionStatus {
  connected: boolean;
  email?: string | null;
  connected_at?: string | null;
}

// Row shape returned by the admin-only list_google_calendar_connections()
// RPC - one row per tenant profile, connection fields null if not
// connected.
export interface GoogleCalendarConnectionListItem {
  profile_id: string;
  full_name: string;
  email: string;
  google_account_email: string | null;
  connected_at: string | null;
}

// A physical place stock lives - "Ute 1", "Main Warehouse", a shelf.
// Admin-managed setup data, same shape/RLS as ServiceCategory.
export interface InventoryLocation {
  id: string;
  tenant_id: string;
  name: string;
  type: string | null;
  created_at: string;
  updated_at: string;
}

// Inventory's own top-level category - "Material", "Tools", "First Aid
// Kit". Admin-managed setup data, same shape/RLS as InventoryLocation.
// Deliberately separate from ServiceCategory (job tagging) and
// PriceBookCategory (quote/invoice catalogue) - this hierarchy exists only
// to organise physical stock, see the inventory_material_categories
// migration.
export interface InventoryCategory {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// An optional second level under an InventoryCategory - "Roofing"/
// "Plumbing"/"Tapware" under "Material", say. Not every category needs
// one - an InventoryItem's subcategory_id is nullable for exactly that
// reason.
export interface InventorySubcategory {
  id: string;
  tenant_id: string;
  category_id: string;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// A named supplier an item is sourced from - "Bunnings", "Reece". Flat,
// admin-managed, tenant-wide read like InventoryCategory - no hierarchy
// needed here. See the inventory_suppliers_and_targets migration.
export interface InventorySupplier {
  id: string;
  tenant_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

// The actual thing being stocked - "Silicone tube - clear", "Cordless
// drill". Its own standalone catalogue, unrelated to PriceBookItem (see
// the inventory_material_categories migration for why those two turned
// out not to be the same thing). reorder_threshold/ideal_stock/
// supplier_id are properties of the item itself (not of any one location
// it's stocked at) - see the inventory_suppliers_and_targets migration,
// which moved reorder_threshold here from InventoryLevel.
export interface InventoryItem {
  id: string;
  tenant_id: string;
  category_id: string;
  subcategory_id: string | null;
  supplier_id: string | null;
  name: string;
  // The quantity at a location that triggers the Low-Stock queue.
  reorder_threshold: number;
  // The target quantity a reorder should bring a location back up to -
  // distinct from reorder_threshold (the alert point) - see
  // suggestedReorderQuantity in apps/mobile/lib/pdf.ts.
  ideal_stock: number;
  // Shown as the mobile inventory tile's background image (name overlaid
  // at the bottom), same treatment as price book category/item tiles.
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

// The quantity of an InventoryItem held at a given InventoryLocation.
// Unlike InventoryLocation/InventoryCategory/InventorySubcategory/
// InventoryItem/InventorySupplier, this is tenant-wide *writable* - see
// the inventory_stock_control migration's RLS comment.
export interface InventoryLevel {
  id: string;
  tenant_id: string;
  location_id: string;
  item_id: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

// Not its own table - an InventoryLevel joined with its item/location/
// category/subcategory/supplier names for display in the Low-Stock queue
// and the shopping list PDF. Built client-side (see the inventory
// screen's join over the PowerSync-local tables), not a server view.
export interface LowStockItem {
  inventory_level_id: string;
  location_id: string;
  location_name: string;
  item_id: string;
  item_name: string;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  quantity: number;
  reorder_threshold: number;
  ideal_stock: number;
}

export interface Coordinate {
  lat: number;
  lng: number;
}

// One traced section of roof within a JobMeasurement - "Main House Roof",
// "Garage", "Rear Pergola". flat_area_sqm/true_area_sqm are computed
// client-side (see geo.ts's polygonFlatAreaSqm/trueAreaSqm) and persisted
// alongside the raw coordinates rather than recomputed on every read, so a
// saved measurement's numbers stay exactly what was shown/saved even if
// the area math is refined later.
export interface Facet {
  id: string;
  name: string;
  pitch_degrees: number;
  flat_area_sqm: number;
  true_area_sqm: number;
  coordinates: Coordinate[];
}

// A saved roof measurement against a job - append-style history (like
// JobNote), not a single mutable record per job, since a roof can
// legitimately be re-measured over time. total_flat_area_sqm/
// total_true_area_sqm are the sum of every facet's own area, stored
// redundantly so screens/reports can read one number without summing
// `facets` themselves - see the roof_measurements migration.
export interface JobMeasurement {
  id: string;
  tenant_id: string;
  job_card_id: string;
  title: string;
  facets: Facet[];
  total_flat_area_sqm: number;
  total_true_area_sqm: number;
  snapshot_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Job Card Quote Tools - mirrors the quote_tools migration. Alongside the
// existing roof measurement tool (JobMeasurement above): a linear-distance
// measurer, an on-site material tally counter, a concrete volume
// calculator, and a material order form.
// ---------------------------------------------------------------------------

// A single drawn run (e.g. one gutter length) within a named measurement
// set - no independent lifecycle of its own, see the migration's comment.
export interface LinearMeasurementSegment {
  id: string;
  label: string;
  coordinates: Coordinate[];
  length_meters: number;
}

export interface JobLinearMeasurement {
  id: string;
  tenant_id: string;
  job_card_id: string;
  title: string;
  segments: LinearMeasurementSegment[];
  total_length_meters: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialTallyItem {
  id: string;
  name: string;
  count: number;
  category: string;
}

export interface JobMaterialTally {
  id: string;
  tenant_id: string;
  job_card_id: string;
  tally_name: string | null;
  items: MaterialTallyItem[];
  saved_to_notes: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// No updated_at - a recalculation is a new row, not an edit-in-place, see
// the migration's own comment.
export interface JobConcreteCalculation {
  id: string;
  tenant_id: string;
  job_card_id: string;
  calculation_name: string;
  length_meters: number;
  width_meters: number;
  depth_meters: number;
  waste_percentage: number;
  total_cubic_meters: number;
  estimated_bags_20kg: number;
  created_by: string | null;
  created_at: string;
}

export type MaterialOrderStatus = "DRAFT" | "ORDERED" | "DELIVERED" | "CANCELLED";

export interface MaterialOrderLineItem {
  item_name: string;
  quantity: number;
  unit_type: string;
  notes: string;
}

export interface JobMaterialOrder {
  id: string;
  tenant_id: string;
  job_card_id: string;
  // Server-assigned on insert ("MAT-001", "MAT-002", ...) - see the
  // migration's assign_material_order_number trigger.
  order_number: string;
  supplier_name: string | null;
  delivery_date: string | null;
  line_items: MaterialOrderLineItem[];
  status: MaterialOrderStatus;
  // Populated only if/when a real PDF-generation-and-storage pipeline is
  // wired up for material orders - see the migration's own comment on why
  // that's out of scope for now (desktop's PDF "export" elsewhere is a
  // browser print dialog, not a stored file).
  pdf_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Mirrors supabase/migrations/20260804000100_communication_engine.sql.
export type CommunicationDelayUnit = "hours" | "days";
export type CommunicationDelayDirection = "before" | "after";
// "both" is only valid on a CommunicationRule (send via whichever channel
// has an active template); a rendered/scheduled message is always exactly
// one of "sms" | "email" - see CommunicationMessageChannel below.
export type CommunicationChannel = "sms" | "email" | "both";
export type CommunicationMessageChannel = "sms" | "email";
export type CommunicationTemplateCategory = "quote" | "invoice" | "booking" | "field";
export type ScheduledCommunicationEntityType =
  | "quote"
  | "invoice"
  | "job"
  | "calendar_event"
  | "client"
  | "property_asset"
  | "referral_partner"
  | "report"
  | "purchase_order"
  | "subcontractor"
  | "client_membership";
export type ScheduledCommunicationStatus = "pending" | "sent" | "cancelled" | "failed";

// One row per seeded trigger_key (quote_stage_1, quote_stage_2,
// invoice_pre_due, invoice_overdue_1, job_review_request, job_on_the_way) -
// the mobile Automation & Messaging Settings screen edits these in place,
// it doesn't let a tenant define new trigger_keys of their own.
export interface CommunicationRule {
  id: string;
  tenant_id: string;
  trigger_key: string;
  is_enabled: boolean;
  delay_offset_value: number;
  delay_offset_unit: CommunicationDelayUnit;
  delay_direction: CommunicationDelayDirection;
  channel: CommunicationChannel;
  quiet_hours_start: string;
  quiet_hours_end: string;
  created_at: string;
  updated_at: string;
}

export interface CommunicationTemplate {
  id: string;
  tenant_id: string;
  trigger_key: string;
  name: string;
  type: CommunicationMessageChannel;
  category: CommunicationTemplateCategory;
  subject: string | null;
  body: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// content is a base64 data URI (e.g. "data:application/pdf;base64,...")
// exactly like accepted_signature_svg's convention, not raw base64 -
// keeping the MIME type folded into the string itself means Resend's
// `attachments[].content` field (which wants raw base64) needs a small
// strip-the-prefix step at send time (see process-scheduled-comms),
// rather than needing content_type carried as a second field here.
export interface EmailAttachment {
  filename: string;
  content: string;
}

// A single outbound message, auto-scheduled by a Postgres trigger (quote
// sent, invoice sent) or manually inserted from the mobile app ("On The
// Way", review request) - dispatched by the process-scheduled-comms Edge
// Function on its next cron sweep. rendered_subject/rendered_body start as
// a copy of the matching CommunicationTemplate at schedule time and get
// overwritten with the final token-substituted text at send time.
export interface ScheduledCommunication {
  id: string;
  tenant_id: string;
  entity_type: ScheduledCommunicationEntityType;
  entity_id: string;
  trigger_key: string;
  template_id: string | null;
  channel: CommunicationMessageChannel;
  recipient_phone_or_email: string;
  // CC/BCC recipients for email sends - populated by EmailComposeModal
  // (see apps/desktop/src/components/EmailComposeModal.tsx), empty arrays
  // for anything scheduled the older way (automated triggers that never go
  // through the composer).
  cc_emails: string[];
  bcc_emails: string[];
  // Base64-encoded attachments (a quote/invoice PDF, or anything else
  // picked in the composer) - see EmailAttachment.
  attachments: EmailAttachment[];
  rendered_subject: string | null;
  rendered_body: string;
  scheduled_for: string;
  status: ScheduledCommunicationStatus;
  sent_at: string | null;
  cancellation_reason: string | null;
  failure_reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// B2B Partner & Referral Tracking module - mirrors the
// b2b_referral_tracking migration.
// ---------------------------------------------------------------------------

export type ReferralGroupType = "bni_chapter" | "networking_group" | "trade_association" | "corporate_network";
export type ReferralPartnerType =
  | "bni_member"
  | "real_estate_agent"
  | "builder_contractor"
  | "architect"
  | "insurance_adjuster"
  | "existing_client"
  | "other_b2b";
export type ReferralPartnerTier = "bronze" | "silver" | "gold" | "vip";
export type ReferralRewardType = "none" | "commission_percent" | "flat_fee" | "gift_card";
export type ReferralPartnerStatus = "active" | "inactive";

export interface ReferralGroup {
  id: string;
  tenant_id: string;
  name: string;
  group_type: ReferralGroupType;
  meeting_day: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReferralPartner {
  id: string;
  tenant_id: string;
  group_id: string | null;
  company_name: string | null;
  contact_first_name: string;
  contact_last_name: string | null;
  email: string | null;
  mobile: string | null;
  partner_type: ReferralPartnerType;
  tier: ReferralPartnerTier;
  reward_type: ReferralRewardType;
  // reward_percent (e.g. 5.00 for 5%) when reward_type = 'commission_percent';
  // reward_flat_cents for 'flat_fee'/'gift_card' - see the migration's own
  // comment for why the spec's single decimal field was split in two.
  reward_percent: number | null;
  reward_flat_cents: number | null;
  status: ReferralPartnerStatus;
  created_at: string;
  updated_at: string;
}

// A referral passed OUT to a partner (Workflow 4) - the inverse of a
// referral_partner_id on a job/quote, which tracks referrals that came IN.
export interface ReferralReciprocityLog {
  id: string;
  tenant_id: string;
  partner_id: string;
  client_name: string;
  description: string | null;
  estimated_value_cents: number | null;
  date_passed: string;
  created_by: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dynamic Reports & Safety Documentation Engine - mirrors the
// reports_safety_engine migration. See reports.ts for
// ReportStructureSchema/ReportFormData (the jsonb column shapes).
// ---------------------------------------------------------------------------

export interface ReportCategory {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportSubcategory {
  id: string;
  tenant_id: string;
  category_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ReportTemplate {
  id: string;
  tenant_id: string;
  subcategory_id: string;
  title: string;
  description: string | null;
  is_swms: boolean;
  structure_schema: ReportStructureSchema;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type ReportInstanceStatus = "draft" | "completed" | "archived";

export interface ReportGeoLocation {
  lat: number;
  lng: number;
  captured_at: string;
}

export interface ReportInstance {
  id: string;
  tenant_id: string;
  template_id: string;
  job_card_id: string | null;
  client_id: string | null;
  created_by: string | null;
  status: ReportInstanceStatus;
  form_data: ReportFormData;
  geo_location: ReportGeoLocation | null;
  pdf_storage_path: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ReportSignerRole = "technician" | "client" | "sub_contractor" | "site_supervisor";

export interface ReportSignature {
  id: string;
  tenant_id: string;
  report_instance_id: string;
  signer_name: string;
  signer_role: ReportSignerRole;
  signature_svg_data: string;
  signed_at: string;
}

// ---------------------------------------------------------------------------
// Subcontractor Management & Procurement - mirrors the
// subcontractor_management migration.
// ---------------------------------------------------------------------------

export type SubcontractorTrade =
  | "plumber"
  | "roofer"
  | "electrician"
  | "hvac"
  | "painter"
  | "carpenter"
  | "plasterer"
  | "cleaner"
  | "other";

// "compliance_hold" is never set directly by the app - only
// recompute_subcontractor_compliance_status (trigger + the daily
// process-subcontractor-compliance sweep) writes it. See the migration's
// own comment.
export type SubcontractorStatus = "active" | "inactive" | "compliance_hold";

export interface SubcontractorCompany {
  id: string;
  tenant_id: string;
  company_name: string;
  abn: string | null;
  trades: SubcontractorTrade[];
  preference_tier: number;
  payment_terms_days: number;
  status: SubcontractorStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubcontractorContact {
  id: string;
  tenant_id: string;
  subcontractor_id: string;
  first_name: string;
  last_name: string | null;
  role_title: string | null;
  email: string;
  mobile: string | null;
  work_phone: string | null;
  is_primary_contact: boolean;
  created_at: string;
  updated_at: string;
}

export type SubcontractorDocType = "public_liability" | "workers_comp" | "trade_license" | "white_card" | "safety_induction" | "other";

export interface SubcontractorComplianceDoc {
  id: string;
  tenant_id: string;
  subcontractor_id: string;
  doc_type: SubcontractorDocType;
  doc_number: string | null;
  storage_path: string;
  issue_date: string | null;
  expiry_date: string | null;
  is_verified: boolean;
  created_at: string;
  updated_at: string;
}

// draft -> sent -> (quote requests only: quoted) -> accepted -> completed
// -> paid, or cancelled at any point before completed. See the migration's
// own comment for why one table covers both a Quote Request and a real
// Work Order/PO.
export type PurchaseOrderStatus = "draft" | "sent" | "quoted" | "accepted" | "completed" | "paid" | "cancelled";

export interface PurchaseOrderLineItem {
  description: string;
  quantity: number;
  unit_cost_cents: number;
}

export interface PurchaseOrder {
  id: string;
  tenant_id: string;
  po_number: string | null;
  job_card_id: string;
  subcontractor_id: string;
  contact_id: string | null;
  is_quote_request: boolean;
  status: PurchaseOrderStatus;
  line_items: PurchaseOrderLineItem[];
  total_cost_cents: number;
  billed_to_client_cents: number | null;
  access_token: string | null;
  token_expires_at: string | null;
  quoted_at: string | null;
  pdf_storage_path: string | null;
  issued_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Membership Module (Munus) - mirrors membership_plans_and_clients.sql,
// membership_discount_engine.sql, and membership_communications.sql. A
// layer on top of the existing client/job/quote/invoice schema, same shape
// as the Real Estate & Strata module - see those migrations' own header
// comments for the RLS reasoning behind each table.
// ---------------------------------------------------------------------------

export type MembershipStatus = "active" | "past_due" | "cancelled" | "expired";
export type MembershipBenefitType = "annual_roof_inspection" | "annual_plumbing_check";

// One row per tenant for now - is_active is enforced unique per tenant by
// a partial index (see the migration's own comment on how trivial it'd be
// to relax that into multi-tier support later).
export interface MembershipPlan {
  id: string;
  tenant_id: string;
  name: string;
  annual_price_cents: number;
  stripe_price_id: string | null;
  discount_percent: number;
  waive_callout_fee: boolean;
  priority_scheduling: boolean;
  same_day_response: boolean;
  annual_roof_inspections_included: number;
  annual_plumbing_checks_included: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Point-in-time copy of the plan's benefit values at signup, stored on
// client_memberships.benefits_snapshot - see that column's own comment on
// why a later plan change shouldn't retroactively alter an existing
// member's terms mid-period.
export interface MembershipBenefitsSnapshot {
  discount_percent: number;
  waive_callout_fee: boolean;
  priority_scheduling: boolean;
  same_day_response: boolean;
  annual_roof_inspections_included: number;
  annual_plumbing_checks_included: number;
}

export interface ClientMembership {
  id: string;
  tenant_id: string;
  client_id: string;
  membership_plan_id: string;
  status: MembershipStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  price_paid_cents: number;
  benefits_snapshot: MembershipBenefitsSnapshot;
  started_at: string;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

// The unique (client_membership_id, benefit_type, period_start) constraint
// is what actually prevents a client using the same included benefit
// twice in one billing year - see the migration's own comment.
export interface MembershipBenefitUsage {
  id: string;
  tenant_id: string;
  client_membership_id: string;
  benefit_type: MembershipBenefitType;
  job_card_id: string | null;
  period_start: string;
  period_end: string;
  used_at: string;
  created_by: string | null;
}

// ---------------------------------------------------------------------------
// Cost of Ops module - modelled on the "Cost of Operations Calculator"
// spreadsheet. Every number here is a raw input; the actual COO/labour-cost/
// profitability math is computed live in cost-of-ops.ts, never stored.
// ---------------------------------------------------------------------------

export type CostOfOpsRoleType = "owner" | "field_staff" | "apprentice" | "admin" | "subcontractor";
export type CostOfOpsPayType = "salary" | "hourly";

export interface CostOfOpsSettings {
  id: string;
  tenant_id: string;
  ordinary_hours_per_week: number;
  weekend_days_per_year: number;
  public_holidays_per_year: number;
  annual_leave_days: number;
  sick_days: number;
  rain_shutdown_days: number;
  estimated_efficiency_rate: number;
  target_labour_profit_margin: number;
  // "Actual Charge Rate (ex GST)" on the Profitability tab.
  actual_charge_rate_cents: number;
  materials_avg_monthly_spend_cents: number;
  materials_avg_markup: number;
  contractors_weekly_spend_cents: number;
  contractors_weekly_hours: number;
  vehicles_owned: number;
  vehicle_holding_cost_cents: number;
  buffer_percent: number;
  created_at: string;
  updated_at: string;
}

export interface OperatingExpense {
  id: string;
  tenant_id: string;
  account_name: string;
  monthly_amount_cents: number;
  budget_amount_cents: number | null;
  is_default_category: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface LabourCostEntry {
  id: string;
  tenant_id: string;
  role_type: CostOfOpsRoleType;
  // Link to a real Munus user where one exists; name is used instead for
  // entries without a linked profile (e.g. subcontractors).
  profile_id: string | null;
  name: string | null;
  pay_type: CostOfOpsPayType;
  annual_salary_cents: number | null;
  superannuation_cents: number | null;
  hourly_rate_cents: number | null;
  superannuation_rate: number | null;
  allowance_cents: number | null;
  billable_hours_per_week: number;
  non_billable_hours_per_week: number;
  apprentice_utilisation: number | null;
  subcontractor_charge_out_rate_cents: number | null;
  subcontractor_travel_allow_cents: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
