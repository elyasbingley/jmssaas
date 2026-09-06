import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@powersync/react";
import {
  createReferralGroupSchema,
  createReferralPartnerSchema,
  createReciprocityLogSchema,
  formatCentsAsAud,
  type ReferralGroup,
  type ReferralGroupType,
  type ReferralPartner,
  type ReferralPartnerTier,
  type ReferralPartnerType,
  type ReferralReciprocityLog,
  type ReferralRewardType,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useAuth } from "../../lib/auth-context";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../components/CenteredModal";
import { PickerModal } from "../../components/PickerModal";
import { FormField } from "../../components/FormField";

// Mobile port of desktop's B2BReferrals.tsx. referral_groups/referral_
// partners/referral_reciprocity_logs aren't PowerSync tables (RLS is
// admin-only for writes, broad tenant-scoped for reads - same shape as
// Real Estate/Reports/Subcontractors), so this screen is Supabase-direct
// and connectivity-gated. job_cards.referral_partner_id/referral_fee_paid/
// referral_fee_amount_cents ARE PowerSync columns (added to schema.ts's
// existing job_cards Table - sync rules already select * from job_cards,
// so no sync-rules.yaml change was needed), so "referrals sent"/"closed
// revenue won" figures read the local synced copy and work offline; only
// the invoice side of that join (paid status/total/paid_at) needs
// connectivity, same "office data" treatment as everywhere else invoices
// are read from mobile.
//
// Desktop's "Revenue Analytics & BNI TYFCB" (pure export/reporting tool)
// and "Automated Partner Workflows" (a narrow duplicate of the existing
// Automation & Messaging settings screen) tabs aren't ported - same call
// the Real Estate and Subcontractor modules made dropping their own
// analytics-only tabs. See docs/SETUP.md.

type SubTab = "directory" | "reciprocity";

export function partnerDisplayName(p: ReferralPartner): string {
  const name = [p.contact_first_name, p.contact_last_name].filter(Boolean).join(" ");
  return p.company_name ? `${p.company_name} (${name})` : name;
}

const GROUP_TYPE_OPTIONS: { value: ReferralGroupType; label: string }[] = [
  { value: "bni_chapter", label: "BNI Chapter" },
  { value: "networking_group", label: "Networking Group" },
  { value: "trade_association", label: "Trade Association" },
  { value: "corporate_network", label: "Corporate Network" },
];
const PARTNER_TYPE_OPTIONS: { value: ReferralPartnerType; label: string }[] = [
  { value: "bni_member", label: "BNI Member" },
  { value: "real_estate_agent", label: "Real Estate Agent" },
  { value: "builder_contractor", label: "Builder / Contractor" },
  { value: "architect", label: "Architect" },
  { value: "insurance_adjuster", label: "Insurance Adjuster" },
  { value: "existing_client", label: "Existing Client" },
  { value: "other_b2b", label: "Other B2B" },
];
const TIER_OPTIONS: { value: ReferralPartnerTier; label: string }[] = [
  { value: "bronze", label: "Bronze" },
  { value: "silver", label: "Silver" },
  { value: "gold", label: "Gold" },
  { value: "vip", label: "VIP" },
];
const REWARD_TYPE_OPTIONS: { value: ReferralRewardType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "commission_percent", label: "Commission %" },
  { value: "flat_fee", label: "Flat fee" },
  { value: "gift_card", label: "Gift card" },
];
export const TIER_BADGE_COLORS: Record<ReferralPartnerTier, { bg: string; text: string }> = {
  bronze: { bg: "#fef3c7", text: "#92400e" },
  silver: { bg: "#f3f4f6", text: "#374151" },
  gold: { bg: "#fef9c3", text: "#854d0e" },
  vip: { bg: "#f3e8ff", text: "#6b21a8" },
};

interface ReferredJob {
  id: string;
  referral_partner_id: string | null;
  referral_fee_amount_cents: number | null;
  referral_fee_paid: number | null;
  lifecycle_stage_id: string | null;
}
interface ReferralInvoiceRow {
  id: string;
  job_card_id: string | null;
  status: string;
  total_cents: number;
  paid_at: string | null;
}

