import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  calculateDocumentTotals,
  computeItemizedLinePricing,
  computeLineItemUnitPriceCents,
  formatCentsAsAud,
  marginPercentToMarkupPercent,
  LINE_ITEM_UNITS,
  type LabourCostEntry,
  type LineItemCrewInput,
  type LineItemFormInput,
  type LineItemMaterialInput,
} from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";
import { uploadLineItemImage } from "../lib/uploads";
import { supabase } from "../lib/supabase";

interface LineItemEditorProps {
  items: LineItemFormInput[];
  onChange: (items: LineItemFormInput[]) => void;
  membershipDiscountCents?: number;
  tenantId: string;
}

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

async function fetchLabourCostEntries(): Promise<LabourCostEntry[]> {
  const { data } = await supabase.from("labour_cost_entries").select("*");
  return (data ?? []) as LabourCostEntry[];
}

// A plain `value={someNumber}` input re-derives its displayed text from the
// numeric state on every render. That breaks decimal entry: typing "12."
// parses to 12, which re-renders as "12" with the trailing "." silently
// dropped, so a "5" typed next becomes "125" instead of "12.5" - full
// numbers were the only thing that ever worked. Keeping the raw keystrokes
// in local text state (only re-seeded when the row identity changes, via
// React's remount-on-key-change - see the `key={index}` on each row below)
// lets "12.", "12.5" etc pass through untouched while still calling
// onChange with the parsed number on every keystroke.
function DecimalField({
  value,
  onChange,
  placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => (value === 0 ? "" : String(value)));

  return (
    <input
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      className="w-full rounded-md border px-3 py-2 focus:outline-none"
      style={{
        backgroundColor: "var(--jms-bg)",
        borderColor: "var(--jms-border)",
        color: "var(--jms-text)",
        fontFamily: "var(--jms-font)",
        fontSize: "var(--jms-font-body)",
      }}
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

// Outlined, borderless-fill badge matching the ThemedBadge/AssetsSection
// idiom (border + text share a colour, no background fill, so it reads
// clearly against the dark CRT background instead of the old fixed light
// Tailwind fills that were unreadable on it).
function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="rounded-full border px-2 py-0.5 font-bold"
      style={{ borderColor: color, color, fontSize: "var(--jms-font-label)" }}
    >
      {label}
    </span>
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

const textInputStyle = {
  backgroundColor: "var(--jms-bg)",
  borderColor: "var(--jms-border)",
  color: "var(--jms-text)",
  fontFamily: "var(--jms-font)",
  fontSize: "var(--jms-font-body)",
} as const;

// Margin is the one input (margin = profit / price) - markup (profit /
// cost) is shown alongside it, never entered directly, per the "Margin 30%
// (= 42.86% markup)" spec. Mathematically equivalent, just two different
// denominators on the same profit.
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

// Curated dropdown (LINE_ITEM_UNITS minus "other") plus a free-text field
// for anything not on the list - "other" is tracked as separate local
// state rather than derived purely from `value`, since an empty custom
// unit and "no unit chosen yet" would otherwise be indistinguishable.
const CURATED_UNITS = LINE_ITEM_UNITS.filter((u) => u !== "other");

function UnitSelect({ value, onChange }: { value: string | null | undefined; onChange: (unit: string | null) => void }) {
  const [otherMode, setOtherMode] = useState(() => !!value && !(CURATED_UNITS as readonly string[]).includes(value));

  return (
    <div>
      <select
        className="w-full rounded-md border px-3 py-2 focus:outline-none"
        style={textInputStyle}
        value={otherMode ? "other" : value ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "other") {
            setOtherMode(true);
            onChange(value && !(CURATED_UNITS as readonly string[]).includes(value) ? value : "");
          } else {
            setOtherMode(false);
            onChange(next === "" ? null : next);
          }
        }}
      >
        <option value="">No unit</option>
        {CURATED_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
        <option value="other">Other...</option>
      </select>
      {otherMode ? (
        <input
          type="text"
          placeholder="Unit (e.g. roll, sheet)"
          className="mt-1 w-full rounded-md border px-3 py-2 focus:outline-none"
          style={textInputStyle}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

// Crew lines: more than one worker on an itemized line, each at their own
// cost/charge-out rate and hours (e.g. "you 8 hrs + offsider 8 hrs").
// labourCostEntries lets a row default its cost rate from a real Cost of
// Ops staff member instead of being re-typed.
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
  const addRow = () =>
    onChange([...crew, { worker_name: "", cost_rate_cents: 0, charge_out_rate_cents: 0, hours: 0, sort_order: crew.length }]);

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

// Itemised materials sub-table - replaces the single material_cost_cents
// figure once a line goes itemized.
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

// Live readout: cost, profit $, margin %, markup %, effective $/hr - updates
// on every keystroke since it's just computeItemizedLinePricing re-run on
// the current form state, same as unit_price_cents itself.
function LiveReadout({ item }: { item: LineItemFormInput }) {
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

// Port of apps/mobile/components/LineItemEditor.tsx - same admin-only full
// breakdown editor, same LineItemSummary client-facing view below it, same
// calculateDocumentTotals totals box. Reimplemented in HTML/Tailwind
// instead of React Native views, logic unchanged.
//
// Each line now also carries a pricing_model toggle (line_item_rework_
// schema migration): "legacy" keeps the original labour rate/hours +
// material cost + markup% bracket exactly as before; "itemized" switches
// to the new crew/materials breakdown, material/subcontractor margin %,
// waste/contingency/allowance fields, and the live cost/profit/margin/
// markup/$-per-hour readout. unit_price_cents is still the one value
// actually persisted and trusted by the server either way - toggling
// between models just changes which fields on this form produce it.
export function LineItemEditor({ items, onChange, membershipDiscountCents = 0, tenantId }: LineItemEditorProps) {
  const totals = calculateDocumentTotals(items);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const { data: labourCostEntries } = useQuery({ queryKey: ["labour-cost-entries"], queryFn: fetchLabourCostEntries });

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        const unit_price_cents =
          next.pricing_model === "itemized" ? computeItemizedLinePricing(next).unitPriceCents : computeLineItemUnitPriceCents(next);
        return { ...next, unit_price_cents };
      })
    );
  };

  // Clears crew/materials when switching back to legacy - otherwise an
  // itemized line's children would survive the toggle and still get
  // persisted (replace_quote_line_items/replace_invoice_line_items insert
  // whatever's in item.crew/item.materials regardless of pricing_model),
  // leaving a "legacy" line with phantom itemized children.
  const togglePricingModel = (index: number) => {
    const item = items[index]!;
    if (item.pricing_model === "itemized") {
      updateItem(index, { pricing_model: "legacy", crew: [], materials: [] });
    } else {
      updateItem(index, { pricing_model: "itemized" });
    }
  };

  const uploadImage = async (index: number, file: File) => {
    setImageError(null);
    setUploadingIndex(index);
    try {
      const url = await uploadLineItemImage({ tenantId, file });
      updateItem(index, { image_url: url });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Failed to upload image");
    } finally {
      setUploadingIndex(null);
    }
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  // Renumbers every item's sort_order to match its new array position on
  // every move, not just swapping the two moved rows' own sort_order -
  // QuoteDetail.tsx/InvoiceDetail.tsx's save path sends this array
  // straight to replace_quote_line_items/replace_invoice_line_items,
  // whose own sort_order handling prefers each item's carried sort_order
  // field over its array position (see atomic_line_item_rpcs.sql), so the
  // array order alone isn't enough to persist a reorder on an existing
  // quote/invoice - only QuoteNew.tsx/InvoiceNew.tsx re-derive sort_order
  // from index at insert time. Renumbering here keeps both paths correct.
  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    onChange(next.map((item, i) => ({ ...item, sort_order: i })));
  };

  return (
    <div>
      {items.map((item, index) => {
        const itemized = item.pricing_model === "itemized";
        const crew = item.crew ?? [];
        const materials = item.materials ?? [];
        return (
          <div key={index} className="mb-3 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)" }}>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  #{index + 1}
                </span>
                {itemized ? <Tag label="Itemised" color="var(--jms-accent)" /> : null}
                {item.is_callout_fee ? <Tag label="Call-out fee" color="var(--jms-text-muted)" /> : null}
                {item.waived_amount_cents > 0 ? <Tag label="Waived - Membership" color="var(--jms-accent)" /> : null}
                {item.is_subcontracted ? <Tag label="Subcontracted" color="var(--jms-warning)" /> : null}
                {item.is_optional ? <Tag label="Optional" color="var(--jms-accent)" /> : null}
                {item.bundle_name ? <Tag label={`Bundle: ${item.bundle_name}`} color="var(--jms-text-muted)" /> : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => moveItem(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  aria-label="Move up"
                  className="jms-nav-link rounded px-1 font-bold disabled:opacity-30"
                  style={{ fontSize: "var(--jms-font-label)" }}
                >
                  &uarr;
                </button>
                <button
                  onClick={() => moveItem(index, 1)}
                  disabled={index === items.length - 1}
                  title="Move down"
                  aria-label="Move down"
                  className="jms-nav-link rounded px-1 font-bold disabled:opacity-30"
                  style={{ fontSize: "var(--jms-font-label)" }}
                >
                  &darr;
                </button>
                <button
                  onClick={() => removeItem(index)}
                  className="font-semibold"
                  style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                >
                  Remove
                </button>
              </div>
            </div>

            <textarea
              className="mb-3 w-full rounded-md border px-3 py-2 focus:outline-none"
              style={textInputStyle}
              placeholder={"Description (e.g. supply and install valley channel)"}
              rows={3}
              value={item.description}
              onChange={(e) => updateItem(index, { description: e.target.value })}
            />

            <div className="mb-3 flex items-center gap-2">
              <button
                onClick={() => togglePricingModel(index)}
                className="rounded-md border px-3 py-1.5 font-bold"
                style={
                  itemized
                    ? { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                    : {
                        backgroundColor: "var(--jms-accent-glow)",
                        borderColor: "var(--jms-accent)",
                        color: "var(--jms-accent)",
                        fontSize: "var(--jms-font-label)",
                      }
                }
              >
                Simple
              </button>
              <button
                onClick={() => togglePricingModel(index)}
                className="rounded-md border px-3 py-1.5 font-bold"
                style={
                  itemized
                    ? {
                        backgroundColor: "var(--jms-accent-glow)",
                        borderColor: "var(--jms-accent)",
                        color: "var(--jms-accent)",
                        fontSize: "var(--jms-font-label)",
                      }
                    : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                }
              >
                Itemised
              </button>
            </div>

            <div className="mb-3 grid grid-cols-3 gap-3">
              <Field label="Quantity">
                <DecimalField value={item.quantity} onChange={(n) => updateItem(index, { quantity: n })} />
              </Field>
              <Field label="Unit">
                <UnitSelect value={item.unit} onChange={(unit) => updateItem(index, { unit })} />
              </Field>
              <div className="flex items-end">
                <button
                  onClick={() => updateItem(index, { gst_applicable: !item.gst_applicable })}
                  className="w-full rounded-md border px-3 py-2 font-bold"
                  style={
                    item.gst_applicable
                      ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                      : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                  }
                >
                  GST {item.gst_applicable ? "applicable" : "not applicable"}
                </button>
              </div>
            </div>

            {!itemized ? (
              <>
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <Field label="Labour rate ($/hr)">
                    <DecimalField
                      value={item.labour_rate_cents / 100}
                      onChange={(n) => updateItem(index, { labour_rate_cents: Math.round(n * 100) })}
                    />
                  </Field>
                  <Field label="Labour hours">
                    <DecimalField value={item.labour_hours} onChange={(n) => updateItem(index, { labour_hours: n })} />
                  </Field>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <Field label="Material cost ($)">
                    <DecimalField
                      value={item.material_cost_cents / 100}
                      onChange={(n) => updateItem(index, { material_cost_cents: Math.round(n * 100) })}
                    />
                  </Field>
                  <Field label="Markup (%)">
                    <DecimalField value={item.markup_percent} onChange={(n) => updateItem(index, { markup_percent: n })} />
                  </Field>
                </div>
              </>
            ) : (
              <>
                {crew.length === 0 ? (
                  <div className="mb-3 grid grid-cols-3 gap-3">
                    <Field label="Labour cost rate ($/hr)">
                      <DecimalField
                        value={(item.labour_cost_rate_cents ?? 0) / 100}
                        onChange={(n) => updateItem(index, { labour_cost_rate_cents: Math.round(n * 100) })}
                      />
                    </Field>
                    <Field label="Labour charge-out rate ($/hr)">
                      <DecimalField
                        value={(item.labour_charge_out_rate_cents ?? 0) / 100}
                        onChange={(n) => updateItem(index, { labour_charge_out_rate_cents: Math.round(n * 100) })}
                      />
                    </Field>
                    <Field label="Labour hours">
                      <DecimalField value={item.labour_hours} onChange={(n) => updateItem(index, { labour_hours: n })} />
                    </Field>
                  </div>
                ) : (
                  <CrewEditor crew={crew} labourCostEntries={labourCostEntries ?? []} onChange={(nextCrew) => updateItem(index, { crew: nextCrew })} />
                )}
                <button
                  onClick={() =>
                    updateItem(
                      index,
                      crew.length === 0
                        ? {
                            crew: [
                              {
                                worker_name: "",
                                cost_rate_cents: item.labour_cost_rate_cents ?? 0,
                                charge_out_rate_cents: item.labour_charge_out_rate_cents ?? 0,
                                hours: item.labour_hours,
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
                  <Field label="Material cost ($)">
                    <DecimalField
                      value={item.material_cost_cents / 100}
                      onChange={(n) => updateItem(index, { material_cost_cents: Math.round(n * 100) })}
                    />
                  </Field>
                ) : (
                  <MaterialsEditor materials={materials} onChange={(nextMaterials) => updateItem(index, { materials: nextMaterials })} />
                )}
                <button
                  onClick={() =>
                    updateItem(
                      index,
                      materials.length === 0
                        ? { materials: [{ description: "", quantity: 1, unit_cost_cents: item.material_cost_cents, sort_order: 0 }] }
                        : { materials: [] }
                    )
                  }
                  className="mb-3 font-semibold hover:underline"
                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                >
                  {materials.length === 0 ? "+ Itemise materials" : "Remove itemised materials"}
                </button>

                <div className="mb-3">
                  <Field label="Material margin % (applies to materials + waste/contingency/allowances below)">
                    <MarginField
                      value={item.material_margin_percent ?? 0}
                      onChange={(n) => updateItem(index, { material_margin_percent: n })}
                    />
                  </Field>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-3">
                  <Field label="Waste (%)">
                    <DecimalField value={item.waste_percent ?? 0} onChange={(n) => updateItem(index, { waste_percent: n })} />
                  </Field>
                  <Field label="Contingency (%)">
                    <DecimalField value={item.contingency_percent ?? 0} onChange={(n) => updateItem(index, { contingency_percent: n })} />
                  </Field>
                </div>
                <div className="mb-3 grid grid-cols-3 gap-3">
                  <Field label="Tip fees ($)">
                    <DecimalField
                      value={(item.tip_fees_cents ?? 0) / 100}
                      onChange={(n) => updateItem(index, { tip_fees_cents: Math.round(n * 100) })}
                    />
                  </Field>
                  <Field label="Equipment/scaffold hire ($)">
                    <DecimalField
                      value={(item.equipment_hire_cents ?? 0) / 100}
                      onChange={(n) => updateItem(index, { equipment_hire_cents: Math.round(n * 100) })}
                    />
                  </Field>
                  <Field label="Travel ($)">
                    <DecimalField
                      value={(item.travel_cost_cents ?? 0) / 100}
                      onChange={(n) => updateItem(index, { travel_cost_cents: Math.round(n * 100) })}
                    />
                  </Field>
                </div>
              </>
            )}

            <label
              className="mb-3 flex items-center gap-2 font-semibold"
              style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
            >
              <input
                type="checkbox"
                checked={item.is_subcontracted ?? false}
                onChange={(e) =>
                  updateItem(index, { is_subcontracted: e.target.checked, subcontractor_cost_cents: e.target.checked ? item.subcontractor_cost_cents ?? 0 : 0 })
                }
              />
              Subcontracted
            </label>
            {item.is_subcontracted ? (
              <div className="mb-3 grid grid-cols-2 gap-3">
                <Field label="Subcontractor cost ($, per unit)">
                  <DecimalField
                    value={(item.subcontractor_cost_cents ?? 0) / 100}
                    onChange={(n) => updateItem(index, { subcontractor_cost_cents: Math.round(n * 100) })}
                  />
                </Field>
                {itemized ? (
                  <Field label="Subcontractor margin (%)">
                    <MarginField
                      value={item.subcontractor_margin_percent ?? 0}
                      onChange={(n) => updateItem(index, { subcontractor_margin_percent: n })}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}

            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label
                  className="mb-1 block uppercase tracking-wide"
                  style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                >
                  Bundle name (optional grouping)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Gutter guard package"
                  className="w-full rounded-md border px-3 py-2 focus:outline-none"
                  style={textInputStyle}
                  value={item.bundle_name ?? ""}
                  onChange={(e) => updateItem(index, { bundle_name: e.target.value })}
                />
              </div>
              <label
                className="flex items-end pb-2 gap-2 font-semibold"
                style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
              >
                <input
                  type="checkbox"
                  checked={item.is_optional ?? false}
                  onChange={(e) => updateItem(index, { is_optional: e.target.checked, is_included: !e.target.checked })}
                />
                Optional (client ticks on to include)
              </label>
            </div>

            <div className="mb-3">
              <Field label="Warranty (shown to the client, directly under the description)">
                <input
                  type="text"
                  placeholder="e.g. 10 year workmanship warranty"
                  className="w-full rounded-md border px-3 py-2 focus:outline-none"
                  style={textInputStyle}
                  value={item.warranty_text ?? ""}
                  onChange={(e) => updateItem(index, { warranty_text: e.target.value })}
                />
              </Field>
            </div>
            <div className="mb-3">
              <Field label="Internal notes (office only - never shown to the client)">
                <textarea
                  rows={2}
                  placeholder="e.g. keep copper nails clear of valley"
                  className="w-full rounded-md border px-3 py-2 focus:outline-none"
                  style={textInputStyle}
                  value={item.internal_notes ?? ""}
                  onChange={(e) => updateItem(index, { internal_notes: e.target.value })}
                />
              </Field>
            </div>

            <div className="mb-3">
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Image (shown on the quote/invoice PDF)
              </label>
              {item.image_url ? (
                <img
                  src={item.image_url}
                  alt=""
                  className="mb-2 h-24 w-full max-w-xs rounded-md object-cover"
                  style={{ backgroundColor: "var(--jms-bg)" }}
                />
              ) : null}
              <label
                className="jms-nav-link inline-block cursor-pointer rounded-md border px-3 py-1.5 font-semibold"
                style={{ borderColor: "var(--jms-border)", fontSize: "var(--jms-font-label)" }}
              >
                {uploadingIndex === index ? "Uploading..." : item.image_url ? "Change image" : "Add image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingIndex === index}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadImage(index, file);
                    e.target.value = "";
                  }}
                />
              </label>
              {item.image_url ? (
                <button
                  onClick={() => updateItem(index, { image_url: "" })}
                  className="ml-2 font-semibold"
                  style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                >
                  Remove image
                </button>
              ) : null}
            </div>

            {itemized ? <LiveReadout item={item} /> : null}

            <div className="flex justify-between pt-2" style={{ borderTop: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}>
              <span style={{ color: "var(--jms-text-muted)" }}>Line total</span>
              <span className="font-bold" style={{ color: "var(--jms-text)" }}>
                {item.waived_amount_cents > 0 ? (
                  <>
                    <span className="mr-2 line-through" style={{ color: "var(--jms-text-muted)" }}>
                      {formatCentsAsAud(item.quantity * item.unit_price_cents)}
                    </span>
                    {formatCentsAsAud(item.quantity * item.unit_price_cents - item.waived_amount_cents)}
                  </>
                ) : (
                  formatCentsAsAud(item.quantity * item.unit_price_cents)
                )}
              </span>
            </div>
          </div>
        );
      })}

      {imageError ? (
        <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {imageError}
        </p>
      ) : null}

      <AddLineItemBar
        itemCount={items.length}
        onAdd={(item) => onChange([...items, item])}
        onAddMany={(newItems) => onChange([...items, ...newItems])}
      />

      <TotalsBox totals={totals} membershipDiscountCents={membershipDiscountCents} />
    </div>
  );
}

// Client-facing summary: description / qty / rate / amount only - never the
// labour/material/markup breakdown, matching LineItemSummary on mobile.
// warranty_text is the one itemized-rework field shown here too (right
// under the description) since it's explicitly client-visible by design -
// crew/materials/internal_notes/pricing_model never appear here.
export function LineItemSummary({ items, membershipDiscountCents = 0 }: { items: LineItemFormInput[]; membershipDiscountCents?: number }) {
  const totals = calculateDocumentTotals(items);

  return (
    <div>
      <div
        className="flex pb-2 font-bold uppercase tracking-wide"
        style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
      >
        <span className="flex-[3]">Item &amp; Description</span>
        <span className="flex-1 text-right">Qty</span>
        <span className="flex-1 text-right">Rate</span>
        <span className="flex-1 text-right">Amount</span>
      </div>
      {items.map((item, index) => {
        const excluded = item.is_optional && !item.is_included;
        const showBundleHeading = item.bundle_name && item.bundle_name !== items[index - 1]?.bundle_name;
        return (
          <div key={index}>
            {showBundleHeading ? (
              <div
                className="mt-3 pb-1 font-bold uppercase tracking-wide"
                style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                {item.bundle_name}
              </div>
            ) : null}
            <div
              className={`py-2 ${excluded ? "opacity-50" : ""}`}
              style={{ borderBottom: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}
            >
              {item.image_url ? <img src={item.image_url} alt="" className="mb-2 h-20 w-32 rounded-md object-cover" /> : null}
              <div className="flex">
                <span className="flex-[3]" style={{ color: "var(--jms-text)" }}>
                  {item.description}
                  {item.is_optional ? (
                    <span className="ml-2">
                      <Tag label={excluded ? "Not selected" : "Optional - included"} color="var(--jms-accent)" />
                    </span>
                  ) : null}
                  {item.warranty_text ? (
                    <div className="mt-0.5" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      {item.warranty_text}
                    </div>
                  ) : null}
                </span>
                <span className="flex-1 text-right" style={{ color: "var(--jms-text)" }}>
                  {item.quantity}
                  {item.unit ? ` ${item.unit}` : ""}
                </span>
                <span className="flex-1 text-right" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(item.unit_price_cents)}
                </span>
                <span className="flex-1 text-right" style={{ color: "var(--jms-text)" }}>
                  {excluded ? "—" : formatCentsAsAud(item.quantity * item.unit_price_cents - item.waived_amount_cents)}
                </span>
              </div>
              {item.waived_amount_cents > 0 ? (
                <div className="mt-1 text-right font-semibold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                  Waived - Membership
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      <TotalsBox totals={totals} membershipDiscountCents={membershipDiscountCents} />
    </div>
  );
}

function TotalsBox({
  totals,
  membershipDiscountCents = 0,
}: {
  totals: { subtotal_cents: number; gst_cents: number; total_cents: number };
  membershipDiscountCents?: number;
}) {
  return (
    <div className="mt-3 space-y-1 pt-3" style={{ borderTop: "1px solid var(--jms-border)" }}>
      <div className="flex justify-between" style={{ fontSize: "var(--jms-font-body)" }}>
        <span style={{ color: "var(--jms-text-muted)" }}>Subtotal</span>
        <span style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(totals.subtotal_cents)}</span>
      </div>
      <div className="flex justify-between" style={{ fontSize: "var(--jms-font-body)" }}>
        <span style={{ color: "var(--jms-text-muted)" }}>GST</span>
        <span style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(totals.gst_cents)}</span>
      </div>
      {membershipDiscountCents > 0 ? (
        <div className="flex justify-between" style={{ fontSize: "var(--jms-font-body)" }}>
          <span style={{ color: "var(--jms-accent)" }}>Membership discount</span>
          <span style={{ color: "var(--jms-accent)" }}>-{formatCentsAsAud(membershipDiscountCents)}</span>
        </div>
      ) : null}
      <div className="flex justify-between font-bold" style={{ fontSize: "var(--jms-font-body)" }}>
        <span style={{ color: "var(--jms-text-muted)" }}>Total</span>
        <span style={{ color: "var(--jms-accent)" }}>{formatCentsAsAud(totals.total_cents - membershipDiscountCents)}</span>
      </div>
    </div>
  );
}
