// Shared by gbp-draft and gbp-publish (Google Business Profile posting via
// Zapier - see GBP_SETUP.md).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * Sends one post to the company's Zapier webhook and marks it published.
 * Zapier returning 200 means Zapier received it. If Google then rejects the
 * post, the error shows in Zapier's Zap history (turn on Zapier error emails).
 */
export async function publishPost(admin: SupabaseClient, postId: string) {
  const { data: post, error } = await admin.from("gbp_posts").select("*").eq("id", postId).single();
  if (error || !post) throw new Error(`Post not found: ${postId}`);
  if (post.status === "published") return post;

  const { data: settings } = await admin.from("gbp_settings").select("zapier_webhook_url").eq("tenant_id", post.tenant_id).maybeSingle();
  if (!settings?.zapier_webhook_url) {
    await admin.from("gbp_posts").update({ status: "failed", error: "No Zapier webhook URL set" }).eq("id", post.id);
    throw new Error("No Zapier webhook URL set for this company");
  }

  const payload = {
    post_id: post.id,
    summary: post.summary,
    cta_type: post.cta_type,
    // Google rejects a URL on CALL buttons, so send it empty.
    cta_url: post.cta_type === "CALL" ? "" : (post.cta_url ?? ""),
    photo_url: post.photo_url,
  };

  let res: Response;
  try {
    res = await fetch(settings.zapier_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    await admin.from("gbp_posts").update({ status: "failed", error: `Couldn't reach Zapier: ${String(e).slice(0, 400)}` }).eq("id", post.id);
    throw new Error("Couldn't reach the Zapier webhook");
  }

  if (!res.ok) {
    const text = await res.text();
    await admin.from("gbp_posts").update({ status: "failed", error: `Zapier ${res.status}: ${text.slice(0, 500)}` }).eq("id", post.id);
    throw new Error(`Zapier webhook failed with ${res.status}`);
  }

  const { data: updated } = await admin
    .from("gbp_posts")
    .update({ status: "published", published_at: new Date().toISOString(), error: null })
    .eq("id", post.id)
    .select()
    .single();
  return updated;
}

/** Removes em and en dashes, which read as AI-written. */
export function cleanCaption(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1500);
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
