import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  createJobCardSchema,
  type Client,
  type JobCard,
  type JobLifecycleStage,
  type ServiceCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField, TextAreaField } from "../components/FormField";

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

export default function JobsPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: jobs, isLoading } = useQuery({ queryKey: ["jobs"], queryFn: fetchJobs });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });

  const clientById = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c])), [clients]);
  const categoryById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);
  const stageById = useMemo(() => new Map((stages ?? []).map((s) => [s.id, s])), [stages]);

  const [filterCategory, setFilterCategory] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [sortBy, setSortBy] = useState<"created_at" | "scheduled_at" | "category" | "stage">("created_at");

  const filteredJobs = (jobs ?? []).filter(
    (job) =>
      (!filterCategory || job.service_category_id === filterCategory) &&
      (!filterStage || job.lifecycle_stage_id === filterStage)
  );

  const sortedJobs = [...filteredJobs].sort((a, b) => {
    switch (sortBy) {
      case "scheduled_at":
        return (a.scheduled_at ?? "9999").localeCompare(b.scheduled_at ?? "9999");
      case "category":
        return (categoryById.get(a.service_category_id ?? "")?.name ?? "￿").localeCompare(
          categoryById.get(b.service_category_id ?? "")?.name ?? "￿"
        );
      case "stage":
        return (
          (stageById.get(a.lifecycle_stage_id ?? "")?.position ?? Number.MAX_SAFE_INTEGER) -
          (stageById.get(b.lifecycle_stage_id ?? "")?.position ?? Number.MAX_SAFE_INTEGER)
        );
      case "created_at":
      default:
        return b.created_at.localeCompare(a.created_at);
    }
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [stageId, setStageId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setClientId("");
    setCategoryId("");
    setStageId("");
    setTitle("");
    setDescription("");
    setFormError(null);
  };

  const createJob = useMutation({
    mutationFn: async () => {
      const result = createJobCardSchema.safeParse({
        client_id: clientId,
        title,
        description,
        service_category_id: categoryId || undefined,
        lifecycle_stage_id: stageId || undefined,
      });
      if (!result.success) {
        throw new Error(clientId ? result.error.issues[0]?.message ?? "Invalid job" : "Pick a client first");
      }
      if (!profile) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("job_cards")
        .insert({
          tenant_id: profile.tenant_id,
          client_id: result.data.client_id,
          title: result.data.title,
          description: result.data.description || null,
          service_category_id: result.data.service_category_id ?? null,
          lifecycle_stage_id: result.data.lifecycle_stage_id ?? null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as JobCard;
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      resetForm();
      setModalOpen(false);
      navigate(`/jobs/${job.id}`);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create job")),
  });

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Jobs</h1>
          <p className="text-sm text-gray-500">{jobs?.length ?? 0} jobs</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New job
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={filterStage}
          onChange={(e) => setFilterStage(e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All stages</option>
          {(stages ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {filterCategory || filterStage ? (
          <button
            onClick={() => {
              setFilterCategory("");
              setFilterStage("");
            }}
            className="text-sm font-semibold text-red-600"
          >
            Clear filters
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-gray-500">Sort:</span>
          {(
            [
              { value: "created_at", label: "Created" },
              { value: "scheduled_at", label: "Scheduled" },
              { value: "category", label: "Category" },
              { value: "stage", label: "Stage" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              className={`rounded-full px-3 py-1 font-semibold ${
                sortBy === opt.value ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : sortedJobs.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No jobs found.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Title</th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 font-semibold">Category / Stage</th>
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => {
                const category = categoryById.get(job.service_category_id ?? "");
                const stage = stageById.get(job.lifecycle_stage_id ?? "");
                return (
                  <tr key={job.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-blue-700">
                      <Link to={`/jobs/${job.id}`} className="hover:underline">
                        {job.number ?? "Pending"}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${job.id}`} className="font-medium hover:underline">
                        {job.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{clientById.get(job.client_id)?.name ?? "Unknown"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {category ? (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: category.color ?? "#d1d5db" }}
                            />
                            {category.name}
                          </span>
                        ) : null}
                        {stage ? (
                          <span
                            className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-800"
                            style={stage.color ? { backgroundColor: stage.color } : undefined}
                          >
                            {stage.name}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title="New job"
      >
        <SelectField
          label="Client"
          value={clientId}
          onChange={setClientId}
          options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
          placeholder="Select a client"
        />
        <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextAreaField label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Category"
            value={categoryId}
            onChange={setCategoryId}
            options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
          <SelectField
            label="Stage"
            value={stageId}
            onChange={setStageId}
            options={(stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setModalOpen(false);
              resetForm();
            }}
            className="px-4 py-2 text-sm font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={() => createJob.mutate()}
            disabled={createJob.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createJob.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
