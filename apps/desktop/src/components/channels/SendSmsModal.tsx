import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Client, ChannelMessageTemplate, PlaceholderContext } from "@jmssaas/shared";
import { ALL_PLACEHOLDER_TOKENS, renderTemplate } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../theme/ThemedFormField";

// One SMS compose modal, used both by QuoteDetail's "Send Quote via SMS"
// button (mode="fixed" - the recipient is already known: the quote's
// client) and by Channels' "+ New Message" flow (mode="picker" - the
// admin has to choose an existing client or type a number first). Mirrors
// EmailComposeModal's own shape: this component owns the compose UI and
// delegates the actual send (and any side effects - updating a quote's
// status, invalidating queries, navigating to the new conversation) to the
// caller's `onSend`, closing itself only once that resolves.

export interface PhoneOption {
  label: string;
  value: string;
}

async function fetchClientsForPicker(): Promise<Pick<Client, "id" | "name" | "first_name" | "company_name" | "phone">[]> {
  const { data, error } = await supabase.from("clients").select("id, name, first_name, company_name, phone").order("name");
  if (error) throw error;
  return data as Pick<Client, "id" | "name" | "first_name" | "company_name" | "phone">[];
}

async function fetchClientContactPhones(clientId: string): Promise<PhoneOption[]> {
  const { data, error } = await supabase.from("client_contacts").select("name, phone").eq("client_id", clientId);
  if (error) throw error;
  return (data ?? [])
    .filter((c) => !!c.phone)
    .map((c) => ({ label: `${c.name} (${c.phone})`, value: c.phone as string }));
}

async function fetchTemplates(): Promise<ChannelMessageTemplate[]> {
  const { data, error } = await supabase.from("channel_message_templates").select("*").order("name");
  if (error) throw error;
  return data as ChannelMessageTemplate[];
}

interface SendSmsModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  sendLabel?: string;
  mode: "fixed" | "picker";
  // mode="picker" only - lets Channels' "+ New Message" offer a choice of
  // channel when the tenant has more than one outbound number configured.
  // Omitted (or a single-entry array) renders no toggle at all - every
  // other caller (QuoteDetail/InvoiceDetail's fixed-mode SMS buttons) is
  // unaffected.
  channelType?: "sms" | "whatsapp";
  onChannelTypeChange?: (channelType: "sms" | "whatsapp") => void;
  availableChannelTypes?: ("sms" | "whatsapp")[];
  // mode="fixed" only - the recipient is already known (e.g. the quote's
  // client); the phone field still starts out editable.
  fixedPhone?: string;
  fixedClientId?: string;
  fixedContactName?: string;
  fixedPhoneOptions?: PhoneOption[];
  // Prefilled message body, e.g. the rendered quote-link template.
  defaultBody?: string;
  // Company (+ quote, etc for the fixed/QuoteDetail case) placeholder
  // context - used to render a template when "Insert template" is
  // clicked. In picker mode, the currently-selected client (if any) is
  // merged in automatically so {client_full_name} etc. still resolve.
  renderContextBase: PlaceholderContext;
  onSend: (payload: { phone: string; body: string; clientId?: string; contactName?: string }) => Promise<void>;
}

