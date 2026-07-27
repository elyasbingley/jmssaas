import { z } from "zod";

export const createClientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  suburb: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

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
});
export type CreateServiceCategoryInput = z.infer<typeof createServiceCategorySchema>;

export const createJobLifecycleStageSchema = z.object({
  name: z.string().min(1, "Name is required"),
  position: z.number().int().default(0),
  color: z.string().optional(),
});
export type CreateJobLifecycleStageInput = z.infer<typeof createJobLifecycleStageSchema>;
