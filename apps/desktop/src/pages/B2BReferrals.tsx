import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createReferralGroupSchema,
  createReferralPartnerSchema,
  createReciprocityLogSchema,
  formatCentsAsAud,
  type JobCard,
  type ReferralGroup,
  type ReferralGroupType,
  type ReferralPartner,
  type ReferralPartnerTier,
  type ReferralPartnerType,
  type ReferralReciprocityLog,
  type ReferralRewardType,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField, TextAreaField } from "../components/FormField";
import { ReferralAnalyticsTab } from "../components/ReferralAnalyticsTab";
import { ReciprocityLedgerTab } from "../components/ReciprocityLedgerTab";
import { ReferralWorkflowsTab } from "../components/ReferralWorkflowsTab";

// The four sub-tabs from the spec live under a single sidebar destination
// (/b2b-referrals), same "in-page tabs" relationship RealEstate.tsx already
// established for its own four-sub-tab spec.

type SubTab = "directory" | "analytics" | "reciprocity" | "workflows";

async function fetchReferralGroups(): Promise<ReferralGroup[]> {
  const { data, error } = await supabase.from("referral_groups").select("*").order("name");
  if (error) throw error;
  return data as ReferralGroup[];
}

async function fetchReferralPartners(): Promise<ReferralPartner[]> {
  const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
  if (error) throw error;
  return data as ReferralPartner[];
}

// Every job tagged with a referral partner - used to compute "Total
// Referrals Sent" / "Closed Revenue Won" per partner across the whole
// module (Directory cards, Analytics KPIs, Reciprocity Ledger). Fetched
// once here and passed down, same client-side-join approach Jobs.tsx
// already uses for clients/categories/stages.
export type ReferredJob = Pick<JobCard, "id" | "referral_partner_id" | "referral_fee_amount_cents" | "referral_fee_paid" | "lifecycle_stage_id">;

async function fetchReferredJobs(): Promise<ReferredJob[]> {
  const { data, error } = await supabase
    .from("job_cards")
    .select("id, referral_partner_id, referral_fee_amount_cents, referral_fee_paid, lifecycle_stage_id")
    .not("referral_partner_id", "is", null);
  if (error) throw error;
  return data as ReferredJob[];
}

export interface ReferralInvoiceRow {
  id: string;
  job_card_id: string | null;
  status: string;
  total_cents: number;
  paid_at: string | null;
}

async function fetchReferralInvoices(): Promise<ReferralInvoiceRow[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, job_card_id, status, total_cents, paid_at")
    .not("job_card_id", "is", null);
  if (error) throw error;
  return data as ReferralInvoiceRow[];
}

async function fetchReciprocityLogs(): Promise<ReferralReciprocityLog[]> {
  const { data, error } = await supabase.from("referral_reciprocity_logs").select("*").order("date_passed", { ascending: false });
  if (error) throw error;
  return data as ReferralReciprocityLog[];
}

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

export const TIER_BADGE_CLASSES: Record<ReferralPartnerTier, string> = {
  bronze: "bg-amber-100 text-amber-800",
  silver: "bg-gray-200 text-gray-700",
  gold: "bg-yellow-100 text-yellow-800",
  vip: "bg-purple-100 text-purple-800",
};

