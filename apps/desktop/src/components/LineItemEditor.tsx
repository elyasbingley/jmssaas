import { useState } from "react";
import { calculateDocumentTotals, computeLineItemUnitPriceCents, formatCentsAsAud, type LineItemFormInput } from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";

interface LineItemEditorProps {
  items: LineItemFormInput[];
  onChange: (items: LineItemFormInput[]) => void;
}

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
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
      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
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

// Port of apps/mobile/components/LineItemEditor.tsx - same admin-only full
// breakdown editor (labour rate/hours, material cost, markup%, quantity),
// same LineItemSummary client-facing view below it, same
// calculateDocumentTotals totals box. Reimplemented in HTML/Tailwind
// instead of React Native views, logic unchanged.
export function LineItemEditor({ items, onChange }: LineItemEditorProps) {
  const totals = calculateDocumentTotals(items);

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        return { ...next, unit_price_cents: computeLineItemUnitPriceCents(next) };
      })
    );
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  return (
    <div>
      {items.map((item, index) => (
        <div key={index} className="mb-3 rounded-lg border border-gray-200 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-gray-400">#{index + 1}</span>
            <button onClick={() => removeItem(index)} className="text-xs font-semibold text-red-600">
              Remove
            </button>
          </div>

          <textarea
            className="mb-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder={"Description (e.g. supply and install valley channel)"}
            rows={3}
            value={item.description}
            onChange={(e) => updateItem(index, { description: e.target.value })}
          />

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Labour rate ($/hr)</label>
              <DecimalField
                value={item.labour_rate_cents / 100}
                onChange={(n) => updateItem(index, { labour_rate_cents: Math.round(n * 100) })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Labour hours</label>
              <DecimalField value={item.labour_hours} onChange={(n) => updateItem(index, { labour_hours: n })} />
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Material cost ($)</label>
              <DecimalField
                value={item.material_cost_cents / 100}
                onChange={(n) => updateItem(index, { material_cost_cents: Math.round(n * 100) })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Markup (%)</label>
              <DecimalField value={item.markup_percent} onChange={(n) => updateItem(index, { markup_percent: n })} />
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Quantity</label>
              <DecimalField value={item.quantity} onChange={(n) => updateItem(index, { quantity: n })} />
            </div>
            <div className="flex items-end">
              <button
                onClick={() => updateItem(index, { gst_applicable: !item.gst_applicable })}
                className={`w-full rounded-md px-3 py-2 text-xs font-bold ${
                  item.gst_applicable ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
                }`}
              >
                GST {item.gst_applicable ? "applicable" : "not applicable"}
              </button>
            </div>
          </div>

          <div className="flex justify-between border-t border-gray-100 pt-2 text-sm">
            <span className="text-gray-500">Line total</span>
            <span className="font-bold">{formatCentsAsAud(item.quantity * item.unit_price_cents)}</span>
          </div>
        </div>
      ))}

      <AddLineItemBar itemCount={items.length} onAdd={(item) => onChange([...items, item])} />

      <TotalsBox totals={totals} />
    </div>
  );
}

// Client-facing summary: description / qty / rate / amount only - never the
// labour/material/markup breakdown, matching LineItemSummary on mobile.
export function LineItemSummary({ items }: { items: LineItemFormInput[] }) {
  const totals = calculateDocumentTotals(items);

  return (
    <div>
      <div className="flex border-b border-gray-200 pb-2 text-xs font-bold text-gray-500">
        <span className="flex-[3]">Item &amp; Description</span>
        <span className="flex-1 text-right">Qty</span>
        <span className="flex-1 text-right">Rate</span>
        <span className="flex-1 text-right">Amount</span>
      </div>
      {items.map((item, index) => (
        <div key={index} className="flex border-b border-gray-100 py-2 text-sm">
          <span className="flex-[3]">{item.description}</span>
          <span className="flex-1 text-right">{item.quantity}</span>
          <span className="flex-1 text-right">{formatCentsAsAud(item.unit_price_cents)}</span>
          <span className="flex-1 text-right">{formatCentsAsAud(item.quantity * item.unit_price_cents)}</span>
        </div>
      ))}
      <TotalsBox totals={totals} />
    </div>
  );
}

function TotalsBox({ totals }: { totals: { subtotal_cents: number; gst_cents: number; total_cents: number } }) {
  return (
    <div className="mt-3 space-y-1 border-t border-gray-200 pt-3">
      <div className="flex justify-between text-sm text-gray-600">
        <span>Subtotal</span>
        <span>{formatCentsAsAud(totals.subtotal_cents)}</span>
      </div>
      <div className="flex justify-between text-sm text-gray-600">
        <span>GST</span>
        <span>{formatCentsAsAud(totals.gst_cents)}</span>
      </div>
      <div className="flex justify-between text-sm font-bold text-gray-900">
        <span>Total</span>
        <span>{formatCentsAsAud(totals.total_cents)}</span>
      </div>
    </div>
  );
}
