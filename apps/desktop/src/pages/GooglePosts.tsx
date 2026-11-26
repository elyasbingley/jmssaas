import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GbpCtaType, GbpPost, GbpSettings } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { functionErrorMessage } from "../lib/marketing-photo";
import { ThemedButton } from "../components/theme/ThemedButton";

// Marketing > Google Posts (Google Business Profile posting via Zapier -
// see GBP_SETUP.md). Drafts that gbp-draft writes on Mon/Wed/Fri wait here
// for an admin to approve (with any edits) or skip; History shows what was
// published or failed; Settings holds the Zapier webhook and caption setup.

type Tab = "drafts" | "history" | "settings";
const KEY = ["gbp"];
const MAX_CAPTION = 1500;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const inputClass = "w-full rounded border px-2 py-1.5 focus:outline-none";
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const labelClass = "mb-1 block uppercase tracking-wide";

const STATUS_COLOURS: Record<GbpPost["status"], string> = {
  draft: "var(--jms-warning)",
  approved: "var(--jms-accent)",
  published: "var(--jms-accent)",
  failed: "var(--jms-danger)",
  skipped: "var(--jms-text-muted)",
};

function fmtWhen(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
}

export default function GooglePostsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (["drafts", "history", "settings"] as Tab[]).includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "drafts";
  const setTab = (t: Tab) => setParams(t === "drafts" ? {} : { tab: t }, { replace: true });

  const settings = useQuery({
    queryKey: [...KEY, "settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("gbp_settings").select("*").maybeSingle();
      if (error) throw error;
      return (data as GbpSettings | null) ?? null;
    },
  });
  const posts = useQuery({
    queryKey: [...KEY, "posts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("gbp_posts").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data as GbpPost[];
    },
  });
  const readyPhotos = useQuery({
    queryKey: [...KEY, "ready-photos"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("job_files")
        .select("id", { count: "exact", head: true })
        .eq("marketing_ok", true)
        .is("used_in_post_id", null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const drafts = (posts.data ?? []).filter((p) => p.status === "draft");
  const history = (posts.data ?? []).filter((p) => p.status !== "draft");
  const loadError = settings.error ?? posts.error;
  const s = settings.data;

  return (
    <div className="mx-auto max-w-5xl p-6" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Google Posts
      </h1>
      <p className="mb-5 max-w-3xl" style={muted}>
        Job photos marked <strong>OK for marketing</strong> become posts on your Google Business Profile. On Monday, Wednesday and Friday mornings a draft is written for
        you from one of those photos; approve it (with any changes) and it goes to Google through Zapier.
      </p>

      {loadError ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {getErrorMessage(loadError, "Couldn't load Google posts")}
        </p>
      ) : null}

      {settings.data !== undefined && (!s || !s.enabled || !s.zapier_webhook_url) ? (
        <p className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-warning)", color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }} data-testid="setup-warning">
          {!s || !s.enabled ? "Posting is switched off, so no drafts will be written." : "No Zapier webhook is set yet, so approved posts can't be sent."}{" "}
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
          <p style={muted}>
            {readyPhotos.data === undefined
              ? ""
              : readyPhotos.data === 0
                ? "No photos are waiting to be used. Mark job photos OK for marketing on the job (hover a photo) or in the phone app (hold a photo)."
                : `${readyPhotos.data} photo${readyPhotos.data === 1 ? "" : "s"} marked OK for marketing and not used yet.`}
          </p>
          {posts.data && drafts.length === 0 ? <p style={body}>No drafts waiting. The next one is written on Monday, Wednesday or Friday morning.</p> : null}
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
    mutationFn: async (p: { post_id: string; summary?: string; resend?: boolean }) => {
      const { error } = await supabase.functions.invoke("gbp-publish", { body: p });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't send the post"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

function DraftCard({ post }: { post: GbpPost }) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState(post.summary);
  useEffect(() => setSummary(post.summary), [post.summary]);
  const publish = usePublish();
  const skip = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("gbp_posts").update({ status: "skipped" }).eq("id", post.id);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const tooLong = summary.length > MAX_CAPTION;
  const busy = publish.isPending || skip.isPending;
  const err = publish.error ?? skip.error;

  return (
    <div className="grid gap-4 rounded p-4 md:grid-cols-[280px_1fr]" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="draft-card">
      <a href={post.photo_url} target="_blank" rel="noreferrer" className="block">
        <img src={post.photo_url} alt="The job photo for this post" className="aspect-[4/3] w-full rounded object-cover" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }} />
      </a>
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1" style={muted}>
          <span>Drafted {fmtWhen(post.created_at)}</span>
          {post.job_type ? <span>· {post.job_type}</span> : null}
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
        <label className={labelClass} style={muted} htmlFor={`caption-${post.id}`}>
          Caption
        </label>
        <textarea
          id={`caption-${post.id}`}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={7}
          className={inputClass}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        <p className="mb-2 mt-1 text-right" style={{ ...muted, color: tooLong ? "var(--jms-danger)" : muted.color }}>
          {summary.length} / {MAX_CAPTION}
        </p>
        <p className="mb-3" style={muted}>
          Button: <strong style={{ color: "var(--jms-text)" }}>{post.cta_type === "CALL" ? "Call now" : "Learn more"}</strong>
          {post.cta_type === "LEARN_MORE" && post.cta_url ? (
            <>
              {" → "}
              <a href={post.cta_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                {post.cta_url}
              </a>
            </>
          ) : null}
        </p>
        {err ? (
          <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {getErrorMessage(err, "Something went wrong")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <ThemedButton
            onClick={() => publish.mutate({ post_id: post.id, summary: summary.trim() !== post.summary ? summary : undefined })}
            disabled={busy || tooLong || !summary.trim()}
          >
            {publish.isPending ? "Sending..." : post.concerns.length ? "Approve anyway" : "Approve and post"}
          </ThemedButton>
          <ThemedButton
            variant="secondary"
            onClick={() => {
              if (window.confirm("Skip this post? The photo won't be suggested again.")) skip.mutate();
            }}
            disabled={busy}
          >
            Skip
          </ThemedButton>
        </div>
      </div>
    </div>
  );
}

function HistoryList({ posts, loaded }: { posts: GbpPost[]; loaded: boolean }) {
  const publish = usePublish();
  if (loaded && posts.length === 0) return <p style={body}>Nothing posted yet.</p>;
  return (
    <div className="space-y-3">
      {publish.error ? (
        <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(publish.error, "Couldn't send the post")}</p>
      ) : null}
      {posts.map((p) => (
        <div key={p.id} className="flex gap-4 rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="history-row">
          <img src={p.photo_url} alt="" className="h-20 w-24 shrink-0 rounded object-cover" style={{ backgroundColor: "var(--jms-bg)" }} />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-x-3" style={muted}>
              <span className="font-semibold uppercase" style={{ color: STATUS_COLOURS[p.status] }}>
                {p.status}
              </span>
              <span>{fmtWhen(p.published_at ?? p.created_at)}</span>
              {p.job_type ? <span>· {p.job_type}</span> : null}
              {p.job_card_id ? (
                <Link to={`/jobs/${p.job_card_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                  · Job
                </Link>
              ) : null}
            </div>
            <p className="line-clamp-2 whitespace-pre-line" style={body}>
              {p.summary}
            </p>
            {p.status === "failed" && p.error ? (
              <p className="mt-1" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                {p.error}
              </p>
            ) : null}
          </div>
          {p.status === "failed" || p.status === "approved" ? (
            <div className="shrink-0">
              <ThemedButton onClick={() => publish.mutate({ post_id: p.id })} disabled={publish.isPending} style={{ paddingBlock: 4, paddingInline: 12 }}>
                {publish.isPending && publish.variables?.post_id === p.id ? "Sending..." : "Try again"}
              </ThemedButton>
            </div>
          ) : null}
          {p.status === "published" ? (
            <div className="shrink-0">
              <ThemedButton
                variant="secondary"
                onClick={() => {
                  if (
                    window.confirm(
                      "Send this post to Zapier again?\n\nUse this if it never showed up on Google (for example, the Zap was off). If the first one did get through, Google will get it twice."
                    )
                  )
                    publish.mutate({ post_id: p.id, resend: true });
                }}
                disabled={publish.isPending}
                style={{ paddingBlock: 4, paddingInline: 12 }}
                data-testid="resend"
              >
                {publish.isPending && publish.variables?.post_id === p.id ? "Sending..." : "Send to Zapier again"}
              </ThemedButton>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SettingsForm({ settings }: { settings: GbpSettings | null }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [autoPublish, setAutoPublish] = useState(settings?.auto_publish ?? false);
  const [webhook, setWebhook] = useState("");
  const [editingWebhook, setEditingWebhook] = useState(!settings?.zapier_webhook_url);
  const [businessName, setBusinessName] = useState(settings?.business_name ?? "");
  const [businessDescription, setBusinessDescription] = useState(settings?.business_description ?? "");
  const [ctaType, setCtaType] = useState<GbpCtaType>(settings?.default_cta_type ?? "LEARN_MORE");
  const [ctaUrl, setCtaUrl] = useState(settings?.default_cta_url ?? "");
  const [services, setServices] = useState<{ key: string; url: string }[]>(
    Object.entries(settings?.service_urls ?? {}).map(([key, url]) => ({ key, url }))
  );
  const [voiceNotes, setVoiceNotes] = useState(settings?.voice_notes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const hook = editingWebhook ? webhook.trim() : settings?.zapier_webhook_url ?? "";
      if (hook && !/^https:\/\/hooks\.zapier\.com\//.test(hook)) throw new Error("The webhook should start with https://hooks.zapier.com/ (copy it from your Zap's Catch Hook step).");
      if (enabled && !hook) throw new Error("Add the Zapier webhook before switching posting on.");
      if (ctaType === "LEARN_MORE" && ctaUrl.trim() && !/^https?:\/\//.test(ctaUrl.trim())) throw new Error("The default link should start with https://");
      const serviceUrls: Record<string, string> = {};
      for (const { key, url } of services) {
        const k = key.trim().toLowerCase().replace(/\s+/g, "-");
        if (!k && !url.trim()) continue;
        if (!k || !/^https?:\/\//.test(url.trim())) throw new Error("Each service needs a short name and a link starting with https://");
        serviceUrls[k] = url.trim();
      }
      const { error } = await supabase.from("gbp_settings").upsert({
        tenant_id: profile.tenant_id,
        enabled,
        auto_publish: autoPublish,
        zapier_webhook_url: hook || null,
        business_name: businessName.trim() || null,
        business_description: businessDescription.trim() || null,
        default_cta_type: ctaType,
        default_cta_url: ctaUrl.trim() || null,
        service_urls: serviceUrls,
        voice_notes: voiceNotes.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setFormError(null);
      setMessage("Saved.");
      setWebhook("");
      setEditingWebhook(false);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      setMessage(null);
      setFormError(getErrorMessage(e, "Couldn't save"));
    },
  });

  const savedHook = settings?.zapier_webhook_url;
  const maskedHook = savedHook ? `${savedHook.slice(0, 31)}••••••${savedHook.slice(-4)}` : "";

  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        save.mutate();
      }}
      data-testid="gbp-settings"
    >
      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <label className="flex items-start gap-3" style={body}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-1 h-4 w-4" style={{ accentColor: "var(--jms-accent)" }} />
          <span>
            <strong>Write Google post drafts</strong>
            <span className="block" style={muted}>
              Monday, Wednesday and Friday mornings, from a photo marked OK for marketing. Only one draft waits at a time.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3" style={body}>
          <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} className="mt-1 h-4 w-4" style={{ accentColor: "var(--jms-accent)" }} />
          <span>
            <strong>Post without asking me</strong>
            <span className="block" style={muted}>
              Only when Claude finds nothing wrong with the photo; anything flagged still waits for you. Leave this off for the first few weeks.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          Zapier
        </h2>
        <div>
          <span className={labelClass} style={muted}>
            Webhook URL
          </span>
          {editingWebhook ? (
            <input
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="https://hooks.zapier.com/hooks/catch/..."
              className={inputClass}
              style={inputStyle}
              autoComplete="off"
              aria-label="Zapier webhook URL"
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <code style={body}>{maskedHook}</code>
              <button type="button" className="hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }} onClick={() => setEditingWebhook(true)}>
                Change
              </button>
            </div>
          )}
          <p className="mt-1" style={muted}>
            From your Zap's "Catch Hook" trigger. Anyone with this link can post to your profile, so it's hidden once saved.
          </p>
        </div>
      </section>

      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          How captions are written
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className={labelClass} style={muted} htmlFor="gbp-business-name">
              Business name
            </label>
            <input id="gbp-business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputClass} style={inputStyle} placeholder="Bingley Trade Services" />
          </div>
          <div>
            <label className={labelClass} style={muted} htmlFor="gbp-business-description">
              What the business is
            </label>
            <input
              id="gbp-business-description"
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="a roofing and plumbing business in Western Sydney"
            />
          </div>
        </div>
        <div>
          <label className={labelClass} style={muted} htmlFor="gbp-voice">
            Extra rules for the writer (optional)
          </label>
          <textarea
            id="gbp-voice"
            value={voiceNotes}
            onChange={(e) => setVoiceNotes(e.target.value)}
            rows={3}
            className={inputClass}
            style={inputStyle}
            placeholder='e.g. Sign-off persona is The Leak Detective. For roof inspections, use "report first, no obligation".'
          />
        </div>
      </section>

      <section className="space-y-3 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          Button on the post
        </h2>
        <div className="grid gap-3 md:grid-cols-[200px_1fr]">
          <div>
            <label className={labelClass} style={muted} htmlFor="gbp-cta">
              Default button
            </label>
            <select id="gbp-cta" value={ctaType} onChange={(e) => setCtaType(e.target.value as GbpCtaType)} className={inputClass} style={inputStyle}>
              <option value="LEARN_MORE">Learn more (a link)</option>
              <option value="CALL">Call now</option>
            </select>
          </div>
          {ctaType === "LEARN_MORE" ? (
            <div>
              <label className={labelClass} style={muted} htmlFor="gbp-cta-url">
                Default link
              </label>
              <input id="gbp-cta-url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} className={inputClass} style={inputStyle} placeholder="https://bingleytrades.com.au" />
            </div>
          ) : null}
        </div>
        <div>
          <span className={labelClass} style={muted}>
            Service pages
          </span>
          <p className="mb-2" style={muted}>
            When a post matches one of these services, its button links to that page instead of the default.
          </p>
          <div className="space-y-2">
            {services.map((row, i) => (
              <div key={i} className="grid grid-cols-[180px_1fr_auto] gap-2" data-testid="service-row">
                <input
                  value={row.key}
                  onChange={(e) => setServices(services.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                  className={inputClass}
                  style={inputStyle}
                  placeholder="roof-repairs"
                  aria-label="Service name"
                />
                <input
                  value={row.url}
                  onChange={(e) => setServices(services.map((r, j) => (j === i ? { ...r, url: e.target.value } : r)))}
                  className={inputClass}
                  style={inputStyle}
                  placeholder="https://bingleytrades.com.au/roof-repairs"
                  aria-label="Service page link"
                />
                <button type="button" onClick={() => setServices(services.filter((_, j) => j !== i))} className="px-2 hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setServices([...services, { key: "", url: "" }])} className="mt-2 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            + Add a service page
          </button>
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
