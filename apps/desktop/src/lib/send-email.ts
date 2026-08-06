import type { ScheduledCommunicationEntityType } from "@jmssaas/shared";
import { supabase } from "./supabase";
import { triggerImmediateDispatch } from "./dispatch-now";

function splitEmails(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Shared by every email send in the app that goes through
// EmailComposeModal (quote/invoice delivery, job review requests, the
// free-form job card email) - queues one scheduled_communications row with
// the composer's final (possibly hand-edited) subject/body/cc/bcc, then
// tries to dispatch it immediately the same way the pre-composer send
// buttons always did. Returns whether it actually sent synchronously (vs.
// just queued for the next cron sweep), same semantics
// triggerImmediateDispatch already has.
export async function queueAndSendEmail(params: {
  tenantId: string;
  entityType: ScheduledCommunicationEntityType;
  entityId: string;
  triggerKey: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}): Promise<boolean> {
  const { tenantId, entityType, entityId, triggerKey, to, cc, bcc, subject, body } = params;
  const { data: row, error } = await supabase
    .from("scheduled_communications")
    .insert({
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId,
      trigger_key: triggerKey,
      channel: "email",
      recipient_phone_or_email: to,
      cc_emails: splitEmails(cc ?? ""),
      bcc_emails: splitEmails(bcc ?? ""),
      rendered_subject: subject,
      rendered_body: body,
      scheduled_for: new Date().toISOString(),
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;

  return triggerImmediateDispatch(row.id);
}
