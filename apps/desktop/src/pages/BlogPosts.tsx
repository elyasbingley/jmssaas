import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlogPost, BlogSettings } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { functionErrorMessage } from "../lib/marketing-photo";
import { ThemedButton } from "../components/theme/ThemedButton";

// Marketing > Blog Posts (website blog posts from finished jobs - see
// BLOG_SETUP.md). Drafts that blog-draft writes on Tue/Thu/Sat (or on
// "Write one now") wait here to be edited and approved; approving commits
// the post to the website's GitHub repository and Vercel publishes it.

type Tab = "drafts" | "history" | "settings";
const KEY = ["blog"];
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const inputClass = "w-full rounded border px-2 py-1.5 focus:outline-none";
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const labelClass = "mb-1 block uppercase tracking-wide";
const STATUS_COLOURS: Record<BlogPost["status"], string> = {
  draft: "var(--jms-warning)",
  approved: "var(--jms-accent)",
  published: "var(--jms-accent)",
  failed: "var(--jms-danger)",
  skipped: "var(--jms-text-muted)",
};

function fmtWhen(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
}

export default function BlogPostsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (["drafts", "history", "settings"] as Tab[]).includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "drafts";
  const setTab = (t: Tab) => setParams(t === "drafts" ? {} : { tab: t }, { replace: true });
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: [...KEY, "settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("blog_settings").select("*").maybeSingle();
      if (error) throw error;
      return (data as BlogSettings | null) ?? null;
    },
  });
  const posts = useQuery({
    queryKey: [...KEY, "posts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("blog_posts").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data as BlogPost[];
    },
  });
  const writeNow = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("blog-draft", { body: {} });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't write a post"));
      const result = (data as { results?: { drafted?: string; skipped?: string; error?: string }[] })?.results?.[0];
      if (result?.error) throw new Error(result.error);
      if (result?.skipped) throw new Error(`Nothing to write about: ${result.skipped}.`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const drafts = (posts.data ?? []).filter((p) => p.status === "draft");
  const history = (posts.data ?? []).filter((p) => p.status !== "draft");
  const s = settings.data;
  const loadError = settings.error ?? posts.error;

  return (
    <div className="mx-auto max-w-5xl p-6" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Blog Posts
      </h1>
      <p className="mb-5 max-w-3xl" style={muted}>
        Case studies for your website, written from finished jobs that have photos marked <strong>OK for marketing</strong>. On Tuesday, Thursday and Saturday mornings a
        draft is written for you; edit it, approve it, and it's live on the website about a minute later.
      </p>

      {loadError ? <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(loadError, "Couldn't load blog posts")}</p> : null}
      {settings.data !== undefined && (!s || !s.enabled || !s.github_repo) ? (
        <p className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-warning)", color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }} data-testid="setup-warning">
          {!s?.github_repo ? "The website's GitHub repository isn't set yet, so posts can't be published." : "Scheduled drafts are switched off."}{" "}
          <button className="underline" onClick={() => setTab("settings")}>
            Open Settings
          </button>
        </p>
      ) : null}

      <div className="mb-5 flex flex-wrap gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {(
          [
            ["drafts", `Drafts${drafts.length ? ` · ${drafts.length}` : ""}`],
            ["history", "History"],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={
              tab === key
                ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { borderColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
            data-testid={`tab-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "drafts" ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <ThemedButton onClick={() => writeNow.mutate()} disabled={writeNow.isPending || !s} data-testid="write-now">
              {writeNow.isPending ? "Writing... (up to a minute)" : "Write one now"}
            </ThemedButton>
            <span style={muted}>Picks the most recent finished job with marketing photos that hasn't had a post.</span>
          </div>
          {writeNow.error ? <p style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(writeNow.error, "Couldn't write a post")}</p> : null}
          {posts.data && drafts.length === 0 ? <p style={body}>No drafts waiting.</p> : null}
          {drafts.map((p) => (
            <DraftCard key={p.id} post={p} />
          ))}
        </div>
      ) : null}
      {tab === "history" ? <HistoryList posts={history} loaded={!!posts.data} /> : null}
      {tab === "settings" && settings.data !== undefined ? <SettingsForm settings={settings.data} /> : null}
    </div>
  );
}

function usePublish() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (p: { post_id: string; title?: string; description?: string; body?: string }) => {
      const { error } = await supabase.functions.invoke("blog-publish", { body: p });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't publish the post"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

function DraftCard({ post }: { post: BlogPost }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(post.title);
  const [description, setDescription] = useState(post.description);
  const [text, setText] = useState(post.body);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    setTitle(post.title);
    setDescription(post.description);
    setText(post.body);
  }, [post.title, post.description, post.body]);
  const publish = usePublish();
  const skip = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("blog_posts").update({ status: "skipped" }).eq("id", post.id);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const busy = publish.isPending || skip.isPending;
  const err = publish.error ?? skip.error;
  const words = text.split(/\s+/).filter(Boolean).length;
  const invalid = !title.trim() || !description.trim() || !text.trim() || title.length > 140 || description.length > 320;

  return (
    <div className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="draft-card">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1" style={muted}>
        <span>Drafted {fmtWhen(post.created_at)}</span>
        {post.job_type ? <span>· {post.job_type}</span> : null}
        {post.suburb ? <span>· {post.suburb}</span> : null}
        {post.job_card_id ? (
          <Link to={`/jobs/${post.job_card_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
            · Open the job
          </Link>
        ) : null}
      </div>
      {post.concerns.length ? (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="concerns">
          {post.concerns.map((c, i) => (
            <span key={i} className="rounded px-2 py-0.5 font-semibold" style={{ border: "1px solid var(--jms-warning)", color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}>
              ⚠ {c}
            </span>
          ))}
        </div>
      ) : null}
      {post.photos.length ? (
        <div className="mb-4 flex gap-2 overflow-x-auto">
          {post.photos.map((p, i) => (
            <a key={i} href={p.url} target="_blank" rel="noreferrer" className="shrink-0" title={`Photo ${i + 1}: ${p.alt}`}>
              <img src={p.url} alt={p.alt} className="h-24 w-32 rounded object-cover" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }} />
              <span className="mt-0.5 block text-center" style={muted}>
                {i === 0 ? "1 · top" : i + 1}
              </span>
            </a>
          ))}
        </div>
      ) : null}

      <label className={labelClass} style={muted} htmlFor={`title-${post.id}`}>
        Title
      </label>
      <input id={`title-${post.id}`} value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mb-1 font-semibold`} style={inputStyle} />
      <p className="mb-3 text-right" style={{ ...muted, color: title.length > 70 ? "var(--jms-warning)" : muted.color }}>
        {title.length} / 70 for Google
      </p>
      <label className={labelClass} style={muted} htmlFor={`desc-${post.id}`}>
        Google snippet
      </label>
      <textarea id={`desc-${post.id}`} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} style={inputStyle} />
      <p className="mb-3 text-right" style={{ ...muted, color: description.length > 160 ? "var(--jms-warning)" : muted.color }}>
        {description.length} / 155
      </p>

      <div className="mb-1 flex items-center justify-between">
        <span className={labelClass} style={muted}>
          Post · {words} words
        </span>
        <button type="button" onClick={() => setPreview(!preview)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          {preview ? "Edit" : "Preview"}
        </button>
      </div>
      {preview ? (
        <div className="mb-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "#fff", color: "#1e293b" }} data-testid="preview">
          <h2 className="mb-3 text-2xl font-bold">{title}</h2>
          {post.photos[0] && !/^\[\[photo:1\]\]$/m.test(text) ? <img src={post.photos[0].url} alt="" className="mb-4 w-full rounded" /> : null}
          <PostPreview text={text} photos={post.photos} />
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={18}
            className={inputClass}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
            aria-label="Post"
          />
          <p className="mb-3 mt-1" style={muted}>
            ## a heading · - a list item · **bold** · [link text](/blog/...) · [[photo:2]] places photo 2. Leave a blank line between paragraphs.
          </p>
        </>
      )}
      {post.cta ? (
        <p className="mb-3" style={muted}>
          End box: <strong style={{ color: "var(--jms-text)" }}>{post.cta.heading}</strong> {post.cta.text} [{post.cta.button}]
        </p>
      ) : null}

      {err ? <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(err, "Something went wrong")}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <ThemedButton
          onClick={() =>
            publish.mutate({
              post_id: post.id,
              title: title !== post.title ? title : undefined,
              description: description !== post.description ? description : undefined,
              body: text !== post.body ? text : undefined,
            })
          }
          disabled={busy || invalid}
        >
          {publish.isPending ? "Publishing..." : post.concerns.length ? "Approve anyway and publish" : "Approve and publish"}
        </ThemedButton>
        <ThemedButton
          variant="secondary"
          onClick={() => {
            if (window.confirm("Skip this post? This job won't be suggested again.")) skip.mutate();
          }}
          disabled={busy}
        >
          Skip
        </ThemedButton>
        <span style={muted}>Goes live on the website about a minute after you approve.</span>
      </div>
    </div>
  );
}

// A close-enough preview of how the website shows the post (the website's
// own renderer is components/JobPostBody.tsx in bingley-growth-plan).
function inlineMarks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:\/|https:\/\/)[^\s)]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? <strong key={i++}>{m[1]}</strong> : <span key={i++} className="underline" style={{ color: "#2563eb" }}>{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function PostPreview({ text, photos }: { text: string; photos: BlogPost["photos"] }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((block, i) => {
        const photo = block.match(/^\[\[photo:(\d+)\]\]$/);
        if (photo) {
          const p = photos[Number(photo[1]) - 1];
          return p ? <img key={i} src={p.url} alt={p.alt} className="my-4 w-full rounded" /> : <p key={i} style={{ color: "#b91c1c" }}>(no photo {photo[1]})</p>;
        }
        if (block.startsWith("### ")) return <h4 key={i} className="mb-2 mt-5 text-lg font-bold">{inlineMarks(block.slice(4))}</h4>;
        if (block.startsWith("## ")) return <h3 key={i} className="mb-3 mt-6 text-xl font-bold">{inlineMarks(block.slice(3))}</h3>;
        const lines = block.split("\n");
        if (lines.every((l) => /^[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="mb-4 list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inlineMarks(l.replace(/^[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="mb-3 leading-relaxed">
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j ? <br /> : null}
                {inlineMarks(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function HistoryList({ posts, loaded }: { posts: BlogPost[]; loaded: boolean }) {
  const publish = usePublish();
  if (loaded && posts.length === 0) return <p style={body}>Nothing published yet.</p>;
  return (
    <div className="space-y-3">
      {publish.error ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(publish.error, "Couldn't publish the post")}</p> : null}
      {posts.map((p) => (
        <div key={p.id} className="flex gap-4 rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="history-row">
          {p.photos[0] ? <img src={p.photos[0].url} alt="" className="h-20 w-24 shrink-0 rounded object-cover" style={{ backgroundColor: "var(--jms-bg)" }} /> : null}
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-x-3" style={muted}>
              <span className="font-semibold uppercase" style={{ color: STATUS_COLOURS[p.status] }}>
                {p.status}
              </span>
              <span>{fmtWhen(p.published_at ?? p.created_at)}</span>
              {p.suburb ? <span>· {p.suburb}</span> : null}
              {p.job_card_id ? (
                <Link to={`/jobs/${p.job_card_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                  · Job
                </Link>
              ) : null}
            </div>
            <p className="font-semibold" style={body}>
              {p.title}
            </p>
            {p.status === "published" && p.published_url ? (
              <a href={p.published_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                View on the website ↗
              </a>
            ) : null}
            {p.status === "failed" && p.error ? (
              <p className="mt-1" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                {p.error}
              </p>
            ) : null}
          </div>
          {p.status === "failed" || p.status === "approved" ? (
            <div className="shrink-0">
              <ThemedButton onClick={() => publish.mutate({ post_id: p.id })} disabled={publish.isPending} style={{ paddingBlock: 4, paddingInline: 12 }}>
                {publish.isPending && publish.variables?.post_id === p.id ? "Publishing..." : "Try again"}
              </ThemedButton>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SettingsForm({ settings }: { settings: BlogSettings | null }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [repo, setRepo] = useState(settings?.github_repo ?? "");
  const [branch, setBranch] = useState(settings?.github_branch ?? "main");
  const [siteUrl, setSiteUrl] = useState(settings?.site_url ?? "");
  const [businessName, setBusinessName] = useState(settings?.business_name ?? "");
  const [businessDescription, setBusinessDescription] = useState(settings?.business_description ?? "");
  const [voiceNotes, setVoiceNotes] = useState(settings?.voice_notes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const r = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
      if (r && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) throw new Error('The repository should look like "owner/name", e.g. elyasbingley/bingley-growth-plan.');
      const site = siteUrl.trim().replace(/\/+$/, "");
      if (site && !/^https:\/\//.test(site)) throw new Error("The website address should start with https://");
      const { error } = await supabase.from("blog_settings").upsert({
        tenant_id: profile.tenant_id,
        enabled,
        github_repo: r || null,
        github_branch: branch.trim() || "main",
        site_url: site || null,
        business_name: businessName.trim() || null,
        business_description: businessDescription.trim() || null,
        voice_notes: voiceNotes.trim() || null,
      });
      if (error) throw error;
      setRepo(r);
      setSiteUrl(site);
    },
    onSuccess: () => {
      setFormError(null);
      setMessage("Saved.");
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      setMessage(null);
      setFormError(getErrorMessage(e, "Couldn't save"));
    },
  });

  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        save.mutate();
      }}
      data-testid="blog-settings"
    >
      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <label className="flex items-start gap-3" style={body}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-1 h-4 w-4" style={{ accentColor: "var(--jms-accent)" }} />
          <span>
            <strong>Write blog drafts on a schedule</strong>
            <span className="block" style={muted}>
              Tuesday, Thursday and Saturday mornings, from a finished job with photos marked OK for marketing. Only one draft waits at a time. "Write one now" works either way.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          Website
        </h2>
        <div className="grid gap-3 md:grid-cols-[1fr_160px]">
          <div>
            <label className={labelClass} style={muted} htmlFor="blog-repo">
              GitHub repository
            </label>
            <input id="blog-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={inputClass} style={inputStyle} placeholder="elyasbingley/bingley-growth-plan" />
          </div>
          <div>
            <label className={labelClass} style={muted} htmlFor="blog-branch">
              Branch
            </label>
            <input id="blog-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={inputClass} style={inputStyle} placeholder="main" />
          </div>
        </div>
        <div>
          <label className={labelClass} style={muted} htmlFor="blog-site">
            Website address
          </label>
          <input id="blog-site" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} className={inputClass} style={inputStyle} placeholder="https://www.bingleytrades.com.au" />
        </div>
        <p style={muted}>
          Posts are committed to this repository's branch, and Vercel publishes the site from it. The GitHub access token is a server secret (WEBSITE_GITHUB_TOKEN), not
          kept here - see BLOG_SETUP.md.
        </p>
      </section>

      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          How posts are written
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className={labelClass} style={muted} htmlFor="blog-business-name">
              Business name
            </label>
            <input id="blog-business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputClass} style={inputStyle} placeholder="Bingley Trade Services" />
          </div>
          <div>
            <label className={labelClass} style={muted} htmlFor="blog-business-description">
              What the business is
            </label>
            <input
              id="blog-business-description"
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="a roofing and plumbing business in Western Sydney"
            />
          </div>
        </div>
        <div>
          <label className={labelClass} style={muted} htmlFor="blog-voice">
            Extra rules for the writer (optional)
          </label>
          <textarea
            id="blog-voice"
            value={voiceNotes}
            onChange={(e) => setVoiceNotes(e.target.value)}
            rows={3}
            className={inputClass}
            style={inputStyle}
            placeholder="e.g. Sign off as The Leak Detective. Link to /our-services/roof-repairs when it fits."
          />
        </div>
      </section>

      {formError ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{formError}</p> : null}
      {message ? <p style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{message}</p> : null}
      <ThemedButton type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save settings"}
      </ThemedButton>
    </form>
  );
}
