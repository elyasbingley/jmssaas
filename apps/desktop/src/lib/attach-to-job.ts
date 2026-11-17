import { supabase } from "./supabase";

// Attaching an Inbox email or a Channels message to an existing job. The
// database function attach_message_to_job (attach_messages_to_jobs
// migration) writes the job note and records the link in one step; this
// copies the message's files into the job first, since storage is outside
// the database.

export type AttachSource = { kind: "inbox"; messageId: string } | { kind: "channel"; messageId: string };

interface SourceFile {
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes?: number | null;
}

const JOB_FILES_BUCKET = "job-files";

// Each file is downloaded and re-uploaded rather than pointed at: job_files
// rows always live in the job-files bucket, which is what the job page,
// the phone and job deletion all read.
export async function copyFilesToJob(params: { bucket: string; files: SourceFile[]; tenantId: string; jobCardId: string; uploadedBy: string }): Promise<void> {
  for (const file of params.files) {
    const { data: blob, error: downloadError } = await supabase.storage.from(params.bucket).download(file.storage_path);
    if (downloadError || !blob) throw downloadError ?? new Error(`Failed to download ${file.file_name}`);

    const storagePath = `${params.tenantId}/${params.jobCardId}/${crypto.randomUUID()}-${file.file_name}`;
    const { error: uploadError } = await supabase.storage.from(JOB_FILES_BUCKET).upload(storagePath, blob, { contentType: file.mime_type ?? undefined });
    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from("job_files").insert({
      tenant_id: params.tenantId,
      job_card_id: params.jobCardId,
      storage_path: storagePath,
      file_name: file.file_name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes ?? blob.size,
      uploaded_by: params.uploadedBy,
    });
    if (insertError) throw insertError;
  }
}

async function sourceDetails(source: AttachSource): Promise<{ bucket: string; files: SourceFile[]; linkedJobId: string | null }> {
  if (source.kind === "inbox") {
    const [{ data: message, error: messageError }, { data: files, error: filesError }] = await Promise.all([
      supabase.from("inbox_messages").select("linked_job_id").eq("id", source.messageId).single(),
      supabase.from("inbox_attachments").select("storage_path, file_name, mime_type, size_bytes").eq("message_id", source.messageId),
    ]);
    if (messageError) throw messageError;
    if (filesError) throw filesError;
    return { bucket: "inbox-attachments", files: (files ?? []) as SourceFile[], linkedJobId: message.linked_job_id };
  }
  const { data, error } = await supabase.from("channel_messages").select("media, linked_job_id").eq("id", source.messageId).single();
  if (error) throw error;
  return { bucket: "channel-media", files: (data.media ?? []) as SourceFile[], linkedJobId: data.linked_job_id };
}

export async function attachMessageToJob(source: AttachSource, jobCardId: string, user: { id: string; tenant_id: string }): Promise<{ jobNumber: string | null; fileCount: number }> {
  const details = await sourceDetails(source);
  // Checked before copying files too, so a second click on the same job
  // doesn't leave duplicate files behind before the database refuses it.
  if (details.linkedJobId === jobCardId) throw new Error("This message is already attached to that job.");

  await copyFilesToJob({ bucket: details.bucket, files: details.files, tenantId: user.tenant_id, jobCardId, uploadedBy: user.id });
  const { data, error } = await supabase.rpc("attach_message_to_job", {
    p_job_card_id: jobCardId,
    p_inbox_message_id: source.kind === "inbox" ? source.messageId : null,
    p_channel_message_id: source.kind === "channel" ? source.messageId : null,
  });
  if (error) throw error;
  return { jobNumber: (data as { job_number: string | null }).job_number, fileCount: details.files.length };
}
