// Line pricing for draft quotes made through the API - a copy of
// computeLineItemUnitPriceCents / computeItemizedLinePricing in
// packages/shared/src/money.ts (Edge Functions can't import the shared
// package). packages/shared/test/api-pricing.test.mjs runs both on the same
// inputs, so if one changes without the other that test fails.

export interface CrewRow {
  worker_name?: string | null;
  labour_cost_entry_id?: string | null;
  cost_rate_cents: number;
  charge_out_rate_cents: number;
  hours: number;
  sort_order?: number;
}
export interface MaterialRow {
  description: string;
  quantity: number;
  unit_cost_cents: number;
  sort_order?: number;
}

export interface PricedFields {
  quantity: number;
  labour_rate_cents: number;
  labour_hours: number;
  material_cost_cents: number;
  markup_percent: number;
  subcontractor_cost_cents?: number | null;
  labour_cost_rate_cents?: number | null;
  labour_charge_out_rate_cents?: number | null;
  crew?: CrewRow[];
  materials?: MaterialRow[];
  material_margin_percent?: number | null;
  waste_percent?: number | null;
  contingency_percent?: number | null;
  tip_fees_cents?: number | null;
  equipment_hire_cents?: number | null;
  travel_cost_cents?: number | null;
  is_subcontracted?: boolean | null;
  subcontractor_margin_percent?: number | null;
}

export function legacyUnitPriceCents(item: Pick<PricedFields, "labour_rate_cents" | "labour_hours" | "material_cost_cents" | "markup_percent" | "subcontractor_cost_cents">): number {
  const preMarkupCents = item.labour_rate_cents * item.labour_hours + item.material_cost_cents + (item.subcontractor_cost_cents ?? 0);
  return Math.round(preMarkupCents * (1 + item.markup_percent / 100));
}

