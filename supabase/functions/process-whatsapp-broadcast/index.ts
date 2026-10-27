// Processes whatsapp_broadcast_recipients rows for a WhatsApp broadcast -
// see the whatsapp_broadcasts migration's own comment for why this is a
// separate table/processor from scheduled_communications. Deployed as a
// Supabase Edge Function (Deno runtime, npm: specifiers supported). Two
// ways in, same shape as process-scheduled-comms:
//
//   1. Immediate, scoped dispatch - POST { broadcast_id } with the signed-in
//      admin's own bearer token, right after the compose screen creates the
//      broadcast + recipient rows. Processes up to BATCH_LIMIT queued rows
//      for that one broadcast and returns { processed, remaining, sent,
//      failed } - the compose screen keeps calling this (same broadcast_id)
//      until remaining is 0, which is the primary way a broadcast actually
//      completes (no dependency on the tenant having pg_cron set up).
//
//   2. The cron sweep - service-role bearer token, processes up to
//      BATCH_LIMIT queued rows across every tenant/broadcast. A backstop
//      only (the admin closed the app mid-broadcast, or the immediate
//      calls stopped for any reason) - see docs/SETUP.md for the one-time
//      cron.schedule SQL, same as process-scheduled-comms' own.
//
// Each send uses Twilio's Content API (ContentSid + ContentVariables, not a
// plain Body) - the one thing that lets a WhatsApp sender message someone
// who hasn't messaged the business in the last 24 hours, which is the
// entire point of a marketing broadcast to existing clients. A successful
// send also records a normal outbound channel_messages row (find-or-create
// the conversation first, same as channel-send-message's own to_phone
// path) so the sent message shows up in that client's Channels thread like
// any other WhatsApp message, not just in the broadcast's own history.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

// Same bound as process-scheduled-comms' own BATCH_LIMIT - keeps one
// invocation fast and bounded; the caller (or the next cron tick) picks up
// anything left over.
const BATCH_LIMIT = 50;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS }) });
}

interface RecipientRow {
  id: string;
  broadcast_id: string;
  tenant_id: string;
  client_id: string;
  phone: string;
  variable_values: string[];
}

interface TemplateRow {
  content_sid: string;
  body_preview: string;
}

// Sends one templated WhatsApp message via Twilio's Messages API using
// ContentSid/ContentVariables - the same endpoint channel-send-message
// uses for a plain Body send, just with those two params instead. {"1":
// "Jane", "2": "Bingley Trade Services"} is Twilio's own documented shape
// for positional content variables.
async function sendTemplateViaTwilio(params: { from: string; to: string; contentSid: string; variableValues: string[] }): Promise<{ sid: string } | { error: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { error: "twilio_not_configured" };
  const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const contentVariables: Record<string, string> = {};
  params.variableValues.forEach((v, i) => {
    contentVariables[String(i + 1)] = v;
  });
  const form = new URLSearchParams({
    To: `whatsapp:${params.to}`,
    From: `whatsapp:${params.from}`,
    ContentSid: params.contentSid,
  });
  if (Object.keys(contentVariables).length > 0) form.set("ContentVariables", JSON.stringify(contentVariables));
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const responseBody = await res.json();
  if (!res.ok) {
    console.error("[process-whatsapp-broadcast] Twilio send failed", res.status, responseBody);
    return { error: responseBody?.message ?? "twilio_send_failed" };
  }
  return { sid: responseBody.sid };
}

// Renders the template's own reference copy with this recipient's values,
// purely for the channel_messages row this writes (so the conversation
// thread shows readable text, not "{{1}}, {{2}}") - Twilio resolves the
// actual sent content from ContentSid/ContentVariables server-side
// regardless of what's stored here, same as whatsapp_templates.body_preview
// itself is reference-only (see that table's own comment).
function renderPreview(bodyPreview: string, variableValues: string[]): string {
  return bodyPreview.replace(/\{\{(\d+)\}\}/g, (match, indexStr: string) => {
    const index = Number(indexStr) - 1;
    return index >= 0 && index < variableValues.length ? variableValues[index]! : match;
  });
}

