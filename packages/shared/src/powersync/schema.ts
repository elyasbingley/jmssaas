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
    // Company vs individual client + WorkDrive link (see the
    // client_contacts_sites_workdrive migration) - added to the schema
    // late, after the rest of this table, so were previously missing from
    // mobile's offline copy entirely despite existing in Postgres since
    // that migration.
    client_type: column.text,
    company_name: column.text,
    workdrive_url: column.text,
    // See the client_first_last_name migration - name stays the merge of
    // these two, kept in sync server-side by a trigger and client-side by
    // joinClientName so an offline edit shows the right name immediately.
    first_name: column.text,
    last_name: column.text,
    // Read-only from mobile (set server-side by twilio-sms-webhook/
    // twilio-whatsapp-webhook on an inbound STOP, or edited from desktop's
    // Client Detail page) - synced here just so the opted-out badge can
    // show on a client's card without a separate online fetch. select *
    // in sync-rules.yaml already covers this column, no dashboard redeploy
    // needed for it to start flowing through.
    marketing_opt_out: column.integer,
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

// A named person at a client (especially a company client) beyond the
// single name/email/phone on the clients row itself - see the
// client_contacts_sites_workdrive migration. Same tenant-wide read/write
// RLS shape as clients/client_sites, so it joins the same
// tenant_reference_data PowerSync bucket.
const client_contacts = new Table(
  {
    tenant_id: column.text,
    client_id: column.text,
    name: column.text,
    role: column.text,
    email: column.text,
    phone: column.text,
    is_primary: column.integer,
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
    // Link to the job's WorkDrive folder (see the workdrive_links
    // migration) - a plain URL, offline-editable like the rest of this
    // table since sync rules already select * from job_cards.
    workdrive_url: column.text,
    // B2B & Referrals attribution (see the b2b_referral_tracking
    // migration) - null/0 for a job with no referral source.
    // referral_fee_amount_cents is computed server-side by a Postgres
    // trigger when the linked invoice is marked paid, not something this
    // device ever writes; referral_fee_paid is a manual admin toggle.
    referral_partner_id: column.text,
    // Where the job came from (lead_sources migration). Sync rules already
    // select * from job_cards, so this just exposes the synced column to
    // the phone's job card. lead_sources itself isn't synced - the picker
    // loads it from Supabase while online.
    lead_source_id: column.text,
    referral_fee_paid: column.integer,
    referral_fee_amount_cents: column.integer,
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
    image_url: column.text,
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
    // Google Business Profile posting (gbp_posts migration): "OK for
    // marketing" (0/1), where its stripped public copy is in the marketing
    // bucket, and the Google post it was used in. Set through
    // set_job_file_marketing(), not written locally.
    marketing_ok: column.integer,
    marketing_path: column.text,
    used_in_post_id: column.text,
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

// Leak Check Checklist - templates are admin-managed, tenant-wide read
// setup data like communication_templates above (a technician needs the
// list offline to start a checklist with no reception, even though only an
// admin can author one); job_leak_checks (+ categories/items/item_files)
// are job-scoped field data like job_measurements above, offline-editable
// the same way. is_archived is boolean-shaped (0/1), see connector.ts's
// BOOLEAN_COLUMNS_BY_TABLE. See the leak_check_checklist migration.
const leak_check_templates = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    description: column.text,
    is_archived: column.integer,
    sort_order: column.integer,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const leak_check_template_categories = new Table(
  {
    tenant_id: column.text,
    template_id: column.text,
    name: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { template: ["template_id"] } }
);

const leak_check_template_items = new Table(
  {
    tenant_id: column.text,
    template_id: column.text,
    category_id: column.text,
    item_type: column.text,
    label: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { template: ["template_id"], category: ["category_id"] } }
);

const job_leak_checks = new Table(
  {
    tenant_id: column.text,
    job_card_id: column.text,
    template_id: column.text,
    title: column.text,
    status: column.text,
    // share_token/shared_at are omitted from the local schema - generated
    // server-side on demand by a dedicated RPC (see the migration's own
    // comment), never set or read from a device.
    completed_at: column.text,
    completed_by: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { job: ["job_card_id"] } }
);

const job_leak_check_categories = new Table(
  {
    tenant_id: column.text,
    leak_check_id: column.text,
    job_card_id: column.text,
    name: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { leak_check: ["leak_check_id"], job: ["job_card_id"] } }
);

const job_leak_check_items = new Table(
  {
    tenant_id: column.text,
    leak_check_id: column.text,
    category_id: column.text,
    job_card_id: column.text,
    item_type: column.text,
    label: column.text,
    result: column.text,
    notes: column.text,
    meter_start_reading: column.real,
    meter_end_reading: column.real,
    meter_wait_minutes: column.real,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { leak_check: ["leak_check_id"], category: ["category_id"], job: ["job_card_id"] } }
);

const job_leak_check_item_files = new Table(
  {
    tenant_id: column.text,
    item_id: column.text,
    job_card_id: column.text,
    storage_path: column.text,
    file_name: column.text,
    mime_type: column.text,
    size_bytes: column.integer,
    uploaded_by: column.text,
    created_at: column.text,
  },
  { indexes: { item: ["item_id"], job: ["job_card_id"] } }
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
    // Asana-style project engine (see the asana_task_engine migration) -
    // section_id is a purely organisational Kanban-column position within
    // project_id, independent of `status` above which still drives
    // completion everywhere it always has.
    project_id: column.text,
    section_id: column.text,
    parent_task_id: column.text,
    priority: column.text,
    is_milestone: column.integer,
    start_date: column.text,
    position_order: column.integer,
    estimated_hours: column.real,
    actual_hours: column.real,
    client_id: column.text,
    property_id: column.text,
    // Eisenhower Matrix (see the eisenhower_matrix migration) - nullable,
    // unlike is_milestone above: null (both axes) means "Unsorted", not
    // "false". SQLite stores NULL as NULL through an integer column same as
    // any other type, so this works the same way TEXT columns above do.
    is_urgent: column.integer,
    is_important: column.integer,
  },
  {
    indexes: {
      job: ["job_card_id"],
      assignee: ["assigned_to"],
      project: ["project_id"],
      section: ["section_id"],
      parent: ["parent_task_id"],
    },
  }
);

// Admin-managed project setup data, tenant-wide read like service_categories/
// job_lifecycle_stages above - see the asana_task_engine migration.
const task_projects = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    description: column.text,
    color_hex: column.text,
    icon: column.text,
    view_type: column.text,
    is_archived: column.integer,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const task_sections = new Table(
  {
    tenant_id: column.text,
    project_id: column.text,
    name: column.text,
    position_order: column.integer,
    created_at: column.text,
  },
  { indexes: { project: ["project_id"] } }
);

// A directed edge - blocking_task_id blocks dependent_task_id.
const task_dependencies = new Table(
  {
    tenant_id: column.text,
    blocking_task_id: column.text,
    dependent_task_id: column.text,
    created_at: column.text,
  },
  { indexes: { blocking: ["blocking_task_id"], dependent: ["dependent_task_id"] } }
);

const task_custom_fields = new Table(
  {
    tenant_id: column.text,
    project_id: column.text,
    name: column.text,
    field_type: column.text,
    // JSON-encoded array of option strings, DROPDOWN fields only - see
    // job_measurements.facets above for the same jsonb-as-text convention.
    options: column.text,
    position_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { project: ["project_id"] } }
);

const task_custom_field_values = new Table(
  {
    tenant_id: column.text,
    task_id: column.text,
    custom_field_id: column.text,
    value_text: column.text,
    value_number: column.real,
    value_date: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { task: ["task_id"], field: ["custom_field_id"] } }
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

// Notes module - offline-capable on mobile only (desktop stays Supabase-
// direct for Notes, like every other desktop screen - see the notes_module
// migration's own comment). note_revisions (history) and the note-files
// storage bucket's actual bytes are deliberately NOT synced here - see
// sync-rules.yaml's note_tenant_data/note_admin_data comment for why.
// is_deleted/value_checkbox are boolean-shaped, stored as 0/1
// (column.integer) like every other flag in this file - see connector.ts's
// BOOLEAN_COLUMNS_BY_TABLE, which this schema's new tables were added to.
// value_list has no PowerSync column type (SQLite text/integer/real only)
// so it's stored as a JSON-stringified array in a text column and parsed
// at the app layer.
const note_notebooks = new Table(
  {
    tenant_id: column.text,
    parent_id: column.text,
    name: column.text,
    sort_order: column.integer,
    visibility: column.text,
    edit_access: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], parent: ["parent_id"] } }
);

