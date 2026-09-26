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
import { ThemedModal } from "./theme/ThemedModal";
import { ThemedFormField } from "./theme/ThemedFormField";
import { ThemedButton } from "./theme/ThemedButton";

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
  referral_lead_received: "Sent to the partner as soon as they're added, and again if a job is later tagged as referred by them.",
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
      <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        Configure the automated emails sent to referral partners as thank-yous and updates. Uses the same Automation engine as the
        rest of the app.
      </p>

      <div className="space-y-3">
        {TRIGGER_KEYS.map((key) => {
          const rule = (rules ?? []).find((r) => r.trigger_key === key);
          const triggerTemplates = (templates ?? []).filter((t) => t.trigger_key === key);
          if (!rule) return null;
          return (
            <div key={key} className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
              <div className="mb-1 flex items-center justify-between">
                <p className="font-bold" style={{ color: "var(--jms-text)" }}>
                  {TRIGGER_LABELS[key]}
                </p>
                <label className="flex items-center gap-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                  <input type="checkbox" checked={rule.is_enabled} onChange={() => toggleRule.mutate(rule)} />
                  Enabled
                </label>
              </div>
              <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                {TRIGGER_DESCRIPTIONS[key]}
              </p>

              {triggerTemplates.map((template) => (
                <div key={template.id} className="mt-2 flex items-center justify-between pt-2" style={{ borderTop: "1px solid var(--jms-border)" }}>
                  <div className="min-w-0 flex-1 pr-3">
                    <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {template.name} ({template.type})
                    </p>
                    <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      {template.body}
                    </p>
                  </div>
                  <button
                    onClick={() => openEditTemplate(template)}
                    className="flex-shrink-0 font-semibold hover:underline"
                    style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
                  >
                    Edit message
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <ThemedModal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title={editingTemplate ? `Edit message - ${editingTemplate.name}` : "Edit message"}>
        <ThemedFormField label="Subject" value={templateSubject} onChange={(e) => setTemplateSubject(e.target.value)} />
        <div className="mb-2">
          <label className="mb-1 block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Body
          </label>
          <textarea
            ref={bodyRef}
            value={templateBody}
            onChange={(e) => setTemplateBody(e.target.value)}
            rows={6}
            className="w-full rounded border px-3 py-2 focus:outline-none"
            style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
          />
        </div>
        <div className="mb-4 flex flex-wrap gap-1">
          {relevantTokens
            .filter((t) => (ALL_PLACEHOLDER_TOKENS as readonly string[]).includes(t))
            .map((token) => (
              <button
                key={token}
                onClick={() => insertToken(token)}
                className="rounded-full border px-2 py-1 font-semibold"
                style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                {`{${token}}`}
              </button>
            ))}
        </div>
        <label className="mb-4 flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input type="checkbox" checked={templateActive} onChange={(e) => setTemplateActive(e.target.checked)} />
          Active
        </label>
        {templateError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {templateError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setTemplateModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveTemplate.mutate()} disabled={saveTemplate.isPending}>
            {saveTemplate.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}
