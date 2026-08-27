import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { recordMembershipBenefitUsageSchema, type ClientMembership, type MembershipBenefitType, type MembershipBenefitUsage, type MembershipStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";

// Membership status summary for the field - so a technician on a client/
// job screen can see "this client is a Member, no call-out fee, hasn't
// used their annual roof inspection yet" without calling the office.
// Supabase-direct (not PowerSync) - same "occasional, needs connectivity"
// treatment as MaterialTallyCounter, since membership enrollment/status
// changes happen through the office + Stripe, not from the field. Renders
// nothing at all for a non-member client - no need to show a "not a
// member" card on every single client screen.
//
// jobCardId is optional - when a call site supplies it (the job detail
// screen), each not-yet-used included benefit gets a "Mark as used"
// action that records membership_benefit_usage against that job. The
// proactive re-check in handleMarkUsed happens before the insert (per the
// original spec), not just as a fallback for the constraint violation, so
// a technician gets a clear "already used this period" message and can
// bill the visit as billable instead. The client detail screen (no
// jobCardId) stays read-only, same as before this action existed.

const STATUS_LABELS: Record<MembershipStatus, string> = {
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
  expired: "Expired",
};

const STATUS_COLORS: Record<MembershipStatus, string> = {
  active: "#15803d",
  past_due: "#b45309",
  cancelled: "#6b7280",
  expired: "#6b7280",
};

const BENEFIT_LABELS: Record<MembershipBenefitType, string> = {
  annual_roof_inspection: "Annual roof inspection",
  annual_plumbing_check: "Annual plumbing check",
};

async function fetchActiveMembership(clientId: string): Promise<ClientMembership | null> {
  const { data, error } = await supabase
    .from("client_memberships")
    .select("*")
    .eq("client_id", clientId)
    .in("status", ["active", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ClientMembership | null;
}

async function fetchBenefitUsage(clientMembershipId: string, periodStart: string): Promise<MembershipBenefitUsage[]> {
  const { data, error } = await supabase
    .from("membership_benefit_usage")
    .select("*")
    .eq("client_membership_id", clientMembershipId)
    .eq("period_start", periodStart);
  if (error) throw error;
  return data as MembershipBenefitUsage[];
}

export function MembershipStatusCard({ clientId, jobCardId }: { clientId: string; jobCardId?: string }) {
  const { profile } = useAuth();
  const [membership, setMembership] = useState<ClientMembership | null>(null);
  const [usedBenefits, setUsedBenefits] = useState<Set<MembershipBenefitType>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState<MembershipBenefitType | null>(null);
  const [alreadyUsedType, setAlreadyUsedType] = useState<MembershipBenefitType | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  const reload = async () => {
    const m = await fetchActiveMembership(clientId);
    setMembership(m);
    if (m?.current_period_start) {
      const usage = await fetchBenefitUsage(m.id, m.current_period_start);
      setUsedBenefits(new Set(usage.map((u) => u.benefit_type)));
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchActiveMembership(clientId)
      .then(async (m) => {
        if (cancelled) return;
        setMembership(m);
        if (m?.current_period_start) {
          const usage = await fetchBenefitUsage(m.id, m.current_period_start);
          if (!cancelled) setUsedBenefits(new Set(usage.map((u) => u.benefit_type)));
        }
        if (!cancelled) setLoaded(true);
      })
      .catch((e) => {
        console.error("[MembershipStatusCard] Failed to load membership status", e);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const handleMarkUsed = async (benefitType: MembershipBenefitType) => {
    if (!membership || !membership.current_period_start || !membership.current_period_end || !profile) return;
    setRecording(benefitType);
    setRecordError(null);
    setAlreadyUsedType(null);
    try {
      // Proactive check first (per spec), not just a fallback for the
      // constraint violation below.
      const existing = await fetchBenefitUsage(membership.id, membership.current_period_start);
      if (existing.some((u) => u.benefit_type === benefitType)) {
        setAlreadyUsedType(benefitType);
        return;
      }

      const result = recordMembershipBenefitUsageSchema.safeParse({
        client_membership_id: membership.id,
        benefit_type: benefitType,
        job_card_id: jobCardId,
        period_start: membership.current_period_start,
        period_end: membership.current_period_end,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      const { error } = await supabase
        .from("membership_benefit_usage")
        .insert({ ...result.data, tenant_id: profile.tenant_id, created_by: profile.id });
      if (error) {
        if ((error as { code?: string }).code === "23505") {
          setAlreadyUsedType(benefitType);
          return;
        }
        throw error;
      }
      await reload();
    } catch (e) {
      console.error("[MembershipStatusCard] Failed to record benefit usage", e);
      setRecordError(getErrorMessage(e, "Failed to record benefit usage"));
    } finally {
      setRecording(null);
    }
  };

  if (!loaded || !membership) return null;

  const snapshot = membership.benefits_snapshot;
  const chips: string[] = [];
  if (snapshot.waive_callout_fee) chips.push("No call-out fee");
  if (snapshot.discount_percent > 0) chips.push(`${snapshot.discount_percent}% off repairs`);
  if (snapshot.priority_scheduling) chips.push("Priority scheduling");
  if (snapshot.same_day_response) chips.push("Same-day response");

  const includedBenefits: MembershipBenefitType[] = [];
  if (snapshot.annual_roof_inspections_included > 0) includedBenefits.push("annual_roof_inspection");
  if (snapshot.annual_plumbing_checks_included > 0) includedBenefits.push("annual_plumbing_check");

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Member</Text>
        <Text style={[styles.status, { color: STATUS_COLORS[membership.status] }]}>{STATUS_LABELS[membership.status]}</Text>
      </View>

      {chips.length > 0 ? (
        <View style={styles.chipRow}>
          {chips.map((chip) => (
            <View key={chip} style={styles.chip}>
              <Text style={styles.chipText}>{chip}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {includedBenefits.length > 0 ? (
        <View style={styles.benefitsList}>
          {includedBenefits.map((benefit) => {
            const used = usedBenefits.has(benefit);
            return (
              <View key={benefit}>
                <View style={styles.benefitRowWithAction}>
                  <Text style={styles.benefitRow}>
                    {used ? "✓" : "○"} {BENEFIT_LABELS[benefit]} {used ? "used this period" : "not yet used"}
                  </Text>
                  {jobCardId && !used ? (
                    <Pressable
                      style={styles.markUsedButton}
                      onPress={() => handleMarkUsed(benefit)}
                      disabled={recording === benefit}
                    >
                      <Text style={styles.markUsedButtonText}>{recording === benefit ? "Recording..." : "Mark as used"}</Text>
                    </Pressable>
                  ) : null}
                </View>
                {alreadyUsedType === benefit ? (
                  <Text style={styles.alreadyUsedText}>Already used this period - bill this visit as billable instead.</Text>
                ) : null}
              </View>
            );
          })}
          {recordError ? <Text style={styles.recordErrorText}>{recordError}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No horizontal margin here deliberately - this component gets dropped
  // into containers with very different padding conventions (a padded
  // "section" View on the job detail screen vs. an unpadded FlatList
  // header on the client detail screen), so each call site wraps it with
  // whatever horizontal spacing that context needs instead.
  card: { backgroundColor: "#eff6ff", borderRadius: 10, padding: 12, marginBottom: 12, gap: 6 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 14, fontWeight: "700", color: "#1d4ed8" },
  status: { fontSize: 12, fontWeight: "700" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { backgroundColor: "#dbeafe", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: "600", color: "#1e40af" },
  benefitsList: { gap: 6 },
  benefitRow: { fontSize: 12, color: "#374151", flexShrink: 1 },
  benefitRowWithAction: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  markUsedButton: { backgroundColor: "#1d4ed8", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, flexShrink: 0 },
  markUsedButtonText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  alreadyUsedText: { fontSize: 11, color: "#b45309", marginTop: 2 },
  recordErrorText: { fontSize: 11, color: "#dc2626", marginTop: 2 },
});
