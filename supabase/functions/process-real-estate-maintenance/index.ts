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
// Since the asset_register migration this reads the asset service plans
// (asset_services) of every active asset on an agency property - gutter
// cleans, backflow tests, anything with an interval - rather than the old
// gutter-clean fields on a roofing asset. One reminder per asset per due
// date: asset_services.pm_reminded_for records which due date the property
// manager has been told about, so ticking the service off (which moves the
// due date on) makes the next cycle remind again.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

interface DueServiceRow {
  id: string;
  next_due_on: string;
  pm_reminded_for: string | null;
  property_assets: { id: string; property_id: string | null; status: string } | null;
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

    const { data: services, error: servicesError } = await admin
      .from("asset_services")
      .select("id, next_due_on, pm_reminded_for, property_assets!inner(id, property_id, status)")
      .eq("tenant_id", tenant.id)
      .not("property_assets.property_id", "is", null)
      .eq("property_assets.status", "active")
      .not("next_due_on", "is", null)
      .lte("next_due_on", reminderThreshold.toISOString().slice(0, 10));
    if (servicesError) {
      console.error(`[process-real-estate-maintenance] Failed to fetch services for tenant ${tenant.id}`, servicesError.message);
      continue;
    }

    // One reminder per asset, covering every service of it that's due.
    const byAsset = new Map<string, { propertyId: string; serviceIds: string[] }>();
    for (const service of (services ?? []) as unknown as DueServiceRow[]) {
      scanned++;
      const asset = service.property_assets;
      if (!asset?.property_id || service.pm_reminded_for === service.next_due_on) continue;
      const entry = byAsset.get(asset.id) ?? { propertyId: asset.property_id, serviceIds: [] };
      entry.serviceIds.push(service.id);
      byAsset.set(asset.id, entry);
    }

    for (const [assetId, { propertyId, serviceIds }] of byAsset) {
      const { data: property } = await admin.from("properties").select("property_manager_id").eq("id", propertyId).single();
      if (!property?.property_manager_id) continue;
      const { data: pm } = await admin.from("property_managers").select("email").eq("id", property.property_manager_id).single();
      if (!pm?.email) continue;

      for (const template of matchingTemplates) {
        await admin.from("scheduled_communications").insert({
          tenant_id: tenant.id,
          entity_type: "property_asset",
          entity_id: assetId,
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
      // Remember which due date this was for.
      for (const serviceId of serviceIds) {
        const service = ((services ?? []) as unknown as DueServiceRow[]).find((x) => x.id === serviceId)!;
        await admin.from("asset_services").update({ pm_reminded_for: service.next_due_on }).eq("id", serviceId);
      }
    }
  }

  return json({ ok: true, tenants: (tenants ?? []).length, scanned, queued });
});
