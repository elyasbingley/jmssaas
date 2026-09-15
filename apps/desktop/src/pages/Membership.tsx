import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { membershipPlanFormSchema, type ClientMembership, type MembershipPlan, type MembershipStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";

// Membership Module (Munus) - same structural pattern as RealEstate.tsx:
// a settings-style form for the tenant's single plan (see membership_
// plans_and_clients.sql's own comment on why is_active is unique per
// tenant, not per plan row), plus a read-only list of current/past
// members. Enrolling a client happens from the client detail page's own
// Membership tab (it needs a specific client, this page doesn't), not
// here - this page is "manage the offer" + "see who's on it", not an
// enrollment flow.

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

async function fetchPlan(tenantId: string): Promise<MembershipPlan | null> {
  const { data, error } = await supabase
    .from("membership_plans")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as MembershipPlan | null;
}

interface MemberRow extends ClientMembership {
  clients: { name: string } | null;
}

async function fetchMembers(): Promise<MemberRow[]> {
  const { data, error } = await supabase
    .from("client_memberships")
    .select("*, clients(name)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as MemberRow[];
}

const STATUS_LABELS: Record<MembershipStatus, string> = {
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
  expired: "Expired",
};

const STATUS_COLOR_VAR: Record<MembershipStatus, string> = {
  active: "var(--jms-accent)",
  past_due: "var(--jms-warning)",
  cancelled: "var(--jms-text-muted)",
  expired: "var(--jms-text-muted)",
};

export default function MembershipPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: plan } = useQuery({
    queryKey: ["membership-plan", profile?.tenant_id],
    queryFn: () => fetchPlan(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: members } = useQuery({ queryKey: ["client-memberships"], queryFn: fetchMembers });

  const [name, setName] = useState("Membership");
  const [annualPrice, setAnnualPrice] = useState("99");
  const [discountPercent, setDiscountPercent] = useState("10");
  const [waiveCalloutFee, setWaiveCalloutFee] = useState(true);
  const [priorityScheduling, setPriorityScheduling] = useState(true);
  const [sameDayResponse, setSameDayResponse] = useState(false);
  const [roofInspections, setRoofInspections] = useState("1");
  const [plumbingChecks, setPlumbingChecks] = useState("1");
  const [isActive, setIsActive] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (plan) {
      setName(plan.name);
      setAnnualPrice((plan.annual_price_cents / 100).toString());
      setDiscountPercent(plan.discount_percent.toString());
      setWaiveCalloutFee(plan.waive_callout_fee);
      setPriorityScheduling(plan.priority_scheduling);
      setSameDayResponse(plan.same_day_response);
      setRoofInspections(plan.annual_roof_inspections_included.toString());
      setPlumbingChecks(plan.annual_plumbing_checks_included.toString());
      setIsActive(plan.is_active);
    }
  }, [plan]);

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = membershipPlanFormSchema.safeParse({
        name,
        annual_price_cents: Math.round(parseNumber(annualPrice) * 100),
        discount_percent: parseNumber(discountPercent),
        waive_callout_fee: waiveCalloutFee,
        priority_scheduling: priorityScheduling,
        same_day_response: sameDayResponse,
        annual_roof_inspections_included: Math.round(parseNumber(roofInspections)),
        annual_plumbing_checks_included: Math.round(parseNumber(plumbingChecks)),
        is_active: isActive,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      if (plan) {
        const { error } = await supabase.from("membership_plans").update(result.data).eq("id", plan.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("membership_plans").insert({ tenant_id: profile.tenant_id, ...result.data });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["membership-plan", profile?.tenant_id] });
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save membership plan")),
  });

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Membership
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Manage your membership offer (no call-out fee, a discount on repairs, priority scheduling, and included annual checks), and see
        who's currently enrolled.
      </p>

      <div className="mb-8 rounded-lg p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="mb-4 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          The offer
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <ThemedFormField label="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
          <ThemedFormField label="Annual price ($)" type="number" step="0.01" value={annualPrice} onChange={(e) => setAnnualPrice(e.target.value)} />
          <ThemedFormField
            label="Discount on repairs/installations (%)"
            type="number"
            step="1"
            value={discountPercent}
            onChange={(e) => setDiscountPercent(e.target.value)}
          />
          <ThemedFormField
            label="Included annual roof inspections"
            type="number"
            step="1"
            value={roofInspections}
            onChange={(e) => setRoofInspections(e.target.value)}
          />
          <ThemedFormField
            label="Included annual plumbing checks"
            type="number"
            step="1"
            value={plumbingChecks}
            onChange={(e) => setPlumbingChecks(e.target.value)}
          />
        </div>

        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            <input type="checkbox" checked={waiveCalloutFee} onChange={(e) => setWaiveCalloutFee(e.target.checked)} />
            Waive the call-out fee for members
          </label>
          <label className="flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            <input type="checkbox" checked={priorityScheduling} onChange={(e) => setPriorityScheduling(e.target.checked)} />
            Priority scheduling for members
          </label>
          <label className="flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            <input type="checkbox" checked={sameDayResponse} onChange={(e) => setSameDayResponse(e.target.checked)} />
            Same-day response guarantee
          </label>
          <label className="flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Plan is active (visible to enrol new clients into)
          </label>
        </div>

        {saveError ? (
          <p className="mt-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {saveError}
          </p>
        ) : null}
        {saved ? (
          <p className="mt-4" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
            Saved.
          </p>
        ) : null}
        <ThemedButton onClick={() => save.mutate()} disabled={save.isPending} style={{ marginTop: 16 }}>
          {save.isPending ? "Saving..." : "Save"}
        </ThemedButton>
      </div>

      <div className="rounded-lg p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="mb-4 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Members
        </h2>
        {!members || members.length === 0 ? (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No members yet. Enrol a client from their client detail page's Membership tab.
          </p>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <Link
                key={m.id}
                to={`/clients/${m.client_id}`}
                className="jms-nav-link flex items-center justify-between rounded-lg p-3"
                style={{ border: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}
              >
                <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                  {m.clients?.name ?? "Unknown client"}
                </span>
                <div className="flex items-center gap-3">
                  {m.current_period_end ? (
                    <span style={{ color: "var(--jms-text-muted)" }}>
                      {m.status === "active" ? "Renews" : "Ended"} {new Date(m.current_period_end).toLocaleDateString("en-AU")}
                    </span>
                  ) : null}
                  <span
                    className="rounded-full border px-2 py-0.5 font-bold"
                    style={{ borderColor: STATUS_COLOR_VAR[m.status], color: STATUS_COLOR_VAR[m.status], fontSize: "var(--jms-font-label)" }}
                  >
                    {STATUS_LABELS[m.status]}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
