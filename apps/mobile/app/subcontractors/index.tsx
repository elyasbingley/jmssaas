import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  createSubcontractorCompanySchema,
  type SubcontractorCompany,
  type SubcontractorComplianceDoc,
  type SubcontractorContact,
  type SubcontractorDocType,
  type SubcontractorStatus,
  type SubcontractorTrade,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useAuth } from "../../lib/auth-context";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../components/CenteredModal";
import { FormField } from "../../components/FormField";

// Mobile port of desktop's Subcontractors.tsx. Like Real Estate & Strata
// and Reports & Safety, none of subcontractor_companies/_contacts/
// _compliance_docs/purchase_orders are PowerSync tables - RLS is admin-only
// for writes (broad tenant-scoped read), so this is Supabase-direct and
// connectivity-gated, same pattern. The desktop "Financial Performance" tab
// (pure margin analytics, no workflow) isn't ported - same call the Real
// Estate module made dropping its own analytics dashboards - see
// docs/SETUP.md.

type SubTab = "directory" | "compliance";

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

export const STATUS_BADGE: Record<SubcontractorStatus, { bg: string; text: string; label: string }> = {
  active: { bg: "#dcfce7", text: "#15803d", label: "Up to date" },
  inactive: { bg: "#f3f4f6", text: "#6b7280", label: "Inactive" },
  compliance_hold: { bg: "#fee2e2", text: "#b91c1c", label: "Compliance Hold" },
};

const DOC_TYPE_LABELS: Record<SubcontractorDocType, string> = {
  public_liability: "Public Liability",
  workers_comp: "Workers Comp",
  trade_license: "Trade License",
  white_card: "White Card",
  safety_induction: "Safety Induction",
  other: "Other",
};

