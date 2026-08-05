import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  createSubcontractorCompanySchema,
  type PurchaseOrder,
  type SubcontractorCompany,
  type SubcontractorContact,
  type SubcontractorStatus,
  type SubcontractorTrade,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField, TextAreaField } from "../components/FormField";
import { ComplianceTrackerTab } from "../components/subcontractors/ComplianceTrackerTab";
import { FinancialPerformanceTab } from "../components/subcontractors/FinancialPerformanceTab";

// The three sub-tabs from the spec live under a single sidebar destination
// (/subcontractors), same "one sidebar destination, several in-page tabs"
// relationship every other multi-tab module in this app already uses.

type SubTab = "directory" | "compliance" | "financial";

export const TRADE_LABELS: Record<SubcontractorTrade, string> = {
  plumber: "Plumber",
  roofer: "Roofer",
  electrician: "Electrician",
  hvac: "HVAC",
  painter: "Painter",
  carpenter: "Carpenter",
  plasterer: "Plasterer",
  cleaner: "Cleaner",
  other: "Other",
};

export const TIER_LABELS: Record<number, string> = {
  1: "Tier 1 - Preferred",
  2: "Tier 2",
  3: "Tier 3",
  4: "Tier 4",
  5: "Tier 5 - Last Resort",
};

export const STATUS_BADGE: Record<SubcontractorStatus, { label: string; classes: string }> = {
  active: { label: "🟢 Up to date", classes: "bg-green-50 text-green-700" },
  inactive: { label: "Inactive", classes: "bg-gray-100 text-gray-500" },
  compliance_hold: { label: "🔴 Compliance Hold", classes: "bg-red-50 text-red-700" },
};

async function fetchSubcontractors(): Promise<SubcontractorCompany[]> {
  const { data, error } = await supabase.from("subcontractor_companies").select("*").order("preference_tier").order("company_name");
  if (error) throw error;
  return data as SubcontractorCompany[];
}
async function fetchContacts(): Promise<SubcontractorContact[]> {
  const { data, error } = await supabase.from("subcontractor_contacts").select("*");
  if (error) throw error;
  return data as SubcontractorContact[];
}
async function fetchPurchaseOrders(): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase.from("purchase_orders").select("*");
  if (error) throw error;
  return data as PurchaseOrder[];
}

