import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  createJobLifecycleStageSchema,
  createLeadSourceSchema,
  createServiceCategorySchema,
  type JobLifecycleStage,
  type LeadSource,
  type ServiceCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

// Direct port of apps/mobile/app/job-setup.tsx - same two admin-managed
// lists (service categories, job lifecycle stages), same tap-based
// reordering (no drag-and-drop) for stages. Desktop reads/writes both
// tables with plain Supabase calls instead of PowerSync's execute(), since
// this app has no offline mode.

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
async function fetchLeadSources(): Promise<LeadSource[]> {
  const { data, error } = await supabase.from("lead_sources").select("*").order("sort_order");
  if (error) throw error;
  return data as LeadSource[];
}

export default function JobSetupPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const { data: leadSources } = useQuery({ queryKey: ["lead-sources"], queryFn: fetchLeadSources });

  const invalidateCategories = () => queryClient.invalidateQueries({ queryKey: ["service-categories"] });
  const invalidateStages = () => queryClient.invalidateQueries({ queryKey: ["job-lifecycle-stages"] });
  const invalidateLeadSources = () => queryClient.invalidateQueries({ queryKey: ["lead-sources"] });

  // --- Service categories ---
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ServiceCategory | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState("");
  const [categoryMaintenanceInterval, setCategoryMaintenanceInterval] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const openNewCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryColor("");
    setCategoryMaintenanceInterval("");
    setCategoryError(null);
    setCategoryModalOpen(true);
  };
  const openEditCategory = (category: ServiceCategory) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryColor(category.color ?? "");
    setCategoryMaintenanceInterval(
      category.maintenance_interval_months != null ? String(category.maintenance_interval_months) : ""
    );
    setCategoryError(null);
    setCategoryModalOpen(true);
  };

  const saveCategory = useMutation({
    mutationFn: async () => {
      const result = createServiceCategorySchema.safeParse({
        name: categoryName,
        color: categoryColor || undefined,
        maintenance_interval_months: categoryMaintenanceInterval ? Number(categoryMaintenanceInterval) : undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid category");
      if (!profile) throw new Error("Not signed in");

      if (editingCategory) {
        const { error } = await supabase
          .from("service_categories")
          .update({
            name: result.data.name,
            color: result.data.color || null,
            maintenance_interval_months: result.data.maintenance_interval_months ?? null,
          })
          .eq("id", editingCategory.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("service_categories").insert({
          tenant_id: profile.tenant_id,
          name: result.data.name,
          color: result.data.color || null,
          maintenance_interval_months: result.data.maintenance_interval_months ?? null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateCategories();
      setCategoryModalOpen(false);
    },
    onError: (e) => setCategoryError(getErrorMessage(e, "Failed to save category")),
  });

  const deleteCategory = useMutation({
    mutationFn: async (category: ServiceCategory) => {
      const { error } = await supabase.from("service_categories").delete().eq("id", category.id);
      if (error) throw error;
    },
    onSuccess: invalidateCategories,
  });

  const handleDeleteCategory = (category: ServiceCategory) => {
    if (window.confirm(`Delete "${category.name}"? Jobs using it will just lose the tag.`)) {
      deleteCategory.mutate(category);
    }
  };

  // --- Job lifecycle stages ---
  const [stageModalOpen, setStageModalOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<JobLifecycleStage | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageColor, setStageColor] = useState("");
  const [stageIsClosed, setStageIsClosed] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  const openNewStage = () => {
    setEditingStage(null);
    setStageName("");
    setStageColor("");
    setStageIsClosed(false);
    setStageError(null);
    setStageModalOpen(true);
  };
  const openEditStage = (stage: JobLifecycleStage) => {
    setEditingStage(stage);
    setStageName(stage.name);
    setStageColor(stage.color ?? "");
    setStageIsClosed(stage.is_closed);
    setStageError(null);
    setStageModalOpen(true);
  };

  const saveStage = useMutation({
    mutationFn: async () => {
      const list = stages ?? [];
      const nextPosition = list.length > 0 ? Math.max(...list.map((s) => s.position)) + 1 : 1;
      const result = createJobLifecycleStageSchema.safeParse({
        name: stageName,
        color: stageColor || undefined,
        position: editingStage?.position ?? nextPosition,
        is_closed: stageIsClosed,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid stage");
      if (!profile) throw new Error("Not signed in");

      if (editingStage) {
        const { error } = await supabase
          .from("job_lifecycle_stages")
          .update({ name: result.data.name, color: result.data.color || null, is_closed: result.data.is_closed })
          .eq("id", editingStage.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("job_lifecycle_stages").insert({
          tenant_id: profile.tenant_id,
          name: result.data.name,
          position: result.data.position,
          color: result.data.color || null,
          is_system_default: false,
          is_closed: result.data.is_closed,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateStages();
      setStageModalOpen(false);
    },
    onError: (e) => setStageError(getErrorMessage(e, "Failed to save stage")),
  });

  const deleteStage = useMutation({
    mutationFn: async (stage: JobLifecycleStage) => {
      const { error } = await supabase.from("job_lifecycle_stages").delete().eq("id", stage.id);
      if (error) throw error;
    },
    onSuccess: invalidateStages,
  });

  const handleDeleteStage = (stage: JobLifecycleStage) => {
    const note = stage.is_system_default
      ? " This is one of the default stages - jobs currently in it will just become unstaged."
      : " Jobs currently in it will just become unstaged.";
    if (window.confirm(`Delete "${stage.name}"?${note}`)) {
      deleteStage.mutate(stage);
    }
  };

  // --- Lead sources ---
  const [leadSourceModalOpen, setLeadSourceModalOpen] = useState(false);
  const [editingLeadSource, setEditingLeadSource] = useState<LeadSource | null>(null);
  const [leadSourceName, setLeadSourceName] = useState("");
  const [leadSourceIsReferral, setLeadSourceIsReferral] = useState(false);
  const [leadSourceError, setLeadSourceError] = useState<string | null>(null);

  const openNewLeadSource = () => {
    setEditingLeadSource(null);
    setLeadSourceName("");
    setLeadSourceIsReferral(false);
    setLeadSourceError(null);
    setLeadSourceModalOpen(true);
  };
  const openEditLeadSource = (source: LeadSource) => {
    setEditingLeadSource(source);
    setLeadSourceName(source.name);
    setLeadSourceIsReferral(source.is_referral_source);
    setLeadSourceError(null);
    setLeadSourceModalOpen(true);
  };

  const saveLeadSource = useMutation({
    mutationFn: async () => {
      const list = leadSources ?? [];
      const nextSortOrder = list.length > 0 ? Math.max(...list.map((s) => s.sort_order)) + 1 : 1;
      const result = createLeadSourceSchema.safeParse({
        name: leadSourceName,
        sort_order: editingLeadSource?.sort_order ?? nextSortOrder,
        is_referral_source: leadSourceIsReferral,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid lead source");
      if (!profile) throw new Error("Not signed in");

      if (editingLeadSource) {
        const { error } = await supabase
          .from("lead_sources")
          .update({ name: result.data.name, is_referral_source: result.data.is_referral_source })
          .eq("id", editingLeadSource.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("lead_sources").insert({
          tenant_id: profile.tenant_id,
          name: result.data.name,
          sort_order: result.data.sort_order,
          is_referral_source: result.data.is_referral_source,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateLeadSources();
      setLeadSourceModalOpen(false);
    },
    onError: (e) => setLeadSourceError(getErrorMessage(e, "Failed to save lead source")),
  });

  const deleteLeadSource = useMutation({
    mutationFn: async (source: LeadSource) => {
      const { error } = await supabase.from("lead_sources").delete().eq("id", source.id);
      if (error) throw error;
    },
    onSuccess: invalidateLeadSources,
  });

  const handleDeleteLeadSource = (source: LeadSource) => {
    if (window.confirm(`Delete "${source.name}"? Jobs using it will just lose the tag.`)) {
      deleteLeadSource.mutate(source);
    }
  };

  // Tap-based reordering, same convention as job lifecycle stages.
  const moveLeadSource = useMutation({
    mutationFn: async ({ source, direction }: { source: LeadSource; direction: "up" | "down" }) => {
      const list = leadSources ?? [];
      const index = list.findIndex((s) => s.id === source.id);
      const neighborIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || neighborIndex < 0 || neighborIndex >= list.length) return;
      const neighbor = list[neighborIndex];
      if (!neighbor) return;

      const { error: error1 } = await supabase
        .from("lead_sources")
        .update({ sort_order: neighbor.sort_order })
        .eq("id", source.id);
      if (error1) throw error1;
      const { error: error2 } = await supabase
        .from("lead_sources")
        .update({ sort_order: source.sort_order })
        .eq("id", neighbor.id);
      if (error2) throw error2;
    },
    onSuccess: invalidateLeadSources,
  });

  // Tap-based reordering (no drag-and-drop), matching mobile's own
  // convention - swap this stage's position with its neighbor's.
  const moveStage = useMutation({
    mutationFn: async ({ stage, direction }: { stage: JobLifecycleStage; direction: "up" | "down" }) => {
      const list = stages ?? [];
      const index = list.findIndex((s) => s.id === stage.id);
      const neighborIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || neighborIndex < 0 || neighborIndex >= list.length) return;
      const neighbor = list[neighborIndex];
      if (!neighbor) return;

      const { error: error1 } = await supabase
        .from("job_lifecycle_stages")
        .update({ position: neighbor.position })
        .eq("id", stage.id);
      if (error1) throw error1;
      const { error: error2 } = await supabase
        .from("job_lifecycle_stages")
        .update({ position: stage.position })
        .eq("id", neighbor.id);
      if (error2) throw error2;
    },
    onSuccess: invalidateStages,
  });

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Job Setup
      </h1>

      <h2 className="mb-1 mt-6 uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Service categories
      </h2>
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Tags shown on jobs, e.g. "Roof Restoration" or "Gutter Cleaning".
      </p>

      <div className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {(categories ?? []).length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No categories yet.
          </p>
        ) : (
          (categories ?? []).map((category, i) => (
            <div
              key={category.id}
              className="flex items-center justify-between gap-3 p-3"
              style={i > 0 ? { borderTop: "1px solid var(--jms-border)" } : undefined}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: category.color ?? "var(--jms-border)" }} />
                <span className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {category.name}
                </span>
                {category.maintenance_interval_months ? (
                  <span
                    className="flex-shrink-0 rounded border px-1.5 py-0.5 font-bold"
                    style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                  >
                    Every {category.maintenance_interval_months}mo
                  </span>
                ) : null}
              </div>
              <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                <button onClick={() => openEditCategory(category)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                  Edit
                </button>
                <button onClick={() => handleDeleteCategory(category)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-3">
        <ThemedButton onClick={openNewCategory} className="w-full">
          + New category
        </ThemedButton>
      </div>

      <h2 className="mb-1 mt-8 uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Job lifecycle stages
      </h2>
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        A custom pipeline for jobs - this is the only status a job has.
      </p>

      <div className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {(stages ?? []).length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No stages yet.
          </p>
        ) : (
          (stages ?? []).map((stage, index) => (
            <div
              key={stage.id}
              className="flex items-center justify-between gap-3 p-3"
              style={index > 0 ? { borderTop: "1px solid var(--jms-border)" } : undefined}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: stage.color ?? "var(--jms-border)" }} />
                <span className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {stage.name}
                </span>
                {stage.is_system_default ? (
                  <span
                    className="flex-shrink-0 rounded border px-1.5 py-0.5 font-bold"
                    style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                  >
                    Default
                  </span>
                ) : null}
                {stage.is_closed ? (
                  <span
                    className="flex-shrink-0 rounded border px-1.5 py-0.5 font-bold"
                    style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                  >
                    Closed
                  </span>
                ) : null}
              </div>
              <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                <button
                  onClick={() => moveStage.mutate({ stage, direction: "up" })}
                  disabled={index === 0}
                  className="font-semibold disabled:opacity-30"
                  style={{ color: "var(--jms-text)" }}
                >
                  Up
                </button>
                <button
                  onClick={() => moveStage.mutate({ stage, direction: "down" })}
                  disabled={index === (stages ?? []).length - 1}
                  className="font-semibold disabled:opacity-30"
                  style={{ color: "var(--jms-text)" }}
                >
                  Down
                </button>
                <button onClick={() => openEditStage(stage)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                  Edit
                </button>
                <button onClick={() => handleDeleteStage(stage)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-3">
        <ThemedButton onClick={openNewStage} className="w-full">
          + New stage
        </ThemedButton>
      </div>

      <h2 className="mb-1 mt-8 uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Lead sources
      </h2>
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        How a job came to you - shown as a dropdown on the New Job form. The one flagged "Referral" reveals the referral
        partner picker when chosen.
      </p>

      <div className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {(leadSources ?? []).length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No lead sources yet.
          </p>
        ) : (
          (leadSources ?? []).map((source, index) => (
            <div
              key={source.id}
              className="flex items-center justify-between gap-3 p-3"
              style={index > 0 ? { borderTop: "1px solid var(--jms-border)" } : undefined}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {source.name}
                </span>
                {source.is_referral_source ? (
                  <span
                    className="flex-shrink-0 rounded border px-1.5 py-0.5 font-bold"
                    style={{ borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                  >
                    Referral
                  </span>
                ) : null}
              </div>
              <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                <button
                  onClick={() => moveLeadSource.mutate({ source, direction: "up" })}
                  disabled={index === 0}
                  className="font-semibold disabled:opacity-30"
                  style={{ color: "var(--jms-text)" }}
                >
                  Up
                </button>
                <button
                  onClick={() => moveLeadSource.mutate({ source, direction: "down" })}
                  disabled={index === (leadSources ?? []).length - 1}
                  className="font-semibold disabled:opacity-30"
                  style={{ color: "var(--jms-text)" }}
                >
                  Down
                </button>
                <button onClick={() => openEditLeadSource(source)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                  Edit
                </button>
                <button onClick={() => handleDeleteLeadSource(source)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-3">
        <ThemedButton onClick={openNewLeadSource} className="w-full">
          + New lead source
        </ThemedButton>
      </div>

      <ThemedModal open={categoryModalOpen} onClose={() => setCategoryModalOpen(false)} title={editingCategory ? "Edit category" : "New category"}>
        <ThemedFormField label="Name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="e.g. Roof Restoration" />
        <ThemedFormField
          label="Color (optional hex, e.g. #1d4ed8)"
          value={categoryColor}
          onChange={(e) => setCategoryColor(e.target.value)}
          placeholder="#1d4ed8"
        />
        <ThemedFormField
          label="Maintenance reminder every (months, optional)"
          type="number"
          value={categoryMaintenanceInterval}
          onChange={(e) => setCategoryMaintenanceInterval(e.target.value)}
          placeholder="e.g. 6 for aircon winterisation, 12 for annual pest control"
        />
        {categoryError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {categoryError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setCategoryModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveCategory.mutate()} disabled={saveCategory.isPending}>
            {saveCategory.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={stageModalOpen} onClose={() => setStageModalOpen(false)} title={editingStage ? "Edit stage" : "New stage"}>
        <ThemedFormField label="Name" value={stageName} onChange={(e) => setStageName(e.target.value)} placeholder="e.g. Deposit Paid" />
        <ThemedFormField
          label="Color (optional hex, e.g. #1d4ed8)"
          value={stageColor}
          onChange={(e) => setStageColor(e.target.value)}
          placeholder="#1d4ed8"
        />
        <label className="mb-4 flex items-center gap-2 font-medium" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input type="checkbox" checked={stageIsClosed} onChange={(e) => setStageIsClosed(e.target.checked)} />
          Job is done in this stage (triggers the completion summary email and maintenance reminders)
        </label>
        {stageError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {stageError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setStageModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveStage.mutate()} disabled={saveStage.isPending}>
            {saveStage.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal
        open={leadSourceModalOpen}
        onClose={() => setLeadSourceModalOpen(false)}
        title={editingLeadSource ? "Edit lead source" : "New lead source"}
      >
        <ThemedFormField label="Name" value={leadSourceName} onChange={(e) => setLeadSourceName(e.target.value)} placeholder="e.g. Google Search" />
        <label className="mb-4 flex items-center gap-2 font-medium" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input
            type="checkbox"
            checked={leadSourceIsReferral}
            onChange={(e) => setLeadSourceIsReferral(e.target.checked)}
          />
          This represents a referral (reveals the referral partner picker on the New Job form when chosen)
        </label>
        {leadSourceError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {leadSourceError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setLeadSourceModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveLeadSource.mutate()} disabled={saveLeadSource.isPending}>
            {saveLeadSource.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
