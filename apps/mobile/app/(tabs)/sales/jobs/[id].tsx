import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createJobCardSchema,
  createTaskSchema,
  formatCentsAsAud,
  renderTemplate,
  type Agency,
  type CalendarEvent,
  type Client,
  type CommunicationRule,
  type CommunicationTemplate,
  type Invoice,
  type InvoiceLineItem,
  type JobCard,
  type JobLifecycleStage,
  type KeyLog,
  type Property,
  type PropertyManager,
  type Quote,
  type QuoteLineItem,
  type ServiceCategory,
  type Task,
  type TaskStatus,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { triggerImmediateDispatch } from "../../../../lib/dispatch-now";
import { formatClientAddress } from "../../../../lib/format";
import { useThemedStyles, type StyleTheme } from "../../../../lib/use-themed-styles";
import { useJobNotes } from "../../../../lib/use-job-notes";
import { useJobContacts } from "../../../../lib/use-job-contacts";
import { useJobPhotoCapture } from "../../../../lib/use-job-photo-capture";
import { useJobActionOrder, type JobActionId } from "../../../../lib/job-actions";
import { Panel } from "../../../../components/theme/Panel";
import { Readout } from "../../../../components/theme/Readout";
import { ThemedButton } from "../../../../components/theme/ThemedButton";
import { ThemedModal } from "../../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../../components/theme/ThemedFormField";
import { ThemedPickerModal } from "../../../../components/theme/ThemedPickerModal";
import { ThemedCommunicationLog } from "../../../../components/theme/ThemedCommunicationLog";
import { JobActionsBar } from "../../../../components/theme/JobActionsBar";
import { JobActionsSheet } from "../../../../components/theme/JobActionsSheet";
import { MultiCaptureCamera } from "../../../../components/MultiCaptureCamera";

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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function callPhone(phone: string) {
  Linking.openURL(`tel:${phone.replace(/\s+/g, "")}`).catch(() => {});
}

