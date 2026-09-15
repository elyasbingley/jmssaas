import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { KnowledgeArticle, KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

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
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/knowledge" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Knowledge
      </Link>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            {isUncategorised ? "Uncategorised" : (category?.name ?? "")}
          </h1>
          {isUncategorised ? null : (
            <button onClick={() => setRenameOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
              Rename
            </button>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <ThemedButton onClick={() => createArticle.mutate()} disabled={createArticle.isPending}>
            {createArticle.isPending ? "Creating..." : "+ New article"}
          </ThemedButton>
          {articleError ? (
            <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{articleError}</p>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : !articles || articles.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No articles yet in this category.</p>
      ) : (
        <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          {articles.map((article) => (
            <Link
              key={article.id}
              to={`/knowledge/articles/${article.id}`}
              className="jms-nav-link flex items-center justify-between px-4 py-3 last:border-0"
              style={{ borderBottom: "1px solid var(--jms-border)" }}
            >
              <span className="font-medium" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {article.title}
              </span>
              {article.is_published ? null : (
                <span
                  className="rounded-full border px-2 py-0.5 font-semibold"
                  style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                >
                  Draft
                </span>
              )}
            </Link>
          ))}
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
    </div>
  );
}
