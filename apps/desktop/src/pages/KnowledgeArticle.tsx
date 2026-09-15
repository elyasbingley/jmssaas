import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  toEmbedUrl,
  type EmailAttachment,
  type KnowledgeArticle,
  type KnowledgeBlock,
  type KnowledgeCategory,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { uploadKnowledgeImage } from "../lib/uploads";
import { buildKnowledgeArticlePdfBlob } from "../lib/knowledge-pdf";
import { blobToDataUrl } from "../lib/quote-invoice-pdf-bytes";
import { queueAndSendEmail } from "../lib/send-email";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { EmailComposeModal } from "../components/EmailComposeModal";

const BUCKET = "knowledge-files";

function newBlockId(): string {
  return crypto.randomUUID();
}

async function fetchArticle(id: string): Promise<KnowledgeArticle> {
  const { data, error } = await supabase.from("knowledge_articles").select("*").eq("id", id).single();
  if (error) throw error;
  return data as KnowledgeArticle;
}
async function fetchCategories(): Promise<KnowledgeCategory[]> {
  const { data, error } = await supabase.from("knowledge_categories").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as KnowledgeCategory[];
}
async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}

function TextBlockEditor({ block, onChange }: { block: Extract<KnowledgeBlock, { type: "text" }>; onChange: (block: KnowledgeBlock) => void }) {
  return (
    <ThemedTextAreaField
      label="Text"
      labelHidden
      rows={5}
      value={block.body}
      onChange={(e) => onChange({ ...block, body: e.target.value })}
      placeholder="Write this section's content..."
    />
  );
}

