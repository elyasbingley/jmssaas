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
  type LineItemCrewInput,
  type LineItemFormInput,
  type LineItemMaterialInput,
  type OperatingExpense,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { emptyLineItem, normalizeLineItem } from "../lib/line-items";
import { CenteredModal } from "./CenteredModal";
import { useTheme } from "../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

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
// row - separate child tables (price_book_item_crew/materials, or the
// _variation_ equivalents). Only fetched when the source is actually
// itemized (see the two call sites below) - a legacy item has nothing
// there to fetch.
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
// row (item or variation) actually supplies the price - factored out so
// applyBundle/addFromPriceBookItem don't each repeat the same ~15-field
// spread by hand.
function itemizedFieldsFrom(sourceItem: PriceBookItem | PriceBookItemVariation, children: { crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }) {
  if (sourceItem.pricing_model !== "itemized") return {};
  return {
    pricing_model: "itemized" as const,
    // The new quote/invoice line's quantity has to start at the
    // catalogue's own benchmark denominator, not the usual blank-line
    // default of 1 - crew/materials below carry absolute totals (e.g.
    // "14 hours, 70 units of material"), priced at that benchmark
    // quantity (see computeItemizedLinePricing's own comment: unit price
    // = total charge / quantity). Starting the new line at quantity=1
    // would divide those same absolute totals by 1 instead of 70,
    // inflating the per-unit price ~70x. Quantity=70 reproduces the
    // catalogue's own price exactly; the admin can still edit it from
    // there like any other field.
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

// Matches the reference design's "Search Price Book (3+ characters) or
// leave blank for custom item" field: searches price_book_items live
// (debounced, description ilike) as the admin types, and selecting a result
// - optionally picking one of its variations - pre-fills a new line item
// from that catalogue entry. Leaving the search blank and tapping "Add
// custom item" falls through to a fully blank line item, exactly like
// before this control existed.
export function AddLineItemBar({ itemCount, onAdd, onAddMany }: AddLineItemBarProps) {
  const styles = useThemedStyles(createStyles);
  const { tokens } = useTheme();
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
          // A legacy item's per-unit price scales cleanly with any
          // quantity, so the bundle's own row.quantity (how many of this
          // item the bundle adds) is used directly, same as always. An
          // itemized item's crew/materials are absolute totals priced at
          // its own benchmark quantity (see itemizedFieldsFrom's own
          // comment) - multiplying that benchmark by an unrelated bundle
          // count has no well-defined meaning, so the catalogue's own
          // quantity wins instead; a bundle multiplier on an itemized
          // catalogue item is a rare enough combination that this is a
          // reasonable place to simplify rather than invent a scaling rule.
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
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Search Price Book (3+ characters) or leave blank for custom item"
        placeholderTextColor={styles.placeholder.color}
        value={query}
        onChangeText={setQuery}
      />
      {searching ? <ActivityIndicator style={styles.spinner} color={tokens.accent} /> : null}

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

function createStyles({ tokens, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { marginBottom: 12 },
    input: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 8,
      padding: 12,
      fontSize: 15,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    placeholder: { color: tokens.textMuted },
    spinner: { marginTop: 8 },
    results: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, marginTop: 8, overflow: "hidden" as const, backgroundColor: tokens.surface },
    resultRow: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    resultText: { fontSize: 14, color: tokens.textPrimary, ...mono },
    addButtonRow: { flexDirection: "row" as const, gap: 20 },
    addButton: { alignSelf: "flex-start" as const, paddingVertical: 8 },
    addButtonText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    bundleError: { color: tokens.danger, marginBottom: 8, ...mono },
    modalTitle: {
      fontSize: 18,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    modalSubtitle: { color: tokens.textMuted, marginBottom: 4, ...mono },
    variationRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    variationRowText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    modalCancel: { marginTop: 8, alignSelf: "flex-end" as const },
    modalCancelText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
  };
}
