// Stripe Connect webhook receiver for the Membership module - separate
// from the existing stripe-webhook function (which handles the platform
// account's own invoice-payment events, a single non-Connect webhook
// endpoint). Connect events are configured as their own separate webhook
// endpoint in the Stripe Dashboard (Developers > Webhooks > the "Connect"
// tab, not the main platform tab) with their own distinct signing secret
// (STRIPE_CONNECT_WEBHOOK_SECRET) - see docs/SETUP.md.
//
// Handles checkout.session.completed (creates the client_memberships row -
// this is what fires membership_welcome, via the AFTER INSERT trigger in
// the membership_communications migration), customer.subscription.updated/
// deleted, and invoice.paid/invoice.payment_failed (keeps status and
// current_period_start/end in sync). membership_payment_failed/
// membership_cancelled fire automatically from the AFTER UPDATE trigger on
// whatever status transition actually happens as a result of the updates
// below - there is no communication-sending logic in this file at all.
//
// Same hand-verified HMAC-SHA256 signature check as stripe-webhook (no
// stripe-node SDK) - copied rather than imported, since Edge Functions
// can't import code from outside their own directory.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_CONNECT_WEBHOOK_SECRET = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET") ?? "";

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

  if (expectedHex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

async function stripeGet(path: string, stripeAccount: string): Promise<{ ok: boolean; body: any }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Stripe-Account": stripeAccount },
  });
  return { ok: res.ok, body: await res.json() };
}

function unixToDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// Stripe's own subscription.status values ('trialing', 'active',
// 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired',
// 'paused') collapsed onto this schema's four-value membership_status enum
// - values with no clean equivalent (unpaid/incomplete/paused) map to
// 'past_due', matching the intent ("something needs the member's
// attention") rather than inventing new enum values this module's own
// spec never asked for.
function mapSubscriptionStatus(stripeStatus: string): "active" | "past_due" | "cancelled" {
  if (stripeStatus === "active" || stripeStatus === "trialing") return "active";
  if (stripeStatus === "canceled") return "cancelled";
  return "past_due";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_CONNECT_WEBHOOK_SECRET) {
    console.error("[membership-stripe-webhook] STRIPE_CONNECT_WEBHOOK_SECRET not configured");
    return json({ error: "server_error" }, 500);
  }

  const signatureHeader = req.headers.get("Stripe-Signature") ?? "";
  const rawBody = await req.text();

  const valid = await verifyStripeSignature(rawBody, signatureHeader, STRIPE_CONNECT_WEBHOOK_SECRET);
  if (!valid) return json({ error: "invalid_signature" }, 400);

  let event: { type?: string; account?: string; data?: { object?: Record<string, any> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const stripeAccount = event.account;
  const object = event.data?.object ?? {};
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.type === "checkout.session.completed" && object.mode === "subscription" && stripeAccount) {
      const clientId = object.metadata?.client_id as string | undefined;
      const tenantId = object.metadata?.tenant_id as string | undefined;
      const membershipPlanId = object.metadata?.membership_plan_id as string | undefined;
      const subscriptionId = object.subscription as string | undefined;
      const customerId = object.customer as string | undefined;
      if (!clientId || !tenantId || !membershipPlanId || !subscriptionId) {
        return json({ ok: true, skipped: "missing_metadata" });
      }

      const { data: existing } = await admin.from("client_memberships").select("id").eq("stripe_subscription_id", subscriptionId).maybeSingle();
      if (existing) return json({ ok: true, already_processed: true });

      const sub = await stripeGet(`subscriptions/${subscriptionId}`, stripeAccount);
      if (!sub.ok) {
        console.error("[membership-stripe-webhook] Failed to fetch subscription", sub.body);
        return json({ error: "server_error" }, 500);
      }

      const { data: plan } = await admin.from("membership_plans").select("*").eq("id", membershipPlanId).single();
      if (!plan) return json({ ok: true, skipped: "plan_not_found" });

      const { error: insertError } = await admin.from("client_memberships").insert({
        tenant_id: tenantId,
        client_id: clientId,
        membership_plan_id: membershipPlanId,
        status: mapSubscriptionStatus(sub.body.status),
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        current_period_start: unixToDate(sub.body.current_period_start),
        current_period_end: unixToDate(sub.body.current_period_end),
        price_paid_cents: plan.annual_price_cents,
        benefits_snapshot: {
          discount_percent: plan.discount_percent,
          waive_callout_fee: plan.waive_callout_fee,
          priority_scheduling: plan.priority_scheduling,
          same_day_response: plan.same_day_response,
          annual_roof_inspections_included: plan.annual_roof_inspections_included,
          annual_plumbing_checks_included: plan.annual_plumbing_checks_included,
        },
      });
      if (insertError) {
        // A unique_violation here means a retried webhook raced the
        // pre-check above and lost - safe to treat as already-processed,
        // not a real failure.
        if (insertError.code === "23505") return json({ ok: true, already_processed: true });
        console.error("[membership-stripe-webhook] Failed to insert client_membership", insertError.message);
        return json({ error: "server_error" }, 500);
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscriptionId = object.id as string | undefined;
      if (!subscriptionId) return json({ ok: true, skipped: "missing_subscription_id" });

      const status = event.type === "customer.subscription.deleted" ? "cancelled" : mapSubscriptionStatus(object.status as string);

      const update: Record<string, unknown> = { status };
      if (object.current_period_start) update.current_period_start = unixToDate(object.current_period_start);
      if (object.current_period_end) update.current_period_end = unixToDate(object.current_period_end);
      if (status === "cancelled") update.cancelled_at = new Date().toISOString();

      const { error } = await admin.from("client_memberships").update(update).eq("stripe_subscription_id", subscriptionId);
      if (error) {
        console.error("[membership-stripe-webhook] Failed to update client_membership", error.message);
        return json({ error: "server_error" }, 500);
      }
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const subscriptionId = object.subscription as string | undefined;
      if (!subscriptionId || !stripeAccount) return json({ ok: true, skipped: "missing_subscription_id" });

      if (event.type === "invoice.payment_failed") {
        const { error } = await admin.from("client_memberships").update({ status: "past_due" }).eq("stripe_subscription_id", subscriptionId);
        if (error) {
          console.error("[membership-stripe-webhook] Failed to mark past_due", error.message);
          return json({ error: "server_error" }, 500);
        }
      } else {
        // invoice.paid - re-fetch the subscription for the authoritative
        // current_period_start/end (an invoice object's own period fields
        // aren't reliably present depending on API version/invoice type),
        // and mark active - this is what advances current_period_end each
        // renewal, which membership_renewal_upcoming's cron sweep and
        // membership_benefit_usage's per-period uniqueness both depend on.
        const sub = await stripeGet(`subscriptions/${subscriptionId}`, stripeAccount);
        if (!sub.ok) {
          console.error("[membership-stripe-webhook] Failed to fetch subscription for invoice.paid", sub.body);
          return json({ error: "server_error" }, 500);
        }
        const { error } = await admin
          .from("client_memberships")
          .update({
            status: "active",
            current_period_start: unixToDate(sub.body.current_period_start),
            current_period_end: unixToDate(sub.body.current_period_end),
          })
          .eq("stripe_subscription_id", subscriptionId);
        if (error) {
          console.error("[membership-stripe-webhook] Failed to renew client_membership", error.message);
          return json({ error: "server_error" }, 500);
        }
      }
    }
  } catch (e) {
    console.error("[membership-stripe-webhook] Unhandled error", e instanceof Error ? e.message : String(e));
    return json({ error: "server_error" }, 500);
  }

  // Every other event type (and every handled one) is acknowledged and
  // ignored/succeeded - Stripe retries on anything but a 2xx.
  return json({ ok: true });
});
