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

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  job_card_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  due_date: z.string().date().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

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

export const communicationDelayUnitSchema = z.enum(["hours", "days"]);
export const communicationDelayDirectionSchema = z.enum(["before", "after"]);
export const communicationChannelSchema = z.enum(["sms", "email", "both"]);
export const communicationMessageChannelSchema = z.enum(["sms", "email"]);
export const communicationTemplateCategorySchema = z.enum(["quote", "invoice", "booking", "field"]);
export const scheduledCommunicationEntityTypeSchema = z.enum(["quote", "invoice", "job", "calendar_event", "client"]);

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
