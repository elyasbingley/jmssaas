import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReferralPartner, ScheduledCommunicationStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { partnerDisplayName, type ReferredJob } from "../pages/B2BReferrals";

// Sub-tab 5: read-only audit trail of every automated email the three
// referral trigger_keys (see ReferralWorkflowsTab) have sent to partners -
// "what's gone out, to whom, and did it land." scheduled_communications has
// no FK to referral_partners (entity_id is polymorphic - see the
// b2b_referral_automation migration's own comment), and the two "job event"
// trigger_keys point at the job_cards.id, not the partner, while the
// monthly digest points at the partner's own id directly - so partner
// resolution below has to check both, same join process-scheduled-comms
// itself does at send time (buildEntityContext's entity_type ===
// 'referral_partner' branch).

const REFERRAL_TRIGGER_KEYS = ["referral_lead_received", "referral_job_completed", "referral_monthly_digest"] as const;

const TRIGGER_LABELS: Record<string, string> = {
  referral_lead_received: "Lead Received",
  referral_job_completed: "Job Won / Completed",
  referral_monthly_digest: "Monthly Digest",
};

const STATUS_COLOR_VAR: Record<ScheduledCommunicationStatus, string> = {
  pending: "var(--jms-warning)",
  sent: "var(--jms-accent)",
  cancelled: "var(--jms-text-muted)",
  failed: "var(--jms-danger)",
};

interface CommsRow {
  id: string;
  entity_id: string;
  trigger_key: string;
  channel: string;
  recipient_phone_or_email: string;
  rendered_subject: string | null;
  rendered_body: string;
  scheduled_for: string;
  status: ScheduledCommunicationStatus;
  sent_at: string | null;
  failure_reason: string | null;
}

async function fetchReferralComms(): Promise<CommsRow[]> {
  const { data, error } = await supabase
    .from("scheduled_communications")
    .select("id, entity_id, trigger_key, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for, status, sent_at, failure_reason")
    .eq("entity_type", "referral_partner")
    .in("trigger_key", REFERRAL_TRIGGER_KEYS)
    .order("scheduled_for", { ascending: false });
  if (error) throw error;
  return data as CommsRow[];
}

export function ReferralCommunicationsTab({ partners, referredJobs }: { partners: ReferralPartner[]; referredJobs: ReferredJob[] }) {
  const { data: rows, isLoading } = useQuery({ queryKey: ["referral-communication-log"], queryFn: fetchReferralComms });

  const partnerById = useMemo(() => new Map(partners.map((p) => [p.id, p])), [partners]);
  const partnerIdByJobId = useMemo(() => new Map(referredJobs.map((j) => [j.id, j.referral_partner_id])), [referredJobs]);

  const partnerNameFor = (entityId: string): string => {
    const directPartner = partnerById.get(entityId);
    if (directPartner) return partnerDisplayName(directPartner);
    const viaJobPartnerId = partnerIdByJobId.get(entityId);
    const viaJobPartner = viaJobPartnerId ? partnerById.get(viaJobPartnerId) : null;
    return viaJobPartner ? partnerDisplayName(viaJobPartner) : "Unknown partner";
  };

  if (isLoading) {
    return (
      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        No automated partner emails have gone out yet.
      </p>
    );
  }

  return (
    <div className="max-w-3xl space-y-2">
      <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        Every automated email sent to a referral partner, most recent first.
      </p>
      {rows.map((row) => (
        <div key={row.id} className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {partnerNameFor(row.entity_id)}
            </p>
            <span
              className="rounded border px-2 py-0.5 font-semibold uppercase tracking-wide"
              style={{ borderColor: STATUS_COLOR_VAR[row.status], color: STATUS_COLOR_VAR[row.status], fontSize: "var(--jms-font-label)" }}
            >
              {row.status}
            </span>
          </div>
          <p className="mb-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {TRIGGER_LABELS[row.trigger_key] ?? row.trigger_key} &middot; {row.channel.toUpperCase()} &middot; {row.recipient_phone_or_email || "No recipient on file"}
          </p>
          {row.rendered_subject ? (
            <p className="mb-1 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              {row.rendered_subject}
            </p>
          ) : null}
          <p className="line-clamp-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            {row.rendered_body.replace(/<[^>]+>/g, " ").trim()}
          </p>
          <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {row.status === "sent" && row.sent_at
              ? `Sent ${new Date(row.sent_at).toLocaleString("en-AU")}`
              : row.status === "failed"
                ? `Failed${row.failure_reason ? ` - ${row.failure_reason}` : ""}`
                : `Scheduled for ${new Date(row.scheduled_for).toLocaleString("en-AU")}`}
          </p>
        </div>
      ))}
    </div>
  );
}
