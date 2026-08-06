import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCentsAsAud, type JobLifecycleStage, type ReferralGroup, type ReferralPartner } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { SelectField } from "./FormField";
import { partnerDisplayName, type ReferralInvoiceRow, type ReferredJob } from "../pages/B2BReferrals";

// Sub-tab 2: KPI ribbon + the BNI "Thank You For Closed Business" (TYFCB)
// export tool. Every figure here is computed live from job_cards/invoices/
// referral_partners rather than a stored running total - same tradeoff Job
// Costing already makes elsewhere in this app: simpler and impossible to
// drift out of sync, at the cost of doing the aggregation client-side on
// every render instead of reading a pre-summed column.

async function fetchLifecycleStages(): Promise<JobLifecycleStage[]> {
  const { data, error } = await supabase.from("job_lifecycle_stages").select("*");
  if (error) throw error;
  return data as JobLifecycleStage[];
}

type DatePreset = "this_week" | "this_month" | "last_month" | "ytd" | "custom";

function presetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  if (preset === "this_week") {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    return { from: toIso(monday), to: toIso(now) };
  }
  if (preset === "this_month") {
    return { from: toIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: toIso(now) };
  }
  if (preset === "last_month") {
    return {
      from: toIso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: toIso(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  // ytd
  return { from: toIso(new Date(now.getFullYear(), 0, 1)), to: toIso(now) };
}

export function ReferralAnalyticsTab({
  groups,
  partners,
  referredJobs,
  referralInvoices,
}: {
  groups: ReferralGroup[];
  partners: ReferralPartner[];
  referredJobs: ReferredJob[];
  referralInvoices: ReferralInvoiceRow[];
}) {
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchLifecycleStages });

  const partnerById = useMemo(() => new Map(partners.map((p) => [p.id, p])), [partners]);
  const isClosedByStageId = useMemo(() => new Map((stages ?? []).map((s) => [s.id, s.is_closed])), [stages]);
  const jobById = useMemo(() => new Map(referredJobs.map((j) => [j.id, j])), [referredJobs]);

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
  const paidReferredInvoicesYtd = useMemo(
    () =>
      referralInvoices.filter(
        (inv) => inv.status === "paid" && inv.job_card_id && jobById.has(inv.job_card_id) && inv.paid_at && inv.paid_at >= yearStart
      ),
    [referralInvoices, jobById, yearStart]
  );

  const totalReferralRevenueYtdCents = paidReferredInvoicesYtd.reduce((sum, inv) => sum + inv.total_cents, 0);

  const bniPartnerIds = useMemo(
    () => new Set(partners.filter((p) => p.group_id && groups.find((g) => g.id === p.group_id)?.group_type === "bni_chapter").map((p) => p.id)),
    [partners, groups]
  );
  const bniTyfcbYtdCents = paidReferredInvoicesYtd
    .filter((inv) => {
      const job = jobById.get(inv.job_card_id!);
      return job?.referral_partner_id && bniPartnerIds.has(job.referral_partner_id);
    })
    .reduce((sum, inv) => sum + inv.total_cents, 0);

  const closedReferredJobs = referredJobs.filter((j) => isClosedByStageId.get(j.lifecycle_stage_id ?? "") === true);
  const conversionRate = referredJobs.length > 0 ? (closedReferredJobs.length / referredJobs.length) * 100 : 0;

  const wonJobIds = new Set(referralInvoices.filter((inv) => inv.status === "paid" && inv.job_card_id).map((inv) => inv.job_card_id!));
  const wonReferredJobCount = referredJobs.filter((j) => wonJobIds.has(j.id)).length;
  const avgValuePerReferredJobCents = wonReferredJobCount > 0 ? Math.round(totalReferralRevenueYtdCents / wonReferredJobCount) : 0;

  // --- BNI TYFCB export tool ---
  const bniGroups = groups.filter((g) => g.group_type === "bni_chapter");
  const [tyfcbGroupId, setTyfcbGroupId] = useState("");
  const [preset, setPreset] = useState<DatePreset>("this_month");
  const [customFrom, setCustomFrom] = useState(() => presetRange("this_month").from);
  const [customTo, setCustomTo] = useState(() => presetRange("this_month").to);
  const [copied, setCopied] = useState(false);

  const range = preset === "custom" ? { from: customFrom, to: customTo } : presetRange(preset);

  const tyfcbRows = useMemo(() => {
    const eligiblePartnerIds = new Set(
      partners.filter((p) => (tyfcbGroupId ? p.group_id === tyfcbGroupId : p.group_id && bniPartnerIds.has(p.id))).map((p) => p.id)
    );
    const byPartner = new Map<string, { jobsWon: number; revenueCents: number }>();
    for (const inv of referralInvoices) {
      if (inv.status !== "paid" || !inv.job_card_id || !inv.paid_at) continue;
      if (inv.paid_at < range.from || inv.paid_at > `${range.to}T23:59:59`) continue;
      const job = jobById.get(inv.job_card_id);
      if (!job?.referral_partner_id || !eligiblePartnerIds.has(job.referral_partner_id)) continue;
      const existing = byPartner.get(job.referral_partner_id) ?? { jobsWon: 0, revenueCents: 0 };
      existing.jobsWon += 1;
      existing.revenueCents += inv.total_cents;
      byPartner.set(job.referral_partner_id, existing);
    }
    return Array.from(byPartner.entries())
      .map(([partnerId, v]) => ({ partner: partnerById.get(partnerId), ...v }))
      .filter((r) => !!r.partner)
      .sort((a, b) => b.revenueCents - a.revenueCents);
  }, [partners, tyfcbGroupId, bniPartnerIds, referralInvoices, range.from, range.to, jobById, partnerById]);

  const tyfcbText = tyfcbRows
    .map((r) => `${partnerDisplayName(r.partner!)}\t${r.jobsWon}\t${formatCentsAsAud(r.revenueCents)}`)
    .join("\n");

  const copyToClipboard = async () => {
    const header = "Partner Name\tJobs Won Count\tTotal Revenue Generated";
    await navigator.clipboard.writeText(`${header}\n${tyfcbText}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const downloadCsv = () => {
    const header = "Partner Name,Jobs Won Count,Total Revenue Generated";
    const csvRows = tyfcbRows.map((r) => `"${partnerDisplayName(r.partner!).replace(/"/g, '""')}",${r.jobsWon},${(r.revenueCents / 100).toFixed(2)}`);
    const blob = new Blob([`${header}\n${csvRows.join("\n")}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bni-tyfcb-${range.from}-to-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Total Referral Revenue (YTD)</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(totalReferralRevenueYtdCents)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Conversion Rate of Referred Leads</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{conversionRate.toFixed(0)}%</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Average Value per Referred Job</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(avgValuePerReferredJobCents)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">BNI TYFCB Total (YTD)</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(bniTyfcbYtdCents)}</p>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-gray-500">BNI TYFCB Export Tool</h2>
        <p className="mb-4 text-sm text-gray-500">
          "Thank You For Closed Business" - ready-to-copy totals formatted for BNI Connect input, filtered by chapter and date range.
        </p>

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-64">
            <SelectField
              label="BNI Group"
              value={tyfcbGroupId}
              onChange={setTyfcbGroupId}
              options={bniGroups.map((g) => ({ value: g.id, label: g.name }))}
              placeholder="All BNI chapters"
            />
          </div>
          <div className="flex gap-1">
            {(
              [
                { value: "this_week", label: "This Week" },
                { value: "this_month", label: "This Month" },
                { value: "last_month", label: "Last Month" },
                { value: "ytd", label: "YTD" },
              ] as { value: DatePreset; label: string }[]
            ).map((p) => (
              <button
                key={p.value}
                onClick={() => setPreset(p.value)}
                className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
                  preset === p.value ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">From</label>
              <input
                type="date"
                value={preset === "custom" ? customFrom : range.from}
                onChange={(e) => {
                  setPreset("custom");
                  setCustomFrom(e.target.value);
                }}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-gray-700">To</label>
              <input
                type="date"
                value={preset === "custom" ? customTo : range.to}
                onChange={(e) => {
                  setPreset("custom");
                  setCustomTo(e.target.value);
                }}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>

        {tyfcbRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">No paid, referred jobs in this range.</p>
        ) : (
          <table className="mb-4 w-full text-left text-sm">
            <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2 font-semibold">Partner Name</th>
                <th className="py-2 text-right font-semibold">Jobs Won Count</th>
                <th className="py-2 text-right font-semibold">Total Revenue Generated ($)</th>
              </tr>
            </thead>
            <tbody>
              {tyfcbRows.map((r) => (
                <tr key={r.partner!.id} className="border-b border-gray-100 last:border-0">
                  <td className="py-2">{partnerDisplayName(r.partner!)}</td>
                  <td className="py-2 text-right">{r.jobsWon}</td>
                  <td className="py-2 text-right font-semibold">{formatCentsAsAud(r.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="flex gap-3">
          <button
            onClick={copyToClipboard}
            disabled={tyfcbRows.length === 0}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {copied ? "Copied!" : "Copy to Clipboard"}
          </button>
          <button
            onClick={downloadCsv}
            disabled={tyfcbRows.length === 0}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            Export TYFCB CSV
          </button>
        </div>
      </div>
    </div>
  );
}
