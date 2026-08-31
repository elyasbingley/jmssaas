import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  computeLineItemUnitPriceCents,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type LineItemFormInput,
  type OperatingExpense,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { emptyLineItem, normalizeLineItem } from "../lib/line-items";
import { Modal } from "./Modal";

interface AddLineItemBarProps {
  itemCount: number;
  onAdd: (item: LineItemFormInput) => void;
}

async function fetchCostOfOpsSettings(): Promise<CostOfOpsSettings | null> {
  const { data } = await supabase.from("cost_of_ops_settings").select("*").maybeSingle();
  return data as CostOfOpsSettings | null;
}
async function fetchOperatingExpenses(): Promise<OperatingExpense[]> {
  const { data } = await supabase.from("operating_expenses").select("*");
  return (data ?? []) as OperatingExpense[];
}
async function fetchLabourCostEntries(): Promise<LabourCostEntry[]> {
  const { data } = await supabase.from("labour_cost_entries").select("*");
  return (data ?? []) as LabourCostEntry[];
}

// Port of apps/mobile/components/AddLineItemBar.tsx - same debounced
// price_book_items search (3+ characters, ilike on description),
// variation picker, and "add as custom item" fallback.
export function AddLineItemBar({ itemCount, onAdd }: AddLineItemBarProps) {
  // Cost of Ops's (Team) Hourly COO, adjusted for estimated efficiency - the
  // business's actual blended labour cost per hour, once that module has
  // been filled out. Suggested as the starting Labour Rate on a brand new
  // custom line item only (a price-book-linked item keeps its own catalog
  // rate, untouched). Silently stays 0 (blank, same as before this existed)
  // whenever cost_of_ops_settings isn't there yet - including for a
  // technician's session, since that table's RLS is admin-only and simply
  // returns no rows rather than an error.
  const { data: costOfOpsSettings } = useQuery({ queryKey: ["cost-of-ops-settings"], queryFn: fetchCostOfOpsSettings });
  const { data: operatingExpenses } = useQuery({
    queryKey: ["operating-expenses"],
    queryFn: fetchOperatingExpenses,
    enabled: !!costOfOpsSettings,
  });
  const { data: labourCostEntries } = useQuery({
    queryKey: ["labour-cost-entries"],
    queryFn: fetchLabourCostEntries,
    enabled: !!costOfOpsSettings,
  });

  let suggestedLabourRateCents = 0;
  if (costOfOpsSettings && operatingExpenses && labourCostEntries) {
    const opex = calculateOperatingExpenses(operatingExpenses, costOfOpsSettings);
    const labour = calculateLabour(labourCostEntries, costOfOpsSettings);
    const coo = calculateCostOfOperations(opex, labour, costOfOpsSettings);
    if (Number.isFinite(coo.hourlyCooAdjustedCents) && coo.hourlyCooAdjustedCents > 0) {
      suggestedLabourRateCents = Math.round(coo.hourlyCooAdjustedCents);
    }
  }

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PriceBookItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [variationTarget, setVariationTarget] = useState<PriceBookItem | null>(null);
  const [variations, setVariations] = useState<PriceBookItemVariation[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timeout = setTimeout(async () => {
      const { data, error } = await supabase
        .from("price_book_items")
        .select("*")
        .ilike("description", `%${trimmed}%`)
        .order("description")
        .limit(20);
      if (!cancelled) {
        setResults(error ? [] : ((data ?? []) as PriceBookItem[]));
        setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  const addFromPriceBookItem = (item: PriceBookItem, variation?: PriceBookItemVariation) => {
    const source = variation
      ? {
          description: `${item.description} (${variation.name})`,
          labour_rate_cents: variation.labour_rate_cents,
          labour_hours: variation.labour_hours,
          material_cost_cents: variation.material_cost_cents,
          markup_percent: variation.markup_percent,
          is_callout_fee: item.is_callout_fee ?? false,
        }
      : {
          description: item.description,
          labour_rate_cents: item.labour_rate_cents,
          labour_hours: item.labour_hours,
          material_cost_cents: item.material_cost_cents,
          markup_percent: item.markup_percent,
          is_callout_fee: item.is_callout_fee ?? false,
        };
    onAdd(normalizeLineItem(source, itemCount));
    setQuery("");
    setResults([]);
    setVariationTarget(null);
  };

  const handleSelectResult = async (item: PriceBookItem) => {
    const { data, error } = await supabase
      .from("price_book_item_variations")
      .select("*")
      .eq("price_book_item_id", item.id)
      .order("sort_order")
      .order("name");
    const itemVariations = error ? [] : ((data ?? []) as PriceBookItemVariation[]);
    if (itemVariations.length > 0) {
      setVariations(itemVariations);
      setVariationTarget(item);
    } else {
      addFromPriceBookItem(item);
    }
  };

  const addCustomItem = () => {
    const base = emptyLineItem(itemCount);
    const item = suggestedLabourRateCents > 0 ? { ...base, labour_rate_cents: suggestedLabourRateCents } : base;
    onAdd({ ...item, unit_price_cents: computeLineItemUnitPriceCents(item) });
    setQuery("");
    setResults([]);
  };

  return (
    <div className="mb-4">
      <input
        type="text"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        placeholder="Search Price Book (3+ characters) or leave blank for custom item"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching ? <p className="mt-1 text-xs text-gray-400">Searching...</p> : null}

      {results.length > 0 ? (
        <div className="mt-2 overflow-hidden rounded-md border border-gray-300">
          {results.map((item) => (
            <button
              key={item.id}
              onClick={() => handleSelectResult(item)}
              className="block w-full truncate border-b border-gray-200 px-3 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
            >
              {item.description}
            </button>
          ))}
        </div>
      ) : null}

      <button onClick={addCustomItem} className="mt-2 text-sm font-semibold text-blue-700 hover:underline">
        {query.trim().length > 0 ? "+ Add as custom item instead" : "+ Add custom item"}
      </button>

      <Modal open={!!variationTarget} onClose={() => setVariationTarget(null)} title="Select a variation">
        <p className="mb-3 text-sm text-gray-500">{variationTarget?.description}</p>
        <button
          onClick={() => variationTarget && addFromPriceBookItem(variationTarget)}
          className="block w-full border-b border-gray-200 py-3 text-left text-sm hover:bg-gray-50"
        >
          Base pricing (no variation)
        </button>
        {variations.map((variation) => (
          <button
            key={variation.id}
            onClick={() => variationTarget && addFromPriceBookItem(variationTarget, variation)}
            className="block w-full border-b border-gray-200 py-3 text-left text-sm last:border-0 hover:bg-gray-50"
          >
            {variation.name}
          </button>
        ))}
      </Modal>
    </div>
  );
}
