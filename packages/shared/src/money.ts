// All money is handled in integer cents to avoid floating point rounding
// errors in GST math. Line item unit prices are entered GST-exclusive
// (standard AU trade quoting practice); GST is added per line, then summed,
// to produce the GST-inclusive document total.

import type { LineItemInput } from "./types";

export const AU_GST_RATE = 0.1;

// ---------------------------------------------------------------------------
// Margin <-> markup conversion (itemised quoting rework). "Margin" is
// profit as a % of the charged price (price = cost / (1 - margin/100));
// "markup" is profit as a % of cost (price = cost * (1 + markup/100)). The
// line item editor's single input is margin - these exist purely to show
// the equivalent markup % alongside it (and the reverse, for anywhere a
// markup is entered directly, e.g. the legacy markup_percent field).
// Clamped below 100/-100 respectively since a 100% margin implies an
// infinite markup (free cost, so no finite markup% expresses it).
// ---------------------------------------------------------------------------

export function marginPercentToMarkupPercent(marginPercent: number): number {
  const clamped = Math.min(marginPercent, 99.999);
  return (clamped / (100 - clamped)) * 100;
}

export function markupPercentToMarginPercent(markupPercent: number): number {
  const clamped = Math.max(markupPercent, -99.999);
  return (clamped / (100 + clamped)) * 100;
}

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

export interface ItemizedLinePricing {
  totalCostCents: number;
  totalChargeCents: number;
  // The three components of totalCostCents, broken out for callers that
  // need them separately (Job Costing/Analytics show labour/material/
  // subcontractor cost as distinct columns, same as a legacy line's
  // labour_rate_cents*labour_hours/material_cost_cents/
  // subcontractor_cost_cents). Already whole-line totals (quantity is
  // baked into crew hours/itemised materials/the cost basis, not a
  // separate multiplier - see unitPriceCents below), unlike a legacy
  // line's own per-unit fields.
  labourCostCents: number;
  materialCostCents: number;
  subcontractorCostCents: number;
  // What computeLineItemUnitPriceCents produces for a legacy line:
  // Math.round(totalChargeCents / quantity), so quantity * unitPriceCents
  // still equals totalChargeCents and lineItemSubtotalCents/
  // calculateDocumentTotals need no changes at all. This is also how a
  // benchmark rate like "ridge re-bed = $X/lm" emerges over time: enter the
  // job's real total cost/crew/materials with quantity = 70 and unit =
  // "lm", and unitPriceCents is the resulting $/lm.
  unitPriceCents: number;
  profitCents: number;
  marginPercent: number;
  markupPercent: number;
  // Line profit / total labour hours (confirmed with the person - not
  // revenue / hours, since the point of this readout is "how much is an
  // hour of this job actually worth to the business", not just its billing
  // rate).
  effectiveHourlyRateCents: number;
}

// Prices a line using the itemised model (crew/materials breakdown, split
// labour cost/charge rates, material margin, waste/contingency/allowances,
// subcontractor margin) instead of the old single labour_rate_cents/
// material_cost_cents/markup_percent bracket. Same relationship to
// unit_price_cents as computeLineItemUnitPriceCents has: this is what the
// line item editor uses to show the live cost/profit/margin/markup/$-per-
// hour readout and to derive unit_price_cents before saving - the server
// still just stores and trusts whatever unit_price_cents is submitted,
// never recomputes it.
export function computeItemizedLinePricing(
  item: Pick<
    LineItemInput,
    | "quantity"
    | "labour_hours"
    | "labour_cost_rate_cents"
    | "labour_charge_out_rate_cents"
    | "crew"
    | "material_cost_cents"
    | "materials"
    | "material_margin_percent"
    | "waste_percent"
    | "contingency_percent"
    | "tip_fees_cents"
    | "equipment_hire_cents"
    | "travel_cost_cents"
    | "is_subcontracted"
    | "subcontractor_cost_cents"
    | "subcontractor_margin_percent"
  >
): ItemizedLinePricing {
  const crew = item.crew ?? [];
  let labourCostCents: number;
  let labourChargeCents: number;
  let totalLabourHours: number;
  if (crew.length > 0) {
    labourCostCents = crew.reduce((sum, c) => sum + Math.round(c.cost_rate_cents * c.hours), 0);
    labourChargeCents = crew.reduce((sum, c) => sum + Math.round(c.charge_out_rate_cents * c.hours), 0);
    totalLabourHours = crew.reduce((sum, c) => sum + c.hours, 0);
  } else {
    totalLabourHours = item.labour_hours;
    labourCostCents = Math.round((item.labour_cost_rate_cents ?? 0) * item.labour_hours);
    labourChargeCents = Math.round((item.labour_charge_out_rate_cents ?? 0) * item.labour_hours);
  }

  const materials = item.materials ?? [];
  const materialsCostCents =
    materials.length > 0
      ? materials.reduce((sum, m) => sum + Math.round(m.quantity * m.unit_cost_cents), 0)
      : item.material_cost_cents;
  // Tip fees/equipment-scaffold hire/travel are "marked up like materials"
  // (confirmed with the person) - they join the same cost basis as
  // materials, inflated by waste%/contingency% and then margined, rather
  // than being passed through at cost.
  const allowancesCents = (item.tip_fees_cents ?? 0) + (item.equipment_hire_cents ?? 0) + (item.travel_cost_cents ?? 0);
  // waste_percent and contingency_percent both inflate the cost basis
  // itself (confirmed with the person) - so the inflated amount is what the
  // client actually pays for once material_margin_percent is applied on
  // top, same mechanism for both.
  const materialBasisCents = Math.round(
    (materialsCostCents + allowancesCents) * (1 + (item.waste_percent ?? 0) / 100) * (1 + (item.contingency_percent ?? 0) / 100)
  );
  const materialChargeCents =
    item.material_margin_percent != null
      ? Math.round(materialBasisCents / (1 - Math.min(item.material_margin_percent, 99.999) / 100))
      : materialBasisCents;

  const subcontractorCostCents = item.is_subcontracted ? item.subcontractor_cost_cents ?? 0 : 0;
  const subcontractorChargeCents = item.is_subcontracted
    ? item.subcontractor_margin_percent != null
      ? Math.round(subcontractorCostCents / (1 - Math.min(item.subcontractor_margin_percent, 99.999) / 100))
      : subcontractorCostCents
    : 0;

  const totalCostCents = labourCostCents + materialBasisCents + subcontractorCostCents;
  const totalChargeCents = labourChargeCents + materialChargeCents + subcontractorChargeCents;
  const profitCents = totalChargeCents - totalCostCents;

  return {
    totalCostCents,
    totalChargeCents,
    labourCostCents,
    materialCostCents: materialBasisCents,
    subcontractorCostCents,
    unitPriceCents: item.quantity > 0 ? Math.round(totalChargeCents / item.quantity) : totalChargeCents,
    profitCents,
    marginPercent: totalChargeCents > 0 ? (profitCents / totalChargeCents) * 100 : 0,
    markupPercent: totalCostCents > 0 ? (profitCents / totalCostCents) * 100 : 0,
    effectiveHourlyRateCents: totalLabourHours > 0 ? Math.round(profitCents / totalLabourHours) : 0,
  };
}

