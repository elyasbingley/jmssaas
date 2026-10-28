import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  computeItemizedLinePricing,
  formatCentsAsAud,
  marginPercentToMarkupPercent,
  type LabourCostEntry,
  type LineItemCrewInput,
  type LineItemFormInput,
  type LineItemMaterialInput,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

// The itemized cost-rate/charge-rate/margin pricing fields, shared by the
// Price Book item form and its variation modal (both in PriceBookItem.tsx)
// - same fields/behaviour as LineItemEditor.tsx's own itemized block, but
// deliberately a separate component rather than that one made reusable:
// LineItemEditor is the most heavily-used screen in the app (every quote/
// invoice), and refactoring it to share pieces with a brand-new editor
// risks a regression there for no benefit the quote/invoice side actually
// needs. This file is free to duplicate that UI/logic shape instead -
// same tradeoff this codebase already makes between Edge Functions rather
// than cross-importing between them.
//
// Pricing is computed via the exact same computeItemizedLinePricing used
// for a quote/invoice line - a price book item just uses `quantity` as
// the benchmark denominator the itemized total was priced at (e.g. 70 for
// a $X/70-per-lm rate) rather than a document line's multiplier. See the
// price_book_itemized_pricing migration's own comment.

export type PriceBookPricingFields = Pick<
  LineItemFormInput,
  | "pricing_model"
  | "quantity"
  | "labour_rate_cents"
  | "labour_hours"
  | "labour_cost_rate_cents"
  | "labour_charge_out_rate_cents"
  | "crew"
  | "material_cost_cents"
  | "materials"
  | "markup_percent"
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

async function fetchLabourCostEntries(): Promise<LabourCostEntry[]> {
  const { data } = await supabase.from("labour_cost_entries").select("*");
  return (data ?? []) as LabourCostEntry[];
}

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

const textInputStyle = {
  backgroundColor: "var(--jms-bg)",
  borderColor: "var(--jms-border)",
  color: "var(--jms-text)",
  fontFamily: "var(--jms-font)",
  fontSize: "var(--jms-font-body)",
} as const;

function DecimalField({ value, onChange, placeholder }: { value: number; onChange: (n: number) => void; placeholder?: string }) {
  const [text, setText] = useState(() => (value === 0 ? "" : String(value)));
  return (
    <input
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      className="w-full rounded-md border px-3 py-2 focus:outline-none"
      style={textInputStyle}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        if (!/^\d*\.?\d*$/.test(next)) return;
        setText(next);
        onChange(parseNumber(next));
      }}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function MarginField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <DecimalField value={value} onChange={onChange} placeholder="%" />
      <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        = {marginPercentToMarkupPercent(value).toFixed(2)}% markup
      </p>
    </div>
  );
}

function CrewEditor({
  crew,
  labourCostEntries,
  onChange,
}: {
  crew: LineItemCrewInput[];
  labourCostEntries: LabourCostEntry[];
  onChange: (crew: LineItemCrewInput[]) => void;
}) {
  const updateRow = (i: number, patch: Partial<LineItemCrewInput>) => onChange(crew.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const removeRow = (i: number) => onChange(crew.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...crew, { worker_name: "", cost_rate_cents: 0, charge_out_rate_cents: 0, hours: 0, sort_order: crew.length }]);

  return (
    <div className="mb-3 rounded-md p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Crew
        </span>
        <button onClick={addRow} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          + Add worker
        </button>
      </div>
      {crew.map((c, i) => (
        <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_1fr_1fr_auto] items-start gap-2">
          <div>
            {labourCostEntries.length > 0 ? (
              <select
                className="mb-1 w-full rounded-md border px-2 py-2 focus:outline-none"
                style={textInputStyle}
                value={c.labour_cost_entry_id ?? ""}
                onChange={(e) => {
                  const entry = labourCostEntries.find((l) => l.id === e.target.value);
                  updateRow(i, {
                    labour_cost_entry_id: e.target.value || null,
                    worker_name: entry ? entry.name ?? c.worker_name : c.worker_name,
                    cost_rate_cents: entry?.hourly_rate_cents ?? c.cost_rate_cents,
                  });
                }}
              >
                <option value="">Ad-hoc worker...</option>
                {labourCostEntries.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name ?? l.role_type}
                  </option>
                ))}
              </select>
            ) : null}
            <input
              type="text"
              placeholder="Worker name"
              className="w-full rounded-md border px-2 py-2 focus:outline-none"
              style={textInputStyle}
              value={c.worker_name}
              onChange={(e) => updateRow(i, { worker_name: e.target.value })}
            />
          </div>
          <DecimalField value={c.cost_rate_cents / 100} onChange={(n) => updateRow(i, { cost_rate_cents: Math.round(n * 100) })} placeholder="Cost $/hr" />
          <DecimalField
            value={c.charge_out_rate_cents / 100}
            onChange={(n) => updateRow(i, { charge_out_rate_cents: Math.round(n * 100) })}
            placeholder="Charge $/hr"
          />
          <DecimalField value={c.hours} onChange={(n) => updateRow(i, { hours: n })} placeholder="Hours" />
          <button onClick={() => removeRow(i)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            &#10005;
          </button>
        </div>
      ))}
    </div>
  );
}

