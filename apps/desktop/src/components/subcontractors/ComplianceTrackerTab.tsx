import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

function cellClasses(expiryDate: string | null): string {
  if (!expiryDate) return "text-gray-300";
  const days = daysUntil(expiryDate);
  if (days < 0) return "bg-red-50 text-red-700 font-semibold";
  if (days <= 30) return "bg-amber-50 text-amber-800 font-semibold";
  return "bg-green-50 text-green-700";
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
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => setHoldOnly((v) => !v)}
          className={`rounded-full px-3 py-1.5 text-sm font-semibold ${holdOnly ? "bg-red-600 text-white" : "bg-gray-100 text-gray-700"}`}
        >
          🔴 Compliance Hold only
        </button>
        <p className="text-xs text-gray-400">Red = expired · Amber = expiring within 30 days · Green = current · Blank = no doc on file</p>
      </div>

      {visibleSubs.length === 0 ? (
        <p className="text-sm text-gray-500">No subcontractors to show.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
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
                <tr key={sub.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900">{sub.company_name}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[sub.status].classes}`}>
                      {STATUS_BADGE[sub.status].label}
                    </span>
                  </td>
                  {DOC_TYPES.map((type) => {
                    const doc = docsBySub.get(sub.id)?.get(type);
                    return (
                      <td key={type} className={`px-4 py-3 ${cellClasses(doc?.expiry_date ?? null)}`}>
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
