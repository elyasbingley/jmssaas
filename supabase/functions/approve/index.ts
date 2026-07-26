// Public, unauthenticated JSON API for the quote/invoice approval page.
// Deployed as a Supabase Edge Function (Deno runtime, npm: specifiers
// supported).
//
// This used to render the HTML page itself, but Supabase's platform force-
// downgrades any HTML-looking Edge Function response on the shared
// *.supabase.co domain to inert text/plain with a
// `Content-Security-Policy: default-src 'none'; sandbox` header - a
// deliberate anti-phishing measure (a function serving *interactive* HTML
// under a trusted shared domain is exactly what that policy exists to
// block), confirmed by inspecting the actual response headers rather than
// guessed at. There's no header this function can set to opt back out of
// it short of attaching a paid custom domain to the project. JSON
// responses aren't subject to that restriction, so this function is now a
// plain data API, and the actual page lives as a static HTML/JS file in
// Supabase Storage instead (see supabase/static/approval-page.html) -
// Storage-served files don't get the same lockdown, and Storage is
// already part of this app's stack (same place the company logo lives).
//
// Every actual read and write still goes through the SECURITY DEFINER
// RPCs added in supabase/migrations/20260728000100_quote_invoice_approval.sql
// (get_quote_for_approval, accept_quote_by_token, etc.) using the plain
// anon key - the token itself is the credential, validated server-side in
// those functions (existence, expiry, current status), not here. This
// function never touches the database directly and never sees the
// service role key.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

type DocType = "quote" | "invoice";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const docType = url.searchParams.get("type");
    const token = url.searchParams.get("token");
    if ((docType !== "quote" && docType !== "invoice") || !token) {
      return json({ error: "bad_request" }, 400);
    }
    const rpcPrefix: DocType = docType;
    const { data, error } = await supabase.rpc(`get_${rpcPrefix}_for_approval`, { p_token: token });
    if (error) return json({ error: "server_error" }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    let body: { type?: string; token?: string; action?: string; name?: string; reason?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const { type: docType, token, action, name, reason } = body;
    if ((docType !== "quote" && docType !== "invoice") || !token) {
      return json({ error: "bad_request" }, 400);
    }
    const rpcPrefix: DocType = docType;

    if (action === "accept") {
      const { data, error } = await supabase.rpc(`accept_${rpcPrefix}_by_token`, {
        p_token: token,
        p_name: name ?? "",
      });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }
    if (action === "decline") {
      const { data, error } = await supabase.rpc(`decline_${rpcPrefix}_by_token`, {
        p_token: token,
        p_reason: reason ?? "",
      });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }
    return json({ error: "bad_request" }, 400);
  }

  return json({ error: "method_not_allowed" }, 405);
});
