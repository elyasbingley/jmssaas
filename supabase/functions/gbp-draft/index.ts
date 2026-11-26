// gbp-draft
// Run by pg_cron (Mon/Wed/Fri - see GBP_SETUP.md). For each company with
// Google posting enabled:
//   1. picks an unused marketing-approved job photo, rotating job types
//   2. has Claude write the caption from the photo + job details
//   3. saves a draft and tells the admins (or publishes straight away if
//      auto_publish is on and Claude found no privacy or quality concerns)
//
// Deploy with:  supabase functions deploy gbp-draft --no-verify-jwt
// Auth: requires header  x-cron-secret: <CRON_SECRET>
//
// Fitted to JMS: photos are job_files (image/* rows) on job_cards; the
// suburb comes from the job's site, else its agency property, else its
// client; the "job type" is the job's service category. Claude is called
// through the official SDK (as process-inbox-ai-parse does), with
// structured output so the reply is always valid JSON in the right shape.

import Anthropic from "npm:@anthropic-ai/sdk@0.71.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanCaption, publishPost } from "../_shared/gbp.ts";

const MODEL = "claude-sonnet-5-5";
const LOOKBACK_DAYS = 120;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Only needed for an API key that isn't scoped to a workspace: the API then
// asks which workspace to bill (anthropic-workspace-id header).
const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";

Deno.serve(async (req) => {
  // An unset CRON_SECRET must not let an empty header through.
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorised", { status: 401 });
  }
  if (!ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 500 });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));

  let query = admin.from("gbp_settings").select("*").eq("enabled", true);
  if (body.tenant_id) query = query.eq("tenant_id", body.tenant_id);
  const { data: tenants, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const settings of tenants ?? []) {
    try {
      results.push(await draftForTenant(admin, settings));
    } catch (e) {
      console.error("[gbp-draft]", settings.tenant_id, e);
      results.push({ tenant_id: settings.tenant_id, error: String(e) });
    }
  }
  return Response.json({ results });
});

interface Settings {
  tenant_id: string;
  auto_publish: boolean;
  business_name: string | null;
  business_description: string | null;
  default_cta_type: "LEARN_MORE" | "CALL" | null;
  default_cta_url: string | null;
  service_urls: Record<string, string> | null;
  voice_notes: string | null;
}
interface Photo {
  id: string;
  job_card_id: string;
  marketing_path: string;
  created_at: string;
}
interface JobInfo {
  title: string | null;
  suburb: string | null;
  job_type: string | null;
}

