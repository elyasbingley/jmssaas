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

Sign-in now lands on a Home screen with a tile per section (Jobs, Quotes,
Invoices, Tasks, Clients, Calendar); the same sections are also always
reachable via the bottom tab bar.

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
- **No native date/time picker - fixed**: every plain-text date field in the
  app (due dates, quote/invoice expiry/due dates, calendar start/end) now
  uses `DateField` (`components/DateField.tsx`), a tappable picker built on
  `@react-native-community/datetimepicker`, installed via `pnpm add` and
  confirmed compatible by checking the installed package's own
  `peerDependencies` against this project's Expo/React Native versions
  (`expo: ">=52.0.0"`, satisfied by the installed `expo@57.0.7`) rather than
  assumed. Android has no combined date+time native picker, only separate
  date and time dialogs, so calendar events (which need both) show them as
  two sequential steps there; iOS's inline picker supports both in one
  control. **This needs real-device re-verification** - the same sandbox
  network-policy gap noted throughout this doc means there's no way to
  actually open a native date picker from here.
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

## UX overhaul pass (labels, date pickers, numbering, navigation, calendar, camera)

This was a large, single pass across the whole app's UI/UX, described up
front as "the bare minimum for today" with further polish expected in a
follow-up round. What follows documents the judgment calls made (three were
flagged explicitly as needing reasoning, not a silent pick) and what's
scoped down or still needs real-device verification.

- **Sequential reference numbers - job cards/tasks vs. quotes/invoices**:
  quotes (`QT001`...) and invoices (`INV001`...) are created online-only, so
  a straightforward per-tenant counter assigned by a Postgres trigger on
  insert is safe - there's never more than one in-flight insert racing for
  the next number. Job cards (`J001`...) and tasks (`TSK001`...) are
  offline-capable via PowerSync, so two technicians could each create one
  while both offline; a naive "highest existing number + 1 computed on the
  device" approach would let both compute the same number and collide the
  moment they sync back up. The chosen approach is **reconcile on sync, not
  on-device**: the `number` column starts NULL on every job card/task and is
  only ever assigned by the same trigger mechanism, running in Postgres when
  the row's upload lands there - never computed by the app. Two technicians
  creating job cards offline at the same moment can't collide, because by
  the time either row is actually assigned a number, the trigger has already
  serialized the two inserts. The tradeoff: an offline-created job
  card/task shows "Pending sync" instead of a number until the device
  reconnects and that row round-trips through a sync - never a fabricated or
  possibly-wrong number. No manual-renumber fallback UI was built, because
  with this design a genuine collision isn't actually possible - there'd be
  nothing to renumber. See the long comment block at the top of
  `supabase/migrations/20260723000100_ux_overhaul.sql` for the full
  reasoning, and it was functionally verified (not just typechecked)
  against a local Postgres 16 instance: sequential per-tenant numbers,
  correctly isolated between tenants, and the `convert_quote_to_invoice` RPC
  auto-assigning an invoice number too.
- **Task notes/files - separate tables, not polymorphic**: `task_notes` and
  `task_files` mirror `job_notes`/`job_files` exactly rather than a single
  polymorphic "notes"/"files" table with a `parent_type` column. The
  codebase already has one such pair (job cards); a polymorphic table would
  still need to look up the parent row in every RLS policy to check
  assignment, so it wouldn't actually simplify anything - it would just
  trade two statically-typed tables for one with a runtime-checked
  discriminant. Both tables carry denormalized `job_card_id`/`assigned_to`
  columns (copied from the parent task by a trigger on insert) rather than
  requiring a join in PowerSync sync rules, since `powersync/sync-rules.yaml`
  already notes that join support in sync-rule *data* queries isn't
  confirmed against a real PowerSync instance from this sandbox - the same
  caution applied to job_notes/job_files originally is applied consistently
  here. Job card and task photo attachments share one `AttachmentQueue` and
  one local `attachments` table (see `packages/shared/src/powersync/schema.ts`),
  since PowerSync's queue is keyed by attachment id, not by which parent
  table it belongs to.
