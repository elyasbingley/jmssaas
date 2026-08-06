// B2B Partner & Referral Tracking - monthly referral digest sweep (see the
// b2b_referral_automation migration). Deployed as its own Supabase Edge
// Function, invoked on its own monthly pg_cron schedule - same "calendar-
// driven check, not a row insert/update a Postgres trigger could hook"
// shape as process-retention-campaigns/process-real-estate-maintenance.
//
// Unlike every other trigger_key, this one is fully rendered HERE, before
// insert, rather than left with raw {tokens} for process-scheduled-comms
// to resolve at send time. There's no single job/invoice row this message
// is "about" - it's a per-partner summary across every job that closed
// last calendar month - so there's no natural entity_id to point
// process-scheduled-comms' buildEntityContext at that would let it
// reconstruct the digest numbers on its own. Summing here, once, and
// baking the result into rendered_subject/rendered_body is simpler than
// teaching the generic dispatcher a "recompute a month of closed business"
// code path for a single trigger_key. entity_id is still set to the
// partner's own id (not null) so the Communication Log / dedup queries
// have something concrete to point at - see buildEntityContext's
// referral_partner fallback branch in process-scheduled-comms for how a
// bare partner id is handled safely there.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

function formatCentsAsAud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function render(body: string, tokens: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) => (key in tokens ? tokens[key]! : match));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  // The just-completed calendar month, in UTC - good enough for a once-
  // a-month digest (the same simplification process-scheduled-comms' own
  // quiet-hours math accepts for DST edges, just at a much coarser grain).
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthLabel = periodStart.toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });

  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) {
    console.error("[process-referral-digest] Failed to fetch tenants", tenantsError.message);
    return json({ error: "server_error" }, 500);
  }

  let scanned = 0;
  let queued = 0;

  for (const tenant of tenants ?? []) {
    const { data: rule } = await admin
      .from("communication_rules")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "referral_monthly_digest")
      .maybeSingle();
    if (!rule || !rule.is_enabled) continue;

    const { data: templates } = await admin
      .from("communication_templates")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "referral_monthly_digest")
      .eq("is_active", true);
    const matchingTemplates = (templates ?? []).filter((t) => rule.channel === "both" || rule.channel === t.type);
    if (matchingTemplates.length === 0) continue;

    const { data: partners } = await admin
      .from("referral_partners")
      .select("id, contact_first_name, email, status")
      .eq("tenant_id", tenant.id)
      .eq("status", "active");

    for (const partner of partners ?? []) {
      scanned++;
      if (!partner.email) continue;

      // Already queued this partner's digest for this run (idempotency -
      // same "has a row been queued since X" shape as the maintenance/
      // retention sweeps, just keyed on this month's start instead of a
      // per-asset date).
      const { data: existing } = await admin
        .from("scheduled_communications")
        .select("id")
        .eq("entity_type", "referral_partner")
        .eq("entity_id", partner.id)
        .eq("trigger_key", "referral_monthly_digest")
        .gte("created_at", periodEnd.toISOString())
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const { data: jobs } = await admin.from("job_cards").select("id").eq("referral_partner_id", partner.id);
      const jobIds = (jobs ?? []).map((j: { id: string }) => j.id);
      if (jobIds.length === 0) continue;

      const { data: invoices } = await admin
        .from("invoices")
        .select("total_cents, paid_at")
        .in("job_card_id", jobIds)
        .eq("status", "paid")
        .gte("paid_at", periodStart.toISOString())
        .lt("paid_at", periodEnd.toISOString());

      const closedInvoices = invoices ?? [];
      if (closedInvoices.length === 0) continue; // Nothing to report - skip rather than send an empty digest.

      const totalCents = closedInvoices.reduce((sum: number, inv: { total_cents: number }) => sum + inv.total_cents, 0);
      const tokens = {
        partner_first_name: firstName(partner.contact_first_name),
        digest_jobs_count: String(closedInvoices.length),
        digest_total_value: formatCentsAsAud(totalCents),
      };

      for (const template of matchingTemplates) {
        await admin.from("scheduled_communications").insert({
          tenant_id: tenant.id,
          entity_type: "referral_partner",
          entity_id: partner.id,
          trigger_key: "referral_monthly_digest",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: partner.email,
          rendered_subject: template.subject ? render(template.subject, tokens) : template.subject,
          rendered_body: render(template.body, tokens),
          scheduled_for: now.toISOString(),
          status: "pending",
        });
        queued++;
      }
    }
  }

  return json({ ok: true, tenants: (tenants ?? []).length, scanned, queued, month: monthLabel });
});
