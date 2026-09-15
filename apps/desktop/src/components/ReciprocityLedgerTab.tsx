import { useMemo } from "react";
import { formatCentsAsAud, type ReferralPartner, type ReferralReciprocityLog } from "@jmssaas/shared";
import { partnerDisplayName, type ReferralInvoiceRow, type ReferredJob } from "../pages/B2BReferrals";

// Sub-tab 3: two-way value tracking per partner - inbound (revenue from
// jobs they referred to us) vs outbound (estimated value of leads we
// passed to them, from referral_reciprocity_logs). Ratio thresholds
// (>2x favors one side = "Net", within 2x = "Balanced") are a judgment
// call - the spec names three states but not the cutoffs, so this picks a
// simple, explainable rule of thumb rather than an arbitrary precise one.

type ReciprocityStatus = "balanced" | "net_exporter" | "net_importer" | "no_data";

function reciprocityStatus(inboundCents: number, outboundCents: number): ReciprocityStatus {
  if (inboundCents === 0 && outboundCents === 0) return "no_data";
  const ratio = outboundCents / Math.max(inboundCents, 1);
  if (ratio > 2) return "net_exporter";
  if (ratio < 0.5) return "net_importer";
  return "balanced";
}

// Reciprocity status colors derive from theme tokens rather than a fixed
// palette (unlike the tier badges) - same design decision the mobile app's
// STATUS_BADGE made (apps/mobile/app/b2b-referrals/index.tsx): balanced
// tracks the active accent, the two imbalanced states share the warning
// color, and no-data reads as muted.
const STATUS_BADGE: Record<ReciprocityStatus, { label: string; color: string }> = {
  balanced: { label: "Balanced Partner", color: "var(--jms-accent)" },
  net_exporter: { label: "Net Exporter", color: "var(--jms-warning)" },
  net_importer: { label: "Net Importer", color: "var(--jms-warning)" },
  no_data: { label: "No referral activity yet", color: "var(--jms-text-muted)" },
};

function inboundCentsForPartner(partnerId: string, referredJobs: ReferredJob[], referralInvoices: ReferralInvoiceRow[]): number {
  const jobIds = new Set(referredJobs.filter((j) => j.referral_partner_id === partnerId).map((j) => j.id));
  return referralInvoices
    .filter((inv) => inv.status === "paid" && inv.job_card_id && jobIds.has(inv.job_card_id))
    .reduce((sum, inv) => sum + inv.total_cents, 0);
}

export function ReciprocityLedgerTab({
  partners,
  referredJobs,
  referralInvoices,
  reciprocityLogs,
}: {
  partners: ReferralPartner[];
  referredJobs: ReferredJob[];
  referralInvoices: ReferralInvoiceRow[];
  reciprocityLogs: ReferralReciprocityLog[];
}) {
  const outboundByPartner = useMemo(() => {
    const map = new Map<string, number>();
    for (const log of reciprocityLogs) {
      map.set(log.partner_id, (map.get(log.partner_id) ?? 0) + (log.estimated_value_cents ?? 0));
    }
    return map;
  }, [reciprocityLogs]);

  const rows = partners
    .map((partner) => {
      const inbound = inboundCentsForPartner(partner.id, referredJobs, referralInvoices);
      const outbound = outboundByPartner.get(partner.id) ?? 0;
      return { partner, inbound, outbound, status: reciprocityStatus(inbound, outbound) };
    })
    .filter((r) => r.inbound > 0 || r.outbound > 0)
    .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound));

  return (
    <div>
      <div className="mb-6 space-y-3">
        {rows.length === 0 ? (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No inbound or outbound referral activity recorded yet.</p>
        ) : (
          rows.map(({ partner, inbound, outbound, status }) => {
            const max = Math.max(inbound, outbound, 1);
            const badge = STATUS_BADGE[status];
            return (
              <div key={partner.id} className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-bold" style={{ color: "var(--jms-text)" }}>
                    {partnerDisplayName(partner)}
                  </p>
                  <span
                    className="rounded border px-2 py-0.5 font-semibold uppercase tracking-wide"
                    style={{ borderColor: badge.color, color: badge.color, fontSize: "var(--jms-font-label)" }}
                  >
                    {badge.label}
                  </span>
                </div>
                <div className="space-y-2" style={{ fontSize: "var(--jms-font-body)" }}>
                  <div>
                    <div className="mb-1 flex justify-between" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      <span>Inbound (from {partner.contact_first_name})</span>
                      <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                        {formatCentsAsAud(inbound)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }}>
                      <div className="h-2 rounded-full" style={{ width: `${(inbound / max) * 100}%`, backgroundColor: "var(--jms-accent)" }} />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      <span>Outbound (to {partner.contact_first_name})</span>
                      <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                        {formatCentsAsAud(outbound)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }}>
                      <div className="h-2 rounded-full" style={{ width: `${(outbound / max) * 100}%`, backgroundColor: "var(--jms-warning)" }} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="mb-3 font-bold uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          Referrals passed out - recent log
        </h2>
        {reciprocityLogs.length === 0 ? (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Nothing logged yet - use "Log Referral Passed Out" on the Directory tab.</p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              <tr>
                <th className="py-2 font-semibold">Date</th>
                <th className="py-2 font-semibold">Partner</th>
                <th className="py-2 font-semibold">Client / lead</th>
                <th className="py-2 text-right font-semibold">Est. value</th>
              </tr>
            </thead>
            <tbody>
              {reciprocityLogs.slice(0, 20).map((log) => {
                const partner = partners.find((p) => p.id === log.partner_id);
                return (
                  <tr key={log.id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="py-2" style={{ color: "var(--jms-text-muted)" }}>
                      {log.date_passed}
                    </td>
                    <td className="py-2" style={{ color: "var(--jms-text)" }}>
                      {partner ? partnerDisplayName(partner) : "Unknown partner"}
                    </td>
                    <td className="py-2" style={{ color: "var(--jms-text)" }}>
                      {log.client_name}
                    </td>
                    <td className="py-2 text-right" style={{ color: "var(--jms-text)" }}>
                      {log.estimated_value_cents != null ? formatCentsAsAud(log.estimated_value_cents) : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
