import { useState } from "react";
import {
  duplicateOption,
  formatCentsAsAud,
  optionTotals,
  replaceSection,
  sectionLines,
  type LineItemFormInput,
  type QuoteOption,
  type QuoteOptionInput,
} from "@jmssaas/shared";
import { LineItemEditor, LineItemSummary } from "./LineItemEditor";
import { ThemedButton } from "./theme/ThemedButton";

// Quote options (Good / Better / Best) around the normal line item editor
// - see the quote_options migration. A tab for the shared section ("In
// every option": call-out fee, scaffolding...) and one per option; each tab
// edits just that section's lines with the usual LineItemEditor. A quote
// with no options looks exactly as before, with a button to start offering
// options.

const SHARED = "shared";
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" };

export function QuoteOptionsEditor({
  options,
  onOptionsChange,
  lineItems,
  onLineItemsChange,
  savedOptions,
  chosenOptionId,
  isLocked,
  canChoose,
  onChoose,
  choosing,
  membershipDiscountCents,
  tenantId,
}: {
  options: QuoteOptionInput[];
  onOptionsChange: (options: QuoteOptionInput[]) => void;
  lineItems: LineItemFormInput[];
  onLineItemsChange: (items: LineItemFormInput[]) => void;
  // As last saved - for the totals with membership discount, and "chosen".
  savedOptions: QuoteOption[];
  chosenOptionId: string | null;
  isLocked: boolean;
  // The office can record the client's choice (accepted by phone) - not
  // once they've accepted online.
  canChoose: boolean;
  onChoose: (optionId: string | null) => void;
  choosing: boolean;
  membershipDiscountCents: number;
  tenantId: string;
}) {
  const [active, setActive] = useState<string>(options[0]?.id ?? SHARED);
  const sorted = [...options].sort((a, b) => a.sort_order - b.sort_order);
  const activeOption = sorted.find((o) => o.id === active) ?? null;
  const activeKey = activeOption ? activeOption.id : null;

  const renumber = (list: QuoteOptionInput[]) => list.map((o, i) => ({ ...o, sort_order: i }));
  const updateOption = (id: string, patch: Partial<QuoteOptionInput>) =>
    onOptionsChange(
      options.map((o) => (o.id === id ? { ...o, ...patch } : patch.is_recommended ? { ...o, is_recommended: false } : o))
    );

  const startOptions = () => {
    const first: QuoteOptionInput = { id: crypto.randomUUID(), name: "Option 1", description: "", is_recommended: false, sort_order: 0 };
    const second: QuoteOptionInput = { id: crypto.randomUUID(), name: "Option 2", description: "", is_recommended: false, sort_order: 1 };
    onOptionsChange([first, second]);
    setActive(first.id);
  };
  const addOption = () => {
    const option: QuoteOptionInput = { id: crypto.randomUUID(), name: `Option ${sorted.length + 1}`, description: "", is_recommended: false, sort_order: sorted.length };
    onOptionsChange([...sorted, option]);
    setActive(option.id);
  };
  const copyOption = (option: QuoteOptionInput) => {
    const copy = duplicateOption(lineItems, option, crypto.randomUUID(), sorted.length);
    onOptionsChange([...sorted, copy.option]);
    onLineItemsChange([...lineItems, ...copy.lines]);
    setActive(copy.option.id);
  };
  const removeOption = (option: QuoteOptionInput) => {
    const count = sectionLines(lineItems, option.id).length;
    if (!window.confirm(`Remove "${option.name}"${count ? ` and its ${count} line${count === 1 ? "" : "s"}` : ""}?`)) return;
    const rest = renumber(sorted.filter((o) => o.id !== option.id));
    onLineItemsChange(lineItems.filter((item) => item.option_id !== option.id));
    // One option left isn't a choice: fold it back into a plain quote.
    if (rest.length === 1) {
      onLineItemsChange(lineItems.filter((item) => item.option_id !== option.id).map((item) => ({ ...item, option_id: null })));
      onOptionsChange([]);
      setActive(SHARED);
      return;
    }
    onOptionsChange(rest);
    setActive(rest[0]?.id ?? SHARED);
  };
  const moveOption = (option: QuoteOptionInput, delta: number) => {
    const index = sorted.findIndex((o) => o.id === option.id);
    const target = index + delta;
    if (target < 0 || target >= sorted.length) return;
    const next = [...sorted];
    const moving = next[index]!;
    next[index] = next[target]!;
    next[target] = moving;
    onOptionsChange(renumber(next));
  };

  // No options: the editor as it always was.
  if (!options.length) {
    return (
      <>
        {isLocked ? (
          <LineItemSummary items={lineItems} membershipDiscountCents={membershipDiscountCents} />
        ) : (
          <>
            <LineItemEditor items={lineItems} onChange={onLineItemsChange} membershipDiscountCents={membershipDiscountCents} tenantId={tenantId} />
            <button onClick={startOptions} className="mt-3 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
              + Offer options (e.g. Repair / Restore / Replace)
            </button>
            <p style={muted}>The client picks one option on their quote link. The lines above stay in every option.</p>
          </>
        )}
      </>
    );
  }

  const tab = (key: string, label: string, sub?: string) => (
    <button
      key={key}
      onClick={() => setActive(key)}
      className="rounded-t border px-3 py-2 text-left"
      style={{
        borderColor: active === key ? "var(--jms-accent)" : "var(--jms-border)",
        backgroundColor: active === key ? "var(--jms-accent-glow)" : "transparent",
        color: active === key ? "var(--jms-accent)" : "var(--jms-text)",
        fontSize: "var(--jms-font-body)",
      }}
    >
      <div className="font-semibold">{label}</div>
      {sub ? <div style={muted}>{sub}</div> : null}
    </button>
  );

  const liveTotal = (id: string) => optionTotals(lineItems, id).total_cents;
  const saved = (id: string) => savedOptions.find((o) => o.id === id);

  return (
    <div data-testid="quote-options">
      <div className="mb-3 overflow-x-auto">
        <table className="w-full" style={{ fontSize: "var(--jms-font-body)", color: "var(--jms-text)" }}>
          <thead>
            <tr style={muted}>
              <th className="py-1 text-left font-semibold">Option</th>
              <th className="py-1 text-right font-semibold">Total (inc GST)</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => {
              const s = saved(o.id);
              const isChosen = chosenOptionId === o.id;
              return (
                <tr key={o.id} style={{ borderTop: "1px solid var(--jms-border)" }}>
                  <td className="py-1.5">
                    {o.name}
                    {o.is_recommended ? <span style={{ ...muted, color: "var(--jms-accent)" }}> · Recommended</span> : null}
                    {isChosen ? <span style={{ ...muted, color: "var(--jms-accent)", fontWeight: 700 }}> · CHOSEN</span> : null}
                  </td>
                  <td className="py-1.5 text-right font-semibold">
                    {formatCentsAsAud(s && isLocked ? s.total_cents : liveTotal(o.id) - (s?.membership_discount_cents ?? 0))}
                  </td>
                  <td className="py-1.5 text-right">
                    {canChoose && s ? (
                      <button
                        onClick={() => onChoose(isChosen ? null : o.id)}
                        disabled={choosing}
                        className="font-semibold hover:underline"
                        style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                      >
                        {isChosen ? "Undo choice" : "Client chose this"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={muted}>
          Until the client chooses, the quote counts as the recommended option (or the first). Each total includes the lines in "In every
          option".
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {tab(SHARED, "In every option", `${sectionLines(lineItems, null).length} lines`)}
        {sorted.map((o) => tab(o.id, `${o.is_recommended ? "★ " : ""}${o.name}`, `${sectionLines(lineItems, o.id).length} lines`))}
        {!isLocked ? (
          <button onClick={addOption} className="px-3 py-2 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
            + Add option
          </button>
        ) : null}
      </div>

      <div className="rounded-b rounded-tr border p-3" style={{ borderColor: "var(--jms-border)" }}>
        {activeOption && !isLocked ? (
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Option name"
                value={activeOption.name}
                onChange={(e) => updateOption(activeOption.id, { name: e.target.value })}
                className="rounded border px-2 py-1.5 font-semibold"
                style={inputStyle}
              />
              <label className="flex items-center gap-1" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                <input
                  type="checkbox"
                  checked={activeOption.is_recommended}
                  onChange={(e) => updateOption(activeOption.id, { is_recommended: e.target.checked })}
                />
                Recommended
              </label>
              <span className="ml-auto flex gap-3" style={{ fontSize: "var(--jms-font-label)" }}>
                <button onClick={() => moveOption(activeOption, -1)} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                  ← Move
                </button>
                <button onClick={() => moveOption(activeOption, 1)} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                  Move →
                </button>
                <button onClick={() => copyOption(activeOption)} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                  Copy option
                </button>
                <button onClick={() => removeOption(activeOption)} className="hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Remove option
                </button>
              </span>
            </div>
            <textarea
              aria-label="Option description"
              rows={2}
              value={activeOption.description}
              onChange={(e) => updateOption(activeOption.id, { description: e.target.value })}
              placeholder="What this option includes, in a sentence or two - shown to the client above its lines"
              className="w-full rounded border px-2 py-1.5"
              style={inputStyle}
            />
          </div>
        ) : null}
        {activeOption && isLocked && activeOption.description ? <p className="mb-2" style={muted}>{activeOption.description}</p> : null}
        {!activeOption ? (
          <p className="mb-2" style={muted}>
            These lines are in every option - e.g. a call-out fee - and are added to whichever option the client picks.
          </p>
        ) : null}

        {isLocked ? (
          <LineItemSummary items={sectionLines(lineItems, activeKey)} membershipDiscountCents={0} />
        ) : (
          <LineItemEditor
            key={active}
            items={sectionLines(lineItems, activeKey)}
            onChange={(section) => onLineItemsChange(replaceSection(lineItems, activeKey, section))}
            membershipDiscountCents={0}
            tenantId={tenantId}
          />
        )}
      </div>
    </div>
  );
}
