# Setup: provisioning the real services

The repo is scaffolded against placeholder config. Nothing runs until you provision
your own Supabase project, PowerSync instance, and (later, for email/calendar) a
Google Cloud OAuth client, and fill in the resulting values in `apps/mobile/.env`.

## 1. Prerequisites

- Node 20+, pnpm (`corepack enable` will pick up the pinned version)
- A free [Expo](https://expo.dev) account, for [EAS Build](https://docs.expo.dev/build/introduction/)
  (`npm install -g eas-cli`, then `eas login`) - **not** the Expo Go app. PowerSync
  requires a native SQLite module that Expo Go can't load; see step 6.
- An Android phone (or emulator) to install the development build on
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

## 6. Build and install a development build

Neither Expo Go nor the web build work for this project once PowerSync is in the
loop:

- **Expo Go can't run it.** PowerSync's React Native SDK needs
  `@journeyapps/react-native-quick-sqlite`, a native module - Expo Go only ships
  with a fixed set of pre-bundled native modules and can't load custom ones.
  Trying anyway fails with `Could not resolve
  @journeyapps/react-native-quick-sqlite` followed by every route erroring out.
- **The web build doesn't work either** - `@journeyapps/react-native-quick-sqlite`
  has no web implementation, so `pnpm --filter mobile web` / pressing `w` will
  fail the same way. PowerSync does support web via a separate
  `@powersync/web` package (WASM SQLite), but that's additional setup this repo
  hasn't done yet - a real gap, not just an inconvenience (see known gaps below).
  The "desktop app" story (Tauri wrapping a web build) is blocked on this too.

What you need instead is a **development build**: a real app binary, built once
via EAS's cloud build service (no local Android Studio needed), installed
directly on the device, and reused for everyday development from then on -
regular code changes still hot-reload through it exactly like Expo Go would.
You only need to rebuild if you add or change a native dependency.

```bash
cd apps/mobile
eas login                                        # once, if you haven't already
eas build --profile development --platform android
```

This uses the `development` profile in `apps/mobile/eas.json` (internal
distribution, produces an installable `.apk` rather than a Play Store `.aab`).
When the build finishes, EAS prints a link/QR code - open it on the phone and
install the APK directly (you'll need to allow installs from unknown sources
the first time).

Then, same as any Expo project:

```bash
pnpm install
pnpm --filter mobile dev
```

Open the app you just installed on the phone - it connects to this dev server
the same way Expo Go would, just with the native SQLite module actually
present this time.

## 7. Try the vertical slice

1. Sign in with the admin account you created in step 3, inside the
   development build installed in step 6 (not Expo Go, not the web build).
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
- To check the per-technician sync scoping (see the known-gaps note below),
  sign in as a technician on a second device (or an Android emulator with the
  same development build installed), assign yourself (as admin) to one job
  card, and confirm that device only ever shows that one job card and its own
  notes/tasks - not the rest of the tenant's jobs - even after a full
  reinstall and fresh first sync.

## Known gaps / next steps

- **PowerSync connection stuck in a loop after sign-in - fixed**: confirmed
  against a real Android device (once the dev-build fix below let the app
  actually run) - after signing in, the app sat on "Setting up your account"
  forever, with nothing in the Metro logs but PowerSync's own `Trying to
  close for the second time` warning repeated indefinitely. Root cause,
  confirmed by reading `@powersync/common`'s actual source rather than
  guessed: the `useEffect` in `auth-context.tsx` that calls
  `connectPowerSync()` depended on the Supabase `session` *object*, which
  gets replaced with a new reference on more than just sign-in/out -
  notably the immediate `INITIAL_SESSION` emission right after subscribing,
  and periodic `TOKEN_REFRESHED` events. PowerSync's `ConnectionManager`
  treats every `connect()` call as "abort whatever's in flight and restart
  with the latest parameters" (by design, for legitimate reconnect
  scenarios), so the extra, spurious `connect()` calls meant the sync
  connection kept getting aborted before it could ever finish - it never
  crashed, it just never completed. Fixed by keying the effect on
  `session?.user.id` instead (a stable string that only changes on an
  actual sign-in/sign-out/user-switch), and confirmed `connector.ts`'s
  `fetchCredentials` was already doing the right thing independently
  (fetches a fresh Supabase token on every call, not a stale closed-over
  value) - PowerSync's SDK calls that itself whenever it needs a new token,
  so the effect never needed to force a reconnect for token refresh anyway.
  Also added dev-gated debug logging (`apps/mobile/lib/powersync.ts`, via
  `@powersync/common`'s `createBaseLogger()` - confirmed against the
  installed package's actual API, not assumed) so a similar issue would
  surface PowerSync's own connection-attempt logs instead of just the bare
  warning next time. **This fix is confirmed from reading the actual
  PowerSync source (`ConnectionManager.connect()`'s documented
  abort-and-restart behavior, and the exact `Trying to close for the second
  time` string traced to its RSocket transport layer), not a guess - but it
  still needs to be verified on the real device again, since there's no way
  to test an actual PowerSync connection from this sandboxed session (same
  network policy gap noted throughout this doc).**
- **Debug logging added above produced zero output on device - fixed**:
  after pulling the fix and doing a full fresh reload with a cleared Metro
  cache, the app still showed only the bare `Trying to close for the
  second time` warning - not even a single DEBUG-level connection-attempt
  line. Traced to `js-logger` (the library `createBaseLogger()` wraps):
  its built-in `useDefaults()` handler hardcodes `console.debug` as the
  console method for `LogLevel.DEBUG` specifically (confirmed by reading
  `js-logger`'s actual source, `createDefaultHandler`'s console-method
  selection). Separately confirmed that React Native's own JS shim for
  forwarding console output to the Metro terminal
  (`setUpDeveloperTools.js`) only runs when `console._isPolyfilled` is
  set, which is a legacy JSC-only flag - Hermes (this project's engine)
  doesn't set it, so that forwarding path is dead code here and log
  forwarding instead depends on Hermes's own native console handling,
  which this session has no way to verify treats `console.debug` the same
  as `console.log`/`warn`/`error`. Rather than guess, `powersync.ts` now
  uses `logger.setHandler(...)` with a custom handler instead of
  `useDefaults()`, so DEBUG/INFO/TRACE-level messages always go through
  `console.log` (WARN/ERROR still go through `console.warn`/`console.error`,
  which are already confirmed to reach the terminal). **The `console.debug`
  root cause is confirmed from `js-logger`'s source; whether it's the
  *complete* explanation for the zero-output symptom is not fully provable
  from this sandbox (Hermes's native console behavior isn't something we
  can inspect here) - but the fix removes the dependency on that unverified
  behavior either way. Needs real-device re-verification.**
- **Expo Go / web can't run this app - fixed with a development build**:
  confirmed against a real Android device - `@journeyapps/react-native-quick-sqlite`
  (PowerSync's native SQLite module, required by `@powersync/react-native`) was
  missing from `apps/mobile/package.json` entirely, and even once present it's a
  native module Expo Go can't load. Fixed by adding the dependency explicitly,
  adding `expo-dev-client` (+ its plugin entry in `app.json`), and adding
  `apps/mobile/eas.json` with a `development` build profile (internal
  distribution, Android APK) - see the rewritten step 6 above. Not added:
  a plugin entry for `@journeyapps/react-native-quick-sqlite` itself - its
  config plugin only does something on iOS with `use_frameworks!` enabled
  (confirmed by reading the plugin's source, which just wires up
  `withUseFrameworks`), and this project doesn't set that iOS option; revisit
  if `useFrameworks` is ever turned on. Also not verified: the exact current
  EAS CLI version - `eas.json`'s `cli` block deliberately omits a `version`
  pin rather than guess one, since this sandbox couldn't reach EAS to check
  (same network policy gap as the Supabase provisioning session below) - EAS
  CLI will fill it in the first time `eas build:configure` or `eas build` runs
  locally.
- **Web support for PowerSync**: `@journeyapps/react-native-quick-sqlite` has
  no web implementation, so the web build (`pnpm --filter mobile web` /
  pressing `w`) fails the same way Expo Go does. PowerSync does support web via
  a separate `@powersync/web` package (WASM SQLite over IndexedDB), but wiring
  up a platform-specific PowerSync database factory (native SQLite on
  mobile, WASM on web) hasn't been done - a real gap, not just an
  inconvenience, since it blocks the desktop (Tauri-wraps-web) story below too.
- **Desktop (Tauri)**: not scaffolded yet by design (see the mobile-first
  decision on this branch) - also now blocked on the web PowerSync gap above,
  in addition to Tauri itself not being scaffolded.
- **Gmail/Calendar Google integration**: `calendar_events` has
  `google_calendar_id`/`google_event_id`/`last_synced_at` columns and the
  calendar UI tolerates them being null (shows "Not synced with Google
  Calendar yet"), but nothing writes to them - two-way sync and Gmail sending
  are still unbuilt. Email sending isn't started at all yet.
- **Tenant-wide local sync vs. per-technician RLS - fixed**: `powersync/sync-rules.yaml`
  used to download a tenant's *entire* `job_cards`/`job_notes`/`job_files`/`tasks`
  tables to every device. It's now split by role: admins still get the full
  tenant (`admin_job_data` bucket), technicians get a bucket instantiated
  per job card assigned to them (`technician_assigned_jobs`, which also
  scopes that job's own notes and files - full nested scoping, not just
  `job_cards` itself) plus tasks assigned directly to them
  (`technician_own_tasks`). `clients`/`client_sites`/`profiles` remain
  tenant-wide for everyone, unchanged, since any tech can look up any
  client on site. One deliberate loose end: neither technician bucket's
  parameter query excludes admins by role (that would need a join against
  `profiles` inside the parameter query - kept out since there's no way to
  confirm PowerSync's sync-rules SQL parser accepts a join there without a
  live instance, and none is provisioned in this environment). Harmless in
  practice - if an admin is ever also someone's `assigned_technician_id`
  (e.g. the business owner doing field work themselves), they'd just
  receive that data via an extra bucket path, not extra *data*, since
  `admin_job_data` already gives them everything. Worth a quick sanity
  check against a real PowerSync instance once one's provisioned, in case
  joins in parameter queries turn out not to be supported.

  What *was* validated here: this sandbox has a real Postgres 16 install
  (no Docker, so the usual `supabase start` local dev flow doesn't work,
  but the `postgres`/`postgresql-client` packages are present), so every
  migration - including the new one below - was run end-to-end against a
  throwaway database with hand-built stubs for the Supabase-specific bits
  (`auth.uid()`, `auth.users`, `storage.foldername()`, the
  `authenticated`/`anon` roles and their default grants). All three
  migrations applied cleanly, and every query in `powersync/sync-rules.yaml`
  (with `bucket.*`/`request.user_id()` swapped for literal test values) ran
  without error against the real schema - including confirming end-to-end
  that a job card assigned to a technician is what
  `technician_assigned_jobs`'s parameter query returns, and that a
  `job_notes` row scoped by that job's id returns only that job's own note.
  This is real verification of the SQL, just not of PowerSync's own bucket
  evaluation, which only the actual sync service can do.
- **Quote/invoice line item edits - fixed**: saving edited line items on
  `app/quotes/[id].tsx` / `app/invoices/[id].tsx`, and converting a quote to
  an invoice, used to be two separate Supabase calls each (delete-then-insert,
  or insert-invoice-then-insert-line-items) - a failure between the two could
  leave a quote/invoice with mismatched or missing line items. Both are now
  single atomic Postgres RPC calls
  (`supabase/migrations/20260721000100_atomic_line_item_rpcs.sql`:
  `replace_quote_line_items`, `replace_invoice_line_items`,
  `convert_quote_to_invoice`), which also recompute totals server-side from
  the line items actually being stored rather than trusting client-supplied
  totals. Functionally tested against the real Postgres 16 instance
  mentioned above: as a technician, `replace_quote_line_items` is correctly
  rejected by RLS ("new row violates row-level security policy"); as the
  admin, it correctly recomputes and persists totals (verified against a
  hand-computed expected value), and calling it a second time with a
  different item set *replaces* rather than appends (line item count and
  totals both update to match the new set, not the old plus the new).
  `convert_quote_to_invoice` was verified to produce an invoice whose
  totals and line items match the quote's at conversion time.
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
