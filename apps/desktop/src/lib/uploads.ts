import { supabase } from "./supabase";

// Desktop equivalent of apps/mobile/lib/powersync.ts's addJobPhoto - same
// storage_path convention (<tenant_id>/<job_card_id>/<uuid>.<ext>, see
// supabase/migrations/20260720000300_storage.sql's RLS policies, which key
// off that exact path shape) and the same job_files row shape, just a
// direct upload instead of going through PowerSync's offline attachment
// queue - there's nothing to queue when the app is always online.
// Returns the storage_path of the uploaded job_files row - the roof
// measurement screen uses this to record which photo is its own snapshot
// (mobile's own addJobPhoto-based snapshot capture doesn't do this: it
// sets job_measurements.snapshot_path to just "<tenant_id>/<job_id>", a
// folder prefix rather than the actual file, since addJobPhoto never
// returns the id/path it generates - not fixed there, but worth doing
// properly here since the return value is available for free).
export async function uploadJobPhoto(params: {
  tenantId: string;
  jobCardId: string;
  uploadedBy: string;
  file: File;
}): Promise<string> {
  const id = crypto.randomUUID();
  const extension = params.file.name.split(".").pop()?.toLowerCase() || "jpg";
  const fileName = `${id}.${extension}`;
  const storagePath = `${params.tenantId}/${params.jobCardId}/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("job-files")
    .upload(storagePath, params.file, { contentType: params.file.type || undefined });
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase.from("job_files").insert({
    id,
    tenant_id: params.tenantId,
    job_card_id: params.jobCardId,
    storage_path: storagePath,
    file_name: fileName,
    mime_type: params.file.type || null,
    size_bytes: params.file.size,
    uploaded_by: params.uploadedBy,
  });
  if (insertError) throw insertError;

  return storagePath;
}

// Reports & Safety module - "report-files" bucket, <tenant_id>/<report_
// instance_id>/<uuid>.<ext> path (see the reports_safety_engine
// migration's storage RLS). No row insert here unlike uploadJobPhoto/
// uploadTaskPhoto - a report photo's path lives inline inside the
// relevant answer's photoPaths array in report_instances.form_data, not a
// separate table, since it's owned by one specific form field, not the
// report as a whole.
export async function uploadReportPhoto(params: { tenantId: string; reportInstanceId: string; file: File }): Promise<string> {
  const id = crypto.randomUUID();
  const extension = params.file.name.split(".").pop()?.toLowerCase() || "jpg";
  const storagePath = `${params.tenantId}/${params.reportInstanceId}/${id}.${extension}`;

  const { error } = await supabase.storage
    .from("report-files")
    .upload(storagePath, params.file, { contentType: params.file.type || undefined });
  if (error) throw error;

  return storagePath;
}

// Same pattern as uploadJobPhoto, for task photo attachments - same
// job-files bucket, same "<tenant_id>/task-<task_id>/<uuid>.<ext>" storage
// path shape as apps/mobile/lib/powersync.ts's addTaskPhoto, just a direct
// upload instead of PowerSync's offline attachment queue.
export async function uploadTaskPhoto(params: {
  tenantId: string;
  taskId: string;
  uploadedBy: string;
  file: File;
}): Promise<string> {
  const id = crypto.randomUUID();
  const extension = params.file.name.split(".").pop()?.toLowerCase() || "jpg";
  const fileName = `${id}.${extension}`;
  const storagePath = `${params.tenantId}/task-${params.taskId}/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("job-files")
    .upload(storagePath, params.file, { contentType: params.file.type || undefined });
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase.from("task_files").insert({
    id,
    tenant_id: params.tenantId,
    task_id: params.taskId,
    storage_path: storagePath,
    file_name: fileName,
    mime_type: params.file.type || null,
    size_bytes: params.file.size,
    uploaded_by: params.uploadedBy,
  });
  if (insertError) throw insertError;

  return storagePath;
}
