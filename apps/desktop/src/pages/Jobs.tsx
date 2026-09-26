import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  createJobCardSchema,
  type Agency,
  type Client,
  type JobCard,
  type JobLifecycleStage,
  type JobTemplate,
  type LeadSource,
  type Profile,
  type Property,
  type PropertyManager,
  type ReferralPartner,
  type ServiceCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

async function fetchJobs(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobCard[];
}

// Just the set of client_ids with an active membership - drives the
// "same-day response" reminder banner on the New Job form (see
// membership_plans.same_day_response) once a member client is picked.
async function fetchActiveMemberClientIds(): Promise<Set<string>> {
  const { data, error } = await supabase.from("client_memberships").select("client_id").eq("status", "active");
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.client_id as string));
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

async function fetchAgencies(): Promise<Agency[]> {
  const { data, error } = await supabase.from("agencies").select("*").order("name");
  if (error) throw error;
  return data as Agency[];
}
async function fetchPropertyManagers(): Promise<PropertyManager[]> {
  const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
  if (error) throw error;
  return data as PropertyManager[];
}
async function fetchProperties(): Promise<Property[]> {
  const { data, error } = await supabase.from("properties").select("*").order("suburb");
  if (error) throw error;
  return data as Property[];
}

async function fetchReferralPartners(): Promise<ReferralPartner[]> {
  const { data, error } = await supabase.from("referral_partners").select("*").eq("status", "active").order("contact_first_name");
  if (error) throw error;
  return data as ReferralPartner[];
}

async function fetchLeadSources(): Promise<LeadSource[]> {
  const { data, error } = await supabase.from("lead_sources").select("*").order("sort_order");
  if (error) throw error;
  return data as LeadSource[];
}

async function fetchJobTemplates(): Promise<JobTemplate[]> {
  const { data, error } = await supabase.from("job_templates").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as JobTemplate[];
}

// Same "any profile, not just a technician-flagged one" picker JobDetail.tsx
// already uses for reassignment - an admin who also does field work can
// assign a job to themselves too.
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