// Shared by both entry points - processes up to BATCH_LIMIT queued rows
// matching the given filter (a specific broadcast, or everything due
// across tenants for the cron sweep).
async function processBatch(admin: SupabaseClient, broadcastIdFilter: string | null): Promise<{ processed: number; sent: number; failed: number }> {
  let query = admin
    .from("whatsapp_broadcast_recipients")
    .select("id, broadcast_id, tenant_id, client_id, phone, variable_values")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (broadcastIdFilter) query = query.eq("broadcast_id", broadcastIdFilter);

  const { data: due, error: fetchError } = await query;
  if (fetchError) {
    console.error("[process-whatsapp-broadcast] Failed to fetch due rows", fetchError.message);
    return { processed: 0, sent: 0, failed: 0 };
  }
  const rows = (due ?? []) as RecipientRow[];
  if (rows.length === 0) return { processed: 0, sent: 0, failed: 0 };

  // Cache per-broadcast template + tenant WhatsApp number lookups - a
  // batch is typically all (or mostly) the same broadcast.
  const templateCache = new Map<string, TemplateRow>();
  const fromNumberCache = new Map<string, string | null>();

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    let template = templateCache.get(row.broadcast_id);
    if (!template) {
      const { data: broadcast } = await admin.from("whatsapp_broadcasts").select("template_id").eq("id", row.broadcast_id).single();
      const { data: templateRow } = broadcast
        ? await admin.from("whatsapp_templates").select("content_sid, body_preview").eq("id", broadcast.template_id).single()
        : { data: null };
      if (!templateRow) {
        await admin.from("whatsapp_broadcast_recipients").update({ status: "failed", error: "Template not found" }).eq("id", row.id);
        failed++;
        continue;
      }
      template = templateRow;
      templateCache.set(row.broadcast_id, template);
    }

    let fromNumber = fromNumberCache.get(row.tenant_id);
    if (fromNumber === undefined) {
      const { data: tenant } = await admin.from("tenants").select("whatsapp_phone_number").eq("id", row.tenant_id).single();
      fromNumber = tenant?.whatsapp_phone_number ?? null;
      fromNumberCache.set(row.tenant_id, fromNumber);
    }
    if (!fromNumber) {
      await admin.from("whatsapp_broadcast_recipients").update({ status: "failed", error: "WhatsApp number not configured" }).eq("id", row.id);
      failed++;
      continue;
    }

    const variableValues = Array.isArray(row.variable_values) ? (row.variable_values as unknown as string[]) : [];
    const result = await sendTemplateViaTwilio({ from: fromNumber, to: row.phone, contentSid: template.content_sid, variableValues });

    if ("error" in result) {
      await admin.from("whatsapp_broadcast_recipients").update({ status: "failed", error: result.error }).eq("id", row.id);
      failed++;
      continue;
    }

    // Find-or-create the conversation + record the message, same shape as
    // channel-send-message's own to_phone path, so this send shows up in
    // the client's normal Channels thread.
    const { data: existingConversation } = await admin
      .from("channel_conversations")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("channel_type", "whatsapp")
      .eq("external_contact", row.phone)
      .maybeSingle();

    const previewText = renderPreview(template.body_preview, variableValues);
    let conversationId = existingConversation?.id as string | undefined;
    if (!conversationId) {
      const { data: created } = await admin
        .from("channel_conversations")
        .insert({ tenant_id: row.tenant_id, channel_type: "whatsapp", external_contact: row.phone, client_id: row.client_id, last_message_at: new Date().toISOString(), last_message_preview: previewText.slice(0, 200) })
        .select("id")
        .single();
      conversationId = created?.id;
    } else {
      await admin.from("channel_conversations").update({ last_message_at: new Date().toISOString(), last_message_preview: previewText.slice(0, 200) }).eq("id", conversationId);
    }
    if (conversationId) {
      await admin.from("channel_messages").insert({
        conversation_id: conversationId,
        tenant_id: row.tenant_id,
        direction: "outbound",
        body: previewText,
        external_message_id: result.sid,
        status: "sent",
      });
    }

    await admin.from("whatsapp_broadcast_recipients").update({ status: "sent", external_message_id: result.sid, sent_at: new Date().toISOString() }).eq("id", row.id);
    sent++;
  }

  // Update aggregate counts per affected broadcast, and flip to 'completed'
  // once nothing queued remains for it.
  const affectedBroadcastIds = [...new Set(rows.map((r) => r.broadcast_id))];
  for (const broadcastId of affectedBroadcastIds) {
    const { count: remainingCount } = await admin
      .from("whatsapp_broadcast_recipients")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", broadcastId)
      .eq("status", "queued");
    const { count: sentCount } = await admin.from("whatsapp_broadcast_recipients").select("id", { count: "exact", head: true }).eq("broadcast_id", broadcastId).eq("status", "sent");
    const { count: failedCount } = await admin.from("whatsapp_broadcast_recipients").select("id", { count: "exact", head: true }).eq("broadcast_id", broadcastId).eq("status", "failed");
    await admin
      .from("whatsapp_broadcasts")
      .update({
        sent_count: sentCount ?? 0,
        failed_count: failedCount ?? 0,
        ...((remainingCount ?? 0) === 0 ? { status: "completed", completed_at: new Date().toISOString() } : {}),
      })
      .eq("id", broadcastId);
  }

  return { processed: rows.length, sent, failed };
}

async function runSweep(): Promise<Response> {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = await processBatch(admin, null);
  return json({ ok: true, ...result });
}

// Scoped, admin-authenticated immediate dispatch for one broadcast - see
// the file header comment. Any admin on the broadcast's own tenant may
// call this (verified via the broadcast row's tenant_id, not trusted from
// the request body).
async function dispatchBroadcast(req: Request, authHeader: string): Promise<Response> {
  let body: { broadcast_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body.broadcast_id) return json({ error: "bad_request" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);
  if (callerProfile.role !== "admin") return json({ error: "forbidden" }, 403);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: broadcast } = await admin.from("whatsapp_broadcasts").select("id, tenant_id").eq("id", body.broadcast_id).maybeSingle();
  if (!broadcast || broadcast.tenant_id !== callerProfile.tenant_id) return json({ error: "not_found" }, 404);

  const result = await processBatch(admin, body.broadcast_id);
  const { count: remaining } = await admin
    .from("whatsapp_broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", body.broadcast_id)
    .eq("status", "queued");

  return json({ ok: true, ...result, remaining: remaining ?? 0 });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return runSweep();
  if (authHeader.startsWith("Bearer ") && req.method === "POST") return dispatchBroadcast(req, authHeader);
  return json({ error: "unauthorized" }, 401);
});
