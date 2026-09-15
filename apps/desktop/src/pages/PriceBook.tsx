import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPriceBookCategorySchema, type PriceBookCategory } from "@jmssaas/shared";
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

export default function PriceBookPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: categories, isLoading } = useQuery({ queryKey: ["price-book-categories"], queryFn: fetchCategories });

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
        <ThemedButton onClick={() => setModalOpen(true)}>+ New category</ThemedButton>
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : !categories || categories.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No categories yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {categories.map((category) =>
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
    </div>
  );
}
