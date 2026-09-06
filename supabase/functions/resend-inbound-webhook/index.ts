// Inbox - Resend's inbound email webhook. A tenant forwards from their own
// real inbox to their generated <inbox_local_part>@<verified domain>
// address (see the inbox migration and docs/SETUP.md's setup steps);
// Resend receives it there and POSTs the parsed email here.
//
// Signature verification uses Svix (Resend signs every webhook - inbound
// included - the same way as their other webhook types), the same
// verify-by-hand-with-Web-Crypto approach xero-webhook/stripe-webhook use
// rather than pulling in the svix npm package for one HMAC check:
// signed_content = "{svix-id}.{svix-timestamp}.{raw_body}", HMAC-SHA256
// with the base64 portion of the whsec_... secret, compared against each
// "v1,<base64 sig>" entry in the space-separated svix-signature header.
//
// IMPORTANT - the exact field names below (payload.data.from/to/subject/
// text/html/attachments\[\].content) are Resend's documented inbound
// email shape as of when this was written, not verified against a live
// payload in this environment (no Resend inbound domain exists here to
// receive a real test webhook). Once inbound is enabled for real, send
// yourself a test email and check the Resend dashboard's webhook delivery
// log (or this function's own logs) against what's actually parsed below
// - adjust the `parseResendPayload` extraction if any field name differs.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_INBOUND_WEBHOOK_SECRET = Deno.env.get("RESEND_INBOUND_WEBHOOK_SECRET") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifySvixSignature(rawBody: string, headers: Headers): Promise<boolean> {
  if (!RESEND_INBOUND_WEBHOOK_SECRET) return false;
  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignature = headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretB64 = RESEND_INBOUND_WEBHOOK_SECRET.startsWith("whsec_")
    ? RESEND_INBOUND_WEBHOOK_SECRET.slice("whsec_".length)
    : RESEND_INBOUND_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey("raw", base64ToBytes(secretB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  // svix-signature is space-separated "v1,<base64>" entries - only one in
  // practice, but multiple during a secret rotation window.
  return svixSignature.split(" ").some((entry) => {
    const [, sig] = entry.split(",");
    return sig === expected;
  });
}

interface ParsedInboundEmail {
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: { filename: string; contentType: string | null; content: string }[];
}

function parseFromHeader(from: string): { email: string; name: string | null } {
  const match = from.match(/^(.*)<(.+)>$/);
  if (match) return { name: match[1]!.trim().replace(/^"|"$/g, "") || null, email: match[2]!.trim() };
  return { email: from.trim(), name: null };
}

// Some senders (Gmail/Outlook "compose" boxes especially) only populate the
// HTML part of a multipart email, leaving text/plain empty - confirmed live:
// subject/from/attachments all parsed correctly from a real test send, but
// body_text came back empty while the sender's email visibly had a body.
// This is a best-effort tag-stripping fallback (not a real HTML parser -
// Deno's std lib has none built in and pulling a dependency in for this one
// field isn't worth it), used only when Resend's own text field is empty.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseResendPayload(payload: any): ParsedInboundEmail | null {
  const data = payload?.data;
  if (!data) return null;
  const fromRaw = data.from ?? data.from_email ?? "";
  const { email: fromEmail, name: fromName } = parseFromHeader(String(fromRaw));
  const toRaw = data.to ?? data.to_email ?? [];
  const toEmail = String(Array.isArray(toRaw) ? toRaw[0] : toRaw);
  if (!fromEmail || !toEmail) return null;

  const attachments = (data.attachments ?? []).map((a: any) => ({
    filename: a.filename ?? a.file_name ?? "attachment",
    contentType: a.content_type ?? a.contentType ?? null,
    content: a.content ?? a.content_base64 ?? "",
  }));

  const html = data.html ?? null;
  const rawText = data.text ?? null;
  const text = rawText && rawText.trim() ? rawText : html ? htmlToPlainText(html) : null;

  return {
    fromEmail,
    fromName,
    toEmail,
    subject: data.subject ?? null,
    text,
    html,
    attachments,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();
  const valid = await verifySvixSignature(rawBody, req.headers);
  if (!valid) return json({ error: "invalid_signature" }, 401);

  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Logged unconditionally (not just on parse failure) while the exact
  // Resend inbound payload shape is still being confirmed against live
  // sends - see this function's own top-of-file comment. Check Supabase
  // Dashboard -> Edge Functions -> resend-inbound-webhook -> Logs after a
  // test send if a field ever comes through wrong/empty.
  console.log("[resend-inbound-webhook] raw payload", JSON.stringify(payload));

  const email = parseResendPayload(payload);
  if (!email) return json({ ok: true, skipped: "unrecognised_payload" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const localPart = email.toEmail.split("@")[0]?.toLowerCase();
  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .select("id")
    .eq("inbox_local_part", localPart)
    .maybeSingle();
  if (tenantError) {
    console.error("[resend-inbound-webhook] Failed to look up tenant", tenantError);
    return json({ error: "server_error" }, 500);
  }
  if (!tenant) {
    // No matching tenant - nothing to do, but still 200 so Resend doesn't
    // retry-storm an address that will never match.
    return json({ ok: true, skipped: "unknown_recipient" });
  }

  const { data: message, error: messageError } = await admin
    .from("inbox_messages")
    .insert({
      tenant_id: tenant.id,
      from_email: email.fromEmail,
      from_name: email.fromName,
      subject: email.subject,
      body_text: email.text,
      body_html: email.html,
      status: "unprocessed",
    })
    .select("id")
    .single();
  if (messageError) {
    console.error("[resend-inbound-webhook] Failed to insert message", messageError);
    return json({ error: "server_error" }, 500);
  }

  for (const attachment of email.attachments) {
    if (!attachment.content) continue;
    try {
      const bytes = base64ToBytes(attachment.content);
      const storagePath = `${tenant.id}/${message.id}/${crypto.randomUUID()}-${attachment.filename}`;
      const { error: uploadError } = await admin.storage
        .from("inbox-attachments")
        .upload(storagePath, bytes, { contentType: attachment.contentType ?? undefined });
      if (uploadError) throw uploadError;

      await admin.from("inbox_attachments").insert({
        tenant_id: tenant.id,
        message_id: message.id,
        storage_path: storagePath,
        file_name: attachment.filename,
        mime_type: attachment.contentType,
        size_bytes: bytes.byteLength,
      });
    } catch (e) {
      console.error("[resend-inbound-webhook] Failed to store attachment", attachment.filename, e);
    }
  }

  // No attachments and there's actual text to work with - hand it to the
  // AI-parsing function to draft a job suggestion (fire-and-forget: a
  // parsing failure shouldn't fail the webhook response Resend is waiting
  // on, the message is already safely stored either way).
  if (email.attachments.length === 0 && (email.text ?? "").trim().length > 0) {
    fetch(`${SUPABASE_URL}/functions/v1/process-inbox-ai-parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ message_id: message.id }),
    }).catch((e) => console.error("[resend-inbound-webhook] Failed to trigger AI parsing", e));
  }

  return json({ ok: true, message_id: message.id });
});
