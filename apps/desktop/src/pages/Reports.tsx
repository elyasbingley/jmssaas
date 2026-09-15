import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  createReportCategorySchema,
  createReportSubcategorySchema,
  type Client,
  type JobCard,
  type Profile,
  type ReportCategory,
  type ReportInstance,
  type ReportInstanceStatus,
  type ReportSubcategory,
  type ReportTemplate,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedBadge } from "../components/theme/ThemedBadge";

// The three sub-tabs from the spec live under a single sidebar destination
// (/reports) - same "one sidebar destination, several in-page tabs"
// relationship every other multi-tab module in this app already uses.
// "Homepage tile" (the spec's other entry point) is this same nav link,
// added to the top-level (ungrouped) section of Layout.tsx alongside
// Dispatch/Tasks - desktop has no separate tile-based home dashboard to
// place a literal tile on (root "/" just redirects to /dispatch), so the
// nav entry is the closest honest equivalent.

type SubTab = "new" | "history" | "studio";

async function fetchCategories(): Promise<ReportCategory[]> {
  const { data, error } = await supabase.from("report_categories").select("*").order("name");
  if (error) throw error;
  return data as ReportCategory[];
}
async function fetchSubcategories(): Promise<ReportSubcategory[]> {
  const { data, error } = await supabase.from("report_subcategories").select("*").order("name");
  if (error) throw error;
  return data as ReportSubcategory[];
}
async function fetchTemplates(): Promise<ReportTemplate[]> {
  const { data, error } = await supabase.from("report_templates").select("*").order("title");
  if (error) throw error;
  return data as ReportTemplate[];
}
async function fetchInstances(): Promise<ReportInstance[]> {
  const { data, error } = await supabase.from("report_instances").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data as ReportInstance[];
}
async function fetchJobs(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobCard[];
}
async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}
async function fetchProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*");
  if (error) throw error;
  return data as Profile[];
}

// Report status (draft/completed/archived) is a workflow state, not a
// safety-risk signal, so it derives from the active theme's tokens like
// everything else - unlike the fixed WHS risk-matrix colors below, it's
// fine for this to shift with the tenant's chosen accent.
const STATUS_COLORS: Record<ReportInstanceStatus, string> = {
  draft: "var(--jms-warning)",
  completed: "var(--jms-accent)",
  archived: "var(--jms-text-muted)",
};

