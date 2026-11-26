// Creates the public "marketing" copy of a job photo when it's flagged
// "OK for marketing" (Google Business Profile posting - see GBP_SETUP.md).
//
// Why on the device: re-encoding the photo bakes in its rotation and drops
// the EXIF block, which includes the GPS coordinates of the client's house.
// Doing it here avoids heavy image work in Edge Functions.
//
// Fitted to JMS (the draft was written without the repo):
// - Job photos are job_files rows, and on the phone the photo is already a
//   local file (the PowerSync attachment queue's local_uri) - so no
//   download step.
// - Uses expo-image-manipulator's current API (manipulate/renderAsync/
//   saveAsync, as ThemedPhotoAttachments does) - manipulateAsync is
//   deprecated in this SDK - and needs no new packages.
// - job_files has no UPDATE permission, so the flag is set through the
//   set_job_file_marketing() database function. That needs a connection
//   anyway (the copy is uploaded to storage), and the change comes back to
//   the phone through PowerSync like any other server change.

import { decode } from "base64-arraybuffer";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { supabase } from "./supabase";

const MAX_WIDTH = 1600;

export function marketingPath(tenantId: string, jobFileId: string): string {
  return `${tenantId}/${jobFileId}.jpg`;
}

export async function flagPhotoForMarketing(opts: {
  tenantId: string;
  jobFileId: string;
  /** file:// URI of the photo on this device */
  sourceUri: string;
}): Promise<string> {
  // Resize to at most 1600px wide (never enlarged), JPEG 80%. The output
  // has no EXIF/GPS.
  let image = await ImageManipulator.manipulate(opts.sourceUri).renderAsync();
  if (image.width > MAX_WIDTH) image = await ImageManipulator.manipulate(image).resize({ width: MAX_WIDTH }).renderAsync();
  const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  if (!out.base64) throw new Error("Couldn't read the photo");

  const path = marketingPath(opts.tenantId, opts.jobFileId);
  const { error: upErr } = await supabase.storage.from("marketing").upload(path, decode(out.base64), { contentType: "image/jpeg", upsert: true });
  if (upErr) throw upErr;

  const { error: dbErr } = await supabase.rpc("set_job_file_marketing", { p_job_file_id: opts.jobFileId, p_marketing_path: path });
  if (dbErr) {
    // Don't leave a public copy behind for a photo that isn't flagged.
    await supabase.storage.from("marketing").remove([path]);
    throw dbErr;
  }
  return path;
}

export async function unflagPhotoForMarketing(opts: { tenantId: string; jobFileId: string }): Promise<void> {
  const { data: row } = await supabase.from("job_files").select("used_in_post_id").eq("id", opts.jobFileId).maybeSingle();
  const { error } = await supabase.rpc("set_job_file_marketing", { p_job_file_id: opts.jobFileId, p_marketing_path: null });
  if (error) throw error;
  // The public copy goes too - unless a Google post already uses it (the
  // post, draft or published, links to that copy).
  if (!row?.used_in_post_id) await supabase.storage.from("marketing").remove([marketingPath(opts.tenantId, opts.jobFileId)]);
}
