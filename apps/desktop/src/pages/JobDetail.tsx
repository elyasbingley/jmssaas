import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createJobNoteSchema,
  formatCentsAsAud,
  type Agency,
  type Client,
  type Invoice,
  type InvoiceLineItem,
  type JobCard,
  type JobFile,
  type JobLifecycleStage,
  type JobMeasurement,
  type JobNote,
  type Profile,
  type Property,
  type PropertyManager,
  type Quote,
  type QuoteLineItem,
  type PurchaseOrder,
  type ReportInstance,
  type ReportTemplate,
  type ServiceCategory,
  type SubcontractorCompany,
  type SubcontractorTrade,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { triggerImmediateDispatch } from "../lib/dispatch-now";
import { formatClientAddress } from "../lib/format";
import { uploadJobPhoto } from "../lib/uploads";
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";
import { CommunicationLog } from "../components/CommunicationLog";
import { TRADE_LABELS, TIER_LABELS } from "./Subcontractors";

// Same tiny cost helpers as JobCosting.tsx (and apps/mobile's own copy in
// jobs/[id].tsx) - copied verbatim rather than shared, matching how
// mobile itself keeps its own local copy instead of factoring this into
// packages/shared.
function lineItemLabourCostCents(item: Pick<QuoteLineItem, "quantity" | "labour_rate_cents" | "labour_hours">): number {
  return Math.round(item.quantity * item.labour_rate_cents * item.labour_hours);
}
function lineItemMaterialCostCents(item: Pick<QuoteLineItem, "quantity" | "material_cost_cents">): number {
  return Math.round(item.quantity * item.material_cost_cents);
}

async function fetchJob(id: string): Promise<JobCard> {
  const { data, error } = await supabase.from("job_cards").select("*").eq("id", id).single();
  if (error) throw error;
  return data as JobCard;
}

async function fetchClient(clientId: string): Promise<Client> {
  const { data, error } = await supabase.from("clients").select("*").eq("id", clientId).single();
  if (error) throw error;
  return data as Client;
}

async function fetchAgency(agencyId: string): Promise<Agency> {
  const { data, error } = await supabase.from("agencies").select("*").eq("id", agencyId).single();
  if (error) throw error;
  return data as Agency;
}
async function fetchPropertyManager(id: string): Promise<PropertyManager> {
  const { data, error } = await supabase.from("property_managers").select("*").eq("id", id).single();
  if (error) throw error;
  return data as PropertyManager;
}
async function fetchProperty(id: string): Promise<Property> {
  const { data, error } = await supabase.from("properties").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Property;
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

async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "technician").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

