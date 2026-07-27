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
  attachments,
});

export type Database = (typeof AppSchema)["types"];
