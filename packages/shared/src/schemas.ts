import { z } from "zod";
import type { ReportFieldType } from "./reports";
import type { SubcontractorDocType, SubcontractorStatus, SubcontractorTrade } from "./types";

export const createClientSchema = z.object({
  // "Individual" (regular COD homeowner): `name` is their own full name.
  // "Company": `name` is the primary contact person, company_name is the
  // company's own name (required in that case - see the refine below) -
  // this is what stops a company client ever being saved with just a
  // person's name and no company name, or vice versa.
  client_type: z.enum(["individual", "company"]).default("individual"),
  company_name: z.string().optional(),
  name: z.string().min(1, "Name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  suburb: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  workdrive_url: z.string().optional(),
}).refine((data) => data.client_type !== "company" || !!data.company_name?.trim(), {
  message: "Company name is required for a company client",
  path: ["company_name"],
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const createClientContactSchema = z.object({
  client_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  role: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  is_primary: z.boolean().default(false),
});
export type CreateClientContactInput = z.infer<typeof createClientContactSchema>;

export const createClientSiteSchema = z.object({
  client_id: z.string().uuid(),
  label: z.string().optional(),
  address_line1: z.string().min(1, "Address is required"),
  address_line2: z.string().optional(),
  suburb: z.string().min(1, "Suburb is required"),
  state: z.string().min(1, "State is required"),
  postcode: z.string().regex(/^\d{4}$/, "Enter a 4-digit postcode"),
  is_primary: z.boolean().default(false),
  notes: z.string().optional(),
});
export type CreateClientSiteInput = z.infer<typeof createClientSiteSchema>;

export const jobStatusSchema = z.enum(["new", "scheduled", "in_progress", "completed", "invoiced"]);

export const createJobCardSchema = z.object({
  client_id: z.string().uuid(),
  site_id: z.string().uuid().optional(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  assigned_technician_id: z.string().uuid().optional(),
  scheduled_at: z.string().datetime().optional(),
  service_category_id: z.string().uuid().optional(),
  lifecycle_stage_id: z.string().uuid().optional(),
  // Real Estate & Strata module (see the real_estate_nte_and_invoicing
  // migration) - all optional, same as the category/stage fields above;
  // an ordinary (non-agency) job never sets any of these.
  is_real_estate_job: z.boolean().optional(),
  agency_id: z.string().uuid().optional(),
  property_manager_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  work_order_number: z.string().optional(),
  nte_limit_cents: z.number().int().positive().optional(),
  // B2B & Referral Tracking module (see the b2b_referral_tracking
  // migration) - which partner sent this job, if any.
  referral_partner_id: z.string().uuid().optional(),
});
export type CreateJobCardInput = z.infer<typeof createJobCardSchema>;

// Retrofits an EXISTING job (and, transitively, any quote/invoice already
// linked to it - they read these same job_cards columns live via a join,
// see InvoiceDetail.tsx's fetchInvoice) with real-estate/strata agency
// assignment - the "New job" form's is_real_estate_job/agency_id/etc.
// fields were previously only ever settable once, at creation. Same field
// set as createJobCardSchema's real-estate slice, just standalone since
// this is a full update (not a create) and is_real_estate_job is
// required rather than optional here - the control always sends an
// explicit true/false, never omits it.
export const updateJobRealEstateAssignmentSchema = z.object({
  is_real_estate_job: z.boolean(),
  agency_id: z.string().uuid().optional().or(z.literal("")),
  property_manager_id: z.string().uuid().optional().or(z.literal("")),
  property_id: z.string().uuid().optional().or(z.literal("")),
  work_order_number: z.string().optional(),
  nte_limit_cents: z.number().int().positive().optional(),
});
export type UpdateJobRealEstateAssignmentInput = z.infer<typeof updateJobRealEstateAssignmentSchema>;

export const createJobNoteSchema = z.object({
  job_card_id: z.string().uuid(),
  body: z.string().min(1, "Note can't be empty"),
});
export type CreateJobNoteInput = z.infer<typeof createJobNoteSchema>;

export const createTaskNoteSchema = z.object({
  task_id: z.string().uuid(),
  body: z.string().min(1, "Note can't be empty"),
});
export type CreateTaskNoteInput = z.infer<typeof createTaskNoteSchema>;

export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  job_card_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  due_date: z.string().date().optional(),
  // Asana-style project engine (see the asana_task_engine migration).
  project_id: z.string().uuid().optional(),
  section_id: z.string().uuid().optional(),
  parent_task_id: z.string().uuid().optional(),
  priority: taskPrioritySchema.default("medium"),
  is_milestone: z.boolean().default(false),
  start_date: z.string().date().optional(),
  estimated_hours: z.number().nonnegative().optional(),
  actual_hours: z.number().nonnegative().optional(),
  client_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ---------------------------------------------------------------------------
// Asana-style project management engine
// ---------------------------------------------------------------------------

export const taskProjectViewTypeSchema = z.enum(["BOARD", "LIST", "CALENDAR", "TIMELINE"]);

export const createTaskProjectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  color_hex: z.string().default("#3B82F6"),
  icon: z.string().default("folder"),
  view_type: taskProjectViewTypeSchema.default("BOARD"),
});
export type CreateTaskProjectInput = z.infer<typeof createTaskProjectSchema>;

export const createTaskSectionSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  position_order: z.number().int().default(0),
});
export type CreateTaskSectionInput = z.infer<typeof createTaskSectionSchema>;

