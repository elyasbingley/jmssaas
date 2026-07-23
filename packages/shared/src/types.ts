// Mirrors supabase/migrations/20260720000100_init_schema.sql.
// Keep in sync by hand for Phase 1; consider `supabase gen types typescript`
// once the schema stabilises.

export type UserRole = "admin" | "technician";

export type JobStatus = "new" | "scheduled" | "in_progress" | "completed" | "invoiced";

export type TaskStatus = "todo" | "in_progress" | "done";

export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "expired";

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export type LineItemType = "materials" | "labour" | "markup" | "other";

export type TemplateType = "quote" | "invoice";

export interface Tenant {
  id: string;
  name: string;
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
  created_by: string | null;
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

export interface LineItemInput {
  item_type: LineItemType;
  description: string;
  quantity: number;
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
}

export interface InvoiceLineItem extends LineItemInput {
  id: string;
  tenant_id: string;
  invoice_id: string;
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