export function itemizedUnitPriceCents(item: PricedFields): number {
  const crew = item.crew ?? [];
  let labourChargeCents: number;
  if (crew.length > 0) {
    labourChargeCents = crew.reduce((sum, c) => sum + Math.round(c.charge_out_rate_cents * c.hours), 0);
  } else {
    labourChargeCents = Math.round((item.labour_charge_out_rate_cents ?? 0) * item.labour_hours);
  }
  const materials = item.materials ?? [];
  const materialsCostCents = materials.length > 0 ? materials.reduce((sum, m) => sum + Math.round(m.quantity * m.unit_cost_cents), 0) : item.material_cost_cents;
  const allowancesCents = (item.tip_fees_cents ?? 0) + (item.equipment_hire_cents ?? 0) + (item.travel_cost_cents ?? 0);
  const materialBasisCents = Math.round((materialsCostCents + allowancesCents) * (1 + (item.waste_percent ?? 0) / 100) * (1 + (item.contingency_percent ?? 0) / 100));
  const materialChargeCents =
    item.material_margin_percent != null ? Math.round(materialBasisCents / (1 - Math.min(item.material_margin_percent, 99.999) / 100)) : materialBasisCents;
  const subcontractorCostCents = item.is_subcontracted ? item.subcontractor_cost_cents ?? 0 : 0;
  const subcontractorChargeCents = item.is_subcontracted
    ? item.subcontractor_margin_percent != null
      ? Math.round(subcontractorCostCents / (1 - Math.min(item.subcontractor_margin_percent, 99.999) / 100))
      : subcontractorCostCents
    : 0;
  const totalChargeCents = labourChargeCents + materialChargeCents + subcontractorChargeCents;
  return item.quantity > 0 ? Math.round(totalChargeCents / item.quantity) : totalChargeCents;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// A price book item as a quote line - the same fields the desktop's "add
// from price book" copies. An itemised item is priced for its own
// benchmark quantity; asked for a different quantity, the line keeps that
// per-unit price as a plain line (so re-opening the quote in JMS doesn't
// re-price it), still linked to the price book item.
export function lineFromPriceBookItem(item: Row, children: { crew: CrewRow[]; materials: MaterialRow[] }, quantity: number | null): Row {
  const base = {
    price_book_item_id: item.id,
    description: item.description,
    unit: item.unit ?? null,
    warranty_text: item.warranty_text ?? null,
    is_callout_fee: item.is_callout_fee ?? false,
    gst_applicable: item.gst_applicable ?? true,
  };
  if (item.pricing_model === "itemized") {
    const benchmark = Number(item.quantity ?? 1) || 1;
    const fields: PricedFields = {
      quantity: benchmark,
      labour_rate_cents: Number(item.labour_rate_cents ?? 0),
      labour_hours: Number(item.labour_hours ?? 0),
      material_cost_cents: Number(item.material_cost_cents ?? 0),
      markup_percent: Number(item.markup_percent ?? 0),
      labour_cost_rate_cents: item.labour_cost_rate_cents,
      labour_charge_out_rate_cents: item.labour_charge_out_rate_cents,
      crew: children.crew.map((c) => ({ ...c, cost_rate_cents: Number(c.cost_rate_cents), charge_out_rate_cents: Number(c.charge_out_rate_cents), hours: Number(c.hours) })),
      materials: children.materials.map((m) => ({ ...m, quantity: Number(m.quantity), unit_cost_cents: Number(m.unit_cost_cents) })),
      material_margin_percent: item.material_margin_percent == null ? null : Number(item.material_margin_percent),
      waste_percent: item.waste_percent == null ? null : Number(item.waste_percent),
      contingency_percent: item.contingency_percent == null ? null : Number(item.contingency_percent),
      tip_fees_cents: item.tip_fees_cents == null ? null : Number(item.tip_fees_cents),
      equipment_hire_cents: item.equipment_hire_cents == null ? null : Number(item.equipment_hire_cents),
      travel_cost_cents: item.travel_cost_cents == null ? null : Number(item.travel_cost_cents),
      is_subcontracted: !!item.is_subcontracted,
      subcontractor_cost_cents: Number(item.subcontractor_cost_cents ?? 0),
      subcontractor_margin_percent: item.subcontractor_margin_percent == null ? null : Number(item.subcontractor_margin_percent),
    };
    const unitPrice = itemizedUnitPriceCents(fields);
    if (quantity == null || quantity === benchmark) {
      return {
        ...base,
        ...fields,
        pricing_model: "itemized",
        crew: fields.crew!.map((c, i) => ({ worker_name: c.worker_name ?? null, labour_cost_entry_id: c.labour_cost_entry_id ?? null, cost_rate_cents: c.cost_rate_cents, charge_out_rate_cents: c.charge_out_rate_cents, hours: c.hours, sort_order: i })),
        materials: fields.materials!.map((m, i) => ({ description: m.description, quantity: m.quantity, unit_cost_cents: m.unit_cost_cents, sort_order: i })),
        unit_price_cents: unitPrice,
      };
    }
    return { ...base, pricing_model: "legacy", quantity, labour_rate_cents: 0, labour_hours: 0, material_cost_cents: unitPrice, markup_percent: 0, unit_price_cents: unitPrice };
  }
  const legacy = {
    labour_rate_cents: Number(item.labour_rate_cents ?? 0),
    labour_hours: Number(item.labour_hours ?? 0),
    material_cost_cents: Number(item.material_cost_cents ?? 0),
    markup_percent: Number(item.markup_percent ?? 0),
    subcontractor_cost_cents: Number(item.subcontractor_cost_cents ?? 0),
    is_subcontracted: !!item.is_subcontracted,
  };
  return { ...base, ...legacy, pricing_model: "legacy", quantity: quantity ?? 1, unit_price_cents: legacyUnitPriceCents(legacy) };
}

// A typed line (no price book item): the price is the line's own "material"
// cost with no markup - how the desktop stores a custom line, so it stays
// at this price when the quote is opened in JMS.
export function customLine(description: string, quantity: number, unitPriceCents: number, gst: boolean): Row {
  return {
    description,
    quantity,
    pricing_model: "legacy",
    labour_rate_cents: 0,
    labour_hours: 0,
    material_cost_cents: unitPriceCents,
    markup_percent: 0,
    unit_price_cents: unitPriceCents,
    gst_applicable: gst,
  };
}