export const createTaskDependencySchema = z.object({
  blocking_task_id: z.string().uuid(),
  dependent_task_id: z.string().uuid(),
}).refine((data) => data.blocking_task_id !== data.dependent_task_id, {
  message: "A task can't depend on itself",
  path: ["dependent_task_id"],
});
export type CreateTaskDependencyInput = z.infer<typeof createTaskDependencySchema>;

export const taskCustomFieldTypeSchema = z.enum(["text", "number", "dropdown", "date"]);

export const createTaskCustomFieldSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  field_type: taskCustomFieldTypeSchema.default("text"),
  // DROPDOWN fields only - ignored for every other field_type.
  options: z.array(z.string().min(1)).optional(),
  position_order: z.number().int().default(0),
});
export type CreateTaskCustomFieldInput = z.infer<typeof createTaskCustomFieldSchema>;

// Only the one field matching the parent custom field's own field_type is
// meant to be set - the UI picks which, this schema just accepts whichever
// arrives.
export const setTaskCustomFieldValueSchema = z.object({
  task_id: z.string().uuid(),
  custom_field_id: z.string().uuid(),
  value_text: z.string().optional(),
  value_number: z.number().optional(),
  value_date: z.string().date().optional(),
});
export type SetTaskCustomFieldValueInput = z.infer<typeof setTaskCustomFieldValueSchema>;

// Shared by a line item, a price book item, and a price book item variation
// - all three price the same underlying thing (labour rate/hours, material
// cost, markup%), just at different points in the pipeline (catalogue entry
// vs. a specific quote/invoice line).
export const priceBreakdownSchema = z.object({
  labour_rate_cents: z.number().int().nonnegative().default(0),
  labour_hours: z.number().nonnegative().default(0),
  material_cost_cents: z.number().int().nonnegative().default(0),
  markup_percent: z.number().nonnegative().default(0),
});

export const lineItemSchema = priceBreakdownSchema.extend({
  description: z.string().min(1),
  quantity: z.number().positive(),
  // Derived from the breakdown fields above (see money.ts's
  // computeLineItemUnitPriceCents) - not directly user-entered, but still
  // validated here since it's what actually gets persisted and fed into
  // calculate_line_item_totals.
  unit_price_cents: z.number().int().nonnegative(),
  gst_applicable: z.boolean().default(true),
  sort_order: z.number().int().default(0),
  // Copied from the source price_book_items row when a line is added from
  // the catalogue (see AddLineItemBar) - not user-editable per line, just
  // carried through so replace_quote_line_items/replace_invoice_line_items
  // know which lines a membership's call-out-fee waiver can apply to.
  is_callout_fee: z.boolean().default(false),
  // Always server-derived (apply_membership_adjustments) - never actually
  // submitted as a meaningful value by the client, but needed on the type so
  // a persisted line item fetched back from quote_line_items/
  // invoice_line_items can be read and displayed (see LineItemEditor's
  // "Waived - Membership" label).
  waived_amount_cents: z.number().int().nonnegative().default(0),
});
export type LineItemFormInput = z.infer<typeof lineItemSchema>;

export const createPriceBookCategorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  sort_order: z.number().int().default(0),
});
export type CreatePriceBookCategoryInput = z.infer<typeof createPriceBookCategorySchema>;

export const createPriceBookItemSchema = priceBreakdownSchema.extend({
  category_id: z.string().uuid(),
  description: z.string().min(1, "Description is required"),
  sort_order: z.number().int().default(0),
  // Flags this catalogue item as the tenant's call-out/service fee, so a
  // membership plan's waive_callout_fee benefit knows which line item to
  // waive once it's added to a quote/invoice (see AddLineItemBar).
  is_callout_fee: z.boolean().default(false),
});
export type CreatePriceBookItemInput = z.infer<typeof createPriceBookItemSchema>;

