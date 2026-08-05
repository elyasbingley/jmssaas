// Subcontractor Management - daily compliance lockout sweep (Workflow 4).
// Deployed as its own Supabase Edge Function, invoked on its own daily
// pg_cron schedule - same "calendar-driven check, not a row insert/update
// a Postgres trigger could hook" shape as process-retention-campaigns/
// process-real-estate-maintenance/process-referral-digest.
//
// Two jobs in one sweep:
//   1. Catch a document that silently crossed its expiry_date with nobody
//      touching the row that day - recompute_subcontractor_compliance_status
//      (the trigger version, fired on insert/update/delete of a compliance
//      doc) can never see this case, only this daily pass can.
//   2. Queue the "please send updated paperwork" reminder email to every
//      contact of every newly-held (or still-held) subcontractor.
//
// Idempotency is per-contact, not per-subcontractor (unlike every other
// trigger_key's "has this exact entity_id ever been scheduled" check) -
// the spec's own wording is "send to ALL subcontractor_contacts", so a
// second contact at the same subcontractor must still get their own row
// even though the first contact's row already satisfies a naive entity-id
// check. This resends the reminder daily for as long as the hold remains
// unresolved (deliberately - an unresolved compliance gap is exactly the
// kind of thing that should keep nagging, not fire once and go silent).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);

  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) {
    console.error("[process-subcontractor-compliance] Failed to fetch tenants", tenantsError.message);
    return json({ error: "server_error" }, 500);
  }

  let scanned = 0;
  let queued = 0;

  for (const tenant of tenants ?? []) {
    const { data: rule } = await admin
      .from("communication_rules")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "subcontractor_compliance_expired")
      .maybeSingle();
    if (!rule || !rule.is_enabled) continue;

    const { data: templates } = await admin
      .from("communication_templates")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "subcontractor_compliance_expired")
      .eq("is_active", true);
    const matchingTemplates = (templates ?? []).filter((t) => rule.channel === "both" || rule.channel === t.type);
    if (matchingTemplates.length === 0) continue;

    // Recompute every subcontractor's status first, catching any silent
    // expiry (job 1 above) before deciding who needs a reminder.
    const { data: subcontractors } = await admin
      .from("subcontractor_companies")
      .select("id, company_name")
      .eq("tenant_id", tenant.id);

    for (const sub of subcontractors ?? []) {
      scanned++;
      await admin.rpc("recompute_subcontractor_compliance_status", { p_subcontractor_id: sub.id });

      const { data: refreshed } = await admin.from("subcontractor_companies").select("status").eq("id", sub.id).single();
      if (refreshed?.status !== "compliance_hold") continue;

      const { data: contacts } = await admin.from("subcontractor_contacts").select("id, email").eq("subcontractor_id", sub.id);
      if (!contacts || contacts.length === 0) continue;

      for (const contact of contacts) {
        if (!contact.email) continue;

        // Per-contact idempotency (see the file header comment) - one
        // reminder per contact per day is enough, not one per contact
        // ever.
        const { data: existingToday } = await admin
          .from("scheduled_communications")
          .select("id")
          .eq("entity_type", "subcontractor")
          .eq("entity_id", sub.id)
          .eq("trigger_key", "subcontractor_compliance_expired")
          .eq("recipient_phone_or_email", contact.email)
          .gte("created_at", `${todayIso}T00:00:00Z`)
          .limit(1)
          .maybeSingle();
        if (existingToday) continue;

        for (const template of matchingTemplates) {
          await admin.from("scheduled_communications").insert({
            tenant_id: tenant.id,
            entity_type: "subcontractor",
            entity_id: sub.id,
            trigger_key: "subcontractor_compliance_expired",
            template_id: template.id,
            channel: template.type,
            recipient_phone_or_email: contact.email,
            rendered_subject: template.subject,
            rendered_body: template.body,
            scheduled_for: now.toISOString(),
            status: "pending",
          });
          queued++;
        }
      }
    }
  }

  return json({ ok: true, tenants: (tenants ?? []).length, scanned, queued });
});
