// The website's checklist sign-up forms (bingleytrades.com.au/storm-check
// and /hot-water-check) post here. Each sign-up becomes a lead in JMS: the
// client (matched by mobile if they're already in JMS), a job card in the
// first stage with lead source "Checklist: roof" or "Checklist: hot water",
// and - for the roof checklist, when Sequence 1 is on - the follow-up texts
// (see the follow_up_sequences migration). The office gets a notification.
//
// Public: deployed with --no-verify-jwt. The form sends the company's
// checklist_signup_key (shown on JMS's Follow-ups page) so the sign-up lands
// in the right company.
//
// POST, as JSON, a normal form post, or FormData:
//   key          the company's sign-up key (or ?key= on the URL)
//   checklist    "roof" | "hot_water" (also accepts "storm-check" /
//                "hot-water-check")
//   first_name   (or "name")
//   mobile       (or "phone")
//   suburb
//   email        optional
//   botcheck     honeypot - if a bot fills it in, nothing is saved
//   redirect     optional, for a plain HTML form with no JavaScript: where
//                to send them afterwards (bingleytrades.com.au pages only)
//
// GET ?unsubscribe=<id> is the unsubscribe link at the bottom of the
// sign-up email.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Where a no-JavaScript form may be sent back to afterwards.
const REDIRECT_HOSTS = (Deno.env.get("CHECKLIST_REDIRECT_HOSTS") ?? "bingleytrades.com.au,www.bingleytrades.com.au")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS } });
}

function page(title: string, message: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#1f2937;line-height:1.5}h1{font-size:1.4rem}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// A few sign-ups a minute from one address is plenty for a real person
// (CHECKLIST_MAX_PER_MINUTE, default 5).
// In-memory, so per function instance - the database also ignores the same
// mobile signing up twice in a day.
const MAX_PER_MINUTE = Number(Deno.env.get("CHECKLIST_MAX_PER_MINUTE") ?? "5") || 5;
const recentByIp = new Map<string, number[]>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const hits = (recentByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recentByIp.set(ip, hits);
  if (recentByIp.size > 5000) recentByIp.clear();
  return hits.length > MAX_PER_MINUTE;
}

async function readFields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  } else if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  } else {
    for (const [k, v] of new URLSearchParams(await req.text())) out[k] = v;
  }
  return out;
}

function normaliseChecklist(raw: string | undefined): "roof" | "hot_water" | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/^\//, "");
  if (["roof", "storm", "storm-check", "storm_check"].includes(v)) return "roof";
  if (["hot_water", "hot-water", "hotwater", "hot-water-check", "hot_water_check"].includes(v)) return "hot_water";
  return null;
}

function safeRedirect(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && REDIRECT_HOSTS.includes(url.hostname.toLowerCase())) return url.toString();
  } catch {
    // not a URL
  }
  return null;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_mobile: "Please enter an Australian mobile number (04xx xxx xxx) so I can text you the checklist.",
  missing_name: "Please enter your first name.",
  unknown_form: "This form isn't set up correctly. Please contact us directly.",
  unknown_checklist: "This form isn't set up correctly. Please contact us directly.",
};

async function notifyOffice(tenantId: string, result: Record<string, unknown>, checklist: "roof" | "hot_water", mobile: string) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenantId,
        type: "lead_signup",
        title: checklist === "roof" ? "New storm checklist sign-up" : "New hot water checklist sign-up",
        body: [result.first_name, result.suburb, mobile].filter(Boolean).join(", ") + (result.enrolment_id ? " - follow-up texts started" : ""),
        data: { job_card_id: result.job_card_id },
      }),
    });
  } catch (e) {
    console.error("[checklist-signup] notification failed", e);
  }
}

// Sends the first text now rather than at the next scheduled run.
async function sendFirstTextNow(enrolmentId: string) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/process-follow-ups`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enrolment_id: enrolmentId }),
    });
  } catch (e) {
    console.error("[checklist-signup] couldn't start the first text", e);
  }
}

function inBackground(promise: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(promise);
  else promise.catch(() => {});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, error: "server_error" }, 500);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const id = url.searchParams.get("unsubscribe") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return page("Link not recognised", "This unsubscribe link isn't complete. Reply STOP to any text from us instead.", 400);
    const { data, error } = await admin.rpc("follow_up_unsubscribe", { p_enrolment_id: id });
    if (error) {
      console.error("[checklist-signup] unsubscribe failed", error);
      return page("Something went wrong", "Please reply STOP to any text from us and we'll take you off the list.", 500);
    }
    return data
      ? page("You're unsubscribed", "You won't get any more tips or offers from us. If you ever need a hand, you've still got our number.")
      : page("Link not recognised", "We couldn't find that sign-up. Reply STOP to any text from us instead.", 404);
  }

  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let fields: Record<string, string>;
  try {
    fields = await readFields(req);
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const redirectTo = safeRedirect(fields.redirect);
  const respond = (status: number, body: Record<string, unknown>) => {
    if (redirectTo && body.ok) return new Response(null, { status: 303, headers: { Location: redirectTo, ...CORS_HEADERS } });
    if (redirectTo && !body.ok) return page("Please check your details", String(body.message ?? "Something went wrong. Please go back and try again."), status);
    return json(body, status);
  };

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  if (tooMany(ip)) return respond(429, { ok: false, error: "too_many", message: "Too many sign-ups from here in a minute. Please wait a moment and try again." });

  // Honeypot: real people never fill this in. Answer as if it worked.
  if ((fields.botcheck ?? fields.website ?? "").trim() !== "") return respond(200, { ok: true });

  const checklist = normaliseChecklist(fields.checklist);
  const mobile = (fields.mobile ?? fields.phone ?? "").trim();
  const { data, error } = await admin.rpc("checklist_signup", {
    p_key: (fields.key ?? url.searchParams.get("key") ?? "").trim(),
    p_checklist: checklist ?? "",
    p_first_name: (fields.first_name ?? fields.name ?? "").trim().slice(0, 80),
    p_mobile: mobile.slice(0, 30),
    p_suburb: (fields.suburb ?? "").trim().slice(0, 80),
    p_email: (fields.email ?? "").trim().slice(0, 200),
  });
  if (error) {
    const code = Object.keys(ERROR_MESSAGES).find((k) => error.message?.includes(k));
    if (code) return respond(400, { ok: false, error: code, message: ERROR_MESSAGES[code] });
    console.error("[checklist-signup] sign-up failed", error);
    return respond(500, { ok: false, error: "server_error", message: "Something went wrong saving your details. Please contact us directly." });
  }

  const result = data as Record<string, unknown>;
  if (!result.duplicate) inBackground(notifyOffice(String(result.tenant_id), result, checklist!, mobile));
  if (result.enrolment_id) inBackground(sendFirstTextNow(String(result.enrolment_id)));

  return respond(200, { ok: true });
});
