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

const STATUS_BADGE: Record<ReciprocityStatus, { label: string; classes: string }> = {
  balanced: { label: "🟢 Balanced Partner", classes: "bg-green-50 text-green-700" },
  net_exporter: { label: "🟡 Net Exporter", classes: "bg-yellow-50 text-yellow-800" },
  net_importer: { label: "🔵 Net Importer", classes: "bg-blue-50 text-blue-700" },
  no_data: { label: "No referral activity yet", classes: "bg-gray-100 text-gray-500" },
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
          <p className="text-sm text-gray-500">No inbound or outbound referral activity recorded yet.</p>
        ) : (
          rows.map(({ partner, inbound, outbound, status }) => {
            const max = Math.max(inbound, outbound, 1);
            return (
              <div key={partner.id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-bold text-gray-900">{partnerDisplayName(partner)}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[status].classes}`}>
                    {STATUS_BADGE[status].label}
                  </span>
                </div>
                <div className="space-y-2 text-sm">
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-gray-500">
                      <span>Inbound (from {partner.contact_first_name})</span>
                      <span className="font-semibold text-gray-700">{formatCentsAsAud(inbound)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100">
                      <div className="h-2 rounded-full bg-blue-600" style={{ width: `${(inbound / max) * 100}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-gray-500">
                      <span>Outbound (to {partner.contact_first_name})</span>
                      <span className="font-semibold text-gray-700">{formatCentsAsAud(outbound)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100">
                      <div className="h-2 rounded-full bg-amber-500" style={{ width: `${(outbound / max) * 100}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Referrals passed out - recent log</h2>
        {reciprocityLogs.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing logged yet - use "Log Referral Passed Out" on the Directory tab.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
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
                  <tr key={log.id} className="border-b border-gray-100 last:border-0">
                    <td className="py-2 text-gray-500">{log.date_passed}</td>
                    <td className="py-2">{partner ? partnerDisplayName(partner) : "Unknown partner"}</td>
                    <td className="py-2">{log.client_name}</td>
                    <td className="py-2 text-right">{log.estimated_value_cents != null ? formatCentsAsAud(log.estimated_value_cents) : "-"}</td>
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
