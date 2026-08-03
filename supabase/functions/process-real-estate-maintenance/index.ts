// Recurring Maintenance Engine's due-date detection sweep (see the
// real_estate_maintenance_engine migration). Deployed as a Supabase Edge
// Function, invoked on its own daily pg_cron schedule - same shape as
// process-retention-campaigns (a calendar-driven check, not a row insert/
// update a Postgres trigger could hook), not process-scheduled-comms'
// 5-minute sweep. This function only DETECTS and QUEUES a `pending`
// scheduled_communications row per due asset; the actual token rendering
// and sending happens through process-scheduled-comms' normal cron sweep,
// same as every other trigger_key (see that function's `property_asset`
// branch in buildEntityContext).
//
// Scoped specifically to the gutter-clean schedule already captured on a
// roofing property_assets row (last_gutter_clean_date +
// gutter_clean_interval_months) - see the migration's own comment for why
// the spec's other example (backflow inspections) isn't modelled here.
//
// Idempotency mirrors process-retention-campaigns: "has a
// property_maintenance_due row been queued for this asset SINCE its
// last_gutter_clean_date" - once the asset's last_gutter_clean_date is
// updated after the clean actually happens, the next due cycle gets a
// fresh reminder without ever double-sending for the same cycle.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

interface PropertyAssetRow {
  id: string;
  tenant_id: string;
  property_id: string;
  attributes: { last_gutter_clean_date?: string; gutter_clean_interval_months?: number };
}

function computeDueDate(asset: PropertyAssetRow): Date | null {
  const { last_gutter_clean_date, gutter_clean_interval_months } = asset.attributes ?? {};
  if (!last_gutter_clean_date || !gutter_clean_interval_months) return null;
  const d = new Date(`${last_gutter_clean_date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + gutter_clean_interval_months);
  return d;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) {
    console.error("[process-real-estate-maintenance] Failed to fetch tenants", tenantsError.message);
    return json({ error: "server_error" }, 500);
  }

  let scanned = 0;
  let queued = 0;

  for (const tenant of tenants ?? []) {
    const { data: rule } = await admin
      .from("communication_rules")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "property_maintenance_due")
      .maybeSingle();
    if (!rule || !rule.is_enabled) continue;

    const reminderWindowDays = rule.delay_offset_unit === "hours" ? rule.delay_offset_value / 24 : rule.delay_offset_value;
    const reminderThreshold = new Date(now.getTime() + reminderWindowDays * 24 * 60 * 60 * 1000);

    const { data: templates } = await admin
      .from("communication_templates")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "property_maintenance_due")
      .eq("is_active", true);
    const matchingTemplates = (templates ?? []).filter((t) => rule.channel === "both" || rule.channel === t.type);
    if (matchingTemplates.length === 0) continue;

    const { data: assets, error: assetsError } = await admin
      .from("property_assets")
      .select("id, tenant_id, property_id, attributes")
      .eq("tenant_id", tenant.id)
      .eq("category", "roofing");
    if (assetsError) {
      console.error(`[process-real-estate-maintenance] Failed to fetch assets for tenant ${tenant.id}`, assetsError.message);
      continue;
    }

    for (const asset of (assets ?? []) as PropertyAssetRow[]) {
      const dueDate = computeDueDate(asset);
      if (!dueDate) continue;
      scanned++;
      if (dueDate > reminderThreshold) continue;

      const { data: existing } = await admin
        .from("scheduled_communications")
        .select("id")
        .eq("entity_type", "property_asset")
        .eq("entity_id", asset.id)
        .eq("trigger_key", "property_maintenance_due")
        .gte("created_at", asset.attributes.last_gutter_clean_date!)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const { data: property } = await admin
        .from("properties")
        .select("property_manager_id")
        .eq("id", asset.property_id)
        .single();
      if (!property?.property_manager_id) continue;

      const { data: pm } = await admin.from("property_managers").select("email").eq("id", property.property_manager_id).single();
      if (!pm?.email) continue;

      for (const template of matchingTemplates) {
        await admin.from("scheduled_communications").insert({
          tenant_id: tenant.id,
          entity_type: "property_asset",
          entity_id: asset.id,
          trigger_key: "property_maintenance_due",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: pm.email,
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
