import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  computeLineItemUnitPriceCents,
  createLineItemBundleItemSchema,
  formatCentsAsAud,
  type LineItemBundle,
  type LineItemBundleItem,
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

type BundleItemRow = LineItemBundleItem & {
  price_book_items: Pick<PriceBookItem, "description" | "labour_rate_cents" | "labour_hours" | "material_cost_cents" | "markup_percent"> | null;
};

async function fetchBundle(id: string): Promise<LineItemBundle> {
  const { data, error } = await supabase.from("line_item_bundles").select("*").eq("id", id).single();
  if (error) throw error;
  return data as LineItemBundle;
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

function resolvedBreakdown(row: BundleItemRow) {
  if (row.price_book_items) {
    return {
      description: row.price_book_items.description,
      labour_rate_cents: row.price_book_items.labour_rate_cents,
      labour_hours: row.price_book_items.labour_hours,
      material_cost_cents: row.price_book_items.material_cost_cents,
      markup_percent: row.price_book_items.markup_percent,
    };
  }
  return {
    description: row.description ?? "",
    labour_rate_cents: row.labour_rate_cents,
    labour_hours: row.labour_hours,
    material_cost_cents: row.material_cost_cents,
    markup_percent: row.markup_percent,
  };
}

type PriceBookBreakdown = Pick<PriceBookItem, "labour_rate_cents" | "labour_hours" | "material_cost_cents" | "markup_percent">;

const emptyItemForm = {
  mode: "custom" as "custom" | "price_book",
  priceBookItemId: "",
  priceBookItemDescription: "",
  priceBookItemBreakdown: null as PriceBookBreakdown | null,
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
        ? {
            labour_rate_cents: row.price_book_items.labour_rate_cents,
            labour_hours: row.price_book_items.labour_hours,
            material_cost_cents: row.price_book_items.material_cost_cents,
            markup_percent: row.price_book_items.markup_percent,
          }
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
        ? computeLineItemUnitPriceCents(itemForm.priceBookItemBreakdown)
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
            const breakdown = resolvedBreakdown(row);
            const unitPriceCents = computeLineItemUnitPriceCents(breakdown);
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
                        onClick={() =>
                          setItemForm({
                            ...itemForm,
                            priceBookItemId: pb.id,
                            priceBookItemDescription: pb.description,
                            priceBookItemBreakdown: {
                              labour_rate_cents: pb.labour_rate_cents,
                              labour_hours: pb.labour_hours,
                              material_cost_cents: pb.material_cost_cents,
                              markup_percent: pb.markup_percent,
                            },
                          })
                        }
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
