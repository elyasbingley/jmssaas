import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { v4 as uuidv4 } from "uuid";
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
  type ReportGeoLocation,
  type ReportInstance,
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
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useAuth } from "../../../lib/auth-context";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { triggerImmediateDispatch } from "../../../lib/dispatch-now";
import { buildPdfDataUri } from "../../../lib/print";
import { buildReportPdfHtml, uploadReportPhoto } from "../../../lib/report-pdf";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { PickerModal } from "../../../components/PickerModal";
import { SignaturePad } from "../../../components/SignaturePad";

const BUCKET = "report-files";
const RISK_LEVELS: RiskLikelihood[] = [1, 2, 3, 4, 5];
const RISK_RATING_COLORS: Record<string, { bg: string; text: string }> = {
  low: { bg: "#dcfce7", text: "#166534" },
  medium: { bg: "#fef9c3", text: "#854d0e" },
  high: { bg: "#ffedd5", text: "#9a3412" },
  extreme: { bg: "#fee2e2", text: "#991b1b" },
};

// Best-effort GPS capture, mirrors desktop's tryGetLocation - never blocks
// completing a report (a tech inside a building with no fix, or location
// permission denied, still needs to finish and submit).
async function tryGetLocation(): Promise<ReportGeoLocation | null> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const position = await Location.getCurrentPositionAsync({});
    return { lat: position.coords.latitude, lng: position.coords.longitude, captured_at: new Date().toISOString() };
  } catch {
    return null;
  }
}

function newHazardRow(): RiskHazardRow {
  return { id: uuidv4(), hazard: "", likelihood: 1, consequence: 1, rating: calculateRiskRating(1, 1), controlMeasures: "" };
}