const notes = new Table(
  {
    tenant_id: column.text,
    notebook_id: column.text,
    title: column.text,
    body: column.text,
    daily_note_date: column.text,
    visibility: column.text,
    edit_access: column.text,
    revision: column.integer,
    is_deleted: column.integer,
    deleted_at: column.text,
    created_by: column.text,
    updated_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], notebook: ["notebook_id"] } }
);

// Read-only from mobile's perspective - the only writer is the Postgres
// trigger (notes_recompute_links_and_tags), which can't run while offline,
// so a fully-offline device's outgoing-links view only reflects its last
// sync until it reconnects. Synced anyway so backlinks/graph have
// *something* to show offline rather than nothing.
const note_links = new Table(
  {
    tenant_id: column.text,
    source_note_id: column.text,
    target_note_id: column.text,
    target_title: column.text,
    created_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], source: ["source_note_id"], target: ["target_note_id"] } }
);

const note_tags = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    created_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const note_tag_assignments = new Table(
  {
    tenant_id: column.text,
    note_id: column.text,
    tag_id: column.text,
  },
  { indexes: { tenant: ["tenant_id"], note: ["note_id"], tag: ["tag_id"] } }
);

const note_properties = new Table(
  {
    tenant_id: column.text,
    note_id: column.text,
    key: column.text,
    value_type: column.text,
    value_text: column.text,
    value_number: column.real,
    value_checkbox: column.integer,
    value_date: column.text,
    value_list: column.text,
    sort_order: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], note: ["note_id"] } }
);