async function draftForTenant(admin: SupabaseClient, s: Settings) {
  const tenantId = s.tenant_id;

  // Don't pile up drafts if the last one hasn't been reviewed.
  if (!s.auto_publish) {
    const { count } = await admin
      .from("gbp_posts")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "draft");
    if ((count ?? 0) > 0) return { tenant_id: tenantId, skipped: "a draft is already waiting for review" };
  }

  // --- 1. Candidate photos -------------------------------------------------
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: photoRows, error: photoErr } = await admin
    .from("job_files")
    .select("id, job_card_id, marketing_path, created_at")
    .eq("tenant_id", tenantId)
    .eq("marketing_ok", true)
    .not("marketing_path", "is", null)
    .is("used_in_post_id", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(40);
  if (photoErr) throw photoErr;
  const photos = (photoRows ?? []) as Photo[];
  if (!photos.length) return { tenant_id: tenantId, skipped: "no unused marketing photos" };

  const jobs = await jobInfo(admin, [...new Set(photos.map((p) => p.job_card_id))]);

  // --- 2. Rotate: avoid the job types and jobs used in the last 3 posts -----
  const { data: recent } = await admin
    .from("gbp_posts")
    .select("job_type, job_card_id")
    .eq("tenant_id", tenantId)
    .neq("status", "skipped")
    .order("created_at", { ascending: false })
    .limit(3);
  const recentTypes = new Set((recent ?? []).map((r) => r.job_type).filter(Boolean));
  const recentJobs = new Set((recent ?? []).map((r) => r.job_card_id).filter(Boolean));
  const pick =
    photos.find((p) => !recentJobs.has(p.job_card_id) && !recentTypes.has(jobs.get(p.job_card_id)?.job_type)) ??
    photos.find((p) => !recentJobs.has(p.job_card_id)) ??
    photos[0]!;
  const pickedJob = jobs.get(pick.job_card_id);

  const photoUrl = `${SUPABASE_URL}/storage/v1/object/public/marketing/${pick.marketing_path}`;

  // --- 3. Caption from Claude ----------------------------------------------
  const serviceKeys = Object.keys(s.service_urls ?? {});
  const draft = await writeCaption({
    businessName: s.business_name ?? "a local trade business",
    businessDescription: s.business_description ?? "",
    voiceNotes: s.voice_notes ?? "",
    serviceKeys,
    photoUrl,
    context: {
      suburb: pickedJob?.suburb ?? null,
      job_title: pickedJob?.title ?? null,
      job_type: pickedJob?.job_type ?? null,
    },
  });

  // --- 4. Call to action ---------------------------------------------------
  let ctaType: "LEARN_MORE" | "CALL" = s.default_cta_type ?? "LEARN_MORE";
  let ctaUrl: string | null = s.default_cta_url ?? null;
  if (draft.service_key && s.service_urls?.[draft.service_key]) {
    ctaType = "LEARN_MORE";
    ctaUrl = s.service_urls[draft.service_key]!;
  }
  if (ctaType === "LEARN_MORE" && !ctaUrl) ctaType = "CALL";
  if (ctaType === "CALL") ctaUrl = null;

  // --- 5. Save -------------------------------------------------------------
  const { data: post, error: insErr } = await admin
    .from("gbp_posts")
    .insert({
      tenant_id: tenantId,
      job_card_id: pick.job_card_id,
      job_file_id: pick.id,
      job_type: pickedJob?.job_type ?? null,
      photo_url: photoUrl,
      summary: draft.summary,
      service_key: draft.service_key,
      cta_type: ctaType,
      cta_url: ctaUrl,
      concerns: draft.concerns,
      status: "draft",
    })
    .select()
    .single();
  if (insErr) throw insErr;

  await admin.from("job_files").update({ used_in_post_id: post.id }).eq("id", pick.id);

  // --- 6. Publish or wait for review ---------------------------------------
  if (s.auto_publish && draft.publishable && draft.concerns.length === 0) {
    await admin.from("gbp_posts").update({ status: "approved" }).eq("id", post.id);
    await publishPost(admin, post.id);
    return { tenant_id: tenantId, published: post.id };
  }

  await notifyAdmins(admin, tenantId, post.id, draft.concerns.length);
  return { tenant_id: tenantId, drafted: post.id, concerns: draft.concerns };
}

// Title, suburb and job type for each job.
async function jobInfo(admin: SupabaseClient, jobIds: string[]): Promise<Map<string, JobInfo>> {
  const { data: jobRows, error } = await admin
    .from("job_cards")
    .select("id, title, client_id, site_id, property_id, service_category_id")
    .in("id", jobIds);
  if (error) throw error;
  const rows = (jobRows ?? []) as { id: string; title: string; client_id: string; site_id: string | null; property_id: string | null; service_category_id: string | null }[];
  const ids = (k: "client_id" | "site_id" | "property_id" | "service_category_id") => [...new Set(rows.map((r) => r[k]).filter((v): v is string => !!v))];
  const byId = async (table: string, cols: string, list: string[]) => {
    if (!list.length) return new Map<string, Record<string, string | null>>();
    const { data, error: e } = await admin.from(table).select(cols).in("id", list);
    if (e) throw e;
    return new Map(((data ?? []) as unknown as Record<string, string | null>[]).map((r) => [r.id as string, r]));
  };
  const [clients, sites, properties, categories] = await Promise.all([
    byId("clients", "id, suburb", ids("client_id")),
    byId("client_sites", "id, suburb", ids("site_id")),
    byId("properties", "id, suburb", ids("property_id")),
    byId("service_categories", "id, name", ids("service_category_id")),
  ]);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        title: r.title,
        suburb: (r.site_id && sites.get(r.site_id)?.suburb) || (r.property_id && properties.get(r.property_id)?.suburb) || clients.get(r.client_id)?.suburb || null,
        job_type: (r.service_category_id && categories.get(r.service_category_id)?.name) || null,
      },
    ])
  );
}

