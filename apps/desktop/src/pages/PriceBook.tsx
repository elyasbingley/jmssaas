import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPriceBookCategorySchema, type PriceBookCategory, type PriceBookSettings, type PriceBookSortMode } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

const IMAGE_BUCKET = "price-book-images";

async function fetchCategories(): Promise<PriceBookCategory[]> {
  const { data, error } = await supabase.from("price_book_categories").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as PriceBookCategory[];
}

// No row yet just means "custom" (the pre-existing default before this
// toggle existed) - the app upserts the row lazily on the first change
// rather than backfilling one per tenant.
async function fetchSettings(): Promise<PriceBookSettings | null> {
  const { data, error } = await supabase.from("price_book_settings").select("*").maybeSingle();
  if (error) throw error;
  return (data as PriceBookSettings | null) ?? null;
}

// sort_order still decides display order even in alphabetical mode - this
// just re-sorts by name client-side so switching modes never needs a
// write, and custom mode's own order survives underneath untouched.
function sortCategories(categories: PriceBookCategory[], mode: PriceBookSortMode): PriceBookCategory[] {
  if (mode === "alphabetical") {
    return [...categories].sort((a, b) => a.name.localeCompare(b.name));
  }
  return categories;
}

export default function PriceBookPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: categories, isLoading } = useQuery({ queryKey: ["price-book-categories"], queryFn: fetchCategories });
  const { data: settings } = useQuery({ queryKey: ["price-book-settings"], queryFn: fetchSettings });
  const sortMode: PriceBookSortMode = settings?.category_sort_mode ?? "custom";
  const sortedCategories = sortCategories(categories ?? [], sortMode);

  const setSortMode = useMutation({
    mutationFn: async (mode: PriceBookSortMode) => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase
        .from("price_book_settings")
        .upsert({ tenant_id: profile.tenant_id, category_sort_mode: mode }, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["price-book-settings"] }),
  });

  const [reorderOpen, setReorderOpen] = useState(false);
  // Re-numbers every category to its new index rather than just swapping
  // the two moved rows' sort_order values, so pre-existing duplicate/gappy
  // sort_order values (anything created before this reorder UI existed)
  // get normalized the first time anyone reorders, instead of silently
  // producing a no-op swap.
  const moveCategory = useMutation({
    mutationFn: async ({ category, direction }: { category: PriceBookCategory; direction: -1 | 1 }) => {
      const ordered = sortCategories(categories ?? [], "custom");
      const index = ordered.findIndex((c) => c.id === category.id);
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= ordered.length) return;
      const reordered = [...ordered];
      const moved = reordered.splice(index, 1)[0];
      if (!moved) return;
      reordered.splice(targetIndex, 0, moved);
      const updates = reordered
        .map((c, newIndex) => ({ id: c.id, sort_order: newIndex, changed: c.sort_order !== newIndex }))
        .filter((c) => c.changed);
      for (const update of updates) {
        const { error } = await supabase.from("price_book_categories").update({ sort_order: update.sort_order }).eq("id", update.id);
        if (error) throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["price-book-categories"] }),
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const createCategory = useMutation({
    mutationFn: async () => {
      const result = createPriceBookCategorySchema.safeParse({ name, sort_order: categories?.length ?? 0 });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid category");
      if (!profile) throw new Error("Not signed in");

      let imageUrl: string | null = null;
      if (imageFile) {
        const extension = imageFile.type.includes("png") ? "png" : "jpg";
        const path = `${profile.tenant_id}/category-${Date.now()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from(IMAGE_BUCKET)
          .upload(path, imageFile, { contentType: imageFile.type || "image/jpeg", upsert: true });
        if (uploadError) throw uploadError;
        imageUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
      }

      const { error } = await supabase
        .from("price_book_categories")
        .insert({ ...result.data, tenant_id: profile.tenant_id, image_url: imageUrl });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-categories"] });
      setModalOpen(false);
      setName("");
      setImageFile(null);
      setFormError(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create category")),
  });

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Price Book
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{categories?.length ?? 0} categories</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)" }}>
            <button
              onClick={() => setSortMode.mutate("custom")}
              className="px-3 py-2 font-semibold"
              style={
                sortMode === "custom"
                  ? { backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                  : { backgroundColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
              }
            >
              Custom order
            </button>
            <button
              onClick={() => setSortMode.mutate("alphabetical")}
              className="px-3 py-2 font-semibold"
              style={
                sortMode === "alphabetical"
                  ? { backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                  : { backgroundColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
              }
            >
              A&ndash;Z
            </button>
          </div>
          {sortMode === "custom" ? (
            <ThemedButton variant="secondary" onClick={() => setReorderOpen(true)}>
              Reorder
            </ThemedButton>
          ) : null}
          <ThemedButton onClick={() => setModalOpen(true)}>+ New category</ThemedButton>
        </div>
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : !categories || categories.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No categories yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {sortedCategories.map((category) =>
            category.image_url ? (
              <Link
                key={category.id}
                to={`/price-book/categories/${category.id}`}
                className="flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-xl bg-cover bg-center text-center hover:opacity-90"
                style={{ backgroundImage: `url(${category.image_url})`, border: "1px solid var(--jms-border)" }}
              >
                <span
                  className="bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6 font-bold"
                  style={{ color: "var(--jms-text)" }}
                >
                  {category.name}
                </span>
              </Link>
            ) : (
              <Link
                key={category.id}
                to={`/price-book/categories/${category.id}`}
                className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl p-4 text-center"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
              >
                <span className="text-3xl">📋</span>
                <span className="font-bold" style={{ color: "var(--jms-text)" }}>
                  {category.name}
                </span>
              </Link>
            ),
          )}
        </div>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title="New category">
        <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gutters and Downpipes" />
        <label className="mb-4 block font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Tile image (optional)
          <input
            type="file"
            accept="image/*"
            className="mt-1 block w-full"
            style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createCategory.mutate()} disabled={createCategory.isPending}>
            {createCategory.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={reorderOpen} onClose={() => setReorderOpen(false)} title="Reorder categories">
        <div className="mb-4 overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)" }}>
          {sortCategories(categories ?? [], "custom").map((category, index, ordered) => (
            <div
              key={category.id}
              className="flex items-center justify-between gap-3 px-3 py-2 last:border-0"
              style={{ borderBottom: "1px solid var(--jms-border)" }}
            >
              <span className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {category.name}
              </span>
              <div className="flex flex-shrink-0 gap-2">
                <button
                  onClick={() => moveCategory.mutate({ category, direction: -1 })}
                  disabled={index === 0 || moveCategory.isPending}
                  className="px-2 font-bold disabled:opacity-30"
                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
                >
                  &uarr;
                </button>
                <button
                  onClick={() => moveCategory.mutate({ category, direction: 1 })}
                  disabled={index === ordered.length - 1 || moveCategory.isPending}
                  className="px-2 font-bold disabled:opacity-30"
                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
                >
                  &darr;
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <ThemedButton onClick={() => setReorderOpen(false)}>Done</ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
