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
// clients where that's still false. The send buttons reuse the existing
// 'job_review_request' automation message (same one editable from
// Settings > Automation & Messaging) rather than a new template, just
// queued with entity_type 'client' instead of 'job' - process-scheduled-
// comms already has a client-entity branch (see its own comment, added for
// the dormant-client re-engagement campaign) that resolves
// {client_first_name} etc from entity_id directly, so no Edge Function
// changes were needed for this module.
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

type SendChannel = "email" | "sms" | "both";

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
    mutationFn: async ({ client, wantChannel }: { client: Client; wantChannel: SendChannel }) => {
      if (!profile) throw new Error("Not signed in");
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Review request' message is turned off in Settings > Automation & Messaging");
      }
      const wantTypes = wantChannel === "both" ? ["email", "sms"] : [wantChannel];
      const matching = (templates ?? []).filter(
        (t) => wantTypes.includes(t.type) && (rule.channel === "both" || rule.channel === t.type)
      );
      if (matching.length === 0) {
        throw new Error("No active 'Review request' message template found for that channel");
      }

      let anySent = false;
      for (const template of matching) {
        const recipient = template.type === "sms" ? (client.phone ?? "") : (client.email ?? "");
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
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Google Reviews</h1>
        <p className="text-sm text-gray-500">
          {clients?.length ?? 0} client{clients?.length === 1 ? "" : "s"} who haven&apos;t left a review yet
        </p>
      </div>

      <input
        type="text"
        placeholder="Search clients..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />

      <div className="overflow-hidden rounded-lg border border-gray-300 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : filteredClients.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">
            {clients?.length === 0 ? "Every client has been marked as reviewed." : "No clients found."}
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
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
                  <tr key={client.id} className="border-b border-gray-200 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link to={`/clients/${client.id}`} className="font-medium text-blue-700 hover:underline">
                        {client.client_type === "company" && client.company_name ? client.company_name : client.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{client.phone ?? "-"}</td>
                    <td className="px-4 py-3 text-gray-600">{client.email ?? "-"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => sendReviewRequest.mutate({ client, wantChannel: "email" })}
                          disabled={isSending || !client.email}
                          title={client.email ? undefined : "No email on file"}
                          className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Email
                        </button>
                        <button
                          onClick={() => sendReviewRequest.mutate({ client, wantChannel: "sms" })}
                          disabled={isSending || !client.phone}
                          title={client.phone ? undefined : "No phone on file"}
                          className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          SMS
                        </button>
                        <button
                          onClick={() => sendReviewRequest.mutate({ client, wantChannel: "both" })}
                          disabled={isSending || (!client.email && !client.phone)}
                          title={client.email || client.phone ? undefined : "No email or phone on file"}
                          className="rounded-md bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isSending ? "Sending..." : "Both"}
                        </button>
                      </div>
                      {message ? (
                        <p className={`mt-1 text-xs ${message.isError ? "text-red-600" : "text-green-700"}`}>{message.text}</p>
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
