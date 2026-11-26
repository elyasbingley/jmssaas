import { supabase } from "./supabase";

// "OK for marketing" on the desktop (Google Business Profile posting - see
// GBP_SETUP.md). The desktop twin of apps/mobile/lib/marketing-photo.ts:
// makes the public copy in the 'marketing' bucket and flags the job_files
// row through set_job_file_marketing().
//
// The copy is made in the browser: the photo is decoded with its EXIF
// rotation applied, drawn onto a canvas (at most 1600px wide) and saved as
// a fresh JPEG. A canvas export carries no EXIF at all, so the GPS
// position of the client's house never reaches the public copy.

const MAX_WIDTH = 1600;

export function marketingPath(tenantId: string, jobFileId: string): string {
  return `${tenantId}/${jobFileId}.jpg`;
}

async function strippedJpeg(source: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This photo's format can't be read in the browser (HEIC photos from iPhones often can't). Flag it from the phone instead.");
  }
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare the photo");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob) throw new Error("Couldn't prepare the photo");
  return blob;
}

export async function flagPhotoForMarketing(opts: { tenantId: string; jobFileId: string; storagePath: string }): Promise<string> {
  const { data: original, error: dlErr } = await supabase.storage.from("job-files").download(opts.storagePath);
  if (dlErr || !original) throw dlErr ?? new Error("Couldn't download the photo");
  const copy = await strippedJpeg(original);

  const path = marketingPath(opts.tenantId, opts.jobFileId);
  const { error: upErr } = await supabase.storage.from("marketing").upload(path, copy, { contentType: "image/jpeg", upsert: true });
  if (upErr) throw upErr;

  const { error: dbErr } = await supabase.rpc("set_job_file_marketing", { p_job_file_id: opts.jobFileId, p_marketing_path: path });
  if (dbErr) {
    // Don't leave a public copy behind for a photo that isn't flagged.
    await supabase.storage.from("marketing").remove([path]);
    throw dbErr;
  }
  return path;
}

export async function unflagPhotoForMarketing(opts: { tenantId: string; jobFileId: string; usedInPost: boolean }): Promise<void> {
  const { error } = await supabase.rpc("set_job_file_marketing", { p_job_file_id: opts.jobFileId, p_marketing_path: null });
  if (error) throw error;
  // The public copy goes too - unless a Google post already uses it (the
  // post, draft or published, links to that copy).
  if (!opts.usedInPost) await supabase.storage.from("marketing").remove([marketingPath(opts.tenantId, opts.jobFileId)]);
}

// The Supabase client hides an Edge Function's own error message inside the
// response; this pulls it out so the screen can show it.
export async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = await ctx.clone().json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      /* not JSON */
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
