// Stripe webhook receiver - the other half of the "approve" function's
// createPaymentLink: once a client actually pays a Checkout Session, Stripe
// POSTs the event here and this marks the invoice paid, closing the loop
// (invoice link -> Stripe Checkout -> paid) rather than leaving payment
// confirmation as a manual "mark paid" click.
//
// Verifies the Stripe-Signature header by hand (HMAC-SHA256 over
// `${timestamp}.${rawBody}`, using Deno's Web Crypto SubtleCrypto - see
// verifyStripeSignature below) rather than pulling in the stripe-node SDK,
// same "one small piece of protocol, not worth a whole dependency" call as
// the "approve" function's raw REST call to create the session in the
// first place. Configure this URL as the endpoint in the Stripe Dashboard
// (Developers > Webhooks), subscribed to checkout.session.completed, and
// set STRIPE_WEBHOOK_SECRET to the signing secret Stripe shows you there -
// see docs/SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

// Stripe tolerates a little clock drift but rejects anything stale, mainly
// to stop a captured request being replayed later - 5 minutes matches
// Stripe's own default tolerance.
const TOLERANCE_SECONDS = 300;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(payload: string, signatureHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expectedHex = toHex(expectedBytes);

  // Constant-time-ish comparison - not performance-critical here (one
  // webhook at a time), just avoids a trivial early-exit timing tell.
  if (expectedHex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured");
    return json({ error: "server_error" }, 500);
  }

  const signatureHeader = req.headers.get("Stripe-Signature") ?? "";
  const rawBody = await req.text();

  const valid = await verifyStripeSignature(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "invalid_signature" }, 400);

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object ?? {};
    const sessionId = session.id as string | undefined;
    const paymentIntentId = (session.payment_intent as string | null) ?? null;
    if (sessionId) {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await admin.rpc("mark_invoice_paid_by_stripe", {
        p_stripe_checkout_session_id: sessionId,
        p_stripe_payment_intent_id: paymentIntentId,
      });
      if (error) {
        console.error("[stripe-webhook] Failed to mark invoice paid", error.message);
        return json({ error: "server_error" }, 500);
      }
    }
  }

  // Every other event type is acknowledged and ignored - Stripe retries on
  // anything but a 2xx, so unhandled types still need a 200 or Stripe will
  // keep resending them.
  return json({ ok: true });
});
