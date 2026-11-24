import { test } from "node:test";
import assert from "node:assert/strict";
import { computeItemizedLinePricing, computeLineItemUnitPriceCents } from "../src/money.ts";
import { customLine, itemizedUnitPriceCents, legacyUnitPriceCents, lineFromPriceBookItem } from "../../../supabase/functions/jms-api/pricing.ts";

// The JMS API (supabase/functions/jms-api) prices draft quote lines with
// its own copy of the shared maths, since Edge Functions can't import this
// package. These keep the two the same.

const legacyCases = [
  { labour_rate_cents: 9000, labour_hours: 2, material_cost_cents: 15000, markup_percent: 20, subcontractor_cost_cents: 0 },
  { labour_rate_cents: 12500, labour_hours: 0.75, material_cost_cents: 333, markup_percent: 17.5, subcontractor_cost_cents: 5000 },
  { labour_rate_cents: 0, labour_hours: 0, material_cost_cents: 25000, markup_percent: 0, subcontractor_cost_cents: null },
];

test("legacy line prices match the shared maths", () => {
  for (const c of legacyCases) assert.equal(legacyUnitPriceCents(c), computeLineItemUnitPriceCents(c));
});

const itemizedCases = [
  {
    quantity: 1, labour_rate_cents: 0, labour_hours: 0, material_cost_cents: 0, markup_percent: 0,
    crew: [{ cost_rate_cents: 4000, charge_out_rate_cents: 9500, hours: 3 }, { cost_rate_cents: 3500, charge_out_rate_cents: 8000, hours: 2.5 }],
    materials: [{ description: "Ridge cap", quantity: 12, unit_cost_cents: 1850 }],
    material_margin_percent: 35, waste_percent: 10, contingency_percent: 5, tip_fees_cents: 4500, equipment_hire_cents: 0, travel_cost_cents: 2000,
    is_subcontracted: false, subcontractor_cost_cents: 0, subcontractor_margin_percent: null,
  },
  {
    quantity: 10, labour_rate_cents: 0, labour_hours: 4, material_cost_cents: 50000, markup_percent: 0,
    labour_cost_rate_cents: 4200, labour_charge_out_rate_cents: 11000, crew: [], materials: [],
    material_margin_percent: null, waste_percent: null, contingency_percent: null, tip_fees_cents: null, equipment_hire_cents: 15000, travel_cost_cents: null,
    is_subcontracted: true, subcontractor_cost_cents: 80000, subcontractor_margin_percent: 20,
  },
  {
    quantity: 3, labour_rate_cents: 0, labour_hours: 1, material_cost_cents: 999, markup_percent: 0,
    labour_cost_rate_cents: null, labour_charge_out_rate_cents: 9900, crew: [], materials: [],
    material_margin_percent: 99.9999, waste_percent: 0, contingency_percent: 0, is_subcontracted: false, subcontractor_cost_cents: 0,
  },
];

test("itemised line prices match the shared maths", () => {
  for (const c of itemizedCases) assert.equal(itemizedUnitPriceCents(c), computeItemizedLinePricing(c).unitPriceCents);
});

test("a price book item becomes a line at the same price the desktop gives it", () => {
  const legacy = lineFromPriceBookItem({ id: "x", description: "Gutter clean", pricing_model: "legacy", labour_rate_cents: 9000, labour_hours: 2, material_cost_cents: 1000, markup_percent: 10, gst_applicable: true, unit: "each" }, { crew: [], materials: [] }, 3);
  assert.equal(legacy.unit_price_cents, computeLineItemUnitPriceCents({ labour_rate_cents: 9000, labour_hours: 2, material_cost_cents: 1000, markup_percent: 10 }));
  assert.equal(legacy.quantity, 3);
  assert.equal(legacy.price_book_item_id, "x");

  const pb = { id: "y", description: "Re-bed ridge", pricing_model: "itemized", quantity: 10, labour_hours: 4, material_cost_cents: 50000, labour_charge_out_rate_cents: 11000, labour_cost_rate_cents: 4200 };
  const asBenchmark = lineFromPriceBookItem(pb, { crew: [], materials: [] }, null);
  assert.equal(asBenchmark.pricing_model, "itemized");
  assert.equal(asBenchmark.quantity, 10);
  const other = lineFromPriceBookItem(pb, { crew: [], materials: [] }, 4);
  // a different quantity keeps the per-unit price, as a plain line that won't re-price
  assert.equal(other.pricing_model, "legacy");
  assert.equal(other.quantity, 4);
  assert.equal(other.unit_price_cents, asBenchmark.unit_price_cents);
  assert.equal(computeLineItemUnitPriceCents(other), other.unit_price_cents);
});

test("a typed line keeps its price when re-opened in JMS", () => {
  const l = customLine("Call-out", 1, 12000, true);
  assert.equal(computeLineItemUnitPriceCents(l), 12000);
});
