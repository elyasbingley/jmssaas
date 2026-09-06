import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  computeLineItemUnitPriceCents,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type LineItemBundle,
  type LineItemBundleItem,
  type LineItemFormInput,
  type OperatingExpense,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { emptyLineItem, normalizeLineItem } from "../lib/line-items";
import { CenteredModal } from "./CenteredModal";

interface AddLineItemBarProps {
  itemCount: number;
  onAdd: (item: LineItemFormInput) => void;
  onAddMany: (items: LineItemFormInput[]) => void;
}

type BundleItemRow = LineItemBundleItem & {
  price_book_items: Pick<PriceBookItem, "description" | "labour_rate_cents" | "labour_hours" | "material_cost_cents" | "markup_percent"> | null;
};

async function fetchBundles(): Promise<LineItemBundle[]> {
  const { data, error } = await supabase.from("line_item_bundles").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as LineItemBundle[];
}

async function fetchBundleItems(bundleId: string): Promise<BundleItemRow[]> {
  const { data, error } = await supabase
    .from("line_item_bundle_items")
    .select("*, price_book_items(description, labour_rate_cents, labour_hours, material_cost_cents, markup_percent)")
    .eq("bundle_id", bundleId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return data as unknown as BundleItemRow[];
}

// Matches the reference design's "Search Price Book (3+ characters) or
// leave blank for custom item" field: searches price_book_items live
// (debounced, description ilike) as the admin types, and selecting a result
// - optionally picking one of its variations - pre-fills a new line item
// from that catalogue entry. Leaving the search blank and tapping "Add
// custom item" falls through to a fully blank line item, exactly like
// before this control existed.
export function AddLineItemBar({ itemCount, onAdd, onAddMany }: AddLineItemBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PriceBookItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [variationTarget, setVariationTarget] = useState<PriceBookItem | null>(null);
  const [variations, setVariations] = useState<PriceBookItemVariation[]>([]);

  const [bundles, setBundles] = useState<LineItemBundle[]>([]);
  const [bundlePickerOpen, setBundlePickerOpen] = useState(false);
  const [applyingBundleId, setApplyingBundleId] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBundles().then((rows) => {
      if (!cancelled) setBundles(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inserts every member item of the bundle in one onAddMany call - see the
  // desktop port of this file for why looping onAdd here would silently
  // drop every item but the last (each call in a tight loop closes over the
  // same stale items array from this render). A catalogue-linked item
  // (price_book_item_id set) always uses that item's CURRENT price_book_items
  // row, fetched fresh here, never a value frozen when the bundle was
  // authored. Every inserted item gets bundle_name set to the bundle's own
  // name, so they show grouped under a heading on the PDF (see the
  // optional_bundled_line_items migration).
  const applyBundle = async (bundle: LineItemBundle) => {
    setApplyingBundleId(bundle.id);
    setBundleError(null);
    try {
      const rows = await fetchBundleItems(bundle.id);
      const newItems = rows.map((row, index) => {
        const breakdown = row.price_book_items
          ? {
              description: row.price_book_items.description,
              labour_rate_cents: row.price_book_items.labour_rate_cents,
              labour_hours: row.price_book_items.labour_hours,
              material_cost_cents: row.price_book_items.material_cost_cents,
              markup_percent: row.price_book_items.markup_percent,
            }
          : {
              description: row.description ?? "",
              labour_rate_cents: row.labour_rate_cents,
              labour_hours: row.labour_hours,
              material_cost_cents: row.material_cost_cents,
              markup_percent: row.markup_percent,
            };
        return normalizeLineItem({ ...breakdown, quantity: row.quantity, bundle_name: bundle.name }, itemCount + index);
      });
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
  const [suggestedLabourRateCents, setSuggestedLabourRateCents] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: settings } = await supabase.from("cost_of_ops_settings").select("*").maybeSingle();
      if (!settings || cancelled) return;
      const [{ data: expenses }, { data: labourEntries }] = await Promise.all([
        supabase.from("operating_expenses").select("*"),
        supabase.from("labour_cost_entries").select("*"),
      ]);
      if (cancelled) return;
      const opex = calculateOperatingExpenses((expenses ?? []) as OperatingExpense[], settings as CostOfOpsSettings);
      const labour = calculateLabour((labourEntries ?? []) as LabourCostEntry[], settings as CostOfOpsSettings);
      const coo = calculateCostOfOperations(opex, labour, settings as CostOfOpsSettings);
      if (Number.isFinite(coo.hourlyCooAdjustedCents) && coo.hourlyCooAdjustedCents > 0) {
        setSuggestedLabourRateCents(Math.round(coo.hourlyCooAdjustedCents));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Search Price Book (3+ characters) or leave blank for custom item"
        value={query}
        onChangeText={setQuery}
      />
      {searching ? <ActivityIndicator style={styles.spinner} /> : null}

      {results.length > 0 ? (
        <View style={styles.results}>
          {results.map((item) => (
            <Pressable key={item.id} style={styles.resultRow} onPress={() => handleSelectResult(item)}>
              <Text style={styles.resultText} numberOfLines={1}>
                {item.description}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.addButtonRow}>
        <Pressable style={styles.addButton} onPress={addCustomItem}>
          <Text style={styles.addButtonText}>
            {query.trim().length > 0 ? "+ Add as custom item instead" : "+ Add custom item"}
          </Text>
        </Pressable>
        {bundles.length > 0 ? (
          <Pressable style={styles.addButton} onPress={() => setBundlePickerOpen(true)}>
            <Text style={styles.addButtonText}>+ Add from bundle</Text>
          </Pressable>
        ) : null}
      </View>

      <CenteredModal visible={bundlePickerOpen} onClose={() => setBundlePickerOpen(false)}>
        <Text style={styles.modalTitle}>Add from bundle</Text>
        {bundleError ? <Text style={styles.bundleError}>{bundleError}</Text> : null}
        {bundles.map((bundle) => (
          <Pressable
            key={bundle.id}
            style={styles.variationRow}
            disabled={applyingBundleId === bundle.id}
            onPress={() => applyBundle(bundle)}
          >
            <Text style={styles.variationRowText}>{applyingBundleId === bundle.id ? "Adding..." : bundle.name}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setBundlePickerOpen(false)} style={styles.modalCancel}>
          <Text style={styles.modalCancelText}>Cancel</Text>
        </Pressable>
      </CenteredModal>

      <CenteredModal visible={!!variationTarget} onClose={() => setVariationTarget(null)}>
        <Text style={styles.modalTitle}>Select a variation</Text>
        <Text style={styles.modalSubtitle}>{variationTarget?.description}</Text>
        <Pressable
          style={styles.variationRow}
          onPress={() => variationTarget && addFromPriceBookItem(variationTarget)}
        >
          <Text style={styles.variationRowText}>Base pricing (no variation)</Text>
        </Pressable>
        {variations.map((variation) => (
          <Pressable
            key={variation.id}
            style={styles.variationRow}
            onPress={() => variationTarget && addFromPriceBookItem(variationTarget, variation)}
          >
            <Text style={styles.variationRowText}>{variation.name}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setVariationTarget(null)} style={styles.modalCancel}>
          <Text style={styles.modalCancelText}>Cancel</Text>
        </Pressable>
      </CenteredModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 15 },
  spinner: { marginTop: 8 },
  results: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, marginTop: 8, overflow: "hidden" },
  resultRow: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  resultText: { fontSize: 14, color: "#111827" },
  addButtonRow: { flexDirection: "row", gap: 20 },
  addButton: { alignSelf: "flex-start", paddingVertical: 8 },
  addButtonText: { color: "#1d4ed8", fontWeight: "600" },
  bundleError: { color: "#dc2626", marginBottom: 8 },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  modalSubtitle: { color: "#6b7280", marginBottom: 4 },
  variationRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  variationRowText: { fontSize: 15, color: "#111827" },
  modalCancel: { marginTop: 8, alignSelf: "flex-end" },
  modalCancelText: { color: "#1d4ed8", fontWeight: "600" },
});
