import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { membershipPlanFormSchema, type ClientMembership, type MembershipPlan, type MembershipStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { FormField } from "../components/FormField";

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

const STATUS_CLASSES: Record<MembershipStatus, string> = {
  active: "bg-green-100 text-green-700",
  past_due: "bg-amber-100 text-amber-700",
  cancelled: "bg-gray-100 text-gray-600",
  expired: "bg-gray-100 text-gray-600",
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
    <div className="p-8">
      <h1 className="mb-1 text-xl font-bold text-gray-900">Membership</h1>
      <p className="mb-6 text-sm text-gray-500">
        Manage your membership offer (no call-out fee, a discount on repairs, priority scheduling, and included annual checks), and see
        who's currently enrolled.
      </p>

      <div className="mb-8 rounded-lg border border-gray-300 bg-white p-6">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-gray-500">The offer</h2>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
          <FormField label="Annual price ($)" type="number" step="0.01" value={annualPrice} onChange={(e) => setAnnualPrice(e.target.value)} />
          <FormField label="Discount on repairs/installations (%)" type="number" step="1" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />
          <FormField label="Included annual roof inspections" type="number" step="1" value={roofInspections} onChange={(e) => setRoofInspections(e.target.value)} />
          <FormField label="Included annual plumbing checks" type="number" step="1" value={plumbingChecks} onChange={(e) => setPlumbingChecks(e.target.value)} />
        </div>

        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={waiveCalloutFee} onChange={(e) => setWaiveCalloutFee(e.target.checked)} />
            Waive the call-out fee for members
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={priorityScheduling} onChange={(e) => setPriorityScheduling(e.target.checked)} />
            Priority scheduling for members
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={sameDayResponse} onChange={(e) => setSameDayResponse(e.target.checked)} />
            Same-day response guarantee
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Plan is active (visible to enrol new clients into)
          </label>
        </div>

        {saveError ? <p className="mt-4 text-sm text-red-600">{saveError}</p> : null}
        {saved ? <p className="mt-4 text-sm text-green-700">Saved.</p> : null}
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="mt-4 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {save.isPending ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="rounded-lg border border-gray-300 bg-white p-6">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-gray-500">Members</h2>
        {!members || members.length === 0 ? (
          <p className="text-sm text-gray-500">
            No members yet. Enrol a client from their client detail page's Membership tab.
          </p>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <Link
                key={m.id}
                to={`/clients/${m.client_id}`}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-3 text-sm hover:bg-gray-50"
              >
                <span className="font-semibold text-gray-900">{m.clients?.name ?? "Unknown client"}</span>
                <div className="flex items-center gap-3">
                  {m.current_period_end ? (
                    <span className="text-gray-500">
                      {m.status === "active" ? "Renews" : "Ended"} {new Date(m.current_period_end).toLocaleDateString("en-AU")}
                    </span>
                  ) : null}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_CLASSES[m.status]}`}>
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
