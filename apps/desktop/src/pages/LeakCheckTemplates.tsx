import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createLeakCheckTemplateSchema, type LeakCheckTemplate } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

// List of Leak Check Checklist templates (e.g. "Quick Check", "Full
// Inspection") - each one's categories/items are managed on its own detail
// page (LeakCheckTemplateDetail.tsx), same list -> detail split as Bundles.

async function fetchTemplates(): Promise<(LeakCheckTemplate & { item_count: number })[]> {
  const { data, error } = await supabase
    .from("leak_check_templates")
    .select("*, leak_check_template_items(count)")
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return ((data ?? []) as (LeakCheckTemplate & { leak_check_template_items: { count: number }[] })[]).map((row) => ({
    ...row,
    item_count: row.leak_check_template_items?.[0]?.count ?? 0,
  }));
}

export default function LeakCheckTemplatesPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: templates, isLoading } = useQuery({ queryKey: ["leak-check-templates"], queryFn: fetchTemplates });

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const createTemplate = useMutation({
    mutationFn: async () => {
      const result = createLeakCheckTemplateSchema.safeParse({ name, description: description || null, sort_order: templates?.length ?? 0 });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid template");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("leak_check_templates").insert({ ...result.data, tenant_id: profile.tenant_id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leak-check-templates"] });
      setModalOpen(false);
      setName("");
      setDescription("");
      setFormError(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create template")),
  });

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Leak Check Templates
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Starting-point checklists (e.g. "Quick Check", "Full Inspection") a technician picks from to start a leak check on a job.
          </p>
        </div>
        <ThemedButton onClick={() => setModalOpen(true)}>+ New template</ThemedButton>
      </div>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : !templates || templates.length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No templates yet.
          </p>
        ) : (
          templates.map((template) => (
            <Link
              key={template.id}
              to={`/settings/leak-check-templates/${template.id}`}
              className="jms-nav-link flex items-center justify-between gap-3 p-3 last:border-0"
              style={{ borderBottom: "1px solid var(--jms-border)" }}
            >
              <div className="min-w-0">
                <span className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {template.name}
                </span>
                {template.description ? (
                  <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    {template.description}
                  </p>
                ) : null}
              </div>
              <span className="flex-shrink-0" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {template.item_count} item{template.item_count === 1 ? "" : "s"}
              </span>
            </Link>
          ))
        )}
      </div>

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title="New template">
        <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Full Inspection" />
        <ThemedFormField
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Full residential leak check - every fixture"
        />
        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createTemplate.mutate()} disabled={createTemplate.isPending || !name.trim()}>
            {createTemplate.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
