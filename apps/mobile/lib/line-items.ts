import { computeItemizedLinePricing, computeLineItemUnitPriceCents, type LineItemFormInput } from "@jmssaas/shared";

// Shared by LineItemEditor and AddLineItemBar - kept in a plain lib module
// (not re-exported from either component) so the two don't end up with a
// circular import between them.

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

// Fills in any fields missing from a possibly-legacy-shaped item (e.g. a
// template saved before the labour/material/markup breakdown existed, which
// only has description/quantity/unit_price_cents/gst_applicable/sort_order)
// and recomputes unit_price_cents from whatever breakdown is present. Old
// unit_price_cents becomes material_cost_cents with zero labour/markup -
// the same default mapping used for the one-off DB migration of existing
// quote/invoice line items (see supabase/migrations/20260724000100_line_item_redesign.sql),
// applied consistently here for template- and price-book-sourced items too.
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
