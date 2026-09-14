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
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

const IMAGE_BUCKET = "price-book-images";

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

  const [imageError, setImageError] = useState<string | null>(null);

  const changeCategoryImage = useMutation({
    mutationFn: async (file: File) => {
      if (!profile) throw new Error("Not signed in");
      const extension = file.type.includes("png") ? "png" : "jpg";
      const path = `${profile.tenant_id}/category-${id}-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
      const imageUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;

      const { error } = await supabase.from("price_book_categories").update({ image_url: imageUrl }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-category", id] });
      queryClient.invalidateQueries({ queryKey: ["price-book-categories"] });
      setImageError(null);
    },
    onError: (e) => setImageError(getErrorMessage(e, "Failed to upload image")),
  });

  const removeCategoryImage = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("price_book_categories").update({ image_url: null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-category", id] });
      queryClient.invalidateQueries({ queryKey: ["price-book-categories"] });
      setImageError(null);
    },
    onError: (e) => setImageError(getErrorMessage(e, "Failed to remove image")),
  });

  const [newItemOpen, setNewItemOpen] = useState(false);
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [itemImageFile, setItemImageFile] = useState<File | null>(null);
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

      let imageUrl: string | null = null;
      if (itemImageFile) {
        const extension = itemImageFile.type.includes("png") ? "png" : "jpg";
        const path = `${profile.tenant_id}/item-${Date.now()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from(IMAGE_BUCKET)
          .upload(path, itemImageFile, { contentType: itemImageFile.type || "image/jpeg", upsert: true });
        if (uploadError) throw uploadError;
        imageUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
      }

      const { data, error } = await supabase
        .from("price_book_items")
        .insert({ ...result.data, tenant_id: profile.tenant_id, image_url: imageUrl })
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
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/price-book" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Price Book
      </Link>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            {category?.name ?? ""}
          </h1>
          <button onClick={() => setRenameOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
            Rename
          </button>
          <label className="cursor-pointer font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
            {changeCategoryImage.isPending ? "Uploading..." : category?.image_url ? "Change tile image" : "Add tile image"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={changeCategoryImage.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) changeCategoryImage.mutate(file);
                e.target.value = "";
              }}
            />
          </label>
          {category?.image_url ? (
            <button onClick={() => removeCategoryImage.mutate()} className="font-semibold" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              Remove image
            </button>
          ) : null}
        </div>
        <ThemedButton
          onClick={() => {
            setItemForm(emptyItemForm);
            setItemImageFile(null);
            setItemError(null);
            setNewItemOpen(true);
          }}
        >
          + New item
        </ThemedButton>
      </div>
      {imageError ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {imageError}
        </p>
      ) : null}

      {!items || items.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No items yet in this category.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {items.map((item) =>
            item.image_url ? (
              <Link
                key={item.id}
                to={`/price-book/items/${item.id}`}
                className="flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-xl bg-cover bg-center text-center hover:opacity-90"
                style={{ backgroundImage: `url(${item.image_url})`, border: "1px solid var(--jms-border)" }}
              >
                <div className="flex flex-col gap-0.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6">
                  <span className="line-clamp-2 font-bold" style={{ color: "var(--jms-text)" }}>
                    {item.description}
                  </span>
                  <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
                    {formatCentsAsAud(computeLineItemUnitPriceCents(item))}
                  </span>
                </div>
              </Link>
            ) : (
              <Link
                key={item.id}
                to={`/price-book/items/${item.id}`}
                className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-xl p-4 text-center"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
              >
                <span className="line-clamp-2 font-bold" style={{ color: "var(--jms-text)" }}>
                  {item.description}
                </span>
                <span className="font-semibold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                  {formatCentsAsAud(computeLineItemUnitPriceCents(item))}
                </span>
              </Link>
            ),
          )}
        </div>
      )}

      <ThemedModal open={renameOpen} onClose={() => setRenameOpen(false)} title="Rename category">
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

      <ThemedModal open={newItemOpen} onClose={() => setNewItemOpen(false)} title="New item">
        <ThemedTextAreaField
          label="Description"
          rows={3}
          value={itemForm.description}
          onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
          placeholder="e.g. Tile Replacement"
        />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Labour rate ($/hr)"
            value={itemForm.labourRate}
            onChange={(e) => setItemForm({ ...itemForm, labourRate: e.target.value })}
          />
          <ThemedFormField
            label="Labour hours"
            value={itemForm.labourHours}
            onChange={(e) => setItemForm({ ...itemForm, labourHours: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Material cost ($)"
            value={itemForm.materialCost}
            onChange={(e) => setItemForm({ ...itemForm, materialCost: e.target.value })}
          />
          <ThemedFormField
            label="Markup (%)"
            value={itemForm.markupPercent}
            onChange={(e) => setItemForm({ ...itemForm, markupPercent: e.target.value })}
          />
        </div>
        <div className="mb-4 rounded p-3" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }}>
          <p className="font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Computed price
          </p>
          <p className="text-lg font-extrabold" style={{ color: "var(--jms-accent)" }}>
            {formatCentsAsAud(previewCents)}
          </p>
        </div>
        <label className="mb-4 block font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Tile image (optional)
          <input
            type="file"
            accept="image/*"
            className="mt-1 block w-full"
            style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
            onChange={(e) => setItemImageFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {itemError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {itemError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setNewItemOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createItem.mutate()} disabled={createItem.isPending}>
            {createItem.isPending ? "Saving..." : "Create item"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
