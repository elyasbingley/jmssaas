// Provisions the first admin account (or any admin/technician account) for
// a Phase 1 tenant, matching the flow in docs/SETUP.md section 3. Run this
// locally / from a machine with normal network access - it needs to reach
// your Supabase project directly and uses the service_role key, which must
// never be committed or passed through this repo's CI logs.
//
// Usage:
//   SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
//   ADMIN_EMAIL=you@example.com \
//   ADMIN_PASSWORD='choose-a-strong-password' \
//   ADMIN_FULL_NAME='Elyas Bingley' \
//   node scripts/create-admin-user.mjs
//
// Optional: ADMIN_ROLE=technician (defaults to "admin"), TENANT_ID to
// override the default Phase 1 tenant id seeded by supabase/seed.sql.

import { createClient } from "@supabase/supabase-js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const fullName = process.env.ADMIN_FULL_NAME;
const role = process.env.ADMIN_ROLE ?? "admin";
const tenantId = process.env.TENANT_ID ?? DEFAULT_TENANT_ID;

const missing = Object.entries({
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  ADMIN_EMAIL: email,
  ADMIN_PASSWORD: password,
  ADMIN_FULL_NAME: fullName,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  process.exit(1);
}

if (!["admin", "technician"].includes(role)) {
  console.error(`ADMIN_ROLE must be "admin" or "technician", got: ${role}`);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: {
    tenant_id: tenantId,
    role,
    full_name: fullName,
  },
});

if (error) {
  console.error("Failed to create user:", error.message);
  process.exit(1);
}

console.log(`Created ${role} user ${data.user.email} (id: ${data.user.id}) in tenant ${tenantId}.`);
console.log("The handle_new_user trigger should have created a matching profiles row - verify in Table Editor.");
