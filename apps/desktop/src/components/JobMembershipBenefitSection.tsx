import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  recordMembershipBenefitUsageSchema,
  type ClientMembership,
  type MembershipBenefitType,
  type MembershipBenefitUsage,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";

// Job detail page's "record a membership benefit was used on this job"
// action - the counterpart to ClientMembershipSection's read-only usage
// history. membership_benefit_usage and its anti-double-use UNIQUE
// (client_membership_id, benefit_type, period_start) constraint already
// exist (see membership_plans_and_clients.sql); nothing wrote to it until
// this component. Per the original spec, the proactive "already used this
// period" check happens BEFORE attempting the insert (fetchUsage below),
// not just as a fallback for the constraint violation - so the person gets
// a clear message and the option to keep going rather than a raw DB error.
// Self-contained, same "drop into any page" shape as ClientMembershipSection/
// QuoteToolsSection. Renders nothing for a non-member client or one whose
// plan includes no benefits at all.

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

async function fetchUsage(clientMembershipId: string, periodStart: string): Promise<MembershipBenefitUsage[]> {
  const { data, error } = await supabase
    .from("membership_benefit_usage")
    .select("*")
    .eq("client_membership_id", clientMembershipId)
    .eq("period_start", periodStart);
  if (error) throw error;
  return data as MembershipBenefitUsage[];
}

export function JobMembershipBenefitSection({ jobCardId, clientId }: { jobCardId: string; clientId: string }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const { data: membership } = useQuery({
    queryKey: ["client-memberships-active", clientId],
    queryFn: () => fetchActiveMembership(clientId),
  });

  const { data: usage } = useQuery({
    queryKey: ["membership-benefit-usage", membership?.id, membership?.current_period_start],
    queryFn: () => fetchUsage(membership!.id, membership!.current_period_start!),
    enabled: !!membership?.current_period_start,
  });

  const usedTypes = new Set((usage ?? []).map((u) => u.benefit_type));

  const [recordError, setRecordError] = useState<string | null>(null);
  const [alreadyUsedType, setAlreadyUsedType] = useState<MembershipBenefitType | null>(null);
  const [recordedType, setRecordedType] = useState<MembershipBenefitType | null>(null);

  const recordUsage = useMutation({
    mutationFn: async (benefitType: MembershipBenefitType) => {
      if (!membership || !membership.current_period_start || !membership.current_period_end) {
        throw new Error("This membership has no current period to record usage against");
      }
      if (!profile) throw new Error("Not signed in");

      // Proactive check first (per spec) - the UNIQUE constraint on
      // membership_benefit_usage is the real backstop, but checking here
      // means a clear "already used this period" message instead of a raw
      // constraint-violation error, and a chance to bail before the insert
      // round-trip at all.
      const existing = await fetchUsage(membership.id, membership.current_period_start);
      if (existing.some((u) => u.benefit_type === benefitType)) {
        setAlreadyUsedType(benefitType);
        return null;
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
        // 23505 = unique_violation - a race with another save landed first.
        // Same message as the proactive check, not a raw DB error.
        if ((error as { code?: string }).code === "23505") {
          setAlreadyUsedType(benefitType);
          return null;
        }
        throw error;
      }
      return benefitType;
    },
    onSuccess: (benefitType) => {
      setRecordError(null);
      if (benefitType) {
        setRecordedType(benefitType);
        setTimeout(() => setRecordedType(null), 3000);
        queryClient.invalidateQueries({ queryKey: ["membership-benefit-usage"] });
      }
    },
    onError: (e) => setRecordError(getErrorMessage(e, "Failed to record benefit usage")),
  });

  if (!membership) return null;

  const includedBenefits: MembershipBenefitType[] = [];
  if (membership.benefits_snapshot.annual_roof_inspections_included > 0) includedBenefits.push("annual_roof_inspection");
  if (membership.benefits_snapshot.annual_plumbing_checks_included > 0) includedBenefits.push("annual_plumbing_check");
  if (includedBenefits.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-300 bg-white p-6">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Membership Benefits</h2>
      <div className="space-y-2">
        {includedBenefits.map((benefitType) => {
          const used = usedTypes.has(benefitType);
          return (
            <div key={benefitType} className="flex items-center justify-between rounded-md border border-gray-200 px-4 py-2">
              <div>
                <p className="text-sm font-medium text-gray-900">{BENEFIT_LABELS[benefitType]}</p>
                {used ? <p className="text-xs text-green-700">Used this period</p> : null}
                {alreadyUsedType === benefitType ? (
                  <p className="text-xs text-amber-700">Already used this period - bill this visit as billable instead.</p>
                ) : null}
                {recordedType === benefitType ? <p className="text-xs text-green-700">Recorded.</p> : null}
              </div>
              {!used ? (
                <button
                  onClick={() => recordUsage.mutate(benefitType)}
                  disabled={recordUsage.isPending}
                  className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
                >
                  {recordUsage.isPending ? "Recording..." : "Mark as used"}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {recordError ? <p className="mt-2 text-sm text-red-600">{recordError}</p> : null}
    </div>
  );
}
