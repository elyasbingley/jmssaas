// All money is handled in integer cents to avoid floating point rounding
// errors in GST math. Line item unit prices are entered GST-exclusive
// (standard AU trade quoting practice); GST is added per line, then summed,
// to produce the GST-inclusive document total.

import type { LineItemInput } from "./types";

export const AU_GST_RATE = 0.1;

export function lineItemSubtotalCents(item: Pick<LineItemInput, "quantity" | "unit_price_cents">): number {
  return Math.round(item.quantity * item.unit_price_cents);
}

export function lineItemGstCents(item: Pick<LineItemInput, "quantity" | "unit_price_cents" | "gst_applicable">): number {
  if (!item.gst_applicable) return 0;
  return Math.round(lineItemSubtotalCents(item) * AU_GST_RATE);
}

export interface DocumentTotals {
  subtotal_cents: number;
  gst_cents: number;
  total_cents: number;
}

export function calculateDocumentTotals(
  lineItems: Array<Pick<LineItemInput, "quantity" | "unit_price_cents" | "gst_applicable">>
): DocumentTotals {
  const subtotal_cents = lineItems.reduce((sum, item) => sum + lineItemSubtotalCents(item), 0);
  const gst_cents = lineItems.reduce((sum, item) => sum + lineItemGstCents(item), 0);
  return { subtotal_cents, gst_cents, total_cents: subtotal_cents + gst_cents };
}

export function formatCentsAsAud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}
