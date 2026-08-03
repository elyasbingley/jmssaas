import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createJobCardSchema,
  createJobNoteSchema,
  createTaskSchema,
  formatCentsAsAud,
  renderTemplate,
  type Client,
  type CommunicationRule,
  type CommunicationTemplate,
  type Invoice,
  type InvoiceLineItem,
  type JobCard,
  type JobLifecycleStage,
  type JobNote,
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
import { addJobPhoto } from "../../../../lib/powersync";
import { triggerImmediateDispatch } from "../../../../lib/dispatch-now";
import { formatClientAddress } from "../../../../lib/format";
import { CenteredModal } from "../../../../components/CenteredModal";
import { CommunicationLog } from "../../../../components/CommunicationLog";
import { FormField } from "../../../../components/FormField";
import { PhotoAttachments } from "../../../../components/PhotoAttachments";
import { PickerModal } from "../../../../components/PickerModal";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";

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
    `SELECT jf.id, a.local_uri
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

  const handleStageChange = async (next: JobLifecycleStage | null) => {
    const wasClosed = stage?.is_closed ?? false;
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

        {client ? (
          <Pressable style={styles.clientCard} onPress={() => router.push(`/sales/clients/${client.id}`)}>
            <Text style={styles.clientCardName}>{client.name}</Text>
            {client.phone ? <Text style={styles.clientCardMeta}>{client.phone}</Text> : null}
            {formatClientAddress(client) ? (
              <Text style={styles.clientCardMeta}>{formatClientAddress(client)}</Text>
            ) : null}
          </Pressable>
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
        <Text style={styles.sectionTitle}>Roof Measurement</Text>
        <Pressable
          style={styles.measureButton}
          onPress={() => router.push({ pathname: "/sales/jobs/measure", params: { jobCardId: job.id } })}
        >
          <Text style={styles.measureButtonText}>📐 Measure Roof</Text>
        </Pressable>
        <Text style={styles.measureHint}>
          Draw roof sections on a satellite map and save the total area to this job's notes.
        </Text>
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
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  section: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb" },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  number: { fontSize: 12, fontWeight: "700", color: "#1d4ed8", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: "700" },
  description: { marginTop: 6, color: "#374151" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  clientCard: { marginTop: 12, backgroundColor: "#f3f4f6", borderRadius: 8, padding: 12, gap: 2 },
  clientCardName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  clientCardMeta: { fontSize: 13, color: "#6b7280" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
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
    borderBottomColor: "#f0f0f0",
  },
  costingDocNumber: { fontSize: 15, fontWeight: "700", color: "#111827" },
  costingDocMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  costingDocTotal: { fontSize: 15, fontWeight: "700", color: "#111827" },
  costingSummaryTitle: { marginTop: 20 },
  costingSummaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  costingSummaryRowBold: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e5e7eb", marginTop: 4, paddingTop: 10 },
  costingSummaryLabel: { color: "#6b7280", fontSize: 13 },
  costingSummaryValue: { color: "#111827", fontSize: 13, fontWeight: "600" },
  costingSummaryLabelBold: { color: "#111827", fontSize: 15, fontWeight: "700" },
  costingSummaryValueBold: { color: "#111827", fontSize: 15, fontWeight: "700" },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pickerFieldText: { fontSize: 15, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 15, color: "#9ca3af" },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  clearLink: { color: "#1d4ed8", fontWeight: "600", marginTop: 6, alignSelf: "flex-start" },
  linkedRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0" },
  linkedRowText: { color: "#1d4ed8", fontWeight: "600" },
  linkButton: { marginTop: 10, alignSelf: "flex-start" },
  linkButtonText: { color: "#1d4ed8", fontWeight: "600" },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  taskRowTitle: { fontSize: 15, color: "#111827", flex: 1, marginRight: 8 },
  taskStatusBadge: { backgroundColor: "#f3f4f6", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  taskStatusBadgeText: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  addTaskRow: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "flex-end" },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  addNoteButton: { alignSelf: "flex-start", marginTop: 10 },
  measureButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center" },
  measureButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  measureHint: { color: "#6b7280", fontSize: 12, marginTop: 8 },
  onTheWayButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center" },
  onTheWayButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 6 },
  noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0f0f0" },
  noteBody: { fontSize: 15, color: "#111827" },
  noteMeta: { fontSize: 12, color: "#9ca3af", marginTop: 4 },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
});
