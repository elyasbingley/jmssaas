// blog-draft
// Writes a website blog post (a case study) about a finished job, for an
// admin to review in More > Blog Posts (see BLOG_SETUP.md).
//
// Two ways in:
//   - pg_cron (Tue/Thu/Sat), header x-cron-secret: <CRON_SECRET>. For every
//     company with blog drafts on: picks a finished job with photos marked
//     OK for marketing that hasn't had a post, and writes one (unless a
//     draft is already waiting).
//   - An admin's "Write one now" (their own login token), optionally for a
//     chosen job: body { "job_card_id": "..." }.
//
// Deploy with:  supabase functions deploy blog-draft --no-verify-jwt
// (the function checks the cron secret or the admin's token itself).

import Anthropic from "npm:@anthropic-ai/sdk@0.71.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanText, corsHeaders, slugify } from "../_shared/blog.ts";

const MODEL = "claude-opus-5-5";
const LOOKBACK_DAYS = 180;
const MAX_PHOTOS = 4;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Only needed for an API key that isn't scoped to a workspace (see gbp-draft).
const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));

  // Who's asking: the schedule (every company) or an admin (their company).
  let onlyTenant: string | null = null;
  let manual = false;
  if (CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET) {
    onlyTenant = typeof body.tenant_id === "string" ? body.tenant_id : null;
  } else {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorised" }, 401);
    const { data: profile } = await admin.from("profiles").select("tenant_id, role").eq("id", user.id).maybeSingle();
    if (!profile || profile.role !== "admin") return json({ error: "Only an admin can write blog posts" }, 403);
    onlyTenant = profile.tenant_id as string;
    manual = true;
  }

  let query = admin.from("blog_settings").select("*");
  if (!manual) query = query.eq("enabled", true);
  if (onlyTenant) query = query.eq("tenant_id", onlyTenant);
  const { data: tenants, error } = await query;
  if (error) return json({ error: error.message }, 500);
  if (manual && !tenants?.length) return json({ error: "Save the blog settings first (More > Blog Posts > Settings)." }, 400);

  const results = [];
  for (const settings of tenants ?? []) {
    try {
      results.push(await draftForTenant(admin, settings, { manual, jobCardId: typeof body.job_card_id === "string" ? body.job_card_id : null }));
    } catch (e) {
      console.error("[blog-draft]", settings.tenant_id, e);
      results.push({ tenant_id: settings.tenant_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ results });
});

interface Settings {
  tenant_id: string;
  business_name: string | null;
  business_description: string | null;
  voice_notes: string | null;
}
interface PhotoRow {
  id: string;
  job_card_id: string;
  marketing_path: string;
  created_at: string;
}
interface JobRow {
  id: string;
  title: string;
  description: string | null;
  client_id: string;
  site_id: string | null;
  property_id: string | null;
  service_category_id: string | null;
  lifecycle_stage_id: string | null;
  completed_at: string | null;
  created_at: string;
}

