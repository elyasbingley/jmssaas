// Membership renewal/benefit-reminder sweep (see the
// membership_communications migration). Deployed as a Supabase Edge
// Function, invoked on its own daily pg_cron schedule - same shape as
// process-real-estate-maintenance/process-retention-campaigns (a
// calendar-driven check, not a row insert/update a Postgres trigger could
// hook), not process-scheduled-comms' 5-minute sweep. This function only
// DETECTS and QUEUES a `pending` scheduled_communications row per due
// membership; the actual token rendering and sending happens through
// process-scheduled-comms' normal cron sweep, same as every other
// trigger_key (see that function's `client_membership` branch in
// buildEntityContext).
//
// Two independent due-checks per tenant, sharing one membership fetch:
//
//   - membership_renewal_upcoming: current_period_end within the rule's
//     configured window (delay_offset_value days before). Idempotency
//     mirrors process-real-estate-maintenance's "has a reminder been
//     queued since this cycle's reference date" - here, since
//     current_period_start.
//
//   - membership_annual_benefit_reminder: current_period_end within its own
//     (longer) window AND at least one plan-included benefit type
//     (annual_roof_inspection/annual_plumbing_check) has no
//     membership_benefit_usage row for the current period yet. Sends ONE
//     combined reminder per membership per period (not one per unused
//     benefit) - the {membership_benefit_type} token is resolved to a
//     joined label at send time by process-scheduled-comms, computed live
//     against membership_benefit_usage rather than trusted from queue
//     time - so this function only needs to know THAT something is
//     unused, not which, keeping the idempotency check to the same single
//     "queued since current_period_start" shape as the renewal check.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

interface ClientMembershipRow {
  id: string;
  tenant_id: string;
  client_id: string;
  membership_plan_id: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
}

interface CommunicationRuleRow {
  is_enabled: boolean;
  channel: "sms" | "email" | "both";
  delay_offset_value: number;
  delay_offset_unit: "hours" | "days";
}

interface CommunicationTemplateRow {
  id: string;
  type: "sms" | "email";
  subject: string | null;
  body: string;
}