export default function ReportsPage() {
  const [tab, setTab] = useState<SubTab>("new");

  const { data: categories } = useQuery({ queryKey: ["report-categories"], queryFn: fetchCategories });
  const { data: subcategories } = useQuery({ queryKey: ["report-subcategories"], queryFn: fetchSubcategories });
  const { data: templates } = useQuery({ queryKey: ["report-templates"], queryFn: fetchTemplates });
  const { data: instances } = useQuery({ queryKey: ["report-instances"], queryFn: fetchInstances });
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: fetchJobs });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const { data: profiles } = useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles });

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Forms & Certificates
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Build, execute, and sign off on SWMS, JSAs, inspections, and other safety documentation.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        {(
          [
            { key: "new", label: "New Report" },
            { key: "history", label: "Report History" },
            { key: "studio", label: "Template Studio" },
          ] as { key: SubTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="rounded-full border px-4 py-1.5 font-semibold uppercase tracking-wide"
            style={
              tab === t.key
                ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "new" ? (
        <NewReportTab categories={categories ?? []} subcategories={subcategories ?? []} templates={(templates ?? []).filter((t) => t.is_active)} />
      ) : tab === "history" ? (
        <ReportHistoryTab
          instances={instances ?? []}
          templates={templates ?? []}
          jobs={jobs ?? []}
          clients={clients ?? []}
          profiles={profiles ?? []}
        />
      ) : (
        <TemplateStudioTab categories={categories ?? []} subcategories={subcategories ?? []} templates={templates ?? []} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab 1: New Report (Template Library)
// ---------------------------------------------------------------------------

function NewReportTab({
  categories,
  subcategories,
  templates,
}: {
  categories: ReportCategory[];
  subcategories: ReportSubcategory[];
  templates: ReportTemplate[];
}) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [search, setSearch] = useState("");
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const filteredTemplates = search.trim()
    ? templates.filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase()))
    : templates;

  const subcategoriesByCategory = (categoryId: string) => subcategories.filter((s) => s.category_id === categoryId);
  const templatesBySubcategory = (subcategoryId: string) => filteredTemplates.filter((t) => t.subcategory_id === subcategoryId);

  // Creating a report is a two-step commit: insert a draft report_instances
  // row the moment a template is picked (so partial progress can always be
  // saved/resumed, same as a draft quote), then navigate into the runner.
  const startReport = async (templateId: string) => {
    if (!profile) return;
    setStarting(templateId);
    setStartError(null);
    const { data, error } = await supabase
      .from("report_instances")
      .insert({ tenant_id: profile.tenant_id, template_id: templateId, created_by: profile.id, status: "draft" })
      .select("id")
      .single();
    setStarting(null);
    if (error) {
      setStartError(getErrorMessage(error, "Failed to start report"));
      return;
    }
    navigate(`/reports/instances/${data.id}`);
  };

  return (
    <div>
      <ThemedFormField label="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title..." />
      {startError ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {startError}
        </p>
      ) : null}

      {categories.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No report templates yet - build one in the Template Studio tab.
        </p>
      ) : (
        <div className="space-y-6">
          {categories.map((category) => {
            const catSubcategories = subcategoriesByCategory(category.id);
            const catTemplateCount = catSubcategories.reduce((sum, s) => sum + templatesBySubcategory(s.id).length, 0);
            if (catTemplateCount === 0) return null;
            return (
              <div key={category.id}>
                <h2 className="mb-2 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {category.name}
                </h2>
                <div className="space-y-4">
                  {catSubcategories.map((sub) => {
                    const subTemplates = templatesBySubcategory(sub.id);
                    if (subTemplates.length === 0) return null;
                    return (
                      <div key={sub.id}>
                        <p className="mb-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                          {sub.name}
                        </p>
                        <div className="grid grid-cols-3 gap-3">
                          {subTemplates.map((template) => (
                            <button
                              key={template.id}
                              onClick={() => startReport(template.id)}
                              disabled={starting === template.id}
                              className="jms-nav-link rounded-lg p-4 text-left disabled:opacity-60"
                              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
                            >
                              <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                                {template.title}
                              </p>
                              {template.description ? (
                                <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                                  {template.description}
                                </p>
                              ) : null}
                              {template.is_swms ? (
                                <span className="mt-2 inline-block">
                                  <ThemedBadge label="SWMS sign-off required" color="var(--jms-warning)" />
                                </span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab 2: Report History
// ---------------------------------------------------------------------------

function ReportHistoryTab({
  instances,
  templates,
  jobs,
  clients,
  profiles,
}: {
  instances: ReportInstance[];
  templates: ReportTemplate[];
  jobs: JobCard[];
  clients: Client[];
  profiles: Profile[];
}) {
  const queryClient = useQueryClient();
  const templateById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const [linkingInstance, setLinkingInstance] = useState<ReportInstance | null>(null);
  const [linkJobId, setLinkJobId] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const openLinkModal = (instance: ReportInstance) => {
    setLinkingInstance(instance);
    setLinkJobId("");
    setLinkError(null);
  };

  const linkToJob = useMutation({
    mutationFn: async () => {
      if (!linkingInstance || !linkJobId) throw new Error("Pick a job");
      const job = jobById.get(linkJobId);
      const { error } = await supabase
        .from("report_instances")
        .update({ job_card_id: linkJobId, client_id: job?.client_id ?? linkingInstance.client_id })
        .eq("id", linkingInstance.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-instances"] });
      setLinkingInstance(null);
    },
    onError: (e) => setLinkError(getErrorMessage(e, "Failed to link report")),
  });

  return (
    <div>
      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {instances.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No reports yet.
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Report</th>
                <th className="px-4 py-2 font-semibold">Linked Job</th>
                <th className="px-4 py-2 font-semibold">Created By</th>
                <th className="px-4 py-2 font-semibold">Date Completed</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((instance) => {
                const template = templateById.get(instance.template_id);
                const job = instance.job_card_id ? jobById.get(instance.job_card_id) : null;
                const author = instance.created_by ? profileById.get(instance.created_by) : null;
                return (
                  <tr key={instance.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3">
                      <Link to={`/reports/instances/${instance.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {template?.title ?? "Unknown template"}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {job ? (
                        <Link to={`/jobs/${job.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                          {job.number ?? job.title}
                        </Link>
                      ) : (
                        <button onClick={() => openLinkModal(instance)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                          Link to Job
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>{author?.full_name ?? "-"}</td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {instance.completed_at ? new Date(instance.completed_at).toLocaleDateString("en-AU") : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <ThemedBadge label={instance.status.charAt(0).toUpperCase() + instance.status.slice(1)} color={STATUS_COLORS[instance.status]} />
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/reports/instances/${instance.id}`} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ThemedModal open={!!linkingInstance} onClose={() => setLinkingInstance(null)} title="Link report to a job">
        <ThemedSelectField
          label="Job"
          value={linkJobId}
          onChange={setLinkJobId}
          options={jobs.map((j) => ({
            value: j.id,
            label: `${j.number ?? "Pending"} - ${j.title} (${clientById.get(j.client_id)?.name ?? "Unknown client"})`,
          }))}
          placeholder="Select a job"
        />
        {linkError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {linkError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setLinkingInstance(null)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => linkToJob.mutate()} disabled={linkToJob.isPending || !linkJobId}>
            {linkToJob.isPending ? "Linking..." : "Link"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab 3: Template Studio - category/subcategory CRUD inline (same
// expandable-tree + modal pattern RealEstate.tsx's DirectoryTab uses for
// Agency -> PM -> Property); the template itself (sections/fields) is
// complex enough to warrant its own dedicated page - see
// ReportTemplateEditor.tsx.
// ---------------------------------------------------------------------------

const ICON_OPTIONS = ["ClipboardList", "ShieldAlert", "HardHat", "Home", "Wrench", "FileCheck"];

function TemplateStudioTab({
  categories,
  subcategories,
  templates,
}: {
  categories: ReportCategory[];
  subcategories: ReportSubcategory[];
  templates: ReportTemplate[];
}) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const toggleCategory = (id: string) => {
    setExpandedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const subcategoriesByCategory = (categoryId: string) => subcategories.filter((s) => s.category_id === categoryId);
  const templatesBySubcategory = (subcategoryId: string) => templates.filter((t) => t.subcategory_id === subcategoryId);

  // --- Add Category ---
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [categoryIcon, setCategoryIcon] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const openNewCategory = () => {
    setCategoryName("");
    setCategoryDescription("");
    setCategoryIcon("");
    setCategoryError(null);
    setCategoryModalOpen(true);
  };

  const createCategory = useMutation({
    mutationFn: async () => {
      const result = createReportCategorySchema.safeParse({ name: categoryName, description: categoryDescription, icon: categoryIcon });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid category");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("report_categories").insert({
        tenant_id: profile.tenant_id,
        name: result.data.name,
        description: result.data.description || null,
        icon: result.data.icon || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-categories"] });
      setCategoryModalOpen(false);
    },
    onError: (e) => setCategoryError(getErrorMessage(e, "Failed to create category")),
  });

  // --- Add Subcategory ---
  const [subcategoryModalOpen, setSubcategoryModalOpen] = useState(false);
  const [subCategoryId, setSubCategoryId] = useState("");
  const [subName, setSubName] = useState("");
  const [subError, setSubError] = useState<string | null>(null);

  const openNewSubcategory = (categoryId?: string) => {
    setSubCategoryId(categoryId ?? "");
    setSubName("");
    setSubError(null);
    setSubcategoryModalOpen(true);
  };

  const createSubcategory = useMutation({
    mutationFn: async () => {
      const result = createReportSubcategorySchema.safeParse({ category_id: subCategoryId, name: subName });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid subcategory");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("report_subcategories").insert({
        tenant_id: profile.tenant_id,
        category_id: result.data.category_id,
        name: result.data.name,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-subcategories"] });
      setSubcategoryModalOpen(false);
    },
    onError: (e) => setSubError(getErrorMessage(e, "Failed to create subcategory")),
  });

  return (
    <div>
      <div className="mb-4 flex justify-end gap-2">
        <ThemedButton variant="secondary" onClick={() => openNewSubcategory()}>
          + Add Subcategory
        </ThemedButton>
        <ThemedButton onClick={openNewCategory}>+ Add Category</ThemedButton>
      </div>

      {categories.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No categories yet - add one to start building templates.</p>
      ) : (
        <div className="space-y-3">
          {categories.map((category) => {
            const expanded = expandedCategoryIds.has(category.id);
            const subs = subcategoriesByCategory(category.id);
            return (
              <div key={category.id} className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
                <button onClick={() => toggleCategory(category.id)} className="jms-nav-link flex w-full items-center justify-between px-4 py-3 text-left">
                  <div className="flex items-center gap-3">
                    <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>{expanded ? "▾" : "▸"}</span>
                    <span className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {category.name}
                    </span>
                  </div>
                  <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    {subs.length} subcategor{subs.length === 1 ? "y" : "ies"}
                  </span>
                </button>
                {expanded ? (
                  <div className="px-4 py-3" style={{ borderTop: "1px solid var(--jms-border)" }}>
                    {subs.length === 0 ? (
                      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No subcategories yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {subs.map((sub) => {
                          const subTemplates = templatesBySubcategory(sub.id);
                          return (
                            <div key={sub.id} className="ml-6 pl-4" style={{ borderLeft: "1px solid var(--jms-border)" }}>
                              <p className="mb-1 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                                {sub.name}
                              </p>
                              {subTemplates.length > 0 ? (
                                <div className="mb-1 space-y-1">
                                  {subTemplates.map((template) => (
                                    <button
                                      key={template.id}
                                      onClick={() => navigate(`/reports/templates/${template.id}`)}
                                      className="jms-nav-link flex w-full items-center justify-between rounded px-2 py-1 text-left"
                                      style={{ fontSize: "var(--jms-font-body)" }}
                                    >
                                      <span style={{ color: "var(--jms-accent)" }}>{template.title}</span>
                                      <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                                        {template.is_active ? "Active" : "Inactive"}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                              <button
                                onClick={() => navigate(`/reports/templates/new?subcategoryId=${sub.id}`)}
                                className="font-semibold hover:underline"
                                style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                              >
                                + New template in {sub.name}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <button
                      onClick={() => openNewSubcategory(category.id)}
                      className="mt-2 font-semibold hover:underline"
                      style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                    >
                      + Add subcategory to {category.name}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <ThemedModal open={categoryModalOpen} onClose={() => setCategoryModalOpen(false)} title="New category">
        <ThemedFormField label="Name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="e.g. WHS & Safety" />
        <ThemedTextAreaField label="Description (optional)" rows={2} value={categoryDescription} onChange={(e) => setCategoryDescription(e.target.value)} />
        <ThemedSelectField label="Icon (optional)" value={categoryIcon} onChange={setCategoryIcon} options={ICON_OPTIONS.map((i) => ({ value: i, label: i }))} placeholder="None" />
        {categoryError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {categoryError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setCategoryModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createCategory.mutate()} disabled={createCategory.isPending}>
            {createCategory.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={subcategoryModalOpen} onClose={() => setSubcategoryModalOpen(false)} title="New subcategory">
        <ThemedSelectField
          label="Category"
          value={subCategoryId}
          onChange={setSubCategoryId}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
          placeholder="Select category"
        />
        <ThemedFormField label="Name" value={subName} onChange={(e) => setSubName(e.target.value)} placeholder="e.g. Safety Forms" />
        {subError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {subError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSubcategoryModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createSubcategory.mutate()} disabled={createSubcategory.isPending || !subCategoryId}>
            {createSubcategory.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
