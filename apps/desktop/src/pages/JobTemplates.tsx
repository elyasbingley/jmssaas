import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  createJobTemplateSchema,
  type JobLifecycleStage,
  type JobTemplate,
  type ServiceCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

// Same list+modal CRUD shape as JobSetup.tsx's service categories/lifecycle
// stages sections - a standalone settings page (rather than folded into
// Job Setup) since the person asked for "a setting called Job Templates"
// by name. Picked from Jobs.tsx's "New Job" modal to prefill title/
// description/category/stage instead of filling every field by hand.

async function fetchTemplates(): Promise<JobTemplate[]> {
  const { data, error } = await supabase.from("job_templates").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as JobTemplate[];
}
async function fetchCategories(): Promise<ServiceCategory[]> {
  const { data, error } = await supabase.from("service_categories").select("*").order("name");
  if (error) throw error;
  return data as ServiceCategory[];
}
async function fetchStages(): Promise<JobLifecycleStage[]> {
  const { data, error } = await supabase.from("job_lifecycle_stages").select("*").order("position");
  if (error) throw error;
  return data as JobLifecycleStage[];
}

export default function JobTemplatesPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: templates } = useQuery({ queryKey: ["job-templates"], queryFn: fetchTemplates });
  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const categoryById = new Map((categories ?? []).map((c) => [c.id, c]));
  const stageById = new Map((stages ?? []).map((s) => [s.id, s]));

  const invalidateTemplates = () => queryClient.invalidateQueries({ queryKey: ["job-templates"] });

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<JobTemplate | null>(null);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [stageId, setStageId] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setEditingTemplate(null);
    setName("");
    setCategoryId("");
    setStageId("");
    setDescription("");
    setFormError(null);
    setModalOpen(true);
  };
  const openEdit = (template: JobTemplate) => {
    setEditingTemplate(template);
    setName(template.name);
    setCategoryId(template.service_category_id ?? "");
    setStageId(template.lifecycle_stage_id ?? "");
    setDescription(template.description ?? "");
    setFormError(null);
    setModalOpen(true);
  };

  const saveTemplate = useMutation({
    mutationFn: async () => {
      const result = createJobTemplateSchema.safeParse({
        name,
        service_category_id: categoryId || undefined,
        lifecycle_stage_id: stageId || undefined,
        description: description || undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid template");
      if (!profile) throw new Error("Not signed in");

      if (editingTemplate) {
        const { error } = await supabase
          .from("job_templates")
          .update({
            name: result.data.name,
            service_category_id: result.data.service_category_id ?? null,
            lifecycle_stage_id: result.data.lifecycle_stage_id ?? null,
            description: result.data.description || null,
          })
          .eq("id", editingTemplate.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("job_templates").insert({
          tenant_id: profile.tenant_id,
          name: result.data.name,
          service_category_id: result.data.service_category_id ?? null,
          lifecycle_stage_id: result.data.lifecycle_stage_id ?? null,
          description: result.data.description || null,
          sort_order: result.data.sort_order,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateTemplates();
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save template")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (template: JobTemplate) => {
      const { error } = await supabase.from("job_templates").delete().eq("id", template.id);
      if (error) throw error;
    },
    onSuccess: invalidateTemplates,
  });

  const handleDelete = (template: JobTemplate) => {
    if (window.confirm(`Delete "${template.name}"?`)) deleteTemplate.mutate(template);
  };

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Job Templates
      </h1>
      <p className="mb-3 mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Reusable starting points for a new job - pick one from the "New job" screen instead of filling in the category,
        stage, and description by hand each time.
      </p>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {(templates ?? []).length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No job templates yet.
          </p>
        ) : (
          (templates ?? []).map((template) => {
            const category = categoryById.get(template.service_category_id ?? "");
            const stage = stageById.get(template.lifecycle_stage_id ?? "");
            return (
              <div
                key={template.id}
                className="flex items-center justify-between gap-3 p-3 last:border-0"
                style={{ borderBottom: "1px solid var(--jms-border)" }}
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                    {template.name}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {category ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                        style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: category.color ?? "var(--jms-text-muted)" }} />
                        {category.name}
                      </span>
                    ) : null}
                    {stage ? (
                      <span
                        className="rounded-full border px-2 py-0.5 font-semibold"
                        style={{ borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
                      >
                        {stage.name}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                  <button onClick={() => openEdit(template)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                    Edit
                  </button>
                  <button onClick={() => handleDelete(template)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <ThemedButton onClick={openNew} className="mt-3 w-full" style={{ paddingBlock: 12, paddingInline: 24 }}>
        + New job template
      </ThemedButton>

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={editingTemplate ? "Edit job template" : "New job template"}>
        <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hot Water System Replacement" />
        <p className="-mt-2 mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Also becomes the new job's default title - still editable before saving.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <ThemedSelectField
            label="Category"
            value={categoryId}
            onChange={setCategoryId}
            options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
            placeholder="None"
          />
          <ThemedSelectField
            label="Stage"
            value={stageId}
            onChange={setStageId}
            options={(stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
            placeholder="None"
          />
        </div>
        <ThemedTextAreaField label="Description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveTemplate.mutate()} disabled={saveTemplate.isPending || !name.trim()}>
            {saveTemplate.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
