import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createFinePrintTemplateSchema, updateFinePrintTemplateSchema, type FinePrintTemplate } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

// Settings page for fine_print_templates - same flat list + single-modal
// create/edit shape as SmsTemplates.tsx. Picking a template on a quote/
// invoice copies its body in as a frozen snapshot (see the fine_print_
// templates migration's own comment) - editing a template here never
// changes an already-created quote/invoice.

async function fetchTemplates(): Promise<FinePrintTemplate[]> {
  const { data, error } = await supabase.from("fine_print_templates").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as FinePrintTemplate[];
}

interface TemplateDraft {
  id?: string;
  name: string;
  body: string;
}

export default function FinePrintTemplatesPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const { data: templates, isLoading } = useQuery({ queryKey: ["fine-print-templates"], queryFn: fetchTemplates });

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setDraft({ name: "", body: "" });
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (t: FinePrintTemplate) => {
    setDraft({ id: t.id, name: t.name, body: t.body });
    setFormError(null);
    setModalOpen(true);
  };

  const createTemplate = useMutation({
    mutationFn: async (input: { name: string; body: string }) => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase
        .from("fine_print_templates")
        .insert({ ...input, tenant_id: profile.tenant_id, created_by: profile.id, sort_order: templates?.length ?? 0 });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fine-print-templates"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template")),
  });

  const updateTemplate = useMutation({
    mutationFn: async (input: { id: string; name: string; body: string }) => {
      const { error } = await supabase.from("fine_print_templates").update({ name: input.name, body: input.body }).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fine-print-templates"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("fine_print_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["fine-print-templates"] }),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to delete template")),
  });

  const handleSave = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const body = draft.body;
    const schema = draft.id ? updateFinePrintTemplateSchema : createFinePrintTemplateSchema;
    const result = schema.safeParse({ name, body });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (draft.id) {
      updateTemplate.mutate({ id: draft.id, name, body });
    } else {
      createTemplate.mutate({ name, body });
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
            Fine Print Templates
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Reusable terms/conditions text - pick one from a dropdown on any quote or invoice.
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
              <p className="mb-1 font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {t.name}
              </p>
              <p className="line-clamp-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {t.body || "(empty)"}
              </p>
            </button>
          ))}
        </div>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={draft?.id ? "Edit Template" : "New Template"}>
        {draft ? (
          <>
            <ThemedFormField label="Template name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Standard Terms" />
            <ThemedTextAreaField
              label="Fine print"
              rows={6}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="e.g. Warranty terms, payment conditions, liability clauses..."
            />

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
