// Mirrors supabase/migrations/20260720000100_init_schema.sql.
// Keep in sync by hand for Phase 1; consider `supabase gen types typescript`
// once the schema stabilises.

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
  created_at: string;
}

export interface Profile {
  id: string;
  tenant_id: string;
  role: UserRole;
  full_name: string;
  email: string;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  tenant_id: string;
  name: string;
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
  created_by: string | null;
  created_at: string;
  updated_at: string;
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
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
  access_notes: string | null;
  key_tag_number: string | null;
  created_at: string;
  updated_at: string;
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
}

export interface Quote {
  id: string;
  tenant_id: string;
  client_id: string;
  job_card_id: string | null;
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
  declined_at: string | null;
  decline_reason: string | null;
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
  declined_at: string | null;
  decline_reason: string | null;
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
  created_by: string | null;
  created_at: string;
  updated_at: string;
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

// Mirrors supabase/migrations/20260804000100_communication_engine.sql.
export type CommunicationDelayUnit = "hours" | "days";
export type CommunicationDelayDirection = "before" | "after";
// "both" is only valid on a CommunicationRule (send via whichever channel
// has an active template); a rendered/scheduled message is always exactly
// one of "sms" | "email" - see CommunicationMessageChannel below.
export type CommunicationChannel = "sms" | "email" | "both";
export type CommunicationMessageChannel = "sms" | "email";
export type CommunicationTemplateCategory = "quote" | "invoice" | "booking" | "field";
export type ScheduledCommunicationEntityType = "quote" | "invoice" | "job" | "calendar_event" | "client";
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
  rendered_subject: string | null;
  rendered_body: string;
  scheduled_for: string;
  status: ScheduledCommunicationStatus;
  sent_at: string | null;
  cancellation_reason: string | null;
  failure_reason: string | null;
  created_at: string;
}
