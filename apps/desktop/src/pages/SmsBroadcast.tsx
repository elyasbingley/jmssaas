import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Client } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "../components/theme/ThemedButton";

// Broadcast a plain-text SMS to many clients at once - see the
// sms_broadcasts migration's own comment for why this is simpler than
// WhatsApp's version (no Content Template requirement) and
// process-sms-broadcast's own comment for how sending actually happens.
// This page only renders each recipient's final text and creates the
// broadcast + recipient rows, then repeatedly calls that Edge Function
// (the same broadcast_id each time) until nothing's left queued - same
// "loop, not a single call" shape as WhatsappBroadcast.tsx.
//
// Spam Act 2003: Send is blocked until the message includes an opt-out
// instruction (checked for the word "stop", case-insensitive - covers
// "reply STOP to opt out" and any reasonable variant of it) - see this
// page's own STOP_HINT text. twilio-sms-webhook watches every inbound
// reply for STOP/UNSUBSCRIBE/etc. and sets marketing_opt_out, which this
// page's recipient list already excludes.

const DEFAULT_BODY = "Hi {client_first_name}, it's been a while since your last service with us - let us know if you'd like us to take a look at anything. Reply STOP to opt out.";

interface BroadcastRow {
  id: string;
  name: string;
  status: "sending" | "completed";
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
}

async function fetchClients(): Promise<Pick<Client, "id" | "name" | "first_name" | "company_name" | "phone" | "marketing_opt_out">[]> {
  const { data, error } = await supabase.from("clients").select("id, name, first_name, company_name, phone, marketing_opt_out").order("name");
  if (error) throw error;
  return data as Pick<Client, "id" | "name" | "first_name" | "company_name" | "phone" | "marketing_opt_out">[];
}

async function fetchBroadcasts(): Promise<BroadcastRow[]> {
  const { data, error } = await supabase
    .from("sms_broadcasts")
    .select("id, name, status, total_recipients, sent_count, failed_count, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data as BroadcastRow[];
}

// Only the two merge fields that make sense for a marketing blast (no
// job/quote/invoice context exists here) - a small, purpose-built
// substitution rather than pulling in packages/shared's full placeholder
// engine (built for communication_templates' much larger token set).
function renderSmsBody(template: string, firstName: string, companyName: string): string {
  return template.replaceAll("{client_first_name}", firstName || "there").replaceAll("{company_name}", companyName);
}

async function dispatchUntilDone(broadcastId: string, onProgress: (sent: number, failed: number) => void): Promise<void> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) throw new Error("Supabase URL not configured");
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");

  let totalSent = 0;
  let totalFailed = 0;
  for (;;) {
    const res = await fetch(`${supabaseUrl}/functions/v1/process-sms-broadcast`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast_id: broadcastId }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.detail || body.error || "Failed to send broadcast");
    totalSent += body.sent ?? 0;
    totalFailed += body.failed ?? 0;
    onProgress(totalSent, totalFailed);
    if (!body.remaining) break;
  }
}

