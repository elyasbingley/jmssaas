import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ALL_PLACEHOLDER_TOKENS,
  updateCommunicationRuleSchema,
  updateCommunicationTemplateSchema,
  type CommunicationDelayDirection,
  type CommunicationDelayUnit,
  type CommunicationRule,
  type CommunicationTemplate,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

// Direct port of apps/mobile/app/automation-settings.tsx - same trigger
// groups/labels/timing summaries, same six-trigger_key scope (not a fully
// custom "add your own automation" builder - see that file's own comment).
// Desktop is always-online, so this reads/writes communication_rules and
// communication_templates with plain Supabase calls instead of PowerSync's
// local-first execute(), and the review link field has no
// RequiresConnectionNotice-style gating since there's no offline mode here.

const TRIGGER_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "Quote Follow-ups",
    keys: ["quote_sent", "quote_stage_1", "quote_stage_2", "quote_expiring_soon", "quote_expired"],
  },
  {
    title: "Invoice Reminders",
    keys: [
      "invoice_sent",
      "invoice_pre_due",
      "invoice_due_today",
      "invoice_overdue_1",
      "invoice_overdue_14",
      "invoice_payment_received",
    ],
  },
  {
    title: "Field Alerts",
    keys: ["job_on_the_way", "job_prep_checklist", "job_completion_summary", "job_review_request"],
  },
  {
    title: "Retention",
    keys: ["maintenance_reminder", "dormant_client_reengagement"],
  },
];

const TRIGGER_LABELS: Record<string, string> = {
  quote_sent: "Quote delivery",
  quote_stage_1: "First follow-up",
  quote_stage_2: "Second follow-up",
  quote_expiring_soon: "Expiring soon",
  quote_expired: "Expired",
  invoice_sent: "Invoice delivery",
  invoice_pre_due: "Reminder before due",
  invoice_due_today: "Due today",
  invoice_overdue_1: "Overdue reminder",
  invoice_overdue_14: "Seriously overdue",
  invoice_payment_received: "Payment receipt",
  job_on_the_way: "On The Way",
  job_prep_checklist: "Prep your site",
  job_completion_summary: "Job complete",
  job_review_request: "Review request",
  maintenance_reminder: "Maintenance reminder",
  dormant_client_reengagement: "Dormant client re-engagement",
};

const TRIGGER_ANCHORS: Record<string, string> = {
  quote_sent: "sent",
  quote_stage_1: "the quote is sent",
  quote_stage_2: "the quote is sent",
  quote_expiring_soon: "the quote expires",
  quote_expired: "the quote expires",
  invoice_sent: "sent",
  invoice_pre_due: "the invoice is due",
  invoice_due_today: "the invoice is due",
  invoice_overdue_1: "the invoice is due",
  invoice_overdue_14: "the invoice is due",
  invoice_payment_received: "the invoice is paid",
  job_on_the_way: "sent",
  job_prep_checklist: "the job's scheduled visit",
  job_completion_summary: "the job is completed",
  job_review_request: "the job is completed",
};

const UNIT_OPTIONS: CommunicationDelayUnit[] = ["hours", "days"];
const DIRECTION_OPTIONS: CommunicationDelayDirection[] = ["before", "after"];

function summarizeTiming(rule: CommunicationRule): string {
  if (rule.trigger_key === "maintenance_reminder") {
    return "Interval set per service category in Job Setup";
  }
  if (rule.trigger_key === "dormant_client_reengagement") {
    const unitLabel = rule.delay_offset_value === 1 ? rule.delay_offset_unit.replace(/s$/, "") : rule.delay_offset_unit;
    return `Sent after ${rule.delay_offset_value} ${unitLabel} with no new job`;
  }
  const anchor = TRIGGER_ANCHORS[rule.trigger_key] ?? "the trigger event";
  if (rule.delay_offset_value === 0) return `Sent immediately when ${anchor}`;
  const unitLabel = rule.delay_offset_value === 1 ? rule.delay_offset_unit.replace(/s$/, "") : rule.delay_offset_unit;
  return `${rule.delay_offset_value} ${unitLabel} ${rule.delay_direction} ${anchor}`;
}