export const createPriceBookVariationSchema = priceBreakdownSchema.extend({
  price_book_item_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  sort_order: z.number().int().default(0),
});
export type CreatePriceBookVariationInput = z.infer<typeof createPriceBookVariationSchema>;

export const createQuoteSchema = z.object({
  client_id: z.string().uuid(),
  job_card_id: z.string().uuid().optional(),
  template_id: z.string().uuid().optional(),
  // Not user-entered - assigned by a Postgres trigger on insert (QT001,
  // QT002, ...). See the ux_overhaul migration.
  expiry_date: z.string().date().optional(),
  notes: z.string().optional(),
  line_items: z.array(lineItemSchema).min(1, "Add at least one line item"),
  referral_partner_id: z.string().uuid().optional(),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const createInvoiceSchema = z.object({
  client_id: z.string().uuid(),
  job_card_id: z.string().uuid().optional(),
  quote_id: z.string().uuid().optional(),
  // Not user-entered - assigned by a Postgres trigger on insert (INV001,
  // INV002, ...). See the ux_overhaul migration.
  due_date: z.string().date().optional(),
  notes: z.string().optional(),
  line_items: z.array(lineItemSchema).min(1, "Add at least one line item"),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateCompanySettingsSchema = z.object({
  name: z.string().min(1, "Company name is required"),
  abn: z.string().optional(),
  email: z.string().email("Enter a valid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  website: z.string().optional(),
  business_address_line1: z.string().optional(),
  business_address_line2: z.string().optional(),
  business_suburb: z.string().optional(),
  business_state: z.string().optional(),
  business_postcode: z.string().optional(),
  license_number: z.string().optional(),
  bank_account_name: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_bsb: z.string().optional(),
  xero_sales_account_code: z.string().optional(),
});
export type UpdateCompanySettingsInput = z.infer<typeof updateCompanySettingsSchema>;

export const recurrenceRuleSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(365),
  byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
  endType: z.enum(["never", "on", "after"]),
  endDate: z.string().optional(),
  count: z.number().int().min(1).max(500).optional(),
});

export const createCalendarEventSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  location: z.string().optional(),
  guests: z.string().optional(),
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  all_day: z.boolean().default(false),
  job_card_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  recurrence_rule: recurrenceRuleSchema.optional(),
});
export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;

// Client-side validation before calling the create-technician Edge
// Function (see supabase/functions/create-technician) - the function does
// its own minimal validation server-side too, this just gives the admin
// immediate feedback instead of a round trip for an obviously-empty field.
export const createTechnicianSchema = z.object({
  full_name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type CreateTechnicianInput = z.infer<typeof createTechnicianSchema>;

export const createServiceCategorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  color: z.string().optional(),
  maintenance_interval_months: z.number().int().positive().optional(),
});
export type CreateServiceCategoryInput = z.infer<typeof createServiceCategorySchema>;

export const createJobLifecycleStageSchema = z.object({
  name: z.string().min(1, "Name is required"),
  position: z.number().int().default(0),
  color: z.string().optional(),
  is_closed: z.boolean().optional().default(false),
});
export type CreateJobLifecycleStageInput = z.infer<typeof createJobLifecycleStageSchema>;

export const createInventoryLocationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.string().optional(),
});
export type CreateInventoryLocationInput = z.infer<typeof createInventoryLocationSchema>;

export const createInventoryCategorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  color: z.string().optional(),
  sort_order: z.number().int().default(0),
});
export type CreateInventoryCategoryInput = z.infer<typeof createInventoryCategorySchema>;

export const createInventorySubcategorySchema = z.object({
  category_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  color: z.string().optional(),
  sort_order: z.number().int().default(0),
});
export type CreateInventorySubcategoryInput = z.infer<typeof createInventorySubcategorySchema>;

export const createInventorySupplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
});
export type CreateInventorySupplierInput = z.infer<typeof createInventorySupplierSchema>;

export const createInventoryItemSchema = z.object({
  category_id: z.string().uuid(),
  subcategory_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  name: z.string().min(1, "Name is required"),
  // The quantity at a location that triggers the Low-Stock queue.
  reorder_threshold: z.number().int().nonnegative().default(5),
  // The target quantity a reorder should bring a location back up to.
  ideal_stock: z.number().int().nonnegative().default(10),
});
export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;

export const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type CoordinateInput = z.infer<typeof coordinateSchema>;

// 0-60° matches the measurement screen's stepper range - covers everything
// from a flat roof up to a genuinely steep pitch; anything beyond that is
// rare enough on a house that it wasn't worth extending the UI for.
export const facetSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Name is required"),
  pitch_degrees: z.number().min(0).max(60),
  flat_area_sqm: z.number().nonnegative(),
  true_area_sqm: z.number().nonnegative(),
  coordinates: z.array(coordinateSchema).min(3, "A facet needs at least 3 points"),
});
export type FacetInput = z.infer<typeof facetSchema>;

