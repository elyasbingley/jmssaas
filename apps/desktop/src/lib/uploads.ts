import { supabase } from "./supabase";

// Desktop equivalent of apps/mobile/lib/powersync.ts's addJobPhoto - same
// storage_path convention (<tenant_id>/<job_card_id>/<uuid>.<ext>, see
// supabase/migrations/20260720000300_storage.sql's RLS policies, which key
// off that exact path shape) and the same job_files row shape, just a
// direct upload instead of going through PowerSync's offline attachment
// queue - there's nothing to queue when the app is always online.
export async function uploadJobPhoto(params: {
  tenantId: string;
  jobCardId: string;
  uploadedBy: string;
  file: File;
}): Promise<void> {
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
}