async function draftForTenant(admin: SupabaseClient, s: Settings, opts: { manual: boolean; jobCardId: string | null }) {
  const tenantId = s.tenant_id;

  // Don't pile up drafts (the schedule only; "Write one now" always writes).
  if (!opts.manual) {
    const { count } = await admin.from("blog_posts").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "draft");
    if ((count ?? 0) > 0) return { tenant_id: tenantId, skipped: "a draft is already waiting for review" };
  }

  // --- 1. Candidate jobs: marketing photos, finished, no post yet -----------
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  let photoQuery = admin
    .from("job_files")
    .select("id, job_card_id, marketing_path, created_at")
    .eq("tenant_id", tenantId)
    .eq("marketing_ok", true)
    .not("marketing_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  photoQuery = opts.jobCardId ? photoQuery.eq("job_card_id", opts.jobCardId) : photoQuery.gte("created_at", since);
  const { data: photoRows, error: photoErr } = await photoQuery;
  if (photoErr) throw photoErr;
  const photosByJob = new Map<string, PhotoRow[]>();
  for (const p of (photoRows ?? []) as PhotoRow[]) photosByJob.set(p.job_card_id, [...(photosByJob.get(p.job_card_id) ?? []), p]);
  if (!photosByJob.size) {
    return { tenant_id: tenantId, skipped: opts.jobCardId ? "that job has no photos marked OK for marketing" : "no finished jobs with photos marked OK for marketing" };
  }

  const { data: done } = await admin.from("blog_posts").select("job_card_id").eq("tenant_id", tenantId).not("job_card_id", "is", null);
  const alreadyPosted = new Set((done ?? []).map((r: { job_card_id: string }) => r.job_card_id));
  if (opts.jobCardId && alreadyPosted.has(opts.jobCardId)) return { tenant_id: tenantId, skipped: "that job already has a blog post" };

  const { data: jobRows, error: jobErr } = await admin
    .from("job_cards")
    .select("id, title, description, client_id, site_id, property_id, service_category_id, lifecycle_stage_id, completed_at, created_at")
    .in("id", [...photosByJob.keys()].filter((id) => !alreadyPosted.has(id)));
  if (jobErr) throw jobErr;
  const { data: stages } = await admin.from("job_lifecycle_stages").select("id, is_closed").eq("tenant_id", tenantId);
  const closed = new Set((stages ?? []).filter((st: { is_closed: boolean }) => st.is_closed).map((st: { id: string }) => st.id));
  const finished = ((jobRows ?? []) as JobRow[]).filter((j) => opts.jobCardId || j.completed_at || (j.lifecycle_stage_id && closed.has(j.lifecycle_stage_id)));
  if (!finished.length) return { tenant_id: tenantId, skipped: "no finished jobs with photos marked OK for marketing" };

  const categories = await byId(admin, "service_categories", "id, name", finished.map((j) => j.service_category_id));
  const jobType = (j: JobRow) => (j.service_category_id ? (categories.get(j.service_category_id)?.name as string | undefined) ?? null : null);

  // Rotate job types against the last three posts; prefer jobs with more
  // photos, then the most recent.
  const { data: recent } = await admin.from("blog_posts").select("job_type").eq("tenant_id", tenantId).neq("status", "skipped").order("created_at", { ascending: false }).limit(3);
  const recentTypes = new Set((recent ?? []).map((r: { job_type: string | null }) => r.job_type).filter(Boolean));
  const score = (j: JobRow) => {
    const photos = photosByJob.get(j.id)!;
    return (recentTypes.has(jobType(j)) ? 0 : 1000) + Math.min(photos.length, MAX_PHOTOS) * 100 + new Date(photos[0]!.created_at).getTime() / 1e13;
  };
  const job = [...finished].sort((a, b) => score(b) - score(a))[0]!;
  const photos = photosByJob.get(job.id)!.slice(0, MAX_PHOTOS);
  const photoUrls = photos.map((p) => `${SUPABASE_URL}/storage/v1/object/public/marketing/${p.marketing_path}`);

  // --- 2. What happened on the job --------------------------------------------
  const suburb = await jobSuburb(admin, job);
  const { data: notes } = await admin.from("job_notes").select("body, created_at").eq("job_card_id", job.id).order("created_at").limit(15);
  const work = await workDone(admin, job.id);
  const context = {
    job_title: job.title,
    job_description: job.description,
    job_type: jobType(job),
    suburb,
    finished: (job.completed_at ?? job.created_at).slice(0, 7),
    work_done: work,
    tech_notes: (notes ?? []).map((n: { body: string }) => n.body.slice(0, 600)),
  };

  // --- 3. The post, from Claude -----------------------------------------------
  const draft = await writePost({
    businessName: s.business_name ?? "a local trade business",
    businessDescription: s.business_description ?? "",
    voiceNotes: s.voice_notes ?? "",
    photoUrls,
    context,
  });

  // A free slug among this company's posts (the website's own pages are
  // checked again when it's published).
  const base = slugify(draft.slug || draft.title);
  let slug = base;
  for (let n = 2; ; n++) {
    const { count } = await admin.from("blog_posts").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("slug", slug);
    if (!count) break;
    slug = `${base.slice(0, 80)}-${n}`;
  }

  const { data: post, error: insErr } = await admin
    .from("blog_posts")
    .insert({
      tenant_id: tenantId,
      job_card_id: job.id,
      slug,
      title: draft.title,
      description: draft.description,
      // Drop any [[photo:N]] for a photo this post doesn't have.
      body: draft.body.replace(/^\[\[photo:(\d+)\]\]\n*/gm, (m, n) => (Number(n) >= 1 && Number(n) <= photos.length ? m : "")).trim(),
      suburb,
      job_type: jobType(job),
      photos: photos.map((p, i) => ({ job_file_id: p.id, url: photoUrls[i], alt: draft.photo_alts[i] || `${job.title}${suburb ? ` in ${suburb}` : ""}` })),
      cta: draft.cta,
      concerns: draft.concerns,
      status: "draft",
    })
    .select("id")
    .single();
  if (insErr) throw insErr;

  if (!opts.manual) await notifyAdmins(admin, tenantId, post.id, draft.title, draft.concerns.length);
  return { tenant_id: tenantId, drafted: post.id, job_card_id: job.id, concerns: draft.concerns };
}

