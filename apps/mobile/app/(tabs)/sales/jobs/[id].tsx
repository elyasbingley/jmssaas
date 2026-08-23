import { useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  collectRecipientEmails,
  createJobCardSchema,
  createJobNoteSchema,
  createTaskSchema,
  formatCentsAsAud,
  renderTemplate,
  updateJobRealEstateAssignmentSchema,
  type Agency,
  type Client,
  type ClientContact,
  type CommunicationRule,
  type CommunicationTemplate,
  type EmailAttachment,
  type Invoice,
  type InvoiceLineItem,
  type JobCard,
  type JobLifecycleStage,
  type JobNote,
  type KeyLog,
  type MaterialTallyItem,
  type Property,
  type PropertyManager,
  type PurchaseOrder,
  type Quote,
  type QuoteLineItem,
  type ReferralPartner,
  type ReportInstance,
  type ReportTemplate,
  type ServiceCategory,
  type SubcontractorCompany,
  type SubcontractorTrade,
  type Task,
  type TaskStatus,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { addJobPhoto } from "../../../../lib/powersync";
import { triggerImmediateDispatch } from "../../../../lib/dispatch-now";
import { formatClientAddress } from "../../../../lib/format";
import { getErrorMessage } from "../../../../lib/errors";
import { CenteredModal } from "../../../../components/CenteredModal";
import { CommunicationLog } from "../../../../components/CommunicationLog";
import { EmailComposeModal } from "../../../../components/EmailComposeModal";
import { FormField } from "../../../../components/FormField";
import { PhotoAttachments } from "../../../../components/PhotoAttachments";
import { PickerModal } from "../../../../components/PickerModal";
import { MeasureRoofTool } from "../../../../components/MeasureRoofTool";
import { LinearMeasurerTool } from "../../../../components/LinearMeasurerTool";
import { MaterialTallyCounter } from "../../../../components/MaterialTallyCounter";
import { PhotoMarkupEditor } from "../../../../components/PhotoMarkupEditor";
import { ConcreteCalculatorTool } from "../../../../components/ConcreteCalculatorTool";
import { MaterialOrderFormTool } from "../../../../components/MaterialOrderFormTool";
import { TIER_LABELS, TRADE_LABELS } from "../../../subcontractors/index";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { partnerDisplayName } from "../../../b2b-referrals/index";

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
const NEXT_TASK_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

interface JobFileWithLocalUri {
  id: string;
  local_uri: string | null;
  file_name: string | null;
  mime_type: string | null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// labour_rate_cents/labour_hours/material_cost_cents on a line item are the
// PER UNIT cost breakdown that fed into that line's unit_price_cents (see
// computeLineItemUnitPriceCents in packages/shared/src/money.ts) - not
// already multiplied by quantity - so a line's actual total cost has to
// scale by quantity here the same way lineItemSubtotalCents scales the
// charged amount.
function lineItemLabourCostCents(item: Pick<QuoteLineItem, "quantity" | "labour_rate_cents" | "labour_hours">): number {
  return Math.round(item.quantity * item.labour_rate_cents * item.labour_hours);
}

function lineItemMaterialCostCents(item: Pick<QuoteLineItem, "quantity" | "material_cost_cents">): number {
  return Math.round(item.quantity * item.material_cost_cents);
}

interface CostingDoc {
  id: string;
  type: "quote" | "invoice";
  number: string;
  status: string;
  total_cents: number;
}

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [id]);
  const job = jobRows[0];

  const { data: clientRows } = useQuery<Client>("SELECT * FROM clients WHERE id = ?", [job?.client_id ?? ""]);
  const client = clientRows[0];

  const { data: clientContacts } = useQuery<ClientContact>(
    "SELECT * FROM client_contacts WHERE client_id = ?",
    [job?.client_id ?? ""]
  );

  // Automation & Messaging rules/templates - PowerSync-synced tenant
  // reference data (see powersync/sync-rules.yaml), so these manual field
  // triggers work with no reception, same as the rest of this screen.
  const { data: communicationRules } = useQuery<CommunicationRule>("SELECT * FROM communication_rules");
  const { data: communicationTemplates } = useQuery<CommunicationTemplate>("SELECT * FROM communication_templates");

  const { data: categories } = useQuery<ServiceCategory>("SELECT * FROM service_categories ORDER BY name");
  const { data: stages } = useQuery<JobLifecycleStage>("SELECT * FROM job_lifecycle_stages ORDER BY position");
  const category = categories.find((c) => c.id === job?.service_category_id) ?? null;
  const stage = stages.find((s) => s.id === job?.lifecycle_stage_id) ?? null;

  const { data: notes } = useQuery<JobNote>(
    "SELECT * FROM job_notes WHERE job_card_id = ? ORDER BY created_at DESC",
    [id]
  );

  const { data: jobTasks } = useQuery<Task>(
    "SELECT * FROM tasks WHERE job_card_id = ? ORDER BY (due_date IS NULL), due_date, created_at DESC",
    [id]
  );

  const { data: files } = useQuery<JobFileWithLocalUri>(
    `SELECT jf.id, jf.file_name, jf.mime_type, a.local_uri
       FROM job_files jf
       LEFT JOIN attachments a ON a.id = jf.id
      WHERE jf.job_card_id = ?
      ORDER BY jf.created_at DESC`,
    [id]
  );

  // Quotes/invoices are online-only (see docs/SETUP.md), so unlike the rest
  // of this screen they're fetched straight from Supabase rather than a
  // PowerSync-watched local query, same as the quotes/invoices list screens.
  const { data: linkedQuotes, refetch: refetchQuotes } = useSupabaseFetch<Quote[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("quotes").select("*").eq("job_card_id", id);
    if (error) throw error;
    return (data ?? []) as Quote[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetchQuotes);

  const { data: linkedInvoices, refetch: refetchInvoices } = useSupabaseFetch<Invoice[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("invoices").select("*").eq("job_card_id", id);
    if (error) throw error;
    return (data ?? []) as Invoice[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetchInvoices);

  // Reports & Safety - report_instances/report_templates aren't PowerSync
  // tables (see app/reports/index.tsx), so this is the same Supabase-direct,
  // online-only treatment as quotes/invoices above.
  const { data: linkedReports, refetch: refetchLinkedReports } = useSupabaseFetch<ReportInstance[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_instances").select("*").eq("job_card_id", id).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as ReportInstance[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetchLinkedReports);

  const { data: activeReportTemplates } = useSupabaseFetch<ReportTemplate[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_templates").select("*").eq("is_active", true).order("title");
    if (error) throw error;
    return (data ?? []) as ReportTemplate[];
  }, [isOnline]);

  const [createReportModalVisible, setCreateReportModalVisible] = useState(false);
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
    setCreateReportModalVisible(false);
    router.push(`/reports/instance/${data.id}`);
  };

  const [linkReportModalVisible, setLinkReportModalVisible] = useState(false);
  const [linkReportError, setLinkReportError] = useState<string | null>(null);
  const { data: unlinkedReports, refetch: refetchUnlinkedReports } = useSupabaseFetch<ReportInstance[]>(async () => {
    if (!isOnline || !linkReportModalVisible) return [];
    const { data, error } = await supabase.from("report_instances").select("*").is("job_card_id", null).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as ReportInstance[];
  }, [isOnline, linkReportModalVisible]);

  const linkExistingReport = async (reportId: string) => {
    if (!job) return;
    const { error } = await supabase.from("report_instances").update({ job_card_id: job.id, client_id: job.client_id }).eq("id", reportId);
    if (error) {
      setLinkReportError(getErrorMessage(error, "Failed to link report"));
      return;
    }
    setLinkReportModalVisible(false);
    refetchLinkedReports();
  };

  // Subcontractors - like reports, purchase_orders/subcontractor_companies
  // aren't PowerSync tables. Assigning a subcontractor to a job *is*
  // creating a Purchase Order (or Quote Request) - there's no separate
  // assignment table, same as desktop's JobDetail.tsx.
  const { data: linkedPurchaseOrders, refetch: refetchLinkedPurchaseOrders } = useSupabaseFetch<PurchaseOrder[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("purchase_orders").select("*").eq("job_card_id", id).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as PurchaseOrder[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetchLinkedPurchaseOrders);

  const { data: allSubcontractors } = useSupabaseFetch<SubcontractorCompany[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("subcontractor_companies").select("*").order("preference_tier").order("company_name");
    if (error) throw error;
    return (data ?? []) as SubcontractorCompany[];
  }, [isOnline]);

  const [assignSubModalVisible, setAssignSubModalVisible] = useState(false);
  const [assignSubTradeFilter, setAssignSubTradeFilter] = useState<SubcontractorTrade | "">("");

  // Real Estate & Strata module - agencies aren't a PowerSync table (same
  // "office reference data, fetched online" treatment as quotes/invoices
  // above), only needed here for the NTE guardrail's "PM approval required"
  // wording and the Request NTE Variation flow below.
  const { data: agency } = useSupabaseFetch<Agency | null>(async () => {
    if (!isOnline || !job?.agency_id) return null;
    const { data, error } = await supabase.from("agencies").select("*").eq("id", job.agency_id).single();
    if (error) throw error;
    return data as Agency;
  }, [isOnline, job?.agency_id]);
  const { data: propertyManager } = useSupabaseFetch<PropertyManager | null>(async () => {
    if (!isOnline || !job?.property_manager_id) return null;
    const { data, error } = await supabase.from("property_managers").select("*").eq("id", job.property_manager_id).single();
    if (error) throw error;
    return data as PropertyManager;
  }, [isOnline, job?.property_manager_id]);
  const { data: property } = useSupabaseFetch<Property | null>(async () => {
    if (!isOnline || !job?.property_id) return null;
    const { data, error } = await supabase.from("properties").select("*").eq("id", job.property_id).single();
    if (error) throw error;
    return data as Property;
  }, [isOnline, job?.property_id]);

  // Full lists (not just this job's own agency/PM/property) - only used by
  // the "Real estate assignment" edit modal's pickers below, but fetched
  // unconditionally like the single-row versions above rather than gated
  // on the modal being open, matching this screen's existing style.
  const { data: allAgencies } = useSupabaseFetch<Agency[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("agencies").select("*").order("name");
    if (error) throw error;
    return data as Agency[];
  }, [isOnline]);
  const { data: allPropertyManagers } = useSupabaseFetch<PropertyManager[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
    if (error) throw error;
    return data as PropertyManager[];
  }, [isOnline]);
  const { data: allProperties } = useSupabaseFetch<Property[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("properties").select("*").order("suburb");
    if (error) throw error;
    return data as Property[];
  }, [isOnline]);

  // Key Tracking Lifecycle - see Workflow 3 of the Real Estate & Strata
  // spec. key_logs isn't a PowerSync table (same online-only treatment as
  // agencies/properties above), so pickup/in-van/return all need
  // connectivity - a real, disclosed limitation (see docs/SETUP.md), not
  // an oversight.
  const { data: keyLog, refetch: refetchKeyLog } = useSupabaseFetch<KeyLog | null>(async () => {
    if (!isOnline || !job) return null;
    const { data, error } = await supabase
      .from("key_logs")
      .select("*")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as KeyLog | null;
  }, [isOnline, job?.id]);
  useRefetchOnFocus(refetchKeyLog);

  const [keyActionError, setKeyActionError] = useState<string | null>(null);

  // Free-form job card email - mirrors desktop JobDetail.tsx's ServiceM8-style
  // per-job "Email" button. Uses entity_type 'job' with trigger_key
  // 'manual_email' so it's distinguishable from templated automation in the
  // Communication Log. Unlike queueScheduledCommunication above, this goes
  // straight to Supabase rather than the local PowerSync table, since
  // cc_emails/bcc_emails/attachments aren't columns in the local schema
  // (see powersync/schema.ts) - so, like handleRequestNteVariation, it
  // needs connectivity.
  const [jobEmailModalVisible, setJobEmailModalVisible] = useState(false);
  const jobRecipientOptions = collectRecipientEmails({
    clientEmail: client?.email,
    contactEmails: (clientContacts ?? []).map((c) => c.email),
  });

  const handleSendJobEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile || !job) throw new Error("Not signed in");
    if (!isOnline) throw new Error("Sending an email needs an internet connection.");
    const { data: row, error: insertError } = await supabase
      .from("scheduled_communications")
      .insert({
        tenant_id: profile.tenant_id,
        entity_type: "job",
        entity_id: job.id,
        trigger_key: "manual_email",
        template_id: null,
        channel: "email",
        recipient_phone_or_email: payload.to,
        cc_emails: payload.cc ? payload.cc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        bcc_emails: payload.bcc ? payload.bcc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        rendered_subject: payload.subject,
        rendered_body: payload.body,
        attachments: payload.attachments,
        scheduled_for: new Date().toISOString(),
        status: "pending",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    const wasSent = await triggerImmediateDispatch(row.id);
    Alert.alert(wasSent ? "Sent" : "Queued", wasSent ? "The email has been sent." : "The email is queued and will go out shortly.");
  };

  const handleKeyPickedUp = async () => {
    if (!profile || !job?.property_id || !property?.key_tag_number) return;
    setKeyActionError(null);
    const { error } = await supabase.from("key_logs").insert({
      tenant_id: profile.tenant_id,
      property_id: job.property_id,
      job_id: job.id,
      technician_id: profile.id,
      key_tag_number: property.key_tag_number,
      status: "picked_up",
      picked_up_at: new Date().toISOString(),
    });
    if (error) {
      setKeyActionError(error.message);
      return;
    }
    refetchKeyLog();
  };

  const handleKeyStatusChange = async (nextStatus: "in_van" | "returned") => {
    if (!keyLog) return;
    setKeyActionError(null);
    const { error } = await supabase
      .from("key_logs")
      .update(nextStatus === "returned" ? { status: nextStatus, returned_at: new Date().toISOString() } : { status: nextStatus })
      .eq("id", keyLog.id);
    if (error) {
      setKeyActionError(error.message);
      return;
    }
    refetchKeyLog();
  };

  const [activeTab, setActiveTab] = useState<"details" | "costing" | "tools">("details");
  const [markupPhoto, setMarkupPhoto] = useState<JobFileWithLocalUri | null>(null);
  const [transferredTallyItems, setTransferredTallyItems] = useState<MaterialTallyItem[] | null>(null);
  const isAdmin = profile?.role === "admin";

  // Only fetched once the person actually opens Job Costing (not needed for
  // the Details tab's plain quote/invoice number lists above) - avoids a
  // couple of extra round trips on every job screen visit for a tab most
  // views of this screen won't touch.
  const quoteIds = (linkedQuotes ?? []).map((q) => q.id).join(",");
  const invoiceIds = (linkedInvoices ?? []).map((inv) => inv.id).join(",");

  const { data: quoteLineItems, loading: quoteLineItemsLoading } = useSupabaseFetch<QuoteLineItem[]>(async () => {
    const ids = quoteIds ? quoteIds.split(",") : [];
    if (!isOnline || activeTab !== "costing" || ids.length === 0) return [];
    const { data, error } = await supabase.from("quote_line_items").select("*").in("quote_id", ids);
    if (error) throw error;
    return (data ?? []) as QuoteLineItem[];
  }, [isOnline, activeTab, quoteIds]);

  const { data: invoiceLineItems, loading: invoiceLineItemsLoading } = useSupabaseFetch<InvoiceLineItem[]>(async () => {
    const ids = invoiceIds ? invoiceIds.split(",") : [];
    if (!isOnline || activeTab !== "costing" || ids.length === 0) return [];
    const { data, error } = await supabase.from("invoice_line_items").select("*").in("invoice_id", ids);
    if (error) throw error;
    return (data ?? []) as InvoiceLineItem[];
  }, [isOnline, activeTab, invoiceIds]);

  const costingDocs: CostingDoc[] = [
    ...(linkedQuotes ?? []).map((q) => ({
      id: q.id,
      type: "quote" as const,
      number: q.quote_number,
      status: q.status,
      total_cents: q.total_cents,
    })),
    ...(linkedInvoices ?? []).map((inv) => ({
      id: inv.id,
      type: "invoice" as const,
      number: inv.invoice_number,
      status: inv.status,
      total_cents: inv.total_cents,
    })),
  ];

  const allCostingLineItems = [...(quoteLineItems ?? []), ...(invoiceLineItems ?? [])];
  const totalLabourCents = allCostingLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item), 0);
  const totalMaterialCents = allCostingLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
  const totalChargedCents = costingDocs.reduce((sum, doc) => sum + doc.total_cents, 0);
  // NTE (Not-To-Exceed) guardrail - see Workflow 2 of the Real Estate &
  // Strata spec. totalChargedCents above already sums every quote/invoice
  // linked to this job regardless of which tab is open (only the line-item
  // breakdown queries are gated on activeTab === "costing"), so this check
  // is safe to run even from the Details tab where stage changes happen.
  const isNteExceeded = job?.is_real_estate_job && job.nte_limit_cents != null && totalChargedCents > job.nte_limit_cents;
  // Margin here is "charged minus cost", i.e. it treats the line item
  // markup% as the margin - matching how computeLineItemUnitPriceCents
  // already builds markup into the rate. Total charged is GST-inclusive
  // (it's each document's total_cents) while labour/material cost are
  // GST-exclusive, so this margin/margin% also includes the GST slice of
  // revenue - a small overstatement worth knowing about. It can also
  // double-count a quote that was converted to an invoice, since both stay
  // linked to the job and both get summed - if that's not the intent,
  // filtering converted quotes (status "accepted" with a matching invoice)
  // out of the aggregate would be the fix.
  const marginCents = totalChargedCents - (totalLabourCents + totalMaterialCents);
  const marginPercent = totalChargedCents > 0 ? (marginCents / totalChargedCents) * 100 : 0;
  const costingLoading = quoteLineItemsLoading || invoiceLineItemsLoading;

  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);

  // --- Automated field messages (On The Way / Review Request) ---
  // Inserted directly into the local PowerSync-synced scheduled_
  // communications table (tenant-wide writable - see the communication_
  // engine migration's RLS), not sent from the device itself - the whole
  // point of the queue table is that scheduling and sending are decoupled,
  // so this works with no reception (see process-scheduled-comms's own
  // comment for the dispatcher side). {tech_first_name}/{eta_minutes} are
  // rendered right here, since they come from this exact tap (who's
  // driving, what ETA they typed) and have nowhere else to be
  // reconstructed from later - every other token in the template
  // ({client_*}/{job_*}/{site_address}/{company_*}) is left raw for the
  // dispatcher to resolve server-side once it's back online, which is what
  // lets this queue entirely offline without needing company details this
  // device doesn't have synced at all (tenants isn't a PowerSync table).
  const queueScheduledCommunication = async (
    triggerKey: string,
    scheduleContext?: { eta_minutes: number }
  ): Promise<{ queued: boolean; sentImmediately: boolean }> => {
    if (!profile || !job) return { queued: false, sentImmediately: false };
    const rule = communicationRules.find((r) => r.trigger_key === triggerKey);
    if (!rule || !rule.is_enabled) return { queued: false, sentImmediately: false };

    const matchingTemplates = communicationTemplates.filter(
      (t) => t.trigger_key === triggerKey && t.is_active && (rule.channel === "both" || rule.channel === t.type)
    );
    if (matchingTemplates.length === 0) return { queued: false, sentImmediately: false };

    const techFirstName = profile.full_name.trim().split(/\s+/)[0] ?? profile.full_name;
    const now = new Date().toISOString();
    const insertedIds: string[] = [];

    for (const template of matchingTemplates) {
      const recipient = template.type === "sms" ? (client?.phone ?? "") : (client?.email ?? "");
      const partialContext = scheduleContext
        ? {
            schedule: {
              tech_first_name: techFirstName,
              booking_date: null,
              booking_start_time: null,
              eta_minutes: scheduleContext.eta_minutes,
            },
          }
        : undefined;
      const renderedBody = partialContext ? renderTemplate(template.body, partialContext) : template.body;
      const renderedSubject = template.subject
        ? partialContext
          ? renderTemplate(template.subject, partialContext)
          : template.subject
        : null;

      const rowId = uuidv4();
      await powersync.execute(
        `INSERT INTO scheduled_communications
           (id, tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for, status, created_at)
         VALUES (?, ?, 'job', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          rowId,
          profile.tenant_id,
          job.id,
          triggerKey,
          template.id,
          template.type,
          recipient,
          renderedSubject,
          renderedBody,
          now,
          now,
        ]
      );
      insertedIds.push(rowId);
    }

    // Best-effort "send it right now" instead of waiting for the next cron
    // sweep - see lib/dispatch-now.ts. Only attempted while online; offline
    // it just falls back to the queue exactly as before, no different than
    // if this call didn't exist.
    let sentImmediately = false;
    if (isOnline) {
      const results = await Promise.all(insertedIds.map((rowId) => triggerImmediateDispatch(rowId)));
      sentImmediately = results.length > 0 && results.every(Boolean);
    }

    return { queued: true, sentImmediately };
  };

  const [onTheWayModalVisible, setOnTheWayModalVisible] = useState(false);
  const [etaMinutes, setEtaMinutes] = useState("");
  const [onTheWayError, setOnTheWayError] = useState<string | null>(null);

  const handleSendOnTheWay = async () => {
    const eta = Number(etaMinutes);
    if (!etaMinutes.trim() || Number.isNaN(eta) || eta < 0) {
      setOnTheWayError("Enter a valid number of minutes");
      return;
    }
    const result = await queueScheduledCommunication("job_on_the_way", { eta_minutes: eta });
    if (!result.queued) {
      setOnTheWayError("This message is turned off in Settings > Automation & Messaging, or has no active template.");
      return;
    }
    setOnTheWayModalVisible(false);
    setEtaMinutes("");
    setOnTheWayError(null);
    Alert.alert(
      result.sentImmediately ? "Sent" : "Queued",
      result.sentImmediately
        ? "The On The Way message has been sent."
        : "The message is queued and will send shortly (next sync/cron sweep)."
    );
  };

  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);
  const [stagePickerVisible, setStagePickerVisible] = useState(false);

  const handleCategoryChange = async (next: ServiceCategory | null) => {
    await powersync.execute("UPDATE job_cards SET service_category_id = ? WHERE id = ?", [next?.id ?? null, id]);
  };

  const [nteModalVisible, setNteModalVisible] = useState(false);
  const [nteRequesting, setNteRequesting] = useState(false);
  const [nteRequestError, setNteRequestError] = useState<string | null>(null);

  const handleStageChange = async (next: JobLifecycleStage | null) => {
    const wasClosed = stage?.is_closed ?? false;
    // NTE guardrail: block entering a closed (job-done) stage while over
    // budget and not yet PM-approved - see Workflow 2 of the Real Estate &
    // Strata spec. Checked before the UPDATE runs, not after, so an
    // over-budget job never actually reaches the closed stage in the first
    // place (no undo needed).
    if (next?.is_closed && !wasClosed && isNteExceeded && !job?.nte_exceeded_approved) {
      setNteRequestError(null);
      setNteModalVisible(true);
      return;
    }
    await powersync.execute("UPDATE job_cards SET lifecycle_stage_id = ? WHERE id = ?", [next?.id ?? null, id]);
    // Same "just finished" moment the old status picker's completed check
    // used to catch - now keyed off entering any is_closed stage (not just
    // one literally named "Completed"), matching the DB triggers' own
    // schedule_job_completion_summary/schedule_maintenance_reminder logic.
    if (next?.is_closed && !wasClosed) {
      Alert.alert("Job completed", "Send an automated review request to the client?", [
        { text: "Not now", style: "cancel" },
        {
          text: "Send",
          onPress: async () => {
            const result = await queueScheduledCommunication("job_review_request");
            if (!result.queued) return;
            Alert.alert(
              result.sentImmediately ? "Sent" : "Queued",
              result.sentImmediately
                ? "The review request has been sent."
                : "The review request is queued and will send shortly (next sync/cron sweep)."
            );
          },
        },
      ]);
    }
    // Key Tracking Lifecycle step 3 (see Workflow 3 of the Real Estate &
    // Strata spec) - prompt for the key's return the same "just finished"
    // moment the review-request prompt above fires on, only when there's
    // an actual outstanding (not yet returned) key log for this job.
    if (next?.is_closed && !wasClosed && keyLog && keyLog.status !== "returned") {
      Alert.alert(
        "Return key?",
        `Did you return Key Tag #${keyLog.key_tag_number} to ${agency?.name ?? "the agency"}?`,
        [
          { text: "Not yet", style: "cancel" },
          { text: "Yes, returned", onPress: () => handleKeyStatusChange("returned") },
        ]
      );
    }
  };

  // Requests PM sign-off on the over-budget amount - see Workflow 2 of the
  // Real Estate & Strata spec. Unlike queueScheduledCommunication above,
  // the recipient here is the property manager (not the client), so this
  // doesn't reuse that helper - it builds its own scheduled_communications
  // row with the {nte_*} tokens already rendered, same "render before
  // insert" approach queueScheduledCommunication uses for {tech_first_name}/
  // {eta_minutes}. Requires connectivity (unlike the queue-only helpers
  // above) since generating the token itself is a real Postgres round trip
  // (generate_job_nte_variation_link), not something that can be queued
  // offline the way a plain scheduled_communications insert can.
  const handleRequestNteVariation = async () => {
    if (!profile || !job || !isOnline) {
      setNteRequestError("Requesting a variation needs an internet connection.");
      return;
    }
    setNteRequesting(true);
    setNteRequestError(null);
    try {
      const approvalPageUrl = process.env.EXPO_PUBLIC_APPROVAL_PAGE_URL;
      if (!approvalPageUrl) {
        throw new Error("Approval page URL not configured - set EXPO_PUBLIC_APPROVAL_PAGE_URL in .env (see docs/SETUP.md)");
      }
      const rule = communicationRules.find((r) => r.trigger_key === "job_nte_variation_request");
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'NTE Variation Request' message is turned off in Settings > Automation & Messaging");
      }
      const matchingTemplates = communicationTemplates.filter(
        (t) => t.trigger_key === "job_nte_variation_request" && t.is_active && (rule.channel === "both" || rule.channel === t.type)
      );
      if (matchingTemplates.length === 0) throw new Error("No active 'NTE Variation Request' message template found");

      const recipientEmail = propertyManager?.email ?? agency?.billing_email ?? "";
      if (!recipientEmail) {
        throw new Error("No property manager or agency billing email on file to send this to.");
      }

      const { data: token, error: tokenError } = await supabase.rpc("generate_job_nte_variation_link", { p_job_id: job.id });
      if (tokenError) throw tokenError;
      const approvalLink = `${approvalPageUrl}?type=nte_variation&token=${token}`;
      const nteContext = { limit_cents: job.nte_limit_cents ?? 0, current_total_cents: totalChargedCents, approval_link: approvalLink };

      const now = new Date().toISOString();
      for (const template of matchingTemplates) {
        const renderedBody = renderTemplate(template.body, { nte: nteContext });
        const renderedSubject = template.subject ? renderTemplate(template.subject, { nte: nteContext }) : null;
        const rowId = uuidv4();
        await powersync.execute(
          `INSERT INTO scheduled_communications
             (id, tenant_id, entity_type, entity_id, trigger_key, template_id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for, status, created_at)
           VALUES (?, ?, 'job', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [rowId, profile.tenant_id, job.id, "job_nte_variation_request", template.id, template.type, recipientEmail, renderedSubject, renderedBody, now, now]
        );
        await triggerImmediateDispatch(rowId);
      }

      setNteModalVisible(false);
      Alert.alert("Sent", "The budget variation request has been emailed to the property manager for approval.");
    } catch (e) {
      setNteRequestError(e instanceof Error ? e.message : "Failed to send the variation request");
    } finally {
      setNteRequesting(false);
    }
  };

  // --- Edit job title/description ---
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = () => {
    if (!job) return;
    setEditTitle(job.title);
    setEditDescription(job.description ?? "");
    setEditError(null);
    setEditModalVisible(true);
  };

  const handleSaveEdit = async () => {
    const result = createJobCardSchema.safeParse({
      client_id: job?.client_id,
      title: editTitle,
      description: editDescription,
    });
    if (!result.success) {
      setEditError(result.error.issues[0]?.message ?? "Invalid job");
      return;
    }

    await powersync.execute(
      "UPDATE job_cards SET title = ?, description = ?, updated_at = ? WHERE id = ?",
      [result.data.title, result.data.description || null, new Date().toISOString(), id]
    );
    setEditModalVisible(false);
  };

  // --- WorkDrive link ---
  const [workdriveModalVisible, setWorkdriveModalVisible] = useState(false);
  const [workdriveInput, setWorkdriveInput] = useState("");

  const openWorkdriveModal = () => {
    if (!job) return;
    setWorkdriveInput(job.workdrive_url ?? "");
    setWorkdriveModalVisible(true);
  };

  const handleSaveWorkdrive = async () => {
    await powersync.execute("UPDATE job_cards SET workdrive_url = ?, updated_at = ? WHERE id = ?", [
      workdriveInput || null,
      new Date().toISOString(),
      id,
    ]);
    setWorkdriveModalVisible(false);
  };

  // --- Referral source - same "settable any time, not just at creation"
  // gap as WorkDrive/real estate assignment above. referral_partners isn't
  // a PowerSync table (see jobs/index.tsx's own comment), so the picker's
  // options only load while online; the job itself still updates via
  // PowerSync like every other job_cards field on this screen.
  const { data: referralPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);
  const [referralPickerVisible, setReferralPickerVisible] = useState(false);
  const currentReferralPartner = (referralPartners ?? []).find((p) => p.id === job?.referral_partner_id) ?? null;

  const handleSelectReferralPartner = async (partner: ReferralPartner | null) => {
    await powersync.execute("UPDATE job_cards SET referral_partner_id = ?, updated_at = ? WHERE id = ?", [
      partner?.id ?? null,
      new Date().toISOString(),
      id,
    ]);
  };

  // --- Real estate / strata assignment (retrofit an existing job, or edit
  // one already assigned) - same job_cards columns as the New Job form
  // (desktop's Jobs.tsx), previously only ever settable at creation there,
  // now writable from mobile too via PowerSync (job_cards is already
  // offline-writable, this just adds the missing UI). ---
  const [raModalVisible, setRaModalVisible] = useState(false);
  const [raIsRealEstate, setRaIsRealEstate] = useState(false);
  const [raAgencyId, setRaAgencyId] = useState<string | null>(null);
  const [raPropertyManagerId, setRaPropertyManagerId] = useState<string | null>(null);
  const [raPropertyId, setRaPropertyId] = useState<string | null>(null);
  const [raWorkOrderNumber, setRaWorkOrderNumber] = useState("");
  const [raNteLimit, setRaNteLimit] = useState("");
  const [raError, setRaError] = useState<string | null>(null);
  const [agencyPickerVisible, setAgencyPickerVisible] = useState(false);
  const [pmPickerVisible, setPmPickerVisible] = useState(false);
  const [propertyPickerVisible, setPropertyPickerVisible] = useState(false);

  const openRaModal = () => {
    if (!job) return;
    setRaIsRealEstate(job.is_real_estate_job);
    setRaAgencyId(job.agency_id);
    setRaPropertyManagerId(job.property_manager_id);
    setRaPropertyId(job.property_id);
    setRaWorkOrderNumber(job.work_order_number ?? "");
    setRaNteLimit(job.nte_limit_cents != null ? String(job.nte_limit_cents / 100) : "");
    setRaError(null);
    setRaModalVisible(true);
  };

  const raPmsForAgency = (allPropertyManagers ?? []).filter((pm) => pm.agency_id === raAgencyId);
  const raPropertiesForPm = (allProperties ?? []).filter((p) =>
    raPropertyManagerId ? p.property_manager_id === raPropertyManagerId : p.agency_id === raAgencyId
  );

  const handleSaveRa = async () => {
    const result = updateJobRealEstateAssignmentSchema.safeParse({
      is_real_estate_job: raIsRealEstate,
      agency_id: raIsRealEstate ? raAgencyId || undefined : undefined,
      property_manager_id: raIsRealEstate ? raPropertyManagerId || undefined : undefined,
      property_id: raIsRealEstate ? raPropertyId || undefined : undefined,
      work_order_number: raIsRealEstate ? raWorkOrderNumber || undefined : undefined,
      nte_limit_cents: raIsRealEstate && raNteLimit.trim() ? Math.round(Number(raNteLimit) * 100) : undefined,
    });
    if (!result.success) {
      setRaError(result.error.issues[0]?.message ?? "Invalid details");
      return;
    }
    if (result.data.is_real_estate_job && !result.data.agency_id) {
      setRaError("Pick an agency");
      return;
    }

    await powersync.execute(
      `UPDATE job_cards SET is_real_estate_job = ?, agency_id = ?, property_manager_id = ?, property_id = ?,
         work_order_number = ?, nte_limit_cents = ?, updated_at = ? WHERE id = ?`,
      [
        result.data.is_real_estate_job ? 1 : 0,
        result.data.agency_id || null,
        result.data.property_manager_id || null,
        result.data.property_id || null,
        result.data.work_order_number || null,
        result.data.nte_limit_cents ?? null,
        new Date().toISOString(),
        id,
      ]
    );
    setRaModalVisible(false);
  };

  const handleAddTask = async () => {
    const result = createTaskSchema.safeParse({ title: taskTitle, job_card_id: id });
    if (!result.success) {
      setTaskError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO tasks (id, tenant_id, job_card_id, title, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)`,
      [uuidv4(), profile.tenant_id, id, result.data.title, profile.id, now, now]
    );
    setTaskTitle("");
    setTaskError(null);
  };

  const cycleTaskStatus = async (task: Task) => {
    await powersync.execute("UPDATE tasks SET status = ? WHERE id = ?", [NEXT_TASK_STATUS[task.status], task.id]);
  };

  const handleAddNote = async () => {
    const result = createJobNoteSchema.safeParse({ job_card_id: id, body: noteText });
    if (!result.success) {
      setNoteError(result.error.issues[0]?.message ?? "Note can't be empty");
      return;
    }
    if (!profile) return;

    await powersync.execute(
      "INSERT INTO job_notes (id, tenant_id, job_card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), profile.tenant_id, id, profile.id, result.data.body, new Date().toISOString()]
    );
    setNoteText("");
    setNoteError(null);
  };

  const handleUploadPhoto = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile || !job) return;
    setUploading(true);
    try {
      await addJobPhoto({
        tenantId: profile.tenant_id,
        jobCardId: id,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(photo.base64),
        mediaType: photo.mimeType,
        fileExtension: photo.fileExtension,
      });
    } finally {
      setUploading(false);
    }
  };

  if (!job) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <>
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.section}>
        <View style={styles.titleRow}>
          <Text style={styles.number}>{job.number ?? "Pending sync"}</Text>
          <Pressable onPress={openEditModal}>
            <Text style={styles.link}>Edit</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>{job.title}</Text>
        {job.description ? <Text style={styles.description}>{job.description}</Text> : null}

        <Pressable onPress={() => setJobEmailModalVisible(true)}>
          <Text style={styles.link}>Email</Text>
        </Pressable>

        {client ? (
          <Pressable style={styles.clientCard} onPress={() => router.push(`/sales/clients/${client.id}`)}>
            <Text style={styles.clientCardName}>{client.name}</Text>
            {client.phone ? <Text style={styles.clientCardMeta}>{client.phone}</Text> : null}
            {formatClientAddress(client) ? (
              <Text style={styles.clientCardMeta}>{formatClientAddress(client)}</Text>
            ) : null}
          </Pressable>
        ) : null}

        {!job.is_real_estate_job ? (
          <Pressable onPress={openRaModal}>
            <Text style={styles.link}>Mark as real estate / strata job</Text>
          </Pressable>
        ) : null}

        <View style={styles.workdriveRow}>
          <Text style={styles.workdriveLabel}>WorkDrive</Text>
          <Pressable onPress={openWorkdriveModal}>
            <Text style={styles.link}>{job.workdrive_url ? "Edit link" : "+ Add link"}</Text>
          </Pressable>
        </View>
        {job.workdrive_url ? <Text style={styles.clientCardMeta}>{job.workdrive_url}</Text> : null}

        <View style={styles.workdriveRow}>
          <Text style={styles.workdriveLabel}>Referral source</Text>
          <Pressable onPress={() => setReferralPickerVisible(true)}>
            <Text style={styles.link}>{job.referral_partner_id ? "Edit" : "+ Add"}</Text>
          </Pressable>
        </View>
        <Text style={styles.clientCardMeta}>{currentReferralPartner ? partnerDisplayName(currentReferralPartner) : "None"}</Text>

        {job.is_real_estate_job ? (
          <View style={styles.agencyCard}>
            <View style={styles.titleRow}>
              <Text style={styles.agencyBadge}>AGENCY JOB</Text>
              <Pressable onPress={openRaModal}>
                <Text style={styles.link}>Edit</Text>
              </Pressable>
            </View>
            {agency ? <Text style={styles.clientCardName}>{agency.name}</Text> : null}
            <Pressable onPress={openRaModal}>
              <Text style={styles.clientCardMeta}>Work order: {job.work_order_number ?? "Not set"}</Text>
            </Pressable>
            {job.nte_limit_cents != null ? (
              <Text style={styles.clientCardMeta}>NTE limit: {formatCentsAsAud(job.nte_limit_cents)}</Text>
            ) : null}
            {isNteExceeded ? (
              <Text style={styles.nteExceededText}>
                {job.nte_exceeded_approved ? "Over NTE limit - variation approved" : "Over NTE limit - PM approval required to complete"}
              </Text>
            ) : null}

            {property?.key_tag_number ? (
              <View style={styles.keyRow}>
                <Text style={styles.clientCardMeta}>
                  Key: {property.key_tag_number} {keyLog ? `(${keyLog.status.replace("_", " ")})` : "(at office)"}
                </Text>
                {!keyLog || keyLog.status === "returned" ? (
                  <Pressable onPress={handleKeyPickedUp}>
                    <Text style={styles.link}>Keys Picked Up</Text>
                  </Pressable>
                ) : keyLog.status === "picked_up" ? (
                  <Pressable onPress={() => handleKeyStatusChange("in_van")}>
                    <Text style={styles.link}>Mark In Van</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={() => handleKeyStatusChange("returned")}>
                    <Text style={styles.link}>Mark Returned</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            {keyActionError ? <Text style={styles.error}>{keyActionError}</Text> : null}
          </View>
        ) : null}
      </View>

      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tabButton, activeTab === "details" && styles.tabButtonActive]}
          onPress={() => setActiveTab("details")}
        >
          <Text style={[styles.tabButtonText, activeTab === "details" && styles.tabButtonTextActive]}>Details</Text>
        </Pressable>
        {isAdmin ? (
          <Pressable
            style={[styles.tabButton, activeTab === "costing" && styles.tabButtonActive]}
            onPress={() => setActiveTab("costing")}
          >
            <Text style={[styles.tabButtonText, activeTab === "costing" && styles.tabButtonTextActive]}>Job Costing</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.tabButton, activeTab === "tools" && styles.tabButtonActive]}
          onPress={() => setActiveTab("tools")}
        >
          <Text style={[styles.tabButtonText, activeTab === "tools" && styles.tabButtonTextActive]}>Quote Tools</Text>
        </Pressable>
      </View>

      {activeTab === "tools" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Roof Area</Text>
          <MeasureRoofTool jobCardId={id} />

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Linear Measurer</Text>
          <LinearMeasurerTool jobCardId={id} />

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Material Tally</Text>
          <MaterialTallyCounter
            jobCardId={id}
            onTransferToOrder={(items) => setTransferredTallyItems(items)}
          />

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Concrete Calculator</Text>
          <ConcreteCalculatorTool jobCardId={id} />

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Material Order</Text>
          <MaterialOrderFormTool
            jobCardId={id}
            prefillItems={transferredTallyItems}
            onConsumedPrefill={() => setTransferredTallyItems(null)}
          />

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Photo Markup</Text>
          {markupPhoto ? (
            <PhotoMarkupEditor
              jobCardId={id}
              photoUri={markupPhoto.local_uri!}
              photoFileName={markupPhoto.file_name ?? "photo.jpg"}
              onSaved={() => setMarkupPhoto(null)}
              onCancel={() => setMarkupPhoto(null)}
            />
          ) : (
            <>
              <Text style={styles.subtitle}>Pick a photo to annotate. The annotated copy is saved as a new attachment.</Text>
              <View style={styles.markupGrid}>
                {files.filter((f) => f.local_uri).length === 0 ? (
                  <Text style={styles.empty}>No downloaded photos yet - add or open one from Photos below first.</Text>
                ) : (
                  files
                    .filter((f) => f.local_uri)
                    .map((f) => (
                      <Pressable key={f.id} style={styles.markupThumbWrap} onPress={() => setMarkupPhoto(f)}>
                        <Image source={{ uri: f.local_uri! }} style={styles.markupThumb} />
                      </Pressable>
                    ))
                )}
              </View>
            </>
          )}
        </View>
      ) : null}

      {activeTab === "costing" && isAdmin ? (
        !isOnline ? (
          <View style={styles.section}>
            <RequiresConnectionNotice label="Job costing" />
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Linked documents</Text>
            {costingDocs.map((doc) => (
              <Pressable
                key={doc.id}
                style={styles.costingDocRow}
                onPress={() => router.push(doc.type === "quote" ? `/sales/quotes/${doc.id}` : `/sales/invoices/${doc.id}`)}
              >
                <View>
                  <Text style={styles.costingDocNumber}>{doc.number}</Text>
                  <Text style={styles.costingDocMeta}>
                    {doc.type === "quote" ? "Quote" : "Invoice"} · {capitalize(doc.status)}
                  </Text>
                </View>
                <Text style={styles.costingDocTotal}>{formatCentsAsAud(doc.total_cents)}</Text>
              </Pressable>
            ))}
            {costingDocs.length === 0 ? (
              <Text style={styles.empty}>No quotes or invoices linked to this job yet.</Text>
            ) : costingLoading ? (
              <Text style={styles.empty}>Loading costing breakdown...</Text>
            ) : (
              <>
                <Text style={[styles.sectionTitle, styles.costingSummaryTitle]}>Summary</Text>
                <View style={styles.costingSummaryRow}>
                  <Text style={styles.costingSummaryLabel}>Labour cost</Text>
                  <Text style={styles.costingSummaryValue}>{formatCentsAsAud(totalLabourCents)}</Text>
                </View>
                <View style={styles.costingSummaryRow}>
                  <Text style={styles.costingSummaryLabel}>Material cost</Text>
                  <Text style={styles.costingSummaryValue}>{formatCentsAsAud(totalMaterialCents)}</Text>
                </View>
                <View style={styles.costingSummaryRow}>
                  <Text style={styles.costingSummaryLabel}>Total charged</Text>
                  <Text style={styles.costingSummaryValue}>{formatCentsAsAud(totalChargedCents)}</Text>
                </View>
                <View style={[styles.costingSummaryRow, styles.costingSummaryRowBold]}>
                  <Text style={styles.costingSummaryLabelBold}>Margin</Text>
                  <Text style={styles.costingSummaryValueBold}>{formatCentsAsAud(marginCents)}</Text>
                </View>
                <View style={styles.costingSummaryRow}>
                  <Text style={styles.costingSummaryLabel}>Margin %</Text>
                  <Text style={styles.costingSummaryValue}>{marginPercent.toFixed(1)}%</Text>
                </View>
              </>
            )}
          </View>
        )
      ) : null}

      {activeTab === "details" || !isAdmin ? (
        <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notify client</Text>
        <Pressable
          style={styles.onTheWayButton}
          onPress={() => {
            setEtaMinutes("");
            setOnTheWayError(null);
            setOnTheWayModalVisible(true);
          }}
        >
          <Text style={styles.onTheWayButtonText}>🚚 On The Way</Text>
        </Pressable>
        <Text style={styles.measureHint}>Sends an automated "on the way" SMS/email with your ETA.</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Category</Text>
        <Pressable style={styles.pickerField} onPress={() => setCategoryPickerVisible(true)}>
          <View style={styles.pickerFieldRow}>
            {category?.color ? <View style={[styles.swatch, { backgroundColor: category.color }]} /> : null}
            <Text style={category ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {category?.name ?? "No category"}
            </Text>
          </View>
        </Pressable>
        {category ? (
          <Pressable onPress={() => handleCategoryChange(null)}>
            <Text style={styles.clearLink}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Lifecycle stage</Text>
        <Pressable style={styles.pickerField} onPress={() => setStagePickerVisible(true)}>
          <View style={styles.pickerFieldRow}>
            {stage?.color ? <View style={[styles.swatch, { backgroundColor: stage.color }]} /> : null}
            <Text style={stage ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {stage?.name ?? "No stage"}
            </Text>
          </View>
        </Pressable>
        {stage ? (
          <Pressable onPress={() => handleStageChange(null)}>
            <Text style={styles.clearLink}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quotes</Text>
        {(linkedQuotes ?? []).map((q) => (
          <Pressable key={q.id} style={styles.linkedRow} onPress={() => router.push(`/sales/quotes/${q.id}`)}>
            <Text style={styles.linkedRowText}>{q.quote_number}</Text>
          </Pressable>
        ))}
        {isOnline && linkedQuotes?.length === 0 ? <Text style={styles.empty}>No quotes linked to this job.</Text> : null}
        {!isOnline ? (
          <Text style={styles.empty}>Connect to view or create quotes.</Text>
        ) : profile?.role === "admin" ? (
          <Pressable
            style={styles.linkButton}
            onPress={() => router.push({ pathname: "/sales/quotes/new", params: { jobCardId: job.id, clientId: job.client_id } })}
          >
            <Text style={styles.linkButtonText}>+ New quote for this job</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Invoices</Text>
        {(linkedInvoices ?? []).map((inv) => (
          <Pressable key={inv.id} style={styles.linkedRow} onPress={() => router.push(`/sales/invoices/${inv.id}`)}>
            <Text style={styles.linkedRowText}>{inv.invoice_number}</Text>
          </Pressable>
        ))}
        {isOnline && linkedInvoices?.length === 0 ? <Text style={styles.empty}>No invoices linked to this job.</Text> : null}
        {!isOnline ? (
          <Text style={styles.empty}>Connect to view or create invoices.</Text>
        ) : profile?.role === "admin" ? (
          <Pressable
            style={styles.linkButton}
            onPress={() => router.push({ pathname: "/sales/invoices/new", params: { jobCardId: job.id, clientId: job.client_id } })}
          >
            <Text style={styles.linkButtonText}>+ New invoice for this job</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reports & Safety</Text>
        {(linkedReports ?? []).map((r) => (
          <Pressable key={r.id} style={styles.linkedRow} onPress={() => router.push(`/reports/instance/${r.id}`)}>
            <Text style={styles.linkedRowText}>
              {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
              {r.completed_at ? ` - ${new Date(r.completed_at).toLocaleDateString("en-AU")}` : ""}
            </Text>
          </Pressable>
        ))}
        {isOnline && linkedReports?.length === 0 ? <Text style={styles.empty}>No reports linked to this job.</Text> : null}
        {!isOnline ? (
          <Text style={styles.empty}>Connect to view or create reports.</Text>
        ) : isAdmin ? (
          <View style={styles.reportActionsRow}>
            <Pressable
              style={styles.linkButton}
              onPress={() => {
                setCreateReportSearch("");
                setCreateReportError(null);
                setCreateReportModalVisible(true);
              }}
            >
              <Text style={styles.linkButtonText}>+ Create New Report</Text>
            </Pressable>
            <Pressable
              style={styles.linkButton}
              onPress={() => {
                setLinkReportError(null);
                setLinkReportModalVisible(true);
              }}
            >
              <Text style={styles.linkButtonText}>Link Existing Report</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <View style={styles.titleRow}>
          <Text style={styles.sectionTitle}>Subcontractors</Text>
          {isOnline && isAdmin ? (
            <Pressable onPress={() => setAssignSubModalVisible(true)}>
              <Text style={styles.link}>+ Assign</Text>
            </Pressable>
          ) : null}
        </View>
        {(linkedPurchaseOrders ?? []).map((po) => {
          const sub = (allSubcontractors ?? []).find((s) => s.id === po.subcontractor_id);
          return (
            <Pressable key={po.id} style={styles.linkedRow} onPress={() => router.push(`/subcontractors/purchase-order/${po.id}`)}>
              <Text style={styles.linkedRowText}>
                {po.po_number ?? "Pending"} - {sub?.company_name ?? "Unknown subcontractor"} ({po.is_quote_request ? "Quote Request" : "Work Order"})
              </Text>
            </Pressable>
          );
        })}
        {isOnline && linkedPurchaseOrders?.length === 0 ? (
          <Text style={styles.empty}>No subcontractor work orders or quote requests for this job yet.</Text>
        ) : null}
        {!isOnline ? <Text style={styles.empty}>Connect to view or assign subcontractors.</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Tasks</Text>
        {jobTasks.map((t) => (
          <Pressable key={t.id} style={styles.taskRow} onPress={() => router.push(`/tasks/${t.id}`)}>
            <Text style={styles.taskRowTitle}>{t.title}</Text>
            <Pressable
              style={styles.taskStatusBadge}
              onPress={(e) => {
                e.stopPropagation();
                cycleTaskStatus(t);
              }}
            >
              <Text style={styles.taskStatusBadgeText}>{TASK_STATUS_LABELS[t.status]}</Text>
            </Pressable>
          </Pressable>
        ))}
        {jobTasks.length === 0 ? <Text style={styles.empty}>No tasks linked to this job.</Text> : null}
        {profile?.role === "admin" ? (
          <View style={styles.addTaskRow}>
            <View style={{ flex: 1 }}>
              <FormField label="Add a task" placeholder="Task title" value={taskTitle} onChangeText={setTaskTitle} />
            </View>
            <Pressable style={styles.button} onPress={handleAddTask}>
              <Text style={styles.buttonText}>Add</Text>
            </Pressable>
          </View>
        ) : null}
        {taskError ? <Text style={styles.error}>{taskError}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Photos</Text>
        <PhotoAttachments photos={files} uploading={uploading} onUpload={handleUploadPhoto} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        <FormField label="Add a note" placeholder="Note" value={noteText} onChangeText={setNoteText} multiline style={styles.multiline} />
        {noteError ? <Text style={styles.error}>{noteError}</Text> : null}
        <Pressable style={[styles.button, styles.addNoteButton]} onPress={handleAddNote}>
          <Text style={styles.buttonText}>Add note</Text>
        </Pressable>

        {notes.map((note) => (
          <View key={note.id} style={styles.noteRow}>
            <Text style={styles.noteBody}>{note.body}</Text>
            <Text style={styles.noteMeta}>{new Date(note.created_at).toLocaleString()}</Text>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Communication Log</Text>
        <CommunicationLog
          entities={[
            { entityType: "job", entityId: job.id },
            ...(linkedQuotes ?? []).map((q) => ({ entityType: "quote" as const, entityId: q.id })),
            ...(linkedInvoices ?? []).map((inv) => ({ entityType: "invoice" as const, entityId: inv.id })),
          ]}
        />
      </View>
        </>
      ) : null}
    </ScrollView>

    <CenteredModal visible={onTheWayModalVisible} onClose={() => setOnTheWayModalVisible(false)}>
      <Text style={styles.modalTitle}>On The Way</Text>
      <FormField
        label="ETA (minutes)"
        placeholder="e.g. 15"
        value={etaMinutes}
        onChangeText={setEtaMinutes}
        keyboardType="number-pad"
      />
      {onTheWayError ? <Text style={styles.error}>{onTheWayError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setOnTheWayModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={handleSendOnTheWay}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
      </View>
    </CenteredModal>

    <CenteredModal visible={nteModalVisible} onClose={() => setNteModalVisible(false)}>
      <Text style={styles.modalTitle}>Over budget</Text>
      <Text style={styles.modalBody}>
        This job exceeds the NTE limit of {job?.nte_limit_cents != null ? formatCentsAsAud(job.nte_limit_cents) : "-"} by{" "}
        {job?.nte_limit_cents != null ? formatCentsAsAud(totalChargedCents - job.nte_limit_cents) : "-"}. PM approval is required
        before this job can be marked done.
      </Text>
      {nteRequestError ? <Text style={styles.error}>{nteRequestError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setNteModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={handleRequestNteVariation} disabled={nteRequesting}>
          <Text style={styles.buttonText}>{nteRequesting ? "Sending..." : "Request NTE Variation"}</Text>
        </Pressable>
      </View>
    </CenteredModal>

    <CenteredModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
      <Text style={styles.modalTitle}>Edit job</Text>
      <FormField label="Title" placeholder="Job title" value={editTitle} onChangeText={setEditTitle} />
      <FormField
        label="Description (optional)"
        placeholder="Description"
        value={editDescription}
        onChangeText={setEditDescription}
        multiline
        style={styles.multiline}
      />
      {editError ? <Text style={styles.error}>{editError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setEditModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={handleSaveEdit}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
    </CenteredModal>

    <PickerModal
      visible={categoryPickerVisible}
      title="Select category"
      items={categories}
      getKey={(c) => c.id}
      getLabel={(c) => c.name}
      onSelect={handleCategoryChange}
      onClose={() => setCategoryPickerVisible(false)}
    />

    <PickerModal
      visible={stagePickerVisible}
      title="Select stage"
      items={stages}
      getKey={(s) => s.id}
      getLabel={(s) => s.name}
      onSelect={handleStageChange}
      onClose={() => setStagePickerVisible(false)}
    />

    <PickerModal
      visible={referralPickerVisible}
      title="Referral source"
      items={[null, ...(referralPartners ?? [])]}
      getKey={(p) => p?.id ?? "none"}
      getLabel={(p) => (p ? partnerDisplayName(p) : "None")}
      onSelect={handleSelectReferralPartner}
      onClose={() => setReferralPickerVisible(false)}
    />

    <CenteredModal visible={workdriveModalVisible} onClose={() => setWorkdriveModalVisible(false)}>
      <Text style={styles.modalTitle}>WorkDrive link</Text>
      <FormField label="Link" placeholder="https://workdrive.zoho.com/..." value={workdriveInput} onChangeText={setWorkdriveInput} />
      <View style={styles.modalActions}>
        <Pressable onPress={() => setWorkdriveModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={handleSaveWorkdrive}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
    </CenteredModal>

    <CenteredModal visible={raModalVisible} onClose={() => setRaModalVisible(false)}>
      <Text style={styles.modalTitle}>Real estate / strata assignment</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>This is a real estate / strata agency job</Text>
        <Switch value={raIsRealEstate} onValueChange={setRaIsRealEstate} />
      </View>

      {raIsRealEstate ? (
        <>
          <Text style={styles.sectionTitle}>Agency</Text>
          <Pressable style={styles.pickerField} onPress={() => setAgencyPickerVisible(true)}>
            <Text style={raAgencyId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {(allAgencies ?? []).find((a) => a.id === raAgencyId)?.name ?? "Select agency"}
            </Text>
          </Pressable>
          <Text style={styles.sectionTitle}>Property manager</Text>
          <Pressable style={styles.pickerField} onPress={() => setPmPickerVisible(true)}>
            <Text style={raPropertyManagerId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {(() => {
                const pm = (allPropertyManagers ?? []).find((p) => p.id === raPropertyManagerId);
                return pm ? `${pm.first_name} ${pm.last_name}` : "Select property manager";
              })()}
            </Text>
          </Pressable>
          <Text style={styles.sectionTitle}>Property</Text>
          <Pressable style={styles.pickerField} onPress={() => setPropertyPickerVisible(true)}>
            <Text style={raPropertyId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {(() => {
                const p = (allProperties ?? []).find((prop) => prop.id === raPropertyId);
                return p ? `${p.address_line1}, ${p.suburb}` : "Select property";
              })()}
            </Text>
          </Pressable>
          <FormField label="Work order number" placeholder="e.g. WO-4821" value={raWorkOrderNumber} onChangeText={setRaWorkOrderNumber} />
          <FormField
            label="NTE limit ($)"
            placeholder="e.g. 300.00"
            value={raNteLimit}
            onChangeText={setRaNteLimit}
            keyboardType="decimal-pad"
          />
        </>
      ) : null}

      {raError ? <Text style={styles.error}>{raError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setRaModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={handleSaveRa}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
    </CenteredModal>

    <PickerModal
      visible={agencyPickerVisible}
      title="Select agency"
      items={allAgencies ?? []}
      getKey={(a) => a.id}
      getLabel={(a) => a.name}
      onSelect={(a) => {
        setRaAgencyId(a.id);
        setRaPropertyManagerId(null);
        setRaPropertyId(null);
      }}
      onClose={() => setAgencyPickerVisible(false)}
    />

    <PickerModal
      visible={pmPickerVisible}
      title="Select property manager"
      items={raPmsForAgency}
      getKey={(pm) => pm.id}
      getLabel={(pm) => `${pm.first_name} ${pm.last_name}`}
      onSelect={(pm) => {
        setRaPropertyManagerId(pm.id);
        setRaPropertyId(null);
      }}
      onClose={() => setPmPickerVisible(false)}
    />

    <PickerModal
      visible={propertyPickerVisible}
      title="Select property"
      items={raPropertiesForPm}
      getKey={(p) => p.id}
      getLabel={(p) => `${p.address_line1}, ${p.suburb}`}
      onSelect={(p) => setRaPropertyId(p.id)}
      onClose={() => setPropertyPickerVisible(false)}
    />

    <EmailComposeModal
      visible={jobEmailModalVisible}
      onClose={() => setJobEmailModalVisible(false)}
      title={`Email - ${job.title}`}
      defaultTo={client?.email ?? ""}
      defaultSubject=""
      defaultBody=""
      recipientOptions={jobRecipientOptions}
      onSend={handleSendJobEmail}
      sendLabel="Send email"
    />

    <CenteredModal visible={createReportModalVisible} onClose={() => setCreateReportModalVisible(false)}>
      <Text style={styles.modalTitle}>Create new report</Text>
      <FormField label="Search templates" value={createReportSearch} onChangeText={setCreateReportSearch} placeholder="Search by title..." />
      {createReportError ? <Text style={styles.error}>{createReportError}</Text> : null}
      {(activeReportTemplates ?? [])
        .filter((t) => t.title.toLowerCase().includes(createReportSearch.trim().toLowerCase()))
        .map((t) => (
          <Pressable key={t.id} style={styles.reportTemplateRow} onPress={() => startReportForJob(t.id)}>
            <Text style={styles.reportTemplateRowText}>{t.title}</Text>
            {t.is_swms ? <Text style={styles.swmsTag}>SWMS</Text> : null}
          </Pressable>
        ))}
      {(activeReportTemplates ?? []).length === 0 ? <Text style={styles.empty}>No report templates yet.</Text> : null}
      <Pressable onPress={() => setCreateReportModalVisible(false)}>
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
    </CenteredModal>

    <PickerModal
      visible={linkReportModalVisible}
      title="Link existing report"
      items={unlinkedReports ?? []}
      getKey={(r) => r.id}
      getLabel={(r) => `${r.status.charAt(0).toUpperCase() + r.status.slice(1)} report`}
      onSelect={(r) => linkExistingReport(r.id)}
      onClose={() => setLinkReportModalVisible(false)}
    />
    {linkReportError ? <Text style={styles.error}>{linkReportError}</Text> : null}

    <CenteredModal visible={assignSubModalVisible} onClose={() => setAssignSubModalVisible(false)}>
      <Text style={styles.modalTitle}>Assign subcontractor</Text>
      <View style={styles.tradeFilterRow}>
        <Pressable style={[styles.tradeFilterChip, !assignSubTradeFilter && styles.tradeFilterChipActive]} onPress={() => setAssignSubTradeFilter("")}>
          <Text style={[styles.tradeFilterChipText, !assignSubTradeFilter && styles.tradeFilterChipTextActive]}>All trades</Text>
        </Pressable>
        {(Object.keys(TRADE_LABELS) as SubcontractorTrade[]).map((trade) => (
          <Pressable
            key={trade}
            style={[styles.tradeFilterChip, assignSubTradeFilter === trade && styles.tradeFilterChipActive]}
            onPress={() => setAssignSubTradeFilter(trade)}
          >
            <Text style={[styles.tradeFilterChipText, assignSubTradeFilter === trade && styles.tradeFilterChipTextActive]}>
              {TRADE_LABELS[trade]}
            </Text>
          </Pressable>
        ))}
      </View>

      {(allSubcontractors ?? [])
        .filter((s) => !assignSubTradeFilter || s.trades.includes(assignSubTradeFilter))
        .map((sub) => {
          const onHold = sub.status === "compliance_hold";
          return (
            <View key={sub.id} style={[styles.assignSubCard, onHold && styles.assignSubCardHold]}>
              <View style={styles.titleRow}>
                <Text style={[styles.assignSubName, onHold && styles.assignSubNameHold]}>{sub.company_name}</Text>
                <Text style={styles.assignSubTier}>{TIER_LABELS[sub.preference_tier]}</Text>
              </View>
              {onHold ? <Text style={styles.holdNotice}>On compliance hold - expired documents must be renewed first.</Text> : null}
              <View style={styles.assignSubActions}>
                <Pressable
                  style={styles.assignSubButton}
                  disabled={onHold}
                  onPress={() => {
                    setAssignSubModalVisible(false);
                    router.push(`/subcontractors/purchase-order/new?subcontractorId=${sub.id}&quoteRequest=true&jobCardId=${id}`);
                  }}
                >
                  <Text style={styles.assignSubButtonText}>Request Quote</Text>
                </Pressable>
                <Pressable
                  style={[styles.assignSubButton, styles.assignSubButtonPrimary]}
                  disabled={onHold}
                  onPress={() => {
                    setAssignSubModalVisible(false);
                    router.push(`/subcontractors/purchase-order/new?subcontractorId=${sub.id}&quoteRequest=false&jobCardId=${id}`);
                  }}
                >
                  <Text style={styles.assignSubButtonTextPrimary}>Issue Work Order</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      {(allSubcontractors ?? []).length === 0 ? (
        <Text style={styles.empty}>No subcontractors yet - add one from Settings &gt; Subcontractors.</Text>
      ) : null}
      <Pressable onPress={() => setAssignSubModalVisible(false)}>
        <Text style={styles.link}>Close</Text>
      </Pressable>
    </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  section: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  number: { fontSize: 12, fontWeight: "700", color: "#1d4ed8", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: "700" },
  description: { marginTop: 6, color: "#374151" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  clientCard: { marginTop: 12, backgroundColor: "#f3f4f6", borderRadius: 8, padding: 12, gap: 2 },
  clientCardName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  clientCardMeta: { fontSize: 13, color: "#6b7280" },
  agencyCard: { marginTop: 12, backgroundColor: "#eff6ff", borderRadius: 8, padding: 12, gap: 2 },
  agencyBadge: { fontSize: 11, fontWeight: "700", color: "#1d4ed8", marginBottom: 2 },
  workdriveRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  workdriveLabel: { fontSize: 11, fontWeight: "700", color: "#6b7280", textTransform: "uppercase" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: "#374151", flex: 1 },
  nteExceededText: { fontSize: 13, fontWeight: "700", color: "#b91c1c", marginTop: 4 },
  keyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalBody: { fontSize: 14, color: "#374151", lineHeight: 20, marginTop: 6 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginBottom: 10 },
  tabRow: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  tabButton: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6", alignItems: "center" },
  tabButtonActive: { backgroundColor: "#1d4ed8" },
  tabButtonText: { color: "#374151", fontWeight: "700" },
  tabButtonTextActive: { color: "#fff" },
  costingDocRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  costingDocNumber: { fontSize: 15, fontWeight: "700", color: "#111827" },
  costingDocMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  costingDocTotal: { fontSize: 15, fontWeight: "700", color: "#111827" },
  costingSummaryTitle: { marginTop: 20 },
  costingSummaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  costingSummaryRowBold: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#d1d5db", marginTop: 4, paddingTop: 10 },
  costingSummaryLabel: { color: "#6b7280", fontSize: 13 },
  costingSummaryValue: { color: "#111827", fontSize: 13, fontWeight: "600" },
  costingSummaryLabelBold: { color: "#111827", fontSize: 15, fontWeight: "700" },
  costingSummaryValueBold: { color: "#111827", fontSize: 15, fontWeight: "700" },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  // flexShrink so the text is actually width-constrained by the row
  // (next to the fixed-width swatch dot) and wraps onto a second line
  // for a long category/stage name, instead of Yoga letting it overflow
  // its measured width and silently clipping the last character or two.
  pickerFieldText: { fontSize: 15, color: "#111827", flexShrink: 1 },
  pickerFieldPlaceholder: { fontSize: 15, color: "#9ca3af", flexShrink: 1 },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  clearLink: { color: "#1d4ed8", fontWeight: "600", marginTop: 6, alignSelf: "flex-start" },
  linkedRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  linkedRowText: { color: "#1d4ed8", fontWeight: "600" },
  linkButton: { marginTop: 10, alignSelf: "flex-start" },
  linkButtonText: { color: "#1d4ed8", fontWeight: "600" },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  taskRowTitle: { fontSize: 15, color: "#111827", flex: 1, marginRight: 8 },
  taskStatusBadge: { backgroundColor: "#f3f4f6", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  taskStatusBadgeText: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  addTaskRow: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "flex-end" },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  addNoteButton: { alignSelf: "flex-start", marginTop: 10 },
  measureHint: { color: "#6b7280", fontSize: 12, marginTop: 8 },
  onTheWayButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center" },
  onTheWayButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 6 },
  noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#d1d5db" },
  noteBody: { fontSize: 15, color: "#111827" },
  noteMeta: { fontSize: 12, color: "#9ca3af", marginTop: 4 },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
  reportActionsRow: { flexDirection: "row", gap: 16, marginTop: 10 },
  reportTemplateRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  reportTemplateRowText: { fontSize: 15, color: "#111827" },
  swmsTag: { fontSize: 10, fontWeight: "700", color: "#9a3412", backgroundColor: "#ffedd5", borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  subtitle: { color: "#6b7280", fontSize: 13, marginBottom: 10 },
  markupGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  markupThumbWrap: { width: "23%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", backgroundColor: "#f3f4f6" },
  markupThumb: { width: "100%", height: "100%" },
  holdNotice: { color: "#b91c1c", fontSize: 12, marginTop: 4, marginBottom: 8 },
  tradeFilterRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  tradeFilterChip: { backgroundColor: "#f3f4f6", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  tradeFilterChipActive: { backgroundColor: "#1d4ed8" },
  tradeFilterChipText: { fontSize: 11, fontWeight: "600", color: "#374151" },
  tradeFilterChipTextActive: { color: "#fff" },
  assignSubCard: { borderWidth: 1, borderColor: "#f3f4f6", borderRadius: 8, padding: 12, marginBottom: 8 },
  assignSubCardHold: { borderColor: "#fecaca", backgroundColor: "#fef2f2" },
  assignSubName: { fontWeight: "600", color: "#111827", flex: 1 },
  assignSubNameHold: { color: "#9ca3af" },
  assignSubTier: { fontSize: 11, color: "#6b7280" },
  assignSubActions: { flexDirection: "row", gap: 8, marginTop: 8 },
  assignSubButton: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  assignSubButtonText: { fontSize: 12, fontWeight: "700", color: "#374151" },
  assignSubButtonPrimary: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  assignSubButtonTextPrimary: { fontSize: 12, fontWeight: "700", color: "#fff" },
});
