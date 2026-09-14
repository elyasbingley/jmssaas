// Inbox - Resend's inbound email webhook. A tenant forwards from their own
// real inbox to their generated <inbox_local_part>@<verified domain>
// address (see the inbox migration and docs/SETUP.md's setup steps);
// Resend receives it there and POSTs a notification here.
//
// Signature verification uses Svix (Resend signs every webhook - inbound
// included - the same way as their other webhook types), the same
// verify-by-hand-with-Web-Crypto approach xero-webhook/stripe-webhook use
// rather than pulling in the svix npm package for one HMAC check:
// signed_content = "{svix-id}.{svix-timestamp}.{raw_body}", HMAC-SHA256
// with the base64 portion of the whsec_... secret, compared against each
// "v1,<base64 sig>" entry in the space-separated svix-signature header.
//
// CONFIRMED LIVE across four real test sends:
// 1. The `email.received` webhook itself is a lightweight notification
//    only - `payload.data` has from/to/subject/attachment metadata
//    (id/filename/content_type/content_id, no `content`), never a
//    text/html body, even when the source email genuinely had one.
// 2. `GET /emails/{id}` (Resend's documented "retrieve a sent email"
//    endpoint) 404s for a received email's id - that path is for emails
//    sent through Resend, not received ones.
// 3. `GET /emails/receiving/{id}` (using the webhook's own `data.email_id`)
//    DOES work and returns the real `text`/`html` body - see fetchFullEmail.
// 4. That response's own `attachments[]` is metadata-only too (no
//    `content`), but it carries a `raw.download_url` - a signed URL (no
//    Resend auth needed) to the complete original RFC 822 email, MIME
//    attachments and all. extractAttachmentBase64 pulls one attachment's
//    base64 body out of that raw message by matching its Content-ID or
//    filename - a small hand-rolled reader targeting the common case (a
//    standard multipart/mixed message with a base64-encoded attachment
//    part, which is what every normal mail client produces), not a full
//    MIME parser. Every fetch here is still logged unconditionally in case
//    a future edge case needs adjusting this extraction.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_INBOUND_WEBHOOK_SECRET = Deno.env.get("RESEND_INBOUND_WEBHOOK_SECRET") ?? "";
// Same secret every other function's outbound Resend calls already use
// (process-scheduled-comms) - project secrets are shared across all Edge
// Functions, so no new `supabase secrets set` is needed for this.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

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

interface InboundAttachmentMeta {
  id: string;
  filename: string;
  contentType: string | null;
  // e.g. "<f_mtqkp7ik0>" (angle brackets included, matching the raw MIME
  // message's own Content-ID header) - the most reliable way to match this
  // attachment's metadata to its body inside the raw email, filename being
  // the fallback for a part with no Content-ID.
  contentId: string | null;
}

interface ParsedInboundEmail {
  emailId: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  subject: string | null;
  attachments: InboundAttachmentMeta[];
}

interface FullReceivedEmail {
  text: string | null;
  html: string | null;
  // Keyed by the attachment `id` from the webhook's own metadata, since
  // that's the only stable handle both payloads share for matching one up
  // to the other.
  attachmentContentById: Record<string, string>;
}

function parseFromHeader(from: string): { email: string; name: string | null } {
  const match = from.match(/^(.*)<(.+)>$/);
  if (match) return { name: match[1]!.trim().replace(/^"|"$/g, "") || null, email: match[2]!.trim() };
  return { email: from.trim(), name: null };
}

// Some senders (Gmail/Outlook "compose" boxes especially) only populate the
// HTML part of a multipart email, leaving text/plain empty. Best-effort
// tag-stripping fallback (not a real HTML parser - Deno's std lib has none
// built in and pulling a dependency in for this one field isn't worth it),
// used only when the fetched email's own text field is empty.
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

  const attachments: InboundAttachmentMeta[] = (data.attachments ?? []).map((a: any) => ({
    id: a.id ?? a.attachment_id ?? "",
    filename: a.filename ?? a.file_name ?? "attachment",
    contentType: a.content_type ?? a.contentType ?? null,
    contentId: a.content_id ?? a.contentId ?? null,
  }));

  return {
    emailId: data.email_id ?? data.id ?? null,
    fromEmail,
    fromName,
    toEmail,
    subject: data.subject ?? null,
    attachments,
  };
}