function openInMaps(address: string) {
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`).catch(() => {});
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

  // Automation & Messaging rules/templates - PowerSync-synced tenant
  // reference data (see powersync/sync-rules.yaml), so these manual field
  // triggers work with no reception, same as the rest of this screen.
  const { data: communicationRules } = useQuery<CommunicationRule>("SELECT * FROM communication_rules");
  const { data: communicationTemplates } = useQuery<CommunicationTemplate>("SELECT * FROM communication_templates");

  const { data: categories } = useQuery<ServiceCategory>("SELECT * FROM service_categories ORDER BY name");
  const { data: stages } = useQuery<JobLifecycleStage>("SELECT * FROM job_lifecycle_stages ORDER BY position");
  const category = categories.find((c) => c.id === job?.service_category_id) ?? null;
  const stage = stages.find((s) => s.id === job?.lifecycle_stage_id) ?? null;

  const { data: jobTasks } = useQuery<Task>(
    "SELECT * FROM tasks WHERE job_card_id = ? ORDER BY (due_date IS NULL), due_date, created_at DESC",
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

  // Calendar events are also online-only (docs/SETUP.md) - job_card_id has
  // always existed on calendar_events and calendar/new.tsx already supports
  // picking/pre-selecting a job when creating one, this just surfaces the
  // ones still upcoming (end_at in the future) here too.
  const { data: upcomingBookings, refetch: refetchBookings } = useSupabaseFetch<CalendarEvent[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase
      .from("calendar_events")
      .select("*")
      .eq("job_card_id", id)
      .gte("end_at", new Date().toISOString())
      .order("start_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as CalendarEvent[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetchBookings);

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

  const [activeTab, setActiveTab] = useState<"details" | "costing">("details");
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

  const { noteText, setNoteText, noteError, addNote } = useJobNotes(id);
  const jobContacts = useJobContacts(id);
  const photoCapture = useJobPhotoCapture(id);
  const { order: actionOrder, quickActions, setOrder: setActionOrder } = useJobActionOrder();
  const [quickNoteModalVisible, setQuickNoteModalVisible] = useState(false);
  const [actionsSheetVisible, setActionsSheetVisible] = useState(false);
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

  const runJobAction = (actionId: JobActionId) => {
    switch (actionId) {
      case "notes":
        setQuickNoteModalVisible(true);
        return;
      case "camera":
        photoCapture.openCamera();
        return;
      case "photoLibrary":
        photoCapture.pickFromLibrary();
        return;
      case "phone":
        if (!clientPhone) {
          Alert.alert("No phone number", "This client has no phone number on file.");
          return;
        }
        callPhone(clientPhone);
        return;
      case "sms":
        if (!clientPhone) {
          Alert.alert("No phone number", "This client has no phone number on file.");
          return;
        }
        Linking.openURL(`sms:${clientPhone.replace(/\s+/g, "")}`).catch(() => {});
        return;
      case "email":
        if (!client?.email) {
          Alert.alert("No email address", "This client has no email address on file.");
          return;
        }
        Linking.openURL(`mailto:${client.email}`).catch(() => {});
        return;
      case "forms":
        Alert.alert("Not available on mobile yet", "Forms & Certificates is currently only available in the desktop app's Reports module.");
        return;
    }
  };

  const styles = useThemedStyles(createStyles);

  if (!job) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  const clientAddress = client ? formatClientAddress(client) : null;
  const clientPhone = client?.phone ?? null;
  const pmMobile = propertyManager?.mobile ?? propertyManager?.work_phone ?? null;

  return (
    <>
    <StatusBar style="light" />
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.headerLink}>‹ BACK</Text>
          </Pressable>
          <Text style={styles.jobNumber}>{job.number ?? "PENDING SYNC"}</Text>
          <Pressable onPress={openEditModal} hitSlop={8}>
            <Text style={styles.headerLink}>EDIT</Text>
          </Pressable>
        </View>
        <Text style={styles.jobTitle}>{job.title}</Text>

        {client ? (
          <View style={styles.headerReadouts}>
            <Readout label="Client" value={client.name} onPress={() => router.push(`/sales/clients/${client.id}`)} />
            {clientPhone ? <Readout label="Phone" value={clientPhone} onPress={() => callPhone(clientPhone)} /> : null}
            {clientAddress ? <Readout label="Address" value={clientAddress} onPress={() => openInMaps(clientAddress)} /> : null}
          </View>
        ) : null}

        {job.is_real_estate_job ? (
          <View style={styles.agencyBadgeRow}>
            <Text style={styles.agencyBadge}>◆ AGENCY JOB{agency ? ` · ${agency.name.toUpperCase()}` : ""}</Text>
          </View>
        ) : null}
      </View>

      {isAdmin ? (
        <View style={styles.tabRow}>
          <Pressable
            style={[styles.tabButton, activeTab === "details" && styles.tabButtonActive]}
            onPress={() => setActiveTab("details")}
          >
            <Text style={[styles.tabButtonText, activeTab === "details" && styles.tabButtonTextActive]}>Details</Text>
          </Pressable>
          <Pressable
            style={[styles.tabButton, activeTab === "costing" && styles.tabButtonActive]}
            onPress={() => setActiveTab("costing")}
          >
            <Text style={[styles.tabButtonText, activeTab === "costing" && styles.tabButtonTextActive]}>Job Costing</Text>
          </Pressable>
        </View>
      ) : null}

      {activeTab === "costing" && isAdmin ? (
        !isOnline ? (
          <Panel title="Job Costing" status="OFFLINE">
            <Text style={styles.empty}>
              This device is offline. Job costing is an office/PC workflow that needs a connection - reconnect to view it.
            </Text>
          </Panel>
        ) : (
          <>
            <Panel title="Linked Documents">
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
              {costingDocs.length === 0 ? <Text style={styles.empty}>No quotes or invoices linked to this job yet.</Text> : null}
            </Panel>
            {costingDocs.length > 0 ? (
              <Panel title="Summary">
                {costingLoading ? (
                  <Text style={styles.empty}>Loading costing breakdown...</Text>
                ) : (
                  <>
                    <Readout label="Labour cost" value={formatCentsAsAud(totalLabourCents)} />
                    <Readout label="Material cost" value={formatCentsAsAud(totalMaterialCents)} />
                    <Readout label="Total charged" value={formatCentsAsAud(totalChargedCents)} />
                    <View style={styles.divider} />
                    <Readout label="Margin" value={formatCentsAsAud(marginCents)} />
                    <Readout label="Margin %" value={`${marginPercent.toFixed(1)}%`} />
                  </>
                )}
              </Panel>
            ) : null}
          </>
        )
      ) : null}

      {activeTab === "details" || !isAdmin ? (
        <>
          <Panel title="Job Description">
            {job.description ? (
              <Text style={styles.bodyText}>{job.description}</Text>
            ) : (
              <Text style={styles.empty}>No description yet. Tap EDIT above to add one.</Text>
            )}
          </Panel>

          <Panel title="Contacts">
            {client ? (
              <>
                <Readout label="Primary Contact" value={client.name} onPress={() => router.push(`/sales/clients/${client.id}`)} />
                {clientPhone ? <Readout label="Phone" value={clientPhone} onPress={() => callPhone(clientPhone)} /> : null}
              </>
            ) : (
              <Text style={styles.empty}>No client on this job.</Text>
            )}

            {job.is_real_estate_job ? (
              <>
                <View style={styles.divider} />
                {agency ? <Readout label="Agency" value={agency.name} /> : null}
                {propertyManager ? (
                  <Readout label="Property Manager" value={`${propertyManager.first_name} ${propertyManager.last_name}`} />
                ) : null}
                {pmMobile ? <Readout label="PM Contact" value={pmMobile} onPress={() => callPhone(pmMobile)} /> : null}
                {job.work_order_number ? <Readout label="Work Order" value={job.work_order_number} /> : null}
                {job.nte_limit_cents != null ? <Readout label="NTE Limit" value={formatCentsAsAud(job.nte_limit_cents)} /> : null}
                {isNteExceeded ? (
                  <Text style={styles.dangerText}>
                    {job.nte_exceeded_approved ? "OVER NTE LIMIT - VARIATION APPROVED" : "OVER NTE LIMIT - PM APPROVAL REQUIRED"}
                  </Text>
                ) : null}

                {property?.key_tag_number ? (
                  <>
                    <View style={styles.divider} />
                    <Readout
                      label="Key Tag"
                      value={`${property.key_tag_number} (${keyLog ? keyLog.status.replace("_", " ").toUpperCase() : "AT OFFICE"})`}
                    />
                    <View style={styles.keyActionsRow}>
                      {!keyLog || keyLog.status === "returned" ? (
                        <ThemedButton variant="secondary" label="Keys Picked Up" onPress={handleKeyPickedUp} />
                      ) : keyLog.status === "picked_up" ? (
                        <ThemedButton variant="secondary" label="Mark In Van" onPress={() => handleKeyStatusChange("in_van")} />
                      ) : (
                        <ThemedButton variant="secondary" label="Mark Returned" onPress={() => handleKeyStatusChange("returned")} />
                      )}
                    </View>
                  </>
                ) : null}
                {keyActionError ? <Text style={styles.dangerText}>{keyActionError}</Text> : null}
              </>
            ) : null}

            <View style={styles.divider} />
            <Text style={styles.fieldLabel}>Additional Contacts</Text>
            {jobContacts.contacts.map((c) => (
              <View key={c.id} style={styles.contactRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>
                    {c.name}
                    {c.role_label ? ` · ${c.role_label}` : ""}
                  </Text>
                  {c.phone ? (
                    <Pressable onPress={() => callPhone(c.phone as string)}>
                      <Text style={styles.contactMeta}>{c.phone}</Text>
                    </Pressable>
                  ) : null}
                  {c.email ? <Text style={styles.contactMeta}>{c.email}</Text> : null}
                </View>
                <Pressable onPress={() => jobContacts.removeContact(c.id)} hitSlop={8}>
                  <Text style={styles.dangerText}>REMOVE</Text>
                </Pressable>
              </View>
            ))}
            {jobContacts.contacts.length === 0 ? (
              <Text style={styles.empty}>No additional contacts (e.g. a second homeowner or tenant) yet.</Text>
            ) : null}
            <View style={{ gap: 8, marginTop: 8 }}>
              <ThemedFormField label="Name" placeholder="Contact name" value={jobContacts.name} onChangeText={jobContacts.setName} />
              <ThemedFormField
                label="Role (optional)"
                placeholder="e.g. Tenant, Second Homeowner"
                value={jobContacts.roleLabel}
                onChangeText={jobContacts.setRoleLabel}
              />
              <ThemedFormField label="Phone (optional)" placeholder="Phone" value={jobContacts.phone} onChangeText={jobContacts.setPhone} keyboardType="phone-pad" />
              <ThemedFormField label="Email (optional)" placeholder="Email" value={jobContacts.email} onChangeText={jobContacts.setEmail} keyboardType="email-address" />
              {jobContacts.error ? <Text style={styles.dangerText}>{jobContacts.error}</Text> : null}
              <ThemedButton variant="secondary" label="Add Contact" onPress={jobContacts.addContact} />
            </View>
          </Panel>

          <Panel title="Upcoming Bookings">
            {(upcomingBookings ?? []).map((event) => (
              <Pressable key={event.id} style={styles.linkedRow} onPress={() => router.push(`/calendar/${event.id}`)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.linkedRowText}>{event.title}</Text>
                  <Text style={styles.contactMeta}>
                    {new Date(event.start_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </Text>
                </View>
              </Pressable>
            ))}
            {isOnline && (upcomingBookings ?? []).length === 0 ? (
              <Text style={styles.empty}>No upcoming bookings linked to this job.</Text>
            ) : null}
            {!isOnline ? (
              <Text style={styles.empty}>Connect to view or schedule bookings.</Text>
            ) : (
              <Pressable onPress={() => router.push({ pathname: "/calendar/new", params: { jobCardId: job.id } })}>
                <Text style={styles.addLink}>+ Schedule booking for this job</Text>
              </Pressable>
            )}
          </Panel>

          <Panel title="Job Details" status={stage?.name?.toUpperCase()}>
            <Text style={styles.fieldLabel}>Category</Text>
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

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Lifecycle Stage</Text>
            <Pressable style={styles.pickerField} onPress={() => setStagePickerVisible(true)}>
              <View style={styles.pickerFieldRow}>
                {stage?.color ? <View style={[styles.swatch, { backgroundColor: stage.color }]} /> : null}
                <Text style={stage ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>{stage?.name ?? "No stage"}</Text>
              </View>
            </Pressable>
            {stage ? (
              <Pressable onPress={() => handleStageChange(null)}>
                <Text style={styles.clearLink}>Clear</Text>
              </Pressable>
            ) : null}
          </Panel>

          <Panel title="Notify Client">
            <ThemedButton
              label="On The Way"
              onPress={() => {
                setEtaMinutes("");
                setOnTheWayError(null);
                setOnTheWayModalVisible(true);
              }}
            />
            <Text style={styles.hint}>Sends an automated "on the way" SMS/email with your ETA.</Text>
          </Panel>

          <Panel title="Job Tasks">
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
                  <Text style={styles.taskStatusBadgeText}>{TASK_STATUS_LABELS[t.status].toUpperCase()}</Text>
                </Pressable>
              </Pressable>
            ))}
            {jobTasks.length === 0 ? <Text style={styles.empty}>No tasks linked to this job.</Text> : null}
            {profile?.role === "admin" ? (
              <View style={styles.addTaskRow}>
                <View style={{ flex: 1 }}>
                  <ThemedFormField label="Add a task" placeholder="Task title" value={taskTitle} onChangeText={setTaskTitle} />
                </View>
                <ThemedButton label="Add" onPress={handleAddTask} />
              </View>
            ) : null}
            {taskError ? <Text style={styles.dangerText}>{taskError}</Text> : null}
          </Panel>

          <Panel title="Billing · Quotes">
            {(linkedQuotes ?? []).map((q) => (
              <Pressable key={q.id} style={styles.linkedRow} onPress={() => router.push(`/sales/quotes/${q.id}`)}>
                <Text style={styles.linkedRowText}>{q.quote_number}</Text>
                <Text style={styles.linkedRowTotal}>{formatCentsAsAud(q.total_cents)}</Text>
              </Pressable>
            ))}
            {isOnline && linkedQuotes?.length === 0 ? <Text style={styles.empty}>No quotes linked to this job.</Text> : null}
            {!isOnline ? (
              <Text style={styles.empty}>Connect to view or create quotes.</Text>
            ) : profile?.role === "admin" ? (
              <Pressable
                onPress={() => router.push({ pathname: "/sales/quotes/new", params: { jobCardId: job.id, clientId: job.client_id } })}
              >
                <Text style={styles.addLink}>+ New quote for this job</Text>
              </Pressable>
            ) : null}
          </Panel>

          <Panel title="Billing · Invoices">
            {(linkedInvoices ?? []).map((inv) => (
              <Pressable key={inv.id} style={styles.linkedRow} onPress={() => router.push(`/sales/invoices/${inv.id}`)}>
                <Text style={styles.linkedRowText}>{inv.invoice_number}</Text>
                <Text style={styles.linkedRowTotal}>{formatCentsAsAud(inv.total_cents)}</Text>
              </Pressable>
            ))}
            {isOnline && linkedInvoices?.length === 0 ? <Text style={styles.empty}>No invoices linked to this job.</Text> : null}
            {!isOnline ? (
              <Text style={styles.empty}>Connect to view or create invoices.</Text>
            ) : profile?.role === "admin" ? (
              <Pressable
                onPress={() => router.push({ pathname: "/sales/invoices/new", params: { jobCardId: job.id, clientId: job.client_id } })}
              >
                <Text style={styles.addLink}>+ New invoice for this job</Text>
              </Pressable>
            ) : null}
          </Panel>

          <Panel title="Diary">
            <ThemedButton label="Open Diary" onPress={() => router.push({ pathname: "/sales/jobs/diary", params: { jobCardId: job.id } })} />
            <Text style={styles.hint}>Notes, photos and files for this job all live in the Diary.</Text>
          </Panel>

          <Panel title="Job Tools">
            <ThemedButton label="Open Job Tools" onPress={() => router.push({ pathname: "/sales/jobs/tools", params: { jobCardId: job.id } })} />
            <Text style={styles.hint}>Roof Area, Linear Measurer, Material Tally, Photo Markup, Concrete Calculator, Material Order.</Text>
          </Panel>

          <Panel title="Communication Log">
            <ThemedCommunicationLog
              entities={[
                { entityType: "job", entityId: job.id },
                ...(linkedQuotes ?? []).map((q) => ({ entityType: "quote" as const, entityId: q.id })),
                ...(linkedInvoices ?? []).map((inv) => ({ entityType: "invoice" as const, entityId: inv.id })),
              ]}
            />
          </Panel>
        </>
      ) : null}
    </ScrollView>

    {activeTab === "details" || !isAdmin ? (
      <JobActionsBar quickActions={quickActions} onAction={runJobAction} onMore={() => setActionsSheetVisible(true)} />
    ) : null}
    </SafeAreaView>

    <MultiCaptureCamera
      visible={photoCapture.cameraVisible}
      onClose={() => photoCapture.setCameraVisible(false)}
      onDone={photoCapture.handleCameraDone}
    />

    <ThemedModal visible={quickNoteModalVisible} onClose={() => setQuickNoteModalVisible(false)}>
      <Text style={styles.modalTitle}>Add Note</Text>
      <ThemedFormField label="Note" placeholder="Note" value={noteText} onChangeText={setNoteText} multiline style={styles.multiline} />
      {noteError ? <Text style={styles.dangerText}>{noteError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setQuickNoteModalVisible(false)}>
          <Text style={styles.headerLink}>Cancel</Text>
        </Pressable>
        <ThemedButton
          label="Save"
          onPress={async () => {
            const ok = await addNote();
            if (ok) setQuickNoteModalVisible(false);
          }}
        />
      </View>
    </ThemedModal>

    <JobActionsSheet
      visible={actionsSheetVisible}
      onClose={() => setActionsSheetVisible(false)}
      order={actionOrder}
      onReorder={setActionOrder}
      onAction={runJobAction}
    />

    <ThemedModal visible={onTheWayModalVisible} onClose={() => setOnTheWayModalVisible(false)}>
      <Text style={styles.modalTitle}>On The Way</Text>
      <ThemedFormField
        label="ETA (minutes)"
        placeholder="e.g. 15"
        value={etaMinutes}
        onChangeText={setEtaMinutes}
        keyboardType="number-pad"
      />
      {onTheWayError ? <Text style={styles.dangerText}>{onTheWayError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setOnTheWayModalVisible(false)}>
          <Text style={styles.headerLink}>Cancel</Text>
        </Pressable>
        <ThemedButton label="Send" onPress={handleSendOnTheWay} />
      </View>
    </ThemedModal>

    <ThemedModal visible={nteModalVisible} onClose={() => setNteModalVisible(false)}>
      <Text style={styles.modalTitle}>Over Budget</Text>
      <Text style={styles.modalBody}>
        This job exceeds the NTE limit of {job?.nte_limit_cents != null ? formatCentsAsAud(job.nte_limit_cents) : "-"} by{" "}
        {job?.nte_limit_cents != null ? formatCentsAsAud(totalChargedCents - job.nte_limit_cents) : "-"}. PM approval is required
        before this job can be marked done.
      </Text>
      {nteRequestError ? <Text style={styles.dangerText}>{nteRequestError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setNteModalVisible(false)}>
          <Text style={styles.headerLink}>Cancel</Text>
        </Pressable>
        <ThemedButton
          label={nteRequesting ? "Sending..." : "Request NTE Variation"}
          onPress={handleRequestNteVariation}
          disabled={nteRequesting}
        />
      </View>
    </ThemedModal>

    <ThemedModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
      <Text style={styles.modalTitle}>Edit Job</Text>
      <ThemedFormField label="Title" placeholder="Job title" value={editTitle} onChangeText={setEditTitle} />
      <ThemedFormField
        label="Description (optional)"
        placeholder="Description"
        value={editDescription}
        onChangeText={setEditDescription}
        multiline
        style={styles.multiline}
      />
      {editError ? <Text style={styles.dangerText}>{editError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setEditModalVisible(false)}>
          <Text style={styles.headerLink}>Cancel</Text>
        </Pressable>
        <ThemedButton label="Save" onPress={handleSaveEdit} />
      </View>
    </ThemedModal>

    <ThemedPickerModal
      visible={categoryPickerVisible}
      title="Select category"
      items={categories}
      getKey={(c) => c.id}
      getLabel={(c) => c.name}
      onSelect={handleCategoryChange}
      onClose={() => setCategoryPickerVisible(false)}
    />

    <ThemedPickerModal
      visible={stagePickerVisible}
      title="Select stage"
      items={stages}
      getKey={(s) => s.id}
      getLabel={(s) => s.name}
      onSelect={handleStageChange}
      onClose={() => setStagePickerVisible(false)}
    />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { padding: 16, gap: 10 },
    headerTopRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    jobNumber: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.textMuted,
      letterSpacing: 1.5,
      fontFamily: fontFamily.mobileFontFamily,
      textTransform: "uppercase" as const,
    },
    headerLink: {
      color: tokens.accent,
      fontWeight: "700" as const,
      fontFamily: fontFamily.mobileFontFamily,
      letterSpacing: 1,
      fontSize: font.body,
    },
    jobTitle: {
      fontSize: font.title + 4,
      fontWeight: "700" as const,
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
    },
    headerReadouts: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      padding: 12,
      gap: 8,
      backgroundColor: tokens.surface,
    },
    agencyBadgeRow: { alignSelf: "flex-start" as const },
    agencyBadge: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.warning,
      fontFamily: fontFamily.mobileFontFamily,
      letterSpacing: 1,
    },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      fontFamily: fontFamily.mobileFontFamily,
      textTransform: "uppercase" as const,
      letterSpacing: 1,
    },
    modalBody: { fontSize: font.body, color: tokens.textPrimary, lineHeight: 20, marginTop: 6, fontFamily: fontFamily.mobileFontFamily },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    tabRow: { flexDirection: "row" as const, paddingHorizontal: 12, paddingTop: 4, gap: 8 },
    tabButton: { flex: 1, paddingVertical: 10, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, alignItems: "center" as const },
    tabButtonActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    tabButtonText: {
      color: tokens.textMuted,
      fontWeight: "700" as const,
      fontFamily: fontFamily.mobileFontFamily,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      fontSize: font.body - 1,
    },
    tabButtonTextActive: { color: tokens.accent },
    costingDocRow: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    costingDocNumber: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    costingDocMeta: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, fontFamily: fontFamily.mobileFontFamily },
    costingDocTotal: { fontSize: font.body, fontWeight: "700" as const, color: tokens.accent, fontFamily: fontFamily.mobileFontFamily },
    divider: { borderTopWidth: 1, borderTopColor: tokens.border, marginVertical: 4 },
    contactRow: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    contactName: { color: tokens.textPrimary, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
    contactMeta: { color: tokens.textMuted, fontSize: font.label, fontFamily: fontFamily.mobileFontFamily, marginTop: 2 },
    bodyText: { fontSize: font.body, color: tokens.textPrimary, lineHeight: font.body + 6, fontFamily: fontFamily.mobileFontFamily },
    fieldLabel: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      marginBottom: 6,
    },
    fieldLabelSpaced: { marginTop: 12 },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, fontFamily: fontFamily.mobileFontFamily },
    swatch: { width: 12, height: 12, borderRadius: 6 },
    clearLink: { color: tokens.accent, fontWeight: "600" as const, marginTop: 6, alignSelf: "flex-start" as const, fontFamily: fontFamily.mobileFontFamily },
    hint: { color: tokens.textMuted, fontSize: font.label, marginTop: 8, fontFamily: fontFamily.mobileFontFamily },
    keyActionsRow: { flexDirection: "row" as const, marginTop: 8 },
    taskRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    taskRowTitle: { fontSize: font.body, color: tokens.textPrimary, flex: 1, marginRight: 8, fontFamily: fontFamily.mobileFontFamily },
    taskStatusBadge: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
    taskStatusBadgeText: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label - 1, fontFamily: fontFamily.mobileFontFamily },
    addTaskRow: { flexDirection: "row" as const, gap: 8, marginTop: 4, alignItems: "flex-end" as const },
    addLink: { color: tokens.accent, fontWeight: "600" as const, marginTop: 4, fontFamily: fontFamily.mobileFontFamily },
    linkedRow: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    linkedRowText: { color: tokens.textPrimary, fontWeight: "600" as const, fontFamily: fontFamily.mobileFontFamily },
    linkedRowTotal: { color: tokens.accent, fontWeight: "700" as const, fontFamily: fontFamily.mobileFontFamily },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    dangerText: { color: tokens.danger, marginTop: 6, fontFamily: fontFamily.mobileFontFamily, fontSize: font.label },
    noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: tokens.border },
    noteBody: { fontSize: font.body, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    noteMeta: { fontSize: font.label - 1, color: tokens.textMuted, marginTop: 4, fontFamily: fontFamily.mobileFontFamily },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 12, fontFamily: fontFamily.mobileFontFamily },
  };
}
