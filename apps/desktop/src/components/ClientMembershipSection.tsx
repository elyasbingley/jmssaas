import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientMembership, MembershipBenefitType, MembershipBenefitUsage, MembershipStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";

// Client detail page's Membership section - enrol (via Stripe Checkout),
// view the current membership's status/benefit usage, and see enrollment
// history. Self-contained, same "drop into any page, fetches its own
// data" shape as QuoteToolsSection/KeyManagementDashboard - ClientDetail.tsx
// just renders <ClientMembershipSection clientId={id!} />.

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

const BENEFIT_LABELS: Record<MembershipBenefitType, string> = {
  annual_roof_inspection: "Annual roof inspection",
  annual_plumbing_check: "Annual plumbing check",
};

async function fetchMemberships(clientId: string): Promise<ClientMembership[]> {
  const { data, error } = await supabase
    .from("client_memberships")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as ClientMembership[];
}

async function fetchBenefitUsage(clientMembershipId: string): Promise<MembershipBenefitUsage[]> {
  const { data, error } = await supabase
    .from("membership_benefit_usage")
    .select("*")
    .eq("client_membership_id", clientMembershipId)
    .order("used_at", { ascending: false });
  if (error) throw error;
  return data as MembershipBenefitUsage[];
}

export function ClientMembershipSection({ clientId }: { clientId: string }) {
  const queryClient = useQueryClient();
  const { data: memberships } = useQuery({ queryKey: ["client-memberships", clientId], queryFn: () => fetchMemberships(clientId) });

  const active = (memberships ?? []).find((m) => m.status === "active" || m.status === "past_due");
  const past = (memberships ?? []).filter((m) => m !== active);

  const { data: benefitUsage } = useQuery({
    queryKey: ["membership-benefit-usage", active?.id],
    queryFn: () => fetchBenefitUsage(active!.id),
    enabled: !!active,
  });

  const [enrolling, setEnrolling] = useState(false);
  const [enrolError, setEnrolError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const handleEnrol = async () => {
    setEnrolling(true);
    setEnrolError(null);
    setCheckoutUrl(null);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/create-membership-checkout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error) {
        if (resBody.error === "stripe_not_connected") throw new Error("Connect Stripe in Settings before enrolling a client.");
        if (resBody.error === "no_active_plan") throw new Error("Set up a membership plan on the Membership page first.");
        throw new Error(resBody.detail || resBody.error || "Failed to create enrollment link");
      }
      setCheckoutUrl(resBody.checkout_url as string);
    } catch (e) {
      setEnrolError(getErrorMessage(e, "Failed to create enrollment link"));
    } finally {
      setEnrolling(false);
    }
  };

  const [copied, setCopied] = useState(false);
  const copyCheckoutUrl = async () => {
    if (!checkoutUrl) return;
    await navigator.clipboard.writeText(checkoutUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelMembership = useMutation({
    mutationFn: async () => {
      if (!active) return;
      const { error } = await supabase
        .from("client_memberships")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", active.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client-memberships", clientId] }),
    onError: (e) => setCancelError(getErrorMessage(e, "Failed to cancel membership")),
  });

  return (
    <div className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Membership</h2>

      {active ? (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_CLASSES[active.status]}`}>
              {STATUS_LABELS[active.status]}
            </span>
            {active.current_period_end ? (
              <span className="text-sm text-gray-500">
                Renews {new Date(active.current_period_end).toLocaleDateString("en-AU")}
              </span>
            ) : null}
          </div>

          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Benefit usage this period</h3>
          {!benefitUsage || benefitUsage.length === 0 ? (
            <p className="mb-3 text-sm text-gray-500">No included benefits used yet this period.</p>
          ) : (
            <div className="mb-3 space-y-1">
              {benefitUsage.map((u) => (
                <div key={u.id} className="flex items-center justify-between rounded border border-gray-200 px-3 py-1.5 text-sm">
                  <span className="text-gray-900">{BENEFIT_LABELS[u.benefit_type]}</span>
                  <span className="text-gray-500">{new Date(u.used_at).toLocaleDateString("en-AU")}</span>
                </div>
              ))}
            </div>
          )}

          {cancelError ? <p className="mb-2 text-sm text-red-600">{cancelError}</p> : null}
          <button
            onClick={() => cancelMembership.mutate()}
            disabled={cancelMembership.isPending}
            className="text-sm font-semibold text-red-600 hover:underline disabled:opacity-60"
          >
            {cancelMembership.isPending ? "Cancelling..." : "Cancel membership"}
          </button>
        </div>
      ) : (
        <div>
          <p className="mb-3 text-sm text-gray-500">This client isn't a member yet.</p>
          {checkoutUrl ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
              <p className="mb-2 text-sm text-gray-700">Send this link to the client to complete enrollment:</p>
              <div className="flex items-center gap-2">
                <input readOnly value={checkoutUrl} className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700" />
                <button onClick={copyCheckoutUrl} className="flex-shrink-0 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800">
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleEnrol}
              disabled={enrolling}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {enrolling ? "Creating link..." : "Enrol in Membership"}
            </button>
          )}
          {enrolError ? <p className="mt-2 text-sm text-red-600">{enrolError}</p> : null}
        </div>
      )}

      {past.length > 0 ? (
        <div className="mt-4 border-t border-gray-200 pt-3">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Past memberships</h3>
          <div className="space-y-1">
            {past.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_CLASSES[m.status]}`}>{STATUS_LABELS[m.status]}</span>
                <span className="text-gray-500">
                  {new Date(m.started_at).toLocaleDateString("en-AU")}
                  {m.cancelled_at ? ` - ${new Date(m.cancelled_at).toLocaleDateString("en-AU")}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