// Finds one attachment's base64 body inside a raw RFC 822 email by
// matching its Content-ID (preferred) or filename, per the top-of-file
// comment. Not a general MIME parser - only handles a single level of
// multipart (no nested multipart/related inside multipart/mixed) and only
// base64-encoded parts, which covers a normal mail client's attachments.
function extractAttachmentBase64(rawEmail: string, contentId: string | null, filename: string): string | null {
  const topHeaderEnd = rawEmail.search(/\r?\n\r?\n/);
  if (topHeaderEnd === -1) return null;
  const topHeaders = rawEmail.slice(0, topHeaderEnd);
  const boundaryMatch = topHeaders.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1];

  const parts = rawEmail.split(`--${boundary}`);
  for (const part of parts) {
    const partHeaderEnd = part.search(/\r?\n\r?\n/);
    if (partHeaderEnd === -1) continue;
    const partHeaders = part.slice(0, partHeaderEnd);
    const partBody = part.slice(partHeaderEnd).replace(/^\r?\n\r?\n/, "");

    const matchesContentId = !!contentId && new RegExp(`content-id:\\s*${contentId}`, "i").test(partHeaders);
    const lowerHeaders = partHeaders.toLowerCase();
    const matchesFilename = lowerHeaders.includes(`filename="${filename.toLowerCase()}"`) || lowerHeaders.includes(`filename=${filename.toLowerCase()}`);
    if (!matchesContentId && !matchesFilename) continue;

    if (!/content-transfer-encoding:\s*base64/i.test(partHeaders)) continue;
    return partBody.replace(/\r?\n/g, "").trim();
  }
  return null;
}

async function fetchFullEmail(emailId: string, attachments: InboundAttachmentMeta[]): Promise<FullReceivedEmail | null> {
  if (!RESEND_API_KEY) {
    console.error("[resend-inbound-webhook] RESEND_API_KEY not set - cannot fetch full email content");
    return null;
  }

  const url = `https://api.resend.com/emails/receiving/${emailId}`;
  let data: any;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } });
    const bodyText = await res.text();
    console.log("[resend-inbound-webhook] fetched full email", url, res.status, bodyText);
    if (!res.ok) return null;
    const full = JSON.parse(bodyText);
    data = full?.data ?? full;
  } catch (e) {
    console.error("[resend-inbound-webhook] Failed to fetch full email", url, e);
    return null;
  }

  const attachmentContentById: Record<string, string> = {};
  const downloadUrl = data?.raw?.download_url;
  if (attachments.length > 0 && downloadUrl) {
    try {
      const rawRes = await fetch(downloadUrl);
      const rawEmail = await rawRes.text();
      console.log("[resend-inbound-webhook] fetched raw email", downloadUrl, rawRes.status, "length", rawEmail.length);
      if (rawRes.ok) {
        for (const attachment of attachments) {
          const content = extractAttachmentBase64(rawEmail, attachment.contentId, attachment.filename);
          if (content) attachmentContentById[attachment.id] = content;
          else console.warn("[resend-inbound-webhook] Could not find attachment body in raw email", attachment.filename, attachment.contentId);
        }
      }
    } catch (e) {
      console.error("[resend-inbound-webhook] Failed to fetch/parse raw email", downloadUrl, e);
    }
  }

  return {
    text: data?.text ?? null,
    html: data?.html ?? null,
    attachmentContentById,
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

  const full = email.emailId ? await fetchFullEmail(email.emailId, email.attachments) : null;
  const html = full?.html ?? null;
  const rawText = full?.text ?? null;
  const bodyText = rawText && rawText.trim() ? rawText : html ? htmlToPlainText(html) : null;

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
      body_text: bodyText,
      body_html: html,
      status: "unprocessed",
    })
    .select("id")
    .single();
  if (messageError) {
    console.error("[resend-inbound-webhook] Failed to insert message", messageError);
    return json({ error: "server_error" }, 500);
  }

  for (const attachment of email.attachments) {
    const content = full?.attachmentContentById[attachment.id];
    if (!content) {
      console.warn(
        "[resend-inbound-webhook] No content found for attachment - check fetchFullEmail's logged response for the right field name",
        attachment.filename,
        attachment.id
      );
      continue;
    }
    try {
      const bytes = base64ToBytes(content);
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
  if (email.attachments.length === 0 && (bodyText ?? "").trim().length > 0) {
    fetch(`${SUPABASE_URL}/functions/v1/process-inbox-ai-parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ message_id: message.id }),
    }).catch((e) => console.error("[resend-inbound-webhook] Failed to trigger AI parsing", e));
  }

  return json({ ok: true, message_id: message.id });
});
