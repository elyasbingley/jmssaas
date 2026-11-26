// gbp-publish
// Called from JMS when an admin taps Approve on a Google post draft (or
// "Try again" on a failed one).
// Body: { "post_id": "uuid", "summary"?: "edited caption", "resend"?: true }
// resend: send an already-published post to Zapier again (e.g. the Zap was
// off the first time, which Zapier doesn't report as an error).
// RLS on gbp_posts makes sure only admins of the post's company can see or
// approve it, so the post is read and approved with the caller's own token.
//
// Deploy with:  supabase functions deploy gbp-publish

import { createClient } from "npm:@supabase/supabase-js@2";
import { cleanCaption, corsHeaders, publishPost } from "../_shared/gbp.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { post_id, summary, resend } = await req.json().catch(() => ({}));
    if (!post_id) return json({ error: "post_id is required" }, 400);

    // Visible only if the caller is an admin of this company (RLS).
    const { data: post, error } = await userClient.from("gbp_posts").select("id, status").eq("id", post_id).maybeSingle();
    if (error || !post) return json({ error: "Post not found" }, 404);
    const resending = resend === true && post.status === "published";
    if (!resending && !["draft", "approved", "failed"].includes(post.status)) {
      return json({ error: `Post is already ${post.status}` }, 409);
    }
    if (resending) {
      const published = await publishPost(admin, post_id, { resend: true });
      return json({ ok: true, post: published });
    }

    const { data: { user } } = await userClient.auth.getUser();
    const update: Record<string, unknown> = { status: "approved", approved_by: user?.id ?? null, error: null };
    if (typeof summary === "string" && summary.trim()) update.summary = cleanCaption(summary);

    const { error: updErr } = await userClient.from("gbp_posts").update(update).eq("id", post_id);
    if (updErr) return json({ error: updErr.message }, 403);

    const published = await publishPost(admin, post_id);
    return json({ ok: true, post: published });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
