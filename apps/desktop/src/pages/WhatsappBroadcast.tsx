import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Client, WhatsappTemplate } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

// Broadcast a registered WhatsApp template to many clients at once - see
// the whatsapp_broadcasts migration's own comment for why this exists
// (marketing to clients who haven't messaged recently, which Twilio's
// "group" workaround can't reach) and process-whatsapp-broadcast's own
// comment for how sending actually happens. This page only creates the
// broadcast + recipient rows, then repeatedly calls that Edge Function
// (the same broadcast_id each time) until nothing's left queued - that
// loop, not a single call, is what reliably finishes a broadcast of any
// size without needing the tenant to have pg_cron set up.

interface BroadcastRow {
  id: string;
  name: string;
  status: "sending" | "completed";
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  whatsapp_templates: { name: string } | null;
}

async function fetchActiveTemplates(): Promise<WhatsappTemplate[]> {
  const { data, error } = await supabase.from("whatsapp_templates").select("*").eq("is_active", true).order("name");
  if (error) throw error;
  return data as WhatsappTemplate[];
}

async function fetchClients(): Promise<Pick<Client, "id" | "name" | "company_name" | "phone">[]> {
  const { data, error } = await supabase.from("clients").select("id, name, company_name, phone").order("name");
  if (error) throw error;
  return data as Pick<Client, "id" | "name" | "company_name" | "phone">[];
}

async function fetchBroadcasts(): Promise<BroadcastRow[]> {
  const { data, error } = await supabase
    .from("whatsapp_broadcasts")
    .select("id, name, status, total_recipients, sent_count, failed_count, created_at, whatsapp_templates(name)")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data as unknown as BroadcastRow[];
}

// Calls process-whatsapp-broadcast with this broadcast_id repeatedly until
// nothing's left queued for it - a single call only processes one bounded
// batch (see that function's own BATCH_LIMIT), so a broadcast larger than
// one batch needs more than one call to actually finish.
async function dispatchUntilDone(broadcastId: string, onProgress: (sent: number, failed: number) => void): Promise<void> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) throw new Error("Supabase URL not configured");
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");

  let totalSent = 0;
  let totalFailed = 0;
  for (;;) {
    const res = await fetch(`${supabaseUrl}/functions/v1/process-whatsapp-broadcast`, {
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

export default function WhatsappBroadcastPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const { data: templates } = useQuery({ queryKey: ["whatsapp-templates-active"], queryFn: fetchActiveTemplates });
  const { data: clients } = useQuery({ queryKey: ["clients-for-broadcast"], queryFn: fetchClients });
  const { data: broadcasts, isLoading: broadcastsLoading } = useQuery({ queryKey: ["whatsapp-broadcasts"], queryFn: fetchBroadcasts });

  const [templateId, setTemplateId] = useState("");
  const selectedTemplate = (templates ?? []).find((t) => t.id === templateId) ?? null;

  // Per variable: either "use client's name" (per-recipient) or one fixed
  // value sent to everyone (e.g. the company name).
  const [variableModes, setVariableModes] = useState<Record<number, "client_name" | "fixed">>({});
  const [variableFixedValues, setVariableFixedValues] = useState<Record<number, string>>({});

  const [clientSearch, setClientSearch] = useState("");
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());

  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; failed: number } | null>(null);

  const filteredClients = (clients ?? []).filter((c) => `${c.company_name ?? ""} ${c.name}`.toLowerCase().includes(clientSearch.trim().toLowerCase()));
  const selectedClients = (clients ?? []).filter((c) => selectedClientIds.has(c.id));
  const recipientsWithPhone = selectedClients.filter((c) => !!c.phone);
  const recipientsMissingPhone = selectedClients.filter((c) => !c.phone);

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
      if (!selectedTemplate) throw new Error("Choose a template first");
      if (recipientsWithPhone.length === 0) throw new Error("Select at least one client with a phone number on file");

      const { data: broadcast, error: broadcastError } = await supabase
        .from("whatsapp_broadcasts")
        .insert({
          tenant_id: profile!.tenant_id,
          template_id: selectedTemplate.id,
          name: `${selectedTemplate.name} - ${new Date().toLocaleDateString("en-AU")}`,
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
        variable_values: selectedTemplate.variable_labels.map((_, i) => (variableModes[i] === "client_name" ? c.name : variableFixedValues[i] ?? "")),
      }));
      const { error: recipientsError } = await supabase.from("whatsapp_broadcast_recipients").insert(recipientRows);
      if (recipientsError) throw recipientsError;

      setSending(true);
      setProgress({ sent: 0, failed: 0 });
      await dispatchUntilDone(broadcast.id, (sent, failed) => setProgress({ sent, failed }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-broadcasts"] });
      setTemplateId("");
      setVariableModes({});
      setVariableFixedValues({});
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
      queryClient.invalidateQueries({ queryKey: ["whatsapp-broadcasts"] });
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

  const canSend = !!selectedTemplate && recipientsWithPhone.length > 0 && !sending;

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/channels" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Channels
      </Link>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        WhatsApp Broadcast
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Send an approved template to many clients at once, each as its own message - not a WhatsApp group.
      </p>

      {!isAdmin ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Only an admin can send a broadcast.</p>
      ) : (
        <>
          <div className="mb-6 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <label className="mb-1 block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Template
            </label>
            {(templates ?? []).length === 0 ? (
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                No active templates - register one in{" "}
                <Link to="/settings/whatsapp-templates" style={{ color: "var(--jms-accent)" }}>
                  Settings &gt; WhatsApp Templates
                </Link>{" "}
                first.
              </p>
            ) : (
              <select
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  setVariableModes({});
                  setVariableFixedValues({});
                }}
                className="mb-3 w-full rounded border px-3 py-2 focus:outline-none"
                style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
              >
                <option value="">Select a template...</option>
                {(templates ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            {selectedTemplate ? (
              <>
                <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {selectedTemplate.body_preview}
                </p>
                {selectedTemplate.variable_labels.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {selectedTemplate.variable_labels.map((label, i) => (
                      <div key={i}>
                        <label className="mb-1 block" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                          {`{{${i + 1}}}`} {label}
                        </label>
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                            <input
                              type="radio"
                              checked={(variableModes[i] ?? "fixed") === "client_name"}
                              onChange={() => setVariableModes({ ...variableModes, [i]: "client_name" })}
                            />
                            Each client's own name
                          </label>
                          <label className="flex items-center gap-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                            <input
                              type="radio"
                              checked={(variableModes[i] ?? "fixed") === "fixed"}
                              onChange={() => setVariableModes({ ...variableModes, [i]: "fixed" })}
                            />
                            Same for everyone:
                          </label>
                          <input
                            type="text"
                            disabled={(variableModes[i] ?? "fixed") !== "fixed"}
                            value={variableFixedValues[i] ?? ""}
                            onChange={(e) => setVariableFixedValues({ ...variableFixedValues, [i]: e.target.value })}
                            className="flex-1 rounded border px-2 py-1 focus:outline-none disabled:opacity-40"
                            style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
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
                  {!c.phone ? (
                    <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>No phone</span>
                  ) : null}
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
                  {b.whatsapp_templates?.name ?? "Deleted template"} - {b.sent_count} sent, {b.failed_count} failed of {b.total_recipients} -{" "}
                  {new Date(b.created_at).toLocaleString("en-AU")}
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
