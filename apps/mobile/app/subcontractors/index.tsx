import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ThemeTokens } from "@jmssaas/shared";
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
import { useTheme } from "../../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedButton } from "../../components/theme/ThemedButton";

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

export function getStatusBadge(tokens: ThemeTokens): Record<SubcontractorStatus, { bg: string; border: string; text: string; label: string }> {
  return {
    active: { bg: tokens.accentGlow, border: tokens.accent, text: tokens.accent, label: "Up to date" },
    inactive: { bg: tokens.surface, border: tokens.border, text: tokens.textMuted, label: "Inactive" },
    compliance_hold: { bg: tokens.surface, border: tokens.danger, text: tokens.danger, label: "Compliance Hold" },
  };
}

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
  const router = useRouter();
  const isOnline = useIsOnline();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [tab, setTab] = useState<SubTab>("directory");
  const styles = useThemedStyles(createStyles);

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

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Subcontractors</Text>
      </View>

      {!isOnline ? (
        <ThemedRequiresConnectionNotice label="Subcontractors" />
      ) : (
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
      )}
    </SafeAreaView>
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
  const { tokens } = useTheme();
  const styles = useThemedStyles(createStyles);
  const statusBadge = getStatusBadge(tokens);
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
      <ThemedFormField label="Search" value={search} onChangeText={setSearch} placeholder="Search company or contact" />
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
        <View style={{ marginVertical: 12 }}>
          <ThemedButton label="+ Add Subcontractor" onPress={openNew} />
        </View>
      ) : null}

      {filtered.length === 0 ? (
        <Text style={styles.empty}>No subcontractors match these filters.</Text>
      ) : (
        filtered.map((sub) => {
          const contact = primaryContactBySub.get(sub.id);
          const badge = statusBadge[sub.status];
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
              <View style={[styles.statusBadge, { backgroundColor: badge.bg, borderColor: badge.border, alignSelf: "flex-start", marginTop: 6 }]}>
                <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
              </View>
            </Pressable>
          );
        })
      )}

      <ThemedModal visible={modalVisible} onClose={() => setModalVisible(false)}>
        <Text style={styles.modalTitle}>New subcontractor company</Text>
        <ThemedFormField label="Company name" value={companyName} onChangeText={setCompanyName} placeholder="e.g. Apex Electrical Services" />
        <ThemedFormField label="ABN (optional)" value={abn} onChangeText={setAbn} />
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
        <ThemedFormField label="Payment terms (days)" value={paymentTerms} onChangeText={setPaymentTerms} keyboardType="number-pad" />
        <ThemedFormField label="Notes (optional)" value={notes} onChangeText={setNotes} multiline style={styles.multiline} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={saving ? "Saving..." : "Save"} onPress={save} disabled={saving} />
        </View>
      </ThemedModal>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Compliance - a per-subcontractor card list (mobile-appropriate stand-in
// for desktop's wide subcontractor x doc-type matrix, which doesn't fit a
// phone screen), same expired/expiring/current/no-doc colouring mapped onto
// theme tokens (danger/warning/accent/muted) instead of light-mode hexes.
// ---------------------------------------------------------------------------

function ComplianceTab({ subcontractors, docs }: { subcontractors: SubcontractorCompany[]; docs: SubcontractorComplianceDoc[] }) {
  const router = useRouter();
  const { tokens } = useTheme();
  const styles = useThemedStyles(createStyles);
  const statusBadge = getStatusBadge(tokens);
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
          const badge = statusBadge[sub.status];
          const subDocs = docsBySub.get(sub.id);
          return (
            <Pressable key={sub.id} style={styles.subCard} onPress={() => router.push(`/subcontractors/${sub.id}`)}>
              <View style={styles.subCardHeader}>
                <Text style={styles.subCardName}>{sub.company_name}</Text>
                <View style={[styles.statusBadge, { backgroundColor: badge.bg, borderColor: badge.border }]}>
                  <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
                </View>
              </View>
              <View style={styles.docGrid}>
                {(Object.keys(DOC_TYPE_LABELS) as SubcontractorDocType[]).map((type) => {
                  const doc = subDocs?.get(type);
                  const expiry = doc?.expiry_date ?? null;
                  const days = expiry ? daysUntil(expiry) : null;
                  const color =
                    days == null ? tokens.textMuted :
                    days < 0 ? tokens.danger :
                    days <= 30 ? tokens.warning :
                    tokens.accent;
                  return (
                    <View key={type} style={[styles.docCell, { borderColor: color }]}>
                      <Text style={styles.docCellLabel}>{DOC_TYPE_LABELS[type]}</Text>
                      <Text style={[styles.docCellValue, { color }]}>
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

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    title: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary },
    container: { flex: 1, backgroundColor: tokens.background },
    tabRow: { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: tokens.border },
    tab: { flex: 1, paddingVertical: 12, alignItems: "center" as const, borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabActive: { borderBottomColor: tokens.accent },
    tabText: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted, textTransform: "uppercase" as const },
    tabTextActive: { color: tokens.accent },
    tabBody: { flex: 1, padding: 16 },
    error: { ...mono, color: tokens.danger, marginTop: 8, fontSize: font.body },
    empty: { ...mono, color: tokens.textMuted, textAlign: "center" as const, marginTop: 16, fontSize: font.body },
    link: { ...mono, color: tokens.accent, fontWeight: "600" as const, fontSize: font.body },
    fieldLabel: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, marginTop: 10, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: 1 },
    multiline: { minHeight: 60, textAlignVertical: "top" as const },

    tierFilterRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 10, marginBottom: 4 },
    tierChip: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 5 },
    tierChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    tierChipText: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted },
    tierChipTextActive: { color: tokens.accent },

    tradeRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginBottom: 6 },
    tradeChip: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 5 },
    tradeChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    tradeChipText: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted },
    tradeChipTextActive: { color: tokens.accent },

    subCard: { borderWidth: 1, borderColor: tokens.border, borderRadius: 4, padding: 14, marginBottom: 10, backgroundColor: tokens.surface },
    subCardHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "flex-start" as const, gap: 8 },
    subCardName: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, flex: 1 },
    subCardContact: { ...mono, fontSize: font.label, color: tokens.textMuted, marginTop: 2 },
    tierBadge: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
    tierBadgeText: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted },
    statusBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
    statusBadgeText: { ...mono, fontSize: font.label, fontWeight: "700" as const },

    holdFilterChip: { alignSelf: "flex-start" as const, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 8 },
    holdFilterChipActive: { borderColor: tokens.danger, backgroundColor: tokens.surface },
    holdFilterChipText: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted },
    holdFilterChipTextActive: { color: tokens.danger },
    legend: { ...mono, fontSize: font.label, color: tokens.textMuted, marginBottom: 12 },
    docGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 8 },
    docCell: { borderWidth: 1, borderRadius: 4, backgroundColor: tokens.surface, paddingHorizontal: 8, paddingVertical: 6, minWidth: 100 },
    docCellLabel: { ...mono, fontSize: font.label, color: tokens.textMuted, fontWeight: "600" as const },
    docCellValue: { ...mono, fontSize: font.label, fontWeight: "700" as const, marginTop: 2 },

    modalTitle: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 16, marginTop: 4 },
  };
}
