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
  type ReportSignature,
  type ReportSignerRole,
  type ReportTemplate,
  type RiskConsequence,
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
import { SelectField } from "../components/FormField";
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

const RISK_LEVELS: RiskLikelihood[] = [1, 2, 3, 4, 5];
const RISK_RATING_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-800",
  medium: "bg-yellow-100 text-yellow-800",
  high: "bg-orange-100 text-orange-800",
  extreme: "bg-red-100 text-red-800",
};

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
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to="/reports" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Reports
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{template.title}</h1>
          {template.description ? <p className="text-sm text-gray-500">{template.description}</p> : null}
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            instance.status === "draft" ? "bg-amber-100 text-amber-800" : instance.status === "completed" ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
          }`}
        >
          {instance.status.charAt(0).toUpperCase() + instance.status.slice(1)}
        </span>
      </div>

      {!instance.job_card_id ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-sm font-semibold text-amber-800">Unlinked standalone report</p>
          <SelectField
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
            <SelectField
              label="Client (optional)"
              value={clientId}
              onChange={setClientId}
              options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Select client"
            />
          ) : null}
          {isDraft && (jobCardId !== (instance.job_card_id ?? "") || clientId !== (instance.client_id ?? "")) ? (
            <button onClick={() => saveDraft.mutate()} className="text-xs font-semibold text-blue-700 hover:underline">
              Save link
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mb-4 text-sm text-gray-500">
          Linked to job{" "}
          <Link to={`/jobs/${instance.job_card_id}`} className="font-semibold text-blue-700 hover:underline">
            {jobById.get(instance.job_card_id)?.number ?? jobById.get(instance.job_card_id)?.title ?? instance.job_card_id}
          </Link>
        </p>
      )}

      <div className="space-y-6">
        {template.structure_schema.map((section) => (
          <div key={section.id} className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-gray-500">{section.title}</h2>
            <div className="space-y-5">
              {section.fields.map((field) => {
                const answer = formData[field.id];
                return (
                  <div key={field.id}>
                    <label className="mb-1 block text-sm font-semibold text-gray-800">
                      {field.label}
                      {field.required ? <span className="text-red-600"> *</span> : null}
                    </label>
                    {field.helpText ? <p className="mb-1 text-xs text-gray-400">{field.helpText}</p> : null}

                    {field.type === "pass_fail" ? (
                      <div>
                        <div className="flex gap-2">
                          {(["pass", "fail", "na"] as const).map((v) => (
                            <button
                              key={v}
                              disabled={!isDraft}
                              onClick={() => updateAnswer(field.id, { type: "pass_fail", value: v } as PassFailAnswer)}
                              className={`rounded-md px-4 py-2 text-sm font-semibold ${
                                (answer as PassFailAnswer)?.value === v
                                  ? v === "pass"
                                    ? "bg-green-600 text-white"
                                    : v === "fail"
                                      ? "bg-red-600 text-white"
                                      : "bg-gray-500 text-white"
                                  : "bg-gray-100 text-gray-600"
                              } disabled:opacity-70`}
                            >
                              {v.toUpperCase()}
                            </button>
                          ))}
                        </div>
                        {field.requireActionOnFail && (answer as PassFailAnswer)?.value === "fail" ? (
                          <div className="mt-3 rounded-md bg-red-50 p-3">
                            <p className="mb-2 text-xs font-semibold text-red-800">Action required</p>
                            <textarea
                              disabled={!isDraft}
                              value={(answer as PassFailAnswer)?.actionNote ?? ""}
                              onChange={(e) => updateAnswer(field.id, { actionNote: e.target.value } as Partial<PassFailAnswer>)}
                              placeholder="What needs to be done?"
                              rows={2}
                              className="mb-2 w-full rounded-md border border-red-200 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
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
                        onChange={(likelihood, consequence) =>
                          updateAnswer(field.id, {
                            type: "risk_matrix",
                            likelihood,
                            consequence,
                            rating: calculateRiskRating(likelihood, consequence),
                          } as RiskMatrixAnswer)
                        }
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
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50"
                      />
                    ) : field.type === "long_text" ? (
                      <textarea
                        disabled={!isDraft}
                        value={(answer as { value: string })?.value ?? ""}
                        onChange={(e) => updateAnswer(field.id, { type: "long_text", value: e.target.value } as ReportAnswer)}
                        rows={3}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50"
                      />
                    ) : field.type === "meter_reading" ? (
                      <input
                        disabled={!isDraft}
                        value={(answer as { value: string })?.value ?? ""}
                        onChange={(e) => updateAnswer(field.id, { type: "meter_reading", value: e.target.value } as ReportAnswer)}
                        placeholder="e.g. 1234.5"
                        className="w-48 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50"
                      />
                    ) : field.type === "signature" ? (
                      <div>
                        <input
                          disabled={!isDraft}
                          value={(answer as SignatureAnswer)?.signerName ?? ""}
                          onChange={(e) => updateAnswer(field.id, { signerName: e.target.value } as Partial<SignatureAnswer>)}
                          placeholder="Signer name"
                          className="mb-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50"
                        />
                        {isDraft ? (
                          <SignaturePad
                            value={(answer as SignatureAnswer)?.svgData ?? ""}
                            onChange={(dataUrl) => updateAnswer(field.id, { svgData: dataUrl } as Partial<SignatureAnswer>)}
                          />
                        ) : (answer as SignatureAnswer)?.svgData ? (
                          <img src={(answer as SignatureAnswer).svgData} alt="Signature" className="h-24 rounded-md border border-gray-200 bg-white" />
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
          <div className="rounded-lg border border-orange-200 bg-orange-50 p-5">
            <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-orange-800">Worker Sign-Off Roster</h2>
            <p className="mb-4 text-xs text-orange-700">Every worker on site signs individually before this SWMS is complete.</p>

            {(signatures ?? []).length > 0 ? (
              <div className="mb-4 space-y-2">
                {(signatures ?? []).map((sig) => (
                  <div key={sig.id} className="flex items-center justify-between rounded-md bg-white p-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{sig.signer_name}</p>
                      <p className="text-xs text-gray-500">
                        {sig.signer_role.replace("_", " ")} - signed {new Date(sig.signed_at).toLocaleString("en-AU")}
                      </p>
                    </div>
                    <img src={sig.signature_svg_data} alt="Signature" className="h-10" />
                  </div>
                ))}
              </div>
            ) : null}

            {isDraft ? (
              <div className="rounded-md bg-white p-3">
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <input
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    placeholder="Worker name"
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <select
                    value={signerRole}
                    onChange={(e) => setSignerRole(e.target.value as ReportSignerRole)}
                    className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="technician">Technician</option>
                    <option value="sub_contractor">Sub-contractor</option>
                    <option value="site_supervisor">Site supervisor</option>
                    <option value="client">Client</option>
                  </select>
                </div>
                <SignaturePad value={signerSvg} onChange={setSignerSvg} />
                {signatureError ? <p className="mt-2 text-sm text-red-600">{signatureError}</p> : null}
                <button
                  onClick={() => addSignature.mutate()}
                  disabled={addSignature.isPending || !signerName || !signerSvg}
                  className="mt-2 rounded-md bg-orange-700 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-800 disabled:opacity-60"
                >
                  {addSignature.isPending ? "Adding..." : "+ Add worker sign-off"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {isDraft ? (
        <div className="mt-6 space-y-2">
          {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}
          {saved ? <p className="text-sm text-green-700">Draft saved.</p> : null}
          {completeError ? <p className="text-sm text-red-600">{completeError}</p> : null}
          <div className="flex gap-3">
            <button
              onClick={() => saveDraft.mutate()}
              disabled={saveDraft.isPending}
              className="rounded-md border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {saveDraft.isPending ? "Saving..." : "Save draft"}
            </button>
            <button
              onClick={() => complete.mutate()}
              disabled={complete.isPending}
              className="rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {complete.isPending ? "Completing & generating PDF..." : "Complete report"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {sendError ? <p className="text-sm text-red-600">{sendError}</p> : null}
          {sendResult ? <p className="text-sm text-green-700">{sendResult}</p> : null}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={downloadPdf}
              disabled={pdfBusy || !instance.pdf_storage_path}
              className="rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {pdfBusy ? "Preparing..." : "Download PDF"}
            </button>
            <button
              onClick={() => sendEmail.mutate()}
              disabled={sendEmail.isPending}
              className="rounded-md border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {sendEmail.isPending ? "Sending..." : "Send via Email"}
            </button>
          </div>
          {downloadUrl ? (
            <p className="text-xs text-gray-400">
              If the download didn't open,{" "}
              <a href={downloadUrl} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
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
              {urls[p] ? <img src={urls[p]} alt="" className="h-20 w-20 rounded-md border border-gray-200 object-cover" /> : null}
              {!disabled ? (
                <button
                  onClick={() => onChange(paths.filter((x) => x !== p))}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs text-white"
                >
                  &times;
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!disabled ? (
        <label className="inline-block cursor-pointer rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50">
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
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

function RiskMatrixField({
  answer,
  onChange,
  disabled,
}: {
  answer: RiskMatrixAnswer | undefined;
  onChange: (likelihood: RiskLikelihood, consequence: RiskConsequence) => void;
  disabled: boolean;
}) {
  const likelihood = answer?.likelihood ?? 1;
  const consequence = answer?.consequence ?? 1;
  const rating = answer?.rating ?? calculateRiskRating(likelihood, consequence);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold text-gray-500">Likelihood</p>
          <select
            disabled={disabled}
            value={likelihood}
            onChange={(e) => onChange(Number(e.target.value) as RiskLikelihood, consequence)}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-50"
          >
            {RISK_LEVELS.map((l) => (
              <option key={l} value={l}>
                {RISK_LIKELIHOOD_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-gray-500">Consequence</p>
          <select
            disabled={disabled}
            value={consequence}
            onChange={(e) => onChange(likelihood, Number(e.target.value) as RiskConsequence)}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-50"
          >
            {RISK_LEVELS.map((c) => (
              <option key={c} value={c}>
                {RISK_CONSEQUENCE_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <span className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold ${RISK_RATING_COLORS[rating]}`}>
        {RISK_RATING_LABELS[rating]} risk
      </span>
    </div>
  );
}
