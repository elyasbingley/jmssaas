// Dashboard is the home screen on both desktop and mobile - see each app's
// Dashboard/HomeScreen. This file holds the bits both platforms need
// identically: the widget prefs shape/defaults, and the pure counting logic
// that turns raw quote/invoice rows into the three-bucket numbers shown on
// each card, so the two apps can't quietly define "Unbilled" differently.

import type { DashboardWidgetPrefs, InvoiceStatus, QuoteStatus } from "./types";

export const DEFAULT_DASHBOARD_WIDGETS: DashboardWidgetPrefs = {
  jobs_today: true,
  jobs_tomorrow: true,
  invoices: true,
  quotes: true,
};

export const DASHBOARD_WIDGET_LABELS: Record<keyof DashboardWidgetPrefs, string> = {
  jobs_today: "Jobs booked today",
  jobs_tomorrow: "Jobs booked tomorrow",
  invoices: "Invoices",
  quotes: "Quotes",
};

// Invoices: Draft / Unpaid / Overdue, per the Dashboard spec. "Unpaid" means
// sent-but-not-yet-paid; paid and void invoices don't belong in any of the
// three buckets, so they fall through to null and are excluded from the
// dashboard's counts entirely (a paid invoice isn't something that still
// needs attention, and void never was a real invoice).
export type InvoiceDashboardBucket = "draft" | "unpaid" | "overdue";

export function invoiceDashboardBucket(status: InvoiceStatus): InvoiceDashboardBucket | null {
  switch (status) {
    case "draft":
      return "draft";
    case "sent":
      return "unpaid";
    case "overdue":
      return "overdue";
    default:
      return null;
  }
}

// Quotes: Draft / Unbilled / Billed. "Billed" isn't a quote `status` value -
// converting a quote to an invoice (convert_quote_to_invoice) never changes
// the quote's own status column, it just inserts an invoices row with
// quote_id set (see the line_item_redesign migration). So "Billed" here
// means "has a linked invoice", checked separately from status; "Unbilled"
// is every other non-draft stage (sent/accepted/declined/expired) up to
// that point, matching the spec's "every stage from quote creation until
// converted to an invoice" - draft keeps its own bucket rather than being
// folded into Unbilled, since it's called out as a separate count.
export type QuoteDashboardBucket = "draft" | "unbilled" | "billed";

export function quoteDashboardBucket(status: QuoteStatus, hasLinkedInvoice: boolean): QuoteDashboardBucket {
  if (hasLinkedInvoice) return "billed";
  if (status === "draft") return "draft";
  return "unbilled";
}
