// Admin-only: creates a new Supabase Auth user (a technician login) for the
// calling admin's own tenant. Deployed as a Supabase Edge Function (Deno
// runtime, npm: specifiers supported) because creating an Auth user
// programmatically requires the service_role key (the Admin API isn't
// available to a regular authenticated client, by design) - that key must
// never ship inside the mobile app bundle, so this function is the only
// place it's used, same general shape as scripts/create-admin-user.mjs but
// callable from the app instead of run by hand.
//
// Unlike the "approve" function (deliberately public, verify_jwt = false),
// this one keeps the platform's default JWT verification ON - only a
// genuinely signed-in user can reach this code at all. On top of that, the
// caller's admin-ness is re-checked here server-side against their real
// `profiles` row (never trusted from the request body) - the actual
// security boundary is this function, not whether the app happens to hide
// the "New technician" button from non-admins.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// GoTrue doesn't expose a single stable error code for every case across
// versions - classify by both `code` (when present) and a lowercased
// message match, so this degrades gracefully rather than falling through
// to a generic "something went wrong" for the two cases an admin will
// actually hit in practice.
function classifyCreateError(error: { code?: string; message?: string }): "email_taken" | "weak_password" | "create_failed" {
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  if (code === "email_exists" || message.includes("already been registered") || message.includes("already registered")) {
    return "email_taken";
  }
  if (code === "weak_password" || message.includes("password")) {
    return "weak_password";
  }
  return "create_failed";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  // Scoped to the caller's own JWT - used only to confirm who's calling and
  // read their own profile under the normal "profiles: read within tenant"
  // RLS policy. Never used to create the new user; that needs the service
  // role client below.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const { data: callerProfile, error: profileError } = await callerClient
    .from("profiles")
    .select("role, tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (profileError || !callerProfile) return json({ error: "unauthorized" }, 401);
  if (callerProfile.role !== "admin") return json({ error: "forbidden" }, 403);

  let body: { full_name?: string; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const { full_name: fullName, email, password } = body;
  if (!isNonEmptyString(fullName)) return json({ error: "full_name_required" }, 400);
  if (!isNonEmptyString(email)) return json({ error: "email_required" }, 400);
  if (!isNonEmptyString(password)) return json({ error: "password_required" }, 400);

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // user_metadata shape matches scripts/create-admin-user.mjs exactly -
  // handle_new_user() (see supabase/migrations/20260720000100_init_schema.sql)
  // reads these three keys off raw_user_meta_data to build the matching
  // profiles row. tenant_id is the CALLER's own tenant (looked up above,
  // never taken from the request), which is what actually makes this "the
  // same tenant as the admin who created them" rather than something the
  // client could spoof.
  const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: {
      tenant_id: callerProfile.tenant_id,
      role: "technician",
      full_name: fullName.trim(),
    },
  });

  if (createError) {
    // Never log the password, and never echo the raw GoTrue error message
    // back to the client - classify it into a small closed set instead.
    console.error("[create-technician] Failed to create user", createError.message);
    return json({ error: classifyCreateError(createError) }, 422);
  }

  return json({ ok: true, id: createData.user?.id });
});