async function fetchNotes(jobId: string): Promise<JobNote[]> {
  const { data, error } = await supabase
    .from("job_notes")
    .select("*")
    .eq("job_card_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobNote[];
}

async function fetchLinkedQuotes(jobId: string): Promise<Quote[]> {
  const { data, error } = await supabase.from("quotes").select("*").eq("job_card_id", jobId);
  if (error) throw error;
  return data as Quote[];
}

async function fetchLinkedInvoices(jobId: string): Promise<Invoice[]> {
  const { data, error } = await supabase.from("invoices").select("*").eq("job_card_id", jobId);
  if (error) throw error;
  return data as Invoice[];
}

async function fetchQuoteLineItems(quoteIds: string[]): Promise<QuoteLineItem[]> {
  if (quoteIds.length === 0) return [];
  const { data, error } = await supabase.from("quote_line_items").select("*").in("quote_id", quoteIds);
  if (error) throw error;
  return data as QuoteLineItem[];
}

async function fetchInvoiceLineItems(invoiceIds: string[]): Promise<InvoiceLineItem[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await supabase.from("invoice_line_items").select("*").in("invoice_id", invoiceIds);
  if (error) throw error;
  return data as InvoiceLineItem[];
}

async function fetchMeasurements(jobId: string): Promise<JobMeasurement[]> {
  const { data, error } = await supabase
    .from("job_measurements")
    .select("*")
    .eq("job_card_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobMeasurement[];
}

async function fetchFiles(jobId: string): Promise<JobFile[]> {
  const { data, error } = await supabase
    .from("job_files")
    .select("*")
    .eq("job_card_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobFile[];
}

// Bucket is private (see supabase/migrations/20260720000300_storage.sql) -
// a short-lived signed URL is the correct way to view an already-uploaded
// photo here, not a public URL. Desktop only ever views these - capturing
// new ones from a webcam isn't in scope (see docs/SETUP.md).
async function fetchFileUrls(files: JobFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (f) => {
      const { data } = await supabase.storage.from("job-files").createSignedUrl(f.storage_path, 3600);
      return [f.id, data?.signedUrl ?? ""] as const;
    })
  );
  return Object.fromEntries(entries);
}

async function fetchLinkedReports(jobId: string): Promise<ReportInstance[]> {
  const { data, error } = await supabase
    .from("report_instances")
    .select("*")
    .eq("job_card_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as ReportInstance[];
}
async function fetchUnlinkedReports(): Promise<ReportInstance[]> {
  const { data, error } = await supabase.from("report_instances").select("*").is("job_card_id", null).order("created_at", { ascending: false });
  if (error) throw error;
  return data as ReportInstance[];
}
async function fetchActiveReportTemplates(): Promise<ReportTemplate[]> {
  const { data, error } = await supabase.from("report_templates").select("*").eq("is_active", true).order("title");
  if (error) throw error;
  return data as ReportTemplate[];
}
async function fetchAllReportTemplates(): Promise<ReportTemplate[]> {
  const { data, error } = await supabase.from("report_templates").select("*");
  if (error) throw error;
  return data as ReportTemplate[];
}

async function fetchLinkedPurchaseOrders(jobId: string): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase.from("purchase_orders").select("*").eq("job_card_id", jobId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as PurchaseOrder[];
}
async function fetchSubcontractors(): Promise<SubcontractorCompany[]> {
  const { data, error } = await supabase.from("subcontractor_companies").select("*").order("preference_tier").order("company_name");
  if (error) throw error;
  return data as SubcontractorCompany[];
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: job } = useQuery({ queryKey: ["job", id], queryFn: () => fetchJob(id!), enabled: !!id });
  const { data: client } = useQuery({
    queryKey: ["client", job?.client_id],
    queryFn: () => fetchClient(job!.client_id),
    enabled: !!job,
  });
  const { data: agency } = useQuery({
    queryKey: ["agency", job?.agency_id],
    queryFn: () => fetchAgency(job!.agency_id!),
    enabled: !!job?.agency_id,
  });
  const { data: propertyManager } = useQuery({
    queryKey: ["property-manager", job?.property_manager_id],
    queryFn: () => fetchPropertyManager(job!.property_manager_id!),
    enabled: !!job?.property_manager_id,
  });
  const { data: property } = useQuery({
    queryKey: ["property", job?.property_id],
    queryFn: () => fetchProperty(job!.property_id!),
    enabled: !!job?.property_id,
  });
  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });
  const { data: notes } = useQuery({ queryKey: ["job-notes", id], queryFn: () => fetchNotes(id!), enabled: !!id });
  const { data: linkedQuotes } = useQuery({
    queryKey: ["job-quotes", id],
    queryFn: () => fetchLinkedQuotes(id!),
    enabled: !!id,
  });
  const { data: linkedInvoices } = useQuery({
    queryKey: ["job-invoices", id],
    queryFn: () => fetchLinkedInvoices(id!),
    enabled: !!id,
  });
  const quoteIds = (linkedQuotes ?? []).map((q) => q.id);
  const invoiceIds = (linkedInvoices ?? []).map((inv) => inv.id);
  const { data: quoteLineItems } = useQuery({
    queryKey: ["job-quote-line-items", quoteIds.join(",")],
    queryFn: () => fetchQuoteLineItems(quoteIds),
    enabled: !!linkedQuotes,
  });
  const { data: invoiceLineItems } = useQuery({
    queryKey: ["job-invoice-line-items", invoiceIds.join(",")],
    queryFn: () => fetchInvoiceLineItems(invoiceIds),
    enabled: !!linkedInvoices,
  });
  const { data: measurements } = useQuery({
    queryKey: ["job-measurements", id],
    queryFn: () => fetchMeasurements(id!),
    enabled: !!id,
  });
  const { data: files } = useQuery({ queryKey: ["job-files", id], queryFn: () => fetchFiles(id!), enabled: !!id });
  const { data: fileUrls } = useQuery({
    queryKey: ["job-file-urls", id, files?.map((f) => f.id).join(",")],
    queryFn: () => fetchFileUrls(files!),
    enabled: !!files && files.length > 0,
  });

  const updateJob = useMutation({
    mutationFn: async (patch: Partial<JobCard>) => {
      const { error } = await supabase.from("job_cards").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const [reviewRequestResult, setReviewRequestResult] = useState<string | null>(null);
  const [reviewRequestError, setReviewRequestError] = useState<string | null>(null);

  // Same "just finished" moment mobile's own stage picker prompts on (see
  // apps/mobile jobs/[id].tsx's handleStageChange) - keyed off entering any
  // is_closed stage, not one literally named "Completed", matching the DB
  // triggers' own schedule_job_completion_summary/schedule_maintenance_
  // reminder logic (see the job_status_lifecycle_consolidation migration).
  // No {tech_first_name}/{eta_minutes} placeholder rendering needed here
  // (unlike an On The Way message) - job_review_request has no schedule
  // context, so the template body/subject go through as-is for the
  // dispatcher to resolve the rest of its tokens server-side.
  const queueReviewRequest = useMutation({
    mutationFn: async () => {
      if (!profile || !client) throw new Error("Not signed in");
      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "job_review_request")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Review request' message is turned off in Settings > Automation & Messaging");
      }

      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "job_review_request")
        .eq("is_active", true);
      const matching = (templates ?? []).filter((t) => rule.channel === "both" || rule.channel === t.type);
      if (matching.length === 0) throw new Error("No active 'Review request' message template found");

      let anySent = false;
      for (const template of matching) {
        const recipient = template.type === "sms" ? (client.phone ?? "") : (client.email ?? "");
        const { data: row, error } = await supabase
          .from("scheduled_communications")
          .insert({
            tenant_id: profile.tenant_id,
            entity_type: "job",
            entity_id: id,
            trigger_key: "job_review_request",
            template_id: template.id,
            channel: template.type,
            recipient_phone_or_email: recipient,
            rendered_subject: template.subject,
            rendered_body: template.body,
            scheduled_for: new Date().toISOString(),
            status: "pending",
          })
          .select("id")
          .single();
        if (error) throw error;
        if (await triggerImmediateDispatch(row.id)) anySent = true;
      }
      return anySent;
    },
    onSuccess: (anySent) => {
      queryClient.invalidateQueries({ queryKey: ["communication-log"] });
      setReviewRequestError(null);
      setReviewRequestResult(anySent ? "The review request has been sent." : "The review request is queued and will send shortly.");
      setTimeout(() => setReviewRequestResult(null), 5000);
    },
    onError: (e) => setReviewRequestError(getErrorMessage(e, "Failed to queue review request")),
  });

  const handleStageChange = (nextStageId: string) => {
    const wasClosed = (stages ?? []).find((s) => s.id === job?.lifecycle_stage_id)?.is_closed ?? false;
    const willBeClosed = (stages ?? []).find((s) => s.id === nextStageId)?.is_closed ?? false;
    updateJob.mutate({ lifecycle_stage_id: nextStageId || null });
    if (willBeClosed && !wasClosed) {
      if (window.confirm("Job marked as done. Send an automated review request to the client?")) {
        queueReviewRequest.mutate();
      }
    }
  };

  const { data: linkedReports } = useQuery({
    queryKey: ["job-reports", id],
    queryFn: () => fetchLinkedReports(id!),
    enabled: !!id,
  });
  const { data: activeReportTemplates } = useQuery({ queryKey: ["report-templates", "active"], queryFn: fetchActiveReportTemplates });
  const { data: allReportTemplates } = useQuery({ queryKey: ["report-templates", "all"], queryFn: fetchAllReportTemplates });

  const { data: linkedPurchaseOrders } = useQuery({
    queryKey: ["job-purchase-orders", id],
    queryFn: () => fetchLinkedPurchaseOrders(id!),
    enabled: !!id,
  });
  const { data: allSubcontractors } = useQuery({ queryKey: ["subcontractors"], queryFn: fetchSubcontractors });
  const [assignSubModalOpen, setAssignSubModalOpen] = useState(false);
  const [assignSubTradeFilter, setAssignSubTradeFilter] = useState<SubcontractorTrade | "">("");

  const [createReportModalOpen, setCreateReportModalOpen] = useState(false);
  const [createReportSearch, setCreateReportSearch] = useState("");
  const [createReportError, setCreateReportError] = useState<string | null>(null);

  const startReportForJob = async (templateId: string) => {
    if (!profile || !job) return;
    setCreateReportError(null);
    const { data, error } = await supabase
      .from("report_instances")
      .insert({
        tenant_id: profile.tenant_id,
        template_id: templateId,
        job_card_id: job.id,
        client_id: job.client_id,
        created_by: profile.id,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) {
      setCreateReportError(getErrorMessage(error, "Failed to start report"));
      return;
    }
    navigate(`/reports/instances/${data.id}`);
  };

  const [linkReportModalOpen, setLinkReportModalOpen] = useState(false);
  const { data: unlinkedReports } = useQuery({
    queryKey: ["report-instances", "unlinked"],
    queryFn: fetchUnlinkedReports,
    enabled: linkReportModalOpen,
  });
  const [linkReportError, setLinkReportError] = useState<string | null>(null);

  const linkExistingReport = useMutation({
    mutationFn: async (reportId: string) => {
      if (!job) throw new Error("Job not loaded");
      const { error } = await supabase.from("report_instances").update({ job_card_id: job.id, client_id: job.client_id }).eq("id", reportId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-reports", id] });
      queryClient.invalidateQueries({ queryKey: ["report-instances", "unlinked"] });
      setLinkReportModalOpen(false);
    },
    onError: (e) => setLinkReportError(getErrorMessage(e, "Failed to link report")),
  });

  const [photoError, setPhotoError] = useState<string | null>(null);

  const uploadPhotos = useMutation({
    mutationFn: async (fileList: FileList) => {
      if (!profile) throw new Error("Not signed in");
      // Sequential, not Promise.all - keeps upload order predictable and
      // avoids hammering Storage with a burst of concurrent PUTs for a
      // multi-select of, say, 20 photos.
      for (const file of Array.from(fileList)) {
        await uploadJobPhoto({ tenantId: profile.tenant_id, jobCardId: id!, uploadedBy: profile.id, file });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-files", id] });
      setPhotoError(null);
    },
    onError: (e) => setPhotoError(getErrorMessage(e, "Failed to upload photo")),
  });

  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const addNote = useMutation({
    mutationFn: async () => {
      const result = createJobNoteSchema.safeParse({ job_card_id: id, body: noteBody });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: id,
        author_id: profile.id,
        body: result.data.body,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-notes", id] });
      setNoteBody("");
      setNoteError(null);
    },
    onError: (e) => setNoteError(getErrorMessage(e, "Failed to add note")),
  });

  if (!job) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  const address = client ? formatClientAddress(client) : null;

  // Per-job costing breakdown - same math/caveats as JobCosting.tsx's
  // cross-job report (GST-inclusive charged vs. GST-exclusive cost, and a
  // converted quote+invoice pair double-counting since both stay linked to
  // the job), just scoped to this one job instead of every job at once.
  const allCostingLineItems = [...(quoteLineItems ?? []), ...(invoiceLineItems ?? [])];
  const totalLabourCents = allCostingLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item), 0);
  const totalMaterialCents = allCostingLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
  const totalChargedCents =
    (linkedQuotes ?? []).reduce((sum, q) => sum + q.total_cents, 0) +
    (linkedInvoices ?? []).reduce((sum, inv) => sum + inv.total_cents, 0);
  const marginCents = totalChargedCents - (totalLabourCents + totalMaterialCents);
  const marginPercent = totalChargedCents > 0 ? (marginCents / totalChargedCents) * 100 : 0;
  const hasCostingDocs = (linkedQuotes ?? []).length > 0 || (linkedInvoices ?? []).length > 0;

  // Same "is this job over its NTE budget" check the mobile app's
  // completion guardrail uses (see the mobile jobs/[id].tsx equivalent) -
  // shown here read-only so an admin can see the state without needing a
  // phone in hand.
  const isNteExceeded = job.is_real_estate_job && job.nte_limit_cents != null && totalChargedCents > job.nte_limit_cents;

  return (
    <div className="p-8">
      <Link to="/jobs" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Jobs
      </Link>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-xs font-bold text-blue-700">{job.number ?? "Pending"}</span>
          <h1 className="text-xl font-bold text-gray-900">{job.title}</h1>
        </div>
        {job.description ? <p className="mb-4 text-sm text-gray-600">{job.description}</p> : null}

        {client ? (
          <div className="mb-4 rounded-md bg-gray-50 p-3 text-sm">
            <p className="font-semibold text-gray-900">
              <Link to={`/clients/${client.id}`} className="hover:underline">
                {client.name}
              </Link>
            </p>
            {client.phone ? <p className="text-gray-600">{client.phone}</p> : null}
            {address ? <p className="text-gray-600">{address}</p> : null}
          </div>
        ) : null}

        {job.is_real_estate_job ? (
          <div className="mb-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-blue-700 px-2 py-0.5 text-xs font-bold text-white">Agency Job</span>
              {agency ? <span className="font-semibold text-gray-900">{agency.name}</span> : null}
              {propertyManager ? (
                <span className="text-gray-600">
                  PM: {propertyManager.first_name} {propertyManager.last_name}
                </span>
              ) : null}
            </div>
            {property ? (
              <p className="text-gray-600">
                <Link to={`/real-estate/properties/${property.id}`} className="text-blue-700 hover:underline">
                  {property.address_line1}, {property.suburb}
                </Link>
                {property.key_tag_number ? ` - 🔑 ${property.key_tag_number}` : ""}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-x-4 text-gray-600">
              {job.work_order_number ? <span>Work order: {job.work_order_number}</span> : null}
              {job.nte_limit_cents != null ? <span>NTE limit: {formatCentsAsAud(job.nte_limit_cents)}</span> : null}
            </div>
            {isNteExceeded ? (
              <p className="mt-1 font-semibold text-red-700">
                {job.nte_exceeded_approved
                  ? "Over NTE limit - variation approved"
                  : "Over NTE limit - awaiting PM approval before this job can be completed"}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Category</label>
            <select
              value={job.service_category_id ?? ""}
              onChange={(e) => updateJob.mutate({ service_category_id: e.target.value || null })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">None</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Stage</label>
            <select
              value={job.lifecycle_stage_id ?? ""}
              onChange={(e) => handleStageChange(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">None</option>
              {(stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-500">Technician</label>
            <select
              value={job.assigned_technician_id ?? ""}
              onChange={(e) => updateJob.mutate({ assigned_technician_id: e.target.value || null })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">Unassigned</option>
              {(technicians ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {reviewRequestError ? <p className="mt-3 text-sm text-red-600">{reviewRequestError}</p> : null}
        {reviewRequestResult ? <p className="mt-3 text-sm text-green-700">{reviewRequestResult}</p> : null}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Quotes</h2>
            <Link to={`/quotes/new?clientId=${job.client_id}&jobCardId=${job.id}`} className="text-sm font-semibold text-blue-700 hover:underline">
              + New quote
            </Link>
          </div>
          {!linkedQuotes || linkedQuotes.length === 0 ? (
            <p className="text-sm text-gray-500">No quotes linked to this job.</p>
          ) : (
            <div className="space-y-1">
              {linkedQuotes.map((q) => (
                <Link key={q.id} to={`/quotes/${q.id}`} className="flex justify-between text-sm hover:underline">
                  <span className="text-blue-700">{q.quote_number}</span>
                  <span className="text-gray-600">{formatCentsAsAud(q.total_cents)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Invoices</h2>
            <Link to={`/invoices/new?clientId=${job.client_id}&jobCardId=${job.id}`} className="text-sm font-semibold text-blue-700 hover:underline">
              + New invoice
            </Link>
          </div>
          {!linkedInvoices || linkedInvoices.length === 0 ? (
            <p className="text-sm text-gray-500">No invoices linked to this job.</p>
          ) : (
            <div className="space-y-1">
              {linkedInvoices.map((inv) => (
                <Link key={inv.id} to={`/invoices/${inv.id}`} className="flex justify-between text-sm hover:underline">
                  <span className="text-blue-700">{inv.invoice_number}</span>
                  <span className="text-gray-600">{formatCentsAsAud(inv.total_cents)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Job Costing</h2>
        {!hasCostingDocs ? (
          <p className="text-sm text-gray-500">No quotes or invoices linked to this job yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-gray-500">Labour cost</p>
                <p className="text-sm font-semibold text-gray-900">{formatCentsAsAud(totalLabourCents)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Material cost</p>
                <p className="text-sm font-semibold text-gray-900">{formatCentsAsAud(totalMaterialCents)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Total charged</p>
                <p className="text-sm font-semibold text-gray-900">{formatCentsAsAud(totalChargedCents)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Margin</p>
                <p className="text-sm font-bold text-gray-900">
                  {formatCentsAsAud(marginCents)} <span className="font-normal text-gray-500">({marginPercent.toFixed(1)}%)</span>
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-gray-400">
              Margin treats total charged (GST-inclusive) minus labour/material cost (GST-exclusive) - a small
              overstatement of true margin. A quote converted to an invoice stays linked to the job as both and is
              summed twice here, same as the cross-job{" "}
              <Link to="/job-costing" className="underline">
                Job Costing
              </Link>{" "}
              report.
            </p>
          </>
        )}
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Photos</h2>
          <label className="cursor-pointer rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
            {uploadPhotos.isPending ? "Uploading..." : "+ Upload photos"}
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={uploadPhotos.isPending}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) uploadPhotos.mutate(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {photoError ? <p className="mb-3 text-sm text-red-600">{photoError}</p> : null}
        {!files || files.length === 0 ? (
          <p className="text-sm text-gray-500">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {files.map((f) => (
              <a
                key={f.id}
                href={fileUrls?.[f.id] || undefined}
                target="_blank"
                rel="noreferrer"
                className="block aspect-square overflow-hidden rounded-md border border-gray-200 bg-gray-100"
              >
                {fileUrls?.[f.id] ? (
                  <img src={fileUrls[f.id]} alt={f.file_name} className="h-full w-full object-cover" />
                ) : null}
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Roof Measurement</h2>
          <Link
            to={`/jobs/${id}/measure`}
            className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
          >
            📐 Measure Roof
          </Link>
        </div>
        {!measurements || measurements.length === 0 ? (
          <p className="text-sm text-gray-500">
            Draw roof sections on a satellite map and save the total area to this job.
          </p>
        ) : (
          <div className="space-y-2">
            {measurements.map((m) => (
              <div key={m.id} className="flex items-center justify-between border-t border-gray-100 pt-2 text-sm first:border-0 first:pt-0">
                <div>
                  <p className="font-medium text-gray-900">{m.title}</p>
                  <p className="text-xs text-gray-500">{new Date(m.created_at).toLocaleDateString("en-AU")}</p>
                </div>
                <p className="text-right text-gray-700">
                  {m.total_true_area_sqm.toFixed(1)} m² true
                  <span className="block text-xs text-gray-400">{m.total_flat_area_sqm.toFixed(1)} m² flat</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Notes</h2>
        <div className="mb-4">
          <TextAreaField label="Add a note" rows={2} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
          {noteError ? <p className="mb-2 text-sm text-red-600">{noteError}</p> : null}
          <button
            onClick={() => addNote.mutate()}
            disabled={addNote.isPending || !noteBody.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {addNote.isPending ? "Adding..." : "Add note"}
          </button>
        </div>
        <div className="space-y-3">
          {(notes ?? []).map((note) => (
            <div key={note.id} className="border-t border-gray-100 pt-3 text-sm">
              <p className="text-gray-800">{note.body}</p>
              <p className="mt-1 text-xs text-gray-400">{new Date(note.created_at).toLocaleString()}</p>
            </div>
          ))}
          {notes && notes.length === 0 ? <p className="text-sm text-gray-500">No notes yet.</p> : null}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Reports & Safety</h2>
          <div className="flex gap-2">
            <button
              onClick={() => setLinkReportModalOpen(true)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Link Existing Report
            </button>
            <button
              onClick={() => setCreateReportModalOpen(true)}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
            >
              + Create New Report
            </button>
          </div>
        </div>
        {!linkedReports || linkedReports.length === 0 ? (
          <p className="text-sm text-gray-500">No reports linked to this job yet.</p>
        ) : (
          <div className="space-y-2">
            {linkedReports.map((report) => {
              const template = (allReportTemplates ?? []).find((t) => t.id === report.template_id);
              return (
                <Link
                  key={report.id}
                  to={`/reports/instances/${report.id}`}
                  className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2 text-sm hover:bg-gray-50"
                >
                  <span className="font-medium text-blue-700">{template?.title ?? "Report"}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      report.status === "draft" ? "bg-amber-100 text-amber-800" : report.status === "completed" ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {report.status.charAt(0).toUpperCase() + report.status.slice(1)}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Subcontractors</h2>
          <button
            onClick={() => setAssignSubModalOpen(true)}
            className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
          >
            + Assign Subcontractor
          </button>
        </div>
        {!linkedPurchaseOrders || linkedPurchaseOrders.length === 0 ? (
          <p className="text-sm text-gray-500">No subcontractor work orders or quote requests for this job yet.</p>
        ) : (
          <div className="space-y-1">
            {linkedPurchaseOrders.map((po) => {
              const sub = (allSubcontractors ?? []).find((s) => s.id === po.subcontractor_id);
              return (
                <Link
                  key={po.id}
                  to={`/subcontractors/purchase-orders/${po.id}`}
                  className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2 text-sm hover:bg-gray-50"
                >
                  <span>
                    <span className="font-medium text-blue-700">{po.po_number ?? "Pending"}</span>{" "}
                    <span className="text-gray-500">
                      {sub?.company_name ?? "Unknown subcontractor"} - {po.is_quote_request ? "Quote Request" : "Work Order"}
                    </span>
                  </span>
                  <span className="text-gray-600">{formatCentsAsAud(po.total_cost_cents)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Communication Log</h2>
        <CommunicationLog
          entities={[
            { entityType: "job", entityId: job.id },
            ...(linkedQuotes ?? []).map((q) => ({ entityType: "quote" as const, entityId: q.id })),
            ...(linkedInvoices ?? []).map((inv) => ({ entityType: "invoice" as const, entityId: inv.id })),
          ]}
        />
      </div>

      <Modal open={createReportModalOpen} onClose={() => setCreateReportModalOpen(false)} title="Create new report">
        <FormField label="Search templates" value={createReportSearch} onChange={(e) => setCreateReportSearch(e.target.value)} placeholder="Search by title..." />
        {createReportError ? <p className="mb-4 text-sm text-red-600">{createReportError}</p> : null}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {(activeReportTemplates ?? [])
            .filter((t) => t.title.toLowerCase().includes(createReportSearch.trim().toLowerCase()))
            .map((template) => (
              <button
                key={template.id}
                onClick={() => startReportForJob(template.id)}
                className="flex w-full items-center justify-between rounded-md border border-gray-100 px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="font-medium text-gray-900">{template.title}</span>
                {template.is_swms ? (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">SWMS</span>
                ) : null}
              </button>
            ))}
          {(activeReportTemplates ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">
              No report templates yet -{" "}
              <Link to="/reports" className="text-blue-700 hover:underline">
                build one in the Template Studio
              </Link>
              .
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal open={linkReportModalOpen} onClose={() => setLinkReportModalOpen(false)} title="Link existing report">
        {linkReportError ? <p className="mb-4 text-sm text-red-600">{linkReportError}</p> : null}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {(unlinkedReports ?? []).map((report) => {
            const template = (allReportTemplates ?? []).find((t) => t.id === report.template_id);
            return (
              <button
                key={report.id}
                onClick={() => linkExistingReport.mutate(report.id)}
                disabled={linkExistingReport.isPending}
                className="flex w-full items-center justify-between rounded-md border border-gray-100 px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-60"
              >
                <span className="font-medium text-gray-900">{template?.title ?? "Report"}</span>
                <span className="text-xs text-gray-400">{new Date(report.created_at).toLocaleDateString("en-AU")}</span>
              </button>
            );
          })}
          {(unlinkedReports ?? []).length === 0 ? <p className="text-sm text-gray-500">No unlinked standalone reports.</p> : null}
        </div>
      </Modal>

      <Modal open={assignSubModalOpen} onClose={() => setAssignSubModalOpen(false)} title="Assign subcontractor">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Filter by trade</label>
          <select
            value={assignSubTradeFilter}
            onChange={(e) => setAssignSubTradeFilter(e.target.value as SubcontractorTrade | "")}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">All trades</option>
            {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
              <option key={trade} value={trade}>
                {TRADE_LABELS[trade]}
              </option>
            ))}
          </select>
        </div>

        <div className="max-h-96 space-y-2 overflow-y-auto">
          {(allSubcontractors ?? [])
            .filter((s) => !assignSubTradeFilter || s.trades.includes(assignSubTradeFilter))
            .map((sub) => {
              const onHold = sub.status === "compliance_hold";
              return (
                <div key={sub.id} className={`rounded-md border p-3 ${onHold ? "border-red-100 bg-red-50" : "border-gray-100"}`}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={`font-medium ${onHold ? "text-gray-400" : "text-gray-900"}`}>{sub.company_name}</span>
                    <span className="text-xs text-gray-500">{TIER_LABELS[sub.preference_tier]}</span>
                  </div>
                  {onHold ? (
                    <p className="mb-2 text-xs text-red-700">
                      On compliance hold - expired documents must be renewed before new work can be issued.
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Link
                      to={`/subcontractors/purchase-orders/new?subcontractorId=${sub.id}&quoteRequest=true&jobCardId=${id}`}
                      onClick={(e) => onHold && e.preventDefault()}
                      className={`flex-1 rounded-md px-3 py-1.5 text-center text-xs font-semibold ${
                        onHold ? "cursor-not-allowed bg-gray-100 text-gray-400" : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      Request Quote
                    </Link>
                    <Link
                      to={`/subcontractors/purchase-orders/new?subcontractorId=${sub.id}&quoteRequest=false&jobCardId=${id}`}
                      onClick={(e) => onHold && e.preventDefault()}
                      className={`flex-1 rounded-md px-3 py-1.5 text-center text-xs font-semibold text-white ${
                        onHold ? "cursor-not-allowed bg-gray-300" : "bg-blue-700 hover:bg-blue-800"
                      }`}
                    >
                      Issue Work Order
                    </Link>
                  </div>
                </div>
              );
            })}
          {(allSubcontractors ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">
              No subcontractors yet -{" "}
              <Link to="/subcontractors" className="text-blue-700 hover:underline">
                add one first
              </Link>
              .
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