// "New Google post ready to review" to the company's admins, through the
// same send-notification function the other alerts use (bell + push).
async function notifyAdmins(admin: SupabaseClient, tenantId: string, postId: string, concernCount: number) {
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
        type: "gbp_draft",
        title: "New Google post ready to review",
        body: concernCount ? `Check it first: Claude flagged ${concernCount} concern${concernCount === 1 ? "" : "s"} with the photo.` : "Approve, edit or skip it in Marketing > Google Posts.",
        data: { post_id: postId },
      }),
    });
  } catch (e) {
    console.error("[gbp-draft] notification failed", e);
  }
}

interface CaptionInput {
  businessName: string;
  businessDescription: string;
  voiceNotes: string;
  serviceKeys: string[];
  photoUrl: string;
  context: Record<string, unknown>;
}
interface CaptionOutput {
  summary: string;
  service_key: string | null;
  publishable: boolean;
  concerns: string[];
}

async function writeCaption(input: CaptionInput): Promise<CaptionOutput> {
  const who = input.businessDescription ? `${input.businessName}, ${input.businessDescription}` : input.businessName;
  const system = `You write Google Business Profile updates for ${who}.

Rules:
- Write as the owner, in first person, in plain Australian English. Confident and grounded. Not salesy, no clever wordplay.
- Never use em dashes or en dashes. Use commas or full stops.
- 60 to 120 words.
- Say what the problem was, what was done, and the suburb if given.
- Never mention a street name, house number or any person's name.
- Only describe what you can see in the photo or what the job details say. Do not invent details, measurements or outcomes.
- No hashtags and no emojis.
- End with one short, plain line inviting people to get in touch.
${input.voiceNotes ? `\nExtra rules from the owner:\n${input.voiceNotes}\n` : ""}
Also check the photo. Set "publishable" to false and list each concern if the photo shows any of: a readable house number or street sign, a readable number plate, a person's face, anything that identifies the client's home, or if it is blurry or does not clearly show trade work.

For "service_key", pick the one that matches the job from ${input.serviceKeys.length ? JSON.stringify(input.serviceKeys) : "(none set up)"}, or null if none fits.`;

  // Structured output: the reply is guaranteed to be JSON in this shape.
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      service_key: { type: ["string", "null"] },
      publishable: { type: "boolean" },
      concerns: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "service_key", "publishable", "concerns"],
    additionalProperties: false,
  };

  const anthropic = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    defaultHeaders: ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : undefined,
  });
  // Server-side fallback: if Claude Sonnet 5.5's safety classifiers decline,
  // the API re-runs the request on a suitable model inside the same call.
  // The fields below are newer than this SDK version's types, so they're
  // passed through untyped (the SDK sends the body as given).
  const params = {
    model: MODEL,
    // Thinking is on by default on this model and counts towards
    // max_tokens, so leave room well beyond the ~150-word caption.
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: { type: "json_schema", schema } },
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: input.photoUrl } },
          { type: "text", text: `Job details:\n${JSON.stringify(input.context, null, 2)}\n\nWrite the update.` },
        ],
      },
    ],
  };
  // deno-lint-ignore no-explicit-any
  const response = await anthropic.beta.messages.create(params as any);

  if (response.stop_reason === "refusal") throw new Error("Claude declined to caption this photo");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's reply was cut off (max_tokens)");
  // deno-lint-ignore no-explicit-any
  const text = (response.content as any[]).find((c) => c.type === "text")?.text ?? "";
  if (!text) throw new Error(`Claude returned no caption (stop_reason ${response.stop_reason})`);
  const parsed = JSON.parse(text);

  const serviceKey = typeof parsed.service_key === "string" && input.serviceKeys.includes(parsed.service_key) ? parsed.service_key : null;
  const summary = cleanCaption(String(parsed.summary ?? ""));
  if (!summary) throw new Error("Claude returned an empty caption");

  return {
    summary,
    service_key: serviceKey,
    publishable: parsed.publishable === true,
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
  };
}