function ImageBlockEditor({
  block,
  articleId,
  onChange,
}: {
  block: Extract<KnowledgeBlock, { type: "image" }>;
  articleId: string;
  onChange: (block: KnowledgeBlock) => void;
}) {
  const { profile } = useAuth();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!block.storagePath) {
      setSignedUrl(null);
      return;
    }
    supabase.storage
      .from(BUCKET)
      .createSignedUrl(block.storagePath, 3600)
      .then(({ data }) => {
        if (!cancelled) setSignedUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [block.storagePath]);

  const handleFile = async (file: File) => {
    if (!profile) return;
    setUploading(true);
    setError(null);
    try {
      const storagePath = await uploadKnowledgeImage({ tenantId: profile.tenant_id, articleId, file });
      onChange({ ...block, storagePath });
    } catch (e) {
      setError(getErrorMessage(e, "Failed to upload image"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      {signedUrl ? (
        <img src={signedUrl} alt={block.caption ?? ""} className="mb-2 max-h-64 rounded object-contain" style={{ border: "1px solid var(--jms-border)" }} />
      ) : (
        <div
          className="mb-2 flex h-32 items-center justify-center rounded border border-dashed"
          style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
        >
          No image yet
        </div>
      )}
      <label className="mb-3 inline-block cursor-pointer font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        {uploading ? "Uploading..." : block.storagePath ? "Replace image" : "Upload image"}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </label>
      {error ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {error}
        </p>
      ) : null}
      <ThemedFormField
        label="Caption (optional)"
        value={block.caption ?? ""}
        onChange={(e) => onChange({ ...block, caption: e.target.value })}
      />
    </div>
  );
}

function VideoBlockEditor({ block, onChange }: { block: Extract<KnowledgeBlock, { type: "video_embed" }>; onChange: (block: KnowledgeBlock) => void }) {
  const embedUrl = toEmbedUrl(block.url);
  return (
    <div>
      <ThemedFormField
        label="Video URL (YouTube, Vimeo or Loom)"
        value={block.url}
        onChange={(e) => onChange({ ...block, url: e.target.value })}
        placeholder="https://youtube.com/watch?v=..."
      />
      {embedUrl ? (
        <iframe src={embedUrl} className="mb-3 aspect-video w-full rounded" style={{ border: "1px solid var(--jms-border)" }} allowFullScreen title="Video preview" />
      ) : block.url ? (
        <p className="mb-3" style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>
          Couldn't recognise this as a YouTube, Vimeo or Loom link - it'll still be saved as a plain link.
        </p>
      ) : null}
      <ThemedFormField
        label="Caption (optional)"
        value={block.caption ?? ""}
        onChange={(e) => onChange({ ...block, caption: e.target.value })}
      />
    </div>
  );
}

const BLOCK_LABELS: Record<KnowledgeBlock["type"], string> = {
  text: "Text",
  image: "Image",
  video_embed: "Video",
};

export default function KnowledgeArticlePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: article, isLoading } = useQuery({ queryKey: ["knowledge-article", id], queryFn: () => fetchArticle(id!), enabled: !!id });
  const { data: categories } = useQuery({ queryKey: ["knowledge-categories"], queryFn: fetchCategories });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });

  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [isPublished, setIsPublished] = useState(false);
  const [blocks, setBlocks] = useState<KnowledgeBlock[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (article) {
      setTitle(article.title);
      setCategoryId(article.category_id ?? "");
      setIsPublished(article.is_published);
      setBlocks(article.content_blocks);
    }
  }, [article]);

  const save = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Title is required");
      const { error } = await supabase
        .from("knowledge_articles")
        .update({ title: title.trim(), category_id: categoryId || null, is_published: isPublished, content_blocks: blocks })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-article", id] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-articles"] });
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("knowledge_articles").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => navigate("/knowledge"),
  });

  const updateBlock = (index: number, next: KnowledgeBlock) => setBlocks((prev) => prev.map((b, i) => (i === index ? next : b)));
  const removeBlock = (index: number) => setBlocks((prev) => prev.filter((_, i) => i !== index));
  const moveBlock = (index: number, direction: -1 | 1) => {
    setBlocks((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      const temp = next[index]!;
      next[index] = next[target]!;
      next[target] = temp;
      return next;
    });
  };
  const addBlock = (type: KnowledgeBlock["type"]) => {
    const id = newBlockId();
    const block: KnowledgeBlock =
      type === "text" ? { id, type, body: "" } : type === "image" ? { id, type, storagePath: "" } : { id, type, url: "" };
    setBlocks((prev) => [...prev, block]);
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const downloadPdf = async () => {
    if (!tenant || !article) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const blob = await buildKnowledgeArticlePdfBlob({ tenant, article: { ...article, title, content_blocks: blocks } });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } catch (e) {
      setPdfError(getErrorMessage(e, "Failed to generate PDF"));
    } finally {
      setPdfBusy(false);
    }
  };

  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailAttachments, setEmailAttachments] = useState<EmailAttachment[]>([]);
  const [emailResult, setEmailResult] = useState<string | null>(null);

  const openEmailModal = async () => {
    if (!tenant || !article) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const blob = await buildKnowledgeArticlePdfBlob({ tenant, article: { ...article, title, content_blocks: blocks } });
      const dataUrl = await blobToDataUrl(blob);
      setEmailAttachments([{ filename: `${title || "Article"}.pdf`, content: dataUrl }]);
      setEmailModalOpen(true);
    } catch (e) {
      setPdfError(getErrorMessage(e, "Failed to generate PDF"));
    } finally {
      setPdfBusy(false);
    }
  };

  const handleSendEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile || !article) throw new Error("Not signed in");
    const wasSent = await queueAndSendEmail({
      tenantId: profile.tenant_id,
      entityType: "knowledge_article",
      entityId: article.id,
      triggerKey: "manual_email",
      ...payload,
    });
    setEmailResult(wasSent ? "Email sent." : "Email queued and will send shortly.");
    setTimeout(() => setEmailResult(null), 5000);
  };

  if (isLoading || !article) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/knowledge" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Knowledge
      </Link>

      <ThemedFormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <ThemedSelectField
        label="Category"
        value={categoryId}
        onChange={setCategoryId}
        options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
        placeholder="Uncategorised"
      />
      <label className="mb-4 flex items-center gap-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        <input type="checkbox" checked={isPublished} onChange={(e) => setIsPublished(e.target.checked)} />
        Published (visible to all staff, not just admins)
      </label>

      <div className="mb-6 space-y-4">
        {blocks.map((block, index) => (
          <div key={block.id} className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <div className="mb-3 flex items-center justify-between">
              <span className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
                {BLOCK_LABELS[block.type]}
              </span>
              <div className="flex items-center gap-3 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                <button onClick={() => moveBlock(index, -1)} disabled={index === 0} className="disabled:opacity-30" style={{ color: "var(--jms-text)" }}>
                  ↑
                </button>
                <button onClick={() => moveBlock(index, 1)} disabled={index === blocks.length - 1} className="disabled:opacity-30" style={{ color: "var(--jms-text)" }}>
                  ↓
                </button>
                <button onClick={() => removeBlock(index)} className="hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Remove
                </button>
              </div>
            </div>
            {block.type === "text" ? (
              <TextBlockEditor block={block} onChange={(b) => updateBlock(index, b)} />
            ) : block.type === "image" ? (
              <ImageBlockEditor block={block} articleId={article.id} onChange={(b) => updateBlock(index, b)} />
            ) : (
              <VideoBlockEditor block={block} onChange={(b) => updateBlock(index, b)} />
            )}
          </div>
        ))}
      </div>

      <div className="mb-6 flex gap-3">
        <button
          onClick={() => addBlock("text")}
          className="rounded px-3 py-1.5 font-semibold"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          + Text
        </button>
        <button
          onClick={() => addBlock("image")}
          className="rounded px-3 py-1.5 font-semibold"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          + Image
        </button>
        <button
          onClick={() => addBlock("video_embed")}
          className="rounded px-3 py-1.5 font-semibold"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          + Video
        </button>
      </div>

      {saveError ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p className="mb-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          Saved.
        </p>
      ) : null}
      {pdfError ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {pdfError}
        </p>
      ) : null}
      {emailResult ? (
        <p className="mb-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          {emailResult}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <ThemedButton onClick={() => save.mutate()} disabled={save.isPending} style={{ paddingBlock: 12, paddingInline: 24 }}>
          {save.isPending ? "Saving..." : "Save"}
        </ThemedButton>
        <button
          onClick={downloadPdf}
          disabled={pdfBusy}
          className="rounded px-4 py-2 font-semibold disabled:opacity-60"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          {pdfBusy ? "Preparing..." : "Download PDF"}
        </button>
        <button
          onClick={openEmailModal}
          disabled={pdfBusy}
          className="rounded px-4 py-2 font-semibold disabled:opacity-60"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          {pdfBusy ? "Preparing..." : "Email PDF"}
        </button>
        <button onClick={() => remove.mutate()} className="ml-auto font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          Delete article
        </button>
      </div>

      <EmailComposeModal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        title="Email article as PDF"
        defaultTo=""
        defaultSubject={title}
        defaultBody={`Please find attached: ${title}`}
        recipientOptions={[]}
        defaultAttachments={emailAttachments}
        onSend={handleSendEmail}
        sendLabel="Send"
      />
    </div>
  );
}
