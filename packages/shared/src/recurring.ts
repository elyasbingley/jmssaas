// Recurring jobs (see the recurring_jobs migration): a service set up from
// a job that repeats every N weeks or months. The database creates each
// visit's job (lead_days before it's due); these helpers describe and
// preview the schedule the same way.

import { addDaysToDay, addMonths } from "./assets";

export type RecurringUnit = "week" | "month";
export type RecurringStatus = "active" | "paused" | "stopped";

export interface RecurringService {
  id: string;
  tenant_id: string;
  client_id: string;
  site_id: string | null;
  is_real_estate_job: boolean;
  agency_id: string | null;
  property_manager_id: string | null;
  property_id: string | null;
  source_job_id: string | null;
  title: string;
  description: string | null;
  service_category_id: string | null;
  interval_count: number;
  interval_unit: RecurringUnit;
  next_due_on: string;
  lead_days: number;
  // Same shape replace_invoice_line_items takes.
  line_items: RecurringLineItem[];
  asset_service_id: string | null;
  confirm_text: boolean;
  status: RecurringStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
  gst_applicable: boolean;
  unit?: string | null;
  price_book_item_id?: string | null;
  [key: string]: unknown;
}

export const RECURRING_STATUS_LABELS: Record<RecurringStatus, string> = {
  active: "Active",
  paused: "Paused",
  stopped: "Stopped",
};

// Same as the database's recurring_add_interval.
export function addRecurringInterval(day: string, count: number, unit: RecurringUnit): string {
  return unit === "week" ? addDaysToDay(day, count * 7) : addMonths(day, count);
}

// "every 6 months", "every week", "every 2 weeks", "every year".
export function describeRepeat(count: number, unit: RecurringUnit): string {
  if (unit === "month" && count % 12 === 0) return count === 12 ? "every year" : `every ${count / 12} years`;
  if (count === 1) return `every ${unit}`;
  return `every ${count} ${unit}s`;
}

// The next few due dates from next_due_on, for previews.
export function upcomingVisits(nextDueOn: string, count: number, unit: RecurringUnit, howMany = 3): string[] {
  const out = [nextDueOn];
  while (out.length < howMany) out.push(addRecurringInterval(out[out.length - 1]!, count, unit));
  return out;
}

// When the visit's job will be created: lead_days before it's due.
export function visitCreatedOn(dueOn: string, leadDays: number): string {
  return addDaysToDay(dueOn, -leadDays);
}

// Pre-tax total of the saved line items (for showing the price per visit).
export function recurringVisitTotals(items: Pick<RecurringLineItem, "quantity" | "unit_price_cents" | "gst_applicable">[]): { subtotal_cents: number; gst_cents: number; total_cents: number } {
  let subtotal = 0;
  let gst = 0;
  for (const i of items) {
    const line = Math.round(Number(i.quantity) * Number(i.unit_price_cents));
    subtotal += line;
    if (i.gst_applicable) gst += Math.round(line * 0.1);
  }
  return { subtotal_cents: subtotal, gst_cents: gst, total_cents: subtotal + gst };
}
