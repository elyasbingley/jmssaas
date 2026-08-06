import { useState } from "react";
import { formatCentsAsAud, type PoLineItemInput } from "@jmssaas/shared";

// Purchase order line items are a much flatter shape than quotes/invoices'
// LineItemFormInput (no labour/material/markup/GST split - see the
// migration's own PurchaseOrderLineItem comment) since a PO/Quote Request
// just states "this much of this thing at this cost", so this gets its own
// small editor rather than reusing LineItemEditor.

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

// See LineItemEditor.tsx's DecimalField for why a plain value={number} input
// can never accept a decimal point being typed by hand.
function DecimalField({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => (value === 0 ? "" : String(value)));

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
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

export function PoLineItemEditor({
  items,
  onChange,
  readOnly = false,
}: {
  items: PoLineItemInput[];
  onChange: (items: PoLineItemInput[]) => void;
  readOnly?: boolean;
}) {
  const totalCents = items.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_cost_cents), 0);

  const updateItem = (index: number, patch: Partial<PoLineItemInput>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));
  const addItem = () => onChange([...items, { description: "", quantity: 1, unit_cost_cents: 0 }]);

  return (
    <div>
      {items.map((item, index) => (
        <div key={index} className="mb-3 rounded-lg border border-gray-200 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-gray-400">#{index + 1}</span>
            {!readOnly ? (
              <button onClick={() => removeItem(index)} className="text-xs font-semibold text-red-600">
                Remove
              </button>
            ) : null}
          </div>
          <textarea
            className="mb-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
            placeholder="Description of work"
            rows={2}
            disabled={readOnly}
            value={item.description}
            onChange={(e) => updateItem(index, { description: e.target.value })}
          />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Quantity</label>
              <DecimalField value={item.quantity} disabled={readOnly} onChange={(n) => updateItem(index, { quantity: n })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Unit cost ($)</label>
              <DecimalField
                value={item.unit_cost_cents / 100}
                disabled={readOnly}
                onChange={(n) => updateItem(index, { unit_cost_cents: Math.round(n * 100) })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-500">Line total</label>
              <p className="pt-2 text-sm font-bold text-gray-900">{formatCentsAsAud(Math.round(item.quantity * item.unit_cost_cents))}</p>
            </div>
          </div>
        </div>
      ))}

      {!readOnly ? (
        <button onClick={addItem} className="mb-3 w-full rounded-md border border-dashed border-gray-300 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
          + Add line item
        </button>
      ) : null}

      <div className="flex justify-between border-t border-gray-200 pt-3 text-sm font-bold text-gray-900">
        <span>Total cost</span>
        <span>{formatCentsAsAud(totalCents)}</span>
      </div>
    </div>
  );
}