export const createJobMeasurementSchema = z.object({
  job_card_id: z.string().uuid(),
  title: z.string().min(1, "Title is required").default("Roof Measurement"),
  facets: z.array(facetSchema).min(1, "Add at least one facet"),
  total_flat_area_sqm: z.number().nonnegative(),
  total_true_area_sqm: z.number().nonnegative(),
  snapshot_path: z.string().optional(),
});
export type CreateJobMeasurementInput = z.infer<typeof createJobMeasurementSchema>;

// ---------------------------------------------------------------------------
// Job Card Quote Tools
// ---------------------------------------------------------------------------

export const linearMeasurementSegmentSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1, "Label is required"),
  coordinates: z.array(coordinateSchema).min(2, "A run needs at least 2 points"),
  length_meters: z.number().nonnegative(),
});
export type LinearMeasurementSegmentInput = z.infer<typeof linearMeasurementSegmentSchema>;

export const createJobLinearMeasurementSchema = z.object({
  job_card_id: z.string().uuid(),
  title: z.string().min(1, "Title is required"),
  segments: z.array(linearMeasurementSegmentSchema).min(1, "Add at least one run"),
  total_length_meters: z.number().nonnegative(),
});
export type CreateJobLinearMeasurementInput = z.infer<typeof createJobLinearMeasurementSchema>;

export const materialTallyItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, "Name is required"),
  count: z.number().int().nonnegative(),
  category: z.string().default(""),
});
export type MaterialTallyItemInput = z.infer<typeof materialTallyItemSchema>;

export const createJobMaterialTallySchema = z.object({
  job_card_id: z.string().uuid(),
  tally_name: z.string().optional(),
  items: z.array(materialTallyItemSchema).min(1, "Add at least one item"),
});
export type CreateJobMaterialTallyInput = z.infer<typeof createJobMaterialTallySchema>;

// total_cubic_meters/estimated_bags_20kg are derived from the other
// fields (see money.ts-style computeLineItemUnitPriceCents precedent) but
// still validated here since they're what actually gets persisted.
export const createJobConcreteCalculationSchema = z.object({
  job_card_id: z.string().uuid(),
  calculation_name: z.string().min(1, "Name is required"),
  length_meters: z.number().positive(),
  width_meters: z.number().positive(),
  depth_meters: z.number().positive(),
  waste_percentage: z.number().nonnegative().default(10),
  total_cubic_meters: z.number().nonnegative(),
  estimated_bags_20kg: z.number().int().nonnegative(),
});
export type CreateJobConcreteCalculationInput = z.infer<typeof createJobConcreteCalculationSchema>;

export const materialOrderStatusSchema = z.enum(["DRAFT", "ORDERED", "DELIVERED", "CANCELLED"]);

export const materialOrderLineItemSchema = z.object({
  item_name: z.string().min(1, "Item name is required"),
  quantity: z.number().positive(),
  unit_type: z.string().default("ea"),
  notes: z.string().default(""),
});
export type MaterialOrderLineItemInput = z.infer<typeof materialOrderLineItemSchema>;

// order_number is deliberately absent - server-assigned on insert (see
// the migration's assign_material_order_number trigger), same as
// quote_number/invoice_number.
export const createJobMaterialOrderSchema = z.object({
  job_card_id: z.string().uuid(),
  supplier_name: z.string().optional(),
  delivery_date: z.string().date().optional(),
  line_items: z.array(materialOrderLineItemSchema).min(1, "Add at least one line item"),
  status: materialOrderStatusSchema.default("DRAFT"),
});
export type CreateJobMaterialOrderInput = z.infer<typeof createJobMaterialOrderSchema>;

export const communicationDelayUnitSchema = z.enum(["hours", "days"]);
export const communicationDelayDirectionSchema = z.enum(["before", "after"]);
export const communicationChannelSchema = z.enum(["sms", "email", "both"]);
export const communicationMessageChannelSchema = z.enum(["sms", "email"]);
export const communicationTemplateCategorySchema = z.enum(["quote", "invoice", "booking", "field", "partner"]);
export const scheduledCommunicationEntityTypeSchema = z.enum([
  "quote",
  "invoice",
  "job",
  "calendar_event",
  "client",
  "property_asset",
  "referral_partner",
  "report",
  "purchase_order",
  "subcontractor",
  "client_membership",
]);

// HH:MM or HH:MM:SS - matches the <input type="time">-style pickers used by
// the quiet hours fields on the Automation & Messaging Settings screen.
const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Enter a time as HH:MM");

