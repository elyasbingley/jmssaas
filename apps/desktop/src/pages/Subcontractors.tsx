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
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
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

// classes stays a Tailwind className string (its shape is relied on by
// ComplianceTrackerTab.tsx, out of scope for this retheme) - themed here via
// arbitrary-value classes reading the --jms-* custom properties (same
// pattern already used for hover states in JobDetail.tsx) rather than fixed
// hex, so a subcontractor's status pill still tracks the tenant's chosen
// accent/danger tokens instead of a hardcoded green/red/gray.
export const STATUS_BADGE: Record<SubcontractorStatus, { label: string; classes: string }> = {
  active: { label: "🟢 Up to date", classes: "border border-[var(--jms-accent)] bg-[var(--jms-accent-glow)] text-[var(--jms-accent)]" },
  inactive: { label: "Inactive", classes: "border border-[var(--jms-border)] text-[var(--jms-text-muted)]" },
  compliance_hold: { label: "🔴 Compliance Hold", classes: "border border-[var(--jms-danger)] text-[var(--jms-danger)]" },
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
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Subcontractors
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Manage subcontractor companies, compliance, preference tiers, and purchase orders.
      </p>

      <div className="mb-6 flex gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
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
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={
              tab === t.key
                ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { borderColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
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
          <ThemedFormField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company, contact, or phone" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
            <button
              key={trade}
              onClick={() => toggleTrade(trade)}
              className="rounded-full border px-3 py-1 text-xs font-semibold"
              style={
                tradeFilter.has(trade)
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
              }
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
              className="rounded-full border px-3 py-1 text-xs font-semibold"
              style={
                tierFilter === t
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
              }
            >
              Tier {t}
            </button>
          ))}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SubcontractorStatus | "")}
          className="rounded-md border px-3 py-1.5 text-sm"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)" }}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="compliance_hold">Compliance Hold</option>
          <option value="inactive">Inactive</option>
        </select>
        <ThemedButton onClick={openNew} className="ml-auto" style={{ paddingBlock: 6, paddingInline: 12 }}>
          + Add Subcontractor
        </ThemedButton>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No subcontractors match these filters.</p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filtered.map((sub) => {
            const contact = primaryContactBySub.get(sub.id);
            const jobCount = jobCountBySub.get(sub.id) ?? 0;
            return (
              <Link
                key={sub.id}
                to={`/subcontractors/${sub.id}`}
                className="rounded-lg p-4"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <p className="font-bold" style={{ color: "var(--jms-text)" }}>
                    {sub.company_name}
                  </p>
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)" }}
                  >
                    ⭐ Tier {sub.preference_tier}
                  </span>
                </div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {sub.trades.map((t) => (
                    <span
                      key={t}
                      className="rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)" }}
                    >
                      {TRADE_LABELS[t]}
                    </span>
                  ))}
                </div>
                {contact ? (
                  <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                    {contact.first_name} {contact.last_name ?? ""}
                  </p>
                ) : null}
                <div className="flex items-center justify-between pt-2 text-xs" style={{ borderTop: "1px solid var(--jms-border)" }}>
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_BADGE[sub.status].classes}`}>
                    {STATUS_BADGE[sub.status].label}
                  </span>
                  <span style={{ color: "var(--jms-text-muted)" }}>{jobCount} job(s) assigned</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title="New subcontractor company">
        <ThemedFormField label="Company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Apex Electrical Services" />
        <ThemedFormField label="ABN (optional)" value={abn} onChange={(e) => setAbn(e.target.value)} />

        <label className="mb-1 block font-semibold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Trades
        </label>
        <div className="mb-4 flex flex-wrap gap-1">
          {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
            <button
              key={trade}
              type="button"
              onClick={() => toggleFormTrade(trade)}
              className="rounded-full border px-3 py-1 text-xs font-semibold"
              style={
                trades.has(trade)
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
              }
            >
              {TRADE_LABELS[trade]}
            </button>
          ))}
        </div>

        <ThemedSelectField
          label="Preference tier"
          value={String(tier)}
          onChange={(v) => setTier(Number(v) || 3)}
          options={[1, 2, 3, 4, 5].map((t) => ({ value: String(t), label: TIER_LABELS[t] ?? String(t) }))}
        />
        <ThemedFormField label="Payment terms (days)" type="number" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        <ThemedTextAreaField label="Notes (optional)" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />

        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createSubcontractor.mutate()} disabled={createSubcontractor.isPending}>
            {createSubcontractor.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