async function byId(admin: SupabaseClient, table: string, cols: string, ids: (string | null)[]) {
  const list = [...new Set(ids.filter((v): v is string => !!v))];
  if (!list.length) return new Map<string, Record<string, unknown>>();
  const { data, error } = await admin.from(table).select(cols).in("id", list);
  if (error) throw error;
  return new Map(((data ?? []) as unknown as Record<string, unknown>[]).map((r) => [r.id as string, r]));
}

// The job's suburb: its site, else its agency property, else its client.
async function jobSuburb(admin: SupabaseClient, job: JobRow): Promise<string | null> {
  const [site, property, client] = await Promise.all([
    byId(admin, "client_sites", "id, suburb", [job.site_id]),
    byId(admin, "properties", "id, suburb", [job.property_id]),
    byId(admin, "clients", "id, suburb", [job.client_id]),
  ]);
  return ((job.site_id && site.get(job.site_id)?.suburb) || (job.property_id && property.get(job.property_id)?.suburb) || client.get(job.client_id)?.suburb || null) as string | null;
}

// What was done: the job's invoice lines, else its accepted quote's lines.
async function workDone(admin: SupabaseClient, jobId: string): Promise<string[]> {
  const lines = async (parent: "invoices" | "quotes", status: string[]) => {
    const { data: docs } = await admin.from(parent).select("id").eq("job_card_id", jobId).in("status", status);
    const ids = (docs ?? []).map((d: { id: string }) => d.id);
    if (!ids.length) return [];
    const { data } = await admin
      .from(parent === "invoices" ? "invoice_line_items" : "quote_line_items")
      .select("description, quantity")
      .in(parent === "invoices" ? "invoice_id" : "quote_id", ids)
      .order("sort_order");
    return (data ?? []).map((l: { description: string; quantity: number }) => `${l.description}${Number(l.quantity) !== 1 ? ` (x${l.quantity})` : ""}`);
  };
  const fromInvoices = await lines("invoices", ["draft", "sent", "paid", "overdue"]);
  return (fromInvoices.length ? fromInvoices : await lines("quotes", ["accepted"])).slice(0, 30);
}

async function notifyAdmins(admin: SupabaseClient, tenantId: string, postId: string, title: string, concernCount: number) {
  try {
    const { data: admins } = await admin.from("profiles").select("id").eq("tenant_id", tenantId).eq("role", "admin");
    const recipients = (admins ?? []).map((p: { id: string }) => p.id);
    if (!recipients.length) return;
    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenantId,
        recipient_profile_ids: recipients,
        type: "blog_draft",
        title: "New blog post ready to review",
        body: concernCount ? `"${title}" - check it first: ${concernCount} thing${concernCount === 1 ? "" : "s"} flagged.` : `"${title}" - approve, edit or skip it in Blog Posts.`,
        data: { post_id: postId },
      }),
    });
  } catch (e) {
    console.error("[blog-draft] notification failed", e);
  }
}

interface PostInput {
  businessName: string;
  businessDescription: string;
  voiceNotes: string;
  photoUrls: string[];
  context: Record<string, unknown>;
}
interface PostOutput {
  title: string;
  slug: string;
  description: string;
  body: string;
  photo_alts: string[];
  cta: { heading: string; text: string; button: string };
  concerns: string[];
}

