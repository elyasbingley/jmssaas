// Public, unauthenticated JSON API for the leak check share page. Deployed
// as a Supabase Edge Function (Deno runtime, npm: specifiers supported).
//
// Same reasoning as supabase/functions/approve/index.ts for why this is a
// plain JSON API rather than rendering HTML itself: Supabase force-
// downgrades any HTML-looking Edge Function response on the shared
// *.supabase.co domain to inert text/plain (a deliberate anti-phishing
// measure, confirmed there by inspecting real response headers) - the
// actual page lives as a static file instead (see supabase/static/
// leak-check-share.html).
//
// The checklist data itself comes from get_leak_check_for_share (see the
// leak_check_share migration), called with the plain anon key - the token
// is the credential, validated server-side in that function. That RPC
// returns bare storage_path values for each item's photos rather than
// signed URLs, because Postgres has no way to call Storage's signing
// endpoint - this function does that part, using the service role key to
// bypass the job-files bucket's normal admin-or-assigned-technician RLS
// (the token has already proven this caller is allowed to see this one
// leak check's own photos by the time signing happens - nothing here ever
// signs a path that didn't come back from that RPC call).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    }),
  });
}

interface ShareItem {
  label: string;
  item_type: "standard" | "water_meter";
  result: "pass" | "fail" | "na" | null;
  notes: string | null;
  meter_start_reading: number | null;
  meter_end_reading: number | null;
  meter_wait_minutes: number | null;
  photo_paths: string[];
}

interface ShareCategory {
  name: string;
  items: ShareItem[];
}

interface ShareReport {
  title: string;
  status: string;
  completed_at: string | null;
  tenant_name: string;
  tenant_logo_url: string | null;
  client_name: string;
  job_title: string;
  categories: ShareCategory[];
  error?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  }
  if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "bad_request" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.rpc("get_leak_check_for_share", { p_token: token });
  if (error) return json({ error: "server_error" }, 500);

  const report = data as ShareReport;
  if (report.error) return json(report);

  // Sign every photo path up front in one batch per unique path set,
  // rather than N individual calls - createSignedUrls takes a list and
  // returns matching results in the same order.
  const allPaths = report.categories.flatMap((c) => c.items.flatMap((i) => i.photo_paths));
  const signedUrlByPath = new Map<string, string>();
  if (allPaths.length > 0 && SUPABASE_SERVICE_ROLE_KEY) {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: signed, error: signError } = await admin.storage.from("job-files").createSignedUrls(allPaths, 3600);
    if (!signError && signed) {
      signed.forEach((s, i) => {
        if (s.signedUrl) signedUrlByPath.set(allPaths[i], s.signedUrl);
      });
    }
  }

  const withSignedUrls = {
    ...report,
    categories: report.categories.map((c) => ({
      ...c,
      items: c.items.map((i) => ({
        ...i,
        photos: i.photo_paths.map((p) => signedUrlByPath.get(p)).filter((u): u is string => !!u),
        photo_paths: undefined,
      })),
    })),
  };

  return json(withSignedUrls);
});
