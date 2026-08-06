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
    assigned_technician_id: column.text,
    scheduled_at: column.text,
    completed_at: column.text,
    service_category_id: column.text,
    lifecycle_stage_id: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
    // Real Estate & Strata module (see the real_estate_strata and
    // real_estate_nte_and_invoicing migrations) - all null/0 for an
    // ordinary (non-agency) job. nte_variation_token itself isn't synced -
    // it's only ever read/written server-side via the token RPCs, a
    // technician's own device never needs to see it.
    is_real_estate_job: column.integer,
    agency_id: column.text,
    property_manager_id: column.text,
    property_id: column.text,
    work_order_number: column.text,
    nte_limit_cents: column.integer,
    nte_exceeded_approved: column.integer,
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
    maintenance_interval_months: column.integer,
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
    is_closed: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
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

// Inventory's own two-level category hierarchy (Material/Tools/First Aid
// Kit -> Roofing/Plumbing/Tapware, Power Tools/Hand Tools, ...) - see the
// inventory_material_categories migration. This deliberately replaced an
// earlier design that reused price_book_categories/price_book_items for
// inventory: quote/invoice pricing items and physical stock items turned
// out not to be "the same underlying thing" after all, so inventory now
// has its own standalone catalogue instead. price_book_categories/
// price_book_items are back to Supabase-direct/online-only, same as
// before that earlier design - see docs/SETUP.md.
const inventory_categories = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    color: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const inventory_subcategories = new Table(
  {
    tenant_id: column.text,
    category_id: column.text,
    name: column.text,
    color: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], category: ["category_id"] } }
);

// A named supplier ("Bunnings", "Reece") an item is sourced from - flat,
// admin-managed, tenant-wide read like inventory_categories above, no
// hierarchy needed here. See the inventory_suppliers_and_targets migration.
const inventory_suppliers = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

// The actual thing being stocked (e.g. "Silicone tube - clear") -
// subcategory_id is nullable since not every category needs a second
// level (e.g. a "First Aid Kit" category might hold items directly).
// reorder_threshold/ideal_stock/supplier_id are properties of the item
// itself, not of any one location it's stocked at - the same tube of
// silicone alerts/reorders the same way everywhere, see the
// inventory_suppliers_and_targets migration (this is where
// reorder_threshold used to live on inventory_levels before that
// migration moved it here).
const inventory_items = new Table(
  {
    tenant_id: column.text,
    category_id: column.text,
    subcategory_id: column.text,
    supplier_id: column.text,
    name: column.text,
    reorder_threshold: column.integer,
    ideal_stock: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  {
    indexes: {
      tenant: ["tenant_id"],
      category: ["category_id"],
      subcategory: ["subcategory_id"],
      supplier: ["supplier_id"],
    },
  }
);

// The quantity of an inventory_items row held at a given inventory_
// locations row. Unlike the tables above, this is tenant-wide *writable*
// (not admin-only) - the whole point is a technician tapping +/- on their
// truck's stock from the field, same "small crew, everyone edits it" RLS
// shape as clients/job_cards - see the inventory_stock_control migration.
const inventory_levels = new Table(
  {
    tenant_id: column.text,
    location_id: column.text,
    item_id: column.text,
    quantity: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { location: ["location_id"], item: ["item_id"] } }
);

// Per-tenant automation timing settings, one row per seeded trigger_key -
// admin-managed setup data, tenant-wide read like service_categories/
// job_lifecycle_stages above. See the communication_engine migration.
const communication_rules = new Table(
  {
    tenant_id: column.text,
    trigger_key: column.text,
    is_enabled: column.integer,
    delay_offset_value: column.integer,
    delay_offset_unit: column.text,
    delay_direction: column.text,
    channel: column.text,
    quiet_hours_start: column.text,
    quiet_hours_end: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const communication_templates = new Table(
  {
    tenant_id: column.text,
    trigger_key: column.text,
    name: column.text,
    type: column.text,
    category: column.text,
    subject: column.text,
    body: column.text,
    is_active: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], trigger: ["trigger_key"] } }
);

// The outbound message log - unlike the two tables above, this is
// tenant-wide *writable* (not admin-only), same "small crew, everyone logs
// it" shape as clients/inventory_levels: a technician's "On The Way" tap or
// a Postgres trigger firing on quote/invoice send both insert rows here for
// the cron dispatcher to pick up. See the communication_engine migration.
const scheduled_communications = new Table(
  {
    tenant_id: column.text,
    entity_type: column.text,
    entity_id: column.text,
    trigger_key: column.text,
    template_id: column.text,
    channel: column.text,
    recipient_phone_or_email: column.text,
    rendered_subject: column.text,
    rendered_body: column.text,
    scheduled_for: column.text,
    status: column.text,
    sent_at: column.text,
    cancellation_reason: column.text,
    failure_reason: column.text,
    created_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], entity: ["entity_type", "entity_id"] } }
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

// A saved roof measurement - job-scoped field data like job_notes/
// job_files above, so it's offline-capable the same way (a technician
// drawing/saving a measurement with no reception). `facets` is the
// jsonb array from Postgres, round-tripped as a JSON string locally
// (PowerSync's SQLite columns are TEXT/INTEGER/REAL only, no native JSON
// type) - see the roof_measurements migration and Facet in types.ts for
// the shape encoded inside it.
const job_measurements = new Table(
  {
    tenant_id: column.text,
    job_card_id: column.text,
    title: column.text,
    facets: column.text,
    total_flat_area_sqm: column.real,
    total_true_area_sqm: column.real,
    snapshot_path: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
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
  job_measurements,
  tasks,
  task_notes,
  task_files,
  service_categories,
  job_lifecycle_stages,
  inventory_locations,
  inventory_categories,
  inventory_subcategories,
  inventory_suppliers,
  inventory_items,
  inventory_levels,
  communication_rules,
  communication_templates,
  scheduled_communications,
  attachments,
});

export type Database = (typeof AppSchema)["types"];
