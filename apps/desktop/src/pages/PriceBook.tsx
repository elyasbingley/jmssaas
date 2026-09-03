import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPriceBookCategorySchema, type PriceBookCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

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
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Price Book</h1>
          <p className="text-sm text-gray-500">{categories?.length ?? 0} categories</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New category
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : !categories || categories.length === 0 ? (
        <p className="text-sm text-gray-500">No categories yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {categories.map((category) =>
            category.image_url ? (
              <Link
                key={category.id}
                to={`/price-book/categories/${category.id}`}
                className="flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-xl bg-gray-100 bg-cover bg-center text-center hover:opacity-90"
                style={{ backgroundImage: `url(${category.image_url})` }}
              >
                <span className="bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6 font-bold text-white">{category.name}</span>
              </Link>
            ) : (
              <Link
                key={category.id}
                to={`/price-book/categories/${category.id}`}
                className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl bg-gray-100 p-4 text-center hover:bg-gray-200"
              >
                <span className="text-3xl">📋</span>
                <span className="font-bold text-gray-900">{category.name}</span>
              </Link>
            ),
          )}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New category">
        <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gutters and Downpipes" />
        <label className="mb-4 block text-sm font-semibold text-gray-700">
          Tile image (optional)
          <input
            type="file"
            accept="image/*"
            className="mt-1 block w-full text-sm text-gray-600"
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createCategory.mutate()}
            disabled={createCategory.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createCategory.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