export default function JobsPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: jobs, isLoading } = useQuery({ queryKey: ["jobs"], queryFn: fetchJobs });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const { data: agencies } = useQuery({ queryKey: ["agencies"], queryFn: fetchAgencies });
  const { data: propertyManagers } = useQuery({ queryKey: ["property-managers"], queryFn: fetchPropertyManagers });
  const { data: properties } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties });
  const { data: referralPartners } = useQuery({ queryKey: ["referral-partners", "active"], queryFn: fetchReferralPartners });
  const { data: leadSources } = useQuery({ queryKey: ["lead-sources"], queryFn: fetchLeadSources });
  const { data: memberClientIds } = useQuery({ queryKey: ["active-member-client-ids"], queryFn: fetchActiveMemberClientIds });
  const { data: jobTemplates } = useQuery({ queryKey: ["job-templates"], queryFn: fetchJobTemplates });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });

  const clientById = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c])), [clients]);
  const categoryById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);
  const stageById = useMemo(() => new Map((stages ?? []).map((s) => [s.id, s])), [stages]);

  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [sortBy, setSortBy] = useState<"created_at" | "scheduled_at" | "category" | "stage">("created_at");

  const filteredJobs = (jobs ?? []).filter((job) => {
    if (filterCategory && job.service_category_id !== filterCategory) return false;
    if (filterStage && job.lifecycle_stage_id !== filterStage) return false;
    if (search.trim()) {
      const haystack = `${job.number ?? ""} ${job.title} ${clientById.get(job.client_id)?.name ?? ""}`.toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  });

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

  // ServiceM8-style pagination over the already-filtered/sorted list -
  // this codebase has never used Supabase's server-side .range() anywhere
  // (Jobs.tsx already fetches every job and filters/sorts in memory), so
  // paging the in-memory array keeps that same simple pattern rather than
  // introducing a first, one-off server-side-pagination code path.
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(sortedJobs.length / pageSize));
  useEffect(() => {
    setPage(1);
  }, [search, filterCategory, filterStage, pageSize]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const pagedJobs = sortedJobs.slice((page - 1) * pageSize, page * pageSize);

  const [modalOpen, setModalOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [clientId, setClientId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [stageId, setStageId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isRealEstateJob, setIsRealEstateJob] = useState(false);
  const [agencyId, setAgencyId] = useState("");
  const [propertyManagerId, setPropertyManagerId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [workOrderNumber, setWorkOrderNumber] = useState("");
  const [nteLimit, setNteLimit] = useState("");
  const [referralPartnerId, setReferralPartnerId] = useState("");
  const [leadSourceId, setLeadSourceId] = useState("");
  // Defaults to whoever's creating the job (a technician can always change
  // it to someone else, or clear it back to Unassigned, before saving).
  const [technicianId, setTechnicianId] = useState(profile?.id ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  const selectedLeadSource = (leadSources ?? []).find((s) => s.id === leadSourceId);
  const isReferralLeadSource = selectedLeadSource?.is_referral_source ?? false;

  const resetForm = () => {
    setTemplateId("");
    setClientId("");
    setCategoryId("");
    setStageId("");
    setTitle("");
    setDescription("");
    setIsRealEstateJob(false);
    setAgencyId("");
    setPropertyManagerId("");
    setPropertyId("");
    setWorkOrderNumber("");
    setNteLimit("");
    setReferralPartnerId("");
    setLeadSourceId("");
    setTechnicianId(profile?.id ?? "");
    setFormError(null);
  };

  // Cascading pickers - selecting an agency narrows the PM list to that
  // agency, selecting a PM narrows the property list to that PM. This is
  // the closest honest equivalent of the spec's "auto-suggests/links the
  // matching Property, Property Manager, and Agency" without an OCR/
  // document-parsing engine to actually read an uploaded work order.
  const pmsForAgency = (propertyManagers ?? []).filter((pm) => pm.agency_id === agencyId);
  const propertiesForPm = (properties ?? []).filter((p) => (propertyManagerId ? p.property_manager_id === propertyManagerId : p.agency_id === agencyId));

  const createJob = useMutation({
    mutationFn: async () => {
      const result = createJobCardSchema.safeParse({
        client_id: clientId,
        title,
        description,
        service_category_id: categoryId || undefined,
        lifecycle_stage_id: stageId || undefined,
        is_real_estate_job: isRealEstateJob,
        agency_id: isRealEstateJob ? agencyId || undefined : undefined,
        property_manager_id: isRealEstateJob ? propertyManagerId || undefined : undefined,
        property_id: isRealEstateJob ? propertyId || undefined : undefined,
        work_order_number: isRealEstateJob ? workOrderNumber || undefined : undefined,
        nte_limit_cents: isRealEstateJob && nteLimit ? Math.round(Number(nteLimit) * 100) : undefined,
        // Only actually persisted when the chosen lead source is the
        // referral one - picking a different lead source after having
        // linked a partner drops it rather than leaving it dangling.
        referral_partner_id: isReferralLeadSource ? referralPartnerId || undefined : undefined,
        lead_source_id: leadSourceId || undefined,
        assigned_technician_id: technicianId || undefined,
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
          is_real_estate_job: result.data.is_real_estate_job ?? false,
          agency_id: result.data.agency_id ?? null,
          property_manager_id: result.data.property_manager_id ?? null,
          property_id: result.data.property_id ?? null,
          work_order_number: result.data.work_order_number ?? null,
          nte_limit_cents: result.data.nte_limit_cents ?? null,
          referral_partner_id: result.data.referral_partner_id ?? null,
          lead_source_id: result.data.lead_source_id ?? null,
          assigned_technician_id: result.data.assigned_technician_id ?? null,
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
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Jobs
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {sortedJobs.length !== (jobs ?? []).length ? `${sortedJobs.length} of ${jobs?.length ?? 0} jobs` : `${jobs?.length ?? 0} jobs`}
          </p>
        </div>
        <ThemedButton onClick={() => setModalOpen(true)}>+ New job</ThemedButton>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search job #, title, or client..."
          className="w-64 rounded border px-3 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        />
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="rounded border px-3 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
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
          className="rounded border px-3 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          <option value="">All stages</option>
          {(stages ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {search || filterCategory || filterStage ? (
          <button
            onClick={() => {
              setSearch("");
              setFilterCategory("");
              setFilterStage("");
            }}
            className="font-semibold"
            style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
          >
            Clear filters
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2" style={{ fontSize: "var(--jms-font-body)" }}>
          <span style={{ color: "var(--jms-text-muted)" }}>Sort:</span>
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
              className="rounded-full border px-3 py-1 font-semibold"
              style={
                sortBy === opt.value
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : sortedJobs.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No jobs found.
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Title</th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 font-semibold">Category / Stage</th>
              </tr>
            </thead>
            <tbody>
              {pagedJobs.map((job) => {
                const category = categoryById.get(job.service_category_id ?? "");
                const stage = stageById.get(job.lifecycle_stage_id ?? "");
                return (
                  <tr key={job.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3" style={{ color: "var(--jms-accent)" }}>
                      <Link to={`/jobs/${job.id}`} className="hover:underline">
                        {job.number ?? "Pending"}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${job.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-text)" }}>
                        {job.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {clientById.get(job.client_id)?.name ?? "Unknown"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {category ? (
                          <span className="inline-flex items-center gap-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: category.color ?? "var(--jms-border)" }} />
                            {category.name}
                          </span>
                        ) : null}
                        {stage ? (
                          <span
                            className="rounded-full border px-2 py-0.5 font-semibold"
                            style={{
                              borderColor: stage.color ?? "var(--jms-border)",
                              color: stage.color ?? "var(--jms-text-muted)",
                              fontSize: "var(--jms-font-label)",
                            }}
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

      {sortedJobs.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
          <div className="flex items-center gap-2" style={{ color: "var(--jms-text-muted)" }}>
            <span>Show</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded border px-2 py-1"
              style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)" }}
            >
              {[30, 60, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>
              per page - {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, sortedJobs.length)} of {sortedJobs.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded border px-3 py-1.5 font-semibold disabled:opacity-40"
              style={{ borderColor: "var(--jms-border)", color: "var(--jms-text)" }}
            >
              Previous
            </button>
            <span style={{ color: "var(--jms-text-muted)" }}>
              Page {page} of {pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
              className="rounded border px-3 py-1.5 font-semibold disabled:opacity-40"
              style={{ borderColor: "var(--jms-border)", color: "var(--jms-text)" }}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      <ThemedModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title="New job"
      >
        {jobTemplates && jobTemplates.length > 0 ? (
          <ThemedSelectField
            label="Load from job template (optional)"
            value={templateId}
            onChange={(v) => {
              setTemplateId(v);
              const template = (jobTemplates ?? []).find((t) => t.id === v);
              if (template) {
                setTitle(template.name);
                setDescription(template.description ?? "");
                setCategoryId(template.service_category_id ?? "");
                setStageId(template.lifecycle_stage_id ?? "");
              }
            }}
            options={jobTemplates.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Start from scratch"
          />
        ) : null}
        <ThemedSelectField
          label="Client"
          value={clientId}
          onChange={setClientId}
          options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
          placeholder="Select a client"
        />
        {isRealEstateJob && agencyId && (agencies ?? []).find((a) => a.id === agencyId)?.client_id === clientId && clientId ? (
          <p className="-mt-2 mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Auto-filled from {(agencies ?? []).find((a) => a.id === agencyId)?.name}'s linked client - change if this job bills
            differently.
          </p>
        ) : null}
        {clientId && memberClientIds?.has(clientId) ? (
          <p
            className="-mt-2 mb-4 rounded px-3 py-2 font-semibold"
            style={{ border: "1px solid var(--jms-accent)", backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          >
            This client is a Member - remember the same-day response guarantee.
          </p>
        ) : null}
        <ThemedFormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <ThemedTextAreaField label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <ThemedSelectField
            label="Category"
            value={categoryId}
            onChange={setCategoryId}
            options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
          <ThemedSelectField
            label="Stage"
            value={stageId}
            onChange={setStageId}
            options={(stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>

        <ThemedSelectField
          label="Technician"
          value={technicianId}
          onChange={setTechnicianId}
          options={(technicians ?? []).map((t) => ({ value: t.id, label: t.full_name }))}
          placeholder="Unassigned"
        />

        <label className="mb-3 mt-2 flex items-center gap-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input type="checkbox" checked={isRealEstateJob} onChange={(e) => setIsRealEstateJob(e.target.checked)} />
          This is a real estate / strata agency job
        </label>

        {isRealEstateJob ? (
          <div className="mb-2 rounded p-3" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }}>
            <ThemedSelectField
              label="Agency"
              value={agencyId}
              onChange={(v) => {
                setAgencyId(v);
                setPropertyManagerId("");
                setPropertyId("");
                // Auto-derive the client from the agency's linked billing
                // client, same as PropertyDetail.tsx's property-first job
                // creation - removes the need to separately pick a client
                // that's really just this agency again.
                const picked = (agencies ?? []).find((a) => a.id === v);
                if (picked?.client_id) setClientId(picked.client_id);
              }}
              options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
              placeholder="Select agency"
            />
            <ThemedSelectField
              label="Property manager"
              value={propertyManagerId}
              onChange={(v) => {
                setPropertyManagerId(v);
                setPropertyId("");
              }}
              options={pmsForAgency.map((pm) => ({ value: pm.id, label: `${pm.first_name} ${pm.last_name}` }))}
              placeholder="Select property manager"
            />
            <ThemedSelectField
              label="Property"
              value={propertyId}
              onChange={setPropertyId}
              options={propertiesForPm.map((p) => ({ value: p.id, label: `${p.address_line1}, ${p.suburb}` }))}
              placeholder="Select property"
            />
            <div className="grid grid-cols-2 gap-3">
              <ThemedFormField label="Work order number" value={workOrderNumber} onChange={(e) => setWorkOrderNumber(e.target.value)} />
              <ThemedFormField
                label="NTE limit ($)"
                type="number"
                step="0.01"
                value={nteLimit}
                onChange={(e) => setNteLimit(e.target.value)}
                placeholder="e.g. 300.00"
              />
            </div>
          </div>
        ) : null}

        <ThemedSelectField
          label="Lead source (optional)"
          value={leadSourceId}
          onChange={(v) => {
            setLeadSourceId(v);
            if (!(leadSources ?? []).find((s) => s.id === v)?.is_referral_source) setReferralPartnerId("");
          }}
          options={(leadSources ?? []).map((s) => ({ value: s.id, label: s.name }))}
          placeholder="None"
        />
        {isReferralLeadSource ? (
          <ThemedSelectField
            label="Referral partner"
            value={referralPartnerId}
            onChange={setReferralPartnerId}
            options={(referralPartners ?? []).map((p) => ({
              value: p.id,
              label: p.company_name ? `${p.company_name} (${[p.contact_first_name, p.contact_last_name].filter(Boolean).join(" ")})` : [p.contact_first_name, p.contact_last_name].filter(Boolean).join(" "),
            }))}
            placeholder="None"
          />
        ) : null}

        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setModalOpen(false);
              resetForm();
            }}
            className="px-4 py-2 font-semibold"
            style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
          >
            Cancel
          </button>
          <ThemedButton onClick={() => createJob.mutate()} disabled={createJob.isPending}>
            {createJob.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
