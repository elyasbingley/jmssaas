import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  computeLineItemUnitPriceCents,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type LineItemBundle,
  type LineItemBundleItem,
  type LineItemCrewInput,
  type LineItemFormInput,
  type LineItemMaterialInput,
  type OperatingExpense,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { emptyLineItem, normalizeLineItem } from "../lib/line-items";
import { ThemedModal } from "./theme/ThemedModal";

interface AddLineItemBarProps {
  itemCount: number;
  onAdd: (item: LineItemFormInput) => void;
  onAddMany: (items: LineItemFormInput[]) => void;
}

type BundleItemRow = LineItemBundleItem & { price_book_items: PriceBookItem | null };

async function fetchBundles(): Promise<LineItemBundle[]> {
  const { data, error } = await supabase.from("line_item_bundles").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as LineItemBundle[];
}

async function fetchBundleItems(bundleId: string): Promise<BundleItemRow[]> {
  // price_book_items(*) rather than a hand-picked column list - the
  // itemized breakdown has grown enough fields (see the price_book_
  // itemized_pricing migration) that listing them individually here would
  // just be a second place to keep in sync with that table's own columns.
  const { data, error } = await supabase
    .from("line_item_bundle_items")
    .select("*, price_book_items(*)")
    .eq("bundle_id", bundleId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return data as unknown as BundleItemRow[];
}

// A catalogue item/variation's crew/materials aren't embedded in its own
// row - separate child tables. Only fetched when the source is actually
// itemized (see the two call sites below).
async function fetchPriceBookItemChildren(itemId: string): Promise<{ crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }> {
  const [{ data: crew }, { data: materials }] = await Promise.all([
    supabase.from("price_book_item_crew").select("*").eq("price_book_item_id", itemId).order("sort_order"),
    supabase.from("price_book_item_materials").select("*").eq("price_book_item_id", itemId).order("sort_order"),
  ]);
  return { crew: (crew ?? []) as LineItemCrewInput[], materials: (materials ?? []) as LineItemMaterialInput[] };
}

async function fetchPriceBookVariationChildren(variationId: string): Promise<{ crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }> {
  const [{ data: crew }, { data: materials }] = await Promise.all([
    supabase.from("price_book_item_variation_crew").select("*").eq("price_book_item_variation_id", variationId).order("sort_order"),
    supabase.from("price_book_item_variation_materials").select("*").eq("price_book_item_variation_id", variationId).order("sort_order"),
  ]);
  return { crew: (crew ?? []) as LineItemCrewInput[], materials: (materials ?? []) as LineItemMaterialInput[] };
}

// The itemized scalar fields a line can inherit from whichever catalogue
// row (item or variation) actually supplies the price - see the mobile
// port of this file for the full reasoning (same function, same comment).
function itemizedFieldsFrom(sourceItem: PriceBookItem | PriceBookItemVariation, children: { crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }) {
  if (sourceItem.pricing_model !== "itemized") return {};
  return {
    pricing_model: "itemized" as const,
    quantity: sourceItem.quantity ?? 1,
    labour_cost_rate_cents: sourceItem.labour_cost_rate_cents ?? undefined,
    labour_charge_out_rate_cents: sourceItem.labour_charge_out_rate_cents ?? undefined,
    crew: children.crew,
    materials: children.materials,
    material_margin_percent: sourceItem.material_margin_percent ?? undefined,
    subcontractor_margin_percent: sourceItem.subcontractor_margin_percent ?? undefined,
    waste_percent: sourceItem.waste_percent ?? undefined,
    contingency_percent: sourceItem.contingency_percent ?? undefined,
    tip_fees_cents: sourceItem.tip_fees_cents ?? undefined,
    equipment_hire_cents: sourceItem.equipment_hire_cents ?? undefined,
    travel_cost_cents: sourceItem.travel_cost_cents ?? undefined,
    is_subcontracted: sourceItem.is_subcontracted ?? false,
    subcontractor_cost_cents: sourceItem.subcontractor_cost_cents ?? 0,
  };
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
export function AddLineItemBar({ itemCount, onAdd, onAddMany }: AddLineItemBarProps) {
  const { data: bundles } = useQuery({ queryKey: ["line-item-bundles"], queryFn: fetchBundles });
  const [bundlePickerOpen, setBundlePickerOpen] = useState(false);
  const [applyingBundleId, setApplyingBundleId] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  // Inserts every member item of the bundle in one onAddMany call (never
  // repeated onAdd calls - see LineItemEditor's own onAddMany, added
  // specifically because looping onAdd here would only ever add the LAST
  // item: every call in the loop closes over the same stale `items` array
  // from this render, so each one's [...items, item] discards whatever the
  // previous call in the same loop just added). A catalogue-linked item
  // (price_book_item_id set) always uses that item's CURRENT price_book_items
  // row, fetched fresh here, never a value frozen when the bundle was
  // authored. Every inserted item gets bundle_name set to the bundle's own
  // name, so they show grouped under a heading on the PDF/approval page
  // (see the optional_bundled_line_items migration).
  const applyBundle = async (bundle: LineItemBundle) => {
    setApplyingBundleId(bundle.id);
    setBundleError(null);
    try {
      const rows = await fetchBundleItems(bundle.id);
      const newItems = await Promise.all(
        rows.map(async (row, index) => {
          const priceBookItem = row.price_book_items;
          const children =
            priceBookItem && priceBookItem.pricing_model === "itemized" ? await fetchPriceBookItemChildren(priceBookItem.id) : { crew: [], materials: [] };
          const breakdown = priceBookItem
            ? {
                description: priceBookItem.description,
                labour_rate_cents: priceBookItem.labour_rate_cents,
                labour_hours: priceBookItem.labour_hours,
                material_cost_cents: priceBookItem.material_cost_cents,
                markup_percent: priceBookItem.markup_percent,
                unit: priceBookItem.unit,
                warranty_text: priceBookItem.warranty_text,
                gst_applicable: priceBookItem.gst_applicable ?? true,
                ...itemizedFieldsFrom(priceBookItem, children),
              }
            : {
                description: row.description ?? "",
                labour_rate_cents: row.labour_rate_cents,
                labour_hours: row.labour_hours,
                material_cost_cents: row.material_cost_cents,
                markup_percent: row.markup_percent,
              };
          // See the mobile port's own comment on why an itemized catalogue
          // item keeps its own benchmark quantity rather than the bundle's
          // row.quantity multiplier.
          const resolvedQuantity = priceBookItem?.pricing_model === "itemized" ? priceBookItem.quantity ?? 1 : row.quantity;
          return normalizeLineItem({ ...breakdown, quantity: resolvedQuantity, bundle_name: bundle.name }, itemCount + index);
        })
      );
      onAddMany(newItems);
      setBundlePickerOpen(false);
    } catch (e) {
      setBundleError(e instanceof Error ? e.message : "Failed to add bundle");
    } finally {
      setApplyingBundleId(null);
    }
  };


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

  const addFromPriceBookItem = async (item: PriceBookItem, variation?: PriceBookItemVariation) => {
    const sourceItem = variation ?? item;
    const children =
      sourceItem.pricing_model === "itemized"
        ? variation
          ? await fetchPriceBookVariationChildren(variation.id)
          : await fetchPriceBookItemChildren(item.id)
        : { crew: [], materials: [] };
    const source = {
      description: variation ? `${item.description} (${variation.name})` : item.description,
      labour_rate_cents: sourceItem.labour_rate_cents,
      labour_hours: sourceItem.labour_hours,
      material_cost_cents: sourceItem.material_cost_cents,
      markup_percent: sourceItem.markup_percent,
      is_callout_fee: item.is_callout_fee ?? false,
      unit: sourceItem.unit ?? item.unit,
      warranty_text: sourceItem.warranty_text ?? item.warranty_text,
      gst_applicable: sourceItem.gst_applicable ?? true,
      ...itemizedFieldsFrom(sourceItem, children),
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
      await addFromPriceBookItem(item);
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
        className="w-full rounded-md border px-3 py-2 focus:outline-none"
        style={{
          backgroundColor: "var(--jms-bg)",
          borderColor: "var(--jms-border)",
          color: "var(--jms-text)",
          fontFamily: "var(--jms-font)",
          fontSize: "var(--jms-font-body)",
        }}
        placeholder="Search Price Book (3+ characters) or leave blank for custom item"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching ? (
        <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Searching...
        </p>
      ) : null}

      {results.length > 0 ? (
        <div className="mt-2 overflow-hidden rounded-md border" style={{ borderColor: "var(--jms-border)" }}>
          {results.map((item) => (
            <button
              key={item.id}
              onClick={() => handleSelectResult(item)}
              className="jms-nav-link block w-full truncate border-b px-3 py-2 text-left last:border-0"
              style={{ borderColor: "var(--jms-border)", fontSize: "var(--jms-font-body)" }}
            >
              {item.description}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-4">
        <button
          onClick={addCustomItem}
          className="font-semibold hover:underline"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          {query.trim().length > 0 ? "+ Add as custom item instead" : "+ Add custom item"}
        </button>
        {bundles && bundles.length > 0 ? (
          <button
            onClick={() => setBundlePickerOpen(true)}
            className="font-semibold hover:underline"
            style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
          >
            + Add from bundle
          </button>
        ) : null}
      </div>

      <ThemedModal open={bundlePickerOpen} onClose={() => setBundlePickerOpen(false)} title="Add from bundle">
        {bundleError ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {bundleError}
          </p>
        ) : null}
        {(bundles ?? []).map((bundle) => (
          <button
            key={bundle.id}
            onClick={() => applyBundle(bundle)}
            disabled={applyingBundleId === bundle.id}
            className="jms-nav-link block w-full border-b py-3 text-left last:border-0 disabled:opacity-50"
            style={{ borderColor: "var(--jms-border)", fontSize: "var(--jms-font-body)" }}
          >
            {applyingBundleId === bundle.id ? "Adding..." : bundle.name}
          </button>
        ))}
      </ThemedModal>

      <ThemedModal open={!!variationTarget} onClose={() => setVariationTarget(null)} title="Select a variation">
        <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          {variationTarget?.description}
        </p>
        <button
          onClick={() => variationTarget && addFromPriceBookItem(variationTarget)}
          className="jms-nav-link block w-full border-b py-3 text-left"
          style={{ borderColor: "var(--jms-border)", fontSize: "var(--jms-font-body)" }}
        >
          Base pricing (no variation)
        </button>
        {variations.map((variation) => (
          <button
            key={variation.id}
            onClick={() => variationTarget && addFromPriceBookItem(variationTarget, variation)}
            className="jms-nav-link block w-full border-b py-3 text-left last:border-0"
            style={{ borderColor: "var(--jms-border)", fontSize: "var(--jms-font-body)" }}
          >
            {variation.name}
          </button>
        ))}
      </ThemedModal>
    </div>
  );
}
