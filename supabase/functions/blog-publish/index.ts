// blog-publish
// Called from JMS when an admin approves a blog post draft (or taps "Try
// again" on a failed one). Saves any edits, then commits the post and its
// photos to the website's GitHub repository; Vercel builds and publishes it.
//
// Body: { "post_id": "uuid", "title"?, "description"?, "body"? }
// RLS on blog_posts makes sure only admins of the post's company can see or
// approve it, so the post is read and approved with the caller's own token.
//
// Secret: WEBSITE_GITHUB_TOKEN - a fine-grained GitHub token with
// "Contents: read and write" on the website repository only.
//
// Deploy with:  supabase functions deploy blog-publish

import { createClient } from "npm:@supabase/supabase-js@2";
import { cleanText, commitPost, corsHeaders, type BlogPostRow } from "../_shared/blog.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBSITE_GITHUB_TOKEN = Deno.env.get("WEBSITE_GITHUB_TOKEN") ?? "";
const GITHUB_API = Deno.env.get("GITHUB_API_BASE") ?? "https://api.github.com"; // tests only

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders });

function sydneyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const input = await req.json().catch(() => ({}));
  if (!input.post_id) return json({ error: "post_id is required" }, 400);

  // Visible only if the caller is an admin of this company (RLS).
  const { data: post, error } = await userClient.from("blog_posts").select("*").eq("id", input.post_id).maybeSingle();
  if (error || !post) return json({ error: "Post not found" }, 404);
  if (!["draft", "approved", "failed"].includes(post.status)) return json({ error: `Post is already ${post.status}` }, 409);

  const { data: settings } = await userClient.from("blog_settings").select("*").eq("tenant_id", post.tenant_id).maybeSingle();
  if (!settings?.github_repo) return json({ error: "Set the website's GitHub repository in Blog Posts > Settings first." }, 400);
  if (!WEBSITE_GITHUB_TOKEN) return json({ error: "The WEBSITE_GITHUB_TOKEN secret isn't set (see BLOG_SETUP.md)." }, 500);

  // Save the admin's edits and mark it approved.
  const { data: { user } } = await userClient.auth.getUser();
  const update: Record<string, unknown> = { status: "approved", approved_by: user?.id ?? null, error: null };
  for (const [key, max] of [["title", 140], ["description", 320], ["body", 20000]] as const) {
    if (typeof input[key] === "string" && input[key].trim()) update[key] = cleanText(input[key]).slice(0, max);
  }
  const { data: approved, error: updErr } = await userClient.from("blog_posts").update(update).eq("id", post.id).select("*").single();
  if (updErr || !approved) return json({ error: updErr?.message ?? "Couldn't save the post" }, 403);

  try {
    const { slug, commitSha } = await commitPost({
      token: WEBSITE_GITHUB_TOKEN,
      repo: settings.github_repo,
      branch: settings.github_branch || "main",
      post: approved as BlogPostRow,
      publishDate: sydneyToday(),
      apiBase: GITHUB_API,
    });
    const site = (settings.site_url || "").replace(/\/+$/, "");
    const { data: published } = await admin
      .from("blog_posts")
      .update({
        status: "published",
        slug,
        commit_sha: commitSha,
        published_url: site ? `${site}/blog/${slug}` : null,
        published_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", post.id)
      .select("*")
      .single();
    return json({ ok: true, post: published });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[blog-publish]", post.id, message);
    await admin.from("blog_posts").update({ status: "failed", error: message.slice(0, 600) }).eq("id", post.id);
    return json({ error: message }, 502);
  }
});
