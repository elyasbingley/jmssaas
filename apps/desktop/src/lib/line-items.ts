import { computeLineItemUnitPriceCents, type LineItemFormInput } from "@jmssaas/shared";

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
  return { ...merged, unit_price_cents: computeLineItemUnitPriceCents(merged) };
}