export const updateCommunicationRuleSchema = z.object({
  is_enabled: z.boolean(),
  delay_offset_value: z.number().int().nonnegative(),
  delay_offset_unit: communicationDelayUnitSchema,
  delay_direction: communicationDelayDirectionSchema,
  channel: communicationChannelSchema,
  quiet_hours_start: timeOfDaySchema,
  quiet_hours_end: timeOfDaySchema,
});
export type UpdateCommunicationRuleInput = z.infer<typeof updateCommunicationRuleSchema>;

export const updateCommunicationTemplateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  subject: z.string().optional(),
  body: z.string().min(1, "Message can't be empty"),
  is_active: z.boolean().default(true),
});
export type UpdateCommunicationTemplateInput = z.infer<typeof updateCommunicationTemplateSchema>;

// Used by the mobile app's own manual/field triggers (the "On The Way"
// button, the post-completion review request prompt) to insert a row the
// cron dispatcher will pick up on its next sweep - the mobile app never
// calls the dispatch Edge Function directly, since it may be offline when
// the trigger happens. See process-scheduled-comms.
export const createScheduledCommunicationSchema = z.object({
  entity_type: scheduledCommunicationEntityTypeSchema,
  entity_id: z.string().uuid(),
  trigger_key: z.string().min(1),
  template_id: z.string().uuid().optional(),
  channel: communicationMessageChannelSchema,
  recipient_phone_or_email: z.string().min(1, "Recipient is required"),
  rendered_subject: z.string().optional(),
  rendered_body: z.string().min(1),
  scheduled_for: z.string().datetime(),
});
export type CreateScheduledCommunicationInput = z.infer<typeof createScheduledCommunicationSchema>;

// ---------------------------------------------------------------------------
// Real Estate & Strata module
// ---------------------------------------------------------------------------

export const createAgencySchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["real_estate", "strata"]).default("real_estate"),
  billing_email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  payment_terms_days: z.number().int().positive().default(30),
  require_work_order_num: z.boolean().default(true),
  client_id: z.string().uuid().optional().or(z.literal("")),
});
export type CreateAgencyInput = z.infer<typeof createAgencySchema>;

export const createPropertyManagerSchema = z.object({
  agency_id: z.string().uuid(),
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().min(1, "Last name is required"),
  email: z.string().email().optional().or(z.literal("")),
  mobile: z.string().optional(),
  work_phone: z.string().optional(),
  notes: z.string().optional(),
});
export type CreatePropertyManagerInput = z.infer<typeof createPropertyManagerSchema>;

export const createPropertySchema = z.object({
  agency_id: z.string().uuid(),
  property_manager_id: z.string().uuid().optional().or(z.literal("")),
  address_line1: z.string().min(1, "Address is required"),
  suburb: z.string().min(1, "Suburb is required"),
  state: z.string().min(1, "State is required"),
  postcode: z.string().min(1, "Postcode is required"),
  property_type: z.enum(["residential", "commercial", "strata_common_property", "strata_lot"]).default("residential"),
  strata_plan_number: z.string().optional(),
  owner_landlord_name: z.string().optional(),
  owner_landlord_phone: z.string().optional(),
  owner_landlord_email: z.string().email().optional().or(z.literal("")),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  tenant_email: z.string().email().optional().or(z.literal("")),
  access_notes: z.string().optional(),
  key_tag_number: z.string().optional(),
});
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

// Property Profile's Access & Contacts tab edit form - a subset of
// createPropertySchema's fields (landlord/tenant contact, access notes,
// key tag), deliberately excluding agency_id/property_manager_id/address/
// property_type since those aren't shown or editable from that tab.
export const updatePropertyContactSchema = z.object({
  owner_landlord_name: z.string().optional(),
  owner_landlord_phone: z.string().optional(),
  owner_landlord_email: z.string().email().optional().or(z.literal("")),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  tenant_email: z.string().email().optional().or(z.literal("")),
  access_notes: z.string().optional(),
  key_tag_number: z.string().optional(),
});
export type UpdatePropertyContactInput = z.infer<typeof updatePropertyContactSchema>;

// Property Profile's "Edit property details" action - covers exactly the
// fields updatePropertyContactSchema deliberately excludes (agency_id/
// property_manager_id/address/property_type), for correcting a typo'd
// address or reassigning a property to a different agency/PM after
// creation - previously only settable once, at creation time.
export const updatePropertyDetailsSchema = z.object({
  agency_id: z.string().uuid(),
  property_manager_id: z.string().uuid().optional().or(z.literal("")),
  address_line1: z.string().min(1, "Address is required"),
  suburb: z.string().min(1, "Suburb is required"),
  state: z.string().min(1, "State is required"),
  postcode: z.string().min(1, "Postcode is required"),
  property_type: z.enum(["residential", "commercial", "strata_common_property", "strata_lot"]).default("residential"),
});
export type UpdatePropertyDetailsInput = z.infer<typeof updatePropertyDetailsSchema>;

