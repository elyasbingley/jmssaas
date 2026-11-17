import { supabase } from "./supabase";

// Phone port of apps/desktop/src/lib/attach-to-job.ts - attaching an Inbox
// email or a Channels message to an existing job. The database function
// attach_message_to_job writes the job note and records the link; this
// copies the message's files into the job first. Online only, like the
// Inbox and Channels screens it is used from.

export type AttachSource = { kind: "inbox"; messageId: string } | { kind: "channel"; messageId: string };

interface SourceFile {
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes?: number | null;
}

export async function copyFilesToJob(params: { bucket: string; files: SourceFile[]; tenantId: string; jobCardId: string; uploadedBy: string }): Promise<void> {
  for (const file of params.files) {
    const { data: blob, error: downloadError } = await supabase.storage.from(params.bucket).download(file.storage_path);
    if (downloadError || !blob) throw downloadError ?? new Error(`Failed to download ${file.file_name}`);
    const bytes = await blob.arrayBuffer();

    const storagePath = `${params.tenantId}/${params.jobCardId}/${crypto.randomUUID()}-${file.file_name}`;
    const { error: uploadError } = await supabase.storage.from("job-files").upload(storagePath, bytes, { contentType: file.mime_type ?? undefined });
    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from("job_files").insert({
      tenant_id: params.tenantId,
      job_card_id: params.jobCardId,
      storage_path: storagePath,
      file_name: file.file_name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes ?? bytes.byteLength,
      uploaded_by: params.uploadedBy,
    });
    if (insertError) throw insertError;
  }
}

export async function attachMessageToJob(source: AttachSource, jobCardId: string, user: { id: string; tenant_id: string }): Promise<{ jobNumber: string | null }> {
  let bucket: string;
  let files: SourceFile[];
  let linkedJobId: string | null;
  if (source.kind === "inbox") {
    const [message, attachments] = await Promise.all([
      supabase.from("inbox_messages").select("linked_job_id").eq("id", source.messageId).single(),
      supabase.from("inbox_attachments").select("storage_path, file_name, mime_type, size_bytes").eq("message_id", source.messageId),
    ]);
    if (message.error) throw message.error;
    if (attachments.error) throw attachments.error;
    bucket = "inbox-attachments";
    files = (attachments.data ?? []) as SourceFile[];
    linkedJobId = message.data.linked_job_id;
  } else {
    const { data, error } = await supabase.from("channel_messages").select("media, linked_job_id").eq("id", source.messageId).single();
    if (error) throw error;
    bucket = "channel-media";
    files = (data.media ?? []) as SourceFile[];
    linkedJobId = data.linked_job_id;
  }
  if (linkedJobId === jobCardId) throw new Error("This message is already attached to that job.");

  await copyFilesToJob({ bucket, files, tenantId: user.tenant_id, jobCardId, uploadedBy: user.id });
  const { data, error } = await supabase.rpc("attach_message_to_job", {
    p_job_card_id: jobCardId,
    p_inbox_message_id: source.kind === "inbox" ? source.messageId : null,
    p_channel_message_id: source.kind === "channel" ? source.messageId : null,
  });
  if (error) throw error;
  return { jobNumber: (data as { job_number: string | null }).job_number };
}