export default function B2BReferralsPage() {
  const [tab, setTab] = useState<SubTab>("directory");

  const { data: groups } = useQuery({ queryKey: ["referral-groups"], queryFn: fetchReferralGroups });
  const { data: partners } = useQuery({ queryKey: ["referral-partners"], queryFn: fetchReferralPartners });
  const { data: referredJobs } = useQuery({ queryKey: ["referred-jobs"], queryFn: fetchReferredJobs });
  const { data: referralInvoices } = useQuery({ queryKey: ["referral-invoices"], queryFn: fetchReferralInvoices });
  const { data: reciprocityLogs } = useQuery({ queryKey: ["reciprocity-logs"], queryFn: fetchReciprocityLogs });

  return (
    <div className="p-8">
      <h1 className="mb-1 text-xl font-bold text-gray-900">B2B & Referrals</h1>
      <p className="mb-6 text-sm text-gray-500">
        B2B partners, BNI/networking groups, referral revenue attribution, and reciprocity tracking.
      </p>

      <div className="mb-6 flex gap-1 border-b border-gray-300">
        {(
          [
            { key: "directory", label: "Partner Directory & Groups" },
            { key: "analytics", label: "Revenue Analytics & BNI TYFCB" },
            { key: "reciprocity", label: "Reciprocity Ledger" },
            { key: "workflows", label: "Automated Partner Workflows" },
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
        <DirectoryTab
          groups={groups ?? []}
          partners={partners ?? []}
          referredJobs={referredJobs ?? []}
          referralInvoices={referralInvoices ?? []}
          reciprocityLogs={reciprocityLogs ?? []}
        />
      ) : tab === "analytics" ? (
        <ReferralAnalyticsTab
          groups={groups ?? []}
          partners={partners ?? []}
          referredJobs={referredJobs ?? []}
          referralInvoices={referralInvoices ?? []}
        />
      ) : tab === "reciprocity" ? (
        <ReciprocityLedgerTab partners={partners ?? []} referredJobs={referredJobs ?? []} referralInvoices={referralInvoices ?? []} reciprocityLogs={reciprocityLogs ?? []} />
      ) : (
        <ReferralWorkflowsTab />
      )}
    </div>
  );
}

function partnerInboundCents(partnerId: string, referredJobs: ReferredJob[], referralInvoices: ReferralInvoiceRow[]): number {
  const jobIds = new Set(referredJobs.filter((j) => j.referral_partner_id === partnerId).map((j) => j.id));
  return referralInvoices
    .filter((inv) => inv.status === "paid" && inv.job_card_id && jobIds.has(inv.job_card_id))
    .reduce((sum, inv) => sum + inv.total_cents, 0);
}

function DirectoryTab({
  groups,
  partners,
  referredJobs,
  referralInvoices,
  reciprocityLogs,
}: {
  groups: ReferralGroup[];
  partners: ReferralPartner[];
  referredJobs: ReferredJob[];
  referralInvoices: ReferralInvoiceRow[];
  reciprocityLogs: ReferralReciprocityLog[];
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

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
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupType, setGroupType] = useState<ReferralGroupType | "">("networking_group");
  const [meetingDay, setMeetingDay] = useState("");
  const [groupNotes, setGroupNotes] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);

  const openNewGroup = () => {
    setGroupName("");
    setGroupType("networking_group");
    setMeetingDay("");
    setGroupNotes("");
    setGroupError(null);
    setGroupModalOpen(true);
  };

  const createGroup = useMutation({
    mutationFn: async () => {
      const result = createReferralGroupSchema.safeParse({
        name: groupName,
        group_type: groupType || "networking_group",
        meeting_day: meetingDay,
        notes: groupNotes,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid group");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("referral_groups").insert({
        tenant_id: profile.tenant_id,
        name: result.data.name,
        group_type: result.data.group_type,
        meeting_day: result.data.meeting_day || null,
        notes: result.data.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["referral-groups"] });
      setGroupModalOpen(false);
    },
    onError: (e) => setGroupError(getErrorMessage(e, "Failed to create group")),
  });

  // --- Add Partner ---
  const [partnerModalOpen, setPartnerModalOpen] = useState(false);
  const [pGroupId, setPGroupId] = useState("");
  const [pCompanyName, setPCompanyName] = useState("");
  const [pFirstName, setPFirstName] = useState("");
  const [pLastName, setPLastName] = useState("");
  const [pEmail, setPEmail] = useState("");
  const [pMobile, setPMobile] = useState("");
  const [pPartnerType, setPPartnerType] = useState<ReferralPartnerType | "">("other_b2b");
  const [pTier, setPTier] = useState<ReferralPartnerTier | "">("bronze");
  const [pRewardType, setPRewardType] = useState<ReferralRewardType | "">("none");
  const [pRewardPercent, setPRewardPercent] = useState("");
  const [pRewardFlat, setPRewardFlat] = useState("");
  const [partnerError, setPartnerError] = useState<string | null>(null);

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
    setPartnerModalOpen(true);
  };

  const createPartner = useMutation({
    mutationFn: async () => {
      const result = createReferralPartnerSchema.safeParse({
        group_id: pGroupId || undefined,
        company_name: pCompanyName,
        contact_first_name: pFirstName,
        contact_last_name: pLastName,
        email: pEmail,
        mobile: pMobile,
        partner_type: pPartnerType || "other_b2b",
        tier: pTier || "bronze",
        reward_type: pRewardType || "none",
        reward_percent: pRewardType === "commission_percent" && pRewardPercent ? Number(pRewardPercent) : undefined,
        reward_flat_cents: (pRewardType === "flat_fee" || pRewardType === "gift_card") && pRewardFlat ? Math.round(Number(pRewardFlat) * 100) : undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid partner");
      if (!profile) throw new Error("Not signed in");

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
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["referral-partners"] });
      setPartnerModalOpen(false);
    },
    onError: (e) => setPartnerError(getErrorMessage(e, "Failed to create partner")),
  });

  // --- Log Referral Passed Out ---
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logPartnerId, setLogPartnerId] = useState("");
  const [logClientName, setLogClientName] = useState("");
  const [logDescription, setLogDescription] = useState("");
  const [logEstimatedValue, setLogEstimatedValue] = useState("");
  const [logDatePassed, setLogDatePassed] = useState(() => new Date().toISOString().slice(0, 10));
  const [logError, setLogError] = useState<string | null>(null);

  const openLogReferral = (partnerId?: string) => {
    setLogPartnerId(partnerId ?? "");
    setLogClientName("");
    setLogDescription("");
    setLogEstimatedValue("");
    setLogDatePassed(new Date().toISOString().slice(0, 10));
    setLogError(null);
    setLogModalOpen(true);
  };

  const createLog = useMutation({
    mutationFn: async () => {
      const result = createReciprocityLogSchema.safeParse({
        partner_id: logPartnerId,
        client_name: logClientName,
        description: logDescription,
        estimated_value_cents: logEstimatedValue ? Math.round(Number(logEstimatedValue) * 100) : undefined,
        date_passed: logDatePassed || undefined,
      });
      if (!result.success) throw new Error(logPartnerId ? result.error.issues[0]?.message ?? "Invalid referral" : "Pick a partner first");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("referral_reciprocity_logs").insert({
        tenant_id: profile.tenant_id,
        partner_id: result.data.partner_id,
        client_name: result.data.client_name,
        description: result.data.description || null,
        estimated_value_cents: result.data.estimated_value_cents ?? null,
        date_passed: result.data.date_passed ?? new Date().toISOString().slice(0, 10),
        created_by: profile.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reciprocity-logs"] });
      setLogModalOpen(false);
    },
    onError: (e) => setLogError(getErrorMessage(e, "Failed to log referral")),
  });

  const renderPartnerCard = (partner: ReferralPartner) => {
    const referralsSent = referralsSentByPartner.get(partner.id) ?? 0;
    const closedRevenueCents = partnerInboundCents(partner.id, referredJobs, referralInvoices);
    const outboundCents = outboundByPartner.get(partner.id) ?? 0;
    const group = partner.group_id ? groupById.get(partner.group_id) : null;

    return (
      <div key={partner.id} className="rounded-lg border border-gray-300 bg-white p-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <p className="font-bold text-gray-900">{partnerDisplayName(partner)}</p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TIER_BADGE_CLASSES[partner.tier]}`}>{partner.tier.toUpperCase()}</span>
        </div>
        <div className="mb-3 flex flex-wrap gap-1">
          {group ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">{group.name}</span> : null}
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
            {PARTNER_TYPE_OPTIONS.find((o) => o.value === partner.partner_type)?.label}
          </span>
          {partner.status === "inactive" ? (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">Inactive</span>
          ) : null}
        </div>
        <div className="mb-3 space-y-1 text-sm text-gray-600">
          {partner.email ? <p>{partner.email}</p> : null}
          {partner.mobile ? <p>{partner.mobile}</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-gray-200 pt-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400">Referrals sent</p>
            <p className="font-semibold text-gray-900">{referralsSent}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400">Closed revenue won</p>
            <p className="font-semibold text-gray-900">{formatCentsAsAud(closedRevenueCents)}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs uppercase tracking-wide text-gray-400">Reciprocity ratio</p>
            <p className="font-semibold text-gray-900">
              {formatCentsAsAud(outboundCents)} sent / {formatCentsAsAud(closedRevenueCents)} received
            </p>
          </div>
        </div>
        <button
          onClick={() => openLogReferral(partner.id)}
          className="mt-3 text-xs font-semibold text-blue-700 hover:underline"
        >
          + Log referral passed out to {partner.contact_first_name}
        </button>
      </div>
    );
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-gray-100 p-1 text-sm font-semibold">
          <button
            onClick={() => setView("partner")}
            className={`rounded px-3 py-1 ${view === "partner" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}
          >
            By Partner
          </button>
          <button
            onClick={() => setView("group")}
            className={`rounded px-3 py-1 ${view === "group" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}
          >
            By Group / Chapter
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => openLogReferral()}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Log Referral Passed Out
          </button>
          <button
            onClick={openNewGroup}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            + Add BNI Group
          </button>
          <button
            onClick={() => openNewPartner()}
            className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
          >
            + Add Partner
          </button>
        </div>
      </div>

      {view === "partner" ? (
        partners.length === 0 ? (
          <p className="text-sm text-gray-500">No referral partners yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-4">{partners.map(renderPartnerCard)}</div>
        )
      ) : groups.length === 0 && ungroupedPartners.length === 0 ? (
        <p className="text-sm text-gray-500">No groups or partners yet.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const expanded = expandedGroupIds.has(group.id);
            const groupPartners = partnersByGroup(group.id);
            return (
              <div key={group.id} className="rounded-lg border border-gray-300 bg-white">
                <button onClick={() => toggleGroup(group.id)} className="flex w-full items-center justify-between px-4 py-3 text-left">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-400">{expanded ? "▾" : "▸"}</span>
                    <span className="font-bold text-gray-900">{group.name}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {GROUP_TYPE_OPTIONS.find((o) => o.value === group.group_type)?.label}
                    </span>
                    {group.meeting_day ? <span className="text-xs text-gray-400">Meets {group.meeting_day}</span> : null}
                  </div>
                  <span className="text-xs text-gray-400">
                    {groupPartners.length} partner{groupPartners.length === 1 ? "" : "s"}
                  </span>
                </button>
                {expanded ? (
                  <div className="border-t border-gray-200 px-4 py-3">
                    {groupPartners.length === 0 ? (
                      <p className="text-sm text-gray-500">No partners in this group yet.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-3">{groupPartners.map(renderPartnerCard)}</div>
                    )}
                    <button onClick={() => openNewPartner(group.id)} className="mt-3 text-xs font-semibold text-blue-700 hover:underline">
                      + Add partner to {group.name}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {ungroupedPartners.length > 0 ? (
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <p className="mb-3 text-sm font-bold text-gray-900">Ungrouped partners</p>
              <div className="grid grid-cols-3 gap-3">{ungroupedPartners.map(renderPartnerCard)}</div>
            </div>
          ) : null}
        </div>
      )}

      <Modal open={groupModalOpen} onClose={() => setGroupModalOpen(false)} title="New BNI group / networking group">
        <FormField label="Name" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. BNI Synergy Chapter" />
        <SelectField label="Type" value={groupType} onChange={setGroupType} options={GROUP_TYPE_OPTIONS} placeholder="Select type" />
        <FormField label="Meeting day (optional)" value={meetingDay} onChange={(e) => setMeetingDay(e.target.value)} placeholder="e.g. Tuesday" />
        <TextAreaField label="Notes (optional)" rows={3} value={groupNotes} onChange={(e) => setGroupNotes(e.target.value)} />
        {groupError ? <p className="mb-4 text-sm text-red-600">{groupError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setGroupModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createGroup.mutate()}
            disabled={createGroup.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createGroup.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={partnerModalOpen} onClose={() => setPartnerModalOpen(false)} title="New referral partner">
        <SelectField label="Group (optional)" value={pGroupId} onChange={setPGroupId} options={groups.map((g) => ({ value: g.id, label: g.name }))} placeholder="No group" />
        <FormField label="Company name (optional)" value={pCompanyName} onChange={(e) => setPCompanyName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" value={pFirstName} onChange={(e) => setPFirstName(e.target.value)} />
          <FormField label="Last name" value={pLastName} onChange={(e) => setPLastName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Email" type="email" value={pEmail} onChange={(e) => setPEmail(e.target.value)} />
          <FormField label="Mobile" value={pMobile} onChange={(e) => setPMobile(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Partner type" value={pPartnerType} onChange={setPPartnerType} options={PARTNER_TYPE_OPTIONS} />
          <SelectField label="Tier" value={pTier} onChange={setPTier} options={TIER_OPTIONS} />
        </div>
        <SelectField label="Reward type" value={pRewardType} onChange={setPRewardType} options={REWARD_TYPE_OPTIONS} />
        {pRewardType === "commission_percent" ? (
          <FormField
            label="Commission (%)"
            type="number"
            step="0.01"
            value={pRewardPercent}
            onChange={(e) => setPRewardPercent(e.target.value)}
            placeholder="e.g. 5"
          />
        ) : null}
        {pRewardType === "flat_fee" || pRewardType === "gift_card" ? (
          <FormField
            label={pRewardType === "gift_card" ? "Gift card value ($)" : "Flat fee ($)"}
            type="number"
            step="0.01"
            value={pRewardFlat}
            onChange={(e) => setPRewardFlat(e.target.value)}
            placeholder="e.g. 50.00"
          />
        ) : null}
        {partnerError ? <p className="mb-4 text-sm text-red-600">{partnerError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setPartnerModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createPartner.mutate()}
            disabled={createPartner.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createPartner.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={logModalOpen} onClose={() => setLogModalOpen(false)} title="Log referral passed out">
        <SelectField
          label="Partner"
          value={logPartnerId}
          onChange={setLogPartnerId}
          options={partners.map((p) => ({ value: p.id, label: partnerDisplayName(p) }))}
          placeholder="Select partner"
        />
        <FormField label="Client / lead name" value={logClientName} onChange={(e) => setLogClientName(e.target.value)} placeholder="Who was referred to them" />
        <TextAreaField
          label="Description (optional)"
          rows={2}
          value={logDescription}
          onChange={(e) => setLogDescription(e.target.value)}
          placeholder="e.g. Passed roof restoration lead to John"
        />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Estimated value ($, optional)" type="number" step="0.01" value={logEstimatedValue} onChange={(e) => setLogEstimatedValue(e.target.value)} />
          <FormField label="Date passed" type="date" value={logDatePassed} onChange={(e) => setLogDatePassed(e.target.value)} />
        </div>
        {logError ? <p className="mb-4 text-sm text-red-600">{logError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setLogModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createLog.mutate()}
            disabled={createLog.isPending || !logPartnerId}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createLog.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
