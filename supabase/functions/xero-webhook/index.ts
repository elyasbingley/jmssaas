// Xero webhook: Xero POSTs here whenever an invoice changes in a connected
// organisation (including a payment being added, deleted or reconciled
// against it). The payload only says which organisation/invoice changed,
// so this just starts a xero-sync sweep for that company straight away -
// the sweep reads what changed and brings payments, paid-in-full and voids
// back (see the xero_two_way_sync migration). The 10-minute pg_cron sweep
// catches anything if this webhook isn't set up or a delivery is missed.
//
// Xero wants an answer within 5 seconds, so the sweep runs after the
// response (EdgeRuntime.waitUntil).
//
// Also answers Xero's "Intent to Receive" check (a signed request with no
// events) when the webhook URL is saved in the Xero developer portal.
//
// Signature: HMAC-SHA256 of the raw body with XERO_WEBHOOK_KEY, base64, in
// X-Xero-Signature - checked by hand with Web Crypto.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const XERO_WEBHOOK_KEY = Deno.env.get("XERO_WEBHOOK_KEY") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !XERO_WEBHOOK_KEY) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(XERO_WEBHOOK_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

interface XeroEvent {
  resourceId: string;
  eventCategory: string;
  eventType: string;
  tenantId: string;
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();
  const valid = await verifySignature(rawBody, req.headers.get("x-xero-signature"));
  if (!valid) return json({ error: "invalid_signature" }, 401);

  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  let payload: { events?: XeroEvent[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signature was valid but body isn't JSON - shouldn't happen from
    // Xero itself, but still answer 200 (this is likely the Intent to
    // Receive check, which cares only about signature verification).
    return json({ ok: true });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const xeroTenantIds = [...new Set((payload.events ?? []).filter((e) => e.eventCategory === "INVOICE").map((e) => e.tenantId))];
  if (xeroTenantIds.length === 0) return json({ ok: true, processed: 0 });

  const { data: connections } = await admin.from("xero_connections").select("tenant_id").in("xero_tenant_id", xeroTenantIds);
  const sweeps = (connections ?? []).map((c: { tenant_id: string }) =>
    fetch(`${SUPABASE_URL}/functions/v1/xero-sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sweep", tenant_id: c.tenant_id }),
    })
      .then((res) => {
        if (!res.ok) console.error("[xero-webhook] sweep call failed", res.status);
      })
      .catch((e) => console.error("[xero-webhook] sweep call threw", e))
  );
  const all = Promise.all(sweeps);
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(all);
  else await all;

  return json({ ok: true, processed: sweeps.length });
});