export default function SmsBroadcastPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const { data: tenant } = useQuery({
    queryKey: ["tenant-name-for-sms-broadcast", profile?.tenant_id],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select("name").eq("id", profile!.tenant_id).single();
      if (error) throw error;
      return data as { name: string };
    },
    enabled: !!profile,
  });
  const { data: clients } = useQuery({ queryKey: ["clients-for-sms-broadcast"], queryFn: fetchClients });
  const { data: broadcasts, isLoading: broadcastsLoading } = useQuery({ queryKey: ["sms-broadcasts"], queryFn: fetchBroadcasts });

  const [broadcastName, setBroadcastName] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState(DEFAULT_BODY);
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());

  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; failed: number } | null>(null);

  // Already excludes anyone who's opted out - never even shown as
  // selectable, not just unchecked, so there's no way to send to them by
  // accident.
  const eligibleClients = (clients ?? []).filter((c) => !c.marketing_opt_out);
  const filteredClients = eligibleClients.filter((c) => `${c.company_name ?? ""} ${c.name}`.toLowerCase().includes(clientSearch.trim().toLowerCase()));
  const selectedClients = eligibleClients.filter((c) => selectedClientIds.has(c.id));
  const recipientsWithPhone = selectedClients.filter((c) => !!c.phone);
  const recipientsMissingPhone = selectedClients.filter((c) => !c.phone);

  const hasOptOutHint = /stop/i.test(bodyTemplate);
  const previewClient = recipientsWithPhone[0];
  const previewText = previewClient
    ? renderSmsBody(bodyTemplate, previewClient.first_name || previewClient.name.split(" ")[0] || "", tenant?.name ?? "")
    : renderSmsBody(bodyTemplate, "Jane", tenant?.name ?? "");

  const toggleClient = (id: string) => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      filteredClients.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const createBroadcast = useMutation({
    mutationFn: async () => {
      if (!bodyTemplate.trim()) throw new Error("Write a message first");
      if (!hasOptOutHint) throw new Error('Message must include an opt-out instruction (e.g. "Reply STOP to opt out")');
      if (recipientsWithPhone.length === 0) throw new Error("Select at least one client with a phone number on file");

      const companyName = tenant?.name ?? "";
      const { data: broadcast, error: broadcastError } = await supabase
        .from("sms_broadcasts")
        .insert({
          tenant_id: profile!.tenant_id,
          name: broadcastName.trim() || `SMS broadcast - ${new Date().toLocaleDateString("en-AU")}`,
          body_template: bodyTemplate,
          total_recipients: recipientsWithPhone.length,
          created_by: profile!.id,
        })
        .select("id")
        .single();
      if (broadcastError || !broadcast) throw broadcastError ?? new Error("Failed to create broadcast");

      const recipientRows = recipientsWithPhone.map((c) => ({
        broadcast_id: broadcast.id,
        tenant_id: profile!.tenant_id,
        client_id: c.id,
        phone: c.phone,
        rendered_body: renderSmsBody(bodyTemplate, c.first_name || c.name.split(" ")[0] || "", companyName),
      }));
      const { error: recipientsError } = await supabase.from("sms_broadcast_recipients").insert(recipientRows);
      if (recipientsError) throw recipientsError;

      setSending(true);
      setProgress({ sent: 0, failed: 0 });
      await dispatchUntilDone(broadcast.id, (sent, failed) => setProgress({ sent, failed }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-broadcasts"] });
      setBroadcastName("");
      setBodyTemplate(DEFAULT_BODY);
      setSelectedClientIds(new Set());
      setSending(false);
    },
    onError: (e) => {
      setSendError(getErrorMessage(e, "Failed to send broadcast"));
      setSending(false);
    },
  });

  const resumeBroadcast = useMutation({
    mutationFn: async (broadcastId: string) => {
      setSending(true);
      setProgress({ sent: 0, failed: 0 });
      await dispatchUntilDone(broadcastId, (sent, failed) => setProgress({ sent, failed }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-broadcasts"] });
      setSending(false);
    },
    onError: (e) => {
      setSendError(getErrorMessage(e, "Failed to resume broadcast"));
      setSending(false);
    },
  });

  const handleSend = () => {
    setSendError(null);
    createBroadcast.mutate();
  };

  const canSend = !!bodyTemplate.trim() && hasOptOutHint && recipientsWithPhone.length > 0 && !sending;

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/clients" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Clients
      </Link>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        SMS Broadcast
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Send a plain-text message to many clients at once, each as its own SMS - not a group message.
      </p>

      {!isAdmin ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Only an admin can send a broadcast.</p>
      ) : (
        <>
          <div className="mb-6 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <label className="mb-1 block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Broadcast name (optional)
            </label>
            <input
              type="text"
              value={broadcastName}
              onChange={(e) => setBroadcastName(e.target.value)}
              placeholder="e.g. Spring maintenance push"
              className="mb-4 w-full rounded border px-3 py-2 focus:outline-none"
              style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            />

            <div className="mb-1 flex items-center justify-between">
              <label className="block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Message
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setBodyTemplate((t) => `${t}{client_first_name}`)}
                  className="font-semibold hover:underline"
                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                >
                  Insert first name
                </button>
                <button
                  onClick={() => setBodyTemplate((t) => `${t}{company_name}`)}
                  className="font-semibold hover:underline"
                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                >
                  Insert company name
                </button>
              </div>
            </div>
            <textarea
              value={bodyTemplate}
              onChange={(e) => setBodyTemplate(e.target.value)}
              rows={4}
              className="mb-2 w-full rounded border px-3 py-2 focus:outline-none"
              style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            />
            {!hasOptOutHint ? (
              <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                Must include an opt-out instruction (e.g. "Reply STOP to opt out") before you can send.
              </p>
            ) : null}
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Preview{previewClient ? ` (as ${previewClient.name})` : ""}: "{previewText}"
            </p>
          </div>

          <div className="mb-6 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <div className="mb-2 flex items-center justify-between">
              <label className="block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Recipients ({recipientsWithPhone.length} selected{recipientsMissingPhone.length > 0 ? `, ${recipientsMissingPhone.length} skipped - no phone on file` : ""})
              </label>
              <button onClick={selectAllFiltered} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                Select all shown
              </button>
            </div>
            <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {(clients ?? []).length - eligibleClients.length > 0
                ? `${(clients ?? []).length - eligibleClients.length} client${(clients ?? []).length - eligibleClients.length === 1 ? "" : "s"} opted out of marketing texts - not shown here.`
                : ""}
            </p>
            <input
              type="text"
              placeholder="Search clients..."
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              className="mb-2 w-full rounded border px-3 py-2 focus:outline-none"
              style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            />
            <div className="max-h-64 overflow-y-auto rounded border" style={{ borderColor: "var(--jms-border)" }}>
              {filteredClients.slice(0, 200).map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <input type="checkbox" checked={selectedClientIds.has(c.id)} onChange={() => toggleClient(c.id)} />
                  <span style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                    {c.name}
                    {c.company_name ? ` - ${c.company_name}` : ""}
                  </span>
                  {!c.phone ? <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>No phone</span> : null}
                </label>
              ))}
            </div>
          </div>

          {sendError ? (
            <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {sendError}
            </p>
          ) : null}
          {sending && progress ? (
            <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Sending... {progress.sent} sent, {progress.failed} failed
            </p>
          ) : null}

          <ThemedButton onClick={handleSend} disabled={!canSend}>
            {sending ? "Sending..." : `Send to ${recipientsWithPhone.length} client${recipientsWithPhone.length === 1 ? "" : "s"}`}
          </ThemedButton>
        </>
      )}

      <h2 className="mb-3 mt-10 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Recent broadcasts
      </h2>
      {broadcastsLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : (broadcasts ?? []).length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No broadcasts sent yet.</p>
      ) : (
        <div className="space-y-2">
          {(broadcasts ?? []).map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
              <div>
                <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {b.name}
                </p>
                <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {b.sent_count} sent, {b.failed_count} failed of {b.total_recipients} - {new Date(b.created_at).toLocaleString("en-AU")}
                </p>
              </div>
              {b.status === "sending" ? (
                <ThemedButton onClick={() => resumeBroadcast.mutate(b.id)} disabled={sending} style={{ paddingBlock: 6, paddingInline: 12 }}>
                  Continue sending
                </ThemedButton>
              ) : (
                <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Completed</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