// ---------------------------------------------------------------------------
// Job Costing / Analytics cost breakdown - the labour/material/
// subcontractor cost of a single line item, legacy or itemized. Used to be
// three near-identical copies of the legacy-only formula (desktop
// JobCosting.tsx, mobile's job costing tab, desktop Analytics.tsx) - now
// one shared implementation covering both pricing models, so a fix here
// reaches every caller instead of needing the same fix three times.
//
// For an itemized line, computeItemizedLinePricing already returns a
// whole-line total (quantity baked into crew hours/itemised materials, not
// a separate multiplier), so these pass it through as-is rather than
// multiplying by quantity again - only the legacy per-unit fields need that
// multiply.
// ---------------------------------------------------------------------------

type CostableLineItem = Pick<
  LineItemInput,
  | "quantity"
  | "pricing_model"
  | "labour_rate_cents"
  | "labour_hours"
  | "labour_cost_rate_cents"
  | "labour_charge_out_rate_cents"
  | "crew"
  | "material_cost_cents"
  | "materials"
  | "material_margin_percent"
  | "waste_percent"
  | "contingency_percent"
  | "tip_fees_cents"
  | "equipment_hire_cents"
  | "travel_cost_cents"
  | "is_subcontracted"
  | "subcontractor_cost_cents"
  | "subcontractor_margin_percent"
>;

// labourRateCents is the tenant's own true labour cost ($/hr - typically
// Cost of Ops' averageLabourCostPerHourCents), NOT the line's own
// labour_rate_cents (what the customer was charged for labour, a pricing
// decision rather than a cost) - only used as the fallback for a legacy
// line when the caller has no better rate available (e.g. Cost of Ops
// isn't configured yet).
export function lineItemLabourCostCents(item: CostableLineItem, trueLabourRateCents: number): number {
  if (item.pricing_model === "itemized") return computeItemizedLinePricing(item).labourCostCents;
  const rate = trueLabourRateCents > 0 ? trueLabourRateCents : item.labour_rate_cents;
  return Math.round(item.quantity * rate * item.labour_hours);
}

export function lineItemMaterialCostCents(item: CostableLineItem): number {
  if (item.pricing_model === "itemized") return computeItemizedLinePricing(item).materialCostCents;
  return Math.round(item.quantity * item.material_cost_cents);
}

// "Subby box" - per-unit subcontractor cost on a legacy line, same
// treatment as material; an itemized line's is_subcontracted gate lives in
// computeItemizedLinePricing instead.
export function lineItemSubcontractorCostCents(item: CostableLineItem): number {
  if (item.pricing_model === "itemized") return computeItemizedLinePricing(item).subcontractorCostCents;
  return Math.round(item.quantity * (item.subcontractor_cost_cents ?? 0));
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

// An optional line item not currently included (is_optional && !is_included -
// an upsell the client/office hasn't opted into yet) is excluded from the
// document total here, same filter replace_quote_line_items and
// accept_quote_by_token apply server-side - so what the office sees while
// editing always matches what actually gets saved/quoted. Each line's own
// row still shows its own price via lineItemSubtotalCents/lineItemGstCents
// regardless - only the aggregate here skips it.
export function calculateDocumentTotals(
  lineItems: Array<
    Pick<LineItemInput, "quantity" | "unit_price_cents" | "gst_applicable" | "waived_amount_cents" | "is_optional" | "is_included">
  >
): DocumentTotals {
  const includedItems = lineItems.filter((item) => !item.is_optional || item.is_included);
  const subtotal_cents = includedItems.reduce((sum, item) => sum + lineItemSubtotalCents(item), 0);
  const gst_cents = includedItems.reduce((sum, item) => sum + lineItemGstCents(item), 0);
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
