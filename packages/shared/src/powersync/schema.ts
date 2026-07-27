import { AttachmentTable, column, Schema, Table } from "@powersync/common";

// Offline-capable tables only. Per Phase 1 scope, offline read/edit is
// required for client cards, job cards (+ notes/files) and tasks - not for
// quotes, invoices, templates or calendar events, which are office/PC-side
// workflows fetched directly from Supabase when online. Booleans and
// timestamps are stored as PowerSync's supported SQLite types (INTEGER /
// TEXT) and mapped back to richer types in the app layer.

const profiles = new Table({
  tenant_id: column.text,
  role: column.text,
  full_name: column.text,
  email: column.text,
  phone: column.text,
});

const clients = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    email: column.text,
    phone: column.text,
    notes: column.text,
    address_line1: column.text,
    address_line2: column.text,
    suburb: column.text,
    state: column.text,
    postcode: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const client_sites = new Table(
  {
    tenant_id: column.text,
    client_id: column.text,
    label: column.text,
    address_line1: column.text,
    address_line2: column.text,
    suburb: column.text,
    state: column.text,
    postcode: column.text,
    is_primary: column.integer,
    notes: column.text,
    created_at: column.text,
  },
  { indexes: { client: ["client_id"] } }
);

const job_cards = new Table(
  {
    tenant_id: column.text,
    client_id: column.text,
    site_id: column.text,
    // Assigned server-side on insert (see the ux_overhaul migration) - null
    // locally until this row round-trips through a sync after creation.
    number: column.text,
    title: column.text,
    description: column.text,
    status: column.text,
    assigned_technician_id: column.text,
    scheduled_at: column.text,
    completed_at: column.text,
    service_category_id: column.text,
    lifecycle_stage_id: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { client: ["client_id"], technician: ["assigned_technician_id"] } }
);

// Admin-configurable job tagging/pipeline, synced tenant-wide (read by
// everyone so job rows can show category tags/stage badges offline; writes
// are admin-only, enforced server-side by RLS - see the
// job_categories_lifecycle_stages migration).
const service_categories = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    color: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const job_lifecycle_stages = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    position: column.integer,
    color: column.text,
    is_system_default: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

// price_book_categories/price_book_items were previously Supabase-direct,
// online-only (admin-managed catalogue data for building quotes/invoices,
// which is itself an online-only workflow - see docs/SETUP.md's price book
// section). The inventory_stock_control migration adds them here too,
// synced tenant-wide, purely because inventory needs them: a technician
// adjusting stock from their ute with no reception still needs to see the
// item's name, not just a bare item_id, so "seamlessly offline" for
// inventory transitively requires the catalogue itself to be offline-
// readable. RLS already made these tenant-wide readable (not admin-only)
// before this, so nothing new is exposed by syncing them - see the price
// book RLS comment in the price_book migration. Existing Price Book admin
// screens keep using their direct Supabase fetch unchanged; this is an
// additive local read path, not a replacement.
const price_book_categories = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const price_book_items = new Table(
  {
    tenant_id: column.text,
    category_id: column.text,
    description: column.text,
    labour_rate_cents: column.integer,
    labour_hours: column.real,
    material_cost_cents: column.integer,
    markup_percent: column.real,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { category: ["category_id"] } }
);

// A physical place stock lives (a ute, the main warehouse, a shelf) -
// admin-managed setup data, tenant-wide read like service_categories/
// job_lifecycle_stages above.
const inventory_locations = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    type: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

// The quantity of a price_book_items row held at a given inventory_
// locations row. Unlike the two tables above, this is tenant-wide
// *writable* (not admin-only) - the whole point is a technician tapping
// +/- on their truck's stock from the field, same "small crew, everyone
// edits it" RLS shape as clients/job_cards - see the
// inventory_stock_control migration.
const inventory_levels = new Table(
  {
    tenant_id: column.text,
    location_id: column.text,
    item_id: column.text,
    quantity: column.integer,
    reorder_threshold: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { location: ["location_id"], item: ["item_id"] } }
);

const job_notes = new Table(
  {
    tenant_id: column.text,
    job_card_id: column.text,
    author_id: column.text,
    body: column.text,
    created_at: column.text,
  },
  { indexes: { job: ["job_card_id"] } }
);

const job_files = new Table(
  {
    tenant_id: column.text,
    job_card_id: column.text,
    storage_path: column.text,
    file_name: column.text,
    mime_type: column.text,
    size_bytes: column.integer,
    uploaded_by: column.text,
    created_at: column.text,
  },
  { indexes: { job: ["job_card_id"] } }
);

const tasks = new Table(
  {
    tenant_id: column.text,
    job_card_id: column.text,
    // Assigned server-side on insert - see job_cards.number above.
    number: column.text,
    title: column.text,
    description: column.text,
    status: column.text,
    assigned_to: column.text,
    due_date: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { job: ["job_card_id"], assignee: ["assigned_to"] } }
);

// Notes/files attached to a task - same shape as job_notes/job_files,
// offline-capable so a technician can add a note or photo to a task with no
// reception, same as job cards.
const task_notes = new Table(
  {
    tenant_id: column.text,
    task_id: column.text,
    author_id: column.text,
    body: column.text,
    created_at: column.text,
  },
  { indexes: { task: ["task_id"] } }
);

const task_files = new Table(
  {
    tenant_id: column.text,
    task_id: column.text,
    storage_path: column.text,
    file_name: column.text,
    mime_type: column.text,
    size_bytes: column.integer,
    uploaded_by: column.text,
    created_at: column.text,
  },
  { indexes: { task: ["task_id"] } }
);

// Tracks local download/upload state for job_files/task_files attachments
// (photos). See lib/attachments.ts in apps/mobile for the queue that drives
// this - one AttachmentTable is shared by both, since PowerSync's queue is
// keyed by attachment id, not by which parent table it belongs to.
const attachments = new AttachmentTable();

export const AppSchema = new Schema({
  profiles,
  clients,
  client_sites,
  job_cards,
  job_notes,
  job_files,
  tasks,
  task_notes,
  task_files,
  service_categories,
  job_lifecycle_stages,
  price_book_categories,
  price_book_items,
  inventory_locations,
  inventory_levels,
  attachments,
});

export type Database = (typeof AppSchema)["types"];
