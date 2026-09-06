import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { KnowledgeArticle, KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

// "uncategorised" is a virtual category (category_id IS NULL), not a real
// knowledge_categories row - see KnowledgeBase.tsx's own tile for it. This
// page handles both: a real uuid works exactly like PriceBookCategory.tsx,
// this one just skips the rename/fetch-category calls and queries
// `category_id is null` instead of `= id`.
const UNCATEGORISED = "uncategorised";

async function fetchCategory(id: string): Promise<KnowledgeCategory> {
  const { data, error } = await supabase.from("knowledge_categories").select("*").eq("id", id).single();
  if (error) throw error;
  return data as KnowledgeCategory;
}

async function fetchArticles(categoryId: string): Promise<KnowledgeArticle[]> {
  const query = supabase.from("knowledge_articles").select("*").order("title");
  const { data, error } = await (categoryId === UNCATEGORISED ? query.is("category_id", null) : query.eq("category_id", categoryId));
  if (error) throw error;
  return data as KnowledgeArticle[];
}

export default function KnowledgeCategoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const isUncategorised = id === UNCATEGORISED;

  const { data: category } = useQuery({
    queryKey: ["knowledge-category", id],
    queryFn: () => fetchCategory(id!),
    enabled: !!id && !isUncategorised,
  });
  const { data: articles, isLoading } = useQuery({ queryKey: ["knowledge-articles", id], queryFn: () => fetchArticles(id!), enabled: !!id });

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [articleError, setArticleError] = useState<string | null>(null);

  useEffect(() => {
    if (category) setRenameValue(category.name);
  }, [category]);

  const rename = useMutation({
    mutationFn: async () => {
      if (!renameValue.trim()) throw new Error("Name is required");
      const { error } = await supabase.from("knowledge_categories").update({ name: renameValue.trim() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-category", id] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-categories"] });
      setRenameOpen(false);
    },
    onError: (e) => setRenameError(getErrorMessage(e, "Failed to rename category")),
  });

  const createArticle = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("knowledge_articles")
        .insert({
          tenant_id: profile.tenant_id,
          category_id: isUncategorised ? null : id,
          title: "Untitled article",
          content_blocks: [],
          created_by: profile.id,
        })
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
      <Link to="/knowledge" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Knowledge
      </Link>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">{isUncategorised ? "Uncategorised" : (category?.name ?? "")}</h1>
          {isUncategorised ? null : (
            <button onClick={() => setRenameOpen(true)} className="text-sm font-semibold text-blue-700 hover:underline">
              Rename
            </button>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={() => createArticle.mutate()}
            disabled={createArticle.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createArticle.isPending ? "Creating..." : "+ New article"}
          </button>
          {articleError ? <p className="text-sm text-red-600">{articleError}</p> : null}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : !articles || articles.length === 0 ? (
        <p className="text-sm text-gray-500">No articles yet in this category.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          {articles.map((article) => (
            <Link
              key={article.id}
              to={`/knowledge/articles/${article.id}`}
              className="flex items-center justify-between border-b border-gray-100 px-4 py-3 last:border-0 hover:bg-gray-50"
            >
              <span className="font-medium text-gray-900">{article.title}</span>
              {article.is_published ? null : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Draft</span>
              )}
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
    </div>
  );
}
