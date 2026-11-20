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

  const tile = (label: string, cents: number, tone?: string) => (
    <div className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 0 12px var(--jms-accent-glow)" }}>
      <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {label}
      </p>
      <p className="mt-1 font-bold" style={{ color: tone ?? "var(--jms-text)", fontSize: "calc(var(--jms-font-body) * 1.6)" }}>
        {formatCentsAsAud(cents)}
      </p>
    </div>
  );
  const marginColor = (cents: number) => (cents < 0 ? "var(--jms-danger)" : "var(--jms-accent)");

  return (
    <div style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {tile("Total Paid To Subbies", totals.paid)}
        {tile("Total Revenue Generated", totals.revenue)}
        {tile("Total Margin Made", totals.margin, rows.length ? marginColor(totals.margin) : undefined)}
      </div>

      {rows.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No purchase orders yet.</p>
      ) : (
        <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
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
                <tr key={r.sub.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-3">
                    <Link to={`/subcontractors/${r.sub.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-accent)" }}>
                      {r.sub.company_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(r.totalPaidCents)}</td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(r.revenueCents)}</td>
                  <td className="px-4 py-3 text-right font-semibold" style={{ color: marginColor(r.marginCents) }}>
                    {formatCentsAsAud(r.marginCents)}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text-muted)" }}>{r.marginPercent.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