// attributes is intentionally z.record rather than a fixed shape - see
// PropertyAssetAttributes in types.ts for the documented plumbing/roofing
// fields this actually carries, none of which are required on any one
// asset (a category's fields are all optional, shown/hidden by the UI).
export const createPropertyAssetSchema = z.object({
  property_id: z.string().uuid(),
  category: z.enum(["plumbing", "roofing", "hvac", "general"]).default("general"),
  asset_name: z.string().min(1, "Asset name is required"),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type CreatePropertyAssetInput = z.infer<typeof createPropertyAssetSchema>;

export const createPropertyTenantSchema = z.object({
  property_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
});
export type CreatePropertyTenantInput = z.infer<typeof createPropertyTenantSchema>;

export const createKeyLogSchema = z.object({
  property_id: z.string().uuid(),
  job_id: z.string().uuid().optional(),
  technician_id: z.string().uuid().optional(),
  key_tag_number: z.string().min(1, "Key tag number is required"),
  status: z.enum(["at_office", "picked_up", "in_van", "returned"]).default("at_office"),
});
export type CreateKeyLogInput = z.infer<typeof createKeyLogSchema>;

// ---------------------------------------------------------------------------
// B2B Partner & Referral Tracking module
// ---------------------------------------------------------------------------

export const createReferralGroupSchema = z.object({
  name: z.string().min(1, "Name is required"),
  group_type: z.enum(["bni_chapter", "networking_group", "trade_association", "corporate_network"]).default("networking_group"),
  meeting_day: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateReferralGroupInput = z.infer<typeof createReferralGroupSchema>;

// reward_percent/reward_flat_cents are both plain optional numbers here (not
// conditionally required by reward_type) - the form only shows the one
// field that matches the selected reward_type, so there's nothing to cross-
// validate; whichever field the UI didn't show just stays undefined.
export const createReferralPartnerSchema = z.object({
  group_id: z.string().uuid().optional(),
  company_name: z.string().optional(),
  contact_first_name: z.string().min(1, "First name is required"),
  contact_last_name: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  mobile: z.string().optional(),
  partner_type: z
    .enum(["bni_member", "real_estate_agent", "builder_contractor", "architect", "insurance_adjuster", "existing_client", "other_b2b"])
    .default("other_b2b"),
  tier: z.enum(["bronze", "silver", "gold", "vip"]).default("bronze"),
  reward_type: z.enum(["none", "commission_percent", "flat_fee", "gift_card"]).default("none"),
  reward_percent: z.number().nonnegative().max(100).optional(),
  reward_flat_cents: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
});
export type CreateReferralPartnerInput = z.infer<typeof createReferralPartnerSchema>;

export const createReciprocityLogSchema = z.object({
  partner_id: z.string().uuid(),
  client_name: z.string().min(1, "Client name is required"),
  description: z.string().optional(),
  estimated_value_cents: z.number().int().nonnegative().optional(),
  date_passed: z.string().date().optional(),
});
export type CreateReciprocityLogInput = z.infer<typeof createReciprocityLogSchema>;

// ---------------------------------------------------------------------------
// Dynamic Reports & Safety Documentation Engine
// ---------------------------------------------------------------------------

export const createReportCategorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  icon: z.string().optional(),
});
export type CreateReportCategoryInput = z.infer<typeof createReportCategorySchema>;

export const createReportSubcategorySchema = z.object({
  category_id: z.string().uuid(),
  name: z.string().min(1, "Name is required"),
});
export type CreateReportSubcategoryInput = z.infer<typeof createReportSubcategorySchema>;

const REPORT_FIELD_TYPES: [ReportFieldType, ...ReportFieldType[]] = [
  "pass_fail",
  "risk_matrix",
  "photo",
  "text",
  "long_text",
  "meter_reading",
  "signature",
];

export const reportFieldDefinitionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(REPORT_FIELD_TYPES),
  label: z.string().min(1, "Field label is required"),
  required: z.boolean(),
  helpText: z.string().optional(),
  requireActionOnFail: z.boolean().optional(),
});

export const reportSectionDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1, "Section title is required"),
  fields: z.array(reportFieldDefinitionSchema),
});

export const reportStructureSchemaSchema = z.array(reportSectionDefinitionSchema);

