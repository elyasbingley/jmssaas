import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  computeItemizedLinePricing,
  computeLineItemUnitPriceCents,
  createLineItemBundleItemSchema,
  formatCentsAsAud,
  type LineItemBundle,
  type LineItemBundleItem,
  type LineItemCrewInput,
  type LineItemMaterialInput,
  type PriceBookItem,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

// Full price_book_items(*) rather than a hand-picked legacy-only column
// list - this page used to only ever select labour_rate_cents/labour_
// hours/material_cost_cents/markup_percent, so a bundle item linked to an
// itemized catalogue item (crew/materials breakdown, price_book_itemized_
// pricing migration) always priced at $0 here, even though AddLineItemBar
// (which actually applies a bundle to a quote/invoice) already costs it
// correctly - this page's own display/edit preview just never got the
// same fix.
type BundleItemRow = LineItemBundleItem & { price_book_items: PriceBookItem | null };

async function fetchBundle(id: string): Promise<LineItemBundle> {
  const { data, error } = await supabase.from("line_item_bundles").select("*").eq("id", id).single();
  if (error) throw error;
  return data as LineItemBundle;
}

async function fetchBundleItems(bundleId: string): Promise<BundleItemRow[]> {
  const { data, error } = await supabase
    .from("line_item_bundle_items")
    .select("*, price_book_items(*)")
    .eq("bundle_id", bundleId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return data as unknown as BundleItemRow[];
}

// A catalogue item's crew/materials aren't embedded in its own row -
// separate child tables (same split AddLineItemBar.tsx already fetches
// from for the exact same reason). Only fetched for items that are
// actually itemized.
async function fetchPriceBookItemChildren(itemId: string): Promise<{ crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }> {
  const [{ data: crew }, { data: materials }] = await Promise.all([
    supabase.from("price_book_item_crew").select("*").eq("price_book_item_id", itemId).order("sort_order"),
    supabase.from("price_book_item_materials").select("*").eq("price_book_item_id", itemId).order("sort_order"),
  ]);
  return { crew: (crew ?? []) as LineItemCrewInput[], materials: (materials ?? []) as LineItemMaterialInput[] };
}

// A single breakdown shape covering both pricing models - legacy fields
// always present (0 when irrelevant), itemized fields only meaningful
// when pricing_model is "itemized". Mirrors AddLineItemBar's
// itemizedFieldsFrom output shape so the two pages compute price
// identically for the same catalogue item.
interface ResolvedBreakdown {
  description: string;
  labour_rate_cents: number;
  labour_hours: number;
  material_cost_cents: number;
  markup_percent: number;
  pricing_model?: "legacy" | "itemized";
  quantity?: number;
  labour_cost_rate_cents?: number;
  labour_charge_out_rate_cents?: number;
  crew?: LineItemCrewInput[];
  materials?: LineItemMaterialInput[];
  material_margin_percent?: number;
  subcontractor_margin_percent?: number;
  waste_percent?: number;
  contingency_percent?: number;
  tip_fees_cents?: number;
  equipment_hire_cents?: number;
  travel_cost_cents?: number;
  is_subcontracted?: boolean;
  subcontractor_cost_cents?: number;
}

function priceBookBreakdown(
  item: PriceBookItem,
  children: { crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }
): ResolvedBreakdown {
  const base: ResolvedBreakdown = {
    description: item.description,
    labour_rate_cents: item.labour_rate_cents,
    labour_hours: item.labour_hours,
    material_cost_cents: item.material_cost_cents,
    markup_percent: item.markup_percent,
  };
  if (item.pricing_model !== "itemized") return base;
  return {
    ...base,
    pricing_model: "itemized",
    quantity: item.quantity ?? 1,
    labour_cost_rate_cents: item.labour_cost_rate_cents ?? undefined,
    labour_charge_out_rate_cents: item.labour_charge_out_rate_cents ?? undefined,
    crew: children.crew,
    materials: children.materials,
    material_margin_percent: item.material_margin_percent ?? undefined,
    subcontractor_margin_percent: item.subcontractor_margin_percent ?? undefined,
    waste_percent: item.waste_percent ?? undefined,
    contingency_percent: item.contingency_percent ?? undefined,
    tip_fees_cents: item.tip_fees_cents ?? undefined,
    equipment_hire_cents: item.equipment_hire_cents ?? undefined,
    travel_cost_cents: item.travel_cost_cents ?? undefined,
    is_subcontracted: item.is_subcontracted ?? false,
    subcontractor_cost_cents: item.subcontractor_cost_cents ?? 0,
  };
}

function unitPriceCentsFor(breakdown: ResolvedBreakdown): number {
  if (breakdown.pricing_model === "itemized") {
    return computeItemizedLinePricing({ ...breakdown, quantity: breakdown.quantity ?? 1 }).unitPriceCents;
  }
  return computeLineItemUnitPriceCents(breakdown);
}

function resolvedBreakdown(row: BundleItemRow, childrenByPriceBookItemId: Map<string, { crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] }>): ResolvedBreakdown {
  if (row.price_book_items) {
    const children = childrenByPriceBookItemId.get(row.price_book_items.id) ?? { crew: [], materials: [] };
    return priceBookBreakdown(row.price_book_items, children);
  }
  return {
    description: row.description ?? "",
    labour_rate_cents: row.labour_rate_cents,
    labour_hours: row.labour_hours,
    material_cost_cents: row.material_cost_cents,
    markup_percent: row.markup_percent,
  };
}

