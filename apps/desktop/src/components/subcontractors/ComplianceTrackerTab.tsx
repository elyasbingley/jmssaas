import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { SubcontractorComplianceDoc, SubcontractorCompany, SubcontractorDocType } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { STATUS_BADGE } from "../../pages/Subcontractors";

// Sub-tab 2: matrix view of every subcontractor x every compliance doc
// type, coloured by expiry status. "Required" here just means every
// doc_type this schema knows about, shown as a column even when a given
// subcontractor has never uploaded one for it (blank cell) - the spec's
// own wording ("all required documentation") doesn't distinguish which
// doc_types are mandatory vs optional per subcontractor, so this shows
// the full matrix rather than guessing at a per-trade requirement list.

const DOC_TYPES: SubcontractorDocType[] = ["public_liability", "workers_comp", "trade_license", "white_card", "safety_induction", "other"];
const DOC_TYPE_LABELS: Record<SubcontractorDocType, string> = {
  public_liability: "Public Liability",
  workers_comp: "Workers Comp",
  trade_license: "Trade License",
  white_card: "White Card",
  safety_induction: "Safety Induction",
  other: "Other",
};

async function fetchAllComplianceDocs(): Promise<SubcontractorComplianceDoc[]> {
  const { data, error } = await supabase.from("subcontractor_compliance_docs").select("*");
  if (error) throw error;
  return data as SubcontractorComplianceDoc[];
}

function daysUntil(dateString: string): number {
  const target = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// Theme colours: danger = expired, warning = expiring within 30 days,
// accent = current, muted = no doc on file.
function cellStyle(expiryDate: string | null): React.CSSProperties {
  if (!expiryDate) return { color: "var(--jms-text-muted)" };
  const days = daysUntil(expiryDate);
  if (days < 0) return { color: "var(--jms-danger)", fontWeight: 600 };
  if (days <= 30) return { color: "var(--jms-warning)", fontWeight: 600 };
  return { color: "var(--jms-accent)" };
}

export function ComplianceTrackerTab({ subcontractors }: { subcontractors: SubcontractorCompany[] }) {
  const { data: docs } = useQuery({ queryKey: ["subcontractor-compliance-docs", "all"], queryFn: fetchAllComplianceDocs });
  const [holdOnly, setHoldOnly] = useState(false);

  const docsBySub = useMemo(() => {
    const map = new Map<string, Map<SubcontractorDocType, SubcontractorComplianceDoc>>();
    for (const doc of docs ?? []) {
      if (!map.has(doc.subcontractor_id)) map.set(doc.subcontractor_id, new Map());
      // Latest doc of a given type wins the cell if more than one exists.
      const existing = map.get(doc.subcontractor_id)!.get(doc.doc_type);
      if (!existing || doc.created_at > existing.created_at) {
        map.get(doc.subcontractor_id)!.set(doc.doc_type, doc);
      }
    }
    return map;
  }, [docs]);

  const visibleSubs = holdOnly ? subcontractors.filter((s) => s.status === "compliance_hold") : subcontractors;

  return (
    <div style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setHoldOnly((v) => !v)}
          className="rounded-full border px-3 py-1.5 font-semibold"
          style={
            holdOnly
              ? { borderColor: "var(--jms-danger)", color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }
              : { borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }
          }
        >
          🔴 Compliance Hold only
        </button>
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          <span style={{ color: "var(--jms-danger)" }}>Red</span> = expired · <span style={{ color: "var(--jms-warning)" }}>Amber</span> = expiring within 30 days ·{" "}
          <span style={{ color: "var(--jms-accent)" }}>Green</span> = current · Blank = no doc on file
        </p>
      </div>

      {visibleSubs.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No subcontractors to show.</p>
      ) : (
        <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Subcontractor</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                {DOC_TYPES.map((type) => (
                  <th key={type} className="px-4 py-2 font-semibold">
                    {DOC_TYPE_LABELS[type]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleSubs.map((sub) => (
                <tr key={sub.id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/subcontractors/${sub.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                      {sub.company_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 font-semibold ${STATUS_BADGE[sub.status].classes}`} style={{ fontSize: "var(--jms-font-label)" }}>
                      {STATUS_BADGE[sub.status].label}
                    </span>
                  </td>
                  {DOC_TYPES.map((type) => {
                    const doc = docsBySub.get(sub.id)?.get(type);
                    return (
                      <td key={type} className="whitespace-nowrap px-4 py-3" style={cellStyle(doc?.expiry_date ?? null)}>
                        {doc?.expiry_date ? new Date(`${doc.expiry_date}T00:00:00`).toLocaleDateString("en-AU") : doc ? "No expiry" : "-"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