const note_templates = new Table(
  {
    tenant_id: column.text,
    name: column.text,
    body: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"] } }
);

const note_attachments = new Table(
  {
    tenant_id: column.text,
    note_id: column.text,
    storage_path: column.text,
    filename: column.text,
    content_type: column.text,
    size_bytes: column.integer,
    created_by: column.text,
    created_at: column.text,
  },
  { indexes: { tenant: ["tenant_id"], note: ["note_id"] } }
);

// Timesheets (see the timesheets migration). Synced per person - a device
// only ever holds its own user's entries (the own_timesheets bucket), since
// the mobile app is where time is recorded, not where it is reviewed.
// Written offline: clock on/off and start/stop taps must work with no
// signal. edited_at/edited_by are stamped server-side and only read here.
const timesheetEntryColumns = {
  tenant_id: column.text,
  profile_id: column.text,
  started_at: column.text,
  ended_at: column.text,
  start_latitude: column.real,
  start_longitude: column.real,
  start_accuracy_m: column.real,
  end_latitude: column.real,
  end_longitude: column.real,
  end_accuracy_m: column.real,
  source: column.text,
  note: column.text,
  edited_at: column.text,
  edited_by: column.text,
  created_at: column.text,
  updated_at: column.text,
};

const timesheet_shifts = new Table(timesheetEntryColumns, { indexes: { profile_started: ["profile_id", "started_at"] } });

const timesheet_activities = new Table(
  { ...timesheetEntryColumns, activity_type: column.text, job_card_id: column.text },
  { indexes: { profile_started: ["profile_id", "started_at"], job: ["job_card_id"] } }
);

const timesheet_week_approvals = new Table(
  {
    tenant_id: column.text,
    profile_id: column.text,
    week_start: column.text,
    approved_by: column.text,
    approved_at: column.text,
  },
  { indexes: { profile_week: ["profile_id", "week_start"] } }
);

// Asset register (asset_register migration) - tenant-wide like clients, so
// a tech on any job can see and add to the client's assets offline. JSON
// columns (fields, default_services, default_warranties, attributes) sync
// as text; parse them on read.
const asset_types = new Table({
  tenant_id: column.text,
  name: column.text,
  icon: column.text,
  category: column.text,
  fields: column.text,
  default_services: column.text,
  default_warranties: column.text,
  replace_after_years: column.real,
  lead_days: column.integer,
  sort_order: column.integer,
  is_archived: column.integer,
});

const property_assets = new Table(
  {
    tenant_id: column.text,
    property_id: column.text,
    client_id: column.text,
    site_id: column.text,
    category: column.text,
    asset_type_id: column.text,
    asset_name: column.text,
    attributes: column.text,
    installed_on: column.text,
    install_year: column.integer,
    location: column.text,
    notes: column.text,
    status: column.text,
    removed_on: column.text,
    removed_reason: column.text,
    replaced_by_asset_id: column.text,
    installed_by_job_id: column.text,
    source_line_key: column.text,
    needs_details: column.integer,
    replacement_reminded_at: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { client: ["client_id"], job: ["installed_by_job_id"] } }
);

const asset_warranties = new Table(
  {
    tenant_id: column.text,
    asset_id: column.text,
    kind: column.text,
    label: column.text,
    starts_on: column.text,
    expires_on: column.text,
    notes: column.text,
    created_at: column.text,
  },
  { indexes: { asset: ["asset_id"] } }
);

const asset_services = new Table(
  {
    tenant_id: column.text,
    asset_id: column.text,
    name: column.text,
    interval_months: column.integer,
    last_done_on: column.text,
    next_due_on: column.text,
    notes: column.text,
    created_at: column.text,
  },
  { indexes: { asset: ["asset_id"] } }
);

const asset_service_records = new Table(
  {
    tenant_id: column.text,
    asset_id: column.text,
    service_id: column.text,
    job_card_id: column.text,
    done_on: column.text,
    done_by: column.text,
    note: column.text,
    created_at: column.text,
  },
  { indexes: { asset: ["asset_id"], job: ["job_card_id"] } }
);

const asset_files = new Table(
  {
    tenant_id: column.text,
    asset_id: column.text,
    kind: column.text,
    storage_path: column.text,
    file_name: column.text,
    mime_type: column.text,
    size_bytes: column.integer,
    caption: column.text,
    uploaded_by: column.text,
    created_at: column.text,
  },
  { indexes: { asset: ["asset_id"] } }
);

const asset_warranty_claims = new Table(
  {
    tenant_id: column.text,
    asset_id: column.text,
    warranty_id: column.text,
    job_card_id: column.text,
    lodged_on: column.text,
    claim_with: column.text,
    reference: column.text,
    status: column.text,
    parts_supplied: column.text,
    notes: column.text,
    created_at: column.text,
  },
  { indexes: { asset: ["asset_id"] } }
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
  client_contacts,
  job_cards,
  job_notes,
  job_files,
  job_measurements,
  tasks,
  task_notes,
  task_files,
  task_projects,
  task_sections,
  task_dependencies,
  task_custom_fields,
  task_custom_field_values,
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
  note_notebooks,
  notes,
  note_links,
  note_tags,
  note_tag_assignments,
  note_properties,
  note_templates,
  note_attachments,
  timesheet_shifts,
  timesheet_activities,
  timesheet_week_approvals,
  asset_types,
  property_assets,
  asset_warranties,
  asset_services,
  asset_service_records,
  asset_files,
  asset_warranty_claims,
  attachments,
});

export type Database = (typeof AppSchema)["types"];
