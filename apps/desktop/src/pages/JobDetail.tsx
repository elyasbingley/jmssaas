import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  collectRecipientEmails,
  createClientSiteSchema,
  createJobCardSchema,
  createJobNoteSchema,
  formatCentsAsAud,
  type Agency,
  type Client,
  type ClientContact,
  type ClientSite,
  type EmailAttachment,
  type Invoice,
  type InvoiceLineItem,
  type JobCard,
  type JobFile,
  type JobLifecycleStage,
  type JobNote,
  type Profile,
  type Property,
  type PropertyManager,
  type Quote,
  type QuoteLineItem,
  type PurchaseOrder,
  type ReferralPartner,
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
import { queueAndSendEmail } from "../lib/send-email";
import { formatClientAddress } from "../lib/format";
import { uploadJobPhoto } from "../lib/uploads";
import { pushCalendarEventUpsert } from "../lib/google-calendar-sync";
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";
import { CommunicationLog } from "../components/CommunicationLog";
import { EmailComposeModal, type EmailTemplateOption } from "../components/EmailComposeModal";
import { QuoteToolsSection } from "../components/quote-tools/QuoteToolsSection";
import { JobMembershipBenefitSection } from "../components/JobMembershipBenefitSection";
import { RealEstateAssignmentModal } from "../components/RealEstateAssignmentModal";
import { WorkOrderNumberModal } from "../components/WorkOrderNumberModal";
import { ReferralPartnerModal, referralPartnerLabel } from "../components/ReferralPartnerModal";
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

async function fetchClientSites(clientId: string): Promise<ClientSite[]> {
  const { data, error } = await supabase
    .from("client_sites")
    .select("*")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("label");
  if (error) throw error;
  return data as ClientSite[];
}

