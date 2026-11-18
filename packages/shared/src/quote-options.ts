// Quote options (Good / Better / Best) - see the quote_options migration.
// A quote line with no option_id is in the shared section and counts
// towards every option.

import { calculateDocumentTotals, type DocumentTotals } from "./money";
import type { LineItemInput, QuoteOption } from "./types";

// What the editors hold for an option before it's saved.
export interface QuoteOptionInput {
  id: string;
  name: string;
  description: string;
  is_recommended: boolean;
  sort_order: number;
}

type WithOption = { option_id?: string | null };
type Totalable = Pick<LineItemInput, "quantity" | "unit_price_cents" | "gst_applicable" | "waived_amount_cents" | "is_optional" | "is_included"> & WithOption;

// The lines in one section: the shared section (null) or one option.
export function sectionLines<T extends WithOption>(items: T[], optionId: string | null): T[] {
  return items.filter((item) => (item.option_id ?? null) === optionId);
}

// Everything that's part of an option: the shared lines plus its own.
export function optionLines<T extends WithOption>(items: T[], optionId: string): T[] {
  return items.filter((item) => !item.option_id || item.option_id === optionId);
}

// An option's total from lines being edited (before saving - the saved
// quote_options row also takes off any membership discount).
export function optionTotals(items: Totalable[], optionId: string): DocumentTotals {
  return calculateDocumentTotals(optionLines(items, optionId));
}

// The option the quote counts as: the chosen one, else the recommended
// one, else the first.
export function headlineOption<T extends Pick<QuoteOption, "id" | "is_recommended" | "sort_order">>(options: T[], chosenOptionId?: string | null): T | null {
  if (!options.length) return null;
  const chosen = chosenOptionId ? options.find((o) => o.id === chosenOptionId) : undefined;
  if (chosen) return chosen;
  const sorted = [...options].sort((a, b) => a.sort_order - b.sort_order);
  return sorted.find((o) => o.is_recommended) ?? sorted[0] ?? null;
}

export function cheapestOption<T extends Pick<QuoteOption, "total_cents">>(options: T[]): T | null {
  return options.reduce<T | null>((best, o) => (best === null || o.total_cents < best.total_cents ? o : best), null);
}

// Puts a section's edited lines back among the rest (each tagged with the
// section), then orders everything shared first and options in order, and
// numbers sort_order from 0 - what's sent to replace_quote_line_items.
export function replaceSection<T extends WithOption & { sort_order: number }>(items: T[], optionId: string | null, sectionItems: T[]): T[] {
  const others = items.filter((item) => (item.option_id ?? null) !== optionId);
  return [...others, ...sectionItems.map((item) => ({ ...item, option_id: optionId }))];
}

export function orderForSave<T extends WithOption & { sort_order: number }>(items: T[], options: Pick<QuoteOptionInput, "id" | "sort_order">[]): T[] {
  const rank = new Map(options.map((o) => [o.id, o.sort_order + 1]));
  const known = (item: T) => (item.option_id && rank.has(item.option_id) ? item.option_id : null);
  return items
    .map((item, index) => ({ item: { ...item, option_id: known(item) }, index }))
    .sort((a, b) => {
      const ra = a.item.option_id ? rank.get(a.item.option_id)! : 0;
      const rb = b.item.option_id ? rank.get(b.item.option_id)! : 0;
      return ra - rb || a.item.sort_order - b.item.sort_order || a.index - b.index;
    })
    .map(({ item }, i) => ({ ...item, sort_order: i }));
}

// A copy of an option (new id) with copies of its lines.
export function duplicateOption<T extends WithOption>(
  items: T[],
  option: QuoteOptionInput,
  newId: string,
  sortOrder: number
): { option: QuoteOptionInput; lines: T[] } {
  return {
    option: { ...option, id: newId, name: `${option.name} (copy)`, is_recommended: false, sort_order: sortOrder },
    lines: sectionLines(items, option.id).map((item) => ({ ...item, option_id: newId })),
  };
}
