import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createWhatsappTemplateSchema, updateWhatsappTemplateSchema, type WhatsappTemplate } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

// Settings page for whatsapp_templates - registering a WhatsApp Content
// Template already approved by Meta (built/submitted in the Twilio Console,
// not here - see docs/SETUP.md). This is deliberately not another
// SmsTemplates.tsx-style free-text editor: the actual approved copy and
// its {{1}}, {{2}}... variable slots live on Twilio's side under the
// Content SID, so all this page does is record that SID plus enough
// metadata (name, a copy of the approved text for reference, and a label
// per variable) for the Channels "New Message"/broadcast UI to offer it
// and know what to ask for per recipient.

async function fetchTemplates(): Promise<WhatsappTemplate[]> {
  const { data, error } = await supabase.from("whatsapp_templates").select("*").order("name");
  if (error) throw error;
  return data as WhatsappTemplate[];
}

interface TemplateDraft {
  id?: string;
  name: string;
  contentSid: string;
  bodyPreview: string;
  variableLabels: string[];
  isActive: boolean;
}

export default function WhatsappTemplatesPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const { data: templates, isLoading } = useQuery({ queryKey: ["whatsapp-templates"], queryFn: fetchTemplates });

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setDraft({ name: "", contentSid: "", bodyPreview: "", variableLabels: [], isActive: true });
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (t: WhatsappTemplate) => {
    setDraft({ id: t.id, name: t.name, contentSid: t.content_sid, bodyPreview: t.body_preview, variableLabels: [...t.variable_labels], isActive: t.is_active });
    setFormError(null);
    setModalOpen(true);
  };

  const createTemplate = useMutation({
    mutationFn: async (input: { name: string; content_sid: string; body_preview: string; variable_labels: string[] }) => {
      const { error } = await supabase.from("whatsapp_templates").insert({ tenant_id: profile!.tenant_id, created_by: profile!.id, ...input });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template - check the Content SID isn't already registered")),
  });

  const updateTemplate = useMutation({
    mutationFn: async (input: { id: string; name: string; content_sid: string; body_preview: string; variable_labels: string[]; is_active: boolean }) => {
      const { id, ...rest } = input;
      const { error } = await supabase.from("whatsapp_templates").update(rest).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("whatsapp_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-templates"] }),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to delete template")),
  });

  const handleSave = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const contentSid = draft.contentSid.trim();
    const bodyPreview = draft.bodyPreview.trim();
    const variableLabels = draft.variableLabels.map((l) => l.trim()).filter(Boolean);
    const schema = draft.id ? updateWhatsappTemplateSchema : createWhatsappTemplateSchema;
    const result = schema.safeParse({ name, content_sid: contentSid, body_preview: bodyPreview, variable_labels: variableLabels });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (draft.id) {
      updateTemplate.mutate({ id: draft.id, name, content_sid: contentSid, body_preview: bodyPreview, variable_labels: variableLabels, is_active: draft.isActive });
    } else {
      createTemplate.mutate({ name, content_sid: contentSid, body_preview: bodyPreview, variable_labels: variableLabels });
    }
  };

  const handleDelete = () => {
    if (!draft?.id) return;
    if (window.confirm(`Delete template "${draft.name}"?`)) deleteTemplate.mutate(draft.id);
  };

  const updateVariableLabel = (index: number, value: string) => {
    if (!draft) return;
    const next = [...draft.variableLabels];
    next[index] = value;
    setDraft({ ...draft, variableLabels: next });
  };

  const addVariableLabel = () => {
    if (!draft) return;
    setDraft({ ...draft, variableLabels: [...draft.variableLabels, ""] });
  };

  const removeVariableLabel = (index: number) => {
    if (!draft) return;
    setDraft({ ...draft, variableLabels: draft.variableLabels.filter((_, i) => i !== index) });
  };

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            WhatsApp Templates
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Meta-approved templates for messaging someone first, or broadcasting to many clients at once. Build and submit
            the template itself in the Twilio Console (Content Template Builder) - register its Content SID here once approved.
          </p>
        </div>
        {isAdmin ? <ThemedButton onClick={openNew}>+ Register Template</ThemedButton> : null}
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : (templates ?? []).length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No templates registered yet{isAdmin ? " - click + Register Template once you have an approved Content SID." : "."}
        </p>
      ) : (
        <div className="space-y-3">
          {(templates ?? []).map((t) => (
            <button
              key={t.id}
              onClick={() => (isAdmin ? openEdit(t) : undefined)}
              disabled={!isAdmin}
              className="jms-nav-link block w-full rounded-lg p-4 text-left"
              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", opacity: t.is_active ? 1 : 0.6 }}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {t.name}
                </span>
                {!t.is_active ? (
                  <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Inactive</span>
                ) : null}
              </div>
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{t.body_preview}</p>
              <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)", fontFamily: "monospace" }}>
                {t.content_sid}
              </p>
            </button>
          ))}
        </div>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={draft?.id ? "Edit Template" : "Register Template"}>
        {draft ? (
          <>
            <ThemedFormField label="Template name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <ThemedFormField
              label="Content SID"
              value={draft.contentSid}
              onChange={(e) => setDraft({ ...draft, contentSid: e.target.value })}
              placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <ThemedTextAreaField
              label="Approved template text (for reference only)"
              rows={3}
              value={draft.bodyPreview}
              onChange={(e) => setDraft({ ...draft, bodyPreview: e.target.value })}
              placeholder="Hi {{1}}, time for your seasonal checkup from {{2}}. Reply to book."
            />

            <div className="mb-1 flex items-center justify-between">
              <label className="block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Variables (in {"{{1}}, {{2}}"}... order)
              </label>
              <button onClick={addVariableLabel} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                + Add variable
              </button>
            </div>
            {draft.variableLabels.length === 0 ? (
              <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                No variables - this template sends as-is to everyone.
              </p>
            ) : (
              <div className="mb-3 flex flex-col gap-2">
                {draft.variableLabels.map((label, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)", fontFamily: "monospace" }}>{`{{${i + 1}}}`}</span>
                    <input
                      type="text"
                      value={label}
                      onChange={(e) => updateVariableLabel(i, e.target.value)}
                      placeholder="e.g. Client first name"
                      className="flex-1 rounded border px-2 py-1 focus:outline-none"
                      style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                    />
                    <button onClick={() => removeVariableLabel(i)} aria-label={`Remove variable ${i + 1}`} style={{ color: "var(--jms-danger)" }}>
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}

            {draft.id ? (
              <label
                className="mb-4 flex items-center gap-2 font-semibold"
                style={{ color: draft.isActive ? "var(--jms-text-muted)" : "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
              >
                <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
                Active (uncheck to retire without deleting - broadcast history stays intact)
              </label>
            ) : null}

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