function formatSiteAddress(site: Pick<ClientSite, "address_line1" | "address_line2" | "suburb" | "state" | "postcode">): string {
  return [site.address_line1, site.address_line2, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

async function fetchClientContacts(clientId: string): Promise<ClientContact[]> {
  const { data, error } = await supabase.from("client_contacts").select("*").eq("client_id", clientId);
  if (error) throw error;
  return data as ClientContact[];
}

// Every active email template, any trigger - the free-form job email is a
// "pick a starting point or write from scratch" tool, not scoped to one
// automation trigger the way the quote/invoice send buttons are.
async function fetchEmailTemplates(tenantId: string): Promise<EmailTemplateOption[]> {
  const { data, error } = await supabase
    .from("communication_templates")
    .select("id, name, subject, body")
    .eq("tenant_id", tenantId)
    .eq("type", "email")
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return (data ?? []).map((t) => ({ id: t.id as string, name: t.name as string, subject: (t.subject as string | null) ?? "", body: t.body as string }));
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
async function fetchReferralPartner(id: string): Promise<ReferralPartner> {
  const { data, error } = await supabase.from("referral_partners").select("*").eq("id", id).single();
  if (error) throw error;
  return data as ReferralPartner;
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

// Any profile can be assigned a job - not just role='technician' - so an
// admin who also does field work (common in a small team) can assign
// jobs to themselves too, not only to technician accounts.
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
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
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const { data: job } = useQuery({ queryKey: ["job", id], queryFn: () => fetchJob(id!), enabled: !!id });
  const { data: client } = useQuery({
    queryKey: ["client", job?.client_id],
    queryFn: () => fetchClient(job!.client_id),
    enabled: !!job,
  });
  const { data: clientSites } = useQuery({
    queryKey: ["client-sites", job?.client_id],
    queryFn: () => fetchClientSites(job!.client_id),
    enabled: !!job,
  });
  const { data: clientContacts } = useQuery({
    queryKey: ["client-contacts", job?.client_id],
    queryFn: () => fetchClientContacts(job!.client_id),
    enabled: !!job,
  });
  const { data: emailTemplates } = useQuery({
    queryKey: ["email-templates", profile?.tenant_id],
    queryFn: () => fetchEmailTemplates(profile!.tenant_id),
    enabled: !!profile,
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
  const { data: referralPartner } = useQuery({
    queryKey: ["referral-partner", job?.referral_partner_id],
    queryFn: () => fetchReferralPartner(job!.referral_partner_id!),
    enabled: !!job?.referral_partner_id,
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

  // "+ Add to calendar" - previously the only way to get a job onto the
  // calendar was dragging its Dispatch board card onto a technician's
  // timeline slot (see Dispatch.tsx's own scheduleJob mutation, which
  // this mirrors); there was no way to do it from the job's own page at
  // all. Deliberately a minimal date/time/technician form rather than
  // reusing the full CalendarEventEditor (recurrence, guests, location,
  // category override) - "quickly schedule this job" doesn't need any of
  // that, and this job already has its own separate Category/Stage/
  // Technician card above for everything else.
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleStartTime, setScheduleStartTime] = useState("09:00");
  const [scheduleEndTime, setScheduleEndTime] = useState("10:00");
  const [scheduleTechnicianId, setScheduleTechnicianId] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const openScheduleModal = () => {
    const today = new Date();
    setScheduleDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
    setScheduleStartTime("09:00");
    setScheduleEndTime("10:00");
    setScheduleTechnicianId(job?.assigned_technician_id ?? "");
    setScheduleError(null);
    setScheduleModalOpen(true);
  };

  const scheduleToCalendar = useMutation({
    mutationFn: async () => {
      if (!job || !profile) throw new Error("Not signed in");
      if (!scheduleDate || !scheduleStartTime || !scheduleEndTime) throw new Error("Pick a date and time");
      const start = new Date(`${scheduleDate}T${scheduleStartTime}:00`);
      const end = new Date(`${scheduleDate}T${scheduleEndTime}:00`);
      if (end <= start) throw new Error("End time must be after start time");

      const { data: insertedEvent, error: eventError } = await supabase
        .from("calendar_events")
        .insert({
          tenant_id: job.tenant_id,
          title: job.title,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          all_day: false,
          job_card_id: job.id,
          created_by: profile.id,
        })
        .select("id")
        .single();
      if (eventError) throw eventError;

      if (scheduleTechnicianId && scheduleTechnicianId !== job.assigned_technician_id) {
        const { error: jobError } = await supabase.from("job_cards").update({ assigned_technician_id: scheduleTechnicianId }).eq("id", job.id);
        if (jobError) throw jobError;
      }

      // Must come after the job_cards write above lands, same ordering
      // Dispatch.tsx's own scheduleJob mutation relies on, so the push
      // resolves the assignee's fresh (not stale) technician.
      await pushCalendarEventUpsert(insertedEvent.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      setScheduleModalOpen(false);
    },
    onError: (e) => setScheduleError(getErrorMessage(e, "Failed to add to calendar")),
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

  // Despite the name (kept for the storage_path convention/RLS policies -
  // see uploadJobPhoto's own comment), this has never actually been
  // restricted to images at the storage/DB layer - job_files has always
  // stored mime_type/size_bytes generically. The upload input below used
  // to hardcode accept="image/*" though, which was the entire "no way to
  // upload files" gap - fixed by dropping that restriction and rendering
  // non-image files as a name+icon tile instead of an <img> below.
  const uploadFiles = useMutation({
    mutationFn: async (fileList: FileList) => {
      if (!profile) throw new Error("Not signed in");
      // Sequential, not Promise.all - keeps upload order predictable and
      // avoids hammering Storage with a burst of concurrent PUTs for a
      // multi-select of, say, 20 files.
      for (const file of Array.from(fileList)) {
        await uploadJobPhoto({ tenantId: profile.tenant_id, jobCardId: id!, uploadedBy: profile.id, file });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-files", id] });
      setPhotoError(null);
    },
    onError: (e) => setPhotoError(getErrorMessage(e, "Failed to upload file")),
  });

  // Admin-only, matching the RLS delete policies on both the storage
  // object ("job-files: admin deletes") and the job_files row ("job_files:
  // admin deletes") - a non-admin's delete would just fail RLS, so the
  // button itself is admin-gated below rather than showing a control that
  // silently errors for everyone else.
  const deleteFile = useMutation({
    mutationFn: async (file: JobFile) => {
      const { error: storageError } = await supabase.storage.from("job-files").remove([file.storage_path]);
      if (storageError) throw storageError;
      const { error: rowError } = await supabase.from("job_files").delete().eq("id", file.id);
      if (rowError) throw rowError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-files", id] });
      setPhotoError(null);
    },
    onError: (e) => setPhotoError(getErrorMessage(e, "Failed to delete file")),
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

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteBody, setEditingNoteBody] = useState("");
  const [editNoteError, setEditNoteError] = useState<string | null>(null);

  const startEditNote = (note: JobNote) => {
    setEditingNoteId(note.id);
    setEditingNoteBody(note.body);
    setEditNoteError(null);
  };

  const updateNote = useMutation({
    mutationFn: async () => {
      if (!editingNoteId) return;
      const result = createJobNoteSchema.safeParse({ job_card_id: id, body: editingNoteBody });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");
      const { error } = await supabase.from("job_notes").update({ body: result.data.body }).eq("id", editingNoteId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-notes", id] });
      setEditingNoteId(null);
    },
    onError: (e) => setEditNoteError(getErrorMessage(e, "Failed to save note")),
  });

  // --- Job address (client_sites.site_id) + WorkDrive link ---
  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [addressSiteChoice, setAddressSiteChoice] = useState<string>("");
  const [newAddressForm, setNewAddressForm] = useState({ label: "", address_line1: "", address_line2: "", suburb: "", state: "", postcode: "" });
  const [addressError, setAddressError] = useState<string | null>(null);

  const openAddressModal = () => {
    setAddressSiteChoice(job?.site_id ?? "");
    setNewAddressForm({ label: "", address_line1: "", address_line2: "", suburb: "", state: "", postcode: "" });
    setAddressError(null);
    setAddressModalOpen(true);
  };

  const updateJobSite = useMutation({
    mutationFn: async () => {
      if (!profile || !job || !client) throw new Error("Not signed in");
      let siteId: string | null = addressSiteChoice && addressSiteChoice !== "new" ? addressSiteChoice : null;
      if (addressSiteChoice === "new") {
        const result = createClientSiteSchema.safeParse({ ...newAddressForm, client_id: client.id });
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Enter a valid address");
        const { data: newSite, error: siteError } = await supabase
          .from("client_sites")
          .insert({
            tenant_id: profile.tenant_id,
            client_id: client.id,
            label: result.data.label || null,
            address_line1: result.data.address_line1,
            address_line2: result.data.address_line2 || null,
            suburb: result.data.suburb,
            state: result.data.state,
            postcode: result.data.postcode,
          })
          .select("id")
          .single();
        if (siteError) throw siteError;
        siteId = newSite.id as string;
      }
      const { error } = await supabase.from("job_cards").update({ site_id: siteId }).eq("id", job.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      queryClient.invalidateQueries({ queryKey: ["client-sites", job?.client_id] });
      setAddressModalOpen(false);
    },
    onError: (e) => setAddressError(getErrorMessage(e, "Failed to update address")),
  });

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const saveEdit = useMutation({
    mutationFn: async () => {
      if (!job) throw new Error("Job not loaded");
      const result = createJobCardSchema.safeParse({
        client_id: job.client_id,
        title: editTitle,
        description: editDescription,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid job");
      const { error } = await supabase
        .from("job_cards")
        .update({ title: result.data.title, description: result.data.description || null })
        .eq("id", job.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setEditModalOpen(false);
    },
    onError: (e) => setEditError(getErrorMessage(e, "Failed to save")),
  });

  const [workdriveModalOpen, setWorkdriveModalOpen] = useState(false);
  const [workdriveInput, setWorkdriveInput] = useState("");
  const [workdriveError, setWorkdriveError] = useState<string | null>(null);

  const saveWorkdrive = useMutation({
    mutationFn: async () => {
      if (!job) throw new Error("Job not loaded");
      const { error } = await supabase.from("job_cards").update({ workdrive_url: workdriveInput || null }).eq("id", job.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      setWorkdriveModalOpen(false);
    },
    onError: (e) => setWorkdriveError(getErrorMessage(e, "Failed to save WorkDrive link")),
  });

  const [realEstateModalOpen, setRealEstateModalOpen] = useState(false);
  const [workOrderModalOpen, setWorkOrderModalOpen] = useState(false);
  const [referralModalOpen, setReferralModalOpen] = useState(false);

  // Free-form job card email - similar to ServiceM8's per-job "Email"
  // button: pick a template (or write from scratch), review/edit the body,
  // choose to/cc/bcc, send. Uses entity_type 'job' with its own trigger_key
  // ('manual_email') so it's distinguishable from templated automation in
  // the Communication Log, and goes through the same queueAndSendEmail
  // helper as the quote/invoice composer.
  const [jobEmailModalOpen, setJobEmailModalOpen] = useState(false);
  const [jobEmailError, setJobEmailError] = useState<string | null>(null);
  const [jobEmailResult, setJobEmailResult] = useState<string | null>(null);

  const handleSendJobEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile || !job) throw new Error("Not signed in");
    const wasSent = await queueAndSendEmail({
      tenantId: profile.tenant_id,
      entityType: "job",
      entityId: job.id,
      triggerKey: "manual_email",
      ...payload,
    });
    queryClient.invalidateQueries({ queryKey: ["communication-log"] });
    setJobEmailError(null);
    setJobEmailResult(wasSent ? "Email sent." : "Email queued and will send shortly.");
    setTimeout(() => setJobEmailResult(null), 5000);
  };

  if (!job) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  const jobSite = (clientSites ?? []).find((s) => s.id === job.site_id) ?? null;
  const address = jobSite ? formatSiteAddress(jobSite) : client ? formatClientAddress(client) : null;
  const jobRecipientOptions = collectRecipientEmails({
    clientEmail: client?.email,
    contactEmails: (clientContacts ?? []).map((c) => c.email),
    freeText: [job.description, ...(notes ?? []).map((n) => n.body)],
  });

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

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-blue-700">{job.number ?? "Pending"}</span>
            <h1 className="text-xl font-bold text-gray-900">{job.title}</h1>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              onClick={() => {
                setEditTitle(job.title);
                setEditDescription(job.description ?? "");
                setEditError(null);
                setEditModalOpen(true);
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
            <button
              onClick={() => setJobEmailModalOpen(true)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Email
            </button>
          </div>
        </div>
        {job.description ? <p className="mb-4 whitespace-pre-wrap text-sm text-gray-600">{job.description}</p> : null}
        {jobEmailError ? <p className="mb-2 text-sm text-red-600">{jobEmailError}</p> : null}
        {jobEmailResult ? <p className="mb-2 text-sm text-green-700">{jobEmailResult}</p> : null}

        {client ? (
          <div className="mb-4 rounded-md bg-gray-50 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="font-semibold text-gray-900">
                <Link to={`/clients/${client.id}`} className="hover:underline">
                  {client.client_type === "company" && client.company_name ? client.company_name : client.name}
                </Link>
              </p>
              <button onClick={openAddressModal} className="whitespace-nowrap text-xs font-semibold text-blue-700 hover:underline">
                Edit address
              </button>
            </div>
            {client.phone ? <p className="text-gray-600">{client.phone}</p> : null}
            {address ? (
              <p className="text-gray-600">
                {jobSite?.label ? `${jobSite.label}: ` : ""}
                {address}
              </p>
            ) : (
              <p className="text-gray-400">No address on file</p>
            )}
          </div>
        ) : null}

        {!job.is_real_estate_job ? (
          <button
            onClick={() => setRealEstateModalOpen(true)}
            className="mb-4 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            Mark as real estate / strata job
          </button>
        ) : null}

        <div className="mb-4 rounded-md border border-gray-300 p-3 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">WorkDrive</h3>
            <button
              onClick={() => {
                setWorkdriveInput(job.workdrive_url ?? "");
                setWorkdriveError(null);
                setWorkdriveModalOpen(true);
              }}
              className="text-xs font-semibold text-blue-700 hover:underline"
            >
              {job.workdrive_url ? "Edit link" : "+ Add link"}
            </button>
          </div>
          {job.workdrive_url ? (
            <a href={job.workdrive_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-blue-700 hover:underline">
              Open WorkDrive folder &rarr;
            </a>
          ) : (
            <p className="mt-1 text-gray-400">No WorkDrive link for this job yet.</p>
          )}
        </div>

        <div className="mb-4 flex items-center justify-between rounded-md border border-gray-300 p-3 text-sm">
          <span className="text-gray-600">
            Referral source: {referralPartner ? referralPartnerLabel(referralPartner) : "None"}
          </span>
          <button onClick={() => setReferralModalOpen(true)} className="text-xs font-semibold text-blue-700 hover:underline">
            {job.referral_partner_id ? "Edit" : "+ Add"}
          </button>
        </div>

        {job.is_real_estate_job ? (
          <div className="mb-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-blue-700 px-2 py-0.5 text-xs font-bold text-white">Agency Job</span>
                {agency ? <span className="font-semibold text-gray-900">{agency.name}</span> : null}
                {propertyManager ? (
                  <span className="text-gray-600">
                    PM: {propertyManager.first_name} {propertyManager.last_name}
                  </span>
                ) : null}
              </div>
              <button onClick={() => setRealEstateModalOpen(true)} className="whitespace-nowrap text-xs font-semibold text-blue-700 hover:underline">
                Edit
              </button>
            </div>
            {property ? (
              <p className="text-gray-600">
                <Link to={`/real-estate/properties/${property.id}`} className="text-blue-700 hover:underline">
                  {property.address_line1}, {property.suburb}
                </Link>
                {property.key_tag_number ? ` - 🔑 ${property.key_tag_number}` : ""}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-x-4 text-gray-600">
              <span>
                Work order: {job.work_order_number ?? "Not set"}{" "}
                <button onClick={() => setWorkOrderModalOpen(true)} className="text-xs font-semibold text-blue-700 hover:underline">
                  {job.work_order_number ? "Edit" : "+ Add"}
                </button>
              </span>
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

        {/* 2 columns, not 3 - a native <select>'s closed-state text clips
            hard at the box edge with no ellipsis once it's too narrow, and
            category/stage/technician names are admin-defined free text
            with no length cap, so this trades a slightly taller layout for
            enough room that long names stop getting cut off mid-word. */}
        <div className="grid grid-cols-2 gap-4">
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
        <button
          onClick={openScheduleModal}
          className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          + Add to calendar
        </button>
        {reviewRequestError ? <p className="mt-3 text-sm text-red-600">{reviewRequestError}</p> : null}
        {reviewRequestResult ? <p className="mt-3 text-sm text-green-700">{reviewRequestResult}</p> : null}
      </div>

      <Modal open={scheduleModalOpen} onClose={() => setScheduleModalOpen(false)} title="Add to calendar">
        <FormField label="Date" type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start time" type="time" value={scheduleStartTime} onChange={(e) => setScheduleStartTime(e.target.value)} />
          <FormField label="End time" type="time" value={scheduleEndTime} onChange={(e) => setScheduleEndTime(e.target.value)} />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Technician</label>
          <select
            value={scheduleTechnicianId}
            onChange={(e) => setScheduleTechnicianId(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Unassigned</option>
            {(technicians ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </select>
        </div>
        {scheduleError ? <p className="mb-4 text-sm text-red-600">{scheduleError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setScheduleModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => scheduleToCalendar.mutate()}
            disabled={scheduleToCalendar.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {scheduleToCalendar.isPending ? "Adding..." : "Add to calendar"}
          </button>
        </div>
      </Modal>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-300 bg-white p-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Quotes</h2>
            <Link
              to={`/quotes/new?clientId=${job.client_id}&jobCardId=${job.id}${job.referral_partner_id ? `&referralPartnerId=${job.referral_partner_id}` : ""}`}
              className="text-sm font-semibold text-blue-700 hover:underline"
            >
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
        <div className="rounded-lg border border-gray-300 bg-white p-6">
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

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
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

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Files</h2>
          <label className="cursor-pointer rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
            {uploadFiles.isPending ? "Uploading..." : "+ Upload files"}
            <input
              type="file"
              multiple
              className="hidden"
              disabled={uploadFiles.isPending}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) uploadFiles.mutate(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {photoError ? <p className="mb-3 text-sm text-red-600">{photoError}</p> : null}
        {!files || files.length === 0 ? (
          <p className="text-sm text-gray-500">No files yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {files.map((f) => {
              // mime_type isn't reliably populated for every upload (some
              // browsers/file pickers hand back an empty File.type for a
              // perfectly normal .jpg) - falling back to the extension
              // means a real photo still renders as a thumbnail instead of
              // the generic file icon just because its mime_type is blank.
              const isImage = (f.mime_type ?? "").startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)$/i.test(f.file_name);
              return (
                <div key={f.id} className="group relative aspect-square overflow-hidden rounded-md border border-gray-300 bg-gray-100">
                  <a href={fileUrls?.[f.id] || undefined} target="_blank" rel="noreferrer" className="block h-full w-full" title={f.file_name}>
                    {isImage && fileUrls?.[f.id] ? (
                      <img src={fileUrls[f.id]} alt={f.file_name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
                        <span className="text-2xl">📄</span>
                        <span className="line-clamp-2 break-all text-xs text-gray-600">{f.file_name}</span>
                      </div>
                    )}
                  </a>
                  {isAdmin ? (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        if (window.confirm(`Delete ${f.file_name}?`)) deleteFile.mutate(f);
                      }}
                      disabled={deleteFile.isPending}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs font-bold text-white opacity-0 transition-opacity hover:bg-red-600 disabled:opacity-100 group-hover:opacity-100"
                      title="Delete file"
                    >
                      &times;
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <QuoteToolsSection jobCardId={id!} />

      <div className="mb-6">
        <JobMembershipBenefitSection jobCardId={id!} clientId={job.client_id} />
      </div>

      <div className="rounded-lg border border-gray-300 bg-white p-6">
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
          {(notes ?? []).map((note) =>
            editingNoteId === note.id ? (
              <div key={note.id} className="border-t border-gray-200 pt-3 text-sm">
                <TextAreaField label="Note" labelHidden rows={2} value={editingNoteBody} onChange={(e) => setEditingNoteBody(e.target.value)} />
                {editNoteError ? <p className="mb-2 text-sm text-red-600">{editNoteError}</p> : null}
                <div className="flex gap-2">
                  <button
                    onClick={() => updateNote.mutate()}
                    disabled={updateNote.isPending || !editingNoteBody.trim()}
                    className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
                  >
                    {updateNote.isPending ? "Saving..." : "Save"}
                  </button>
                  <button onClick={() => setEditingNoteId(null)} className="px-3 py-1.5 text-xs font-semibold text-gray-600">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div key={note.id} className="group border-t border-gray-200 pt-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="whitespace-pre-wrap text-gray-800">{note.body}</p>
                  <button
                    onClick={() => startEditNote(note)}
                    className="flex-shrink-0 text-xs font-semibold text-blue-700 opacity-0 hover:underline group-hover:opacity-100"
                  >
                    Edit
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-400">{new Date(note.created_at).toLocaleString()}</p>
              </div>
            )
          )}
          {notes && notes.length === 0 ? <p className="text-sm text-gray-500">No notes yet.</p> : null}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
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
                  className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
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

      <div className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
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
                  className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
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

      <div className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
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
                className="flex w-full items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-left text-sm hover:bg-gray-50"
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
                className="flex w-full items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-60"
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
                <div key={sub.id} className={`rounded-md border p-3 ${onHold ? "border-red-100 bg-red-50" : "border-gray-200"}`}>
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

      <Modal open={addressModalOpen} onClose={() => setAddressModalOpen(false)} title="Edit job address">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Address</label>
          <select
            value={addressSiteChoice}
            onChange={(e) => setAddressSiteChoice(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">{client ? formatClientAddress(client) ?? "Client's main address (none on file)" : "Client's main address"}</option>
            {(clientSites ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {site.label || "Site"} - {formatSiteAddress(site)}
              </option>
            ))}
            <option value="new">+ Add a new address...</option>
          </select>
        </div>
        {addressSiteChoice === "new" ? (
          <div className="mb-4 rounded-md border border-gray-300 p-3">
            <p className="mb-2 text-xs font-semibold text-gray-500">This address will be saved to the client's card too.</p>
            <FormField
              label="Label (optional)"
              value={newAddressForm.label}
              onChange={(e) => setNewAddressForm({ ...newAddressForm, label: e.target.value })}
              placeholder="e.g. Warehouse, Shop 4"
            />
            <FormField
              label="Address line 1"
              value={newAddressForm.address_line1}
              onChange={(e) => setNewAddressForm({ ...newAddressForm, address_line1: e.target.value })}
            />
            <FormField
              label="Address line 2"
              value={newAddressForm.address_line2}
              onChange={(e) => setNewAddressForm({ ...newAddressForm, address_line2: e.target.value })}
            />
            <div className="grid grid-cols-3 gap-3">
              <FormField
                label="Suburb"
                value={newAddressForm.suburb}
                onChange={(e) => setNewAddressForm({ ...newAddressForm, suburb: e.target.value })}
              />
              <FormField
                label="State"
                value={newAddressForm.state}
                onChange={(e) => setNewAddressForm({ ...newAddressForm, state: e.target.value })}
              />
              <FormField
                label="Postcode"
                value={newAddressForm.postcode}
                onChange={(e) => setNewAddressForm({ ...newAddressForm, postcode: e.target.value })}
              />
            </div>
          </div>
        ) : null}
        {addressError ? <p className="mb-4 text-sm text-red-600">{addressError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setAddressModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => updateJobSite.mutate()}
            disabled={updateJobSite.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {updateJobSite.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit job">
        <FormField label="Title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Job title" />
        <TextAreaField
          label="Description"
          rows={4}
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          placeholder="Notes, scope of work, etc."
        />
        {editError ? <p className="mb-4 text-sm text-red-600">{editError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setEditModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveEdit.mutate()}
            disabled={saveEdit.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveEdit.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={workdriveModalOpen} onClose={() => setWorkdriveModalOpen(false)} title="WorkDrive link">
        <FormField
          label="Link"
          value={workdriveInput}
          onChange={(e) => setWorkdriveInput(e.target.value)}
          placeholder="https://workdrive.zoho.com/..."
        />
        {workdriveError ? <p className="mb-4 text-sm text-red-600">{workdriveError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setWorkdriveModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveWorkdrive.mutate()}
            disabled={saveWorkdrive.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveWorkdrive.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <RealEstateAssignmentModal
        open={realEstateModalOpen}
        onClose={() => setRealEstateModalOpen(false)}
        jobCardId={job.id}
        initial={{
          is_real_estate_job: job.is_real_estate_job,
          agency_id: job.agency_id,
          property_manager_id: job.property_manager_id,
          property_id: job.property_id,
          work_order_number: job.work_order_number,
          nte_limit_cents: job.nte_limit_cents,
        }}
      />

      <WorkOrderNumberModal
        open={workOrderModalOpen}
        onClose={() => setWorkOrderModalOpen(false)}
        jobCardId={job.id}
        currentValue={job.work_order_number}
      />

      <ReferralPartnerModal
        open={referralModalOpen}
        onClose={() => setReferralModalOpen(false)}
        table="job_cards"
        recordId={job.id}
        currentValue={job.referral_partner_id}
      />

      <EmailComposeModal
        open={jobEmailModalOpen}
        onClose={() => setJobEmailModalOpen(false)}
        title={`Email - ${job.title}`}
        defaultTo={client?.email ?? ""}
        defaultSubject=""
        defaultBody=""
        recipientOptions={jobRecipientOptions}
        templates={emailTemplates}
        onSend={handleSendJobEmail}
        sendLabel="Send email"
      />
    </div>
  );
}