export const createReportTemplateSchema = z.object({
  subcategory_id: z.string().uuid(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  is_swms: z.boolean().default(false),
  structure_schema: reportStructureSchemaSchema.default([]),
  is_active: z.boolean().default(true),
});
export type CreateReportTemplateInput = z.infer<typeof createReportTemplateSchema>;

export const createReportInstanceSchema = z.object({
  template_id: z.string().uuid(),
  job_card_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
});
export type CreateReportInstanceInput = z.infer<typeof createReportInstanceSchema>;

// form_data's per-field answer shape is enforced by the form runner UI
// (it only ever writes the ReportAnswer variant matching that field's
// declared type), not re-validated field-by-field here - same "trust the
// UI boundary, validate the outer shape" tradeoff property_assets.attributes
// already makes via z.record.
export const updateReportFormDataSchema = z.object({
  form_data: z.record(z.string(), z.unknown()),
  geo_location: z.object({ lat: z.number(), lng: z.number(), captured_at: z.string() }).optional(),
});
export type UpdateReportFormDataInput = z.infer<typeof updateReportFormDataSchema>;

export const createReportSignatureSchema = z.object({
  report_instance_id: z.string().uuid(),
  signer_name: z.string().min(1, "Signer name is required"),
  signer_role: z.enum(["technician", "client", "sub_contractor", "site_supervisor"]),
  signature_svg_data: z.string().min(1, "A signature is required"),
});
export type CreateReportSignatureInput = z.infer<typeof createReportSignatureSchema>;

// ---------------------------------------------------------------------------
// Subcontractor Management & Procurement
// ---------------------------------------------------------------------------

const SUBCONTRACTOR_TRADES: [SubcontractorTrade, ...SubcontractorTrade[]] = [
  "plumber",
  "roofer",
  "electrician",
  "hvac",
  "painter",
  "carpenter",
  "plasterer",
  "cleaner",
  "other",
];

export const createSubcontractorCompanySchema = z.object({
  company_name: z.string().min(1, "Company name is required"),
  abn: z.string().optional(),
  trades: z.array(z.enum(SUBCONTRACTOR_TRADES)).default([]),
  preference_tier: z.number().int().min(1).max(5).default(3),
  payment_terms_days: z.number().int().positive().default(30),
  // Deliberately excludes 'compliance_hold' - see the SubcontractorStatus
  // type's own comment for why the app never sets that value directly.
  status: z.enum(["active", "inactive"] satisfies [SubcontractorStatus, SubcontractorStatus]).default("active"),
  notes: z.string().optional(),
});
export type CreateSubcontractorCompanyInput = z.infer<typeof createSubcontractorCompanySchema>;

export const createSubcontractorContactSchema = z.object({
  subcontractor_id: z.string().uuid(),
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().optional(),
  role_title: z.string().optional(),
  email: z.string().email("Enter a valid email"),
  mobile: z.string().optional(),
  work_phone: z.string().optional(),
  is_primary_contact: z.boolean().default(false),
});
export type CreateSubcontractorContactInput = z.infer<typeof createSubcontractorContactSchema>;

const SUBCONTRACTOR_DOC_TYPES: [SubcontractorDocType, ...SubcontractorDocType[]] = [
  "public_liability",
  "workers_comp",
  "trade_license",
  "white_card",
  "safety_induction",
  "other",
];

export const createComplianceDocSchema = z.object({
  subcontractor_id: z.string().uuid(),
  doc_type: z.enum(SUBCONTRACTOR_DOC_TYPES).default("other"),
  doc_number: z.string().optional(),
  issue_date: z.string().date().optional(),
  // Not universally required at the zod layer (a White Card genuinely has
  // no expiry in some states) - the Compliance Tracker UI still visually
  // flags any required insurance/license type left blank.
  expiry_date: z.string().date().optional(),
  is_verified: z.boolean().default(false),
});
export type CreateComplianceDocInput = z.infer<typeof createComplianceDocSchema>;

export const poLineItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive().default(1),
  unit_cost_cents: z.number().int().nonnegative().default(0),
});
export type PoLineItemInput = z.infer<typeof poLineItemSchema>;

