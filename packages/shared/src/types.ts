// Mirrors supabase/migrations/20260720000100_init_schema.sql.
// Keep in sync by hand for Phase 1; consider `supabase gen types typescript`
// once the schema stabilises.

export type UserRole = "admin" | "technician";

export type JobStatus = "new" | "scheduled" | "in_progress" | "completed" | "invoiced";

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
  status: JobStatus;
  assigned_technician_id: string | null;
  quote_id: string | null;
  invoice_id: string | null;
  scheduled_at: string | null;
  completed_at: string | null;
  // Admin-customizable tag/pipeline, independent of `status` above - see
  // ServiceCategory/JobLifecycleStage and the job_categories_lifecycle_stages
  // migration for why the two aren't kept in sync with each other.
  service_category_id: string | null;
  lifecycle_stage_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// A simple tag on a job (e.g. "Roof Restoration", "Gutter Cleaning") -
// admin-managed, tenant-wide, purely descriptive (no behavior keys off it).
export interface ServiceCategory {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

// An admin-configurable, ordered pipeline (e.g. "Enquiry" / "Quote Sent" /
// "Deposit Paid" / "In Progress") - distinct from the fixed JobStatus enum
// above, which several other features already key off (Schedule board,
// Job Costing, status chips) and isn't being replaced by this.
export interface JobLifecycleStage {
  id: string;
  tenant_id: string;
  name: string;
  position: number;
  color: string | null;
  is_system_default: boolean;
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

// The actual thing being stocked - "Silicone tube - clear", "Cordless
// drill". Its own standalone catalogue, unrelated to PriceBookItem (see
// the inventory_material_categories migration for why those two turned
// out not to be the same thing).
export interface InventoryItem {
  id: string;
  tenant_id: string;
  category_id: string;
  subcategory_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

// The quantity of an InventoryItem held at a given InventoryLocation.
// Unlike InventoryLocation/InventoryCategory/InventorySubcategory/
// InventoryItem, this is tenant-wide *writable* - see the
// inventory_stock_control migration's RLS comment.
export interface InventoryLevel {
  id: string;
  tenant_id: string;
  location_id: string;
  item_id: string;
  quantity: number;
  reorder_threshold: number;
  created_at: string;
  updated_at: string;
}

// Not its own table - an InventoryLevel joined with its item/location/
// category/subcategory names for display in the Low-Stock queue and the
// shopping list PDF. Built client-side (see the inventory screen's join
// over the PowerSync-local tables), not a server view.
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
  quantity: number;
  reorder_threshold: number;
}