const emptyItemForm = {
  mode: "custom" as "custom" | "price_book",
  priceBookItemId: "",
  priceBookItemDescription: "",
  priceBookItemBreakdown: null as ResolvedBreakdown | null,
  description: "",
  labourRate: "0",
  labourHours: "0",
  materialCost: "0",
  markupPercent: "0",
  quantity: "1",
};

export default function BundleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: bundle } = useQuery({ queryKey: ["line-item-bundle", id], queryFn: () => fetchBundle(id!), enabled: !!id });
  const { data: items } = useQuery({ queryKey: ["line-item-bundle-items", id], queryFn: () => fetchBundleItems(id!), enabled: !!id });

  // Crew/materials for every itemized catalogue item this bundle actually
  // references - fetched once per bundle load rather than per row, keyed
  // by price_book_item_id so both the list display and the edit-item
  // preview below can share it.
  const itemizedPriceBookItemIds = (items ?? [])
    .map((row) => row.price_book_items)
    .filter((pb): pb is PriceBookItem => !!pb && pb.pricing_model === "itemized")
    .map((pb) => pb.id);
  const uniqueItemizedIds = [...new Set(itemizedPriceBookItemIds)];
  const { data: priceBookChildrenEntries } = useQuery({
    queryKey: ["line-item-bundle-price-book-children", uniqueItemizedIds.join(",")],
    queryFn: async () => Promise.all(uniqueItemizedIds.map(async (itemId) => [itemId, await fetchPriceBookItemChildren(itemId)] as const)),
    enabled: uniqueItemizedIds.length > 0,
  });
  const childrenByPriceBookItemId = new Map(priceBookChildrenEntries ?? []);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["line-item-bundle-items", id] });
    queryClient.invalidateQueries({ queryKey: ["line-item-bundles"] });
  };

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (bundle) setRenameValue(bundle.name);
  }, [bundle]);

  const rename = useMutation({
    mutationFn: async () => {
      if (!renameValue.trim()) throw new Error("Name is required");
      const { error } = await supabase.from("line_item_bundles").update({ name: renameValue.trim() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["line-item-bundle", id] });
      queryClient.invalidateQueries({ queryKey: ["line-item-bundles"] });
      setRenameOpen(false);
    },
    onError: (e) => setRenameError(getErrorMessage(e, "Failed to rename bundle")),
  });

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<BundleItemRow | null>(null);
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [itemError, setItemError] = useState<string | null>(null);
  const [pbQuery, setPbQuery] = useState("");
  const [pbResults, setPbResults] = useState<PriceBookItem[]>([]);

  useEffect(() => {
    const trimmed = pbQuery.trim();
    if (trimmed.length < 3) {
      setPbResults([]);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(async () => {
      const { data, error } = await supabase.from("price_book_items").select("*").ilike("description", `%${trimmed}%`).order("description").limit(20);
      if (!cancelled) setPbResults(error ? [] : ((data ?? []) as PriceBookItem[]));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [pbQuery]);

  const openNewItem = () => {
    setEditingItem(null);
    setItemForm(emptyItemForm);
    setPbQuery("");
    setPbResults([]);
    setItemError(null);
    setItemModalOpen(true);
  };
  const openEditItem = (row: BundleItemRow) => {
    setEditingItem(row);
    setItemForm({
      mode: row.price_book_item_id ? "price_book" : "custom",
      priceBookItemId: row.price_book_item_id ?? "",
      priceBookItemDescription: row.price_book_items?.description ?? "",
      priceBookItemBreakdown: row.price_book_items
        ? priceBookBreakdown(row.price_book_items, childrenByPriceBookItemId.get(row.price_book_items.id) ?? { crew: [], materials: [] })
        : null,
      description: row.description ?? "",
      labourRate: String(row.labour_rate_cents / 100),
      labourHours: String(row.labour_hours),
      materialCost: String(row.material_cost_cents / 100),
      markupPercent: String(row.markup_percent),
      quantity: String(row.quantity),
    });
    setPbQuery("");
    setPbResults([]);
    setItemError(null);
    setItemModalOpen(true);
  };

  const previewCents =
    itemForm.mode === "price_book"
      ? itemForm.priceBookItemBreakdown
        ? unitPriceCentsFor(itemForm.priceBookItemBreakdown)
        : null
      : computeLineItemUnitPriceCents({
          labour_rate_cents: Math.round(parseNumber(itemForm.labourRate) * 100),
          labour_hours: parseNumber(itemForm.labourHours),
          material_cost_cents: Math.round(parseNumber(itemForm.materialCost) * 100),
          markup_percent: parseNumber(itemForm.markupPercent),
        });

  const saveItem = useMutation({
    mutationFn: async () => {
      const result = createLineItemBundleItemSchema.safeParse({
        bundle_id: id,
        price_book_item_id: itemForm.mode === "price_book" ? itemForm.priceBookItemId || undefined : undefined,
        description: itemForm.mode === "custom" ? itemForm.description : undefined,
        labour_rate_cents: itemForm.mode === "custom" ? Math.round(parseNumber(itemForm.labourRate) * 100) : 0,
        labour_hours: itemForm.mode === "custom" ? parseNumber(itemForm.labourHours) : 0,
        material_cost_cents: itemForm.mode === "custom" ? Math.round(parseNumber(itemForm.materialCost) * 100) : 0,
        markup_percent: itemForm.mode === "custom" ? parseNumber(itemForm.markupPercent) : 0,
        quantity: parseNumber(itemForm.quantity) || 1,
        sort_order: items?.length ?? 0,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      if (editingItem) {
        const { error } = await supabase
          .from("line_item_bundle_items")
          .update({
            price_book_item_id: result.data.price_book_item_id ?? null,
            description: result.data.description || null,
            labour_rate_cents: result.data.labour_rate_cents,
            labour_hours: result.data.labour_hours,
            material_cost_cents: result.data.material_cost_cents,
            markup_percent: result.data.markup_percent,
            quantity: result.data.quantity,
          })
          .eq("id", editingItem.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("line_item_bundle_items").insert({
          tenant_id: profile.tenant_id,
          bundle_id: result.data.bundle_id,
          price_book_item_id: result.data.price_book_item_id ?? null,
          description: result.data.description || null,
          labour_rate_cents: result.data.labour_rate_cents,
          labour_hours: result.data.labour_hours,
          material_cost_cents: result.data.material_cost_cents,
          markup_percent: result.data.markup_percent,
          quantity: result.data.quantity,
          sort_order: result.data.sort_order,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidate();
      setItemModalOpen(false);
    },
    onError: (e) => setItemError(getErrorMessage(e, "Failed to save item")),
  });

  const deleteItem = useMutation({
    mutationFn: async (row: BundleItemRow) => {
      const { error } = await supabase.from("line_item_bundle_items").delete().eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const canSaveItem = itemForm.mode === "price_book" ? !!itemForm.priceBookItemId : itemForm.description.trim().length > 0;

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings/bundles" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Bundles
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          {bundle?.name ?? ""}
        </h1>
        <button onClick={() => setRenameOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          Rename
        </button>
      </div>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {!items || items.length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No items yet in this bundle.
          </p>
        ) : (
          items.map((row) => {
            const breakdown = resolvedBreakdown(row, childrenByPriceBookItemId);
            const unitPriceCents = unitPriceCentsFor(breakdown);
            return (
              <button
                key={row.id}
                onClick={() => openEditItem(row)}
                className="jms-nav-link flex w-full items-center justify-between gap-3 p-3 text-left last:border-0"
                style={{ borderBottom: "1px solid var(--jms-border)" }}
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                    {breakdown.description}
                  </p>
                  <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    Qty {row.quantity} &times; {formatCentsAsAud(unitPriceCents)}
                    {row.price_book_item_id ? " (from Price Book)" : ""}
                  </p>
                </div>
                <span className="flex-shrink-0 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {formatCentsAsAud(unitPriceCents * row.quantity)}
                </span>
              </button>
            );
          })
        )}
      </div>
      <ThemedButton onClick={openNewItem} className="mt-3 w-full" style={{ paddingBlock: 12, paddingInline: 24 }}>
        + New item
      </ThemedButton>

      <ThemedModal open={renameOpen} onClose={() => setRenameOpen(false)} title="Rename bundle">
        <ThemedFormField label="Name" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
        {renameError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {renameError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setRenameOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => rename.mutate()} disabled={rename.isPending}>
            {rename.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={itemModalOpen} onClose={() => setItemModalOpen(false)} title={editingItem ? "Edit item" : "New item"}>
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setItemForm({ ...itemForm, mode: "custom" })}
            className="flex-1 rounded px-3 py-2 font-semibold"
            style={
              itemForm.mode === "custom"
                ? { backgroundColor: "var(--jms-accent-glow)", border: "1px solid var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                : { backgroundColor: "transparent", border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
            }
          >
            Custom item
          </button>
          <button
            type="button"
            onClick={() => setItemForm({ ...itemForm, mode: "price_book" })}
            className="flex-1 rounded px-3 py-2 font-semibold"
            style={
              itemForm.mode === "price_book"
                ? { backgroundColor: "var(--jms-accent-glow)", border: "1px solid var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                : { backgroundColor: "transparent", border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
            }
          >
            From Price Book
          </button>
        </div>

        {itemForm.mode === "price_book" ? (
          <div className="mb-4">
            {itemForm.priceBookItemId ? (
              <div
                className="mb-2 flex items-center justify-between rounded px-3 py-2"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", fontSize: "var(--jms-font-body)" }}
              >
                <span className="truncate font-semibold" style={{ color: "var(--jms-text)" }}>
                  {itemForm.priceBookItemDescription}
                </span>
                <button
                  onClick={() => setItemForm({ ...itemForm, priceBookItemId: "", priceBookItemDescription: "", priceBookItemBreakdown: null })}
                  className="ml-2 flex-shrink-0 font-semibold"
                  style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  className="w-full rounded border px-3 py-2 focus:outline-none"
                  style={{
                    backgroundColor: "var(--jms-bg)",
                    borderColor: "var(--jms-border)",
                    color: "var(--jms-text)",
                    fontFamily: "var(--jms-font)",
                    fontSize: "var(--jms-font-body)",
                  }}
                  placeholder="Search Price Book (3+ characters)"
                  value={pbQuery}
                  onChange={(e) => setPbQuery(e.target.value)}
                />
                {pbResults.length > 0 ? (
                  <div className="mt-2 overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)" }}>
                    {pbResults.map((pb) => (
                      <button
                        key={pb.id}
                        onClick={async () => {
                          const children = pb.pricing_model === "itemized" ? await fetchPriceBookItemChildren(pb.id) : { crew: [], materials: [] };
                          setItemForm({
                            ...itemForm,
                            priceBookItemId: pb.id,
                            priceBookItemDescription: pb.description,
                            priceBookItemBreakdown: priceBookBreakdown(pb, children),
                          });
                        }}
                        className="jms-nav-link block w-full truncate px-3 py-2 text-left last:border-0"
                        style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                      >
                        {pb.description}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <ThemedFormField
              label="Description"
              value={itemForm.description}
              onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
              placeholder="e.g. 250L Hot Water Unit"
            />
            <div className="grid grid-cols-2 gap-3">
              <ThemedFormField label="Labour rate ($/hr)" value={itemForm.labourRate} onChange={(e) => setItemForm({ ...itemForm, labourRate: e.target.value })} />
              <ThemedFormField label="Labour hours" value={itemForm.labourHours} onChange={(e) => setItemForm({ ...itemForm, labourHours: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ThemedFormField label="Material cost ($)" value={itemForm.materialCost} onChange={(e) => setItemForm({ ...itemForm, materialCost: e.target.value })} />
              <ThemedFormField label="Markup (%)" value={itemForm.markupPercent} onChange={(e) => setItemForm({ ...itemForm, markupPercent: e.target.value })} />
            </div>
          </>
        )}

        <ThemedFormField label="Quantity" value={itemForm.quantity} onChange={(e) => setItemForm({ ...itemForm, quantity: e.target.value })} />

        {previewCents !== null ? (
          <div className="mb-4 rounded p-3" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }}>
            <p className="font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Computed unit price
            </p>
            <p className="text-lg font-extrabold" style={{ color: "var(--jms-accent)" }}>
              {formatCentsAsAud(previewCents)}
            </p>
          </div>
        ) : null}

        {itemError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {itemError}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          {editingItem ? (
            <button
              onClick={() => {
                if (window.confirm("Remove this item from the bundle?")) {
                  deleteItem.mutate(editingItem);
                  setItemModalOpen(false);
                }
              }}
              className="font-semibold hover:underline"
              style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <button onClick={() => setItemModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Cancel
            </button>
            <ThemedButton onClick={() => saveItem.mutate()} disabled={saveItem.isPending || !canSaveItem}>
              {saveItem.isPending ? "Saving..." : "Save"}
            </ThemedButton>
          </div>
        </div>
      </ThemedModal>
    </div>
  );
}
