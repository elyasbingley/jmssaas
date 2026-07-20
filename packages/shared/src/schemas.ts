import { z } from "zod";

export const createClientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
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
});
export type CreateJobCardInput = z.infer<typeof createJobCardSchema>;

export const createJobNoteSchema = z.object({
  job_card_id: z.string().uuid(),
  body: z.string().min(1, "Note can't be empty"),
});
export type CreateJobNoteInput = z.infer<typeof createJobNoteSchema>;

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  job_card_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  due_date: z.string().date().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const lineItemSchema = z.object({
  item_type: z.enum(["materials", "labour", "markup", "other"]),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit_price_cents: z.number().int().nonnegative(),
  gst_applicable: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});
export type LineItemFormInput = z.infer<typeof lineItemSchema>;
