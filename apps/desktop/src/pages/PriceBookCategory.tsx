import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  formatCentsAsAud,
  type PriceBookCategory,
  type PriceBookItem,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

async function fetchCategory(id: string): Promise<PriceBookCategory> {
  const { data, error } = await supabase.from("price_book_categories").select("*").eq("id", id).single();
  if (error) throw error;
  return data as PriceBookCategory;
}

async function fetchItems(categoryId: string): Promise<PriceBookItem[]> {
  const { data, error } = await supabase
    .from("price_book_items")
    .select("*")
    .eq("category_id", categoryId)
    .order("sort_order")
    .order("description");
  if (error) throw error;
  return data as PriceBookItem[];
}

const emptyItemForm = { description: "", labourRate: "0", labourHours: "0", materialCost: "0", markupPercent: "0" };

export default function PriceBookCategoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: category } = useQuery({ queryKey: ["price-book-category", id], queryFn: () => fetchCategory(id!), enabled: !!id });
  const { data: items } = useQuery({ queryKey: ["price-book-items", id], queryFn: () => fetchItems(id!), enabled: !!id });

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (category) setRenameValue(category.name);
  }, [category]);

  const rename = useMutation({
    mutationFn: async () => {
      if (!renameValue.trim()) throw new Error("Name is required");
      const { error } = await supabase.from("price_book_categories").update({ name: renameValue.trim() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-category", id] });
      queryClient.invalidateQueries({ queryKey: ["price-book-categories"] });
      setRenameOpen(false);
    },
    onError: (e) => setRenameError(getErrorMessage(e, "Failed to rename category")),
  });

  const [newItemOpen, setNewItemOpen] = useState(false);
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [itemError, setItemError] = useState<string | null>(null);

  const previewCents = computeLineItemUnitPriceCents({
    labour_rate_cents: Math.round(parseNumber(itemForm.labourRate) * 100),
    labour_hours: parseNumber(itemForm.labourHours),
    material_cost_cents: Math.round(parseNumber(itemForm.materialCost) * 100),
    markup_percent: parseNumber(itemForm.markupPercent),
  });

  const createItem = useMutation({
    mutationFn: async () => {
      const result = createPriceBookItemSchema.safeParse({
        category_id: id,
        description: itemForm.description,
        labour_rate_cents: Math.round(parseNumber(itemForm.labourRate) * 100),
        labour_hours: parseNumber(itemForm.labourHours),
        material_cost_cents: Math.round(parseNumber(itemForm.materialCost) * 100),
        markup_percent: parseNumber(itemForm.markupPercent),
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("price_book_items")
        .insert({ ...result.data, tenant_id: profile.tenant_id })
        .select()
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (itemId) => {
      queryClient.invalidateQueries({ queryKey: ["price-book-items", id] });
      navigate(`/price-book/items/${itemId}`);
    },
    onError: (e) => setItemError(getErrorMessage(e, "Failed to create item")),
  });

  return (
    <div className="p-8">
      <Link to="/price-book" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Price Book
      </Link>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">{category?.name ?? ""}</h1>
          <button onClick={() => setRenameOpen(true)} className="text-sm font-semibold text-blue-700 hover:underline">
            Rename
          </button>
        </div>
        <button
          onClick={() => {
            setItemForm(emptyItemForm);
            setItemError(null);
            setNewItemOpen(true);
          }}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New item
        </button>
      </div>

      {!items || items.length === 0 ? (
        <p className="text-sm text-gray-500">No items yet in this category.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <Link
              key={item.id}
              to={`/price-book/items/${item.id}`}
              className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-xl bg-gray-100 p-4 text-center hover:bg-gray-200"
            >
              <span className="line-clamp-2 font-bold text-gray-900">{item.description}</span>
              <span className="text-sm font-semibold text-blue-700">{formatCentsAsAud(computeLineItemUnitPriceCents(item))}</span>
            </Link>
          ))}
        </div>
      )}

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title="Rename category">
        <FormField label="Name" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
        {renameError ? <p className="mb-4 text-sm text-red-600">{renameError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setRenameOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => rename.mutate()}
            disabled={rename.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {rename.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={newItemOpen} onClose={() => setNewItemOpen(false)} title="New item">
        <TextAreaField
          label="Description"
          rows={3}
          value={itemForm.description}
          onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
          placeholder="e.g. Tile Replacement"
        />
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Labour rate ($/hr)"
            value={itemForm.labourRate}
            onChange={(e) => setItemForm({ ...itemForm, labourRate: e.target.value })}
          />
          <FormField
            label="Labour hours"
            value={itemForm.labourHours}
            onChange={(e) => setItemForm({ ...itemForm, labourHours: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Material cost ($)"
            value={itemForm.materialCost}
            onChange={(e) => setItemForm({ ...itemForm, materialCost: e.target.value })}
          />
          <FormField
            label="Markup (%)"
            value={itemForm.markupPercent}
            onChange={(e) => setItemForm({ ...itemForm, markupPercent: e.target.value })}
          />
        </div>
        <div className="mb-4 rounded-md bg-gray-50 p-3">
          <p className="text-xs font-bold text-gray-500">Computed price</p>
          <p className="text-lg font-extrabold text-gray-900">{formatCentsAsAud(previewCents)}</p>
        </div>
        {itemError ? <p className="mb-4 text-sm text-red-600">{itemError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setNewItemOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createItem.mutate()}
            disabled={createItem.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createItem.isPending ? "Saving..." : "Create item"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