export default function ReportInstanceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: instance, refetch: refetchInstance } = useSupabaseFetch<ReportInstance | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase.from("report_instances").select("*").eq("id", id).single();
    if (error) throw error;
    return data as ReportInstance;
  }, [isOnline, id]);

  const { data: template } = useSupabaseFetch<ReportTemplate | null>(async () => {
    if (!isOnline || !instance) return null;
    const { data, error } = await supabase.from("report_templates").select("*").eq("id", instance.template_id).single();
    if (error) throw error;
    return data as ReportTemplate;
  }, [isOnline, instance?.template_id]);

  const { data: tenant } = useSupabaseFetch<Tenant | null>(async () => {
    if (!isOnline || !profile) return null;
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [isOnline, profile?.tenant_id]);

  const { data: signatures, refetch: refetchSignatures } = useSupabaseFetch<ReportSignature[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_signatures").select("*").eq("report_instance_id", id).order("signed_at");
    if (error) throw error;
    return data as ReportSignature[];
  }, [isOnline, id]);

  const { data: jobs } = useSupabaseFetch<JobCard[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("job_cards").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data as JobCard[];
  }, [isOnline]);
  const { data: clients } = useSupabaseFetch<Client[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("clients").select("*").order("name");
    if (error) throw error;
    return data as Client[];
  }, [isOnline]);

  const isDraft = instance?.status === "draft";

  const [formData, setFormData] = useState<ReportFormData>({});
  const [jobCardId, setJobCardId] = useState("");
  const [clientId, setClientId] = useState("");
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);

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

  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

  const updateAnswer = (fieldId: string, patch: Partial<ReportAnswer>) => {
    setFormData((prev) => ({ ...prev, [fieldId]: { ...prev[fieldId], ...patch } as ReportAnswer }));
  };

  const saveDraft = async () => {
    setSaving(true);
    setSaveError(null);
    const { error } = await supabase
      .from("report_instances")
      .update({ form_data: formData, job_card_id: jobCardId || null, client_id: clientId || null })
      .eq("id", id);
    setSaving(false);
    if (error) {
      setSaveError(getErrorMessage(error, "Failed to save"));
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    refetchInstance();
  };

  const complete = async () => {
    if (!template || !instance || !tenant) return;
    const missing = template.structure_schema.flatMap((s) => s.fields).find((f) => f.required && !isAnswered(formData[f.id]));
    if (missing) {
      setCompleteError(`Answer required field: "${missing.label}"`);
      return;
    }
    setCompleting(true);
    setCompleteError(null);
    try {
      const geo = await tryGetLocation();

      const { error: updateError } = await supabase
        .from("report_instances")
        .update({ form_data: formData, job_card_id: jobCardId || null, client_id: clientId || null, geo_location: geo })
        .eq("id", id);
      if (updateError) throw updateError;

      const html = await buildReportPdfHtml({
        tenant,
        template,
        instance: { ...instance, form_data: formData, geo_location: geo, completed_at: new Date().toISOString() },
        signatures: signatures ?? [],
      });
      const dataUri = await buildPdfDataUri(html);
      const base64 = dataUri.split(",")[1] ?? "";
      const pdfPath = `${tenant.id}/${instance.id}/report.pdf`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(pdfPath, decodeBase64(base64), {
        contentType: "application/pdf",
        upsert: true,
      });
      if (uploadError) throw uploadError;

      const { error: completeError2 } = await supabase
        .from("report_instances")
        .update({ status: "completed", completed_at: new Date().toISOString(), pdf_storage_path: pdfPath })
        .eq("id", id);
      if (completeError2) throw completeError2;

      refetchInstance();
    } catch (e) {
      setCompleteError(getErrorMessage(e, "Failed to complete report"));
    } finally {
      setCompleting(false);
    }
  };

  const downloadPdf = async () => {
    if (!instance?.pdf_storage_path) return;
    setPdfBusy(true);
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(instance.pdf_storage_path, 3600);
    setPdfBusy(false);
    if (data?.signedUrl) {
      Linking.openURL(data.signedUrl).catch(() => Alert.alert("Couldn't open PDF"));
    }
  };

  const sendEmail = async () => {
    if (!instance || !profile || !template) return;
    setSendingEmail(true);
    setSendError(null);
    try {
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
      if (!rule || !rule.is_enabled) throw new Error("The 'Report Delivery' email is turned off in Settings > Automation & Messaging");
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

      const wasSent = await triggerImmediateDispatch(row.id);
      setSendResult(wasSent ? "The report email has been sent." : "The report is queued and will be sent shortly.");
      setTimeout(() => setSendResult(null), 5000);
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to send"));
    } finally {
      setSendingEmail(false);
    }
  };

  const saveLink = async () => {
    const { error } = await supabase
      .from("report_instances")
      .update({ job_card_id: jobCardId || null, client_id: clientId || null })
      .eq("id", id);
    if (!error) refetchInstance();
  };

  // --- SWMS worker sign-off roster ---
  const [signerName, setSignerName] = useState("");
  const [signerRole, setSignerRole] = useState<ReportSignerRole>("technician");
  const [signerRolePickerVisible, setSignerRolePickerVisible] = useState(false);
  const [signerSvg, setSignerSvg] = useState("");
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [addingSignature, setAddingSignature] = useState(false);

  const addSignature = async () => {
    const result = createReportSignatureSchema.safeParse({
      report_instance_id: id,
      signer_name: signerName,
      signer_role: signerRole,
      signature_svg_data: signerSvg,
    });
    if (!result.success) {
      setSignatureError(result.error.issues[0]?.message ?? "Invalid signature");
      return;
    }
    if (!profile) return;
    setAddingSignature(true);
    const { error } = await supabase.from("report_signatures").insert({ tenant_id: profile.tenant_id, ...result.data });
    setAddingSignature(false);
    if (error) {
      setSignatureError(getErrorMessage(error, "Failed to add signature"));
      return;
    }
    setSignerName("");
    setSignerSvg("");
    setSignatureError(null);
    refetchSignatures();
  };

  if (!isOnline) {
    return <RequiresConnectionNotice label="Reports" />;
  }

  if (!instance || !template) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={styles.headerRow}>
        <View style={styles.flex1}>
          <Text style={styles.heading}>{template.title}</Text>
          {template.description ? <Text style={styles.subheading}>{template.description}</Text> : null}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[instance.status].bg }]}>
          <Text style={[styles.statusBadgeText, { color: STATUS_COLORS[instance.status].text }]}>
            {instance.status.charAt(0).toUpperCase() + instance.status.slice(1)}
          </Text>
        </View>
      </View>

      {!instance.job_card_id ? (
        <View style={styles.unlinkedBanner}>
          <Text style={styles.unlinkedTitle}>Unlinked standalone report</Text>
          <Pressable
            style={styles.pickerField}
            onPress={() => setJobPickerVisible(true)}
          >
            <Text style={styles.pickerFieldLabel}>Link to Job (optional)</Text>
            <Text style={styles.pickerFieldValue}>
              {jobCardId ? `${jobById.get(jobCardId)?.number ?? "Pending"} - ${jobById.get(jobCardId)?.title ?? ""}` : "Select job"}
            </Text>
          </Pressable>
          {!jobCardId ? (
            <Pressable style={styles.pickerField} onPress={() => setClientPickerVisible(true)}>
              <Text style={styles.pickerFieldLabel}>Client (optional)</Text>
              <Text style={styles.pickerFieldValue}>{clientById.get(clientId)?.name ?? "Select client"}</Text>
            </Pressable>
          ) : null}
          {isDraft && (jobCardId !== (instance.job_card_id ?? "") || clientId !== (instance.client_id ?? "")) ? (
            <Pressable onPress={saveLink}>
              <Text style={styles.link}>Save link</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Text style={styles.linkedMeta}>
          Linked to job {jobById.get(instance.job_card_id)?.number ?? jobById.get(instance.job_card_id)?.title ?? instance.job_card_id}
        </Text>
      )}

      {template.structure_schema.map((section) => (
        <View key={section.id} style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.fields.map((field) => {
            const answer = formData[field.id];
            return (
              <View key={field.id} style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>
                  {field.label}
                  {field.required ? <Text style={styles.required}> *</Text> : null}
                </Text>
                {field.helpText ? <Text style={styles.helpText}>{field.helpText}</Text> : null}

                {field.type === "pass_fail" ? (
                  <View>
                    <View style={styles.passFailRow}>
                      {(["pass", "fail", "na"] as const).map((v) => {
                        const active = (answer as PassFailAnswer)?.value === v;
                        const bg = active ? (v === "pass" ? "#16a34a" : v === "fail" ? "#dc2626" : "#6b7280") : "#f3f4f6";
                        const color = active ? "#fff" : "#4b5563";
                        return (
                          <Pressable
                            key={v}
                            disabled={!isDraft}
                            style={[styles.passFailButton, { backgroundColor: bg }]}
                            onPress={() => updateAnswer(field.id, { type: "pass_fail", value: v } as PassFailAnswer)}
                          >
                            <Text style={{ color, fontWeight: "700" }}>{v.toUpperCase()}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {field.requireActionOnFail && (answer as PassFailAnswer)?.value === "fail" ? (
                      <View style={styles.actionRequired}>
                        <Text style={styles.actionRequiredLabel}>Action required</Text>
                        <TextInput
                          editable={isDraft}
                          value={(answer as PassFailAnswer)?.actionNote ?? ""}
                          onChangeText={(v) => updateAnswer(field.id, { actionNote: v } as Partial<PassFailAnswer>)}
                          placeholder="What needs to be done?"
                          multiline
                          style={styles.actionNoteInput}
                        />
                        <ReportPhotoField
                          disabled={!isDraft}
                          paths={(answer as PassFailAnswer)?.actionPhotoPaths ?? []}
                          onChange={(paths) => updateAnswer(field.id, { actionPhotoPaths: paths } as Partial<PassFailAnswer>)}
                          instanceId={instance.id}
                          tenantId={profile!.tenant_id}
                        />
                      </View>
                    ) : null}
                  </View>
                ) : field.type === "risk_matrix" ? (
                  <RiskMatrixField
                    disabled={!isDraft}
                    answer={answer as RiskMatrixAnswer}
                    onChange={(rows) => updateAnswer(field.id, { type: "risk_matrix", rows } as RiskMatrixAnswer)}
                  />
                ) : field.type === "photo" ? (
                  <ReportPhotoField
                    disabled={!isDraft}
                    paths={(answer as PhotoAnswer)?.photoPaths ?? []}
                    onChange={(paths) => updateAnswer(field.id, { type: "photo", photoPaths: paths } as PhotoAnswer)}
                    instanceId={instance.id}
                    tenantId={profile!.tenant_id}
                  />
                ) : field.type === "text" ? (
                  <TextInput
                    editable={isDraft}
                    value={(answer as { value: string })?.value ?? ""}
                    onChangeText={(v) => updateAnswer(field.id, { type: "text", value: v } as ReportAnswer)}
                    style={styles.textInput}
                  />
                ) : field.type === "long_text" ? (
                  <TextInput
                    editable={isDraft}
                    value={(answer as { value: string })?.value ?? ""}
                    onChangeText={(v) => updateAnswer(field.id, { type: "long_text", value: v } as ReportAnswer)}
                    multiline
                    style={[styles.textInput, styles.multiline]}
                  />
                ) : field.type === "meter_reading" ? (
                  <TextInput
                    editable={isDraft}
                    value={(answer as { value: string })?.value ?? ""}
                    onChangeText={(v) => updateAnswer(field.id, { type: "meter_reading", value: v } as ReportAnswer)}
                    placeholder="e.g. 1234.5"
                    keyboardType="decimal-pad"
                    style={[styles.textInput, styles.meterInput]}
                  />
                ) : field.type === "signature" ? (
                  <View>
                    <TextInput
                      editable={isDraft}
                      value={(answer as SignatureAnswer)?.signerName ?? ""}
                      onChangeText={(v) => updateAnswer(field.id, { signerName: v } as Partial<SignatureAnswer>)}
                      placeholder="Signer name"
                      style={[styles.textInput, { marginBottom: 8 }]}
                    />
                    {isDraft ? (
                      <SignaturePad
                        value={(answer as SignatureAnswer)?.svgData ?? ""}
                        onChange={(dataUrl) => updateAnswer(field.id, { svgData: dataUrl } as Partial<SignatureAnswer>)}
                      />
                    ) : (answer as SignatureAnswer)?.svgData ? (
                      <Image source={{ uri: (answer as SignatureAnswer).svgData }} style={styles.signaturePreview} resizeMode="contain" />
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}

      {template.is_swms ? (
        <View style={styles.swmsCard}>
          <Text style={styles.swmsTitle}>Worker Sign-Off Roster</Text>
          <Text style={styles.swmsSubtitle}>Every worker on site signs individually before this SWMS is complete.</Text>

          {(signatures ?? []).map((sig) => (
            <View key={sig.id} style={styles.signatureRow}>
              <View style={styles.flex1}>
                <Text style={styles.signatureName}>{sig.signer_name}</Text>
                <Text style={styles.signatureMeta}>
                  {sig.signer_role.replace("_", " ")} - signed {new Date(sig.signed_at).toLocaleString("en-AU")}
                </Text>
              </View>
              <Image source={{ uri: sig.signature_svg_data }} style={styles.signatureThumb} resizeMode="contain" />
            </View>
          ))}

          {isDraft ? (
            <View style={styles.signatureForm}>
              <TextInput value={signerName} onChangeText={setSignerName} placeholder="Worker name" style={styles.textInput} />
              <Pressable style={[styles.pickerField, { marginTop: 8 }]} onPress={() => setSignerRolePickerVisible(true)}>
                <Text style={styles.pickerFieldValue}>{SIGNER_ROLE_LABELS[signerRole]}</Text>
              </Pressable>
              <View style={{ marginTop: 8 }}>
                <SignaturePad value={signerSvg} onChange={setSignerSvg} />
              </View>
              {signatureError ? <Text style={styles.error}>{signatureError}</Text> : null}
              <Pressable
                style={styles.addSignatureButton}
                onPress={addSignature}
                disabled={addingSignature || !signerName || !signerSvg}
              >
                <Text style={styles.addSignatureButtonText}>{addingSignature ? "Adding..." : "+ Add worker sign-off"}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {isDraft ? (
        <View style={styles.footerActions}>
          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
          {saved ? <Text style={styles.saved}>Draft saved.</Text> : null}
          {completeError ? <Text style={styles.error}>{completeError}</Text> : null}
          <View style={styles.footerButtonRow}>
            <Pressable style={styles.secondaryButton} onPress={saveDraft} disabled={saving}>
              <Text style={styles.secondaryButtonText}>{saving ? "Saving..." : "Save draft"}</Text>
            </Pressable>
            <Pressable style={styles.primaryButton} onPress={complete} disabled={completing}>
              <Text style={styles.primaryButtonText}>{completing ? "Completing..." : "Complete report"}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.footerActions}>
          {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          {sendResult ? <Text style={styles.saved}>{sendResult}</Text> : null}
          <View style={styles.footerButtonRow}>
            <Pressable style={styles.primaryButton} onPress={downloadPdf} disabled={pdfBusy || !instance.pdf_storage_path}>
              <Text style={styles.primaryButtonText}>{pdfBusy ? "Preparing..." : "Download PDF"}</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={sendEmail} disabled={sendingEmail}>
              <Text style={styles.secondaryButtonText}>{sendingEmail ? "Sending..." : "Send via Email"}</Text>
            </Pressable>
          </View>
        </View>
      )}

      <PickerModal
        visible={jobPickerVisible}
        title="Select job"
        items={jobs ?? []}
        getKey={(j) => j.id}
        getLabel={(j) => `${j.number ?? "Pending"} - ${j.title}`}
        onSelect={(j) => {
          setJobCardId(j.id);
          setClientId(j.client_id);
        }}
        onClose={() => setJobPickerVisible(false)}
      />
      <PickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients ?? []}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={(c) => setClientId(c.id)}
        onClose={() => setClientPickerVisible(false)}
      />
      <PickerModal
        visible={signerRolePickerVisible}
        title="Select role"
        items={SIGNER_ROLES}
        getKey={(r) => r}
        getLabel={(r) => SIGNER_ROLE_LABELS[r]}
        onSelect={setSignerRole}
        onClose={() => setSignerRolePickerVisible(false)}
      />
    </ScrollView>
  );
}

const SIGNER_ROLES: ReportSignerRole[] = ["technician", "sub_contractor", "site_supervisor", "client"];
const SIGNER_ROLE_LABELS: Record<ReportSignerRole, string> = {
  technician: "Technician",
  sub_contractor: "Sub-contractor",
  site_supervisor: "Site supervisor",
  client: "Client",
};
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: "#fef9c3", text: "#854d0e" },
  completed: { bg: "#dcfce7", text: "#15803d" },
  archived: { bg: "#e5e7eb", text: "#4b5563" },
};

// ---------------------------------------------------------------------------
// Photo field - uploads straight to Supabase Storage (report-files bucket,
// not the PowerSync attachment queue PhotoAttachments.tsx uses for job/task
// photos, since report_instances isn't a PowerSync table), then resolves
// each stored path to a short-lived signed URL for display, same as
// desktop's PhotoField.
// ---------------------------------------------------------------------------

function ReportPhotoField({
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

  const upload = async (base64: string, mimeType: string, extension: string) => {
    setUploading(true);
    setError(null);
    try {
      const path = await uploadReportPhoto({ tenantId, reportInstanceId: instanceId, base64, extension, contentType: mimeType });
      onChange([...paths, path]);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to upload photo"));
    } finally {
      setUploading(false);
    }
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable camera access in Settings to take photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;
    await upload(asset.base64, asset.mimeType ?? "image/jpeg", asset.mimeType?.includes("png") ? "png" : "jpg");
  };

  const pickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.6, allowsMultipleSelection: true });
    if (result.canceled) return;
    for (const asset of result.assets) {
      if (!asset.base64) continue;
      await upload(asset.base64, asset.mimeType ?? "image/jpeg", asset.mimeType?.includes("png") ? "png" : "jpg");
    }
  };

  return (
    <View>
      {paths.length > 0 ? (
        <View style={styles.photoRow}>
          {paths.map((p) => (
            <View key={p}>
              {urls[p] ? <Image source={{ uri: urls[p] }} style={styles.photoThumb} /> : <View style={[styles.photoThumb, styles.photoPending]} />}
              {!disabled ? (
                <Pressable style={styles.photoRemove} onPress={() => onChange(paths.filter((x) => x !== p))}>
                  <Text style={styles.photoRemoveText}>×</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {!disabled ? (
        <View style={styles.photoActionsRow}>
          <Pressable style={styles.photoActionButton} onPress={takePhoto} disabled={uploading}>
            <Text style={styles.photoActionButtonText}>{uploading ? "Uploading..." : "Take photo"}</Text>
          </Pressable>
          <Pressable style={[styles.photoActionButton, styles.photoActionButtonSecondary]} onPress={pickFromLibrary} disabled={uploading}>
            <Text style={[styles.photoActionButtonText, styles.photoActionButtonSecondaryText]}>Choose photos</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Risk matrix - a repeatable hazard register (WHS Form 04/05 style), matching
// packages/shared/src/reports.ts's RiskMatrixAnswer shape exactly.
// ---------------------------------------------------------------------------

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
  const [likelihoodPickerFor, setLikelihoodPickerFor] = useState<string | null>(null);
  const [consequencePickerFor, setConsequencePickerFor] = useState<string | null>(null);

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
    <View>
      {rows.length === 0 ? <Text style={styles.helpText}>No hazards recorded yet.</Text> : null}
      {rows.map((row, index) => {
        const ratingColors = RISK_RATING_COLORS[row.rating];
        return (
          <View key={row.id} style={styles.hazardCard}>
            <View style={styles.hazardHeader}>
              <Text style={styles.hazardIndex}>Hazard #{index + 1}</Text>
              {!disabled ? (
                <Pressable onPress={() => removeRow(row.id)}>
                  <Text style={styles.removeLink}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              editable={!disabled}
              value={row.hazard}
              onChangeText={(v) => updateRow(row.id, { hazard: v })}
              placeholder="Hazard identified (e.g. fall from roof edge)"
              multiline
              style={[styles.textInput, styles.multiline, { marginBottom: 8 }]}
            />
            <View style={styles.hazardGrid}>
              <Pressable style={[styles.pickerField, styles.flex1]} onPress={() => !disabled && setLikelihoodPickerFor(row.id)}>
                <Text style={styles.pickerFieldLabel}>Likelihood</Text>
                <Text style={styles.pickerFieldValue}>{RISK_LIKELIHOOD_LABELS[row.likelihood]}</Text>
              </Pressable>
              <Pressable style={[styles.pickerField, styles.flex1]} onPress={() => !disabled && setConsequencePickerFor(row.id)}>
                <Text style={styles.pickerFieldLabel}>Consequence</Text>
                <Text style={styles.pickerFieldValue}>{RISK_CONSEQUENCE_LABELS[row.consequence]}</Text>
              </Pressable>
            </View>
            <View style={[styles.ratingBadge, { backgroundColor: ratingColors.bg }]}>
              <Text style={[styles.ratingBadgeText, { color: ratingColors.text }]}>{RISK_RATING_LABELS[row.rating]} risk</Text>
            </View>
            <TextInput
              editable={!disabled}
              value={row.controlMeasures}
              onChangeText={(v) => updateRow(row.id, { controlMeasures: v })}
              placeholder="Control measures - what will be done to control this risk?"
              multiline
              style={[styles.textInput, styles.multiline, { marginTop: 8 }]}
            />
            <PickerModal
              visible={likelihoodPickerFor === row.id}
              title="Likelihood"
              items={RISK_LEVELS}
              getKey={(l) => String(l)}
              getLabel={(l) => RISK_LIKELIHOOD_LABELS[l]}
              onSelect={(l) => updateRow(row.id, { likelihood: l })}
              onClose={() => setLikelihoodPickerFor(null)}
            />
            <PickerModal
              visible={consequencePickerFor === row.id}
              title="Consequence"
              items={RISK_LEVELS as unknown as RiskConsequence[]}
              getKey={(c) => String(c)}
              getLabel={(c) => RISK_CONSEQUENCE_LABELS[c]}
              onSelect={(c) => updateRow(row.id, { consequence: c })}
              onClose={() => setConsequencePickerFor(null)}
            />
          </View>
        );
      })}
      {!disabled ? (
        <Pressable style={styles.addHazardButton} onPress={addRow}>
          <Text style={styles.addHazardButtonText}>+ Add hazard</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  flex1: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 12 },
  heading: { fontSize: 19, fontWeight: "700", color: "#111827" },
  subheading: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  statusBadgeText: { fontSize: 12, fontWeight: "700" },

  unlinkedBanner: { borderWidth: 1, borderColor: "#fde68a", backgroundColor: "#fffbeb", borderRadius: 10, padding: 12, marginBottom: 16, gap: 8 },
  unlinkedTitle: { fontSize: 13, fontWeight: "700", color: "#92400e" },
  linkedMeta: { fontSize: 13, color: "#6b7280", marginBottom: 16 },
  link: { color: "#1d4ed8", fontWeight: "600" },

  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldLabel: { fontSize: 12, color: "#6b7280", marginBottom: 2 },
  pickerFieldValue: { fontSize: 15, color: "#111827" },

  sectionCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 16, marginBottom: 14, backgroundColor: "#fff" },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginBottom: 12 },
  fieldBlock: { marginBottom: 18 },
  fieldLabel: { fontSize: 14, fontWeight: "700", color: "#1f2937", marginBottom: 4 },
  required: { color: "#dc2626" },
  helpText: { fontSize: 12, color: "#9ca3af", marginBottom: 4 },

  passFailRow: { flexDirection: "row", gap: 8 },
  passFailButton: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  actionRequired: { marginTop: 10, backgroundColor: "#fef2f2", borderRadius: 8, padding: 10 },
  actionRequiredLabel: { fontSize: 12, fontWeight: "700", color: "#991b1b", marginBottom: 6 },
  actionNoteInput: { borderWidth: 1, borderColor: "#fecaca", borderRadius: 8, padding: 10, fontSize: 14, minHeight: 50, textAlignVertical: "top", marginBottom: 8, backgroundColor: "#fff" },

  textInput: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 10, fontSize: 14, backgroundColor: "#fff" },
  multiline: { minHeight: 60, textAlignVertical: "top" },
  meterInput: { width: 160 },
  signaturePreview: { height: 100, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, backgroundColor: "#fff" },

  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  photoThumb: { width: 80, height: 80, borderRadius: 8, backgroundColor: "#e5e7eb" },
  photoPending: { alignItems: "center", justifyContent: "center" },
  photoRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: "#dc2626", alignItems: "center", justifyContent: "center" },
  photoRemoveText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  photoActionsRow: { flexDirection: "row", gap: 8 },
  photoActionButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  photoActionButtonSecondary: { backgroundColor: "#f3f4f6" },
  photoActionButtonText: { color: "#fff", fontWeight: "600", fontSize: 12 },
  photoActionButtonSecondaryText: { color: "#1d4ed8" },

  hazardCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 12, backgroundColor: "#f9fafb", marginBottom: 10 },
  hazardHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  hazardIndex: { fontSize: 11, fontWeight: "700", color: "#9ca3af" },
  removeLink: { color: "#dc2626", fontWeight: "700", fontSize: 12 },
  hazardGrid: { flexDirection: "row", gap: 8, marginBottom: 8 },
  ratingBadge: { alignSelf: "flex-start", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  ratingBadgeText: { fontSize: 11, fontWeight: "700" },
  addHazardButton: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 10, alignItems: "center" },
  addHazardButtonText: { fontWeight: "700", color: "#374151", fontSize: 13 },

  swmsCard: { borderWidth: 1, borderColor: "#fed7aa", backgroundColor: "#fff7ed", borderRadius: 10, padding: 16, marginBottom: 16 },
  swmsTitle: { fontSize: 12, fontWeight: "700", color: "#9a3412", textTransform: "uppercase" },
  swmsSubtitle: { fontSize: 12, color: "#c2410c", marginTop: 2, marginBottom: 10 },
  signatureRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#fff", borderRadius: 8, padding: 10, marginBottom: 8 },
  signatureName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  signatureMeta: { fontSize: 11, color: "#6b7280", marginTop: 2 },
  signatureThumb: { width: 80, height: 40 },
  signatureForm: { backgroundColor: "#fff", borderRadius: 8, padding: 10, marginTop: 4 },
  addSignatureButton: { backgroundColor: "#c2410c", borderRadius: 8, padding: 10, alignItems: "center", marginTop: 8 },
  addSignatureButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  footerActions: { marginTop: 8, gap: 8 },
  footerButtonRow: { flexDirection: "row", gap: 10 },
  primaryButton: { flex: 1, backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center" },
  primaryButtonText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  secondaryButton: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 14, alignItems: "center" },
  secondaryButtonText: { color: "#374151", fontWeight: "700", fontSize: 14 },
  error: { color: "#dc2626", fontSize: 13 },
  saved: { color: "#15803d", fontSize: 13 },
});
