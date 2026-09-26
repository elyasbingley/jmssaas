import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientMembership, MembershipBenefitType, MembershipBenefitUsage, MembershipStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { ThemedPanel } from "./theme/ThemedPanel";
import { ThemedButton } from "./theme/ThemedButton";

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

const STATUS_COLOR_VAR: Record<MembershipStatus, string> = {
  active: "var(--jms-accent)",
  past_due: "var(--jms-warning)",
  cancelled: "var(--jms-text-muted)",
  expired: "var(--jms-text-muted)",
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
    <ThemedPanel title="Membership" className="mt-6">
      {active ? (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span
              className="inline-block whitespace-nowrap rounded border px-2 py-0.5 uppercase tracking-wide"
              style={{ borderColor: STATUS_COLOR_VAR[active.status], color: STATUS_COLOR_VAR[active.status], fontSize: "var(--jms-font-label)" }}
            >
              {STATUS_LABELS[active.status]}
            </span>
            {active.current_period_end ? (
              <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                Renews {new Date(active.current_period_end).toLocaleDateString("en-AU")}
              </span>
            ) : null}
          </div>

          <h3 className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Benefit usage this period
          </h3>
          {!benefitUsage || benefitUsage.length === 0 ? (
            <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              No included benefits used yet this period.
            </p>
          ) : (
            <div className="mb-3 space-y-1">
              {benefitUsage.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between rounded border px-3 py-1.5"
                  style={{ borderColor: "var(--jms-border)", fontSize: "var(--jms-font-body)" }}
                >
                  <span style={{ color: "var(--jms-text)" }}>{BENEFIT_LABELS[u.benefit_type]}</span>
                  <span style={{ color: "var(--jms-text-muted)" }}>{new Date(u.used_at).toLocaleDateString("en-AU")}</span>
                </div>
              ))}
            </div>
          )}

          {cancelError ? (
            <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {cancelError}
            </p>
          ) : null}
          <ThemedButton variant="danger" onClick={() => cancelMembership.mutate()} disabled={cancelMembership.isPending}>
            {cancelMembership.isPending ? "Cancelling..." : "Cancel membership"}
          </ThemedButton>
        </div>
      ) : (
        <div>
          <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            This client isn't a member yet.
          </p>
          {checkoutUrl ? (
            <div className="rounded-md border p-3" style={{ borderColor: "var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
              <p className="mb-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                Send this link to the client to complete enrollment:
              </p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={checkoutUrl}
                  className="min-w-0 flex-1 rounded border px-2 py-1"
                  style={{
                    borderColor: "var(--jms-border)",
                    backgroundColor: "var(--jms-surface)",
                    color: "var(--jms-text)",
                    fontSize: "var(--jms-font-label)",
                  }}
                />
                <ThemedButton variant="secondary" onClick={copyCheckoutUrl} className="flex-shrink-0" style={{ paddingBlock: 6, paddingInline: 12 }}>
                  {copied ? "Copied" : "Copy"}
                </ThemedButton>
              </div>
            </div>
          ) : (
            <ThemedButton onClick={handleEnrol} disabled={enrolling}>
              {enrolling ? "Creating link..." : "Enrol in Membership"}
            </ThemedButton>
          )}
          {enrolError ? (
            <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {enrolError}
            </p>
          ) : null}
        </div>
      )}

      {past.length > 0 ? (
        <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--jms-border)" }}>
          <h3 className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Past memberships
          </h3>
          <div className="space-y-1">
            {past.map((m) => (
              <div key={m.id} className="flex items-center justify-between" style={{ fontSize: "var(--jms-font-body)" }}>
                <span
                  className="inline-block whitespace-nowrap rounded border px-2 py-0.5 uppercase tracking-wide"
                  style={{ borderColor: STATUS_COLOR_VAR[m.status], color: STATUS_COLOR_VAR[m.status], fontSize: "var(--jms-font-label)" }}
                >
                  {STATUS_LABELS[m.status]}
                </span>
                <span style={{ color: "var(--jms-text-muted)" }}>
                  {new Date(m.started_at).toLocaleDateString("en-AU")}
                  {m.cancelled_at ? ` - ${new Date(m.cancelled_at).toLocaleDateString("en-AU")}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </ThemedPanel>
  );
}