export function SendSmsModal({
  open,
  onClose,
  title,
  sendLabel,
  mode,
  channelType,
  onChannelTypeChange,
  availableChannelTypes,
  fixedPhone,
  fixedClientId,
  fixedContactName,
  fixedPhoneOptions,
  defaultBody,
  renderContextBase,
  onSend,
}: SendSmsModalProps) {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [recipientTab, setRecipientTab] = useState<"client" | "manual">("client");
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<Pick<Client, "id" | "name" | "first_name" | "company_name" | "phone"> | null>(null);
  const [manualPhone, setManualPhone] = useState("");
  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<{ id?: string; name: string; body: string; isQuoteDefault: boolean } | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const templateBodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setBody(defaultBody ?? "");
    setSendError(null);
    setTemplatesOpen(false);
    setTemplateDraft(null);
    setTemplateError(null);
    if (mode === "fixed") {
      setPhone(fixedPhone ?? "");
    } else {
      setPhone("");
      setRecipientTab("client");
      setClientSearch("");
      setSelectedClient(null);
      setManualPhone("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, fixedPhone, defaultBody]);

  const { data: clients } = useQuery({
    queryKey: ["clients-for-sms-picker"],
    queryFn: fetchClientsForPicker,
    enabled: open && mode === "picker" && recipientTab === "client",
  });
  const { data: contactOptions } = useQuery({
    queryKey: ["client-contact-phones", selectedClient?.id],
    queryFn: () => fetchClientContactPhones(selectedClient!.id),
    enabled: !!selectedClient,
  });

  const { data: templates, isLoading: templatesLoading } = useQuery({
    queryKey: ["channel-message-templates"],
    queryFn: fetchTemplates,
    enabled: open,
  });

  // At most one is_quote_default row per tenant (a partial unique index
  // enforces this server-side too) - turning one on has to clear whichever
  // other row currently holds it first, in its own statement, since a
  // plain insert/update racing the unique index would just fail outright.
  const clearOtherQuoteDefaults = async (excludeId?: string) => {
    let query = supabase.from("channel_message_templates").update({ is_quote_default: false }).eq("tenant_id", profile!.tenant_id).eq("is_quote_default", true);
    if (excludeId) query = query.neq("id", excludeId);
    const { error } = await query;
    if (error) throw error;
  };

  const createTemplate = useMutation({
    mutationFn: async (input: { name: string; body: string; isQuoteDefault: boolean }) => {
      if (input.isQuoteDefault) await clearOtherQuoteDefaults();
      const { error } = await supabase
        .from("channel_message_templates")
        .insert({ tenant_id: profile!.tenant_id, name: input.name, body: input.body, is_quote_default: input.isQuoteDefault, created_by: profile!.id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channel-message-templates"] });
      setTemplateDraft(null);
      setTemplateError(null);
    },
    onError: (e) => setTemplateError(getErrorMessage(e, "Failed to save template")),
  });

  const updateTemplate = useMutation({
    mutationFn: async (input: { id: string; name: string; body: string; isQuoteDefault: boolean }) => {
      if (input.isQuoteDefault) await clearOtherQuoteDefaults(input.id);
      const { error } = await supabase
        .from("channel_message_templates")
        .update({ name: input.name, body: input.body, is_quote_default: input.isQuoteDefault })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channel-message-templates"] });
      setTemplateDraft(null);
      setTemplateError(null);
    },
    onError: (e) => setTemplateError(getErrorMessage(e, "Failed to save template")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("channel_message_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channel-message-templates"] }),
    onError: (e) => setTemplateError(getErrorMessage(e, "Failed to delete template")),
  });

  // Picking a client (picker mode) auto-fills the phone field from their
  // primary number once their contacts have loaded, same "prefer primary,
  // fall back to a contact" idea QuoteDetail's own SMS button uses.
  useEffect(() => {
    if (mode !== "picker" || recipientTab !== "client" || !selectedClient) return;
    if (selectedClient.phone) {
      setPhone(selectedClient.phone);
    } else if (contactOptions && contactOptions.length > 0) {
      setPhone(contactOptions[0]!.value);
    } else {
      setPhone("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient, contactOptions, mode, recipientTab]);

  const clientId = mode === "fixed" ? fixedClientId : recipientTab === "client" ? selectedClient?.id : undefined;
  const contactName = mode === "fixed" ? fixedContactName : recipientTab === "client" ? selectedClient?.name : undefined;
  const phoneOptions = mode === "fixed" ? fixedPhoneOptions : recipientTab === "client" ? contactOptions : undefined;

  const insertAtCursor = (text: string) => {
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => `${b}${text}`);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${text}${body.slice(end)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Same cursor-insert behaviour as insertAtCursor above, but targets the
  // template draft's own body field (+New template/editing an existing
  // one) rather than the message being composed right now.
  const insertTokenIntoDraft = (token: string) => {
    if (!templateDraft) return;
    const text = `{${token}}`;
    const el = templateBodyRef.current;
    if (!el) {
      setTemplateDraft({ ...templateDraft, body: `${templateDraft.body}${text}` });
      return;
    }
    const start = el.selectionStart ?? templateDraft.body.length;
    const end = el.selectionEnd ?? templateDraft.body.length;
    const next = `${templateDraft.body.slice(0, start)}${text}${templateDraft.body.slice(end)}`;
    setTemplateDraft({ ...templateDraft, body: next });
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const useTemplate = (template: ChannelMessageTemplate) => {
    const context: PlaceholderContext =
      mode === "picker" && selectedClient
        ? { ...renderContextBase, client: { name: selectedClient.name, first_name: selectedClient.first_name, phone: selectedClient.phone, email: null } }
        : renderContextBase;
    insertAtCursor(renderTemplate(template.body, context));
    setTemplatesOpen(false);
  };

  const filteredClients = (clients ?? []).filter((c) =>
    `${c.company_name ?? ""} ${c.name}`.toLowerCase().includes(clientSearch.trim().toLowerCase())
  );

  const canSend = phone.trim().length > 0 && body.trim().length > 0 && !sending;

  const handleSend = async () => {
    setSending(true);
    setSendError(null);
    try {
      await onSend({ phone: phone.trim(), body: body.trim(), clientId, contactName });
      onClose();
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to send message"));
    } finally {
      setSending(false);
    }
  };

  const saveTemplateDraft = () => {
    if (!templateDraft) return;
    const name = templateDraft.name.trim();
    const draftBody = templateDraft.body.trim();
    if (!name || !draftBody) {
      setTemplateError("Name and message are required");
      return;
    }
    if (templateDraft.id) {
      updateTemplate.mutate({ id: templateDraft.id, name, body: draftBody, isQuoteDefault: templateDraft.isQuoteDefault });
    } else {
      createTemplate.mutate({ name, body: draftBody, isQuoteDefault: templateDraft.isQuoteDefault });
    }
  };

  return (
    <ThemedModal open={open} onClose={onClose} title={title}>
      {mode === "picker" && onChannelTypeChange && availableChannelTypes && availableChannelTypes.length > 1 ? (
        <div className="mb-3 flex gap-2">
          {availableChannelTypes.map((ct) => (
            <button
              key={ct}
              onClick={() => onChannelTypeChange(ct)}
              className="rounded-full border px-3 py-1.5 font-semibold"
              style={
                channelType === ct
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
              }
            >
              {ct === "sms" ? "💬 SMS" : "🟢 WhatsApp"}
            </button>
          ))}
        </div>
      ) : null}

      {mode === "picker" ? (
        <div className="mb-4">
          <div className="mb-3 flex gap-2">
            {(["client", "manual"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setRecipientTab(tab)}
                className="rounded-full border px-3 py-1.5 font-semibold"
                style={
                  recipientTab === tab
                    ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                    : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                }
              >
                {tab === "client" ? "Existing client" : "Manual number"}
              </button>
            ))}
          </div>

          {recipientTab === "client" ? (
            <div>
              <input
                type="text"
                placeholder="Search clients..."
                value={selectedClient ? selectedClient.name : clientSearch}
                onChange={(e) => {
                  setClientSearch(e.target.value);
                  setSelectedClient(null);
                }}
                className="mb-2 w-full rounded border px-3 py-2 focus:outline-none"
                style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
              />
              {!selectedClient && clientSearch.trim() ? (
                <div className="mb-2 max-h-40 overflow-y-auto rounded border" style={{ borderColor: "var(--jms-border)" }}>
                  {filteredClients.length === 0 ? (
                    <p className="px-3 py-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                      No matching clients.
                    </p>
                  ) : (
                    filteredClients.slice(0, 20).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setSelectedClient(c);
                          setClientSearch("");
                        }}
                        className="jms-nav-link block w-full px-3 py-2 text-left"
                        style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                      >
                        {c.name}
                        {c.company_name ? ` - ${c.company_name}` : ""}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <input
              type="tel"
              placeholder="0491 570 156"
              value={manualPhone}
              onChange={(e) => {
                setManualPhone(e.target.value);
                setPhone(e.target.value);
              }}
              className="w-full rounded border px-3 py-2 focus:outline-none"
              style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            />
          )}
        </div>
      ) : null}

      <ThemedFormField label="Phone number" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0491 570 156" />

      {phoneOptions && phoneOptions.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {phoneOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPhone(opt.value)}
              className="rounded-full border px-2 py-1"
              style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              Use: {opt.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mb-1 flex items-center justify-between">
        <label className="block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Message
        </label>
        <button
          onClick={() => setTemplatesOpen((v) => !v)}
          className="font-semibold hover:underline"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
        >
          {templatesOpen ? "Hide templates" : "Insert template ▾"}
        </button>
      </div>

      {templatesOpen ? (
        <div className="mb-3 rounded border p-3" style={{ borderColor: "var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
          {templatesLoading ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading templates...</p>
          ) : (templates ?? []).length === 0 && !templateDraft ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No templates yet.</p>
          ) : (
            <div className="mb-2 flex flex-col gap-1">
              {(templates ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  <button
                    onClick={() => useTemplate(t)}
                    className="jms-nav-link min-w-0 flex-1 truncate rounded px-2 py-1 text-left"
                    style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                    title={t.body}
                  >
                    <span className="font-semibold">{t.name}</span>
                    {t.is_quote_default ? (
                      <span className="ml-1" style={{ color: "var(--jms-accent)" }} title="Default body for &quot;Send Quote via SMS&quot;">
                        ★ Quote default
                      </span>
                    ) : null}
                    <span style={{ color: "var(--jms-text-muted)" }}> - {t.body}</span>
                  </button>
                  {isAdmin ? (
                    <>
                      <button
                        onClick={() => {
                          setTemplateDraft({ id: t.id, name: t.name, body: t.body, isQuoteDefault: t.is_quote_default });
                          setTemplateError(null);
                        }}
                        aria-label={`Edit ${t.name}`}
                        style={{ color: "var(--jms-text-muted)" }}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete template "${t.name}"?`)) deleteTemplate.mutate(t.id);
                        }}
                        aria-label={`Delete ${t.name}`}
                        style={{ color: "var(--jms-danger)" }}
                      >
                        🗑
                      </button>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {isAdmin ? (
            templateDraft ? (
              <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--jms-border)" }}>
                <ThemedFormField
                  label="Template name"
                  value={templateDraft.name}
                  onChange={(e) => setTemplateDraft({ ...templateDraft, name: e.target.value })}
                />
                <div className="mb-2 flex flex-wrap gap-1">
                  {ALL_PLACEHOLDER_TOKENS.map((token) => (
                    <button
                      key={token}
                      onClick={() => insertTokenIntoDraft(token)}
                      className="rounded px-2 py-1 font-semibold"
                      style={{ backgroundColor: "var(--jms-accent-glow)", border: "1px solid var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                    >
                      {`{${token}}`}
                    </button>
                  ))}
                </div>
                <ThemedTextAreaField
                  ref={templateBodyRef}
                  label="Template message"
                  rows={3}
                  value={templateDraft.body}
                  onChange={(e) => setTemplateDraft({ ...templateDraft, body: e.target.value })}
                />
                <label
                  className="mb-2 flex items-center gap-2 font-semibold"
                  style={{ color: templateDraft.isQuoteDefault ? "var(--jms-accent)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                >
                  <input
                    type="checkbox"
                    checked={templateDraft.isQuoteDefault}
                    onChange={(e) => setTemplateDraft({ ...templateDraft, isQuoteDefault: e.target.checked })}
                  />
                  Use as default message for "Send Quote via SMS"
                </label>
                {templateError ? (
                  <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                    {templateError}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setTemplateDraft(null)}
                    className="px-3 py-1 font-semibold"
                    style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                  >
                    Cancel
                  </button>
                  <ThemedButton
                    onClick={saveTemplateDraft}
                    disabled={createTemplate.isPending || updateTemplate.isPending}
                    style={{ paddingBlock: 6, paddingInline: 12 }}
                  >
                    {createTemplate.isPending || updateTemplate.isPending ? "Saving..." : "Save template"}
                  </ThemedButton>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setTemplateDraft({ name: "", body: "", isQuoteDefault: false });
                  setTemplateError(null);
                }}
                className="font-semibold hover:underline"
                style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
              >
                + New template
              </button>
            )
          ) : null}
        </div>
      ) : null}

      <ThemedTextAreaField ref={bodyRef} label="Message" labelHidden rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      <p className="mb-4 -mt-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {body.length} characters
      </p>

      {sendError ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {sendError}
        </p>
      ) : null}

      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Cancel
        </button>
        <ThemedButton onClick={handleSend} disabled={!canSend}>
          {sending ? "Sending..." : sendLabel ?? "Send SMS"}
        </ThemedButton>
      </div>
    </ThemedModal>
  );
}