async function writePost(input: PostInput): Promise<PostOutput> {
  const who = input.businessDescription ? `${input.businessName}, ${input.businessDescription}` : input.businessName;
  const n = input.photoUrls.length;
  const system = `You write case-study blog posts for the website of ${who}, about jobs the business has finished.

Write for homeowners searching Google for help with the same problem in their area.

Rules:
- Write as the owner, in first person ("we"), in plain Australian English. Grounded and practical, not salesy. No clever wordplay.
- Never use em dashes or en dashes. Use commas or full stops.
- 450 to 750 words in the body.
- Cover: what the customer noticed, what we found and why it happens, what we did, the result, and one or two practical tips for homeowners.
- Mention the suburb naturally (in the title too) if given. Never mention a street name, house number, or any customer's or worker's name.
- Only state facts from the job details and what you can see in the photos. Do not invent measurements, prices, timeframes or outcomes. If something isn't known, leave it out.
- No hashtags, no emojis, no prices.
${input.voiceNotes ? `\nExtra rules from the owner:\n${input.voiceNotes}\n` : ""}
Format of "body" (plain text, blocks separated by a blank line):
- "## " starts a section heading (use 3 to 5 of them), "### " a smaller one.
- Lines starting "- " are a bulleted list.
- **bold** for emphasis, sparingly.
- Put each photo where it helps on its own line as [[photo:N]] (N from 1 to ${n}). Photo 1 is shown at the top, so place photos 2 to ${n} in the body.
- Do not repeat the title as a heading.

"title": under 70 characters, says the problem and the suburb.
"slug": lowercase words joined by hyphens, under 70 characters.
"description": the Google search snippet, 120 to 155 characters.
"photo_alts": one short factual description per photo, in order (${n} of them).
"cta": a short heading, one sentence, and a button label (under 30 characters, ending with " →") for the box at the end.
"concerns": list anything a person should check before this goes public: a readable house number, street sign, number plate or face in a photo, anything identifying the customer, a claim you weren't sure of, or a photo that doesn't show trade work. Empty if none.`;

  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      description: { type: "string" },
      body: { type: "string" },
      photo_alts: { type: "array", items: { type: "string" } },
      cta: {
        type: "object",
        properties: { heading: { type: "string" }, text: { type: "string" }, button: { type: "string" } },
        required: ["heading", "text", "button"],
        additionalProperties: false,
      },
      concerns: { type: "array", items: { type: "string" } },
    },
    required: ["title", "slug", "description", "body", "photo_alts", "cta", "concerns"],
    additionalProperties: false,
  };

  const anthropic = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    defaultHeaders: ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : undefined,
  });
  // Server-side fallback: if a safety classifier declines, the API retries on
  // a suitable model in the same call. These fields are newer than this SDK
  // version's types, so they're passed through untyped (sent as given).
  const params = {
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: { type: "json_schema", schema } },
    system,
    messages: [
      {
        role: "user",
        content: [
          ...input.photoUrls.map((url) => ({ type: "image", source: { type: "url", url } })),
          { type: "text", text: `Job details:\n${JSON.stringify(input.context, null, 2)}\n\nThe ${n} photo${n === 1 ? " is" : "s are"} above, in order. Write the post.` },
        ],
      },
    ],
  };
  // deno-lint-ignore no-explicit-any
  const response = await anthropic.beta.messages.create(params as any);
  if (response.stop_reason === "refusal") throw new Error("Claude declined to write about this job");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's reply was cut off (max_tokens)");
  // deno-lint-ignore no-explicit-any
  const text = (response.content as any[]).find((c) => c.type === "text")?.text ?? "";
  if (!text) throw new Error(`Claude returned no post (stop_reason ${response.stop_reason})`);
  const p = JSON.parse(text);

  const title = cleanText(String(p.title ?? "")).slice(0, 140);
  const body = cleanText(String(p.body ?? "")).slice(0, 20000);
  const description = cleanText(String(p.description ?? "")).slice(0, 320);
  if (!title || !body || !description) throw new Error("Claude returned an empty post");
  return {
    title,
    slug: String(p.slug ?? ""),
    description,
    body,
    photo_alts: Array.isArray(p.photo_alts) ? p.photo_alts.map((a: unknown) => cleanText(String(a)).slice(0, 200)) : [],
    cta: {
      heading: cleanText(String(p.cta?.heading ?? "")).slice(0, 100),
      text: cleanText(String(p.cta?.text ?? "")).slice(0, 300),
      button: cleanText(String(p.cta?.button ?? "")).slice(0, 40),
    },
    concerns: Array.isArray(p.concerns) ? p.concerns.map(String) : [],
  };
}
