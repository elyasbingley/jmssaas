// All money is handled in integer cents to avoid floating point rounding
// errors in GST math. Line item unit prices are entered GST-exclusive
// (standard AU trade quoting practice); GST is added per line, then summed,
// to produce the GST-inclusive document total.

import type { LineItemInput } from "./types";

export const AU_GST_RATE = 0.1;

// Line Total = Qty x [(Labour Rate x Hours + Material Cost) x (1 + Markup%)],
// confirmed with the person. This computes the bracketed part - the
// per-unit price before quantity is applied - which is what's stored as
// unit_price_cents. Keeping it a separate function (not entangled with
// lineItemSubtotalCents below) means the GST/subtotal math further down
// stays completely untouched: it still just does quantity * unit_price_cents,
// exactly as before this line-item redesign.
export function computeLineItemUnitPriceCents(
  item: Pick<LineItemInput, "labour_rate_cents" | "labour_hours" | "material_cost_cents" | "markup_percent" | "subcontractor_cost_cents">
): number {
  const preMarkupCents = item.labour_rate_cents * item.labour_hours + item.material_cost_cents + (item.subcontractor_cost_cents ?? 0);
  return Math.round(preMarkupCents * (1 + item.markup_percent / 100));
}

// Subtracts waived_amount_cents (0 for any line not flagged is_callout_fee
// by an active membership that waives it - see membership_discount_engine.sql's
// apply_membership_adjustments) before quantity*rate becomes a line's
// contribution to the document subtotal - mirrors calculate_line_item_totals'
// server-side math exactly, so this never disagrees with the persisted
// subtotal_cents/gst_cents once a membership waiver is in play.
export function lineItemSubtotalCents(item: Pick<LineItemInput, "quantity" | "unit_price_cents" | "waived_amount_cents">): number {
  return Math.round(item.quantity * item.unit_price_cents) - (item.waived_amount_cents ?? 0);
}

export function lineItemGstCents(
  item: Pick<LineItemInput, "quantity" | "unit_price_cents" | "gst_applicable" | "waived_amount_cents">
): number {
  if (!item.gst_applicable) return 0;
  return Math.round(lineItemSubtotalCents(item) * AU_GST_RATE);
}

export interface DocumentTotals {
  subtotal_cents: number;
  gst_cents: number;
  total_cents: number;
}

export function calculateDocumentTotals(
  lineItems: Array<Pick<LineItemInput, "quantity" | "unit_price_cents" | "gst_applicable" | "waived_amount_cents">>
): DocumentTotals {
  const subtotal_cents = lineItems.reduce((sum, item) => sum + lineItemSubtotalCents(item), 0);
  const gst_cents = lineItems.reduce((sum, item) => sum + lineItemGstCents(item), 0);
  return { subtotal_cents, gst_cents, total_cents: subtotal_cents + gst_cents };
}

export function formatCentsAsAud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

// Same numeric formatting as formatCentsAsAud but without the currency
// symbol - matches the reference invoice/quote templates, where only the
// prominent "Balance Due" figure carries a $ sign and every itemised/total
// row in the body is plain "1,234.56".
export function formatCentsPlain(cents: number): string {
  return new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}