// quiet_hours_start/end come back from Supabase as "HH:MM:SS" - <input
// type="time"> wants "HH:MM", so strip/re-add the seconds at the boundary.
function timeToInputValue(time: string): string {
  return time.slice(0, 5);
}
function inputValueToTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

async function fetchRules(): Promise<CommunicationRule[]> {
  const { data, error } = await supabase.from("communication_rules").select("*").order("trigger_key");
  if (error) throw error;
  return data as CommunicationRule[];
}
async function fetchTemplates(): Promise<CommunicationTemplate[]> {
  const { data, error } = await supabase.from("communication_templates").select("*").order("trigger_key, type");
  if (error) throw error;
  return data as CommunicationTemplate[];
}
async function fetchTenantReviewLink(tenantId: string): Promise<Pick<Tenant, "google_review_link">> {
  const { data, error } = await supabase.from("tenants").select("google_review_link").eq("id", tenantId).single();
  if (error) throw error;
  return data as Pick<Tenant, "google_review_link">;
}

export default function AutomationSettingsPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: rules } = useQuery({ queryKey: ["communication-rules"], queryFn: fetchRules });
  const { data: templates } = useQuery({ queryKey: ["communication-templates"], queryFn: fetchTemplates });
  const { data: tenant } = useQuery({
    queryKey: ["tenant-review-link", profile?.tenant_id],
    queryFn: () => fetchTenantReviewLink(profile!.tenant_id),
    enabled: !!profile,
  });

  const invalidateRules = () => queryClient.invalidateQueries({ queryKey: ["communication-rules"] });
  const invalidateTemplates = () => queryClient.invalidateQueries({ queryKey: ["communication-templates"] });

  const toggleRule = useMutation({
    mutationFn: async (rule: CommunicationRule) => {
      const { error } = await supabase
        .from("communication_rules")
        .update({ is_enabled: !rule.is_enabled })
        .eq("id", rule.id);
      if (error) throw error;
    },
    onSuccess: invalidateRules,
  });

  const [reviewLink, setReviewLink] = useState("");
  const [reviewLinkSaved, setReviewLinkSaved] = useState(false);
  const [reviewLinkError, setReviewLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) setReviewLink(tenant.google_review_link ?? "");
  }, [tenant]);

  const saveReviewLink = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase
        .from("tenants")
        .update({ google_review_link: reviewLink || null })
        .eq("id", profile.tenant_id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-review-link", profile?.tenant_id] });
      setReviewLinkError(null);
      setReviewLinkSaved(true);
      setTimeout(() => setReviewLinkSaved(false), 3000);
    },
    onError: (e) => setReviewLinkError(getErrorMessage(e, "Failed to save")),
  });

  // Rule edit modal
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<CommunicationRule | null>(null);
  const [ruleDelayValue, setRuleDelayValue] = useState("0");
  const [ruleDelayUnit, setRuleDelayUnit] = useState<CommunicationDelayUnit>("days");
  const [ruleDirection, setRuleDirection] = useState<CommunicationDelayDirection>("after");
  const [ruleQuietStart, setRuleQuietStart] = useState("08:00");
  const [ruleQuietEnd, setRuleQuietEnd] = useState("18:00");
  const [ruleError, setRuleError] = useState<string | null>(null);

  const openEditRule = (rule: CommunicationRule) => {
    setEditingRule(rule);
    setRuleDelayValue(String(rule.delay_offset_value));
    setRuleDelayUnit(rule.delay_offset_unit);
    setRuleDirection(rule.delay_direction);
    setRuleQuietStart(timeToInputValue(rule.quiet_hours_start));
    setRuleQuietEnd(timeToInputValue(rule.quiet_hours_end));
    setRuleError(null);
    setRuleModalOpen(true);
  };

  const saveRule = useMutation({
    mutationFn: async () => {
      if (!editingRule) throw new Error("No rule selected");
      const result = updateCommunicationRuleSchema.safeParse({
        is_enabled: editingRule.is_enabled,
        delay_offset_value: Number(ruleDelayValue) || 0,
        delay_offset_unit: ruleDelayUnit,
        delay_direction: ruleDirection,
        // SMS is currently unsupported (see the dispatcher's own comment) -
        // every rule is email-only for now, so there's nothing to pick here.
        channel: "email",
        quiet_hours_start: inputValueToTime(ruleQuietStart),
        quiet_hours_end: inputValueToTime(ruleQuietEnd),
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      const { error } = await supabase
        .from("communication_rules")
        .update({
          delay_offset_value: result.data.delay_offset_value,
          delay_offset_unit: result.data.delay_offset_unit,
          delay_direction: result.data.delay_direction,
          channel: result.data.channel,
          quiet_hours_start: result.data.quiet_hours_start,
          quiet_hours_end: result.data.quiet_hours_end,
        })
        .eq("id", editingRule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateRules();
      setRuleModalOpen(false);
    },
    onError: (e) => setRuleError(getErrorMessage(e, "Failed to save")),
  });

  // Template edit modal
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CommunicationTemplate | null>(null);
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [templateActive, setTemplateActive] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const openEditTemplate = (template: CommunicationTemplate) => {
    setEditingTemplate(template);
    setTemplateSubject(template.subject ?? "");
    setTemplateBody(template.body);
    setTemplateActive(template.is_active);
    setTemplateError(null);
    setTemplateModalOpen(true);
  };

  const insertToken = (token: string) => {
    const insert = `{${token}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? templateBody.length;
    const end = el?.selectionEnd ?? templateBody.length;
    const next = templateBody.slice(0, start) + insert + templateBody.slice(end);
    setTemplateBody(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  const saveTemplate = useMutation({
    mutationFn: async () => {
      if (!editingTemplate) throw new Error("No template selected");
      const result = updateCommunicationTemplateSchema.safeParse({
        name: editingTemplate.name,
        subject: templateSubject || undefined,
        body: templateBody,
        is_active: templateActive,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      const { error } = await supabase
        .from("communication_templates")
        .update({ subject: result.data.subject || null, body: result.data.body, is_active: result.data.is_active })
        .eq("id", editingTemplate.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateTemplates();
      setTemplateModalOpen(false);
    },
    onError: (e) => setTemplateError(getErrorMessage(e, "Failed to save")),
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-xl font-bold text-gray-900">Automation & Messaging</h1>
      <p className="mb-6 text-sm text-gray-500">Control when automated emails go out, and edit their wording.</p>

      {TRIGGER_GROUPS.map((group) => (
        <div key={group.title} className="mb-6">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-500">{group.title}</h2>
          <div className="space-y-3">
            {group.keys.map((key) => {
              const rule = (rules ?? []).find((r) => r.trigger_key === key);
              const triggerTemplates = (templates ?? []).filter((t) => t.trigger_key === key);
              if (!rule) return null;
              return (
                <div key={key} className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="font-bold text-gray-900">{TRIGGER_LABELS[key] ?? key}</p>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <input
                        type="checkbox"
                        checked={rule.is_enabled}
                        onChange={() => toggleRule.mutate(rule)}
                      />
                      Enabled
                    </label>
                  </div>
                  <p className="text-sm text-gray-700">{summarizeTiming(rule)}</p>
                  <p className="mb-2 text-xs text-gray-400">
                    Quiet hours {rule.quiet_hours_start.slice(0, 5)}-{rule.quiet_hours_end.slice(0, 5)}
                  </p>
                  <button onClick={() => openEditRule(rule)} className="text-sm font-semibold text-blue-700 hover:underline">
                    Edit timing
                  </button>

                  {triggerTemplates.map((template) => (
                    <div key={template.id} className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
                      <div className="min-w-0 flex-1 pr-3">
                        <p className="text-sm font-semibold text-gray-900">
                          {template.name} ({template.type})
                        </p>
                        <p className="truncate text-xs text-gray-500">{template.body}</p>
                      </div>
                      <button
                        onClick={() => openEditTemplate(template)}
                        className="flex-shrink-0 text-sm font-semibold text-blue-700 hover:underline"
                      >
                        Edit message
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-500">Review link</h2>
      <p className="mb-3 text-sm text-gray-500">Used by the {"{google_review_link}"} tag in the review request message.</p>
      <FormField
        label="Google review link"
        value={reviewLink}
        onChange={(e) => setReviewLink(e.target.value)}
        placeholder="https://g.page/r/..."
      />
      {reviewLinkError ? <p className="mb-2 text-sm text-red-600">{reviewLinkError}</p> : null}
      {reviewLinkSaved ? <p className="mb-2 text-sm text-green-700">Saved.</p> : null}
      <button
        onClick={() => saveReviewLink.mutate()}
        disabled={saveReviewLink.isPending}
        className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {saveReviewLink.isPending ? "Saving..." : "Save review link"}
      </button>

      <Modal
        open={ruleModalOpen}
        onClose={() => setRuleModalOpen(false)}
        title={`Edit timing${editingRule ? ` - ${TRIGGER_LABELS[editingRule.trigger_key] ?? editingRule.trigger_key}` : ""}`}
      >
        {editingRule?.trigger_key === "maintenance_reminder" ? (
          <p className="mb-4 text-sm text-gray-600">
            The interval for this reminder is set per service category, not here - edit it from Settings &gt; Job Setup
            on the category that should get a recurring reminder (e.g. 6 months for aircon servicing, 12 for an annual
            inspection).
          </p>
        ) : (
          <>
            <FormField
              label={editingRule?.trigger_key === "dormant_client_reengagement" ? "Days of inactivity" : "Delay value"}
              type="number"
              value={ruleDelayValue}
              onChange={(e) => setRuleDelayValue(e.target.value)}
            />
            {editingRule?.trigger_key !== "dormant_client_reengagement" ? (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-700">Delay unit</label>
                  <select
                    value={ruleDelayUnit}
                    onChange={(e) => setRuleDelayUnit(e.target.value as CommunicationDelayUnit)}
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {UNIT_OPTIONS.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-700">Direction</label>
                  <select
                    value={ruleDirection}
                    onChange={(e) => setRuleDirection(e.target.value as CommunicationDelayDirection)}
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {DIRECTION_OPTIONS.map((direction) => (
                      <option key={direction} value={direction}>
                        {direction}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}
          </>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <FormField
            label="Quiet hours start"
            type="time"
            value={ruleQuietStart}
            onChange={(e) => setRuleQuietStart(e.target.value)}
          />
          <FormField
            label="Quiet hours end"
            type="time"
            value={ruleQuietEnd}
            onChange={(e) => setRuleQuietEnd(e.target.value)}
          />
        </div>

        {ruleError ? <p className="mb-4 text-sm text-red-600">{ruleError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setRuleModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveRule.mutate()}
            disabled={saveRule.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveRule.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title={editingTemplate?.name ?? "Edit message"}>
        {editingTemplate?.type === "email" ? (
          <FormField label="Subject" value={templateSubject} onChange={(e) => setTemplateSubject(e.target.value)} />
        ) : null}

        <label className="mb-1 block text-sm font-semibold text-gray-700">Insert tag</label>
        <div className="mb-3 flex flex-wrap gap-2">
          {ALL_PLACEHOLDER_TOKENS.map((token) => (
            <button
              key={token}
              onClick={() => insertToken(token)}
              className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
            >
              {`{${token}}`}
            </button>
          ))}
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor="template-body">
            Message
          </label>
          <textarea
            id="template-body"
            ref={bodyRef}
            rows={6}
            value={templateBody}
            onChange={(e) => setTemplateBody(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <label className="mb-4 flex items-center gap-2 text-sm font-medium text-gray-700">
          <input type="checkbox" checked={templateActive} onChange={(e) => setTemplateActive(e.target.checked)} />
          Active
        </label>

        {templateError ? <p className="mb-4 text-sm text-red-600">{templateError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setTemplateModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveTemplate.mutate()}
            disabled={saveTemplate.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveTemplate.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
