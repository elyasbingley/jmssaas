import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { createKnowledgeCategorySchema, type KnowledgeArticle, type KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

async function fetchCategories(): Promise<KnowledgeCategory[]> {
  const { data, error } = await supabase.from("knowledge_categories").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as KnowledgeCategory[];
}

// Uncategorised articles are still readable/creatable (category_id is
// nullable - not every tenant needs to organise into folders before
// they've written more than a couple of articles), just surfaced here as
// their own "tile" alongside real categories rather than hidden.
async function fetchUncategorisedCount(): Promise<number> {
  const { count, error } = await supabase
    .from("knowledge_articles")
    .select("id", { count: "exact", head: true })
    .is("category_id", null);
  if (error) throw error;
  return count ?? 0;
}

export default function KnowledgeBasePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: categories, isLoading } = useQuery({ queryKey: ["knowledge-categories"], queryFn: fetchCategories });
  const { data: uncategorisedCount } = useQuery({ queryKey: ["knowledge-uncategorised-count"], queryFn: fetchUncategorisedCount });

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [articleError, setArticleError] = useState<string | null>(null);

  const createCategory = useMutation({
    mutationFn: async () => {
      const result = createKnowledgeCategorySchema.safeParse({ name, sort_order: categories?.length ?? 0 });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid category");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("knowledge_categories").insert({ ...result.data, tenant_id: profile.tenant_id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-categories"] });
      setModalOpen(false);
      setName("");
      setFormError(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create category")),
  });

  const createArticle = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("knowledge_articles")
        .insert({ tenant_id: profile.tenant_id, title: "Untitled article", content_blocks: [], created_by: profile.id } satisfies Partial<KnowledgeArticle> & { tenant_id: string; created_by: string })
        .select()
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (articleId) => navigate(`/knowledge/articles/${articleId}`),
    onError: (e) => setArticleError(getErrorMessage(e, "Failed to create article")),
  });

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Knowledge</h1>
          <p className="text-sm text-gray-500">SOPs, how-tos and training material for your team.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-3">
            <button
              onClick={() => setModalOpen(true)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              + New category
            </button>
            <button
              onClick={() => createArticle.mutate()}
              disabled={createArticle.isPending}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {createArticle.isPending ? "Creating..." : "+ New article"}
            </button>
          </div>
          {articleError ? <p className="text-sm text-red-600">{articleError}</p> : null}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {(categories ?? []).map((category) => (
            <Link
              key={category.id}
              to={`/knowledge/categories/${category.id}`}
              className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl bg-gray-100 p-4 text-center hover:bg-gray-200"
            >
              <span className="text-3xl">📚</span>
              <span className="font-bold text-gray-900">{category.name}</span>
            </Link>
          ))}
          {!uncategorisedCount ? null : (
            <Link
              to="/knowledge/categories/uncategorised"
              className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl bg-gray-100 p-4 text-center hover:bg-gray-200"
            >
              <span className="text-3xl">📄</span>
              <span className="font-bold text-gray-900">Uncategorised</span>
              <span className="text-xs text-gray-500">{uncategorisedCount} article{uncategorisedCount === 1 ? "" : "s"}</span>
            </Link>
          )}
        </div>
      )}
      {!isLoading && (categories ?? []).length === 0 && !uncategorisedCount ? (
        <p className="text-sm text-gray-500">No articles yet - create your first one above.</p>
      ) : null}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New category">
        <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Roofing SOPs" />
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