function inboundCentsForPartner(partnerId: string, referredJobs: ReferredJob[], referralInvoices: ReferralInvoiceRow[]): number {
  const jobIds = new Set(referredJobs.filter((j) => j.referral_partner_id === partnerId).map((j) => j.id));
  return referralInvoices
    .filter((inv) => inv.status === "paid" && inv.job_card_id && jobIds.has(inv.job_card_id))
    .reduce((sum, inv) => sum + inv.total_cents, 0);
}

export default function B2BReferralsScreen() {
  const isOnline = useIsOnline();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [tab, setTab] = useState<SubTab>("directory");

  const { data: groups, refetch: refetchGroups } = useSupabaseFetch<ReferralGroup[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_groups").select("*").order("name");
    if (error) throw error;
    return data as ReferralGroup[];
  }, [isOnline]);
  const { data: partners, refetch: refetchPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);
  const { data: reciprocityLogs, refetch: refetchLogs } = useSupabaseFetch<ReferralReciprocityLog[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_reciprocity_logs").select("*").order("date_passed", { ascending: false });
    if (error) throw error;
    return data as ReferralReciprocityLog[];
  }, [isOnline]);
  const { data: referralInvoices } = useSupabaseFetch<ReferralInvoiceRow[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("invoices").select("id, job_card_id, status, total_cents, paid_at").not("job_card_id", "is", null);
    if (error) throw error;
    return data as ReferralInvoiceRow[];
  }, [isOnline]);

  useRefetchOnFocus(async () => {
    await Promise.all([refetchGroups(), refetchPartners(), refetchLogs()]);
  });

  const { data: referredJobRows } = useQuery<ReferredJob>(
    "SELECT id, referral_partner_id, referral_fee_amount_cents, referral_fee_paid, lifecycle_stage_id FROM job_cards WHERE referral_partner_id IS NOT NULL"
  );

  if (!isOnline) {
    return <RequiresConnectionNotice label="B2B & Referrals" />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabRow}>
        {(
          [
            { key: "directory", label: "Directory" },
            { key: "reciprocity", label: "Reciprocity Ledger" },
          ] as { key: SubTab; label: string }[]
        ).map((t) => (
          <Pressable key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === "directory" ? (
        <DirectoryTab
          groups={groups ?? []}
          partners={partners ?? []}
          referredJobs={referredJobRows}
          referralInvoices={referralInvoices ?? []}
          reciprocityLogs={reciprocityLogs ?? []}
          isAdmin={isAdmin}
          onGroupsChanged={refetchGroups}
          onPartnersChanged={refetchPartners}
          onLogsChanged={refetchLogs}
        />
      ) : (
        <ReciprocityLedgerTab
          partners={partners ?? []}
          referredJobs={referredJobRows}
          referralInvoices={referralInvoices ?? []}
          reciprocityLogs={reciprocityLogs ?? []}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

function DirectoryTab({
  groups,
  partners,
  referredJobs,
  referralInvoices,
  reciprocityLogs,
  isAdmin,
  onGroupsChanged,
  onPartnersChanged,
  onLogsChanged,
}: {
  groups: ReferralGroup[];
  partners: ReferralPartner[];
  referredJobs: ReferredJob[];
  referralInvoices: ReferralInvoiceRow[];
  reciprocityLogs: ReferralReciprocityLog[];
  isAdmin: boolean;
  onGroupsChanged: () => void;
  onPartnersChanged: () => void;
  onLogsChanged: () => void;
}) {
  const { profile } = useAuth();
  const [view, setView] = useState<"partner" | "group">("partner");
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const partnersByGroup = (groupId: string) => partners.filter((p) => p.group_id === groupId);
  const ungroupedPartners = partners.filter((p) => !p.group_id);

  const referralsSentByPartner = useMemo(() => {
    const map = new Map<string, number>();
    for (const job of referredJobs) {
      if (!job.referral_partner_id) continue;
      map.set(job.referral_partner_id, (map.get(job.referral_partner_id) ?? 0) + 1);
    }
    return map;
  }, [referredJobs]);
  const outboundByPartner = useMemo(() => {
    const map = new Map<string, number>();
    for (const log of reciprocityLogs) {
      map.set(log.partner_id, (map.get(log.partner_id) ?? 0) + (log.estimated_value_cents ?? 0));
    }
    return map;
  }, [reciprocityLogs]);

  // --- Add Group ---
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupType, setGroupType] = useState<ReferralGroupType>("networking_group");
  const [groupTypePickerVisible, setGroupTypePickerVisible] = useState(false);
  const [meetingDay, setMeetingDay] = useState("");
  const [groupNotes, setGroupNotes] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);

  const openNewGroup = () => {
    setGroupName("");
    setGroupType("networking_group");
    setMeetingDay("");
    setGroupNotes("");
    setGroupError(null);
    setGroupModalVisible(true);
  };

  const saveGroup = async () => {
    const result = createReferralGroupSchema.safeParse({ name: groupName, group_type: groupType, meeting_day: meetingDay, notes: groupNotes });
    if (!result.success) {
      setGroupError(result.error.issues[0]?.message ?? "Invalid group");
      return;
    }
    if (!profile) return;
    setGroupSaving(true);
    try {
      const { error } = await supabase.from("referral_groups").insert({
        tenant_id: profile.tenant_id,
        name: result.data.name,
        group_type: result.data.group_type,
        meeting_day: result.data.meeting_day || null,
        notes: result.data.notes || null,
      });
      if (error) {
        setGroupError(getErrorMessage(error, "Failed to create group"));
        return;
      }
      setGroupModalVisible(false);
      onGroupsChanged();
    } catch (e) {
      setGroupError(getErrorMessage(e, "Failed to create group"));
    } finally {
      setGroupSaving(false);
    }
  };

  // --- Add Partner ---
  const [partnerModalVisible, setPartnerModalVisible] = useState(false);
  const [pGroupId, setPGroupId] = useState("");
  const [pGroupPickerVisible, setPGroupPickerVisible] = useState(false);
  const [pCompanyName, setPCompanyName] = useState("");
  const [pFirstName, setPFirstName] = useState("");
  const [pLastName, setPLastName] = useState("");
  const [pEmail, setPEmail] = useState("");
  const [pMobile, setPMobile] = useState("");
  const [pPartnerType, setPPartnerType] = useState<ReferralPartnerType>("other_b2b");
  const [pPartnerTypePickerVisible, setPPartnerTypePickerVisible] = useState(false);
  const [pTier, setPTier] = useState<ReferralPartnerTier>("bronze");
  const [pTierPickerVisible, setPTierPickerVisible] = useState(false);
  const [pRewardType, setPRewardType] = useState<ReferralRewardType>("none");
  const [pRewardTypePickerVisible, setPRewardTypePickerVisible] = useState(false);
  const [pRewardPercent, setPRewardPercent] = useState("");
  const [pRewardFlat, setPRewardFlat] = useState("");
  const [partnerError, setPartnerError] = useState<string | null>(null);
  const [partnerSaving, setPartnerSaving] = useState(false);

  const openNewPartner = (groupId?: string) => {
    setPGroupId(groupId ?? "");
    setPCompanyName("");
    setPFirstName("");
    setPLastName("");
    setPEmail("");
    setPMobile("");
    setPPartnerType("other_b2b");
    setPTier("bronze");
    setPRewardType("none");
    setPRewardPercent("");
    setPRewardFlat("");
    setPartnerError(null);
    setPartnerModalVisible(true);
  };

  const savePartner = async () => {
    const result = createReferralPartnerSchema.safeParse({
      group_id: pGroupId || undefined,
      company_name: pCompanyName,
      contact_first_name: pFirstName,
      contact_last_name: pLastName,
      email: pEmail,
      mobile: pMobile,
      partner_type: pPartnerType,
      tier: pTier,
      reward_type: pRewardType,
      reward_percent: pRewardType === "commission_percent" && pRewardPercent ? Number(pRewardPercent) : undefined,
      reward_flat_cents: (pRewardType === "flat_fee" || pRewardType === "gift_card") && pRewardFlat ? Math.round(Number(pRewardFlat) * 100) : undefined,
    });
    if (!result.success) {
      setPartnerError(result.error.issues[0]?.message ?? "Invalid partner");
      return;
    }
    if (!profile) return;
    setPartnerSaving(true);
    try {
      const { error } = await supabase.from("referral_partners").insert({
        tenant_id: profile.tenant_id,
        group_id: result.data.group_id || null,
        company_name: result.data.company_name || null,
        contact_first_name: result.data.contact_first_name,
        contact_last_name: result.data.contact_last_name || null,
        email: result.data.email || null,
        mobile: result.data.mobile || null,
        partner_type: result.data.partner_type,
        tier: result.data.tier,
        reward_type: result.data.reward_type,
        reward_percent: result.data.reward_percent ?? null,
        reward_flat_cents: result.data.reward_flat_cents ?? null,
      });
      if (error) {
        setPartnerError(getErrorMessage(error, "Failed to create partner"));
        return;
      }
      setPartnerModalVisible(false);
      onPartnersChanged();
    } catch (e) {
      setPartnerError(getErrorMessage(e, "Failed to create partner"));
    } finally {
      setPartnerSaving(false);
    }
  };

  // --- Log Referral Passed Out ---
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logPartnerId, setLogPartnerId] = useState("");
  const [logPartnerPickerVisible, setLogPartnerPickerVisible] = useState(false);
  const [logClientName, setLogClientName] = useState("");
  const [logDescription, setLogDescription] = useState("");
  const [logEstimatedValue, setLogEstimatedValue] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [logSaving, setLogSaving] = useState(false);

  const openLogReferral = (partnerId?: string) => {
    setLogPartnerId(partnerId ?? "");
    setLogClientName("");
    setLogDescription("");
    setLogEstimatedValue("");
    setLogError(null);
    setLogModalVisible(true);
  };

  const saveLog = async () => {
    const result = createReciprocityLogSchema.safeParse({
      partner_id: logPartnerId,
      client_name: logClientName,
      description: logDescription,
      estimated_value_cents: logEstimatedValue ? Math.round(Number(logEstimatedValue) * 100) : undefined,
    });
    if (!result.success) {
      setLogError(logPartnerId ? result.error.issues[0]?.message ?? "Invalid referral" : "Pick a partner first");
      return;
    }
    if (!profile) return;
    setLogSaving(true);
    try {
      const { error } = await supabase.from("referral_reciprocity_logs").insert({
        tenant_id: profile.tenant_id,
        partner_id: result.data.partner_id,
        client_name: result.data.client_name,
        description: result.data.description || null,
        estimated_value_cents: result.data.estimated_value_cents ?? null,
        date_passed: new Date().toISOString().slice(0, 10),
        created_by: profile.id,
      });
      if (error) {
        setLogError(getErrorMessage(error, "Failed to log referral"));
        return;
      }
      setLogModalVisible(false);
      onLogsChanged();
    } catch (e) {
      setLogError(getErrorMessage(e, "Failed to log referral"));
    } finally {
      setLogSaving(false);
    }
  };

  const renderPartnerCard = (partner: ReferralPartner) => {
    const referralsSent = referralsSentByPartner.get(partner.id) ?? 0;
    const closedRevenueCents = inboundCentsForPartner(partner.id, referredJobs, referralInvoices);
    const outboundCents = outboundByPartner.get(partner.id) ?? 0;
    const group = partner.group_id ? groupById.get(partner.group_id) : null;
    const tierColors = TIER_BADGE_COLORS[partner.tier];

    return (
      <View key={partner.id} style={styles.partnerCard}>
        <View style={styles.partnerCardHeader}>
          <Text style={styles.partnerCardName}>{partnerDisplayName(partner)}</Text>
          <View style={[styles.tierBadge, { backgroundColor: tierColors.bg }]}>
            <Text style={[styles.tierBadgeText, { color: tierColors.text }]}>{partner.tier.toUpperCase()}</Text>
          </View>
        </View>
        <View style={styles.chipRow}>
          {group ? (
            <View style={styles.groupChip}>
              <Text style={styles.groupChipText}>{group.name}</Text>
            </View>
          ) : null}
          <View style={styles.typeChip}>
            <Text style={styles.typeChipText}>{PARTNER_TYPE_OPTIONS.find((o) => o.value === partner.partner_type)?.label}</Text>
          </View>
          {partner.status === "inactive" ? (
            <View style={styles.inactiveChip}>
              <Text style={styles.inactiveChipText}>Inactive</Text>
            </View>
          ) : null}
        </View>
        {partner.email ? <Text style={styles.partnerCardMeta}>{partner.email}</Text> : null}
        {partner.mobile ? <Text style={styles.partnerCardMeta}>{partner.mobile}</Text> : null}
        <View style={styles.statsRow}>
          <View style={styles.flex1}>
            <Text style={styles.statLabel}>Referrals sent</Text>
            <Text style={styles.statValue}>{referralsSent}</Text>
          </View>
          <View style={styles.flex1}>
            <Text style={styles.statLabel}>Closed revenue won</Text>
            <Text style={styles.statValue}>{formatCentsAsAud(closedRevenueCents)}</Text>
          </View>
        </View>
        <Text style={styles.reciprocityText}>
          {formatCentsAsAud(outboundCents)} sent / {formatCentsAsAud(closedRevenueCents)} received
        </Text>
        {isAdmin ? (
          <Pressable onPress={() => openLogReferral(partner.id)}>
            <Text style={styles.smallLink}>+ Log referral passed out to {partner.contact_first_name}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.viewToggleRow}>
        <Pressable style={[styles.viewToggle, view === "partner" && styles.viewToggleActive]} onPress={() => setView("partner")}>
          <Text style={[styles.viewToggleText, view === "partner" && styles.viewToggleTextActive]}>By Partner</Text>
        </Pressable>
        <Pressable style={[styles.viewToggle, view === "group" && styles.viewToggleActive]} onPress={() => setView("group")}>
          <Text style={[styles.viewToggleText, view === "group" && styles.viewToggleTextActive]}>By Group</Text>
        </Pressable>
      </View>

      {isAdmin ? (
        <View style={styles.directoryActions}>
          <Pressable style={styles.secondaryButton} onPress={() => openLogReferral()}>
            <Text style={styles.secondaryButtonText}>Log Referral</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={openNewGroup}>
            <Text style={styles.secondaryButtonText}>+ Add Group</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={() => openNewPartner()}>
            <Text style={styles.primaryButtonText}>+ Add Partner</Text>
          </Pressable>
        </View>
      ) : null}

      {view === "partner" ? (
        partners.length === 0 ? (
          <Text style={styles.empty}>No referral partners yet.</Text>
        ) : (
          partners.map(renderPartnerCard)
        )
      ) : groups.length === 0 && ungroupedPartners.length === 0 ? (
        <Text style={styles.empty}>No groups or partners yet.</Text>
      ) : (
        <View>
          {groups.map((group) => {
            const expanded = expandedGroupIds.has(group.id);
            const groupPartners = partnersByGroup(group.id);
            return (
              <View key={group.id} style={styles.treeCard}>
                <Pressable style={styles.treeCardHeader} onPress={() => toggleGroup(group.id)}>
                  <Text style={styles.treeChevron}>{expanded ? "▾" : "▸"}</Text>
                  <Text style={styles.treeCardTitle}>{group.name}</Text>
                  <Text style={styles.treeCardMeta}>
                    {groupPartners.length} partner{groupPartners.length === 1 ? "" : "s"}
                  </Text>
                </Pressable>
                {expanded ? (
                  <View style={styles.treeCardBody}>
                    {groupPartners.length === 0 ? <Text style={styles.empty}>No partners in this group yet.</Text> : groupPartners.map(renderPartnerCard)}
                    {isAdmin ? (
                      <Pressable onPress={() => openNewPartner(group.id)}>
                        <Text style={styles.smallLink}>+ Add partner to {group.name}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
          {ungroupedPartners.length > 0 ? (
            <View style={styles.treeCard}>
              <Text style={styles.ungroupedTitle}>Ungrouped partners</Text>
              <View style={styles.treeCardBody}>{ungroupedPartners.map(renderPartnerCard)}</View>
            </View>
          ) : null}
        </View>
      )}

      <CenteredModal visible={groupModalVisible} onClose={() => setGroupModalVisible(false)}>
        <Text style={styles.modalTitle}>New BNI group / networking group</Text>
        <FormField label="Name" value={groupName} onChangeText={setGroupName} placeholder="e.g. BNI Synergy Chapter" />
        <Pressable style={styles.pickerField} onPress={() => setGroupTypePickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Type</Text>
          <Text style={styles.pickerFieldValue}>{GROUP_TYPE_OPTIONS.find((o) => o.value === groupType)?.label}</Text>
        </Pressable>
        <FormField label="Meeting day (optional)" value={meetingDay} onChangeText={setMeetingDay} placeholder="e.g. Tuesday" />
        <FormField label="Notes (optional)" value={groupNotes} onChangeText={setGroupNotes} multiline style={styles.multiline} />
        {groupError ? <Text style={styles.error}>{groupError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setGroupModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={saveGroup} disabled={groupSaving}>
            <Text style={styles.primaryButtonText}>{groupSaving ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={partnerModalVisible} onClose={() => setPartnerModalVisible(false)}>
        <Text style={styles.modalTitle}>New referral partner</Text>
        <Pressable style={styles.pickerField} onPress={() => setPGroupPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Group (optional)</Text>
          <Text style={styles.pickerFieldValue}>{groups.find((g) => g.id === pGroupId)?.name ?? "No group"}</Text>
        </Pressable>
        <FormField label="Company name (optional)" value={pCompanyName} onChangeText={setPCompanyName} />
        <FormField label="First name" value={pFirstName} onChangeText={setPFirstName} />
        <FormField label="Last name" value={pLastName} onChangeText={setPLastName} />
        <FormField label="Email" value={pEmail} onChangeText={setPEmail} keyboardType="email-address" autoCapitalize="none" />
        <FormField label="Mobile" value={pMobile} onChangeText={setPMobile} keyboardType="phone-pad" />
        <Pressable style={styles.pickerField} onPress={() => setPPartnerTypePickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Partner type</Text>
          <Text style={styles.pickerFieldValue}>{PARTNER_TYPE_OPTIONS.find((o) => o.value === pPartnerType)?.label}</Text>
        </Pressable>
        <Pressable style={styles.pickerField} onPress={() => setPTierPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Tier</Text>
          <Text style={styles.pickerFieldValue}>{TIER_OPTIONS.find((o) => o.value === pTier)?.label}</Text>
        </Pressable>
        <Pressable style={styles.pickerField} onPress={() => setPRewardTypePickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Reward type</Text>
          <Text style={styles.pickerFieldValue}>{REWARD_TYPE_OPTIONS.find((o) => o.value === pRewardType)?.label}</Text>
        </Pressable>
        {pRewardType === "commission_percent" ? (
          <FormField label="Commission (%)" value={pRewardPercent} onChangeText={setPRewardPercent} keyboardType="decimal-pad" placeholder="e.g. 5" />
        ) : null}
        {pRewardType === "flat_fee" || pRewardType === "gift_card" ? (
          <FormField
            label={pRewardType === "gift_card" ? "Gift card value ($)" : "Flat fee ($)"}
            value={pRewardFlat}
            onChangeText={setPRewardFlat}
            keyboardType="decimal-pad"
            placeholder="e.g. 50.00"
          />
        ) : null}
        {partnerError ? <Text style={styles.error}>{partnerError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setPartnerModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={savePartner} disabled={partnerSaving}>
            <Text style={styles.primaryButtonText}>{partnerSaving ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={logModalVisible} onClose={() => setLogModalVisible(false)}>
        <Text style={styles.modalTitle}>Log referral passed out</Text>
        <Pressable style={styles.pickerField} onPress={() => setLogPartnerPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Partner</Text>
          <Text style={styles.pickerFieldValue}>
            {partners.find((p) => p.id === logPartnerId) ? partnerDisplayName(partners.find((p) => p.id === logPartnerId)!) : "Select partner"}
          </Text>
        </Pressable>
        <FormField label="Client / lead name" value={logClientName} onChangeText={setLogClientName} placeholder="Who was referred to them" />
        <FormField
          label="Description (optional)"
          value={logDescription}
          onChangeText={setLogDescription}
          multiline
          style={styles.multiline}
          placeholder="e.g. Passed roof restoration lead to John"
        />
        <FormField label="Estimated value ($, optional)" value={logEstimatedValue} onChangeText={setLogEstimatedValue} keyboardType="decimal-pad" />
        {logError ? <Text style={styles.error}>{logError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setLogModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={saveLog} disabled={logSaving || !logPartnerId}>
            <Text style={styles.primaryButtonText}>{logSaving ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <PickerModal
        visible={groupTypePickerVisible}
        title="Group type"
        items={GROUP_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setGroupType(o.value)}
        onClose={() => setGroupTypePickerVisible(false)}
      />
      <PickerModal
        visible={pGroupPickerVisible}
        title="Select group"
        items={groups}
        getKey={(g) => g.id}
        getLabel={(g) => g.name}
        onSelect={(g) => setPGroupId(g.id)}
        onClose={() => setPGroupPickerVisible(false)}
      />
      <PickerModal
        visible={pPartnerTypePickerVisible}
        title="Partner type"
        items={PARTNER_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setPPartnerType(o.value)}
        onClose={() => setPPartnerTypePickerVisible(false)}
      />
      <PickerModal
        visible={pTierPickerVisible}
        title="Tier"
        items={TIER_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setPTier(o.value)}
        onClose={() => setPTierPickerVisible(false)}
      />
      <PickerModal
        visible={pRewardTypePickerVisible}
        title="Reward type"
        items={REWARD_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setPRewardType(o.value)}
        onClose={() => setPRewardTypePickerVisible(false)}
      />
      <PickerModal
        visible={logPartnerPickerVisible}
        title="Select partner"
        items={partners}
        getKey={(p) => p.id}
        getLabel={(p) => partnerDisplayName(p)}
        onSelect={(p) => setLogPartnerId(p.id)}
        onClose={() => setLogPartnerPickerVisible(false)}
      />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Reciprocity Ledger
// ---------------------------------------------------------------------------

type ReciprocityStatus = "balanced" | "net_exporter" | "net_importer" | "no_data";

function reciprocityStatus(inboundCents: number, outboundCents: number): ReciprocityStatus {
  if (inboundCents === 0 && outboundCents === 0) return "no_data";
  const ratio = outboundCents / Math.max(inboundCents, 1);
  if (ratio > 2) return "net_exporter";
  if (ratio < 0.5) return "net_importer";
  return "balanced";
}

const STATUS_BADGE: Record<ReciprocityStatus, { label: string; bg: string; text: string }> = {
  balanced: { label: "Balanced Partner", bg: "#dcfce7", text: "#15803d" },
  net_exporter: { label: "Net Exporter", bg: "#fef9c3", text: "#854d0e" },
  net_importer: { label: "Net Importer", bg: "#dbeafe", text: "#1d4ed8" },
  no_data: { label: "No referral activity yet", bg: "#f3f4f6", text: "#6b7280" },
};

function ReciprocityLedgerTab({
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
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      {rows.length === 0 ? (
        <Text style={styles.empty}>No inbound or outbound referral activity recorded yet.</Text>
      ) : (
        rows.map(({ partner, inbound, outbound, status }) => {
          const max = Math.max(inbound, outbound, 1);
          const badge = STATUS_BADGE[status];
          return (
            <View key={partner.id} style={styles.ledgerCard}>
              <View style={styles.ledgerCardHeader}>
                <Text style={styles.partnerCardName}>{partnerDisplayName(partner)}</Text>
                <View style={[styles.statusBadge, { backgroundColor: badge.bg }]}>
                  <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
                </View>
              </View>
              <View style={styles.barBlock}>
                <View style={styles.barLabelRow}>
                  <Text style={styles.barLabel}>Inbound (from {partner.contact_first_name})</Text>
                  <Text style={styles.barValue}>{formatCentsAsAud(inbound)}</Text>
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barFillInbound, { width: `${(inbound / max) * 100}%` }]} />
                </View>
              </View>
              <View style={styles.barBlock}>
                <View style={styles.barLabelRow}>
                  <Text style={styles.barLabel}>Outbound (to {partner.contact_first_name})</Text>
                  <Text style={styles.barValue}>{formatCentsAsAud(outbound)}</Text>
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barFillOutbound, { width: `${(outbound / max) * 100}%` }]} />
                </View>
              </View>
            </View>
          );
        })
      )}

      <Text style={styles.sectionHeading}>Referrals passed out - recent log</Text>
      {reciprocityLogs.length === 0 ? (
        <Text style={styles.empty}>Nothing logged yet - use "Log Referral" on the Directory tab.</Text>
      ) : (
        reciprocityLogs.slice(0, 20).map((log) => {
          const partner = partners.find((p) => p.id === log.partner_id);
          return (
            <View key={log.id} style={styles.logRow}>
              <Text style={styles.logDate}>{log.date_passed}</Text>
              <View style={styles.flex1}>
                <Text style={styles.logPartner}>{partner ? partnerDisplayName(partner) : "Unknown partner"}</Text>
                <Text style={styles.logClient}>{log.client_name}</Text>
              </View>
              <Text style={styles.logValue}>{log.estimated_value_cents != null ? formatCentsAsAud(log.estimated_value_cents) : "-"}</Text>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  flex1: { flex: 1 },
  tabRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#d1d5db" },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: "#1d4ed8" },
  tabText: { fontSize: 13, fontWeight: "600", color: "#6b7280" },
  tabTextActive: { color: "#1d4ed8" },
  tabBody: { flex: 1, padding: 16 },
  error: { color: "#dc2626", marginTop: 8 },
  empty: { color: "#6b7280", textAlign: "center", marginVertical: 16 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  smallLink: { color: "#1d4ed8", fontWeight: "600", fontSize: 12, marginTop: 8 },
  multiline: { minHeight: 60, textAlignVertical: "top" },

  viewToggleRow: { flexDirection: "row", backgroundColor: "#f3f4f6", borderRadius: 8, padding: 4, marginBottom: 12, alignSelf: "flex-start" },
  viewToggle: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  viewToggleActive: { backgroundColor: "#fff" },
  viewToggleText: { fontSize: 12, fontWeight: "700", color: "#6b7280" },
  viewToggleTextActive: { color: "#111827" },

  directoryActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  primaryButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center" },
  primaryButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  secondaryButton: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center" },
  secondaryButtonText: { color: "#374151", fontWeight: "700", fontSize: 13 },

  partnerCard: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, padding: 14, marginBottom: 10, backgroundColor: "#fff" },
  partnerCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  partnerCardName: { fontSize: 15, fontWeight: "700", color: "#111827", flex: 1 },
  partnerCardMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  tierBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  tierBadgeText: { fontSize: 11, fontWeight: "700" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8, marginBottom: 4 },
  groupChip: { backgroundColor: "#eff6ff", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  groupChipText: { fontSize: 11, fontWeight: "700", color: "#1d4ed8" },
  typeChip: { backgroundColor: "#f3f4f6", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  typeChipText: { fontSize: 11, fontWeight: "600", color: "#4b5563" },
  inactiveChip: { backgroundColor: "#fef2f2", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  inactiveChipText: { fontSize: 11, fontWeight: "700", color: "#b91c1c" },
  statsRow: { flexDirection: "row", gap: 12, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#f3f4f6" },
  statLabel: { fontSize: 10, color: "#9ca3af", textTransform: "uppercase" },
  statValue: { fontSize: 14, fontWeight: "700", color: "#111827", marginTop: 2 },
  reciprocityText: { fontSize: 12, color: "#4b5563", marginTop: 8 },

  treeCard: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, marginBottom: 10, backgroundColor: "#fff" },
  treeCardHeader: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  treeChevron: { color: "#9ca3af", fontSize: 12 },
  treeCardTitle: { flex: 1, fontSize: 15, fontWeight: "700", color: "#111827" },
  treeCardMeta: { fontSize: 11, color: "#9ca3af" },
  treeCardBody: { borderTopWidth: 1, borderTopColor: "#f3f4f6", padding: 14 },
  ungroupedTitle: { fontSize: 15, fontWeight: "700", color: "#111827", padding: 14, paddingBottom: 0 },

  modalTitle: { fontSize: 17, fontWeight: "700" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 16, marginTop: 4 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldLabel: { fontSize: 12, color: "#6b7280", marginBottom: 2 },
  pickerFieldValue: { fontSize: 15, color: "#111827" },

  ledgerCard: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, padding: 14, marginBottom: 10, backgroundColor: "#fff" },
  ledgerCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },
  barBlock: { marginTop: 8 },
  barLabelRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  barLabel: { fontSize: 11, color: "#6b7280" },
  barValue: { fontSize: 12, fontWeight: "700", color: "#374151" },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: "#f3f4f6" },
  barFillInbound: { height: 6, borderRadius: 3, backgroundColor: "#1d4ed8" },
  barFillOutbound: { height: 6, borderRadius: 3, backgroundColor: "#f59e0b" },

  sectionHeading: { fontSize: 13, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginTop: 20, marginBottom: 10 },
  logRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  logDate: { fontSize: 11, color: "#9ca3af", width: 80 },
  logPartner: { fontSize: 13, fontWeight: "600", color: "#111827" },
  logClient: { fontSize: 12, color: "#6b7280" },
  logValue: { fontSize: 13, fontWeight: "700", color: "#111827" },
});
