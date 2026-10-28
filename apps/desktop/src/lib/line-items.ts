import { computeItemizedLinePricing, computeLineItemUnitPriceCents, type LineItemFormInput } from "@jmssaas/shared";

// Port of apps/mobile/lib/line-items.ts - identical logic, kept as a
// separate module here for the same reason (shared by LineItemEditor and
// AddLineItemBar without a circular import between them).

export function emptyLineItem(sortOrder: number): LineItemFormInput {
  return {
    description: "",
    quantity: 1,
    labour_rate_cents: 0,
    labour_hours: 0,
    material_cost_cents: 0,
    markup_percent: 0,
    unit_price_cents: 0,
    gst_applicable: true,
    sort_order: sortOrder,
    is_callout_fee: false,
    waived_amount_cents: 0,
    is_subcontracted: false,
    subcontractor_cost_cents: 0,
    is_optional: false,
    is_included: true,
    bundle_name: "",
    image_url: "",
  };
}

export function normalizeLineItem(raw: Partial<LineItemFormInput> & { description: string }, sortOrder: number): LineItemFormInput {
  const base = emptyLineItem(sortOrder);
  const merged: LineItemFormInput = {
    ...base,
    ...raw,
    material_cost_cents: raw.material_cost_cents ?? raw.unit_price_cents ?? base.material_cost_cents,
    sort_order: sortOrder,
  };
  // Bug fix: this used to always recompute via the legacy formula
  // regardless of pricing_model, silently corrupting unit_price_cents for
  // any itemized item passed through here (a job template's default_line_
  // items, or a price-book item/variation/bundle sourced via
  // AddLineItemBar) - mirrors LineItemEditor's own updateItem branch.
  const unit_price_cents =
    merged.pricing_model === "itemized" ? computeItemizedLinePricing(merged).unitPriceCents : computeLineItemUnitPriceCents(merged);
  return { ...merged, unit_price_cents };
}
