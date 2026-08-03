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

- **What was built**: a client-facing, unauthenticated web page - a static
  file (`supabase/static/approval-page.html`) deployed to a **free external
  static host** (Cloudflare Pages/Netlify/GitHub Pages - the person's
  choice; not specified further here since it's config, not code), calling
  a Supabase Edge Function (`supabase/functions/approve/`) as a plain JSON
  data API for the actual data - at `<deployed-url>?type=quote&token=...`
  (or `type=invoice`) where a client can view a quote/invoice (same
  description/qty/rate/amount-only view as the PDF/`LineItemSummary` -
  never the labour/material/markup breakdown), then accept (typed full
  name) or decline (optional reason). **Neither this, nor the Supabase-
  Storage version before it, was the original design** - see the "Supabase
  force-downgrades HTML on its own shared domain" bullet further down for
  why *two* earlier versions (Edge-Function-rendered, then Storage-hosted)
  didn't work in production and had to be found out empirically rather
  than guessed correctly up front.
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
- **Confirmed fully working against the live project (by the person, not
  this sandbox - it still has no Supabase CLI login/project access)**:
  after the `verify_jwt`, Edge-Function-HTML, and Storage-HTML issues
  below were each found and fixed in turn, the final static-page + JSON-
  API + external-static-host setup was deployed and the approval page
  rendered correctly end-to-end in a real browser - logo, quote number,
  client name, line items, correct Sub Total/GST/Total, and both the
  Accept and Decline forms all showing right. Confirmed via the browser's
  own Network tab that the page's `fetch()` call reaches
  `qnlxmpxjmmhcnzzpcabd.supabase.co/functions/v1/approve` successfully
  (not a CORS failure, not a 404) and gets real data back. This is real
  production verification of the whole chain: external static host ->
  CORS -> Edge Function -> `SECURITY DEFINER` RPC -> Postgres, not just
  the SQL layer in isolation. The Edge Function's own TypeScript still
  isn't covered by `pnpm typecheck` (it's Deno, uses `Deno.serve`/
  `Deno.env`, and lives outside both workspace packages' `tsconfig` roots
  on purpose), but its behavior is now compiler-unchecked *and*
  live-verified, not just reasoned through by hand.
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
- **Supabase force-downgrades HTML on its own shared domain - for Edge
  Functions *and* Storage, not just one of them.** Found by actually
  deploying and inspecting the real response headers (`curl -D -` /
  `Invoke-WebRequest`) after three rounds of the person still seeing raw
  HTML/JS text instead of a rendered page. First attempt: the `approve`
  Edge Function rendered the page directly - response came back
  `Content-Type: text/plain` (not the `text/html` the function explicitly
  set) plus `Content-Security-Policy: default-src 'none'; sandbox` and
  `X-Content-Type-Options: nosniff`, none of which the function set.
  Concluded (reasonably, but wrongly) that this was Edge-Function-
  specific and moved the static page into a public Storage bucket instead
  - **Storage returned the identical three headers**, disproving that.
  This is Supabase's platform applying the same anti-phishing policy
  (blocking interactive HTML from being served under the trusted shared
  `*.supabase.co` domain) to *everything* public on that domain, not a
  per-product quirk, with no per-file/per-bucket/per-function header able
  to opt out of it - the only in-Supabase opt-out is a custom domain, a
  paid-plan feature. Given the person picked the free option when asked
  (see below), the actual fix moved the page **off Supabase entirely**:
  - `supabase/functions/approve/index.ts` is now a plain JSON API (GET
    `?type=&token=` returns the document, POST processes accept/decline) -
    JSON responses aren't subject to the HTML lockdown, confirmed by the
    RPC/token layer working correctly in production once the earlier
    `verify_jwt` issue was fixed.
  - `supabase/static/approval-page.html` is deployed to a free external
    static host (Cloudflare Pages, Netlify, GitHub Pages, etc. - whichever
    the person sets up; not prescribed here since it's a deployment choice
    with no code impact) instead of Supabase Storage. It's genuinely
    cross-origin from the function now, so it calls an absolute URL
    (`SUPABASE_URL` hardcoded near the top of the file - update it if this
    project ever moves to a different Supabase project) rather than
    `location.origin`; the function already sends
    `Access-Control-Allow-Origin: *` for exactly this.
  - `apps/mobile/.env` needs a new var, `EXPO_PUBLIC_APPROVAL_PAGE_URL`
    (see `.env.example`), pointed at wherever the static page ends up
    living - the "Generate & share approval link" button reads this and
    shows a clear error instead of building a broken link if it's unset.
  - The `approval-pages` Storage bucket/migration
    (`20260729000100_approval_page_storage.sql`) is now vestigial - it was
    already applied to the live project before this was diagnosed, and is
    harmless to leave in place (an empty or unused public bucket costs
    nothing), so no follow-up migration was written to remove it. A future
    cleanup could drop it.
  - **New deployment steps**, replacing the old Storage-upload one:
    `supabase db push`, `supabase functions deploy approve`, then deploy
    `supabase/static/approval-page.html` to whichever external static host
    was chosen (each has its own one-time setup - e.g. Cloudflare Pages'
    dashboard supports dragging the single file in directly, no build
    step needed since it's already a complete static file) and set
    `EXPO_PUBLIC_APPROVAL_PAGE_URL` in `.env` to the resulting URL.
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

## Schedule / dispatch board (mobile MVP)

- **What was built**: a "Schedule" view (`app/schedule.tsx`, admin-only) with
  an unassigned-jobs queue (job cards with no future-dated calendar event,
  excluding completed/invoiced jobs) and a per-technician day view for a
  navigable selected date, built by grouping `calendar_events` (joined to
  `job_cards` for the assigned technician and to `clients` for
  name/address) client-side rather than a new query per day tap - the same
  "fetch once, filter in memory" shape `app/(tabs)/calendar/index.tsx`
  already uses. Tapping an unassigned job opens `calendar/new` pre-filled
  and locked to that job (same `lockedFromJob` pattern as "+ New quote for
  this job" on `quotes/new.tsx`), defaulted to the date being viewed.
  Tapping an already-scheduled job opens the existing `calendar/[id]` edit
  screen - no new editing surface was built, per the brief.
- **Reference spec adapted, not built literally**: the reference described
  a desktop drag-and-drop timeline grid with live GPS, an automated
  travel-time buffer (distance-matrix API), a Google Calendar busy-block
  overlay, and WebSocket-based multi-dispatcher locking. None of that
  fits a mobile-first app with no desktop client yet - drag gestures
  fight normal scrolling on a phone, and the other four are each their own
  significant integration. Built instead: tap-to-assign (tap an unassigned
  job, then a job to reassign/reschedule), no GPS, no travel buffer, no
  Google Calendar overlay (Google sync isn't built at all yet - separate
  known future phase), no realtime locking. **The rich drag-and-drop board
  is a deliberate deferral to revisit once a desktop app exists**, not an
  oversight - the underlying data model (`calendar_events` linked to
  `job_cards`) already supports it without a rewrite when that day comes.
  A Supabase Realtime subscription would be the natural fit for a live
  "someone else is viewing this" notice later if two dispatchers actually
  collide in practice - not wired up now (`useRefetchOnFocus` covers the
  common case of "I came back to this screen").
- **Data model decision - `calendar_events` is the source of truth for
  scheduling, not a new field on `job_cards`**: matches the brief's own
  reasoning exactly - `calendar_events` already has the full creation/edit
  UI (date/time pickers, guests, location, job/task linking) and already
  supports a job needing multiple scheduled visits (nothing stops two
  events linking to the same `job_card_id`), where a single new field on
  `job_cards` would support neither and would create a second place that
  could disagree with the calendar about when a job is actually happening.
  **Worth flagging**: `job_cards` already has an unused `scheduled_at`
  timestamp column (schema/types/zod schema all define it, going back to
  the Phase 1 migration) that no screen in the app has ever read or
  written - the brief's framing ("job cards don't currently have a
  scheduled time") isn't quite accurate, there's a vestigial single-
  timestamp field sitting there. This doesn't change the decision (a
  single timestamp still can't represent an end time or multiple visits
  the way `calendar_events` can, and building a second scheduling UI
  around it would recreate exactly the two-places-can-disagree problem
  the brief is trying to avoid) but it's left permanently unused by this
  pass rather than silently repurposed - a future cleanup migration could
  drop it, out of scope here.
- **A real gap this feature had to fill, not silently work around**: the
  app had no UI anywhere to assign or reassign a job's technician before
  this pass - `job_cards.assigned_technician_id` existed in the schema
  and was already used for RLS/per-technician filtering, but nothing ever
  set it (job creation on `sales/jobs/index.tsx` doesn't collect it, and
  the job detail screen doesn't expose it either). "Tap-to-assign" only
  means something with a way to actually pick a technician, so a
  Technician picker (searching `profiles` where `role = 'technician'`, the
  same `PickerModal` component used everywhere else) was added to both
  `calendar/new.tsx` (shown once a job is linked) and `calendar/[id].tsx`
  (admin-only, shown when the event has a linked job) - selecting one
  updates `job_cards.assigned_technician_id` via `powersync.execute` (the
  offline-capable table's normal write path, not a direct Supabase call)
  alongside the calendar event write. Creating a dispatch event also bumps
  a `new` job to `scheduled` - later statuses are left alone - since the
  `JobStatus` enum already has a `scheduled` state clearly meant for
  exactly this moment.
- **Entry point placement - moved after initial build**: originally a
  small admin-only "Schedule / Dispatch ›" link on the Calendar tab
  (reasoning at the time: Home's tile grid deliberately only mirrors the
  real tab bar, and a fourth tile would break that for a feature that's
  "just" a different view over Calendar's own data). The person
  explicitly asked for this to move to a proper Home tile instead, same
  visual style as Sales/Tasks/Calendar, placed right after Calendar in
  the grid - done: `app/(tabs)/index.tsx`'s tile list is now built
  dynamically (`[...TILES, SCHEDULE_TILE]` only when `profile.role ===
  "admin"`) rather than the static three-tile constant it was before, and
  the Calendar-tab link (and its now-dead styles) was removed entirely so
  there's exactly one way in. `app/schedule.tsx` itself, and its
  registration in `app/_layout.tsx` as a standalone route next to
  `company-settings`, are unchanged - only how you get to it moved.
- **Verification status**: `pnpm typecheck` passes clean across the whole
  workspace. This is a pure React Native feature over already-provisioned
  Supabase tables/RLS (no migration, no new schema) and already-verified
  `powersync.execute` write patterns identical to ones used elsewhere in
  the app (`jobs/[id].tsx`'s status changes) - not independently re-run
  against a live device/dev build from this sandbox, same constraint as
  every other on-device UI feature in this project's history (no EAS/Expo
  login access here). Worth checking on a real device once built: the
  `disabled` prop on the locked job-picker `Pressable` in `calendar/new.tsx`
  renders correctly (same pattern already used and presumably working on
  `quotes/new.tsx`, not new to this pass), and that the per-technician day
  view reads sensibly with a realistic number of technicians/jobs on a
  small screen.

## Admin-created technician logins

- **What was built**: an admin can create a technician's login from inside
  the app - full name, email, password - via a new `create-technician`
  Edge Function, and a new `app/team.tsx` screen listing existing
  technicians with a "+ New technician" action. No schema changes: it
  writes to `auth.users` (via the Admin API, service-role only) and lets
  the existing `handle_new_user()` trigger build the matching `profiles`
  row exactly the way `scripts/create-admin-user.mjs` already does by
  hand - the Edge Function sends the identical `user_metadata` shape
  (`tenant_id`, `role`, `full_name`) that trigger already reads.
- **Why an Edge Function, not a direct client call**: `auth.admin.createUser`
  needs the `service_role` key, which must never ship inside the mobile
  app bundle (anyone could extract it from the app and get unrestricted,
  RLS-bypassing access to the whole database). The function is the only
  place that key is used - it's read from `SUPABASE_SERVICE_ROLE_KEY`, an
  Edge Function secret Supabase injects automatically, never committed to
  the repo.
- **The security boundary is server-side, not "the UI hides the button"**:
  unlike the `approve` function (deliberately public, `verify_jwt = false`),
  this one keeps Supabase's *default* JWT verification on - no
  `[functions.create-technician]` entry was added to `config.toml`, so an
  unauthenticated request is rejected by the platform gateway before ever
  reaching the function. On top of that, the function does its own check:
  it builds a second Supabase client scoped to the caller's own JWT
  (forwarded from the `Authorization` header), calls `auth.getUser()` to
  confirm who's actually calling, then reads *that user's own* `profiles`
  row under normal RLS (`profiles: read within tenant`) to get their real
  `role` and `tenant_id` - never trusted from the request body. A non-
  admin (or a request with no valid session at all) gets `403`/`401`
  before any user is created. `tenant_id` for the new technician is always
  the calling admin's own tenant, read server-side the same way - not
  something the client could spoof to create a user in someone else's
  tenant.
- **Error handling - a closed set of codes, not raw Auth errors**: GoTrue's
  own error messages/codes for `createUser` aren't perfectly stable across
  versions, so `classifyCreateError` in the function matches on both a
  `code` field (`email_exists`, `weak_password`) and a lowercased message
  fallback, collapsing everything else to a generic `create_failed`. The
  app (`team.tsx`) reads the structured JSON body off a `FunctionsHttpError`
  (`await error.context.json()`, the documented pattern in the installed
  `@supabase/supabase-js` types) and shows "That email is already in use
  by another account" specifically for the duplicate-email case, rather
  than a raw Postgres/GoTrue error string. The password is never logged -
  not in the Edge Function (only `error.message` is logged, never the
  request body) and not in the app's console.error calls.
- **Screen placement**: a small admin-only "Team" link on Home, right next
  to "Company Settings" - not a tile, not its own tab. Reasoning: Home's
  tile grid (Sales/Tasks/Calendar/Schedule) is for daily operational
  tools an admin or technician actually taps regularly; "Team" and
  "Company Settings" are both occasional setup/administration screens
  (provision a login once, rarely revisit vs. tap a dozen times a day),
  so they share the same lightweight header-link treatment instead of
  spending tile-grid space on something used infrequently. This mirrors
  the distinction that already existed between Schedule (promoted to a
  tile specifically because it's a daily dispatcher tool) and Company
  Settings (left as a link).
- **Verified from this sandbox**: `pnpm typecheck` passes clean across the
  whole workspace. Since this feature needs no new migration, what was
  actually verified against a real local Postgres 16 instance was the
  mechanism the whole feature depends on: seeded a tenant + admin, then
  inserted an `auth.users` row with the *exact* `user_metadata` shape the
  Edge Function sends (`tenant_id`/`role: 'technician'`/`full_name`) -
  confirmed `handle_new_user()` produces a correctly-scoped `profiles` row
  from it. Also confirmed, as the `authenticated` role with the admin's
  own `auth.uid()`, that reading their own profile (what the function's
  authorization check depends on) and reading the tenant's technician list
  (what `team.tsx` depends on) both return the right rows under RLS.
- **NOT verified from this sandbox (needs a live Supabase project, same
  limitation as `approve`)**: the `create-technician` function has never
  been deployed or invoked - the actual `auth.admin.createUser` call
  (Admin API access with the real service-role key), the end-to-end
  `supabase.functions.invoke()` call from the app (including whether
  `FunctionsHttpError`'s `error.context` is genuinely a `Response` in the
  installed React Native runtime the way the web-focused type
  documentation describes it), and a real technician then successfully
  logging in with the created credentials all need a live test.
  Deployment: `supabase functions deploy create-technician` (no
  `--no-verify-jwt` this time - the default JWT verification is
  intentional here, see above).

## Job categories, lifecycle stages, and jobs list filtering/sorting

- **What was built**: two new admin-managed, tenant-wide tables -
  `service_categories` (a simple named/colored tag, e.g. "Roof
  Restoration") and `job_lifecycle_stages` (an ordered, admin-customizable
  pipeline, e.g. "Enquiry" / "Quote Sent" / "Deposit Paid") - plus nullable
  `service_category_id`/`lifecycle_stage_id` columns on `job_cards`. A new
  admin-only `app/job-setup.tsx` screen manages both (create/edit/delete,
  tap up/down reorder for stages). The Jobs list (`sales/jobs/index.tsx`)
  gained category/stage filter chips, a sort control (created date,
  scheduled date, category, stage position), and colored category
  tags/stage badges on each row; the create-job modal and the job detail
  screen (`sales/jobs/[id].tsx`) both gained optional Category/Stage
  pickers.
- **`status` (the existing `job_status` enum) is deliberately NOT replaced
  or touched**: too much of the app already keys off it directly - the
  Schedule/dispatch board's "unassigned" filter, Job Costing, the status
  chip row on the job detail screen. `lifecycle_stage_id` is a second,
  independently admin-customizable pipeline layered on top of `status`,
  not a replacement for it. The migration's one-time backfill links each
  existing job to the default stage matching its status at that moment
  (`New`→`New`, `in_progress`→`In Progress`, etc.), but the two are never
  kept in sync with each other afterwards - changing `status` on the job
  detail screen does not move `lifecycle_stage_id`, and vice versa. This
  was a judgment call: keeping them mechanically linked would mean either
  locking down what an admin can rename/reorder/delete in their custom
  pipeline (defeating the point of it being customizable), or silently
  guessing a status from an arbitrary custom stage name, which isn't
  reliable. Keeping them fully independent was simpler and matches what
  was actually asked for ("distinct from the existing job_cards status
  enum").
- **Default stages seed automatically for every tenant**: a
  `seed_default_lifecycle_stages()` function inserts `New` / `Scheduled` /
  `In Progress` / `Completed` / `Invoiced` (matching the `job_status` enum
  values 1:1, so the backfill's name-matching stays unambiguous) for the
  current tenant, run once for every existing tenant in the migration and
  again automatically via an `after insert on tenants` trigger for any
  tenant created later. `is_system_default = true` marks these five, but
  nothing in the schema actually locks them - an admin can rename,
  recolor, reorder or delete them like any other stage from
  `job-setup.tsx`; the flag is only used to show a "Default" tag and a
  slightly different delete-confirmation message.
- **RLS**: both new tables follow the exact same shape as
  `price_book_categories` - tenant-wide read (`tenant_id =
  current_tenant_id()`), admin-only insert/update/delete
  (`current_tenant_id() and is_admin()`). `job_cards`' own RLS is
  unchanged; the two new nullable FK columns are just regular columns on
  an already-covered table.
- **PowerSync sync scope - a deliberate divergence from the price_book
  precedent**: `service_categories` and `job_lifecycle_stages` were added
  to the `tenant_reference_data` bucket (synced to every signed-in
  device, technicians included), *not* left as a Supabase-direct,
  online-only fetch the way `price_book_categories`/`price_book_items`
  are. Price book stays online-only because it's exclusively
  quote/invoice creation tooling, which is itself an online-only,
  admin/office workflow. Category tags and stage badges, by contrast,
  need to render on the Jobs list and job detail screen for everyone,
  including a technician viewing their own assigned jobs with no
  reception - so this needed to be genuinely offline-capable like
  `clients`/`job_cards` themselves, not fetched-when-online like price
  book. Writes are still admin-only, enforced by Postgres RLS on
  upload - PowerSync bucket membership only controls what a device
  downloads, not what it's allowed to write.
- **No unique constraint on `position`**: matches the existing
  `price_book_categories.sort_order` precedent - gaps or duplicate
  position values are harmless since the UI always sorts by `position`
  and only ever nudges a stage's value up/down by one via the reorder
  buttons, it doesn't rely on positions being contiguous or unique.
- **Reordering is tap up/down buttons, not drag-and-drop**: matches the
  Schedule board's established "no drag-and-drop" convention for this
  codebase. `job-setup.tsx`'s reorder swaps the tapped stage's `position`
  with its immediate neighbor's via two `powersync.execute()` calls.
- **Filtering/sorting the Jobs list is done client-side in JS**, not via
  dynamic SQL `WHERE`/`ORDER BY` clauses built from state - same
  convention already established by the Schedule and Calendar screens:
  the base PowerSync query stays a fixed string (all jobs, or a
  technician's own assigned jobs), and category/stage filters plus the
  sort dropdown are applied afterward over the returned array.
- **Screen placement**: `job-setup.tsx` is a small admin-only "Job Setup"
  link on Home, next to "Company Settings" and "Team" - not a tile,
  following the same "occasional setup screen vs. daily operational tool"
  reasoning documented above for Team.
- **Verified from this sandbox**: the migration was applied cleanly
  against a real local Postgres 16 instance alongside all prior
  migrations; confirmed the `after insert on tenants` trigger seeds
  exactly the 5 expected default stages in the correct order for a new
  tenant, and confirmed the backfill's status→stage-name `CASE` mapping
  correctly links a `job_cards` row to the right stage (e.g.
  `status = 'in_progress'` → the `In Progress` stage at `position = 3`).
  `pnpm typecheck` passes clean across the whole workspace. There is no
  `build` script anywhere in this repo (root `package.json`'s `build`
  turbo task has nothing to run against) - `typecheck` is this repo's
  actual cross-package type-safety gate, consistent with every prior
  phase of this project.
- **NOT verified from this sandbox**: PowerSync's own YAML parsing of the
  two new `tenant_reference_data` bucket lines (no PowerSync instance is
  provisioned here, same known limitation as every other sync-rules
  change in this project - see the note in the Schedule board and
  per-technician sync rule sections above), and no on-device sync/offline
  test of `job-setup.tsx` or the Jobs list filters against a real running
  app.

## Inventory & stock control

- **What was built**: multi-location inventory tracking on top of the
  existing price book catalogue - `inventory_locations` (a physical place
  stock lives: "Ute 1", "Main Warehouse") and `inventory_levels` (the
  quantity of a `price_book_items` row held at a given location, with a
  `reorder_threshold`). A new `sales/inventory/index.tsx` screen (a sixth
  tile in the Sales grid, next to Price Book) has a location switcher, a
  price-book-category filter, and +/- buttons on each item card that write
  straight to local SQLite via `powersync.execute()`. A second "Out of
  Stock / Need to Order" tab shows every `inventory_levels` row across
  every location where `quantity <= reorder_threshold` (red badge at
  `quantity = 0`), with a "Generate Shopping List" button that builds a
  PDF (`buildShoppingListPdfHtml` in `lib/pdf.ts`) grouped by location and
  shares it via the existing `exportPdf` helper (`lib/print.ts` needed no
  changes - it was already a generic HTML-to-PDF-and-share function, not
  quote/invoice-specific).
- **Reused the price book catalogue instead of a separate "inventory
  item" list**: `inventory_levels.item_id` references `price_book_items`
  directly. The alternative - a standalone inventory item table - would
  mean maintaining two parallel catalogues (and reconciling them) for what
  is, in this business, the same underlying thing: a priced item that can
  either go on a quote/invoice or get tracked as stock. This does mean
  inventory can only track items that already exist in the price book;
  that was judged the right tradeoff over a duplicate catalogue.
- **A real architectural tension, resolved deliberately**: price book
  (`price_book_categories`/`price_book_items`) was, until this feature,
  Supabase-direct and online-only - the earlier reasoning being that it's
  admin-managed catalogue data only touched while building a quote/invoice,
  itself an online-only workflow (see the price_book migration and the
  job-categories section above, which explicitly kept price book
  online-only for that reason). Inventory breaks that assumption: a
  technician adjusting stock from their ute with no signal needs to see
  the item's actual name, not a bare `item_id`, for "stock adjustments
  work seamlessly offline" to be true in any meaningful sense. Rather than
  denormalizing the item name onto `inventory_levels` (which would need
  its own sync-on-rename logic) or leaving the inventory screen unusable
  offline, `price_book_categories`/`price_book_items` were added to the
  PowerSync `tenant_reference_data` bucket alongside the new inventory
  tables (see `powersync/sync-rules.yaml`'s updated comment). This exposes
  nothing new - both tables' RLS was already tenant-wide read, not
  admin-only, so this only changes *when* the data reaches a device, not
  *who* can see it. The existing Price Book admin screens
  (`sales/price-book/**`) are untouched and still fetch directly from
  Supabase; this is an additive local read path for inventory, not a
  migration of the old screens onto PowerSync.
- **RLS is split differently between the two new tables, deliberately**:
  `inventory_locations` (naming/managing "Ute 1"/"Main Warehouse") is
  occasional setup/configuration, so it's admin-write/tenant-read, the
  same shape as `service_categories`/`job_lifecycle_stages`/
  `price_book_categories`. `inventory_levels` (the day-to-day quantity a
  technician taps +/- on) is tenant-wide *writable* by design - insert and
  update are open to any tenant member, matching the `clients` table's
  "small crew, everyone needs to be able to edit it" precedent - only
  delete (removing a stock line entirely) is admin-only. A technician
  tapping "+" on an item with no existing stock row at that location
  inserts a brand-new `inventory_levels` row themselves (`quantity = 1`,
  `reorder_threshold` defaulted to 5) - this needed to be a tenant-wide
  insert policy, not just update, for that first-tap-creates-the-row flow
  to work without an admin having to pre-provision every location/item
  pairing up front.
- **Reorder quantity in the PDF is a simple default, not forecasting**:
  `suggestedReorderQuantity` in `lib/pdf.ts` is just
  `max(reorder_threshold - quantity, 1)` - enough to bring that location
  back up to its own threshold, minimum 1. No demand history, lead time,
  or par-level logic; a judgment call to keep this predictable and
  easy for a person to sanity-check against, rather than building
  forecasting nobody asked for.
- **Quantity floor at zero, no negative stock**: `handleAdjust`'s "-"
  button clamps with `Math.max(0, ...)` and is disabled once `quantity`
  reaches 0 - there's no backorder/negative-stock concept in this schema,
  matching how nothing else in this app models a deficit.
- **PowerSync sync scope**: `inventory_locations` and `inventory_levels`
  joined `tenant_reference_data` (same bucket as clients/service
  categories/lifecycle stages/price book, now) rather than getting their
  own bucket - both need to be visible tenant-wide regardless of role
  (a technician needs to see stock at a location they didn't create), so
  there was no role-based reason to split them into their own bucket the
  way `admin_job_data`/`technician_assigned_jobs` are split.
- **Verified from this sandbox**: the migration was applied cleanly
  against a real local Postgres 16 instance alongside all 13 prior
  migrations. RLS was exercised directly (not just read by inspection):
  as an admin, inserting an `inventory_locations` row succeeded; as a
  technician, the identical insert was rejected by RLS. As a technician,
  inserting and updating an `inventory_levels` row both succeeded; a
  technician's `DELETE` against that row affected 0 rows (RLS-filtered,
  not an error, since `DELETE ... USING` policies fail silently rather
  than raising) while an admin's delete would succeed. The
  `(location_id, item_id)` unique constraint was confirmed to reject a
  second row for the same pairing. `pnpm typecheck` passes clean across
  the whole workspace. There is still no `build` script anywhere in this
  repo, consistent with every prior phase's note on this.
- **NOT verified from this sandbox**: PowerSync's own YAML parsing of the
  new bucket lines and an on-device sync/offline test of the Inventory
  screen (same known limitation noted for every sync-rules change in this
  project), and no real PDF was rendered/shared on a device (`exportPdf`
  itself was already exercised for quotes/invoices in the Phase 5 PDF
  work - this only adds a new HTML-building function ahead of that same,
  already-verified call).

## Inventory: standalone material/tool categories (replaces the price book tie-in)

- **What changed and why**: the inventory feature above originally reused
  the price book catalogue (`inventory_levels.item_id` pointed at
  `price_book_items`), reasoning that a quote/invoice pricing item and a
  physical stock item were "the same underlying thing." They aren't:
  inventory needed to track materials and tools (a tube of silicone, a
  cordless drill) that are never priced or put on a quote, with their own
  fully custom two-level category system - which the price book's flat,
  single-level, pricing-focused catalogue can't represent. The
  `inventory_material_categories` migration reverses the tie-in: a new
  standalone catalogue (`inventory_categories` -> `inventory_subcategories`
  -> `inventory_items`) replaces it, and `price_book_categories`/
  `price_book_items` go back to being Supabase-direct/online-only, exactly
  as they were before the original inventory work touched them.
- **The hierarchy**: `inventory_categories` is the top level - e.g.
  "Material", "Tools", "First Aid Kit". `inventory_subcategories` is an
  optional second level under a specific category - e.g. "Roofing"/
  "Plumbing"/"Tapware" under "Material", or "Power Tools"/"Hand Tools"
  under "Tools". `inventory_items.subcategory_id` is nullable because not
  every category needs a second level - a "First Aid Kit" category can
  hold items directly with no subcategories at all. Both levels are fully
  admin-customisable (create/edit/delete) from the new `inventory-setup.tsx`
  screen; actual items are created inline from the main Inventory screen
  itself (a "+ New item" action), mirroring how Jobs creates a job inline
  while `job-setup.tsx` only manages the category/stage hierarchy, not job
  cards themselves.
- **A destructive cascade, called out deliberately**: deleting an
  `inventory_categories` row cascades to delete every `inventory_items` row
  under it (and, in turn, every `inventory_levels` stock record for those
  items) - confirmed live against local Postgres. This mirrors the existing
  `price_book_categories` -> `price_book_items` precedent (also cascade),
  but is more consequential here since it deletes real stock counts, not
  just catalogue/pricing rows. The alternative (`ON DELETE RESTRICT`,
  blocking the delete while items exist) was considered and rejected in
  favour of matching precedent, but the category delete confirmation in
  `inventory-setup.tsx` explicitly counts and names what will be destroyed
  ("this will also delete N items (and their stock records)") rather than
  a generic confirm, specifically because of how consequential this is. If
  this ever proves too easy to trigger by accident, switching that one FK
  to `RESTRICT` is a small, isolated migration - flagging it here as the
  option to revisit rather than silently deciding it's fine forever.
  Deleting a *subcategory*, by contrast, is non-destructive:
  `inventory_items.subcategory_id` is `ON DELETE SET NULL`, so items just
  lose that tag - closer to the softer job-category precedent.
- **RLS**: all three new tables (`inventory_categories`,
  `inventory_subcategories`, `inventory_items`) are tenant-wide read,
  admin-only write, matching `price_book_categories`/`price_book_items`/
  `service_categories` exactly. `inventory_locations`/`inventory_levels`
  are untouched by this migration - locations stay admin-managed, and
  day-to-day quantity adjustments stay tenant-wide writable so a
  technician can still tap +/- from their truck.
- **PowerSync sync scope**: `inventory_categories`/`inventory_subcategories`/
  `inventory_items` joined the `tenant_reference_data` bucket in place of
  the now-removed `price_book_categories`/`price_book_items` lines - same
  reasoning as before (every inventory screen, technician-facing included,
  needs this hierarchy offline), just pointed at the new tables instead.
- **Verified from this sandbox**: the new migration was applied cleanly
  against a real local Postgres 16 instance alongside all 14 prior
  migrations (including the original `inventory_stock_control` one).
  Exercised live: an admin creating a category/subcategory/item succeeded;
  a technician attempting to create a category was rejected by RLS while
  still being able to read the full hierarchy; a technician creating an
  `inventory_levels` row against the new `inventory_items` id succeeded
  (confirming the FK repoint works end-to-end); deleting a category was
  confirmed to cascade-delete its item and that item's stock record.
  `pnpm typecheck` passes clean across the whole workspace.
- **NOT verified from this sandbox**: same PowerSync YAML-parsing and
  on-device sync/offline caveats as every other sync-rules change in this
  project - no PowerSync instance is provisioned here to confirm the
  updated bucket definition against the actual sync service, only against
  Postgres directly. The updated Inventory screen, the new
  `inventory-setup.tsx` screen, and the "+ New item" flow have not been
  exercised in a running app.

## Inventory: suppliers, ideal stock, and per-item reorder threshold

- **What was built**: a flat, admin-managed `inventory_suppliers` list
  ("Bunnings", "Reece", ...) that an item can optionally be tagged with;
  `ideal_stock` (a new target quantity) and `reorder_threshold` (moved
  here, see below) as properties of `inventory_items` itself. The Low-Stock
  queue gained supplier filter chips ("All suppliers" + each supplier),
  and "Generate Shopping List" now respects that filter and whatever else
  is currently visible - the button relabels to name the supplier when
  one's selected, and the PDF's own header names the supplier too when
  every item on it shares one, so a printed/shared copy is unambiguous
  even out of context. Items gained a full edit flow (`inventory-setup.tsx`
  is unchanged for this - editing an item's supplier/thresholds happens by
  tapping the item itself on the main Inventory screen, which previously
  had no edit path at all, only create).
- **`reorder_threshold` moved from `inventory_levels` to
  `inventory_items`, a deliberate model change**: it used to be a
  per-(location, item) value, defaulting to a hardcoded 5 with no UI to
  ever set it differently. The request described it as a property of the
  *item* ("our reorder threshold for a tube of clear silicone is 4") with
  no per-location variation in the example, and nothing in the UI had ever
  actually exposed per-location overrides - so the migration drops the
  column from `inventory_levels` and adds it (plus the new `ideal_stock`)
  to `inventory_items` instead. This is a real, if narrow, behavior change
  from the original inventory design; safe here because no admin-facing
  path ever let a location's threshold diverge from the 5 default, so
  nothing meaningful was actually using the old per-location shape.
- **`reorder_threshold` vs. `ideal_stock` - two different numbers, doing
  two different jobs**: `reorder_threshold` is the alert point (when a
  location's quantity for this item drops to or below it, the item shows
  up in the Low-Stock queue). `ideal_stock` is the target a reorder should
  bring that location back up to. `suggestedReorderQuantity` in
  `lib/pdf.ts` was updated to compute against `ideal_stock`
  (`max(ideal_stock - quantity, 1)`) rather than `reorder_threshold` -
  ordering exactly enough to clear the alert threshold would mean the item
  falls straight back into Low-Stock on the next unit used, which isn't
  useful. This is still a simple "bring it up to the target" calculation,
  not demand forecasting.
- **`inventory_suppliers` RLS/sync**: same shape as `inventory_categories`
  - tenant-wide read, admin-only write, synced via the `tenant_reference_data`
  PowerSync bucket (a technician picking a location still needs to see
  which supplier an item comes from offline).
- **Verified from this sandbox**: the new migration applied cleanly
  against a real local Postgres 16 instance alongside all 15 prior
  migrations. Exercised live: an admin creating a supplier and an item
  with `reorder_threshold`/`ideal_stock`/`supplier_id` set succeeded, and
  a join query confirmed the item→supplier link reads back correctly;
  `\d inventory_levels` confirmed the `reorder_threshold` column is
  actually gone from that table post-migration. `pnpm typecheck` passes
  clean across the whole workspace.
- **NOT verified from this sandbox**: same PowerSync YAML-parsing/
  on-device sync caveats as every prior sync-rules change in this project.
  The item edit flow, supplier filter chips, and the supplier-labelled PDF
  output have not been exercised in a running app.

## Built-in map for roof measurements

- **What was built**: a satellite-map polygon tool for measuring roof
  facets on-site. `job_measurements` (append-style history, like
  `job_notes` - a roof can legitimately be re-measured over time) stores
  one or more facets as jsonb (`id`, `name`, `pitch_degrees`,
  `flat_area_sqm`, `true_area_sqm`, `coordinates`), plus the tenant-wide
  totals and an optional snapshot path. A new
  `sales/jobs/measure.tsx` screen (reached via a "📐 Measure Roof" button
  on the job detail screen, right after Photos) shows a `react-native-maps`
  `MapView` in `mapType="satellite"`, centered on the job's site/client
  address (geocoded) or the device's current location as a fallback.
  Tapping the map adds a vertex to whichever facet is currently "active";
  a bottom drawer lists every facet with a rename-on-tap name, a +/-5°
  pitch stepper (0-60°), and live flat/true area figures. "Save & Append
  to Job Card" takes a snapshot of the map, attaches it as a job photo via
  the existing `addJobPhoto`/attachment-queue pipeline (already
  offline-capable - nothing new needed there), inserts the
  `job_measurements` row, and appends a formatted summary (date, total
  true area, per-facet breakdown) as a `job_notes` row - all via
  `powersync.execute()`, so the whole flow works with no connection.
- **New native dependencies - this needs a new dev-client/EAS build**:
  `react-native-maps` (satellite map, polygon drawing, snapshot capture)
  and `expo-location` (geocoding + current-location fallback) are both
  native modules, added to `apps/mobile/package.json` and to the config
  plugins list. Neither is optional or JS-only - like every other native
  dependency added this project (react-native-quick-sqlite, expo-camera,
  etc.), existing installs need a fresh native build before this feature
  will work; a plain JS reload is not enough this time.
- **A real new external requirement: an Android Google Maps API key**.
  iOS deliberately needs no key - `react-native-maps` uses Apple's native
  MapKit there by default (`PROVIDER_DEFAULT`), which supports
  `mapType="satellite"` with no setup or cost. Android has no equivalent
  "just use the OS's own maps" option - `react-native-maps` always uses
  the Google Maps SDK on Android, and that SDK requires a key just to
  render *any* tiles, satellite included. This is a genuine new
  prerequisite, on top of Supabase/PowerSync: create a key at
  [Google Cloud Console](https://console.cloud.google.com/google/maps-apis),
  enable "Maps SDK for Android", restrict it to this app's package name
  (`au.bingley.jmssaas`) plus your signing certificate's SHA-1, and set
  `GOOGLE_MAPS_API_KEY_ANDROID` in `apps/mobile/.env` (see the updated
  `.env.example`). This is a native-only secret, deliberately not
  `EXPO_PUBLIC_`-prefixed - it's read by `apps/mobile/app.config.js` (see
  below) and baked into `AndroidManifest.xml` at prebuild time, never
  inlined into the JS bundle. There's no in-app way to surface a friendly
  error for a missing key the way `EXPO_PUBLIC_APPROVAL_PAGE_URL` does -
  it's consumed at native build time, not JS runtime, so a missing/wrong
  key doesn't fail the build; the app installs fine and only then crashes
  on-device the moment the map screen mounts (`IllegalStateException: API
  key not found`), confirmed exactly this way on a real device.
- **`.env` alone is NOT enough for `eas build` - confirmed wrong by that
  same live crash, corrected here rather than silently fixed**. The
  original version of this note claimed `.env` was sufficient because
  `app.config.js` reads it directly. That's true for anything evaluating
  `app.config.js` *locally* (`expo start`, a local prebuild) - it is
  **not** true for `eas build`, which runs on Expo's own cloud servers
  against a fresh clone of the git repo. `.env` is (correctly) gitignored,
  so it never reaches that server, `GOOGLE_MAPS_API_KEY_ANDROID` was
  `undefined` when `app.config.js` ran during the cloud build, and the
  resulting APK shipped with no key in its manifest at all - installed and
  ran fine right up until the map screen tried to mount. The actual fix:
  register the key as an **EAS environment variable** (visible to the
  cloud build, not just your local shell), which `app.config.js` already
  reads via `process.env.GOOGLE_MAPS_API_KEY_ANDROID` as its first choice
  (the `.env` parsing is the *fallback*, for local builds only):
  ```
  eas env:create --name GOOGLE_MAPS_API_KEY_ANDROID --value "your-key" --visibility sensitive --environment development
  ```
  Repeat with `--environment preview`/`--environment production` once
  those profiles exist. Re-run `eas build` after this - the key has to be
  registered *before* the build that needs it, not just before you install
  the resulting APK.
- **`app.json` became `app.config.js`, a real structural change**: this
  was needed so `GOOGLE_MAPS_API_KEY_ANDROID` could be read from `.env` at
  config-evaluation time - the Expo CLI's automatic `.env` loading is only
  documented for `EXPO_PUBLIC_`-prefixed vars going into the JS bundle,
  not for arbitrary vars being available in `process.env` when
  `app.config.js` itself runs. Rather than depend on undocumented
  behaviour, `app.config.js` parses `apps/mobile/.env` itself (a few lines
  of hand-rolled parsing, no new dependency) and reads
  `GOOGLE_MAPS_API_KEY_ANDROID` from that. Every other field is an
  unchanged copy of the old `app.json`, which was deleted rather than
  left alongside the new file (Expo prefers `app.config.js` when both
  exist, so keeping both would just be a stale, confusing duplicate).
- **"Geodesic flat polygon area" is an equirectangular approximation, not
  a full ellipsoidal geodesic algorithm - a deliberate, documented
  simplification**. `polygonFlatAreaSqm` in `packages/shared/src/geo.ts`
  projects each vertex to local planar metres (centred on the polygon's
  own mean latitude) and runs the standard shoelace formula, rather than
  pulling in a Vincenty/Karney-style geodesic library. At roof/building
  scale (tens to a few hundred m²) the difference between this and a true
  ellipsoidal calculation is negligible - this is the same approach
  industry roof/solar measurement tools use at this scale. "Geodesic" here
  means "accounts for real-world metres via latitude, not raw lat/lng
  degrees," not "ellipsoidal surface area."
- **Pitch compensation** (`trueAreaSqm`) is exactly the requested
  `flatArea / cos(pitchRadians)`, with a guard against `pitch >= 90°`
  (`cos <= 0`) that should never trigger given the UI's 0-60° stepper
  range, but is there in case this function is ever called from somewhere
  that doesn't enforce that bound.
- **Centering "on the job address" uses `expo-location`'s
  `geocodeAsync`, not a paid geocoding REST API** - forward geocoding
  through `expo-location` uses the *device's own* native geocoding
  (Apple's on iOS, Google Play services' on Android), the same thing
  Maps/Search apps use, at no extra cost and with no separate API key
  needed. This avoids standing up a second Google API key/service (a raw
  REST Geocoding API key shipped in the client would also be a real
  security smell - unlike a native SDK key restricted by package name/SHA-1,
  a REST key is much harder to lock down safely from a mobile client). If
  geocoding the job's site/client address returns nothing, the screen
  falls back to the device's current position (`getCurrentPositionAsync`,
  hence the location permission), then to a fixed default region
  (Sydney) as a last resort where the person is expected to pan manually.
  **Bug found and fixed from live device testing**: the original code only
  requested location permission in the current-position fallback path,
  after already attempting `geocodeAsync` first - reasonable for iOS,
  where `CLGeocoder` is a pure lookup needing no permission at all, but
  wrong for Android: its native `Geocoder` (what `geocodeAsync` calls
  under the hood) threw `Not authorized to use location services` on a
  real Android device, confirming it does require permission there too.
  Fixed by requesting permission once, up front, before attempting
  geocoding at all - a denied/unavailable permission still falls through
  the same chain (geocode fails the same way it would offline, then skips
  straight to the default region instead of also trying
  `getCurrentPositionAsync`).
- **A facet has no independent lifecycle of its own, so it isn't a child
  table** - it's never queried, filtered, or joined outside its parent
  measurement, so it's stored as a `jsonb` array on `job_measurements`
  rather than a normalised `job_measurement_facets` table, avoiding
  migration/RLS/PowerSync overhead for something with no real relational
  need. `total_flat_area_sqm`/`total_true_area_sqm` are stored redundantly
  (derivable by summing facets) purely so other screens/reports can read
  one number without parsing jsonb - same reasoning as other denormalised
  totals elsewhere in this schema (e.g. quote/invoice `total_cents`).
- **RLS mirrors `job_notes`/`job_files` exactly** (visibility and insert
  follow the parent `job_cards` row - admin sees/edits everything, a
  technician only their own assigned job), since this is the same
  "job-scoped field data" shape. Unlike `job_notes` (append-only, no
  update policy), an update policy was added - a technician mid-measurement
  may need to fix a mis-tapped point or re-save after adjusting a pitch,
  not just create a new row every time. Delete is admin-only, matching
  `job_files`.
- **Only a finished facet's points can't be edited afterwards** - once
  "Finish facet" is tapped, that facet is locked (can still be deleted and
  redrawn, but not have individual points added/removed). This was a
  deliberate scope simplification to keep the active-facet state machine
  simple (exactly one facet can ever be "being drawn" at a time); the
  screen does support undoing the *last* point of the facet currently
  being drawn, so a mis-tap doesn't require restarting that facet from
  scratch.
- **Verified from this sandbox**: the migration was applied cleanly
  against a real local Postgres 16 instance alongside all 16 prior
  migrations. RLS was exercised live: an assigned technician could
  insert/select/update their job's measurement; an unassigned technician
  saw zero rows and was rejected on insert; the assigned technician's
  delete attempt was silently filtered (0 rows affected) while an admin's
  delete succeeded. `pnpm typecheck` passes clean across the whole
  workspace, including the new native map/location types. `app.config.js`
  was confirmed to `require()` cleanly and produce the expected plugin
  list. There is still no `build` script anywhere in this repo, consistent
  with every prior phase's note on this - `typecheck` remains the actual
  cross-package gate.
- **NOT verified from this sandbox**: this is the first native map/GPS
  integration in the app, and none of it has run on a real device or
  simulator - no dev-client build exists yet with `react-native-maps`/
  `expo-location` linked in, so the satellite rendering, tap-to-draw
  interaction, snapshot capture, and geocoding fallback chain are all
  unverified beyond `tsc`'s type-checking. Same PowerSync YAML-parsing/
  on-device sync caveat as every prior sync-rules change in this project.
  A fresh EAS/dev-client build and a real Android Google Maps API key are
  both required before this can be tested at all - see above.

## Customisable SMS & Email communication & automation engine

Automated SMS/email follow-ups (quote nudges, invoice reminders, an "On The
Way" text, a post-completion review request), with per-tenant timing/quiet
hours, editable message templates with `{token}` placeholders, and a
Communication Log on the Job/Client Details screens.

- **Three new tables** (`supabase/migrations/20260804000100_communication_engine.sql`):
  `communication_rules` (per `trigger_key` timing/channel/quiet hours,
  seeded with 6 defaults per tenant the same way `job_lifecycle_stages` is -
  see `seed_default_communication_rules`/`handle_new_tenant`),
  `communication_templates` (the actual copy, `{token}`s intact), and
  `scheduled_communications` (the send queue). `trigger_key` is duplicated
  onto `scheduled_communications` itself (not just reachable via
  `template_id`) so it survives a template being deleted and so the
  scheduling triggers can cheaply check "already scheduled?" without a
  join - not in the original spec, added during implementation.
- **Auto-scheduling was NOT in the original spec but is required for the
  feature to do anything** - the spec only described auto-*cancellation*.
  Two new triggers, `schedule_quote_communications`/
  `schedule_invoice_communications` (`after update on quotes`/`invoices`),
  fire when `status` transitions to `'sent'`, scheduling a row per
  enabled rule + matching template. Quote follow-ups offset from the send
  moment; invoice reminders offset from `due_date` (the meaningful
  reference for a payment reminder). Both guard against double-scheduling
  the same `trigger_key` for the same entity (e.g. flipping a quote back to
  draft and resending doesn't stack duplicate follow-ups) - confirmed live
  against a local Postgres instance, see below.
- **Auto-cancellation, as specified**: `cancel_pending_quote_communications`
  watches `quotes.approval_status` moving to `accepted`/`declined` (not
  `quotes.status` - confirmed by reading `accept_quote_by_token`/
  `decline_quote_by_token` in the `quote_invoice_approval` migration, which
  only ever touch `approval_status`); `cancel_pending_invoice_communications`
  watches `invoices.status` moving to `paid`. Both cancel that entity's
  still-`pending` `scheduled_communications` rows with a `cancellation_reason`.
- **`tenants.phone`/`tenants.google_review_link` added** - needed for the
  `{company_phone}`/`{google_review_link}` tokens, neither of which had
  anywhere to persist before this (email/website/logo_url were added
  separately in `invoice_pdf_rebrand`, phone never was). `phone` is edited
  from Company Settings (`apps/mobile/app/company-settings.tsx`);
  `google_review_link` is edited from the new Automation & Messaging
  Settings screen instead, since it's specifically a messaging concern, not
  a general company detail.
- **RLS**: `communication_rules`/`communication_templates` are tenant-read,
  admin-only write (same shape as `job_lifecycle_stages`). `scheduled_
  communications` is tenant-read **and tenant-wide insert** (matches
  `clients` - a technician's "On The Way" tap needs to insert a row from
  the field), admin-only update/delete. The scheduling/cancellation
  triggers write as the function owner, bypassing RLS regardless of these
  policies - they only govern direct client-side writes.
- **Placeholder engine exists in two copies** -
  `packages/shared/src/placeholders.ts` (used by the mobile app: the
  template editor's live preview, and to pre-render the two ephemeral
  tokens below) and a near-identical Deno-native port inside
  `supabase/functions/process-scheduled-comms/index.ts` (the dispatcher
  can't import from outside its own function directory - a Supabase Edge
  Function constraint, not a choice). Keep both in sync by hand if the
  token set ever changes.
- **Dispatcher** (`supabase/functions/process-scheduled-comms`): a
  service-role-only Edge Function, meant to be invoked periodically by
  `pg_cron` -> `net.http_post`. Each sweep fetches due `pending` rows
  (`scheduled_for <= now()`, batched at 50), checks quiet hours, renders
  final text, sends via Twilio (SMS) or Resend (email), and updates
  `status`/`sent_at`/`failure_reason`.
  - **Quiet hours are the ALLOWED sending window**, not a do-not-disturb
    window, despite the column name - the default `08:00`-`18:00` only
    makes sense read that way. A row due outside the window is deferred by
    pushing `scheduled_for` to the next occurrence of `quiet_hours_start`,
    not sent late or dropped. Hardcoded to `Australia/Sydney` - there's no
    `tenants.timezone` column, and this app already assumes AU-only
    everywhere else that cares about locale (GST math, en-AU dates, the
    roof measurement screen's Sydney fallback region), so adding one here
    would solve a problem this product doesn't have yet.
  - **Rendering is split by entity_type**: `quote`/`invoice` rows arrive
    with `{token}`s fully intact (the scheduling triggers just copy the
    template), so the dispatcher rebuilds `{quote_*}`/`{invoice_*}`/
    `{client_*}`/`{company_*}` context from the database and renders the
    whole thing, including generating the quote/invoice approval link via
    the existing `generate_quote_approval_link`/`generate_invoice_approval_link`
    RPCs (same URL shape the mobile app already uses:
    `${APPROVAL_PAGE_URL}?type=quote&token=...`). `job` rows (the mobile
    app's manual "On The Way"/review-request triggers) arrive with
    `{tech_first_name}`/`{eta_minutes}` **already substituted client-side**
    - those come from the exact tap (who's driving, what ETA they typed)
    and have nowhere to be reconstructed from later - every other token is
    left raw for the dispatcher to resolve from `job_cards`/`clients`/
    `client_sites`/`tenants`, the same way it does for quote/invoice rows.
    This is what lets "On The Way" queue entirely offline: the mobile app
    never needs company bank details, the review link, etc. - none of
    which are PowerSync-synced to the device at all (`tenants` isn't a
    PowerSync table).
  - **Immediate single-row dispatch, added after the initial build**: the
    cron sweep alone meant an "On The Way" text could sit `pending` for up
    to the sweep interval (5 minutes in the example schedule below) before
    actually going out - fine for quote/invoice follow-ups, not fine for
    "I'm 15 minutes away" arriving 4 minutes late. The same function now
    also accepts `POST { id }` with a normal signed-in user's bearer token
    (any role, not just admin - a technician needs this) instead of the
    service-role token; it looks up the caller's own `tenant_id` from
    their `profiles` row, fetches that one `scheduled_communications` row
    **scoped to that tenant_id**, and sends it immediately, skipping the
    quiet-hours check entirely (a human tapping the button right now is a
    real-time action, not a background nudge that should wait for business
    hours). `apps/mobile/lib/dispatch-now.ts` calls this right after
    `queueScheduledCommunication` inserts a row (see the job detail
    screen), and swallows any failure - offline, cold start, whatever - so
    the row falls back to the ordinary cron sweep exactly as before. This
    means **redeploying the function** (same command below) is required to
    pick up this behavior; nothing about the cron sweep path changed.
  - **New Edge Function secrets** (`supabase secrets set ...`, or via the
    dashboard): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
    `TWILIO_FROM_NUMBER` for SMS; `RESEND_API_KEY`, `RESEND_FROM_EMAIL` for
    email; `APPROVAL_PAGE_URL` (same value as the mobile app's
    `EXPO_PUBLIC_APPROVAL_PAGE_URL`, just without the `EXPO_PUBLIC_` prefix
    since this runs server-side) to build quote/invoice links. Twilio and
    Resend were picked as the default providers (SMS/email respectively)
    purely because neither this app nor its docs specified one - both are
    called through a plain `fetch`, easy to swap for MessageMedia/SMTP/etc.
    later without touching anything else in the function.
  - **Deploy + schedule** (one-time, project-specific, can't be baked into
    a migration since it needs the project's own deployed URL and a
    service-role bearer token):
    ```
    supabase functions deploy process-scheduled-comms --no-verify-jwt
    ```
    then, in the SQL editor (requires the `pg_cron` and `pg_net`
    extensions, enabled via Database -> Extensions):
    ```sql
    select cron.schedule(
      'process-scheduled-comms',
      '*/5 * * * *',
      $$
      select net.http_post(
        url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/process-scheduled-comms',
        headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
      );
      $$
    );
    ```
- **Mobile**: a new **Automation & Messaging** screen
  (`apps/mobile/app/automation-settings.tsx`, linked from the Settings
  tab) - PowerSync-backed like Job Setup/Inventory Setup, so timing/message
  edits work offline. Deliberately scoped to editing the six `trigger_key`s
  this migration seeds, not a fully custom "add your own automation"
  builder. The job detail screen gained a "Notify client" section (On The
  Way button, prompts for ETA minutes) and a completion prompt ("Send a
  review request?") on the Status chip moving to Completed - both insert
  directly into the local PowerSync-synced `scheduled_communications`
  table, no server round trip. A new `CommunicationLog` component
  (`apps/mobile/components/CommunicationLog.tsx`) shows sent/pending/
  cancelled/failed history with status badges; used on the job detail
  screen (job itself plus its linked quotes/invoices, since those are
  already fetched there) and, more narrowly, on the client detail screen
  (that client's jobs only - quote/invoice follow-ups aren't included
  there, since there's no offline-available way to look up "which quotes/
  invoices belong to this client" - quotes/invoices are Supabase-direct/
  online-only by design, not PowerSync-synced).
- **PowerSync**: `communication_rules`/`communication_templates`/
  `scheduled_communications` all joined the existing `tenant_reference_data`
  bucket (`powersync/sync-rules.yaml`) - the first two tenant-wide read
  like `job_lifecycle_stages`, the third tenant-wide read *and write* like
  `inventory_levels`, since a technician's "On The Way" tap inserts
  directly from the field.
- **Verified from this sandbox**: the migration was applied cleanly against
  a real local Postgres 16 instance alongside all 17 prior migrations.
  Live-exercised: a new tenant auto-seeds all 6 rules + templates; sending
  a quote schedules `quote_stage_1`/`quote_stage_2` with the raw template
  text and correct `scheduled_for` offsets; re-sending doesn't duplicate
  rows; accepting the quote cancels both pending rows with the right
  `cancellation_reason`; RLS was confirmed live under `set role
  authenticated` - a technician can insert a `scheduled_communications` row
  but an update from that same role affects 0 rows (admin-only), matching
  the policy definitions. `pnpm typecheck` passes clean across the whole
  workspace. As with every prior phase, there's still no `build` script in
  this repo - `typecheck` remains the actual cross-package gate.
- **NOT verified from this sandbox**: the dispatcher Edge Function has
  never actually run against a deployed Supabase project - there's no
  instance provisioned here to deploy it to, no real Twilio/Resend
  credentials to send through, and no `pg_cron`/`pg_net` extension to
  schedule it with. Its logic (quiet-hours math, context-building queries,
  the Twilio/Resend HTTP calls) is reviewed and typechecked but not
  execution-tested end-to-end. The mobile screens (Automation & Messaging
  Settings, the On The Way modal, the Communication Log) are unverified
  beyond `tsc` - no dev-client build exists with the current dependency set
  to test against a real device, same caveat as the roof measurement phase
  before it.

## SMS removed - email only (for now)

Real-device testing surfaced a chain of Twilio issues (wrong credentials,
wrong "From" number, recipient numbers stored in local Australian format
instead of the E.164 Twilio requires) that took several rounds to work
through, and the decision was made to drop SMS entirely for now and focus
on building out the email side of the communication engine properly, with
SMS potentially revisited later behind a different provider.

- **`supabase/functions/process-scheduled-comms`**: `sendSms` and the
  AU-phone-number E.164 normalizer were deleted outright (see git history
  if SMS is ever revisited - the old code is a reasonable starting point
  for whatever provider replaces Twilio). `dispatchOne` now only sends via
  Resend; a row whose `channel` isn't `'email'` fails immediately with a
  clear `failure_reason` instead of attempting a provider that no longer
  exists, rather than silently doing nothing.
- **Schema left untouched** - `communication_rules.channel` and
  `communication_templates.type` still allow `'sms'`/`'both'` at the
  database level (their check constraints weren't touched). Ripping that
  out would be a real, riskier migration for a decision that might get
  reversed; leaving the shape in place means a future SMS provider slots
  back in without a schema change, it just needs `dispatchOne`'s email-only
  guard removed/extended.
- **New migration** (`20260810000100_communication_engine_email_only.sql`):
  flips every existing tenant's seeded `communication_rules.channel` and
  `communication_templates.type` from `sms`/`both` to `email` (backfilling
  a sensible `subject` per `trigger_key`, since sms-type templates never
  had one), and replaces `seed_default_communication_rules`/
  `seed_default_communication_templates` so every new tenant seeds
  email-only from now on. Verified against a local Postgres 16 instance:
  applied cleanly after all 18 prior migrations, a fresh tenant seeds
  email-only, and a simulated pre-migration tenant (rules/templates forced
  back to `sms` first) correctly backfills to `email` with the right
  default subjects.
- **Mobile** (`apps/mobile/app/automation-settings.tsx`): the per-rule
  Channel chip picker (sms/email/both) was removed from the edit modal -
  there's nothing to choose right now, so showing a picker with only one
  working option would just be confusing. `handleSaveRule` hardcodes
  `channel: "email"` instead. The per-rule summary line's "Channel: sms ·"
  prefix was dropped too, for the same reason.
- **Not touched**: `packages/shared/src/schemas.ts`/`types.ts` still
  define the full `sms`/`email`/`both` union - same "leave the flexible
  shape, remove the working path" reasoning as the database schema.

## Email reminder ladder + one-click accept/decline

First scoped slice of the larger email automation feature list (quote
reminders/conversion + payment escalation, per that list's own grouping) -
job lifecycle emails, conditional branching/custom merge fields, read
receipts/custom SMTP, and retention campaigns are all still deferred.

- **5 new trigger_keys** (`supabase/migrations/20260815000100_communication_engine_reminder_ladder.sql`):
  `quote_expiring_soon` (7 days before `quotes.expiry_date`), `quote_expired`
  (on `expiry_date` itself), `invoice_due_today` (on `due_date`),
  `invoice_overdue_14` (14 days after `due_date`), and
  `invoice_payment_received` (immediately when `invoices.status` becomes
  `'paid'`). Seeded for every tenant, existing and new, same idempotent
  "seed function + backfill loop" pattern as every earlier trigger_key
  addition in this file.
- **`schedule_quote_communications` learned a second reference date** -
  previously every quote trigger_key was offset from `now()` (the send
  moment); `quote_expiring_soon`/`quote_expired` need `expiry_date`
  instead, so the reference is now chosen per trigger_key inside the loop.
  A quote with no `expiry_date` set (nullable field) simply skips those two
  trigger_keys - confirmed live: a quote sent with `expiry_date` = today+10
  scheduled `quote_expiring_soon` for today+3 and `quote_expired` for
  today+10, alongside the existing `quote_stage_1`/`quote_stage_2` at
  today+3/+7, all four correct simultaneously.
- **`invoice_payment_received` is a genuinely different shape** - not
  scheduled when the invoice is sent, but when it's marked paid, with a
  brand new trigger (`schedule_invoice_payment_receipt`, `after update on
  invoices`) watching the same `status = 'paid'` transition the existing
  `cancel_pending_invoice_communications` trigger already watches. Both
  fire on the same event; Postgres runs same-event triggers in alphabetical
  order by trigger name, and `cancel_pending_invoice_communications_
  trigger` sorts before `schedule_invoice_payment_receipt_trigger`, so the
  cancellation (which cancels this invoice's still-pending reminder rows)
  always completes before the receipt row is inserted - confirmed live: on
  marking a sent invoice paid, all 4 still-pending reminder rows
  (`invoice_pre_due`/`invoice_due_today`/`invoice_overdue_1`/
  `invoice_overdue_14`) flipped to `cancelled` with reason "Invoice paid",
  and `invoice_payment_received` landed as a fresh `pending` row in the
  same statement, not accidentally caught by the cancellation.
- **One-click accept/decline**: two new tokens,
  `{quote_accept_link}`/`{quote_decline_link}` (`packages/shared/src/
  placeholders.ts` and the dispatcher's Deno port - both need updating by
  hand, same as every other token addition), built as `{quote_approval_
  link}` plus `&action=accept`/`&action=decline`. `supabase/static/
  approval-page.html` reads `?action=` and, on that page load, pre-fills
  the accept form's name with the client's own name on file and scrolls it
  into view (decline gets the reason box focused/scrolled) - **deliberately
  not an auto-submit on page load**, even though the link already encodes
  the intended action: corporate email security gateways (Microsoft Safe
  Links, Proofpoint, Mimecast, ...) prefetch every link in an inbound email
  to scan for phishing before a human ever opens it, and a plain GET-page-
  load firing a mutating accept/decline would let those scanners silently
  resolve every quote the instant it lands in an inbox. A human still only
  needs one real tap on the button after opening the link; the mutating
  POST only ever happens from that explicit tap. **This page is redeployed
  by re-uploading the file to Supabase Storage** (see the original "Quote/
  invoice digital acceptance" section above) - it is NOT part of `supabase
  functions deploy` or `supabase db push`, easy to forget.
- **Template bodies can now contain raw HTML** - `quote_stage_1`/
  `quote_stage_2`/`quote_expiring_soon`'s seeded bodies embed styled
  `<a href="{quote_accept_link}">`/`<a href="{quote_decline_link}">`
  button markup directly. There's no visual/WYSIWYG template builder (that's
  explicitly deferred, see the "Engine deep-features" option not chosen for
  this pass) - an admin just types HTML into the same plain multiline body
  field the Automation & Messaging Settings screen already has. `sendEmail`
  in the dispatcher now sends both `html` (the body, `\n` converted to
  `<br>`, everything else passed through untouched) and `text` (an HTML-tags-
  stripped fallback) to Resend, so both HTML-capable and plain-text email
  clients get something sensible, and existing non-HTML templates (job/
  invoice ones) round-trip unchanged in the `text` part.
- **`quote_expired` deliberately has no accept/decline buttons** - a real
  gap found while writing it, not fixed here: `accept_quote_by_token`/
  `decline_quote_by_token` (see the `quote_invoice_approval` migration)
  only ever check the approval TOKEN's own 30-day `token_expires_at`, never
  the quote's own business `expiry_date` - so an accept button on an
  "expired" email would actually still succeed server-side even though the
  price is meant to no longer be honoured. Worked around here by simply not
  offering the button on this one email (copy asks the client to get in
  touch instead); the underlying RPC gap is unfixed and would need its own
  migration if this becomes a real problem (checking `expiry_date` inside
  `accept_quote_by_token`, deciding what "an accepted-but-expired quote"
  should even mean for downstream conversion-to-invoice flows).
- **"Instant Receipt & Certificate Delivery" is only half built** -
  `invoice_payment_received` sends a plain confirmation email, but does NOT
  attach the paid PDF invoice or any compliance certificates, both asked
  for in the original feature list. PDF generation in this app is
  currently client-side only (`apps/mobile/lib/pdf.ts`, run on the admin's
  own device) - there's no server-side PDF pipeline this Edge Function
  could call into, and "compliance certificates" isn't a concept that
  exists anywhere in this schema yet. Both are meaningfully separate
  follow-up projects, deliberately deferred rather than half-built badly.
- **Payment links are still not real payment processing** - the wishlist
  asked for "embedded payment link (Stripe/Square/PayPal)"; `{invoice_
  payment_link}` still points at the same approval page as before (view/
  accept the invoice), not an actual checkout. Integrating a real payment
  processor is a substantial, separate piece of work, out of scope here.
- **Verified from this sandbox**: the new migration applies cleanly after
  all 19 prior migrations against a real local Postgres 16 instance. Live-
  exercised end to end as described above (quote expiry-based scheduling,
  invoice ladder, payment-receipt trigger ordering) - all outcomes matched
  expectations. `pnpm typecheck` passes clean across the whole workspace.
  The approval page's inline script was parsed with Node's `Function`
  constructor to confirm it's syntactically valid JS (not a substitute for
  loading it in a real browser, see below).
- **NOT verified from this sandbox**: no Resend account exists here to
  actually send an email and see how Gmail/Outlook render the HTML button
  markup, nor to confirm the multipart html/text split behaves as
  expected. The approval page's new pre-fill/scroll-into-view behavior
  hasn't been opened in a real browser from a real `?action=accept` link.
  Both need a real send + a real click-through to fully confirm.

Next up: job lifecycle emails (prep-your-site checklist, meet-the-
technician bio, completion summary, the 1-3 vs 4-5 star review gatekeeper),
then the deeper engine features and retention campaigns, per the
still-open items from the original feature list.

## Fixed a real gap: there was no way to actually send a quote/invoice by email

Found while about to test the reminder ladder: "Generate & share approval
link" (both the quote and invoice detail screens) only ever handed the
link to the native OS Share sheet - the admin had to manually pick an app
themselves, which might not even be email, and none of it went through
this app's own email infrastructure at all. Worse, that action was
completely disconnected from the Status chip that actually matters -
`schedule_quote_communications`/`schedule_invoice_communications` (the
whole reminder-ladder engine built in the two prior migrations) only fires
when `status` transitions to `'sent'`, which an admin sets independently
by tapping a chip - so the ladder could silently never start (status
flipped without anything ever being sent) or a document could genuinely be
shared without the ladder ever kicking in (status never flipped).

- **Two new manual trigger_keys** (`supabase/migrations/20260816000100_communication_engine_manual_send.sql`):
  `quote_sent`/`invoice_sent` - same shape as `job_on_the_way`/
  `job_review_request` (mobile-inserted, not touched by the auto-scheduling
  triggers), admin-editable from Automation & Messaging Settings like every
  other trigger_key. `quote_sent`'s seeded template includes the same
  Accept/Decline button markup as the follow-up templates.
- **New "Send Quote/Invoice via Email" button** on both detail screens
  (`apps/mobile/app/(tabs)/sales/quotes/[id].tsx` and `.../invoices/
  [id].tsx`, both admin-only) - looks up the tenant's `quote_sent`/
  `invoice_sent` rule and template, inserts a `scheduled_communications`
  row (Supabase-direct, since these screens are already online-only),
  calls the same `lib/dispatch-now.ts` immediate-dispatch helper the job
  screen's On The Way button uses, and **sets `status = 'sent'` in the same
  action** - the two things that used to be separate, disconnectable steps
  now always happen together. The old Share-sheet button is kept as a
  fallback (no email on file, or the admin prefers texting/WhatsApp-ing it
  themselves) - it no longer claims to be the primary way to send anything.
  Requires the client to have an email on file; a clear inline error points
  at Client Details if not.
- **No separate `generate_quote_approval_link`/`generate_invoice_approval_link`
  call needed from the mobile app** for the new button - the dispatcher's
  `buildEntityContext` already calls that RPC internally whenever it
  renders `{quote_accept_link}`/`{quote_decline_link}`/etc., so the token
  (and the `approval_status = 'sent'` side effect that RPC has) gets
  created as part of sending, not as a separate step.
- **Verified from this sandbox**: the migration applies cleanly after all
  20 prior migrations. Live-exercised: a fresh tenant seeds 13 trigger_keys
  total (11 from the two prior migrations + these 2); inserting a manual
  `quote_sent` row exactly the way the mobile button does, then flipping
  `status` to `'sent'` afterward, correctly ALSO scheduled the normal
  `quote_stage_1`/`quote_stage_2` follow-ups with no collision between the
  manual row and the auto-scheduled ones (different trigger_keys, the
  idempotency check is scoped per trigger_key, confirmed live).
  `pnpm typecheck` passes clean across the whole workspace.
- **Update - verified on a real device**: the "Send Quote via Email"
  button was tapped for real (after fixing two real setup gaps found along
  the way, both worth recording rather than editing away silently):
  1. `APPROVAL_PAGE_URL`/`EXPO_PUBLIC_APPROVAL_PAGE_URL` had both been left
     as the literal placeholder text from `.env.example`
     (`your-deployed-approval-page.pages.dev`) - the approval page had
     never actually been deployed anywhere, so every accept/decline link
     in a real email 404'd. Fixed by deploying `supabase/static/approval-
     page.html` (renamed to `index.html`) to Netlify Drop and pointing
     both env vars at the real URL.
  2. Using Resend's test sender (`onboarding@resend.dev`, no domain
     verification) put the email straight in spam - expected for that
     sender, not a bug; needs a verified domain before this is usable for
     real clients.
  With both fixed: the email arrived, the HTML Accept/Decline buttons
  rendered as actual styled buttons (not raw markup), and tapping Accept
  correctly showed the pre-filled name + scrolled-into-view form, then
  after tapping the real "I accept" button, the quote's `approval_status`
  flipped to `accepted` and synced back into the app. This is the first
  real, end-to-end confirmation of the whole communication engine
  actually working outside a sandboxed Postgres instance.

## Job lifecycle emails

Third scoped slice of the email automation feature list, per the "Pre-Job &
Site Preparation" / "Post-Job & Quality Assurance" sections -
`supabase/migrations/20260817000100_communication_engine_job_lifecycle.sql`.

- **`job_prep_checklist`** - auto-scheduled, default 24 hours before
  `job_cards.scheduled_at`. First trigger_key in this whole engine that's
  offset from a `job_cards` column rather than a quote/invoice send or a
  status transition, and the first one that has to handle being
  **rescheduled**: `schedule_job_prep_checklist` fires on every
  `job_cards` insert/update, and whenever `scheduled_at` actually changes
  (first set, moved, or cleared), cancels any still-pending
  `job_prep_checklist` row for that job and schedules a fresh one against
  the new time - without this, moving a job's time would either leave a
  reminder firing at the old, wrong time, or never update at all. A job
  booked close enough that the computed `scheduled_for` would already be
  in the past just skips scheduling entirely, rather than letting the cron
  sweep fire a stale-looking "reminder" for a visit that's basically
  already happening.
- **`job_completion_summary`** - auto-scheduled, immediate, fired by
  `job_cards.status` becoming `'completed'` - same shape as
  `invoice_payment_received` (a new trigger watching a status transition,
  not tied to a send event).
- **New `{tech_first_name}`/`{booking_date}`/`{booking_start_time}` support
  server-side** - these tokens already existed (used by the mobile app's
  manual On The Way trigger, pre-rendered client-side before insert), but
  `process-scheduled-comms`'s `buildEntityContext` never populated them for
  auto-scheduled `job`-entity rows, since nothing needed them until now.
  Fixed by having the `job` branch look up the assigned technician's
  `full_name` (via `job_cards.assigned_technician_id` -> `profiles`) and
  derive `booking_date`/`booking_start_time` from `scheduled_at` in Sydney
  local time (reusing the existing `sydneyPartsAndOffset` helper). Harmless
  no-op for `job_on_the_way`/`job_review_request` rows, which already have
  these substituted by the time they're inserted.
- **Two items from the same feature-list section deliberately NOT
  built**: "Meet Your Technician" bio (there's no bio/photo/accreditation
  field on a technician's profile anywhere in this schema - needs its own
  data model addition first, not just an email trigger) and the 1-3 vs 4-5
  star "Smart Feedback & Review Gatekeeper" (needs a public token-
  authenticated rating page, a new table to store feedback, and a routing
  decision - meaningfully more new infrastructure than everything else in
  this migration combined, which only reuses the existing trigger/dispatch
  machinery). `job_review_request` is unchanged - still links straight to
  `{google_review_link}` with no gatekeeping in front of it.
- **Verified from this sandbox**: applies cleanly after all 21 prior
  migrations. Live-exercised: a job scheduled 5 days out correctly
  scheduled `job_prep_checklist` ~4 days out (24h before); rescheduling
  that job to 8 days out correctly cancelled the stale pending row
  (`cancellation_reason = 'Job rescheduled'`) and scheduled a fresh one
  ~7 days out; marking the job `completed` immediately queued
  `job_completion_summary`. A fresh tenant now seeds 15 trigger_keys total.
  `pnpm typecheck` passes clean across the whole workspace.
- **NOT verified from this sandbox**: no real send yet for either new
  trigger_key - same caveat as everything else in this engine until it's
  tried against a real job on a real device.

## Retention campaigns

Fourth and final scoped slice of the email automation feature list, per the
"Customer Retention & Recurring Revenue" section -
`supabase/migrations/20260818000100_communication_engine_retention.sql`.
This is the first part of the engine that's genuinely a different shape
from everything before it - not tied to a single row's insert/update event.

- **`maintenance_reminder`** - still fits the existing "fires off an event"
  shape (scheduled the moment a job is marked completed), but the delay
  has to vary PER SERVICE CATEGORY (aircon winterisation every 6 months,
  an annual pest spray every 12), which a single tenant-wide
  `communication_rules` row can't express. Solved with a new
  `service_categories.maintenance_interval_months` column instead (nullable
  - no value means no recurring reminder for that category), editable from
  Job Setup alongside the category's name/color. `communication_rules`
  still has a `maintenance_reminder` row (for `is_enabled`/`channel`/quiet
  hours), but its `delay_offset_value`/`unit`/`direction` are unused filler
  for this one trigger_key - the mobile UI hides the delay editor for it
  entirely and points the admin at Job Setup instead.
- **`dormant_client_reengagement`** - genuinely has no single-row event to
  hook a Postgres trigger off at all: "12 months of silence" only becomes
  true because the calendar advances, not because anything changed in the
  database. Handled by a brand new Edge Function,
  **`supabase/functions/process-retention-campaigns`**, on its own daily
  `pg_cron` schedule (separate from `process-scheduled-comms`'s 5-minute
  sweep - no need to re-check "has it been a year" that often). It only
  detects and queues a `pending` `scheduled_communications` row per newly-
  dormant client; the actual send still goes through the normal
  `process-scheduled-comms` sweep, same quiet-hours handling as everything
  else. `communication_rules.delay_offset_value`/`unit` on this trigger_key
  ARE used, just for something different from everywhere else - "days of
  inactivity" rather than an offset before/after a single event (default
  365 days) - the mobile UI relabels the field accordingly.
- **`scheduled_communications.entity_type` widened to include `'client'`**
  - a dormant client isn't a quote/invoice/job, so this is the first row
  ever scheduled against a client directly. The check constraint was
  dropped and recreated with the 5th value (the column itself untouched).
  `process-scheduled-comms`'s `buildEntityContext` gained a `client` branch
  (just resolves the client's own name/phone/email, no job/quote/invoice
  context to attach).
- **Idempotency is different for this trigger_key** - every other
  trigger_key checks "has this exact (entity_type, entity_id, trigger_key)
  ever been scheduled", which is right for a quote or invoice (only ever
  sent once). A client can legitimately go dormant, come back, and go
  dormant again years later - each dormancy deserves its own email. So
  `process-retention-campaigns` checks "has a
  `dormant_client_reengagement` row been scheduled for this client SINCE
  their most recent job" instead - once they book again, that reference
  date moves forward and a future dormancy period gets a fresh email, with
  no double-sending within the same one. Clients with zero job history are
  skipped entirely - never having booked isn't the same as going quiet.
- **Deploy this one separately** - it's a new Edge Function, not an
  addition to the existing one:
  ```
  supabase functions deploy process-retention-campaigns --no-verify-jwt
  ```
  then its own one-time `pg_cron` schedule (daily is enough; exact time
  doesn't matter much since the real quiet-hours-respecting send still
  happens through the normal dispatcher afterward):
  ```sql
  select cron.schedule(
    'process-retention-campaigns',
    '0 6 * * *',
    $$
    select net.http_post(
      url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/process-retention-campaigns',
      headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
    );
    $$
  );
  ```
- **Verified from this sandbox**: applies cleanly after all 22 prior
  migrations. Live-exercised: a job in a category with a 6-month
  maintenance interval, marked completed, correctly scheduled both
  `job_completion_summary` (immediate) and `maintenance_reminder` (~183
  days out); a job with no service category completing correctly scheduled
  neither. The dormant-client detection SQL (last-job aggregation, rule
  lookup, dormancy comparison, idempotency check) was run directly and
  confirmed correct for a backdated 400-day-old job against the 365-day
  default threshold. The widened `entity_type` check constraint was
  confirmed to accept `'client'` with a real insert. A fresh tenant now
  seeds 17 trigger_keys total. `pnpm typecheck` passes clean across the
  whole workspace.
- **NOT verified from this sandbox**: the new Edge Function itself has
  never actually run (no deployed instance here to invoke it against, and
  its SQL queries were verified by hand rather than through the function's
  own Deno code path) - same caveat as every other Edge Function in this
  engine until it's deployed and either its own cron fires or it's called
  by hand. No real send for either new trigger_key yet either.

This closes out all four slices of the original email automation feature
list that were explicitly scoped for building (reminder ladder, manual
send, job lifecycle, retention). Still open, by choice, from the very
first scoping conversation: the "Engine deep-features" bucket (conditional
branching by job type/value/tag, custom merge fields beyond the fixed
token set, open/click tracking, custom SMTP/white-labeling) - genuinely
more architectural, lower immediate day-to-day payoff, and each of its
four items is really its own project. Also still open from earlier
passes: the technician bio email (needs a new profile field) and the
star-rating review gatekeeper (needs a new public page + table + token
system).

## 8. Desktop app (`apps/desktop`) - foundation pass

A brand new package for the office/admin side of the business - dispatch,
quotes/invoices, price book, job costing, team management. Explicitly
scoped to build the foundation (auth, data layer, nav shell, deployment)
first and get it reviewed before every one of the 9 screens is built out,
same as the original mobile kickoff.

### Architecture decisions

- **Vite + React 19 + TypeScript**, not Next.js or CRA. This app has no
  SSR/SEO requirement (admin-only, behind auth) and no offline requirement
  - Vite's dev server and build are simpler and faster for that shape than
  Next's, and CRA is unmaintained. Adopted per the brief's own suggested
  default.
- **Tailwind CSS**, per the brief's own suggestion ("reasonable given the
  timeline") - same utility-first approach, just without React Native's
  `StyleSheet` indirection mobile uses.
- **`@tanstack/react-query`** for data fetching/caching - not explicitly
  requested, but a natural fit: every screen in this app is Supabase-direct
  and always-online (unlike mobile, which mixes PowerSync-offline and
  online-only screens behind bespoke `useSupabaseFetch`/`useRefetchOnFocus`
  hooks). React Query's cache invalidation replaces what PowerSync's local
  SQLite reactivity gives mobile for free.
- **`react-router-dom` v6** for SPA routing - the standard default for a
  Vite React app, not separately discussed with the client.
- **No PowerSync anywhere** - per explicit instruction. `lib/supabase.ts`
  is a plain `@supabase/supabase-js` client hitting the same tables/RLS
  policies mobile's PowerSync bucket definitions read from, just without
  the local-SQLite sync layer. This means clients/job cards/tasks (synced
  on mobile) get their own direct Supabase queries here instead - same
  data, same RLS, simpler access pattern appropriate for an app that's
  never expected to work offline.
- **Admin-only access** (flagged as a real product decision, not guessed):
  resolved as admin-only for now. A technician account can still
  authenticate against Supabase (`signIn` succeeds) but `RequireAdmin`
  (`src/components/RequireAdmin.tsx`) rejects them post-login with a clear
  message, mirroring `apps/mobile/app/company-settings.tsx`'s existing
  pattern for non-admins viewing an admin-only mobile screen. Revisit if a
  technician ever wants to check their own schedule from a home computer -
  nothing in the schema/RLS blocks it, only this one route guard does.

### What's built in this pass

- `src/lib/supabase.ts` - the plain Supabase client, `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` (Vite's equivalent of Expo's `EXPO_PUBLIC_`
  prefix convention - see `apps/desktop/.env.example`, same two values as
  `apps/mobile/.env.example` under different var names).
- `src/lib/auth-context.tsx` - `AuthProvider`/`useAuth`, session +
  `profiles` row + `isAdmin`. Profile refetch is deliberately keyed on
  `session?.user.id`, not the `session` object itself, for the same reason
  documented in `apps/mobile/lib/auth-context.tsx` (Supabase hands out a
  new session object on token refresh, not just sign-in/out) - no
  PowerSync reconnect loop to break here, but re-fetching the profile on
  every token refresh would still be wasted work.
- `src/pages/Login.tsx` + `src/components/RequireAdmin.tsx` - admin-only
  auth guard described above. Unauthenticated users are redirected to
  `/login` with `state={{ from: location.pathname }}`, so a direct link to
  a specific screen still lands there after signing in.
- `src/components/Layout.tsx` - sidebar nav (Dispatch, Sales group
  [Jobs/Quotes/Invoices/Clients/Price Book], Calendar, Team, Settings),
  matching the sections listed in the brief. Every route except `/login`
  renders inside this shell.
- `src/pages/Stub.tsx` + `src/App.tsx` - all 9 feature routes exist and are
  reachable (proving the nav shell + route guard work end to end) but
  render a plain "not built yet" placeholder. This is intentional: nothing
  beyond the foundation was built in this pass, per the brief's explicit
  instruction to get it reviewed first.
- `apps/desktop/vercel.json` - SPA rewrite (`/* -> /index.html`) so
  client-side routes don't 404 on a hard refresh/direct link.
- Wired into the root `turbo.json`/`pnpm typecheck` pipeline the same way
  `apps/mobile` and `packages/shared` are - `pnpm typecheck` at the repo
  root runs all three.

### Deploying to Vercel

Matching the existing `bingleyroof.com.au` Vercel project (this repo is a
pnpm/turbo monorepo, so a couple of settings need to point at the right
subdirectory - Vercel's dashboard, not a config file, is where most of
this lives):

1. Import this GitHub repo as a new Vercel project (separate from
   whatever project serves `bingleyroof.com.au` - same account, different
   project, since it's a different app on presumably a different
   subdomain, e.g. `app.bingleytrades.com.au`).
2. **Root Directory**: `apps/desktop` (Vercel dashboard -> Project
   Settings -> General). Vercel auto-detects the Vite framework preset
   from that directory and pre-fills Build Command
   (`vite build`)/Output Directory (`dist`) - leave those as detected.
3. Because this is a pnpm workspace, the install step needs to happen from
   the repo root, not `apps/desktop`. Vercel's monorepo support handles
   this automatically once it detects `pnpm-lock.yaml` at the repo root -
   no override needed under **Install Command**. If a deploy ever fails
   with "workspace:* not found" or similar, that's this step not running
   from the root - check the build log's install step.
4. **Environment Variables**: `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`, same values as `apps/mobile/.env` - safe to
   expose in the client bundle (anon key, meaningless without a valid
   RLS-scoped session).
5. Every push to `main` deploys to production; every PR gets its own
   preview URL - same flow `bingleyroof.com.au` already uses.

### Known gaps / judgment calls

- **All 9 feature screens are stubs.** Dispatch/Schedule, Jobs, Quotes,
  Invoices, Clients, Price Book, Calendar, Team, and Settings all render
  "not built yet" - by design, this pass is foundation-only.
- **The dispatch board's drag-and-drop is entirely unbuilt** - the brief
  flagged this as a decision to make ("how much of the full drag-and-drop
  to build in this first pass"), but with every screen still a stub, there
  was nothing to make that call against yet. Worth resolving explicitly
  before that screen is built: whether to hand-roll drag-and-drop on top
  of `calendar_events` or reach for a library (e.g. `dnd-kit` or
  `react-big-calendar`'s drag support) is a real architectural choice, not
  a detail to guess through mid-build.
- **No favicon** - the browser tab shows the Vite default; cosmetic, not
  fixed here.
- **No error boundary / 404 page beyond the catch-all redirect to
  `/dispatch`** - fine for a foundation pass, worth revisiting once real
  screens exist to lose data on.
- **Verified from this sandbox**: `pnpm install` at the repo root picked
  up the new workspace member cleanly; `pnpm typecheck` passes clean
  across `@jmssaas/shared`, `mobile`, and `desktop`; `pnpm --filter desktop
  dev` starts a working Vite dev server; loading it in a real browser
  (Playwright/Chromium) with a placeholder Supabase URL confirms the
  unauthenticated redirect to `/login` fires correctly and the Tailwind-
  styled login form renders as expected (screenshot reviewed by hand).
- **NOT verified from this sandbox**: no real Supabase project was used
  (placeholder `.env` values only, this sandbox has no deployed Supabase
  instance to sign in against) - the actual sign-in call, the `profiles`
  role check post-login, and the admin-only rejection message have not
  been exercised end-to-end with a real account. Nothing has been deployed
  to Vercel yet either - the steps above are written from the existing
  `bingleyroof.com.au` pattern and Vercel's documented monorepo behavior,
  not from having actually clicked through a deploy for this app.

## 9. Desktop app - Clients and Job cards screens

First real feature slice on top of the foundation above, per the user's
own choice ("Clients + Job cards" over Dispatch/Quotes+Invoices/Price book
as the starting point - lowest risk, and everything else depends on
clients/jobs existing).

### What's built

- **`src/pages/Clients.tsx`** - list (client-side name search, matching
  the "filter in JS over an already-fetched result set" convention used
  throughout mobile) + a "New client" modal. `src/pages/ClientDetail.tsx`
  - view, an "Edit" modal (same field set as create), and that client's
  jobs with a "New job" modal scoped to it. Field set mirrors
  `apps/mobile/app/(tabs)/sales/clients/{index,[id]}.tsx` exactly (name,
  phone, email, address lines, notes).
- **`src/pages/Jobs.tsx`** - list with the same category/stage filter
  chips + 4-way sort (created/scheduled/category/stage) as
  `apps/mobile/app/(tabs)/sales/jobs/index.tsx`, plus a "New job" modal
  with a client picker. `src/pages/JobDetail.tsx` - status/category/
  stage/technician as inline `<select>`s that save on change (no separate
  "Edit" modal needed here, unlike the client screen, since these are all
  single-value pickers rather than a multi-field form), a Notes section
  (add + list, oldest-last), and a read-only Photos grid.
- **Photos are view-only by design** - per the brief ("viewing photos
  already uploaded from mobile is useful, capturing new ones from a
  desktop webcam is not a priority"). Each thumbnail is a short-lived
  (1 hour) Supabase Storage signed URL, generated client-side via
  `supabase.storage.from("job-files").createSignedUrl(...)` - the
  `job-files` bucket is private (see
  `supabase/migrations/20260720000300_storage.sql`), so a plain public
  URL wouldn't work even if hardcoded.
- **`src/components/Modal.tsx` / `FormField.tsx`** - small shared
  primitives (centered modal, labelled input/textarea/select) now used
  across both Clients and Jobs, justified now that a second screen needs
  them - mirrors mobile's own `CenteredModal`/`FormField` split, just
  reimplemented in HTML/Tailwind instead of React Native.
- **No job costing tab, no Communication Log, no Tasks sub-list on this
  screen** - all present on mobile's much larger `jobs/[id].tsx` (890
  lines) but out of scope here: job costing is its own separate item in
  the Phase 1 desktop feature list (#7), and Communication Log/Tasks
  weren't called out as part of "Job cards — list, create, edit, notes."
  Worth adding if this screen becomes the primary place admins work from.
- **No offline/PowerSync anywhere in either screen** - every list and
  mutation is a direct `@supabase/supabase-js` call through React Query
  (`useQuery`/`useMutation`), consistent with the whole app's
  architecture. Unlike mobile's `usePowerSync`/`useQuery` (PowerSync's own
  reactive local-SQLite hook), nothing here updates live if changed from
  another tab/device - a mutation success handler explicitly
  `invalidateQueries`s the relevant list to refetch, and there's no
  cross-tab realtime subscription. Fine for an admin-only, mostly-single-
  operator app for now; worth a Supabase Realtime subscription later if
  multiple admins end up using this concurrently.

### Verified from this sandbox

- `pnpm typecheck` passes clean across the whole workspace, and
  `pnpm --filter desktop build` (the real `tsc --noEmit && vite build`
  production build, not just typecheck) succeeds - confirms no dead
  imports/build-time issues beyond what `tsc` alone catches.
- **All 23 migrations applied cleanly to a fresh local Postgres 16
  database** (with minimal `auth.users`/`auth.uid()`/`storage.objects`/
  `storage.foldername()` stubs, since a plain Postgres instance has
  neither GoTrue nor Storage - this only stands in for the schema/
  trigger layer, not real auth or file storage). Every query the two new
  screens issue was then run directly against that real schema, using
  the tenant-creation trigger flow from step 3 above (not hand-written
  profile rows) to catch drift between it and what's assumed here:
  `SELECT`/`INSERT`/`UPDATE` on `clients`, `SELECT`/`INSERT`/`UPDATE` on
  `job_cards` (including the category/stage/technician patch fields),
  `SELECT` on `service_categories`/`job_lifecycle_stages`/`profiles`
  (technician filter), and `INSERT`/`SELECT` on `job_notes`. All returned
  the exact column set `packages/shared/src/types.ts` declares - this
  matters because that file is hand-maintained (see its own top-of-file
  comment) and could in principle have drifted from the real migrations;
  it hasn't. The auto-generated job `number` (`J001`, `J002`, ...)
  confirmed the sequential-numbering trigger from the mobile pass still
  fires correctly when a row is inserted this way.
- Loading `/clients` directly while signed out (Playwright/Chromium)
  correctly redirects to `/login` with no console errors - confirms the
  new routes are properly wrapped by `RequireAdmin` and didn't
  accidentally leak outside `App.tsx`'s guarded route tree.

### NOT verified from this sandbox

- **No live click-through against a real Supabase project** - same
  caveat as the foundation pass. The SQL-level verification above proves
  the queries are shaped correctly against the real schema, but not that
  RLS grants the right access to an authenticated admin session, that
  Storage signed URLs actually resolve to a viewable image, or that the
  UI behaves correctly with real network latency/errors. Worth a manual
  pass through both screens against a real project before relying on them
  day-to-day.
- **Bundle size warning** - `vite build` warns the single JS chunk is
  ~696 kB (188 kB gzipped), over Rollup's 500 kB default threshold. Not a
  correctness issue and not fixed here; worth revisiting with route-based
  code-splitting once there are enough screens for it to matter.

## 10. Desktop app - job card photo upload, Quotes, Invoices

### Job card photo upload was missing entirely

Section 9 above scoped job card photos as view-only by design ("capturing
new ones from a desktop webcam is not a priority"). The person then
reported there was no way to upload an image to a job card from desktop at
all - reading that scoping note back, "capture" was read as meaning
specifically *webcam* capture, but the note as shipped also blocked plain
file-picker upload of existing photos (a spec sheet, a supplier invoice
photo, a screenshot), which was never the intent. Fixed:

- **`src/lib/uploads.ts`** (NEW) - `uploadJobPhoto()`, a direct port of
  `apps/mobile/lib/powersync.ts`'s `addJobPhoto` for a plain-Supabase
  context: same `<tenant_id>/<job_card_id>/<uuid>.<ext>` storage path
  convention (required - the storage RLS policies in
  `supabase/migrations/20260720000300_storage.sql` key off that exact
  shape), same `job_files` row shape, just a direct
  `supabase.storage.from("job-files").upload()` + insert instead of
  PowerSync's offline attachment queue (nothing to queue - always online).
- **`JobDetail.tsx`**'s Photos section gained an "+ Upload photos" button
  (`<input type="file" accept="image/*" multiple>`, hidden and triggered
  via a styled `<label>`) - uploads sequentially (not `Promise.all`, to
  avoid bursting Storage with a large multi-select) and invalidates the
  `job-files` query on success, which the existing `job-file-urls` query's
  key (joined file ids) naturally picks up as a refetch.
- **Going forward**: per instruction, the same "wherever mobile has image
  upload, desktop should too" standard now applies to future desktop
  screens - noted here so it isn't missed again. The only other mobile
  upload surface not yet built on desktop at all is task photos
  (`task_files`, via `addTaskPhoto`) - moot until a Tasks screen exists on
  desktop, which it doesn't yet (out of the Phase 1 desktop scope list).

### Roof measurement tool is not present on desktop

Flagged, not built in this pass. Mobile's measurement tool
(`apps/mobile/app/(tabs)/sales/jobs/measure.tsx`) is a satellite map with
polygon drawing and a facet manager, built on `react-native-maps` (Apple
Maps on iOS, Google Maps SDK on Android) - a native module with no direct
web equivalent. Bringing this to desktop is a real architectural decision
of the same shape as the dispatch board's drag-and-drop choice, not a
small addition:

- **Mapping library choice** - the natural web options are Google Maps
  JavaScript API (closest visual/behavioral match to mobile, but needs its
  own billing-enabled API key separate from `GOOGLE_MAPS_API_KEY_ANDROID`,
  and Google's JS SDK has its own polygon-drawing library
  - `google.maps.drawing`), Mapbox GL JS (better-known free tier, different
  polygon-editing ecosystem - `mapbox-gl-draw`), or Leaflet with a
  satellite tile provider (fully free/open-source, but satellite imagery
  quality varies by provider and it lacks the other two's native polygon-
  editing UX out of the box).
- **Data model needs no changes either way** - `job_measurements` (see
  `supabase/migrations/20260803000100_roof_measurements.sql`) stores
  facets as plain GeoJSON-shaped polygon coordinates and the shared
  `packages/shared`'s geo math (area/perimeter calculations) is already
  framework-agnostic - whichever library desktop picks, it only has to
  produce/consume the same polygon coordinate shape mobile already writes.
- **Recommendation when this gets picked up**: Google Maps JS API, for
  parity with mobile's satellite imagery source and because
  `google.maps.drawing.DrawingManager` is the closest match to the
  facet-by-facet polygon workflow already built and proven on mobile -
  but this is exactly the kind of call that should be confirmed before
  building, not guessed silently.

### Quotes and Invoices

Full line-item editor screens, mirroring `apps/mobile`'s quotes/invoices
stack (`new.tsx`/`[id].tsx`/`index.tsx` for each) as closely as a web
layout allows:

- **`src/lib/line-items.ts`**, **`src/lib/dispatch-now.ts`** - direct
  ports of the same-named mobile `lib/` files (`emptyLineItem`/
  `normalizeLineItem`, and the best-effort immediate-dispatch POST to
  `process-scheduled-comms`), logic unchanged, `VITE_` instead of
  `EXPO_PUBLIC_` for the one env var `dispatch-now.ts` reads.
- **`src/components/LineItemEditor.tsx`** (`LineItemEditor` + client-facing
  `LineItemSummary`) and **`AddLineItemBar.tsx`** (debounced price-book
  search + variation picker + custom-item fallback) - Tailwind
  reimplementations of the same-named mobile components, same
  `calculateDocumentTotals`-driven totals box, same admin-only breakdown
  fields vs. client-facing summary split.
- **`Quotes.tsx`/`QuoteNew.tsx`/`QuoteDetail.tsx`** and
  **`Invoices.tsx`/`InvoiceNew.tsx`/`InvoiceDetail.tsx`** - list, create
  (with client/job picker, optional template load, cross-linking via
  `?clientId=&jobCardId=` query params from a job card's own "+ New
  quote"/"+ New invoice" buttons), and detail (status chips, line-item
  editor, save via the same atomic `replace_quote_line_items`/
  `replace_invoice_line_items` RPCs mobile uses, "Send via Email" using
  the existing `quote_sent`/`invoice_sent` trigger_keys and
  `triggerImmediateDispatch`, and an approval-link button). Quotes gain a
  "Convert to invoice" modal (`convert_quote_to_invoice` RPC, same as
  mobile). Once a document's `approval_status` is `accepted`/`declined`
  the editor swaps for the read-only `LineItemSummary` and fields disable
  - mirrors mobile's `isLocked` handling of the same DB-level lock (see
  section 4's own note on `enforce_accepted_document_money_lock`).
- **`JobDetail.tsx`** gained a Quotes/Invoices two-column card showing
  linked documents with total + a "+ New quote"/"+ New invoice" link,
  mirroring mobile's cross-linking section.
- **Approval link handoff differs from mobile on purpose**: mobile hands
  the link to the native Share sheet; desktop has no share sheet, so
  `generateLink` copies the URL to the clipboard instead
  (`navigator.clipboard.writeText`) with a "Link copied!" button-label
  confirmation. Needs `VITE_APPROVAL_PAGE_URL` in `.env` (added to
  `.env.example`, same value as mobile's `EXPO_PUBLIC_APPROVAL_PAGE_URL`).
- **PDF export was NOT built** - mobile's `buildQuotePdfHtml`/
  `buildInvoicePdfHtml` + `exportPdf` rely on `expo-print`, a native
  module with no direct web equivalent, and PDF wasn't named in the
  Phase 1 desktop scope list's line-item editor item. A web equivalent
  (`window.print()` against a print-styled route, or a client-side PDF
  library) is a reasonable follow-up but is a separate scoping decision,
  not bundled into this pass.

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean
  across all three packages.
- **All 23 migrations reapplied to a fresh local Postgres 16 instance**
  (same throwaway-`auth`/`storage` stub setup as section 9), and every
  RPC/query the new screens call was run directly against the real
  schema: a quote created with line items, `replace_quote_line_items`
  (confirmed subtotal/gst/total recompute correctly - $1,100→$1,056 after
  editing the line items), `generate_quote_approval_link` (confirmed a
  real token + 30-day expiry get written), `convert_quote_to_invoice`
  called with the exact named-argument shape the desktop code uses
  (`p_quote_id`/`p_due_date`, relying on the RPC's `p_invoice_number
  default null` - confirmed this works, not just typechecks), which
  produced a correctly auto-numbered `INV001` with the quote's line items
  and totals copied over; then `replace_invoice_line_items` and
  `generate_invoice_approval_link` on that resulting invoice, and a second
  invoice created standalone (auto-numbered `INV002`, confirming the
  sequence continues correctly outside a conversion). Every result's
  column set matched `packages/shared/src/types.ts` exactly.
- Loading `/quotes`, `/quotes/new`, `/invoices`, `/invoices/new` directly
  while signed out (Playwright/Chromium) all correctly redirect to
  `/login` with no console errors.

### NOT verified from this sandbox

- No live click-through against a real Supabase project (same caveat as
  every prior desktop pass) - the SQL/RPC-level verification above proves
  correctness against the real schema, not that the UI behaves correctly
  end-to-end (price book search results rendering, the approval-link
  clipboard copy actually working in a real browser context, the "Send
  via Email" flow's queued-vs-sent messaging matching a real dispatch).
- The photo upload fix was verified by `tsc`/`vite build` only - no
  real Supabase Storage bucket was available in this sandbox to actually
  exercise an upload against.

## 11. Desktop app - Roof measurement tool

Closes the gap flagged in section 10: desktop had no equivalent of
mobile's satellite-map roof measurement tool at all. Built using **Google
Maps JavaScript API** - the recommendation from section 10's own writeup,
now confirmed and built rather than left as an open question.

### Why Google Maps JS API (not Mapbox/Leaflet)

- **Imagery parity with mobile** - mobile's Android build already uses
  Google's Maps SDK for satellite tiles (`GOOGLE_MAPS_API_KEY_ANDROID`);
  using the same provider's imagery on desktop means a roof measured on
  one platform looks the same on the other, rather than two different
  satellite imagery sources with potentially different capture dates/
  resolution.
- **No drawing library needed** - rather than reaching for
  `google.maps.drawing.DrawingManager` (a toolbar-driven rectangle/circle/
  polygon tool with its own UX, not well suited to "manage several named
  facets with individual pitch/rename/delete controls in a side panel"),
  the tool talks to the base Maps JS API directly: a single map click
  listener adds a vertex to whichever facet is "active", and
  `google.maps.Marker`/`Polygon`/`Polyline` overlays are rebuilt from
  React state on every change. This is a closer port of mobile's own
  click-to-add-vertex interaction (`onPress`->push coordinate) than any
  drawing-library toolbar would give.
- **Maps Static API reuses the same key for the snapshot** - see below.

### What's built

- **`src/lib/google-maps.ts`** - loads the Maps JS API via
  `@googlemaps/js-api-loader`'s newer functional API (`setOptions()` +
  top-level `importLibrary()` - the older `Loader` class this package
  used to export is now deprecated and untyped for this purpose, confirmed
  from its own shipped `.d.ts`). Pulls in the `maps` library (Map/Marker/
  Polygon/Polyline) and `geocoding` (Geocoder), cached behind a single
  module-level promise so concurrent callers share one load.
- **`src/pages/JobMeasure.tsx`** (route: `/jobs/:id/measure`) - port of
  `apps/mobile`'s `measure.tsx`:
  - **Region resolution**: geocodes the job's site (if picked) or client
    address via `google.maps.Geocoder`, falling back to the browser's own
    `navigator.geolocation.getCurrentPosition`, then a fixed Sydney
    default - the same three-step fallback chain as mobile's
    `expo-location`-based version, using browser APIs instead of native
    ones.
  - **Facet drawing**: "+ New Facet" activates a facet; a single map
    click listener (attached once, reading the active facet id from a
    ref so it never goes stale) appends a vertex to whichever facet is
    active; "Undo last point"/"Finish facet" match mobile exactly.
    Facets render as colored `Marker`s per vertex plus a `Polygon` once
    3+ points exist (a `Polyline` at exactly 2), rebuilt from scratch on
    every state change - simple and cheap at this scale (rebuilding a
    Polygon on every marker addition is a non-issue for the couple-dozen-
    vertex-per-facet scale this data actually has, in return for skipping
    a complexity budget that would be needed to diff two overlay sets).
  - **Facet panel**: same fields as mobile (color swatch, click-to-rename
    via a modal, pitch stepper clamped 0-60°, live flat/true area via the
    same `polygonFlatAreaSqm`/`trueAreaSqm` from `packages/shared`,
    delete). Laid out as a side panel next to the map (not stacked below
    it, unlike mobile) - a reasonable use of a desktop screen's extra
    width, and closer to the drawer-beside-canvas layout a desktop
    measuring tool would naturally have.
  - **Save**: validates with the same `createJobMeasurementSchema`,
    attempts a snapshot via the Maps **Static** API (a plain, CORS-enabled
    image URL with one `path=` parameter per facet - color, fill, and
    point list - and no `center`/`zoom` given, since Static Maps auto-fits
    bounds to the supplied paths), uploads it as a job photo via the same
    `uploadJobPhoto` helper section 10 built, inserts the
    `job_measurements` row, and appends the same plain-text summary to
    `job_notes` mobile writes. A failed snapshot doesn't block saving the
    measurement itself - same graceful-degradation reasoning as mobile's
    own `takeSnapshot` try/catch.
  - **Snapshot linkage is more precise than mobile's own version**: mobile
    sets `job_measurements.snapshot_path` to `"<tenant_id>/<job_id>"` (a
    folder prefix, not a specific file) because `addJobPhoto` never
    returns the id/path it generates internally. `uploadJobPhoto` (this
    app's equivalent, see section 10) does return the generated
    `storage_path`, so desktop's `snapshot_path` actually identifies which
    `job_files` row is the snapshot. This is a small, contained
    improvement scoped to desktop's own column value only - mobile's own
    behavior wasn't touched.
- **`JobDetail.tsx`** gained a "Roof Measurement" card: a "📐 Measure Roof"
  button (linking to the new route) plus a list of past measurements
  (title, date, total flat/true area) - mobile has no equivalent history
  list (it only offers the button), added here since desktop has the
  screen space and it's a natural read of data that already exists.

### Google Maps API key setup

Unlike mobile's Android SDK key (baked into a manifest at native-build
time, never shipped in JS), this is a **browser JS API key**, deliberately
`VITE_`-prefixed and bundled into the client - that's how Google's own JS
API is designed to be used. Protect it with **HTTP referrer restrictions**
in the Google Cloud Console, not by hiding it (a bundled JS key can never
truly be secret):

1. [console.cloud.google.com/google/maps-apis](https://console.cloud.google.com/google/maps-apis)
   -> create/select a project -> create a credential (API key).
2. Enable, on that project: **Maps JavaScript API**, **Geocoding API**,
   **Maps Static API** (all three are used - the interactive map, address
   lookup, and the save-time snapshot respectively).
3. Edit the key -> **Application restrictions** -> **HTTP referrers** ->
   add the deployed desktop app's domain(s) plus `http://localhost:5173/*`
   for local dev.
4. `VITE_GOOGLE_MAPS_API_KEY=` in `apps/desktop/.env` (see
   `.env.example`).

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean.
- **`job_measurements` insert and the `job_notes` summary append were run
  directly against a fresh local Postgres 16 instance** with all 23
  migrations applied (same throwaway-`auth`/`storage` stub setup as
  sections 9-10): a two-facet measurement inserted with the exact `facets`
  jsonb shape the save mutation builds (id/name/pitch_degrees/flat+true
  area/coordinates per facet), confirmed to round-trip correctly
  (`jsonb_array_length` = 2, first facet's name and coordinates read back
  exactly as written); a `job_files` row simulating the snapshot upload
  confirmed the `snapshot_path` linkage; the `job_notes` insert used the
  exact plain-text summary format the save mutation builds.
- Loading `/jobs/<uuid>/measure` directly while signed out
  (Playwright/Chromium) correctly redirects to `/login` with no console
  errors, confirming the new route is properly wrapped by `RequireAdmin`.

### NOT verified from this sandbox

- **No real Google Maps API key was available here** - the interactive
  map, geocoding, click-to-add-vertex drawing, and the Static Maps
  snapshot fetch have only been read through carefully against Google's
  documented API shapes and this repo's own mobile equivalent, not
  exercised in a real browser against a real key. This is the single
  biggest gap in this pass's verification - a manual click-through with a
  real key (draw a facet, confirm the area numbers look sane, confirm the
  snapshot photo appears in the job's Photos section afterward) is needed
  before relying on this in the field.
- No live Supabase Storage/project was available either (same caveat as
  sections 9-10) - the snapshot upload path was verified at the SQL level
  only (a `job_files` row with the right shape), not through an actual
  Storage upload.

## 12. Fixes from live desktop testing, and Price Book

Three issues reported from a real desktop session, plus the Price Book
screen.

### Fix: CORS was silently blocking desktop's immediate email dispatch

**Reported behavior**: "Send Quote via Email" always showed "The quote is
marked sent and the email is queued" - never "has been sent" - and the
email never actually arrived even after waiting well past the 5-minute
cron sweep window.

**Root cause**: `supabase/functions/process-scheduled-comms/index.ts` had
no CORS headers at all. `dispatchNow` (the immediate-send path, used by
both mobile's and desktop's "Send via Email" buttons) is called directly
from the client with `fetch()` - fine from React Native, which has no
same-origin policy to enforce, but a real problem from a browser: any
cross-origin `fetch()` from the desktop app's origin
(`http://localhost:5173` or its deployed domain) to `*.supabase.co`
triggers a CORS preflight `OPTIONS` request first, and with zero CORS
headers on the response, the browser blocks the actual request before the
app's own code ever sees a result. `apps/desktop/src/lib/dispatch-now.ts`'s
`triggerImmediateDispatch` catches this (it looks like a generic network
failure) and returns `false`, exactly matching the "queued" message - the
row genuinely is queued correctly, it's only the "send it right now"
optimization that was silently failing every time, every single time,
purely because of the browser's own CORS enforcement, not anything about
this feature or the user's setup.

This is why it only ever failed on desktop and not mobile, and why the
cron sweep should still have eventually picked it up - if it also never
arrived after several sweep intervals, that's worth checking separately:
confirm `process-scheduled-comms` has its 5-minute `pg_cron` schedule
actually set up (see section on Edge Functions in step 6 above; easy to
verify by querying `cron.job_run_details` directly, the same diagnostic
approach used earlier in this project's SMS/email debugging).

**Fix**: added an `OPTIONS` preflight handler and `Access-Control-Allow-Origin: *`
(plus the two other standard CORS headers) to every response the function
returns. This needs to be **redeployed** to take effect:

```bash
npx supabase functions deploy process-scheduled-comms
```

### Fix: no confirmation after "Save changes" on Quote/Invoice detail

**Reported behavior**: "I cannot edit quotes on desktop" / expiry date
changes didn't appear to take.

**Root cause**: not a persistence bug - the expiry date, notes, and line
items are all genuinely saved together by the one "Save changes" button
(same batching as mobile), and the update itself worked. The real problem
was **silence**: the save mutation only ever showed something on
*failure* (`saveError`), never on success - clicking Save and seeing
nothing happen at all looks exactly like a broken save, whether or not it
actually persisted.

**Fix**: `QuoteDetail.tsx` and `InvoiceDetail.tsx` both now show a plain
"Saved." confirmation for 3 seconds after a successful save, mirroring the
existing pattern already used for "Link copied!" and the send-email
result message on the same screens.

### Fix: "Approval page URL not configured"

Not a bug - `VITE_APPROVAL_PAGE_URL` genuinely wasn't set yet in this
person's `apps/desktop/.env`. Same approval page mobile already uses (the
one deployed to Netlify earlier in this project) - same value as
`apps/mobile/.env`'s `EXPO_PUBLIC_APPROVAL_PAGE_URL`, just under the
`VITE_` name. See `.env.example`.

### Price Book

- **`src/pages/PriceBook.tsx`** - category grid (tile per category,
  matching mobile's tile-grid layout) + "New category" modal.
- **`src/pages/PriceBookCategory.tsx`** - items grid for one category
  (description + computed price per tile, via the same
  `computeLineItemUnitPriceCents` mobile uses), rename-category modal,
  "New item" modal (labour/material/markup fields + a live computed-price
  preview, same as mobile's separate `items/new.tsx` route folded into a
  modal here for consistency with how Clients/Jobs create-flows work on
  desktop).
- **`src/pages/PriceBookItem.tsx`** - full item editor (same fields,
  "Save changes" with a confirmation, same as the Quote/Invoice fix
  above), a variations list (click to edit in a modal, same
  labour/material/markup fields, delete), and "Delete item".
- No PowerSync involved anywhere, same as every other desktop screen -
  plain Supabase queries, consistent with mobile's own price book screens
  (already online-only there too, since price book data was scoped as
  admin-managed catalogue data no technician needs offline - see mobile's
  own `price-book/index.tsx` comment).

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean.
- **Every Price Book query and mutation was run directly against a fresh
  local Postgres 16 instance** with all 23 migrations applied (same
  throwaway-`auth`/`storage` setup as sections 9-11): category
  create/rename, item create/update/delete, variation create/delete - all
  confirmed to persist and read back with the exact column shapes
  `packages/shared/src/types.ts` declares, including confirming a deleted
  item no longer appears in its category's item list.
- Loading `/price-book`, `/price-book/categories/<uuid>`, and
  `/price-book/items/<uuid>` directly while signed out
  (Playwright/Chromium) all correctly redirect to `/login` with no console
  errors.
- The CORS fix was verified by reading the Edge Function's own request
  handling logic against how browsers actually enforce CORS preflights -
  not by an actual browser round-trip against a deployed function (no
  live Supabase project in this sandbox - same caveat as every Edge
  Function change in this project until it's deployed and exercised for
  real).

### NOT verified from this sandbox

- The CORS fix has not been deployed or exercised against a real browser
  yet - needs `supabase functions deploy process-scheduled-comms` and a
  real "Send via Email" click to confirm it actually resolves the
  "queued, never sent" symptom.
- No live Supabase project for Price Book either - same caveat as every
  other desktop screen in this project.