export const createPurchaseOrderSchema = z.object({
  job_card_id: z.string().uuid(),
  subcontractor_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  is_quote_request: z.boolean().default(false),
  line_items: z.array(poLineItemSchema).default([]),
  billed_to_client_cents: z.number().int().nonnegative().optional(),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

// ---------------------------------------------------------------------------
// Membership Module (Munus) - mirrors membership_plans_and_clients.sql.
// ---------------------------------------------------------------------------

export const membershipStatusSchema = z.enum(["active", "past_due", "cancelled", "expired"]);
export const membershipBenefitTypeSchema = z.enum(["annual_roof_inspection", "annual_plumbing_check"]);

// One row per tenant for now (see the migration's own comment on the
// partial unique index this reflects) - used for both the first-time
// setup form and every later edit of the tenant's single plan.
export const membershipPlanFormSchema = z.object({
  name: z.string().min(1, "Name is required").default("Membership"),
  annual_price_cents: z.number().int().nonnegative(),
  discount_percent: z.number().min(0).max(100).default(0),
  waive_callout_fee: z.boolean().default(true),
  priority_scheduling: z.boolean().default(true),
  same_day_response: z.boolean().default(false),
  annual_roof_inspections_included: z.number().int().nonnegative().default(1),
  annual_plumbing_checks_included: z.number().int().nonnegative().default(1),
  is_active: z.boolean().default(true),
});
export type MembershipPlanFormInput = z.infer<typeof membershipPlanFormSchema>;

// Client enrollment itself is never form-driven (it happens via Stripe
// Checkout, and the client_memberships row is created by the
// membership-stripe-webhook function on checkout.session.completed) - no
// create schema needed for it here.

export const recordMembershipBenefitUsageSchema = z.object({
  client_membership_id: z.string().uuid(),
  benefit_type: membershipBenefitTypeSchema,
  job_card_id: z.string().uuid().optional(),
  period_start: z.string().date(),
  period_end: z.string().date(),
});
export type RecordMembershipBenefitUsageInput = z.infer<typeof recordMembershipBenefitUsageSchema>;

// ---------------------------------------------------------------------------
// Cost of Ops module
// ---------------------------------------------------------------------------

// One schema covering every settings field - each tab's "Edit assumptions"
// action only ever changes the handful of fields it owns, but always
// submits the full current settings object back (simpler than juggling a
// separate schema per tab for what's ultimately one settings row).
export const updateCostOfOpsSettingsSchema = z.object({
  ordinary_hours_per_week: z.number().positive(),
  weekend_days_per_year: z.number().int().nonnegative(),
  public_holidays_per_year: z.number().int().nonnegative(),
  annual_leave_days: z.number().int().nonnegative(),
  sick_days: z.number().int().nonnegative(),
  rain_shutdown_days: z.number().int().nonnegative(),
  estimated_efficiency_rate: z.number().min(0).max(1),
  target_labour_profit_margin: z.number().min(0).max(1),
  actual_charge_rate_cents: z.number().int().nonnegative(),
  materials_avg_monthly_spend_cents: z.number().int().nonnegative(),
  materials_avg_markup: z.number().min(0),
  contractors_weekly_spend_cents: z.number().int().nonnegative(),
  contractors_weekly_hours: z.number().min(0),
  vehicles_owned: z.number().int().nonnegative(),
  vehicle_holding_cost_cents: z.number().int().nonnegative(),
  buffer_percent: z.number().min(0),
});
export type UpdateCostOfOpsSettingsInput = z.infer<typeof updateCostOfOpsSettingsSchema>;

export const createOperatingExpenseSchema = z.object({
  account_name: z.string().min(1, "Account name is required"),
  monthly_amount_cents: z.number().int().nonnegative().default(0),
  budget_amount_cents: z.number().int().nonnegative().optional(),
  is_default_category: z.boolean().default(false),
  sort_order: z.number().int().default(0),
});
export type CreateOperatingExpenseInput = z.infer<typeof createOperatingExpenseSchema>;

export const costOfOpsRoleTypeSchema = z.enum(["owner", "field_staff", "apprentice", "admin", "subcontractor"]);
export const costOfOpsPayTypeSchema = z.enum(["salary", "hourly"]);

export const createLabourCostEntrySchema = z
  .object({
    role_type: costOfOpsRoleTypeSchema,
    profile_id: z.string().uuid().optional().or(z.literal("")),
    name: z.string().optional(),
    pay_type: costOfOpsPayTypeSchema.default("hourly"),
    annual_salary_cents: z.number().int().nonnegative().optional(),
    superannuation_cents: z.number().int().nonnegative().optional(),
    hourly_rate_cents: z.number().int().nonnegative().optional(),
    superannuation_rate: z.number().min(0).optional(),
    allowance_cents: z.number().int().nonnegative().optional(),
    billable_hours_per_week: z.number().min(0).default(0),
    non_billable_hours_per_week: z.number().min(0).default(0),
    apprentice_utilisation: z.number().min(0).max(1).optional(),
    subcontractor_charge_out_rate_cents: z.number().int().nonnegative().optional(),
    subcontractor_travel_allow_cents: z.number().int().nonnegative().optional(),
    sort_order: z.number().int().default(0),
  })
  .refine((data) => data.role_type === "subcontractor" || !!data.profile_id || !!data.name?.trim(), {
    message: "Pick a linked team member or enter a name",
    path: ["name"],
  });
export type CreateLabourCostEntryInput = z.infer<typeof createLabourCostEntrySchema>;
