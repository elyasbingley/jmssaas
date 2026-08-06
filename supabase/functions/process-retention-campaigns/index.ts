// Dormant-client detection sweep for the communication engine (see
// supabase/migrations/20260818000100_communication_engine_retention.sql).
// Deployed as a Supabase Edge Function, invoked on its OWN daily pg_cron
// schedule - separate from process-scheduled-comms's 5-minute sweep, since
// there's no reason to re-check "has it been a year" that often. This
// function only DETECTS and QUEUES - it inserts a `pending`
// scheduled_communications row for each newly-dormant client, then gets
// out of the way; the actual rendering and sending happens through
// process-scheduled-comms's normal cron sweep, same as every other
// trigger_key, including respecting quiet hours. Service-role-only, same
// auth shape as process-scheduled-comms's cron path - this reads/writes
// across every tenant.
//
// Unlike every other trigger_key, "a client has gone quiet" isn't a single
// row's insert/update event to hook a Postgres trigger off - it only
// becomes true because the calendar advances, not because anything in the
// database changed. That's the whole reason this is a separate Edge
// Function with its own schedule rather than another trigger in the
// migration.
//
// Idempotency is different here too. Every other trigger_key checks "has
// this exact (entity_type, entity_id, trigger_key) ever been scheduled" -
// fine for a quote or invoice, which only ever gets sent once. A client
// isn't like that: they can go dormant, come back, and go dormant again
// years later, and each dormancy deserves its own email. So the check here
// is "has a dormant_client_reengagement row been scheduled for this client
// SINCE their most recent job" - once they book again, that most-recent-
// job date moves forward, and the next time they cross the dormancy
// threshold a fresh email is scheduled, without ever double-sending for
// the same dormancy period.
//
// A client with no job history at all is skipped entirely - they were
// never really an active client to begin with, so "we haven't seen you in
// a while" doesn't apply.

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

  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) {
    console.error("[process-retention-campaigns] Failed to fetch tenants", tenantsError.message);
    return json({ error: "server_error" }, 500);
  }

  let scanned = 0;
  let queued = 0;

  for (const tenant of tenants ?? []) {
    const { data: rule } = await admin
      .from("communication_rules")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "dormant_client_reengagement")
      .maybeSingle();
    if (!rule || !rule.is_enabled) continue;

    // delay_offset_value/unit here is the "days of inactivity" setting
    // (see the migration's comment) - hours is a legal unit on the column
    // but doesn't make sense at this scale, so it's just treated as an
    // (unlikely) fractional day rather than rejected outright.
    const dormantDays = rule.delay_offset_unit === "hours" ? rule.delay_offset_value / 24 : rule.delay_offset_value;
    const dormancyThreshold = new Date(now.getTime() - dormantDays * 24 * 60 * 60 * 1000);

    const { data: templates } = await admin
      .from("communication_templates")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "dormant_client_reengagement")
      .eq("is_active", true);
    const matchingTemplates = (templates ?? []).filter((t) => rule.channel === "both" || rule.channel === t.type);
    if (matchingTemplates.length === 0) continue;

    // One row per client with their most recent job's created_at - clients
    // with zero jobs simply don't appear in this result at all (inner join
    // behaviour of grouping by an existing job_cards row).
    const { data: lastJobs, error: lastJobsError } = await admin
      .from("job_cards")
      .select("client_id, created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false });
    if (lastJobsError) {
      console.error(`[process-retention-campaigns] Failed to fetch jobs for tenant ${tenant.id}`, lastJobsError.message);
      continue;
    }

    const lastJobByClient = new Map<string, string>();
    for (const job of lastJobs ?? []) {
      if (!lastJobByClient.has(job.client_id)) lastJobByClient.set(job.client_id, job.created_at);
    }

    for (const [clientId, lastJobCreatedAt] of lastJobByClient) {
      scanned++;
      const lastJobDate = new Date(lastJobCreatedAt);
      if (lastJobDate > dormancyThreshold) continue;

      const { data: existing } = await admin
        .from("scheduled_communications")
        .select("id")
        .eq("entity_type", "client")
        .eq("entity_id", clientId)
        .eq("trigger_key", "dormant_client_reengagement")
        .gte("created_at", lastJobCreatedAt)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const { data: client } = await admin.from("clients").select("phone, email").eq("id", clientId).single();
      if (!client) continue;

      for (const template of matchingTemplates) {
        const recipient = template.type === "sms" ? (client.phone ?? "") : (client.email ?? "");
        await admin.from("scheduled_communications").insert({
          tenant_id: tenant.id,
          entity_type: "client",
          entity_id: clientId,
          trigger_key: "dormant_client_reengagement",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: recipient,
          rendered_subject: template.subject,
          rendered_body: template.body,
          scheduled_for: now.toISOString(),
          status: "pending",
        });
        queued++;
      }
    }
  }

  return json({ ok: true, tenants: (tenants ?? []).length, scanned, queued });
});
