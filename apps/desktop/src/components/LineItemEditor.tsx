import { useState } from "react";
import { calculateDocumentTotals, computeLineItemUnitPriceCents, formatCentsAsAud, type LineItemFormInput } from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";
import { uploadLineItemImage } from "../lib/uploads";

interface LineItemEditorProps {
  items: LineItemFormInput[];
  onChange: (items: LineItemFormInput[]) => void;
  membershipDiscountCents?: number;
  tenantId: string;
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

// Port of apps/mobile/components/LineItemEditor.tsx - same admin-only full
// breakdown editor (labour rate/hours, material cost, markup%, quantity),
// same LineItemSummary client-facing view below it, same
// calculateDocumentTotals totals box. Reimplemented in HTML/Tailwind
// instead of React Native views, logic unchanged.
export function LineItemEditor({ items, onChange, membershipDiscountCents = 0, tenantId }: LineItemEditorProps) {
  const totals = calculateDocumentTotals(items);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        return { ...next, unit_price_cents: computeLineItemUnitPriceCents(next) };
      })
    );
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
      {items.map((item, index) => (
        <div key={index} className="mb-3 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)" }}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                #{index + 1}
              </span>
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
            style={{
              backgroundColor: "var(--jms-bg)",
              borderColor: "var(--jms-border)",
              color: "var(--jms-text)",
              fontFamily: "var(--jms-font)",
              fontSize: "var(--jms-font-body)",
            }}
            placeholder={"Description (e.g. supply and install valley channel)"}
            rows={3}
            value={item.description}
            onChange={(e) => updateItem(index, { description: e.target.value })}
          />

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Labour rate ($/hr)
              </label>
              <DecimalField
                value={item.labour_rate_cents / 100}
                onChange={(n) => updateItem(index, { labour_rate_cents: Math.round(n * 100) })}
              />
            </div>
            <div>
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Labour hours
              </label>
              <DecimalField value={item.labour_hours} onChange={(n) => updateItem(index, { labour_hours: n })} />
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Material cost ($)
              </label>
              <DecimalField
                value={item.material_cost_cents / 100}
                onChange={(n) => updateItem(index, { material_cost_cents: Math.round(n * 100) })}
              />
            </div>
            <div>
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Markup (%)
              </label>
              <DecimalField value={item.markup_percent} onChange={(n) => updateItem(index, { markup_percent: n })} />
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Quantity
              </label>
              <DecimalField value={item.quantity} onChange={(n) => updateItem(index, { quantity: n })} />
            </div>
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
            <div className="mb-3">
              <label
                className="mb-1 block uppercase tracking-wide"
                style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                Subcontractor cost ($, per unit)
              </label>
              <DecimalField
                value={(item.subcontractor_cost_cents ?? 0) / 100}
                onChange={(n) => updateItem(index, { subcontractor_cost_cents: Math.round(n * 100) })}
              />
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
                style={{
                  backgroundColor: "var(--jms-bg)",
                  borderColor: "var(--jms-border)",
                  color: "var(--jms-text)",
                  fontFamily: "var(--jms-font)",
                  fontSize: "var(--jms-font-body)",
                }}
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
      ))}

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
                </span>
                <span className="flex-1 text-right" style={{ color: "var(--jms-text)" }}>
                  {item.quantity}
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
