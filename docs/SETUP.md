# Setup: provisioning the real services

The repo is scaffolded against placeholder config. Nothing runs until you provision
your own Supabase project, PowerSync instance, and (later, for email/calendar) a
Google Cloud OAuth client, and fill in the resulting values in `apps/mobile/.env`.

## 1. Prerequisites

- Node 20+, pnpm (`corepack enable` will pick up the pinned version)
- The [Expo Go](https://expo.dev/go) app on your phone (fastest way to test on a
  real device), or Xcode/Android Studio for a simulator
- A free [Supabase](https://supabase.com) account
- A [PowerSync](https://powersync.com) account (free tier is fine for Phase 1)

## 2. Create the Supabase project

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Under **Project Settings > API**, copy the **Project URL** and **anon public** key -
   you'll need these for `apps/mobile/.env`.
3. Run the migrations against your project. Easiest via the Supabase CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR-PROJECT-REF
   npx supabase db push
   ```

   This applies everything in `supabase/migrations/` in order: the schema, RLS
   policies, and the `job-files` storage bucket + its policies.

4. Seed the Phase 1 tenant row:

   ```bash
   npx supabase db execute -f supabase/seed.sql
   ```

   (Or paste `supabase/seed.sql` into the SQL Editor in the dashboard.) This inserts
   one `tenants` row with a fixed id (`00000000-0000-0000-0000-000000000001`) for
   Bingley Roof Consulting - referenced below when creating your admin account.

## 3. Create your admin account

Phase 1 has no public sign-up (by design - see the core requirements). You create
accounts directly via the Supabase Admin API, which also lets you set
`tenant_id`/`role`/`full_name` in `raw_user_meta_data` so the `handle_new_user`
trigger (in `20260720000100_init_schema.sql`) provisions the matching `profiles`
row automatically.

Run this once (Node, with your **service role key** - Project Settings > API -
never ship this key in the app):

```js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://YOUR-PROJECT-REF.supabase.co",
  "YOUR-SERVICE-ROLE-KEY" // service_role, not anon - keep this out of the app/repo
);

await supabase.auth.admin.createUser({
  email: "you@example.com",
  password: "choose-a-password",
  email_confirm: true,
  user_metadata: {
    tenant_id: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    full_name: "Elyas Bingley",
  },
});
```

Repeat with `role: "technician"` for each tech's account once you're ready to add them.

## 4. Create the PowerSync instance

1. Sign up at [powersync.com](https://powersync.com) and create a new instance,
   connecting it to your Supabase project (PowerSync's Supabase integration guide
   walks through the exact steps - it needs read access to your Postgres database
   via a replication slot).
2. In the instance's **Sync Rules** editor, paste the contents of
   `powersync/sync-rules.yaml` and deploy it.
3. Copy the instance's connection URL (Instance > Edit instance) for
   `apps/mobile/.env`.

## 5. Fill in `apps/mobile/.env`

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Fill in the three `EXPO_PUBLIC_*` values from steps 2 and 4. These are safe to
expose in the client bundle (anon key + PowerSync endpoint, both meaningless
without a valid RLS-scoped session).

## 6. Run it

```bash
pnpm install
pnpm --filter mobile dev
```

Scan the QR code with Expo Go, or press `w` in the terminal to open the web build
(useful for a quick check without a device - remember the "desktop app" later on
is this same web build wrapped in Tauri).

## 7. Try the vertical slice

1. Sign in with the admin account you created in step 3.
2. Create a client, then a job card for that client.
3. Open the job card, add a note, and attach a photo (camera or library).
4. Turn on airplane mode and repeat - notes, job cards and photos should all
   still work; photos show "Syncing..." until they upload.
5. Turn airplane mode back off. Within a few seconds the queued writes and
   photo should sync to Supabase - check the `job_cards`/`job_notes` tables and
   the `job-files` storage bucket in the dashboard to confirm.

## 8. Try Tasks, Quotes/Invoices, and Calendar

Use the nav strip at the top of the Clients/Tasks/Quotes/Invoices/Calendar
list screens to move between sections.

- **Tasks** work offline the same way job cards do (PowerSync-synced) -
  create a standalone task or one linked to a job card, tap its status chip
  to cycle `todo -> in_progress -> done`, and it'll queue and sync like any
  other offline write.
- **Quotes and invoices** are Supabase-direct and need a connection - turn on
  airplane mode on one of these screens to see the "No connection" state
  instead of a silent failure. Create a quote with a few line items, watch
  the GST-inclusive total update live, then use "Convert to invoice" to copy
  it into a new invoice.
- **Calendar** is also online-only. Create an event and optionally link it to
  a job card or task; a technician can edit an event only if it's linked to
  a job/task assigned to them (matching the `calendar_events` RLS policy),
  otherwise only the admin can.
- To try templates, insert a row into `templates` (`type: 'quote'` or
  `'invoice'`, `default_line_items` as a JSON array matching the line item
  shape) via the SQL editor, then use "Load from template" on the new
  quote/invoice screen.

## Known gaps / next steps

- **Desktop (Tauri)**: not scaffolded yet by design (see the mobile-first
  decision on this branch) - the plan is to wrap this same Expo web build once
  the core workflow is validated on mobile.
- **Gmail/Calendar Google integration**: `calendar_events` has
  `google_calendar_id`/`google_event_id`/`last_synced_at` columns and the
  calendar UI tolerates them being null (shows "Not synced with Google
  Calendar yet"), but nothing writes to them - two-way sync and Gmail sending
  are still unbuilt. Email sending isn't started at all yet.
- **Tenant-wide local sync vs. per-technician RLS**: the PowerSync sync rule
  in `powersync/sync-rules.yaml` downloads a tenant's *entire* `tasks` and
  `job_cards` tables to every device, not just what's assigned to that
  technician - `app/tasks/index.tsx` and the job card list apply the "assigned
  to me" filter client-side in the query, but the data physically sits in
  local SQLite on a technician's device even though Postgres RLS would block
  them from fetching another tech's jobs directly. Fine for a small trusted
  crew in Phase 1; revisit with per-technician bucket filtering (documented
  as a deferred option in the sync rules file) if the crew grows or this
  becomes a real privacy concern.
- **Quote/invoice line item edits aren't transactional**: saving edited line
  items on `app/quotes/[id].tsx` / `app/invoices/[id].tsx` deletes the
  existing `quote_line_items`/`invoice_line_items` rows and re-inserts the
  edited set as two separate Supabase calls, not one transaction - a failure
  between the two would leave a quote/invoice with no line items. The correct
  fix is a Postgres RPC function to do it atomically, which is a schema
  change and so wasn't added without checking first.
- **No native date/time picker**: calendar event start/end times are plain
  "YYYY-MM-DD" + "HH:MM" text fields (`app/calendar/new.tsx`,
  `app/calendar/[id].tsx`), matching the plain-text date fields already used
  for due dates and quote/invoice expiry - functional, but a real date/time
  picker (`@react-native-community/datetimepicker` or similar) would be a
  natural follow-up and wasn't added here to avoid introducing a new native
  dependency mid-task.
- **Client/job-card/template pickers are simple filtered lists**: fine at
  Phase 1's scale (one small business), not paginated or virtualized - revisit
  if client/job counts grow large enough to matter.
- **`react-native-worklets` peer warning**: `pnpm install` reports an unmet peer
  range from `expo-modules-core`. This sandbox's network policy blocks the Expo
  CLI's compatibility-check endpoint, so `npx expo install --fix` couldn't be run
  to reconcile it here - run it once you have normal network access to pick the
  exact version Expo SDK 57 expects.
- **PowerSync attachments API**: `apps/mobile/lib/attachments.ts` and the
  `AttachmentTable` in `packages/shared/src/powersync/schema.ts` use
  `@powersync/common`'s built-in attachment queue, which is still marked
  `@experimental`/`@alpha` upstream as of v1.57. Pin the PowerSync version
  deliberately when upgrading and check their changelog for breaking changes
  to this API specifically.