- **Client primary address vs. `client_sites`**: `client_sites` already
  modeled job-site addresses (a client can have several, each optionally
  flagged `is_primary`). The address added to `clients` directly is a
  different concept - a single "this is where the client is" field that's
  on file the moment a client is created, without forcing a `client_sites`
  row to exist just to record an address for the common case (one
  residential client, one address). Job cards were **not** given their own
  address column: a job's site address is already covered by `site_id` (a
  `client_sites` row) when one's picked, and by the client's own new address
  field as a sensible default otherwise (shown read-only in the job creation
  flow, not re-entered - see "auto-populate" below) - adding a third,
  independent address field on `job_cards` itself would just be a place for
  the other two to drift out of sync with, not a real gap.
- **Auto-populate on job creation**: job cards have always referenced
  `client_id` rather than storing a separate copy of the client's
  name/address/email/phone, so there was never actually a place where those
  needed retyping - the "auto-populate" work here is making that fact
  visible in the UI: both job-creation flows (from a client's own page, and
  from the Jobs tab's client picker) now show a read-only summary of the
  picked client's contact details the moment a client is selected.
- **Native dependencies added this pass need a fresh dev build**:
  `@react-native-community/datetimepicker` and `expo-camera` are native
  modules with config plugin entries now in `app.json` - like the earlier
  PowerSync SQLite dependency, a JS-only reload isn't enough, you need
  `eas build --profile development --platform android` again (see step 6
  above) before any of the date pickers or the new camera screen will work
  on device. Not attempted in this session, same reasoning as before (no
  Expo login/network access from this sandbox).
- **Calendar month/week/day/year views read the whole event table**: fine
  at Phase 1 scale, but `app/(tabs)/calendar/index.tsx` fetches every
  calendar event and filters by date client-side rather than querying a
  date-range - revisit with a range-scoped fetch if event volume grows
  enough to matter (same category of scoped-down decision as the
  unpaginated client/job pickers noted above).
- **Calendar guests field is free text, not real invitations**: `guests` on
  a calendar event is a plain comma-separated text field, not validated
  email addresses and not wired to any invitation/notification mechanism -
  matches the existing Google Calendar sync gap noted below (no Google
  Calendar integration yet at all), so "guests" is metadata for now, not a
  functioning feature.
- **Custom camera screen (`MultiCaptureCamera`) is unstyled/minimal**: takes
  photos in one continuous session (the actual ask - not closing after each
  shot) with a thumbnail strip and Done/Cancel, but has no flash toggle,
  front/back camera switch, or zoom control. Flagged as a smaller polish
  item per the "bare minimum for today" framing rather than gold-plated
  here.
- **Everything in this pass is confirmed from source/typecheck/local-Postgres
  testing, not a live device**: same recurring constraint as the rest of
  this doc - this sandbox's network policy blocks Supabase, PowerSync and
  EAS, so none of the new UI (date pickers, camera, calendar views, the tab
  bar's native transitions) has been seen running on an actual phone. The
  Postgres-level changes (numbering, RLS, storage policies) were
  functionally verified against a real local Postgres 16 instance, which is
  a stronger check than typechecking alone but still not the same as an
  on-device pass.

## Follow-up UI fixes + edit everywhere

This pass followed the first live retest of the UX overhaul above, once the
`20260723000100_ux_overhaul.sql` migration was confirmed live on the real
Supabase project (`supabase db push`, applied cleanly, sync confirmed
working). Six items came out of that retest:

- **Calendar event creation error handling**: traced rather than assumed -
  `@supabase/postgrest-js@2.110.7`'s `PostgrestError` class was confirmed (by
  reading its source directly) to extend `Error`, so the pre-existing
  `e instanceof Error` check in `calendar/new.tsx` was already surfacing the
  real Postgres/PostgREST message, not swallowing it down to the generic
  fallback. The original "Failed to create event" report most likely
  predates the migration going live (it added the `location`/`guests`
  columns this screen writes to). Regardless, error reporting was improved
  per the explicit instruction to do so: a new `apps/mobile/lib/errors.ts`
  helper (`getErrorMessage`) appends `.hint` when present - Postgrest's own
  doc comment calls `hint` "often the single most useful field" for
  diagnosing a failure - and both `calendar/new.tsx` and `calendar/[id].tsx`
  now `console.error` the full error object before showing the formatted
  message, so `code`/`details` are available in the console even when hint
  alone isn't enough.
- **Edit-everywhere audit**: every entity was checked against "does it have
  a working edit path, not just create/view":
  - Clients - **was missing**, now added (`clients/[id].tsx`): an Edit link
    opens a `CenteredModal` pre-filled with the client's current
    name/phone/email/address/notes, reusing the same `FormField` layout as
    client creation, saved back to the same row via `powersync.execute`.
  - Job cards - **was missing** (title/description), now added
    (`jobs/[id].tsx`): same `CenteredModal`/`FormField` pattern, validated
    with `createJobCardSchema`.
  - Tasks - **was missing** (title/description/due date), now added
    (`tasks/[id].tsx`): same pattern, validated with `createTaskSchema`,
    reusing `DateField` for the due date.
  - Quotes and invoices - **verified already fully editable**, not assumed:
    both screens (`quotes/[id].tsx`, `invoices/[id].tsx`) already have a
    "Save changes" flow covering notes, expiry/due date, and line items via
    the `LineItemEditor` + `replace_*_line_items` RPCs added in an earlier
    pass. No changes needed.
  - Calendar events - **verified already fully editable**, not assumed:
    `calendar/[id].tsx` already supports editing title, description,
    location, guests, and start/end via `DateField`, gated by `canEdit`
    (admin or the assigned technician/task owner). No changes needed.
  - RLS was checked, not assumed, for each newly-added edit path: `clients`,
    `job_cards`, and `tasks` all have an `update own or admin` (or
    equivalent tenant-scoped) policy with no admin-only restriction, so none
    of the three new Edit buttons needed role-gating - consistent with the
    existing ungated status-change controls on the same screens.
  - Job detail screen also gained a client summary near the top (name,
    phone, formatted address, tappable through to `/clients/:id`), fetched
    via a `useQuery<Client>` on `job.client_id` - this was the specific gap
    called out (job list already showed the client; job detail didn't). A
    shared `formatClientAddress` helper (`apps/mobile/lib/format.ts`) keeps
    the client and job detail screens' address formatting from drifting
    apart.
- **Camera controls (zoom/flip/flash)**: verified against the installed
  `expo-camera@57.0.3` type declarations directly (not assumed from training
  data, per this app's `AGENTS.md`) rather than an older prop shape:
  `facing?: 'front' | 'back'`, `flash?: 'off' | 'on' | 'auto' | 'screen'`,
  and `zoom?: number` (0-1, "a percentage of device's max zoom" per its own
  doc comment - not a calibrated optical multiplier). `MultiCaptureCamera`
  now has a front/back toggle (`facing`), a flash mode toggle cycling
  off/on/auto (`flash`), and four zoom preset buttons (0.5x/1x/2x/5x)
  mapped to fixed points in that 0-1 range.
  **Known tradeoff**: expo-camera's `zoom` prop has no cross-device way to
  learn the device's actual maximum zoom factor, so the preset values
  (`0`, `0`, `0.25`, `0.6`) are a reasonable approximation, not a true
  0.5x/1x/2x/5x. More significantly, the prop can only zoom *in* from the
  default lens - there's no way to go wider than 1x through it (that would
  need switching to an ultra-wide lens via the separate, iOS-only
  `selectedLens` prop and `getAvailableLensesAsync()`, whose returned lens
  identifiers aren't portable across devices/platforms in a way that could
  be reliably mapped to a "0.5x" label). Rather than omit the 0.5x button
  (which a normal camera app always shows) or build fragile per-platform
  lens-ID matching, 0.5x is mapped to the same zoom value as 1x - it's a
  no-op on this API, documented here rather than silently guessed past.
- **Home screen status bar overlap**: `app/(tabs)/_layout.tsx` sets
  `headerShown: false` on the whole `Tabs` navigator, and the Home tab
  (`(tabs)/index.tsx`) is the only screen mounted directly under it with no
  native header of its own - every other tab (Jobs, Quotes, Invoices,
  Tasks, Clients, Calendar) wraps its screens in its own `Stack` with a
  default (shown) header, which already accounts for the safe area. So only
  Home needed a fix: its root `View` was swapped for `SafeAreaView` (from
  `react-native-safe-area-context`, `edges={["top"]}`) so the header no
  longer renders under the status bar/notch. `SafeAreaProvider` was already
  present at the app root (`app/_layout.tsx`), just unused by any screen
  until now. The login screen and the two loading/first-sync states in
  `app/_layout.tsx` were checked and don't need the same fix - their
  content is vertically centered rather than flush to the top, so there's
  nothing to sit under the notch.

## Bug fixes, price book, line-item redesign, PDF generation, nav restructure

A large six-phase pass. Phases were worked in dependency order (Phase 2's
line-item shape before Phase 3/5, which build on it; Phase 6 was actually
built *before* finishing Phase 5, despite the numbering, because Phase 6 was
explicitly framed as existing "just enough to support Phase 5" - the PDF
needs real company name/ABN/bank details, not blank placeholders).

- **Phase 1 findings**:
  - **Calendar list not updating after creation** - root cause identified
    by code reading: `useSupabaseFetch` (the hook behind the online-only
    quotes/invoices/calendar screens) only fetched on mount. List screens
    like `calendar/index.tsx` stay mounted in their tab's Stack while you
    push into a create/detail screen, so a newly-created row was invisible
    until something else remounted the list. Fixed with a new
    `useRefetchOnFocus` helper (`expo-router`'s `useFocusEffect`), applied
    to the three list screens (calendar, quotes, invoices) and to the job
    detail screen's linked-quotes/invoices, which had the identical bug.
    Deliberately **not** folded into `useSupabaseFetch` itself - several
    detail/edit screens (quote/invoice/event detail) seed local editable
    state from the fetched data via `useEffect`, so a blanket focus-refetch
    there would silently discard an unsaved in-progress edit the moment the
    user navigated to a linked screen (e.g. "View linked job") and back.
  - **DateTimePicker deprecation warning** - confirmed via the installed
    `@react-native-community/datetimepicker@9.1.0` type declarations that
    `onChange` is deprecated in favour of separate `onValueChange` (fires
    only on an actual selection, with a non-optional `date`) and `onDismiss`
    handlers. `DateField.tsx` updated to the new API.
  - **"Quote creation doesn't work"** - could not literally reproduce
    against live Supabase (this sandbox's network policy still blocks it,
    same recurring constraint as every earlier pass). Code review found a
    real, confirmed bug instead: `jobs/[id].tsx`'s "+ New quote/invoice for
    this job" buttons weren't admin-gated, unlike the tab-level "+ New
    quote" FAB - a non-admin technician could reach the create form, fill
    it out correctly, and get rejected by the `admin writes - insert` RLS
    policy on submit, surfacing as a raw Postgres RLS error. Fixed the
    gating to match the tab-level FAB, and improved error surfacing on both
    create flows (shows `.hint`, logs the full error) so any remaining
    failure is diagnosable from the message shown rather than a generic
    fallback string.
- **Phase 2 - line item redesign**: the quantity formula was confirmed with
  the person directly rather than guessed (the reference formula had no
  quantity term, but a quantity field was also requested):
  `Line Total = Qty x [(Labour Rate x Hours + Material Cost) x (1 + Markup%)]`.
  `unit_price_cents` is kept as a real column/field - it now holds that
  bracketed per-unit price, computed client-side
  (`computeLineItemUnitPriceCents` in `packages/shared/src/money.ts`) - so
  the existing GST/subtotal math (`quantity * unit_price_cents`, unchanged
  since Phase 1 of the original build) never needed to change at all, only
  what feeds it. Existing quote/invoice line items were backfilled by
  treating their old `unit_price_cents` as pure material cost with zero
  labour/markup (the person's own suggested default) - functionally
  verified against a real local Postgres 16 instance that this leaves every
  existing quote/invoice's stored totals unchanged to the cent (see
  `supabase/migrations/20260724000100_line_item_redesign.sql`'s header
  comment for why that's true by construction). The client-facing/internal
  split is a new `LineItemSummary` component (description/qty/rate/amount
  only) alongside the existing `LineItemEditor` (full breakdown, now with
  in-place-editable rate/hours/material/markup fields, extending the
  in-place editing the old editor already had for description/qty/price) -
  `quotes/[id].tsx` and `invoices/[id].tsx` show the summary to non-admins
  and the editor to admins. "Client-facing" is read as "non-admin", since
  this app has no separate client login/portal yet - the only actual
  client-facing artifact is the Phase 5 PDF, which reuses the same summary
  data.
- **Phase 3 - price book**: `price_book_categories` / `price_book_items` /
  `price_book_item_variations`, RLS copied from the already-proven
  quotes/quote_line_items shape (tenant-wide read, admin-only write) -
  functionally verified applying cleanly against local Postgres alongside
  every prior migration. Treated as another online-only, office/PC-workflow
  data set (`useSupabaseFetch`, not PowerSync) since only admins manage it
  and quote/invoice creation itself is already online-only. The "Add Line
  Item" search bar (new `AddLineItemBar` component) does a live, debounced
  `ilike` search rather than filtering an in-memory list like `PickerModal`
  does elsewhere, matching the reference "3+ characters" search UX and
  scaling better if the catalogue grows large. Selecting a result with
  variations opens a small picker (base pricing or a named variation)
  before pre-filling the line item; leaving the search blank and tapping
  "Add custom item" falls through to a blank line item exactly as before.
- **Phase 4 - navigation restructure**: Jobs/Quotes/Invoices/Clients/Price
  Book moved from five separate top-level tabs into one Sales tab with its
  own tile-grid landing screen (`(tabs)/sales/index.tsx`), matching Home's
  tile pattern. Tasks and Calendar were **not** part of the five sections
  named for combination, so they stay as their own top-level tabs alongside
  Home and Sales - a fifth tab slot is left available in the bar for a
  future Settings tab (not built - see Phase 6 below). Every internal route
  reference to a moved screen (`/jobs/:id` -> `/sales/jobs/:id`, etc. -
  there were 25+ across cross-links from earlier passes: job -> quote,
  quote -> invoice, quote/invoice -> linked job, client -> job, task ->
  linked job, calendar event -> linked job) was updated and the whole
  workspace re-typechecks clean. Price Book's own route folder (`items/`,
  `categories/`) was originally built as a top-level route outside the tabs
  group in Phase 3 specifically so it wouldn't risk auto-appearing as an
  unwanted tab-bar icon before Phase 4 had a real home for it; Phase 4 then
  moved that whole folder under `(tabs)/sales/price-book/` as planned.
- **Phase 5 - PDF generation**: **on-device generation was chosen**
  (`expo-print`'s `printToFileAsync` rendering an HTML/CSS template, shared
  out via `expo-sharing`), over a server-side approach (a Supabase Edge
  Function generating the PDF). Reasoning: Edge Functions run on Deno
  Deploy, a lightweight serverless runtime not suited to bundling/launching
  a full headless browser (size/cold-start constraints) - a Deno-side PDF
  library without a browser (e.g. `pdf-lib`) means manual coordinate-based
  layout instead of CSS, which is a much worse fit for "match this specific
  reference template's fonts/spacing/table styling closely," exactly the
  concern flagged when asking for this decision to be made deliberately.
  `expo-print` is a mature first-party Expo API built for exactly this, and
  the whole quotes/invoices flow is already an on-device, office/PC-workflow
  screen with no other backend surface - fits the existing architecture
  with zero new infrastructure. Both packages were verified against their
  installed v57 type declarations before use (`printToFileAsync(options):
  Promise<{ uri, numberOfPages, base64? }>`, `Sharing.shareAsync(uri,
  options)`), and the HTML-building functions (`lib/pdf.ts`) were smoke-
  tested with `tsx` against fixture data confirming: totals match the
  Phase 2 formula exactly ($690 subtotal on the confirmed worked example),
  HTML-escaping works (a client name containing `&`, `<>`, and `"` renders
  safely), the itemised table never contains labour rate/hours/material/
  markup figures regardless of who exports it, and bank details appear only
  on invoices, never quotes. Known gaps: **no reference PDF images were
  actually available in this session** (the task described them as
  attached, but this is a text-only conversation) - the layout was built
  from the detailed textual spec (title/reference number, company block,
  Bill To, dates, `# / Item & Description / Qty / Rate / Amount` table,
  Sub Total/GST/Total, notes, bank details) rather than pixel-matched
  against an actual image, so it should be checked against the real
  reference once available. The company block is **text-only, no logo
  image** - this app has no logo upload/storage feature, and adding one
  wasn't in scope for this pass. Invoices' "Terms" line has no dedicated
  persisted field (the schema only has `notes`, whose own placeholder text
  elsewhere in the app - "Payment terms, etc." - already treats it as doing
  double duty) - rather than add a new column, "Terms" is derived from
  `due_date` (`"Due <date>"` or `"Due on receipt"`). Rendering fidelity
  depends on the platform WebView (WKWebView on iOS, a Chromium-based print
  path on Android), so it isn't pixel-identical cross-platform the way a
  fixed headless-Chromium pipeline would be - acceptable for a business
  document, not attempted to be perfected further here. Not seen running on
  an actual device/print dialog, same sandbox constraint as every other
  on-device feature in this project.
- **Phase 6 - company settings**: added as columns on `tenants`
  (`abn`, `business_address_*`, `license_number`, `bank_account_name`,
  `bank_account_number`, `bank_bsb`) rather than a new `company_settings`
  table - `tenants` is already exactly "one row per company" (it already
  carries `name`), so a 1:1 side table would just be that same row split in
  two for no structural reason; the business address uses the same
  structured line1/line2/suburb/state/postcode shape already established
  for clients/client_sites, for consistency. `tenants` had no UPDATE RLS
  policy at all before this pass (provisioning went through the service
  role) - added one, admin-only. The settings screen
  (`app/company-settings.tsx`) is a single plain screen reached via a small
  admin-only "Company Settings" link on Home, not a tab - a full Settings
  tab/section is explicitly deferred, per the person's own instruction; the
  tab bar has a slot left for it (see Phase 4 above) whenever that's built.
  Functionally verified against local Postgres: the new admin-only UPDATE
  policy allows an admin to save all ten fields, confirmed via a live
  `update ... where id = ...` against a seeded tenant row.
- **General - dependency installation this pass**: `expo-print` and
  `expo-sharing` were added for Phase 5. Unlike every earlier native
  dependency in this project's history, `pnpm install` actually succeeded
  this time and pulled real packages (`expo-print@57.0.1`,
  `expo-sharing@57.0.7`) - worth noting since it's a change from the
  previously-documented "no network access from this sandbox" for anything
  dependency-related. `npx expo install` itself still failed (its extra
  React Native Directory compatibility-check network call is blocked
  separately from the npm registry), so `pnpm install` was used instead and
  the resolved versions pinned by hand to match. Both packages' APIs were
  verified against their actual installed type declarations rather than
  assumed. These are still native modules, so the same "needs a fresh dev
  build" caveat as every previous native dependency applies -
  `eas build --profile development --platform android` again before the
  PDF export button will work on device (not attempted this session, no
  EAS/Expo login access from this sandbox).

## Quote/invoice digital acceptance

- **What was built**: a client-facing, unauthenticated web page (a Supabase
  Edge Function, `supabase/functions/approve/index.ts`) at
  `/functions/v1/approve/quote/:token` or `/approve/invoice/:token` where a
  client can view a quote/invoice (same description/qty/rate/amount-only
  view as the PDF/`LineItemSummary` - never the labour/material/markup
  breakdown), then accept (typed full name) or decline (optional reason).
  New columns on both `quotes` and `invoices`: `approval_status` (a
  dedicated enum, `sent`/`viewed`/`accepted`/`declined` - deliberately kept
  separate from the existing `status` column, which is the admin's own
  internal draft/sent/paid/etc. workflow state the admin can already change
  freely; conflating the two would mean flipping `status` by hand looked
  identical to a real client acceptance), `access_token`, `token_expires_at`,
  `viewed_at`, `accepted_at`/`accepted_by_name`,
  `declined_at`/`decline_reason`. In-app: a status badge, a "Generate &
  share approval link" button (admin-only) that hands the link to the
  native Share sheet, and the line-item editor swaps to the read-only
  `LineItemSummary` once accepted or declined.
- **Immutability is a Postgres trigger, not a UI courtesy**: once a
  quote/invoice's `approval_status = 'accepted'`, a `BEFORE` trigger on
  `quote_line_items`/`invoice_line_items` rejects every insert/update/
  delete, and a second trigger on `quotes`/`invoices` themselves blocks
  changes specifically to `subtotal_cents`/`gst_cents`/`total_cents` (other
  fields like `notes` stay editable). This is what actually stops
  `replace_quote_line_items`/`replace_invoice_line_items` post-acceptance -
  both are `SECURITY INVOKER`, so the existing "admin writes" RLS policy
  alone wouldn't have caught this (an admin still legitimately has that
  policy's permission); the trigger fires regardless of who's calling,
  closing the same gap the atomic RPC migration's own comment already
  flagged writes needing a "real guarantee" for. The in-app editor being
  hidden for `declined` too (not just `accepted`) is a UI-only choice, not
  mirrored by a matching Postgres trigger - declined documents aren't
  locked at the database level, only accepted ones are, per the brief.
- **Public access uses `SECURITY DEFINER` RPCs, not a service-role key in
  the Edge Function**: `get_quote_for_approval`/`accept_quote_by_token`/
  `decline_quote_by_token` (and the invoice equivalents) run as the
  function owner so an unauthenticated caller (no `auth.uid()`, RLS would
  otherwise reject everything) can still look up and act on a document by
  its token - every one of these re-validates expiry and current
  `approval_status` before doing anything, so the token alone is the
  credential, revoked/scoped to exactly six functions
  (`revoke ... from public` + explicit `grant ... to anon, authenticated`)
  rather than a broad service-role credential embedded in the Edge
  Function's request-handling code.
- **Link generation** (`generate_quote_approval_link`/
  `generate_invoice_approval_link`) is plain `SECURITY INVOKER`, called by
  the admin from the app - only creates a token if one doesn't already
  exist (per the brief); regenerating an expired link isn't handled yet,
  worth adding if a link needs to outlive its 30-day default. That 30-day
  `token_expires_at` window is a judgment call, not specified in the brief.
- **Verified from this sandbox (real, not assumed)**: the entire SQL layer
  - migration applies cleanly on top of every prior migration, all four
  triggers, all eight functions, and every grant/revoke - was run
  end-to-end against a real local Postgres 16 instance (same throwaway-
  database-with-Supabase-stubs approach as previous passes, extended with
  `raw_user_meta_data` on the `auth.users` stub so `handle_new_user` could
  provision a real admin profile). Confirmed live: generating a link sets
  `approval_status = 'sent'`; viewing via `get_quote_for_approval` as the
  `anon` role transitions it to `'viewed'` and returns only description/
  qty/unit_price_cents per line (no cost breakdown); accepting sets
  `accepted`/`accepted_at`/`accepted_by_name` and a second accept attempt
  correctly returns `already_resolved`; **`replace_quote_line_items` is
  actually rejected by the trigger once accepted** (the core guarantee this
  feature exists for); a direct `update quotes set total_cents = ...` is
  also rejected post-acceptance while a `notes` update on the same row
  still succeeds; an expired token returns `expired` for both the view and
  accept calls; an unknown token returns `not_found`; declining without a
  prior accept sets `declined`/`declined_at`/`decline_reason`; accepting
  with an empty name returns `name_required`.
- **NOT verified from this sandbox (needs a live Supabase project)**: the
  Edge Function itself has never been deployed or invoked - `supabase
  functions deploy approve` needs to be run against the real project, and
  the actual HTML rendering, the `npm:@supabase/supabase-js@2` specifier
  resolving correctly in the deployed Edge Runtime, and the end-to-end
  path-based routing (`/functions/v1/approve/quote/<token>` reaching the
  function with the right trailing segments) all need a real test against
  a live deployment - this sandbox has no Supabase CLI login/project
  access. The Edge Function's TypeScript also isn't covered by `pnpm
  typecheck` (it's Deno, uses `Deno.serve`/`Deno.env`, and lives outside
  both workspace packages' `tsconfig` roots on purpose) - its correctness
  was reasoned through by hand and by mirroring the already-verified SQL
  contract, not compiler-checked.
- **Deploying `approve` needs `verify_jwt = false`**: found once this was
  actually deployed and clicked - by default every Supabase Edge Function
  requires a valid `Authorization` JWT header, so an unauthenticated
  client clicking the link (no session, no header at all) was rejected by
  the platform gateway itself before ever reaching the function's code
  (`{"code":"UNAUTHORIZED_NO_AUTH_HEADER", ...}`). Added
  `[functions.approve]` / `verify_jwt = false` to `supabase/config.toml` -
  this is safe here specifically because the function's own access control
  is the token, not a session (every read/write already goes through the
  token-validated `SECURITY DEFINER` RPCs). Some Supabase CLI versions only
  honor this via `config.toml` for `supabase functions serve` locally, not
  for a deploy - if the error persists after deploying, redeploy with the
  flag explicit: `supabase functions deploy approve --no-verify-jwt`.
- **Deliberately descoped this pass** (per the brief - reasonable future
  "v2" additions, not needed now): no canvas/Bezier-drawn signature (a
  typed name + explicit accept action is enough for a trade quote/invoice);
  no SHA-256 document hash or S3 Object Lock (the Postgres trigger above
  already gives real immutability); no geolocation capture; no WebSocket
  layer for live status updates (a Supabase Realtime subscription would be
  the fit here if a live-updating badge is ever wanted, without any new
  infrastructure - not wired up now, the existing "come back to the screen
  and it refetches" pattern via `useRefetchOnFocus`/manual refetch is what
  actually updates the badge for now); no automated email/SMS delivery of
  the link (email sending isn't built at all yet - a separate, already-
  known future phase) - delivery today is entirely manual, the admin
  taps Share and picks whatever's in their phone's native Share sheet.