function reminderThreshold(now: Date, rule: CommunicationRuleRow): Date {
  const windowDays = rule.delay_offset_unit === "hours" ? rule.delay_offset_value / 24 : rule.delay_offset_value;
  return new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) {
    console.error("[process-membership-reminders] Failed to fetch tenants", tenantsError.message);
    return json({ error: "server_error" }, 500);
  }

  let renewalQueued = 0;
  let benefitQueued = 0;

  for (const tenant of tenants ?? []) {
    const { data: memberships, error: membershipsError } = await admin
      .from("client_memberships")
      .select("id, tenant_id, client_id, membership_plan_id, status, current_period_start, current_period_end")
      .eq("tenant_id", tenant.id)
      .eq("status", "active")
      .not("current_period_end", "is", null);
    if (membershipsError) {
      console.error(`[process-membership-reminders] Failed to fetch memberships for tenant ${tenant.id}`, membershipsError.message);
      continue;
    }
    if (!memberships || memberships.length === 0) continue;

    // --- membership_renewal_upcoming ---
    const { data: renewalRule } = await admin
      .from("communication_rules")
      .select("is_enabled, channel, delay_offset_value, delay_offset_unit")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "membership_renewal_upcoming")
      .maybeSingle();

    if (renewalRule && (renewalRule as CommunicationRuleRow).is_enabled) {
      const rule = renewalRule as CommunicationRuleRow;
      const { data: renewalTemplates } = await admin
        .from("communication_templates")
        .select("id, type, subject, body")
        .eq("tenant_id", tenant.id)
        .eq("trigger_key", "membership_renewal_upcoming")
        .eq("is_active", true);
      const matchingRenewalTemplates = ((renewalTemplates ?? []) as CommunicationTemplateRow[]).filter(
        (t) => rule.channel === "both" || rule.channel === t.type
      );

      if (matchingRenewalTemplates.length > 0) {
        const threshold = reminderThreshold(now, rule);

        for (const membership of memberships as ClientMembershipRow[]) {
          const periodEnd = new Date(`${membership.current_period_end}T00:00:00Z`);
          if (periodEnd > threshold) continue;

          const { data: existing } = await admin
            .from("scheduled_communications")
            .select("id")
            .eq("entity_type", "client_membership")
            .eq("entity_id", membership.id)
            .eq("trigger_key", "membership_renewal_upcoming")
            .gte("created_at", membership.current_period_start ?? membership.current_period_end!)
            .limit(1)
            .maybeSingle();
          if (existing) continue;

          const { data: client } = await admin.from("clients").select("email").eq("id", membership.client_id).single();
          if (!client?.email) continue;

          for (const template of matchingRenewalTemplates) {
            await admin.from("scheduled_communications").insert({
              tenant_id: tenant.id,
              entity_type: "client_membership",
              entity_id: membership.id,
              trigger_key: "membership_renewal_upcoming",
              template_id: template.id,
              channel: template.type,
              recipient_phone_or_email: client.email,
              rendered_subject: template.subject,
              rendered_body: template.body,
              scheduled_for: now.toISOString(),
              status: "pending",
            });
            renewalQueued++;
          }
        }
      }
    }

    // --- membership_annual_benefit_reminder ---
    const { data: benefitRule } = await admin
      .from("communication_rules")
      .select("is_enabled, channel, delay_offset_value, delay_offset_unit")
      .eq("tenant_id", tenant.id)
      .eq("trigger_key", "membership_annual_benefit_reminder")
      .maybeSingle();

    if (benefitRule && (benefitRule as CommunicationRuleRow).is_enabled) {
      const rule = benefitRule as CommunicationRuleRow;
      const { data: benefitTemplates } = await admin
        .from("communication_templates")
        .select("id, type, subject, body")
        .eq("tenant_id", tenant.id)
        .eq("trigger_key", "membership_annual_benefit_reminder")
        .eq("is_active", true);
      const matchingBenefitTemplates = ((benefitTemplates ?? []) as CommunicationTemplateRow[]).filter(
        (t) => rule.channel === "both" || rule.channel === t.type
      );

      if (matchingBenefitTemplates.length > 0) {
        const threshold = reminderThreshold(now, rule);

        for (const membership of memberships as ClientMembershipRow[]) {
          if (!membership.current_period_start) continue;
          const periodEnd = new Date(`${membership.current_period_end}T00:00:00Z`);
          if (periodEnd > threshold) continue;

          const { data: plan } = await admin
            .from("membership_plans")
            .select("annual_roof_inspections_included, annual_plumbing_checks_included")
            .eq("id", membership.membership_plan_id)
            .single();
          if (!plan) continue;

          const includedBenefitTypes: string[] = [];
          if (plan.annual_roof_inspections_included > 0) includedBenefitTypes.push("annual_roof_inspection");
          if (plan.annual_plumbing_checks_included > 0) includedBenefitTypes.push("annual_plumbing_check");
          if (includedBenefitTypes.length === 0) continue;

          const { data: used } = await admin
            .from("membership_benefit_usage")
            .select("benefit_type")
            .eq("client_membership_id", membership.id)
            .eq("period_start", membership.current_period_start);
          const usedTypes = new Set((used ?? []).map((u: { benefit_type: string }) => u.benefit_type));
          const hasUnusedBenefit = includedBenefitTypes.some((t) => !usedTypes.has(t));
          if (!hasUnusedBenefit) continue;

          const { data: existing } = await admin
            .from("scheduled_communications")
            .select("id")
            .eq("entity_type", "client_membership")
            .eq("entity_id", membership.id)
            .eq("trigger_key", "membership_annual_benefit_reminder")
            .gte("created_at", membership.current_period_start)
            .limit(1)
            .maybeSingle();
          if (existing) continue;

          const { data: client } = await admin.from("clients").select("email").eq("id", membership.client_id).single();
          if (!client?.email) continue;

          for (const template of matchingBenefitTemplates) {
            await admin.from("scheduled_communications").insert({
              tenant_id: tenant.id,
              entity_type: "client_membership",
              entity_id: membership.id,
              trigger_key: "membership_annual_benefit_reminder",
              template_id: template.id,
              channel: template.type,
              recipient_phone_or_email: client.email,
              rendered_subject: template.subject,
              rendered_body: template.body,
              scheduled_for: now.toISOString(),
              status: "pending",
            });
            benefitQueued++;
          }
        }
      }
    }
  }

  return json({ ok: true, tenants: (tenants ?? []).length, renewalQueued, benefitQueued });
});
