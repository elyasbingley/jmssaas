import { useMemo } from "react";
import { formatCentsAsAud, type PurchaseOrder, type SubcontractorCompany } from "@jmssaas/shared";
import { Link } from "react-router-dom";

// Sub-tab 3: cost-paid-vs-revenue-generated margin analytics per
// subcontractor. Formulas match the spec's own section 4 exactly:
//   Margin = billed_to_client_cents - total_cost_cents
//   Margin % = Margin / billed_to_client_cents * 100
//   Total Paid To Date = sum(total_cost_cents) where status = 'paid'
// "Revenue Generated" is summed over completed/paid POs only (not
// draft/sent/quoted ones) - counting revenue from work that hasn't
// actually been delivered yet would overstate margin on anything still
// in flight, a judgment call the spec's formula section doesn't pin down
// itself.

export function FinancialPerformanceTab({
  subcontractors,
  purchaseOrders,
}: {
  subcontractors: SubcontractorCompany[];
  purchaseOrders: PurchaseOrder[];
}) {
  const rows = useMemo(() => {
    return subcontractors
      .map((sub) => {
        const subPos = purchaseOrders.filter((po) => po.subcontractor_id === sub.id && !po.is_quote_request);
        const totalPaidCents = subPos.filter((po) => po.status === "paid").reduce((sum, po) => sum + po.total_cost_cents, 0);
        const revenueCents = subPos
          .filter((po) => po.status === "completed" || po.status === "paid")
          .reduce((sum, po) => sum + (po.billed_to_client_cents ?? 0), 0);
        const paidForMarginCents = subPos
          .filter((po) => po.status === "completed" || po.status === "paid")
          .reduce((sum, po) => sum + po.total_cost_cents, 0);
        const marginCents = revenueCents - paidForMarginCents;
        const marginPercent = revenueCents > 0 ? (marginCents / revenueCents) * 100 : 0;
        return { sub, totalPaidCents, revenueCents, marginCents, marginPercent, poCount: subPos.length };
      })
      .filter((r) => r.poCount > 0)
      .sort((a, b) => b.marginCents - a.marginCents);
  }, [subcontractors, purchaseOrders]);

  const totals = rows.reduce(
    (acc, r) => ({
      paid: acc.paid + r.totalPaidCents,
      revenue: acc.revenue + r.revenueCents,
      margin: acc.margin + r.marginCents,
    }),
    { paid: 0, revenue: 0, margin: 0 }
  );

  return (
    <div>
      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Total Paid To Subbies</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(totals.paid)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Total Revenue Generated</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(totals.revenue)}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Total Margin Made</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(totals.margin)}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No purchase orders yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Subcontractor</th>
                <th className="px-4 py-2 text-right font-semibold">Total Paid To Subbie</th>
                <th className="px-4 py-2 text-right font-semibold">Revenue Generated</th>
                <th className="px-4 py-2 text-right font-semibold">Margin Made</th>
                <th className="px-4 py-2 text-right font-semibold">Margin %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sub.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/subcontractors/${r.sub.id}`} className="font-medium text-blue-700 hover:underline">
                      {r.sub.company_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(r.totalPaidCents)}</td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(r.revenueCents)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${r.marginCents < 0 ? "text-red-600" : "text-green-700"}`}>
                    {formatCentsAsAud(r.marginCents)}
                  </td>
                  <td className="px-4 py-3 text-right">{r.marginPercent.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
