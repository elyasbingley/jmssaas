import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createJobTemplateSchema,
  type JobLifecycleStage,
  type JobTemplate,
  type ServiceCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField, TextAreaField } from "../components/FormField";

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
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-bold text-gray-900">Job Templates</h1>
      <p className="mb-3 mt-1 text-sm text-gray-500">
        Reusable starting points for a new job - pick one from the "New job" screen instead of filling in the category,
        stage, and description by hand each time.
      </p>

      <div className="divide-y divide-gray-100 rounded-lg border border-gray-300 bg-white">
        {(templates ?? []).length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No job templates yet.</p>
        ) : (
          (templates ?? []).map((template) => {
            const category = categoryById.get(template.service_category_id ?? "");
            const stage = stageById.get(template.lifecycle_stage_id ?? "");
            return (
              <div key={template.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">{template.name}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {category ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: category.color ?? "#d1d5db" }} />
                        {category.name}
                      </span>
                    ) : null}
                    {stage ? (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-800">{stage.name}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-3 text-sm">
                  <button onClick={() => openEdit(template)} className="font-semibold text-blue-700 hover:underline">
                    Edit
                  </button>
                  <button onClick={() => handleDelete(template)} className="font-semibold text-red-600 hover:underline">
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <button
        onClick={openNew}
        className="mt-3 w-full rounded-md bg-blue-700 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
      >
        + New job template
      </button>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editingTemplate ? "Edit job template" : "New job template"}>
        <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hot Water System Replacement" />
        <p className="-mt-2 mb-4 text-xs text-gray-500">Also becomes the new job's default title - still editable before saving.</p>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Category"
            value={categoryId}
            onChange={setCategoryId}
            options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
            placeholder="None"
          />
          <SelectField
            label="Stage"
            value={stageId}
            onChange={setStageId}
            options={(stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
            placeholder="None"
          />
        </div>
        <TextAreaField label="Description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveTemplate.mutate()}
            disabled={saveTemplate.isPending || !name.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveTemplate.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
