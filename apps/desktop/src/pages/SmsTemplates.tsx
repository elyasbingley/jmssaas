import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ALL_PLACEHOLDER_TOKENS, createChannelMessageTemplateSchema, updateChannelMessageTemplateSchema, type ChannelMessageTemplate } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

// Standalone Settings page for channel_message_templates - desktop
// previously only let an admin manage these from inside the SendSmsModal
// compose flow (its own "Insert template" panel), with no dedicated place
// to just go look at/edit them, unlike mobile which already has
// app/channels/templates.tsx reachable from Settings. Same CRUD, same
// is_quote_default toggle and token picker as that inline panel - this
// page and SendSmsModal's panel are two separate UIs over the same table,
// kept in sync by hand since neither is complex enough to warrant
// extracting a shared component across a settings page and a modal panel.

async function fetchTemplates(): Promise<ChannelMessageTemplate[]> {
  const { data, error } = await supabase.from("channel_message_templates").select("*").order("name");
  if (error) throw error;
  return data as ChannelMessageTemplate[];
}

interface TemplateDraft {
  id?: string;
  name: string;
  body: string;
  isQuoteDefault: boolean;
  isInvoiceDefault: boolean;
}

export default function SmsTemplatesPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const { data: templates, isLoading } = useQuery({ queryKey: ["channel-message-templates"], queryFn: fetchTemplates });

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setDraft({ name: "", body: "", isQuoteDefault: false, isInvoiceDefault: false });
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (t: ChannelMessageTemplate) => {
    setDraft({ id: t.id, name: t.name, body: t.body, isQuoteDefault: t.is_quote_default, isInvoiceDefault: t.is_invoice_default });
    setFormError(null);
    setModalOpen(true);
  };

  const insertToken = (token: string) => {
    if (!draft) return;
    const text = `{${token}}`;
    const el = bodyRef.current;
    if (!el) {
      setDraft({ ...draft, body: `${draft.body}${text}` });
      return;
    }
    const start = el.selectionStart ?? draft.body.length;
    const end = el.selectionEnd ?? draft.body.length;
    const next = `${draft.body.slice(0, start)}${text}${draft.body.slice(end)}`;
    setDraft({ ...draft, body: next });
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // At most one is_quote_default row per tenant (a partial unique index
  // enforces this server-side too) - clear whichever other row currently
  // holds it first, in its own statement, since a plain insert/update
  // racing the unique index would just fail outright.
  const clearOtherQuoteDefaults = async (excludeId?: string) => {
    let query = supabase.from("channel_message_templates").update({ is_quote_default: false }).eq("tenant_id", profile!.tenant_id).eq("is_quote_default", true);
    if (excludeId) query = query.neq("id", excludeId);
    const { error } = await query;
    if (error) throw error;
  };

  // Same idea as clearOtherQuoteDefaults - its own partial unique index.
  const clearOtherInvoiceDefaults = async (excludeId?: string) => {
    let query = supabase
      .from("channel_message_templates")
      .update({ is_invoice_default: false })
      .eq("tenant_id", profile!.tenant_id)
      .eq("is_invoice_default", true);
    if (excludeId) query = query.neq("id", excludeId);
    const { error } = await query;
    if (error) throw error;
  };

  const createTemplate = useMutation({
    mutationFn: async (input: { name: string; body: string; isQuoteDefault: boolean; isInvoiceDefault: boolean }) => {
      if (input.isQuoteDefault) await clearOtherQuoteDefaults();
      if (input.isInvoiceDefault) await clearOtherInvoiceDefaults();
      const { error } = await supabase.from("channel_message_templates").insert({
        tenant_id: profile!.tenant_id,
        name: input.name,
        body: input.body,
        is_quote_default: input.isQuoteDefault,
        is_invoice_default: input.isInvoiceDefault,
        created_by: profile!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channel-message-templates"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template")),
  });

  const updateTemplate = useMutation({
    mutationFn: async (input: { id: string; name: string; body: string; isQuoteDefault: boolean; isInvoiceDefault: boolean }) => {
      if (input.isQuoteDefault) await clearOtherQuoteDefaults(input.id);
      if (input.isInvoiceDefault) await clearOtherInvoiceDefaults(input.id);
      const { error } = await supabase
        .from("channel_message_templates")
        .update({ name: input.name, body: input.body, is_quote_default: input.isQuoteDefault, is_invoice_default: input.isInvoiceDefault })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channel-message-templates"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("channel_message_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channel-message-templates"] }),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to delete template")),
  });

  const handleSave = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const body = draft.body.trim();
    const schema = draft.id ? updateChannelMessageTemplateSchema : createChannelMessageTemplateSchema;
    const result = schema.safeParse({ name, body });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (draft.id) {
      updateTemplate.mutate({ id: draft.id, name, body, isQuoteDefault: draft.isQuoteDefault, isInvoiceDefault: draft.isInvoiceDefault });
    } else {
      createTemplate.mutate({ name, body, isQuoteDefault: draft.isQuoteDefault, isInvoiceDefault: draft.isInvoiceDefault });
    }
  };

  const handleDelete = () => {
    if (!draft?.id) return;
    if (window.confirm(`Delete template "${draft.name}"?`)) deleteTemplate.mutate(draft.id);
  };

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            SMS Templates
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Reusable canned text for Channels' "New Message" and "Send Quote via SMS".
          </p>
        </div>
        {isAdmin ? <ThemedButton onClick={openNew}>+ New Template</ThemedButton> : null}
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : (templates ?? []).length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No templates yet{isAdmin ? " - click + New Template to add one." : "."}
        </p>
      ) : (
        <div className="space-y-3">
          {(templates ?? []).map((t) => (
            <button
              key={t.id}
              onClick={() => (isAdmin ? openEdit(t) : undefined)}
              disabled={!isAdmin}
              className="jms-nav-link block w-full rounded-lg p-4 text-left"
              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {t.name}
                </span>
                {t.is_quote_default ? (
                  <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }} title='Default body for "Send Quote via SMS"'>
                    ★ Quote default
                  </span>
                ) : null}
                {t.is_invoice_default ? (
                  <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }} title='Default body for "Send Invoice via SMS"'>
                    ★ Invoice default
                  </span>
                ) : null}
              </div>
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{t.body}</p>
            </button>
          ))}
        </div>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={draft?.id ? "Edit Template" : "New Template"}>
        {draft ? (
          <>
            <ThemedFormField label="Template name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />

            <div className="mb-2 flex flex-wrap gap-1">
              {ALL_PLACEHOLDER_TOKENS.map((token) => (
                <button
                  key={token}
                  onClick={() => insertToken(token)}
                  className="rounded px-2 py-1 font-semibold"
                  style={{ backgroundColor: "var(--jms-accent-glow)", border: "1px solid var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                >
                  {`{${token}}`}
                </button>
              ))}
            </div>

            <ThemedTextAreaField ref={bodyRef} label="Message" rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />

            <label
              className="mb-2 flex items-center gap-2 font-semibold"
              style={{ color: draft.isQuoteDefault ? "var(--jms-accent)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <input type="checkbox" checked={draft.isQuoteDefault} onChange={(e) => setDraft({ ...draft, isQuoteDefault: e.target.checked })} />
              Use as default message for "Send Quote via SMS"
            </label>
            <label
              className="mb-4 flex items-center gap-2 font-semibold"
              style={{ color: draft.isInvoiceDefault ? "var(--jms-accent)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <input type="checkbox" checked={draft.isInvoiceDefault} onChange={(e) => setDraft({ ...draft, isInvoiceDefault: e.target.checked })} />
              Use as default message for "Send Invoice via SMS"
            </label>

            {formError ? (
              <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                {formError}
              </p>
            ) : null}

            <div className="flex items-center justify-between">
              {draft.id ? (
                <button onClick={handleDelete} className="font-semibold" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-3">
                <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                  Cancel
                </button>
                <ThemedButton onClick={handleSave} disabled={createTemplate.isPending || updateTemplate.isPending}>
                  {createTemplate.isPending || updateTemplate.isPending ? "Saving..." : "Save"}
                </ThemedButton>
              </div>
            </div>
          </>
        ) : null}
      </ThemedModal>
    </div>
  );
}
