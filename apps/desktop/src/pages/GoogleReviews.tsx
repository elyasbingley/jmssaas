import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Client, CommunicationRule, CommunicationTemplate } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { triggerImmediateDispatch } from "../lib/dispatch-now";

// Manual "who hasn't left us a Google review yet" worklist - there's no
// public API to detect an actual review being left, so left_google_review
// is a plain manual tick (see ClientDetail.tsx), and this list is just
// clients where that's still false. The send button reuses the existing
// 'job_review_request' automation message (same one editable from
// Settings > Automation & Messaging) rather than a new template, just
// queued with entity_type 'client' instead of 'job' - process-scheduled-
// comms already has a client-entity branch (see its own comment, added for
// the dormant-client re-engagement campaign) that resolves
// {client_first_name} etc from entity_id directly, so no Edge Function
// changes were needed for this module.
//
// Email only, deliberately - the communication engine went email-only
// project-wide (see communication_engine_email_only.sql and
// process-scheduled-comms' dispatchOne, which fails any non-email row
// outright). This page used to also offer SMS/"Both" buttons, which
// always failed ("No active 'Review request' message template found for
// that channel", since no sms-type template exists post-migration) -
// removed rather than reintroducing a send path the rest of the app has
// deliberately turned off.
async function fetchUnreviewedClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").eq("left_google_review", false).order("name");
  if (error) throw error;
  return data as Client[];
}

async function fetchReviewRequestRule(tenantId: string): Promise<CommunicationRule | null> {
  const { data, error } = await supabase
    .from("communication_rules")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("trigger_key", "job_review_request")
    .maybeSingle();
  if (error) throw error;
  return data as CommunicationRule | null;
}

async function fetchReviewRequestTemplates(tenantId: string): Promise<CommunicationTemplate[]> {
  const { data, error } = await supabase
    .from("communication_templates")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("trigger_key", "job_review_request")
    .eq("is_active", true);
  if (error) throw error;
  return data as CommunicationTemplate[];
}

export default function GoogleReviewsPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sendingClientId, setSendingClientId] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ clientId: string; text: string; isError: boolean } | null>(null);

  const { data: clients, isLoading } = useQuery({ queryKey: ["google-review-clients"], queryFn: fetchUnreviewedClients });
  const { data: rule } = useQuery({
    queryKey: ["communication-rule", "job_review_request", profile?.tenant_id],
    queryFn: () => fetchReviewRequestRule(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: templates } = useQuery({
    queryKey: ["communication-templates", "job_review_request", profile?.tenant_id],
    queryFn: () => fetchReviewRequestTemplates(profile!.tenant_id),
    enabled: !!profile,
  });

  const sendReviewRequest = useMutation({
    mutationFn: async ({ client }: { client: Client }) => {
      if (!profile) throw new Error("Not signed in");
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Review request' message is turned off in Settings > Automation & Messaging");
      }
      const matching = (templates ?? []).filter((t) => t.type === "email");
      if (matching.length === 0) {
        throw new Error("No active 'Review request' email template found");
      }

      let anySent = false;
      for (const template of matching) {
        const recipient = client.email ?? "";
        if (!recipient) continue;
        const { data: row, error } = await supabase
          .from("scheduled_communications")
          .insert({
            tenant_id: profile.tenant_id,
            entity_type: "client",
            entity_id: client.id,
            trigger_key: "job_review_request",
            template_id: template.id,
            channel: template.type,
            recipient_phone_or_email: recipient,
            rendered_subject: template.subject,
            rendered_body: template.body,
            scheduled_for: new Date().toISOString(),
            status: "pending",
          })
          .select("id")
          .single();
        if (error) throw error;
        if (await triggerImmediateDispatch(row.id)) anySent = true;
      }
      return anySent;
    },
    onMutate: ({ client }) => setSendingClientId(client.id),
    onSuccess: (anySent, { client }) => {
      queryClient.invalidateQueries({ queryKey: ["communication-log"] });
      setRowMessage({
        clientId: client.id,
        text: anySent ? "Sent." : "Queued - will send shortly.",
        isError: false,
      });
      setTimeout(() => setRowMessage(null), 5000);
    },
    onError: (e, { client }) => setRowMessage({ clientId: client.id, text: getErrorMessage(e, "Failed to send"), isError: true }),
    onSettled: () => setSendingClientId(null),
  });

  const filteredClients = (clients ?? []).filter((c) =>
    `${c.company_name ?? ""} ${c.name}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Google Reviews
        </h1>
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          {clients?.length ?? 0} client{clients?.length === 1 ? "" : "s"} who haven&apos;t left a review yet
        </p>
      </div>

      <input
        type="text"
        placeholder="Search clients..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 w-full max-w-sm rounded-md px-3 py-2 focus:outline-none"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
      />

      <div className="overflow-hidden rounded-lg" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : filteredClients.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            {clients?.length === 0 ? "Every client has been marked as reviewed." : "No clients found."}
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Phone</th>
                <th className="px-4 py-2 font-semibold">Email</th>
                <th className="px-4 py-2 font-semibold">Send review request</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map((client) => {
                const isSending = sendingClientId === client.id;
                const message = rowMessage?.clientId === client.id ? rowMessage : null;
                return (
                  <tr key={client.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3">
                      <Link to={`/clients/${client.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {client.client_type === "company" && client.company_name ? client.company_name : client.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {client.phone ?? "-"}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {client.email ?? "-"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => sendReviewRequest.mutate({ client })}
                          disabled={isSending || !client.email}
                          title={client.email ? undefined : "No email on file"}
                          className="rounded-md border px-2.5 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                        >
                          {isSending ? "Sending..." : "Send email"}
                        </button>
                      </div>
                      {message ? (
                        <p className="mt-1" style={{ color: message.isError ? "var(--jms-danger)" : "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                          {message.text}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
