import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ALL_PLACEHOLDER_TOKENS,
  updateCommunicationTemplateSchema,
  type CommunicationRule,
  type CommunicationTemplate,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { FormField } from "./FormField";

// Sub-tab 4: trigger-based automated partner emails. Reuses the exact same
// communication_rules/communication_templates tables the rest of the app's
// Automation & Messaging screen manages (see AutomationSettings.tsx) - this
// is a scoped-down variant of that same editor, covering only the three
// referral trigger_keys added by the b2b_referral_automation migration,
// living inside this module rather than bolted onto the shared Settings
// page (a referral partner rule/template has nothing in common with a
// client-facing quote/invoice/job one apart from the underlying table shape).

const TRIGGER_KEYS = ["referral_lead_received", "referral_job_completed", "referral_monthly_digest"] as const;

const TRIGGER_LABELS: Record<string, string> = {
  referral_lead_received: "Lead Received",
  referral_job_completed: "Job Won / Completed",
  referral_monthly_digest: "Monthly Digest",
};

const TRIGGER_DESCRIPTIONS: Record<string, string> = {
  referral_lead_received: "Sent to the partner the moment a job is tagged as referred by them.",
  referral_job_completed: "Sent to the partner when the referred job's invoice is marked paid.",
  referral_monthly_digest: "Sent once a month, summarising that partner's closed business for the month just finished.",
};

async function fetchRules(): Promise<CommunicationRule[]> {
  const { data, error } = await supabase.from("communication_rules").select("*").in("trigger_key", TRIGGER_KEYS);
  if (error) throw error;
  return data as CommunicationRule[];
}
async function fetchTemplates(): Promise<CommunicationTemplate[]> {
  const { data, error } = await supabase.from("communication_templates").select("*").in("trigger_key", TRIGGER_KEYS);
  if (error) throw error;
  return data as CommunicationTemplate[];
}

export function ReferralWorkflowsTab() {
  const queryClient = useQueryClient();

  const { data: rules } = useQuery({ queryKey: ["referral-communication-rules"], queryFn: fetchRules });
  const { data: templates } = useQuery({ queryKey: ["referral-communication-templates"], queryFn: fetchTemplates });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["referral-communication-rules"] });
    queryClient.invalidateQueries({ queryKey: ["referral-communication-templates"] });
  };

  const toggleRule = useMutation({
    mutationFn: async (rule: CommunicationRule) => {
      const { error } = await supabase.from("communication_rules").update({ is_enabled: !rule.is_enabled }).eq("id", rule.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

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

  const relevantTokens = ["partner_first_name", "referred_client_name", "job_title", "job_value", "digest_jobs_count", "digest_total_value", "company_name", "company_phone"];

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
      invalidate();
      setTemplateModalOpen(false);
    },
    onError: (e) => setTemplateError(getErrorMessage(e, "Failed to save")),
  });

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-sm text-gray-500">
        Configure the automated emails sent to referral partners as thank-yous and updates. Uses the same Automation engine as the
        rest of the app.
      </p>

      <div className="space-y-3">
        {TRIGGER_KEYS.map((key) => {
          const rule = (rules ?? []).find((r) => r.trigger_key === key);
          const triggerTemplates = (templates ?? []).filter((t) => t.trigger_key === key);
          if (!rule) return null;
          return (
            <div key={key} className="rounded-lg border border-gray-300 bg-white p-4">
              <div className="mb-1 flex items-center justify-between">
                <p className="font-bold text-gray-900">{TRIGGER_LABELS[key]}</p>
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" checked={rule.is_enabled} onChange={() => toggleRule.mutate(rule)} />
                  Enabled
                </label>
              </div>
              <p className="mb-2 text-sm text-gray-500">{TRIGGER_DESCRIPTIONS[key]}</p>

              {triggerTemplates.map((template) => (
                <div key={template.id} className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2">
                  <div className="min-w-0 flex-1 pr-3">
                    <p className="text-sm font-semibold text-gray-900">
                      {template.name} ({template.type})
                    </p>
                    <p className="truncate text-xs text-gray-500">{template.body}</p>
                  </div>
                  <button onClick={() => openEditTemplate(template)} className="flex-shrink-0 text-sm font-semibold text-blue-700 hover:underline">
                    Edit message
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <Modal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title={editingTemplate ? `Edit message - ${editingTemplate.name}` : "Edit message"}>
        <FormField label="Subject" value={templateSubject} onChange={(e) => setTemplateSubject(e.target.value)} />
        <div className="mb-2">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Body</label>
          <textarea
            ref={bodyRef}
            value={templateBody}
            onChange={(e) => setTemplateBody(e.target.value)}
            rows={6}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="mb-4 flex flex-wrap gap-1">
          {relevantTokens
            .filter((t) => (ALL_PLACEHOLDER_TOKENS as readonly string[]).includes(t))
            .map((token) => (
              <button
                key={token}
                onClick={() => insertToken(token)}
                className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-200"
              >
                {`{${token}}`}
              </button>
            ))}
        </div>
        <label className="mb-4 flex items-center gap-2 text-sm text-gray-700">
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
