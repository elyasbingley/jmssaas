import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPriceBookCategorySchema, type PriceBookCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

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
  const [formError, setFormError] = useState<string | null>(null);

  const createCategory = useMutation({
    mutationFn: async () => {
      const result = createPriceBookCategorySchema.safeParse({ name, sort_order: categories?.length ?? 0 });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid category");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("price_book_categories").insert({ ...result.data, tenant_id: profile.tenant_id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-categories"] });
      setModalOpen(false);
      setName("");
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
          {categories.map((category) => (
            <Link
              key={category.id}
              to={`/price-book/categories/${category.id}`}
              className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl bg-gray-100 p-4 text-center hover:bg-gray-200"
            >
              <span className="text-3xl">📋</span>
              <span className="font-bold text-gray-900">{category.name}</span>
            </Link>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New category">
        <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gutters and Downpipes" />
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