export default function SubcontractorsPage() {
  const [tab, setTab] = useState<SubTab>("directory");

  const { data: subcontractors } = useQuery({ queryKey: ["subcontractors"], queryFn: fetchSubcontractors });
  const { data: contacts } = useQuery({ queryKey: ["subcontractor-contacts"], queryFn: fetchContacts });
  const { data: purchaseOrders } = useQuery({ queryKey: ["purchase-orders"], queryFn: fetchPurchaseOrders });

  return (
    <div className="p-8">
      <h1 className="mb-1 text-xl font-bold text-gray-900">Subcontractors</h1>
      <p className="mb-6 text-sm text-gray-500">Manage subcontractor companies, compliance, preference tiers, and purchase orders.</p>

      <div className="mb-6 flex gap-1 border-b border-gray-200">
        {(
          [
            { key: "directory", label: "Directory & Tier Board" },
            { key: "compliance", label: "Compliance Tracker" },
            { key: "financial", label: "Financial Performance" },
          ] as { key: SubTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-4 py-2 text-sm font-semibold ${
              tab === t.key ? "border-blue-700 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "directory" ? (
        <DirectoryTab subcontractors={subcontractors ?? []} contacts={contacts ?? []} purchaseOrders={purchaseOrders ?? []} />
      ) : tab === "compliance" ? (
        <ComplianceTrackerTab subcontractors={subcontractors ?? []} />
      ) : (
        <FinancialPerformanceTab subcontractors={subcontractors ?? []} purchaseOrders={purchaseOrders ?? []} />
      )}
    </div>
  );
}

function DirectoryTab({
  subcontractors,
  contacts,
  purchaseOrders,
}: {
  subcontractors: SubcontractorCompany[];
  contacts: SubcontractorContact[];
  purchaseOrders: PurchaseOrder[];
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [tradeFilter, setTradeFilter] = useState<Set<SubcontractorTrade>>(new Set());
  const [tierFilter, setTierFilter] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<SubcontractorStatus | "">("");

  const toggleTrade = (trade: SubcontractorTrade) => {
    setTradeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(trade)) next.delete(trade);
      else next.add(trade);
      return next;
    });
  };

  const primaryContactBySub = useMemo(() => {
    const map = new Map<string, SubcontractorContact>();
    for (const c of contacts) {
      if (c.is_primary_contact || !map.has(c.subcontractor_id)) map.set(c.subcontractor_id, c);
    }
    return map;
  }, [contacts]);

  const jobCountBySub = useMemo(() => {
    const map = new Map<string, number>();
    for (const po of purchaseOrders) {
      map.set(po.subcontractor_id, (map.get(po.subcontractor_id) ?? 0) + 1);
    }
    return map;
  }, [purchaseOrders]);

  const filtered = subcontractors.filter((s) => {
    if (tradeFilter.size > 0 && !s.trades.some((t) => tradeFilter.has(t))) return false;
    if (tierFilter && s.preference_tier !== tierFilter) return false;
    if (statusFilter && s.status !== statusFilter) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      const contact = primaryContactBySub.get(s.id);
      const contactName = contact ? `${contact.first_name} ${contact.last_name ?? ""}`.toLowerCase() : "";
      const contactPhone = contact?.mobile ?? contact?.work_phone ?? "";
      if (!s.company_name.toLowerCase().includes(needle) && !contactName.includes(needle) && !contactPhone.includes(needle)) return false;
    }
    return true;
  });

  // --- Add Subcontractor Company ---
  const [modalOpen, setModalOpen] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [abn, setAbn] = useState("");
  const [trades, setTrades] = useState<Set<SubcontractorTrade>>(new Set());
  const [tier, setTier] = useState(3);
  const [paymentTerms, setPaymentTerms] = useState("30");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setCompanyName("");
    setAbn("");
    setTrades(new Set());
    setTier(3);
    setPaymentTerms("30");
    setNotes("");
    setFormError(null);
    setModalOpen(true);
  };

  const toggleFormTrade = (trade: SubcontractorTrade) => {
    setTrades((prev) => {
      const next = new Set(prev);
      if (next.has(trade)) next.delete(trade);
      else next.add(trade);
      return next;
    });
  };

  const createSubcontractor = useMutation({
    mutationFn: async () => {
      const result = createSubcontractorCompanySchema.safeParse({
        company_name: companyName,
        abn,
        trades: Array.from(trades),
        preference_tier: tier,
        payment_terms_days: Number(paymentTerms) || 30,
        notes,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid subcontractor");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("subcontractor_companies").insert({
        tenant_id: profile.tenant_id,
        company_name: result.data.company_name,
        abn: result.data.abn || null,
        trades: result.data.trades,
        preference_tier: result.data.preference_tier,
        payment_terms_days: result.data.payment_terms_days,
        notes: result.data.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subcontractors"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create subcontractor")),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-64">
          <FormField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company, contact, or phone" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
            <button
              key={trade}
              onClick={() => toggleTrade(trade)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                tradeFilter.has(trade) ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {TRADE_LABELS[trade]}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((t) => (
            <button
              key={t}
              onClick={() => setTierFilter(tierFilter === t ? null : t)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                tierFilter === t ? "bg-amber-500 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              Tier {t}
            </button>
          ))}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SubcontractorStatus | "")}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="compliance_hold">Compliance Hold</option>
          <option value="inactive">Inactive</option>
        </select>
        <button onClick={openNew} className="ml-auto rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
          + Add Subcontractor
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500">No subcontractors match these filters.</p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filtered.map((sub) => {
            const contact = primaryContactBySub.get(sub.id);
            const jobCount = jobCountBySub.get(sub.id) ?? 0;
            return (
              <Link
                key={sub.id}
                to={`/subcontractors/${sub.id}`}
                className="rounded-lg border border-gray-200 bg-white p-4 hover:border-blue-400 hover:shadow-sm"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <p className="font-bold text-gray-900">{sub.company_name}</p>
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    ⭐ Tier {sub.preference_tier}
                  </span>
                </div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {sub.trades.map((t) => (
                    <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {TRADE_LABELS[t]}
                    </span>
                  ))}
                </div>
                {contact ? (
                  <p className="mb-2 text-sm text-gray-600">
                    {contact.first_name} {contact.last_name ?? ""}
                  </p>
                ) : null}
                <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_BADGE[sub.status].classes}`}>
                    {STATUS_BADGE[sub.status].label}
                  </span>
                  <span className="text-gray-400">{jobCount} job(s) assigned</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New subcontractor company">
        <FormField label="Company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Apex Electrical Services" />
        <FormField label="ABN (optional)" value={abn} onChange={(e) => setAbn(e.target.value)} />

        <label className="mb-1 block text-sm font-semibold text-gray-700">Trades</label>
        <div className="mb-4 flex flex-wrap gap-1">
          {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
            <button
              key={trade}
              type="button"
              onClick={() => toggleFormTrade(trade)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                trades.has(trade) ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {TRADE_LABELS[trade]}
            </button>
          ))}
        </div>

        <SelectField
          label="Preference tier"
          value={String(tier)}
          onChange={(v) => setTier(Number(v) || 3)}
          options={[1, 2, 3, 4, 5].map((t) => ({ value: String(t), label: TIER_LABELS[t] ?? String(t) }))}
        />
        <FormField label="Payment terms (days)" type="number" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        <TextAreaField label="Notes (optional)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />

        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createSubcontractor.mutate()}
            disabled={createSubcontractor.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createSubcontractor.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