function MaterialsEditor({ materials, onChange }: { materials: LineItemMaterialInput[]; onChange: (materials: LineItemMaterialInput[]) => void }) {
  const updateRow = (i: number, patch: Partial<LineItemMaterialInput>) =>
    onChange(materials.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  const removeRow = (i: number) => onChange(materials.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...materials, { description: "", quantity: 1, unit_cost_cents: 0, sort_order: materials.length }]);
  const subtotalCents = materials.reduce((sum, m) => sum + Math.round(m.quantity * m.unit_cost_cents), 0);

  return (
    <div className="mb-3 rounded-md p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Materials
        </span>
        <button onClick={addRow} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          + Add material
        </button>
      </div>
      {materials.map((m, i) => (
        <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_1fr_auto] items-start gap-2">
          <input
            type="text"
            placeholder="Description"
            className="w-full rounded-md border px-2 py-2 focus:outline-none"
            style={textInputStyle}
            value={m.description}
            onChange={(e) => updateRow(i, { description: e.target.value })}
          />
          <DecimalField value={m.quantity} onChange={(n) => updateRow(i, { quantity: n })} placeholder="Qty" />
          <DecimalField value={m.unit_cost_cents / 100} onChange={(n) => updateRow(i, { unit_cost_cents: Math.round(n * 100) })} placeholder="Unit cost $" />
          <button onClick={() => removeRow(i)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            &#10005;
          </button>
        </div>
      ))}
      {materials.length > 0 ? (
        <div className="flex justify-between pt-1" style={{ borderTop: "1px solid var(--jms-border)", fontSize: "var(--jms-font-label)" }}>
          <span style={{ color: "var(--jms-text-muted)" }}>Materials subtotal</span>
          <span style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(subtotalCents)}</span>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {label}
      </div>
      <div className="font-bold" style={{ color: warn ? "var(--jms-danger)" : "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        {value}
      </div>
    </div>
  );
}

function LiveReadout({ item }: { item: PriceBookPricingFields }) {
  const pricing = computeItemizedLinePricing(item);
  return (
    <div className="mb-3 grid grid-cols-5 gap-2 rounded-md p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
      <Stat label="Cost" value={formatCentsAsAud(pricing.totalCostCents)} />
      <Stat label="Profit" value={formatCentsAsAud(pricing.profitCents)} warn={pricing.profitCents < 0} />
      <Stat label="Margin" value={`${pricing.marginPercent.toFixed(1)}%`} warn={pricing.marginPercent < 0} />
      <Stat label="Markup" value={`${pricing.markupPercent.toFixed(1)}%`} warn={pricing.markupPercent < 0} />
      <Stat label="Effective $/hr" value={formatCentsAsAud(pricing.effectiveHourlyRateCents)} warn={pricing.effectiveHourlyRateCents < 0} />
    </div>
  );
}

export function PriceBookItemizedFields({
  value,
  onChange,
}: {
  value: PriceBookPricingFields;
  onChange: (patch: Partial<PriceBookPricingFields>) => void;
}) {
  const { data: labourCostEntries } = useQuery({ queryKey: ["labour-cost-entries-for-price-book"], queryFn: fetchLabourCostEntries });
  const itemized = value.pricing_model === "itemized";
  const crew = value.crew ?? [];
  const materials = value.materials ?? [];

  const togglePricingModel = () => {
    if (itemized) {
      onChange({ pricing_model: "legacy", crew: [], materials: [] });
    } else {
      onChange({ pricing_model: "itemized" });
    }
  };

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <button
          onClick={togglePricingModel}
          className="flex-1 rounded-md border px-3 py-2 font-semibold"
          style={
            !itemized
              ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
              : { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
          }
        >
          Simple
        </button>
        <button
          onClick={togglePricingModel}
          className="flex-1 rounded-md border px-3 py-2 font-semibold"
          style={
            itemized
              ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
              : { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
          }
        >
          Itemised
        </button>
      </div>

      {!itemized ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Field label="Labour rate ($/hr)">
              <DecimalField value={value.labour_rate_cents / 100} onChange={(n) => onChange({ labour_rate_cents: Math.round(n * 100) })} />
            </Field>
            <Field label="Labour hours">
              <DecimalField value={value.labour_hours} onChange={(n) => onChange({ labour_hours: n })} />
            </Field>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Field label="Material cost ($)">
              <DecimalField value={value.material_cost_cents / 100} onChange={(n) => onChange({ material_cost_cents: Math.round(n * 100) })} />
            </Field>
            <Field label="Markup (%)">
              <DecimalField value={value.markup_percent} onChange={(n) => onChange({ markup_percent: n })} />
            </Field>
          </div>
        </>
      ) : (
        <>
          {crew.length === 0 ? (
            <div className="mb-2 grid grid-cols-3 gap-3">
              <Field label="Labour cost rate ($/hr)">
                <DecimalField
                  value={(value.labour_cost_rate_cents ?? 0) / 100}
                  onChange={(n) => onChange({ labour_cost_rate_cents: Math.round(n * 100) })}
                />
              </Field>
              <Field label="Charge-out rate ($/hr)">
                <DecimalField
                  value={(value.labour_charge_out_rate_cents ?? 0) / 100}
                  onChange={(n) => onChange({ labour_charge_out_rate_cents: Math.round(n * 100) })}
                />
              </Field>
              <Field label="Labour hours">
                <DecimalField value={value.labour_hours} onChange={(n) => onChange({ labour_hours: n })} />
              </Field>
            </div>
          ) : (
            <CrewEditor crew={crew} labourCostEntries={labourCostEntries ?? []} onChange={(nextCrew) => onChange({ crew: nextCrew })} />
          )}
          <button
            onClick={() =>
              onChange(
                crew.length === 0
                  ? {
                      crew: [
                        {
                          worker_name: "",
                          cost_rate_cents: value.labour_cost_rate_cents ?? 0,
                          charge_out_rate_cents: value.labour_charge_out_rate_cents ?? 0,
                          hours: value.labour_hours,
                          sort_order: 0,
                        },
                      ],
                    }
                  : { crew: [] }
              )
            }
            className="mb-3 font-semibold hover:underline"
            style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          >
            {crew.length === 0 ? "+ Add crew (multiple workers)" : "Remove crew breakdown"}
          </button>

          {materials.length === 0 ? (
            <div className="mb-2 grid grid-cols-2 gap-3">
              <Field label="Material cost ($)">
                <DecimalField value={value.material_cost_cents / 100} onChange={(n) => onChange({ material_cost_cents: Math.round(n * 100) })} />
              </Field>
            </div>
          ) : (
            <MaterialsEditor materials={materials} onChange={(nextMaterials) => onChange({ materials: nextMaterials })} />
          )}
          <button
            onClick={() =>
              onChange(
                materials.length === 0
                  ? { materials: [{ description: "", quantity: 1, unit_cost_cents: value.material_cost_cents, sort_order: 0 }] }
                  : { materials: [] }
              )
            }
            className="mb-3 font-semibold hover:underline"
            style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          >
            {materials.length === 0 ? "+ Itemise materials" : "Remove itemised materials"}
          </button>

          <div className="mb-3">
            <Field label="Material margin % (incl. waste/contingency/allowances below)">
              <MarginField value={value.material_margin_percent ?? 0} onChange={(n) => onChange({ material_margin_percent: n })} />
            </Field>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <Field label="Waste (%)">
              <DecimalField value={value.waste_percent ?? 0} onChange={(n) => onChange({ waste_percent: n })} />
            </Field>
            <Field label="Contingency (%)">
              <DecimalField value={value.contingency_percent ?? 0} onChange={(n) => onChange({ contingency_percent: n })} />
            </Field>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-3">
            <Field label="Tip fees ($)">
              <DecimalField value={(value.tip_fees_cents ?? 0) / 100} onChange={(n) => onChange({ tip_fees_cents: Math.round(n * 100) })} />
            </Field>
            <Field label="Equipment/scaffold ($)">
              <DecimalField value={(value.equipment_hire_cents ?? 0) / 100} onChange={(n) => onChange({ equipment_hire_cents: Math.round(n * 100) })} />
            </Field>
            <Field label="Travel ($)">
              <DecimalField value={(value.travel_cost_cents ?? 0) / 100} onChange={(n) => onChange({ travel_cost_cents: Math.round(n * 100) })} />
            </Field>
          </div>
        </>
      )}

      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={() =>
            onChange({
              is_subcontracted: !value.is_subcontracted,
              subcontractor_cost_cents: !value.is_subcontracted ? value.subcontractor_cost_cents ?? 0 : 0,
            })
          }
          className="rounded-md border px-3 py-2 font-semibold"
          style={
            value.is_subcontracted
              ? { backgroundColor: "var(--jms-warning)", borderColor: "var(--jms-warning)", color: "var(--jms-bg)", fontSize: "var(--jms-font-label)" }
              : { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
          }
        >
          {value.is_subcontracted ? "Subcontracted" : "Not subcontracted"}
        </button>
        {value.is_subcontracted ? (
          <div className="flex-1">
            <Field label="Subcontractor cost ($, per unit)">
              <DecimalField
                value={(value.subcontractor_cost_cents ?? 0) / 100}
                onChange={(n) => onChange({ subcontractor_cost_cents: Math.round(n * 100) })}
              />
            </Field>
          </div>
        ) : null}
      </div>
      {value.is_subcontracted && itemized ? (
        <div className="mb-3">
          <Field label="Subcontractor margin (%)">
            <MarginField value={value.subcontractor_margin_percent ?? 0} onChange={(n) => onChange({ subcontractor_margin_percent: n })} />
          </Field>
        </div>
      ) : null}

      {itemized ? <LiveReadout item={value} /> : null}
    </div>
  );
}