function daysUntil(dateString: string): number {
  const target = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function SubcontractorsScreen() {
  const isOnline = useIsOnline();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [tab, setTab] = useState<SubTab>("directory");

  const { data: subcontractors, refetch: refetchSubcontractors } = useSupabaseFetch<SubcontractorCompany[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("subcontractor_companies").select("*").order("preference_tier").order("company_name");
    if (error) throw error;
    return data as SubcontractorCompany[];
  }, [isOnline]);
  const { data: contacts } = useSupabaseFetch<SubcontractorContact[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("subcontractor_contacts").select("*");
    if (error) throw error;
    return data as SubcontractorContact[];
  }, [isOnline]);
  const { data: complianceDocs } = useSupabaseFetch<SubcontractorComplianceDoc[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("subcontractor_compliance_docs").select("*");
    if (error) throw error;
    return data as SubcontractorComplianceDoc[];
  }, [isOnline]);

  useRefetchOnFocus(refetchSubcontractors);

  if (!isOnline) {
    return <RequiresConnectionNotice label="Subcontractors" />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabRow}>
        {(
          [
            { key: "directory", label: "Directory" },
            { key: "compliance", label: "Compliance" },
          ] as { key: SubTab; label: string }[]
        ).map((t) => (
          <Pressable key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === "directory" ? (
        <DirectoryTab subcontractors={subcontractors ?? []} contacts={contacts ?? []} isAdmin={isAdmin} onCreated={refetchSubcontractors} />
      ) : (
        <ComplianceTab subcontractors={subcontractors ?? []} docs={complianceDocs ?? []} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Directory & Tier Board
// ---------------------------------------------------------------------------

function DirectoryTab({
  subcontractors,
  contacts,
  isAdmin,
  onCreated,
}: {
  subcontractors: SubcontractorCompany[];
  contacts: SubcontractorContact[];
  isAdmin: boolean;
  onCreated: () => void;
}) {
  const router = useRouter();
  const { profile } = useAuth();
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<number | null>(null);

  const primaryContactBySub = useMemo(() => {
    const map = new Map<string, SubcontractorContact>();
    for (const c of contacts) {
      if (c.is_primary_contact || !map.has(c.subcontractor_id)) map.set(c.subcontractor_id, c);
    }
    return map;
  }, [contacts]);

  const filtered = subcontractors.filter((s) => {
    if (tierFilter && s.preference_tier !== tierFilter) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      const contact = primaryContactBySub.get(s.id);
      const contactName = contact ? `${contact.first_name} ${contact.last_name ?? ""}`.toLowerCase() : "";
      if (!s.company_name.toLowerCase().includes(needle) && !contactName.includes(needle)) return false;
    }
    return true;
  });

  const [modalVisible, setModalVisible] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [abn, setAbn] = useState("");
  const [trades, setTrades] = useState<Set<SubcontractorTrade>>(new Set());
  const [tier, setTier] = useState(3);
  const [paymentTerms, setPaymentTerms] = useState("30");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setCompanyName("");
    setAbn("");
    setTrades(new Set());
    setTier(3);
    setPaymentTerms("30");
    setNotes("");
    setFormError(null);
    setModalVisible(true);
  };

  const toggleFormTrade = (trade: SubcontractorTrade) => {
    setTrades((prev) => {
      const next = new Set(prev);
      if (next.has(trade)) next.delete(trade);
      else next.add(trade);
      return next;
    });
  };

  const save = async () => {
    const result = createSubcontractorCompanySchema.safeParse({
      company_name: companyName,
      abn,
      trades: Array.from(trades),
      preference_tier: tier,
      payment_terms_days: Number(paymentTerms) || 30,
      notes,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid subcontractor");
      return;
    }
    if (!profile) return;
    setSaving(true);
    const { error } = await supabase.from("subcontractor_companies").insert({
      tenant_id: profile.tenant_id,
      company_name: result.data.company_name,
      abn: result.data.abn || null,
      trades: result.data.trades,
      preference_tier: result.data.preference_tier,
      payment_terms_days: result.data.payment_terms_days,
      notes: result.data.notes || null,
    });
    setSaving(false);
    if (error) {
      setFormError(getErrorMessage(error, "Failed to create subcontractor"));
      return;
    }
    setModalVisible(false);
    onCreated();
  };

  return (
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      <FormField label="Search" value={search} onChangeText={setSearch} placeholder="Search company or contact" />
      <View style={styles.tierFilterRow}>
        {[1, 2, 3, 4, 5].map((t) => (
          <Pressable
            key={t}
            style={[styles.tierChip, tierFilter === t && styles.tierChipActive]}
            onPress={() => setTierFilter(tierFilter === t ? null : t)}
          >
            <Text style={[styles.tierChipText, tierFilter === t && styles.tierChipTextActive]}>Tier {t}</Text>
          </Pressable>
        ))}
      </View>

      {isAdmin ? (
        <Pressable style={styles.primaryButton} onPress={openNew}>
          <Text style={styles.primaryButtonText}>+ Add Subcontractor</Text>
        </Pressable>
      ) : null}

      {filtered.length === 0 ? (
        <Text style={styles.empty}>No subcontractors match these filters.</Text>
      ) : (
        filtered.map((sub) => {
          const contact = primaryContactBySub.get(sub.id);
          const badge = STATUS_BADGE[sub.status];
          return (
            <Pressable key={sub.id} style={styles.subCard} onPress={() => router.push(`/subcontractors/${sub.id}`)}>
              <View style={styles.subCardHeader}>
                <Text style={styles.subCardName}>{sub.company_name}</Text>
                <View style={styles.tierBadge}>
                  <Text style={styles.tierBadgeText}>Tier {sub.preference_tier}</Text>
                </View>
              </View>
              {sub.trades.length > 0 ? (
                <View style={styles.tradeRow}>
                  {sub.trades.map((t) => (
                    <View key={t} style={styles.tradeChip}>
                      <Text style={styles.tradeChipText}>{TRADE_LABELS[t]}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {contact ? (
                <Text style={styles.subCardContact}>
                  {contact.first_name} {contact.last_name ?? ""}
                </Text>
              ) : null}
              <View style={[styles.statusBadge, { backgroundColor: badge.bg, alignSelf: "flex-start", marginTop: 6 }]}>
                <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
              </View>
            </Pressable>
          );
        })
      )}

      <CenteredModal visible={modalVisible} onClose={() => setModalVisible(false)}>
        <Text style={styles.modalTitle}>New subcontractor company</Text>
        <FormField label="Company name" value={companyName} onChangeText={setCompanyName} placeholder="e.g. Apex Electrical Services" />
        <FormField label="ABN (optional)" value={abn} onChangeText={setAbn} />
        <Text style={styles.fieldLabel}>Trades</Text>
        <View style={styles.tradeRow}>
          {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
            <Pressable
              key={trade}
              style={[styles.tradeChip, trades.has(trade) && styles.tradeChipActive]}
              onPress={() => toggleFormTrade(trade)}
            >
              <Text style={[styles.tradeChipText, trades.has(trade) && styles.tradeChipTextActive]}>{TRADE_LABELS[trade]}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.fieldLabel}>Preference tier</Text>
        <View style={styles.tierFilterRow}>
          {[1, 2, 3, 4, 5].map((t) => (
            <Pressable key={t} style={[styles.tierChip, tier === t && styles.tierChipActive]} onPress={() => setTier(t)}>
              <Text style={[styles.tierChipText, tier === t && styles.tierChipTextActive]}>Tier {t}</Text>
            </Pressable>
          ))}
        </View>
        <FormField label="Payment terms (days)" value={paymentTerms} onChangeText={setPaymentTerms} keyboardType="number-pad" />
        <FormField label="Notes (optional)" value={notes} onChangeText={setNotes} multiline style={styles.multiline} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={save} disabled={saving}>
            <Text style={styles.primaryButtonText}>{saving ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Compliance - a per-subcontractor card list (mobile-appropriate stand-in
// for desktop's wide subcontractor x doc-type matrix, which doesn't fit a
// phone screen), same red/amber/green expiry colouring.
// ---------------------------------------------------------------------------

function ComplianceTab({ subcontractors, docs }: { subcontractors: SubcontractorCompany[]; docs: SubcontractorComplianceDoc[] }) {
  const router = useRouter();
  const [holdOnly, setHoldOnly] = useState(false);

  const docsBySub = useMemo(() => {
    const map = new Map<string, Map<SubcontractorDocType, SubcontractorComplianceDoc>>();
    for (const doc of docs) {
      if (!map.has(doc.subcontractor_id)) map.set(doc.subcontractor_id, new Map());
      const existing = map.get(doc.subcontractor_id)!.get(doc.doc_type);
      if (!existing || doc.created_at > existing.created_at) {
        map.get(doc.subcontractor_id)!.set(doc.doc_type, doc);
      }
    }
    return map;
  }, [docs]);

  const visibleSubs = holdOnly ? subcontractors.filter((s) => s.status === "compliance_hold") : subcontractors;

  return (
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      <Pressable style={[styles.holdFilterChip, holdOnly && styles.holdFilterChipActive]} onPress={() => setHoldOnly((v) => !v)}>
        <Text style={[styles.holdFilterChipText, holdOnly && styles.holdFilterChipTextActive]}>Compliance Hold only</Text>
      </Pressable>
      <Text style={styles.legend}>Red = expired · Amber = expiring within 30 days · Green = current · Grey = no doc on file</Text>

      {visibleSubs.length === 0 ? (
        <Text style={styles.empty}>No subcontractors to show.</Text>
      ) : (
        visibleSubs.map((sub) => {
          const badge = STATUS_BADGE[sub.status];
          const subDocs = docsBySub.get(sub.id);
          return (
            <Pressable key={sub.id} style={styles.subCard} onPress={() => router.push(`/subcontractors/${sub.id}`)}>
              <View style={styles.subCardHeader}>
                <Text style={styles.subCardName}>{sub.company_name}</Text>
                <View style={[styles.statusBadge, { backgroundColor: badge.bg }]}>
                  <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
                </View>
              </View>
              <View style={styles.docGrid}>
                {(Object.keys(DOC_TYPE_LABELS) as SubcontractorDocType[]).map((type) => {
                  const doc = subDocs?.get(type);
                  const expiry = doc?.expiry_date ?? null;
                  const days = expiry ? daysUntil(expiry) : null;
                  const colors =
                    days == null ? (doc ? { bg: "#f9fafb", text: "#9ca3af" } : { bg: "#f3f4f6", text: "#d1d5db" }) :
                    days < 0 ? { bg: "#fee2e2", text: "#b91c1c" } :
                    days <= 30 ? { bg: "#fef9c3", text: "#854d0e" } :
                    { bg: "#dcfce7", text: "#15803d" };
                  return (
                    <View key={type} style={[styles.docCell, { backgroundColor: colors.bg }]}>
                      <Text style={styles.docCellLabel}>{DOC_TYPE_LABELS[type]}</Text>
                      <Text style={[styles.docCellValue, { color: colors.text }]}>
                        {expiry ? new Date(`${expiry}T00:00:00`).toLocaleDateString("en-AU") : doc ? "No expiry" : "-"}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  tabRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#d1d5db" },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: "#1d4ed8" },
  tabText: { fontSize: 13, fontWeight: "600", color: "#6b7280" },
  tabTextActive: { color: "#1d4ed8" },
  tabBody: { flex: 1, padding: 16 },
  error: { color: "#dc2626", marginTop: 8 },
  empty: { color: "#6b7280", textAlign: "center", marginTop: 16 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginTop: 10, marginBottom: 6 },
  multiline: { minHeight: 60, textAlignVertical: "top" },

  tierFilterRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10, marginBottom: 4 },
  tierChip: { backgroundColor: "#f3f4f6", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  tierChipActive: { backgroundColor: "#f59e0b" },
  tierChipText: { fontSize: 12, fontWeight: "600", color: "#374151" },
  tierChipTextActive: { color: "#fff" },

  tradeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  tradeChip: { backgroundColor: "#f3f4f6", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  tradeChipActive: { backgroundColor: "#1d4ed8" },
  tradeChipText: { fontSize: 11, fontWeight: "600", color: "#374151" },
  tradeChipTextActive: { color: "#fff" },

  primaryButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center", marginVertical: 12 },
  primaryButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  subCard: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, padding: 14, marginBottom: 10, backgroundColor: "#fff" },
  subCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  subCardName: { fontSize: 15, fontWeight: "700", color: "#111827", flex: 1 },
  subCardContact: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  tierBadge: { backgroundColor: "#fef3c7", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  tierBadgeText: { fontSize: 11, fontWeight: "700", color: "#92400e" },
  statusBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },

  holdFilterChip: { alignSelf: "flex-start", backgroundColor: "#f3f4f6", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 8 },
  holdFilterChipActive: { backgroundColor: "#dc2626" },
  holdFilterChipText: { fontSize: 12, fontWeight: "700", color: "#374151" },
  holdFilterChipTextActive: { color: "#fff" },
  legend: { fontSize: 11, color: "#9ca3af", marginBottom: 12 },
  docGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  docCell: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, minWidth: 100 },
  docCellLabel: { fontSize: 10, color: "#6b7280", fontWeight: "600" },
  docCellValue: { fontSize: 11, fontWeight: "700", marginTop: 2 },

  modalTitle: { fontSize: 17, fontWeight: "700" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 16, marginTop: 4 },
});
