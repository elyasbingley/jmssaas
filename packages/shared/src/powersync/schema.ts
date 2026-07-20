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
    title: column.text,
    description: column.text,
    status: column.text,
    assigned_technician_id: column.text,
    scheduled_at: column.text,
    completed_at: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { client: ["client_id"], technician: ["assigned_technician_id"] } }
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

// Tracks local download/upload state for job_files attachments (photos).
// See lib/attachments.ts in apps/mobile for the queue that drives this.
const attachments = new AttachmentTable();

export const AppSchema = new Schema({
  profiles,
  clients,
  client_sites,
  job_cards,
  job_notes,
  job_files,
  tasks,
  attachments,
});

export type Database = (typeof AppSchema)["types"];
