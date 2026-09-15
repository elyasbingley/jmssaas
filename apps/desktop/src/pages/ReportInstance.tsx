import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  RISK_CONSEQUENCE_LABELS,
  RISK_LIKELIHOOD_LABELS,
  RISK_RATING_LABELS,
  blankAnswerFor,
  calculateRiskRating,
  createReportSignatureSchema,
  isAnswered,
  type Client,
  type JobCard,
  type PassFailAnswer,
  type PhotoAnswer,
  type ReportAnswer,
  type ReportFormData,
  type ReportInstance,
  type ReportInstanceStatus,
  type ReportSignature,
  type ReportSignerRole,
  type ReportTemplate,
  type RiskConsequence,
  type RiskHazardRow,
  type RiskLikelihood,
  type RiskMatrixAnswer,
  type SignatureAnswer,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { uploadReportPhoto } from "../lib/uploads";
import { buildReportPdfBlob } from "../lib/report-pdf";
import { triggerImmediateDispatch } from "../lib/dispatch-now";
import { ThemedSelectField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedBadge } from "../components/theme/ThemedBadge";
import { SignaturePad } from "../components/reports/SignaturePad";

const BUCKET = "report-files";

async function fetchInstance(id: string): Promise<ReportInstance> {
  const { data, error } = await supabase.from("report_instances").select("*").eq("id", id).single();
  if (error) throw error;
  return data as ReportInstance;
}
async function fetchTemplate(id: string): Promise<ReportTemplate> {
  const { data, error } = await supabase.from("report_templates").select("*").eq("id", id).single();
  if (error) throw error;
  return data as ReportTemplate;
}
async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}
async function fetchSignatures(instanceId: string): Promise<ReportSignature[]> {
  const { data, error } = await supabase.from("report_signatures").select("*").eq("report_instance_id", instanceId).order("signed_at");
  if (error) throw error;
  return data as ReportSignature[];
}
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

// Best-effort GPS capture (Workflow 1's geo_location) - never blocks
// completing a report: a technician working inside a building/basement
// with no fix, or a browser with location permission denied, still needs
// to be able to finish and submit the form. Resolves null rather than
// rejecting on any failure or timeout.
function tryGetLocation(): Promise<{ lat: number; lng: number; captured_at: string } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, captured_at: new Date().toISOString() }),
      () => resolve(null),
      { timeout: 5000 }
    );
  });
}

// Report status (draft/completed/archived) is a workflow state, so like
// the rest of the app it derives from the active theme's tokens - see
// RISK_RATING_COLORS/PASS_FAIL_COLORS below for the WHS safety signals
// that deliberately do NOT do this.
const STATUS_COLORS: Record<ReportInstanceStatus, string> = {
  draft: "var(--jms-warning)",
  completed: "var(--jms-accent)",
  archived: "var(--jms-text-muted)",
};

const RISK_LEVELS: RiskLikelihood[] = [1, 2, 3, 4, 5];

// Fixed hex, not accent-derived - a WHS risk rating has to read the same
// green/amber/orange/red regardless of which CRT accent colour the tenant
// has picked, same reasoning as PASS_FAIL_COLORS below.
const RISK_RATING_COLORS: Record<string, string> = {
  low: "#4ade80",
  medium: "#fbbf24",
  high: "#fb923c",
  extreme: "#f87171",
};

// Fixed hex, not accent-derived - a pass/fail safety result must stay
// legible and unambiguous no matter which accent colour is active (an
// amber accent tenant must never see "pass" rendered as amber).
const PASS_FAIL_COLORS: Record<"pass" | "fail" | "na", string> = {
  pass: "#4ade80",
  fail: "#f87171",
  na: "#94a3b8",
};
// Dark text sits on top of the bright fixed fill colours above - matches
// the base CRT background so it reads on every accent preset.
const PASS_FAIL_TEXT = "#0a0f0a";

