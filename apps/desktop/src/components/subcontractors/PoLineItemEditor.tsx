import { useState } from "react";
import { formatCentsAsAud, type PoLineItemInput } from "@jmssaas/shared";

// Purchase order line items are a much flatter shape than quotes/invoices'
// LineItemFormInput (no labour/material/markup/GST split - see the
// migration's own PurchaseOrderLineItem comment) since a PO/Quote Request
// just states "this much of this thing at this cost", so this gets its own
// small editor rather than reusing LineItemEditor.

const inputStyle = (disabled?: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? "var(--jms-surface)" : "var(--jms-bg)",
  borderColor: "var(--jms-border)",
  color: disabled ? "var(--jms-text-muted)" : "var(--jms-text)",
  fontFamily: "var(--jms-font)",
  fontSize: "var(--jms-font-body)",
});
const labelStyle: React.CSSProperties = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };

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
      className="w-full rounded border px-3 py-2 focus:outline-none"
      style={inputStyle(disabled)}
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
    <div style={{ fontFamily: "var(--jms-font)" }}>
      {items.map((item, index) => (
        <div key={index} className="mb-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-bold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
              #{index + 1}
            </span>
            {!readOnly ? (
              <button onClick={() => removeItem(index)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                Remove
              </button>
            ) : null}
          </div>
          <textarea
            className="mb-3 w-full rounded border px-3 py-2 focus:outline-none"
            style={inputStyle(readOnly)}
            placeholder="Description of work"
            rows={2}
            disabled={readOnly}
            value={item.description}
            onChange={(e) => updateItem(index, { description: e.target.value })}
          />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block uppercase tracking-wide" style={labelStyle}>
                Quantity
              </label>
              <DecimalField value={item.quantity} disabled={readOnly} onChange={(n) => updateItem(index, { quantity: n })} />
            </div>
            <div>
              <label className="mb-1 block uppercase tracking-wide" style={labelStyle}>
                Unit cost ($)
              </label>
              <DecimalField
                value={item.unit_cost_cents / 100}
                disabled={readOnly}
                onChange={(n) => updateItem(index, { unit_cost_cents: Math.round(n * 100) })}
              />
            </div>
            <div>
              <label className="mb-1 block uppercase tracking-wide" style={labelStyle}>
                Line total
              </label>
              <p className="pt-2 font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {formatCentsAsAud(Math.round(item.quantity * item.unit_cost_cents))}
              </p>
            </div>
          </div>
        </div>
      ))}

      {!readOnly ? (
        <button
          onClick={addItem}
          className="jms-nav-link mb-3 w-full rounded border border-dashed py-2 font-semibold"
          style={{ borderColor: "var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          + Add line item
        </button>
      ) : null}

      <div className="flex justify-between pt-3 font-bold" style={{ borderTop: "1px solid var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        <span className="uppercase tracking-wide">Total cost</span>
        <span style={{ color: "var(--jms-accent)" }}>{formatCentsAsAud(totalCents)}</span>
      </div>
    </div>
  );
}