export default function ReportInstancePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: instance } = useQuery({ queryKey: ["report-instance", id], queryFn: () => fetchInstance(id!), enabled: !!id });
  const { data: template } = useQuery({
    queryKey: ["report-template", instance?.template_id],
    queryFn: () => fetchTemplate(instance!.template_id),
    enabled: !!instance,
  });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: signatures } = useQuery({
    queryKey: ["report-signatures", id],
    queryFn: () => fetchSignatures(id!),
    enabled: !!id,
  });
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: fetchJobs });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });

  const isDraft = instance?.status === "draft";

  const [formData, setFormData] = useState<ReportFormData>({});
  const [jobCardId, setJobCardId] = useState("");
  const [clientId, setClientId] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    if (instance && template) {
      const merged: ReportFormData = { ...instance.form_data };
      for (const section of template.structure_schema) {
        for (const field of section.fields) {
          if (!merged[field.id]) merged[field.id] = blankAnswerFor(field.type);
        }
      }
      setFormData(merged);
      setJobCardId(instance.job_card_id ?? "");
      setClientId(instance.client_id ?? "");
    }
  }, [instance, template]);

  const clientById = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c])), [clients]);
  const jobById = useMemo(() => new Map((jobs ?? []).map((j) => [j.id, j])), [jobs]);

  const updateAnswer = (fieldId: string, patch: Partial<ReportAnswer>) => {
    setFormData((prev) => ({ ...prev, [fieldId]: { ...prev[fieldId], ...patch } as ReportAnswer }));
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["report-instance", id] });
    queryClient.invalidateQueries({ queryKey: ["report-instances"] });
  };

  const saveDraft = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("report_instances")
        .update({ form_data: formData, job_card_id: jobCardId || null, client_id: clientId || null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const complete = useMutation({
    mutationFn: async () => {
      if (!template || !instance || !tenant) throw new Error("Not loaded yet");

      const missing = template.structure_schema
        .flatMap((s) => s.fields)
        .filter((f) => f.required && !isAnswered(formData[f.id]));
      const firstMissing = missing[0];
      if (firstMissing) throw new Error(`Answer required field: "${firstMissing.label}"`);

      const geo = await tryGetLocation();

      const { error: updateError } = await supabase
        .from("report_instances")
        .update({ form_data: formData, job_card_id: jobCardId || null, client_id: clientId || null, geo_location: geo })
        .eq("id", id);
      if (updateError) throw updateError;

      const currentSignatures = signatures ?? [];
      const pdfBlob = await buildReportPdfBlob({
        tenant,
        template,
        instance: { ...instance, form_data: formData, geo_location: geo, completed_at: new Date().toISOString() },
        signatures: currentSignatures,
        bucket: BUCKET,
      });

      const pdfPath = `${tenant.id}/${instance.id}/report.pdf`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(pdfPath, pdfBlob, {
        contentType: "application/pdf",
        upsert: true,
      });
      if (uploadError) throw uploadError;

      const { error: completeError2 } = await supabase
        .from("report_instances")
        .update({ status: "completed", completed_at: new Date().toISOString(), pdf_storage_path: pdfPath })
        .eq("id", id);
      if (completeError2) throw completeError2;
    },
    onSuccess: () => {
      invalidate();
      setCompleteError(null);
    },
    onError: (e) => setCompleteError(getErrorMessage(e, "Failed to complete report")),
  });

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const downloadPdf = async () => {
    if (!instance?.pdf_storage_path) return;
    setPdfBusy(true);
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(instance.pdf_storage_path, 3600);
    setPdfBusy(false);
    if (data?.signedUrl) {
      setDownloadUrl(data.signedUrl);
      window.open(data.signedUrl, "_blank");
    }
  };

  const sendEmail = useMutation({
    mutationFn: async () => {
      if (!instance || !profile || !template) throw new Error("Not signed in");
      const resolvedClientId = instance.client_id ?? (instance.job_card_id ? jobById.get(instance.job_card_id)?.client_id : null);
      const client = resolvedClientId ? clientById.get(resolvedClientId) : null;
      if (!client?.email) throw new Error("No client on file with an email address for this report.");
      if (!instance.pdf_storage_path) throw new Error("This report has no PDF yet - complete it first.");

      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "report_sent")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Report Delivery' email is turned off in Settings > Automation & Messaging");
      }
      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "report_sent")
        .eq("is_active", true);
      const emailTemplate = (templates ?? []).find((t) => rule.channel === "both" || rule.channel === t.type);
      if (!emailTemplate) throw new Error("No active 'Report Delivery' email template found");

      const { data: row, error: insertError } = await supabase
        .from("scheduled_communications")
        .insert({
          tenant_id: profile.tenant_id,
          entity_type: "report",
          entity_id: instance.id,
          trigger_key: "report_sent",
          template_id: emailTemplate.id,
          channel: emailTemplate.type,
          recipient_phone_or_email: client.email,
          rendered_subject: emailTemplate.subject,
          rendered_body: emailTemplate.body,
          scheduled_for: new Date().toISOString(),
          status: "pending",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      return await triggerImmediateDispatch(row.id);
    },
    onSuccess: (wasSent) => {
      setSendError(null);
      setSendResult(wasSent ? "The report email has been sent." : "The report is queued and will be sent shortly.");
      setTimeout(() => setSendResult(null), 5000);
    },
    onError: (e) => setSendError(getErrorMessage(e, "Failed to send")),
  });

  // --- SWMS worker sign-off roster ---
  const [signerName, setSignerName] = useState("");
  const [signerRole, setSignerRole] = useState<ReportSignerRole>("technician");
  const [signerSvg, setSignerSvg] = useState("");
  const [signatureError, setSignatureError] = useState<string | null>(null);

  const addSignature = useMutation({
    mutationFn: async () => {
      const result = createReportSignatureSchema.safeParse({
        report_instance_id: id,
        signer_name: signerName,
        signer_role: signerRole,
        signature_svg_data: signerSvg,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid signature");
      const { error } = await supabase.from("report_signatures").insert({ tenant_id: profile!.tenant_id, ...result.data });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-signatures", id] });
      setSignerName("");
      setSignerSvg("");
      setSignatureError(null);
    },
    onError: (e) => setSignatureError(getErrorMessage(e, "Failed to add signature")),
  });

  if (!instance || !template) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)", fontFamily: "var(--jms-font)" }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/reports" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Forms & Certificates
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-title)" }}>
            {template.title}
          </h1>
          {template.description ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>{template.description}</p>
          ) : null}
        </div>
        <ThemedBadge label={instance.status.charAt(0).toUpperCase() + instance.status.slice(1)} color={STATUS_COLORS[instance.status]} />
      </div>

      {!instance.job_card_id ? (
        <div className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-warning)", backgroundColor: "var(--jms-bg)" }}>
          <p className="mb-2 font-semibold" style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>
            Unlinked standalone report
          </p>
          <ThemedSelectField
            label="Link to Job (optional)"
            value={jobCardId}
            onChange={(v) => {
              setJobCardId(v);
              const job = jobById.get(v);
              if (job) setClientId(job.client_id);
            }}
            options={(jobs ?? []).map((j) => ({ value: j.id, label: `${j.number ?? "Pending"} - ${j.title}` }))}
            placeholder="Search by job number or title"
          />
          {!jobCardId ? (
            <ThemedSelectField
              label="Client (optional)"
              value={clientId}
              onChange={setClientId}
              options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Select client"
            />
          ) : null}
          {isDraft && (jobCardId !== (instance.job_card_id ?? "") || clientId !== (instance.client_id ?? "")) ? (
            <button onClick={() => saveDraft.mutate()} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
              Save link
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Linked to job{" "}
          <Link to={`/jobs/${instance.job_card_id}`} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
            {jobById.get(instance.job_card_id)?.number ?? jobById.get(instance.job_card_id)?.title ?? instance.job_card_id}
          </Link>
        </p>
      )}

      <div className="space-y-6">
        {template.structure_schema.map((section) => (
          <div key={section.id} className="rounded p-5" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <h2 className="mb-4 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {section.title}
            </h2>
            <div className="space-y-5">
              {section.fields.map((field) => {
                const answer = formData[field.id];
                return (
                  <div key={field.id}>
                    <label className="mb-1 block font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {field.label}
                      {field.required ? <span style={{ color: "var(--jms-danger)" }}> *</span> : null}
                    </label>
                    {field.helpText ? (
                      <p className="mb-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                        {field.helpText}
                      </p>
                    ) : null}

                    {field.type === "pass_fail" ? (
                      <div>
                        <div className="flex gap-2">
                          {(["pass", "fail", "na"] as const).map((v) => {
                            const selected = (answer as PassFailAnswer)?.value === v;
                            return (
                              <button
                                key={v}
                                disabled={!isDraft}
                                onClick={() => updateAnswer(field.id, { type: "pass_fail", value: v } as PassFailAnswer)}
                                className="rounded px-4 py-2 font-semibold disabled:opacity-70"
                                style={
                                  selected
                                    ? { backgroundColor: PASS_FAIL_COLORS[v], color: PASS_FAIL_TEXT, fontSize: "var(--jms-font-body)" }
                                    : { backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                                }
                              >
                                {v.toUpperCase()}
                              </button>
                            );
                          })}
                        </div>
                        {field.requireActionOnFail && (answer as PassFailAnswer)?.value === "fail" ? (
                          <div className="mt-3 rounded p-3" style={{ backgroundColor: "var(--jms-bg)", border: `1px solid ${PASS_FAIL_COLORS.fail}` }}>
                            <p className="mb-2 font-semibold" style={{ color: PASS_FAIL_COLORS.fail, fontSize: "var(--jms-font-label)" }}>
                              Action required
                            </p>
                            <textarea
                              disabled={!isDraft}
                              value={(answer as PassFailAnswer)?.actionNote ?? ""}
                              onChange={(e) => updateAnswer(field.id, { actionNote: e.target.value } as Partial<PassFailAnswer>)}
                              placeholder="What needs to be done?"
                              rows={2}
                              className="mb-2 w-full rounded px-3 py-2 focus:outline-none"
                              style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                            />
                            <PhotoField
                              disabled={!isDraft}
                              paths={(answer as PassFailAnswer)?.actionPhotoPaths ?? []}
                              onChange={(paths) => updateAnswer(field.id, { actionPhotoPaths: paths } as Partial<PassFailAnswer>)}
                              instanceId={instance.id}
                              tenantId={profile!.tenant_id}
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : field.type === "risk_matrix" ? (
                      <RiskMatrixField
                        disabled={!isDraft}
                        answer={answer as RiskMatrixAnswer}
                        onChange={(rows) => updateAnswer(field.id, { type: "risk_matrix", rows } as RiskMatrixAnswer)}
                      />
                    ) : field.type === "photo" ? (
                      <PhotoField
                        disabled={!isDraft}
                        paths={(answer as PhotoAnswer)?.photoPaths ?? []}
                        onChange={(paths) => updateAnswer(field.id, { type: "photo", photoPaths: paths } as PhotoAnswer)}
                        instanceId={instance.id}
                        tenantId={profile!.tenant_id}
                      />
                    ) : field.type === "text" ? (
                      <input
                        disabled={!isDraft}
                        value={(answer as { value: string })?.value ?? ""}
                        onChange={(e) => updateAnswer(field.id, { type: "text", value: e.target.value } as ReportAnswer)}
                        className="w-full rounded px-3 py-2 focus:outline-none"
                        style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                      />
                    ) : field.type === "long_text" ? (
                      <textarea
                        disabled={!isDraft}
                        value={(answer as { value: string })?.value ?? ""}
                        onChange={(e) => updateAnswer(field.id, { type: "long_text", value: e.target.value } as ReportAnswer)}
                        rows={3}
                        className="w-full rounded px-3 py-2 focus:outline-none"
                        style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                      />
                    ) : field.type === "meter_reading" ? (
                      <input
                        disabled={!isDraft}
                        value={(answer as { value: string })?.value ?? ""}
                        onChange={(e) => updateAnswer(field.id, { type: "meter_reading", value: e.target.value } as ReportAnswer)}
                        placeholder="e.g. 1234.5"
                        className="w-48 rounded px-3 py-2 focus:outline-none"
                        style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                      />
                    ) : field.type === "signature" ? (
                      <div>
                        <input
                          disabled={!isDraft}
                          value={(answer as SignatureAnswer)?.signerName ?? ""}
                          onChange={(e) => updateAnswer(field.id, { signerName: e.target.value } as Partial<SignatureAnswer>)}
                          placeholder="Signer name"
                          className="mb-2 w-full rounded px-3 py-2 focus:outline-none"
                          style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                        />
                        {isDraft ? (
                          <SignaturePad
                            value={(answer as SignatureAnswer)?.svgData ?? ""}
                            onChange={(dataUrl) => updateAnswer(field.id, { svgData: dataUrl } as Partial<SignatureAnswer>)}
                          />
                        ) : (answer as SignatureAnswer)?.svgData ? (
                          <img
                            src={(answer as SignatureAnswer).svgData}
                            alt="Signature"
                            className="h-24 rounded bg-white"
                            style={{ border: "1px solid var(--jms-border)" }}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {template.is_swms ? (
          <div className="rounded p-5" style={{ border: "1px solid var(--jms-warning)", backgroundColor: "var(--jms-bg)" }}>
            <h2 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}>
              Worker Sign-Off Roster
            </h2>
            <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Every worker on site signs individually before this SWMS is complete.
            </p>

            {(signatures ?? []).length > 0 ? (
              <div className="mb-4 space-y-2">
                {(signatures ?? []).map((sig) => (
                  <div key={sig.id} className="flex items-center justify-between rounded p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
                    <div>
                      <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                        {sig.signer_name}
                      </p>
                      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                        {sig.signer_role.replace("_", " ")} - signed {new Date(sig.signed_at).toLocaleString("en-AU")}
                      </p>
                    </div>
                    <img src={sig.signature_svg_data} alt="Signature" className="h-10" />
                  </div>
                ))}
              </div>
            ) : null}

            {isDraft ? (
              <div className="rounded p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <input
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    placeholder="Worker name"
                    className="rounded px-3 py-2 focus:outline-none"
                    style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                  />
                  <select
                    value={signerRole}
                    onChange={(e) => setSignerRole(e.target.value as ReportSignerRole)}
                    className="rounded px-3 py-2"
                    style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                  >
                    <option value="technician">Technician</option>
                    <option value="sub_contractor">Sub-contractor</option>
                    <option value="site_supervisor">Site supervisor</option>
                    <option value="client">Client</option>
                  </select>
                </div>
                <SignaturePad value={signerSvg} onChange={setSignerSvg} />
                {signatureError ? (
                  <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                    {signatureError}
                  </p>
                ) : null}
                <div className="mt-2">
                  <ThemedButton onClick={() => addSignature.mutate()} disabled={addSignature.isPending || !signerName || !signerSvg}>
                    {addSignature.isPending ? "Adding..." : "+ Add worker sign-off"}
                  </ThemedButton>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {isDraft ? (
        <div className="mt-6 space-y-2">
          {saveError ? (
            <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{saveError}</p>
          ) : null}
          {saved ? <p style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>Draft saved.</p> : null}
          {completeError ? (
            <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{completeError}</p>
          ) : null}
          <div className="flex gap-3">
            <ThemedButton variant="secondary" onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending} style={{ paddingBlock: 12, paddingInline: 24 }}>
              {saveDraft.isPending ? "Saving..." : "Save draft"}
            </ThemedButton>
            <ThemedButton onClick={() => complete.mutate()} disabled={complete.isPending} style={{ paddingBlock: 12, paddingInline: 24 }}>
              {complete.isPending ? "Completing & generating PDF..." : "Complete report"}
            </ThemedButton>
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {sendError ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{sendError}</p> : null}
          {sendResult ? <p style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{sendResult}</p> : null}
          <div className="flex flex-wrap gap-3">
            <ThemedButton onClick={downloadPdf} disabled={pdfBusy || !instance.pdf_storage_path} style={{ paddingBlock: 12, paddingInline: 24 }}>
              {pdfBusy ? "Preparing..." : "Download PDF"}
            </ThemedButton>
            <ThemedButton variant="secondary" onClick={() => sendEmail.mutate()} disabled={sendEmail.isPending} style={{ paddingBlock: 12, paddingInline: 24 }}>
              {sendEmail.isPending ? "Sending..." : "Send via Email"}
            </ThemedButton>
          </div>
          {downloadUrl ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              If the download didn't open,{" "}
              <a href={downloadUrl} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                click here
              </a>
              .
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PhotoField({
  paths,
  onChange,
  instanceId,
  tenantId,
  disabled,
}: {
  paths: string[];
  onChange: (paths: string[]) => void;
  instanceId: string;
  tenantId: string;
  disabled: boolean;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        paths.map(async (p) => {
          const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 3600);
          return [p, data?.signedUrl ?? ""] as const;
        })
      );
      if (!cancelled) setUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [paths]);

  const handleFiles = async (fileList: FileList) => {
    setUploading(true);
    setError(null);
    try {
      const newPaths: string[] = [];
      for (const file of Array.from(fileList)) {
        newPaths.push(await uploadReportPhoto({ tenantId, reportInstanceId: instanceId, file }));
      }
      onChange([...paths, ...newPaths]);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to upload photo"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      {paths.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {paths.map((p) => (
            <div key={p} className="relative">
              {urls[p] ? (
                <img src={urls[p]} alt="" className="h-20 w-20 rounded object-cover" style={{ border: "1px solid var(--jms-border)" }} />
              ) : null}
              {!disabled ? (
                <button
                  onClick={() => onChange(paths.filter((x) => x !== p))}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full text-xs"
                  style={{ backgroundColor: "var(--jms-danger)", color: PASS_FAIL_TEXT }}
                >
                  &times;
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!disabled ? (
        <label className="inline-block cursor-pointer rounded px-3 py-1.5 font-semibold" style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
          {uploading ? "Uploading..." : "+ Add photo(s)"}
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      ) : null}
      {error ? (
        <p className="mt-1" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function newHazardRow(): RiskHazardRow {
  return { id: crypto.randomUUID(), hazard: "", likelihood: 1, consequence: 1, rating: calculateRiskRating(1, 1), controlMeasures: "" };
}

// A hazard register, not a single likelihood/consequence pick - matches the
// real WHS Form 04 (Site Specific Risk Assessment) / Form 05 (SWMS) tables
// this is modelled on: one row per hazard identified, its risk rating, and
// the control measure put in place for it. See reports.ts's own comment on
// RiskMatrixAnswer for why this replaced the old single-pick shape.
function RiskMatrixField({
  answer,
  onChange,
  disabled,
}: {
  answer: RiskMatrixAnswer | undefined;
  onChange: (rows: RiskHazardRow[]) => void;
  disabled: boolean;
}) {
  const rows = answer?.rows ?? [];

  const updateRow = (rowId: string, patch: Partial<RiskHazardRow>) =>
    onChange(
      rows.map((row) => {
        if (row.id !== rowId) return row;
        const next = { ...row, ...patch };
        return { ...next, rating: calculateRiskRating(next.likelihood, next.consequence) };
      })
    );
  const removeRow = (rowId: string) => onChange(rows.filter((row) => row.id !== rowId));
  const addRow = () => onChange([...rows, newHazardRow()]);

  return (
    <div>
      {rows.length === 0 ? (
        <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No hazards recorded yet.
        </p>
      ) : null}
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={row.id} className="rounded p-3" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Hazard #{index + 1}
              </span>
              {!disabled ? (
                <button onClick={() => removeRow(row.id)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                  Remove
                </button>
              ) : null}
            </div>
            <textarea
              disabled={disabled}
              value={row.hazard}
              onChange={(e) => updateRow(row.id, { hazard: e.target.value })}
              placeholder="Hazard identified (e.g. fall from roof edge)"
              rows={2}
              className="mb-2 w-full rounded px-3 py-2 focus:outline-none"
              style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
            />
            <div className="mb-2 grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  Likelihood
                </p>
                <select
                  disabled={disabled}
                  value={row.likelihood}
                  onChange={(e) => updateRow(row.id, { likelihood: Number(e.target.value) as RiskLikelihood })}
                  className="w-full rounded px-3 py-2"
                  style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                >
                  {RISK_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {RISK_LIKELIHOOD_LABELS[l]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className="mb-1 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  Consequence
                </p>
                <select
                  disabled={disabled}
                  value={row.consequence}
                  onChange={(e) => updateRow(row.id, { consequence: Number(e.target.value) as RiskConsequence })}
                  className="w-full rounded px-3 py-2"
                  style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
                >
                  {RISK_LEVELS.map((c) => (
                    <option key={c} value={c}>
                      {RISK_CONSEQUENCE_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <span className="mb-2 inline-block">
              <ThemedBadge label={`${RISK_RATING_LABELS[row.rating]} risk`} color={RISK_RATING_COLORS[row.rating]} />
            </span>
            <textarea
              disabled={disabled}
              value={row.controlMeasures}
              onChange={(e) => updateRow(row.id, { controlMeasures: e.target.value })}
              placeholder="Control measures - what will be done to control this risk?"
              rows={2}
              className="mt-2 w-full rounded px-3 py-2 focus:outline-none"
              style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}
            />
          </div>
        ))}
      </div>
      {!disabled ? (
        <button
          onClick={addRow}
          className="mt-2 rounded px-3 py-1.5 font-semibold"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
        >
          + Add hazard
        </button>
      ) : null}
    </div>
  );
}
