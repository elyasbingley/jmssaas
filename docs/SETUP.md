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

## 13. Desktop: Calendar and Company Settings

Rounds out every Phase 1 desktop section except Dispatch/Scheduling (still
a stub, pending the drag-and-drop decision flagged early on) and Team
(still a stub).

### Calendar

- **`src/lib/datetime.ts`** - verbatim port of `apps/mobile/lib/datetime.ts`'s
  pure date-math helpers (no React Native dependency in the original, so
  nothing needed to change), plus one addition:
  `toDateTimeLocalInput` for populating a plain
  `<input type="datetime-local">`, the web equivalent of mobile's
  `DateField` component.
- **`src/pages/Calendar.tsx`** - the same four view modes as mobile (Day/
  Week/Month/Year), same Monday-start week grid, same "tap a day to drill
  into Day view, tap a month tile in Year view to jump to Month view"
  navigation. Rebuilt in a CSS grid instead of RN's flex-wrap tiles - a
  month grid is what CSS grid is for, and it renders identically without
  the percentage-width-per-cell arithmetic the RN version needs.
- **`src/pages/CalendarEventNew.tsx`** / **`CalendarEventDetail.tsx`** -
  same fields as mobile (title, all-day toggle, start/end, guests,
  location, description/link, linked job + technician dispatch, linked
  task), same job-dispatch side effect (assigning a technician bumps a
  `new` job to `scheduled`, later statuses left alone). Two intentional
  differences from mobile:
  - **No `canEdit` permission split** - mobile computes whether the
    current user may edit a given event (admin, or the technician it's
    assigned to). Desktop is admin-only end to end (see section 4's own
    access-control decision), so every event reachable here is always
    fully editable - the permission check would always evaluate true and
    was dropped rather than carried over as dead code.
  - **"Open in Maps" becomes a Google Maps web search link** - mobile's
    `openInMaps` opens the device's native maps app; there's no
    equivalent concept on desktop, so this is a plain
    `google.com/maps/search/?query=<location>` link in a new tab instead.
- Technician linking pulls from `profiles` where `role = 'technician'`,
  and task linking queries the `tasks` table directly - there's no desktop
  Tasks screen yet (out of the Phase 1 desktop scope list), but the table
  and RLS already exist from mobile, so listing/linking existing tasks
  here needed nothing new.

### Company Settings

- **`src/pages/Settings.tsx`** - direct port of
  `apps/mobile/app/company-settings.tsx`: logo upload/remove (same
  `company-logos` public bucket, same fresh-filename-per-upload pattern so
  a CDN never serves a stale image under a reused name), company
  name/ABN/email/phone/website, business address, license number, bank
  details, all under one "Save changes" (with the same "Saved."
  confirmation added to Quotes/Invoices in section 12 above - this screen
  never had that gap to begin with since it's newly built here).
- No `isAdmin` gate on the page itself - same reasoning as Calendar above,
  desktop is already admin-only via `RequireAdmin`.

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean.
- **Every Calendar and Settings query/mutation was run directly against a
  fresh local Postgres 16 instance** with all 23 migrations applied (same
  setup as sections 9-12): a job-linked calendar event created with a
  dispatched technician (confirmed the job's `assigned_technician_id` was
  set and its status correctly bumped `new` -> `scheduled`), the joined
  event+job select `CalendarEventDetail` uses, an event update + technician
  reassignment, and a delete; a full company-settings update (all fields)
  plus the logo-upload path (a `storage.objects` row + `tenants.logo_url`
  pointing at its public URL, then cleared again) - all round-tripped with
  the exact shapes `packages/shared/src/types.ts` declares.
- Loading `/calendar`, `/calendar/new`, `/calendar/<uuid>`, and `/settings`
  directly while signed out (Playwright/Chromium) all correctly redirect
  to `/login` with no console errors.

### NOT verified from this sandbox

- No live Supabase project - same caveat as every other desktop screen:
  the queries are confirmed correct against the real schema, but the UI
  itself (the month grid rendering, the logo file picker, a real
  end-to-end technician dispatch from the Calendar screen) hasn't been
  clicked through against a live project.
- **Google Calendar sync is not built anywhere yet** - mobile's own
  `google_event_id`/`last_synced_at` columns exist and are surfaced as a
  read-only "Synced with Google Calendar" notice on both apps' event
  detail screens, but nothing actually populates them (no OAuth flow, no
  sync job) - this was already an open item before this pass, not
  something newly deferred here.

## 14. Desktop: Dispatch board (drag-and-drop timeline)

The one screen mobile deliberately scoped down from day one - see
`apps/mobile/app/schedule.tsx`'s own comment: a tap-to-assign list, "no
desktop app exists yet to make [a drag-and-drop timeline] viable." This
is that timeline, now that one does.

### Drag-and-drop library: `@dnd-kit/core`

The other real decision flagged back when the desktop app was scoped
("how much of the dispatch board's full drag-and-drop to build in this
first pass"), now resolved:

- **`react-big-calendar`/FullCalendar's resource-timeline view** - the
  closest off-the-shelf match to a per-technician-lane Gantt board, but
  FullCalendar's resource-timeline is a paid Premium plugin, and
  react-big-calendar has no equivalent resource-lane view at all (it's a
  month/week/day event grid, not a per-resource timeline).
- **`google.maps.drawing.DrawingManager`-style toolbar libraries** don't
  apply here at all - wrong problem shape (that's for freeform polygon
  drawing, not positioning existing blocks on a time axis).
- **`@dnd-kit/core`** - chosen. It's unopinionated about layout: the
  timeline grid, hour gridlines, and block positioning here are all plain
  CSS/Tailwind; dnd-kit only supplies pointer tracking (`useDraggable`),
  drop-target detection (`useDroppable`), and the `onDragEnd` event this
  screen turns into a time/technician calculation. That's the right
  amount of library for a genuinely custom board like this, versus
  fighting a calendar library's own opinions about layout to make it look
  like a dispatch board instead of a calendar.

### Scope of this first pass

- **Single day view** (prev/today/next nav, same as mobile's Schedule
  screen), not a week/multi-day timeline.
- **07:00-19:00 fixed window**, 15-minute snap on drop.
- **One row per technician**; an "Unassigned jobs" shelf above the grid
  holds every job with no future `calendar_events` row (same derivation
  mobile's `schedule.tsx` already uses) as draggable pills.
- **Three drag interactions, each landing on the exact same
  `calendar_events`/`job_cards` writes the rest of the app already makes**
  - no parallel scheduling model, per the original instruction:
  - Drag an unassigned job onto a technician's row -> creates a
    `calendar_events` row (default 1-hour duration from the drop
    position) and sets `job_cards.assigned_technician_id`, bumping a
    `new` job to `scheduled` (identical semantics to mobile's own "+ New
    event" flow from the Schedule screen).
  - Drag an existing block within/across rows -> updates that event's
    `start_at`/`end_at` (duration preserved, only the start time moves)
    and, if dropped on a different technician's row,
    `job_cards.assigned_technician_id` too.
  - Drag a block back onto the "Unassigned jobs" shelf -> deletes the
    `calendar_events` row, undoing the dispatch.
  - A plain click (no drag) on a block or an unassigned pill navigates to
    that job's detail page - distinguished from a drag via
    `PointerSensor`'s `activationConstraint: { distance: 8 }`, so a click
    that never moves the pointer 8px never engages the drag sensor at all
    and the browser's own click event fires normally.
- **Not built in this pass** (reasonable follow-ups once this base
  interaction is proven out in the field): a week/multi-day timeline,
  resizing a block's duration by dragging its edge (only whole-block
  reposition), recurring events, and drag-to-create a new blank event
  directly on the grid (today, blank slots have no interaction - only
  existing blocks and unassigned pills are draggable).

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean.
- **Every mutation the three drag interactions issue was run directly
  against a fresh local Postgres 16 instance** with all 23 migrations
  applied (same setup as sections 9-13): scheduling a previously-
  unassigned job (calendar_event insert + job dispatch + `new`->
  `scheduled` bump), rescheduling that event to a new time *and*
  reassigning it to a second technician in the same operation (confirmed
  both the event's new `start_at`/`end_at` and the job's new
  `assigned_technician_id` persist together), and unassigning it again
  (delete). All exactly the SQL the mutations in `Dispatch.tsx` issue,
  not a paraphrase of it.
- Loading `/dispatch` directly while signed out (Playwright/Chromium)
  correctly redirects to `/login` with no console errors.

### NOT verified from this sandbox

- **The drag-and-drop interaction itself has never been exercised in a
  real browser** - no live Supabase project here to sign into and see
  real technicians/jobs/events to actually drag. The pixel-math (drop
  position -> time-of-day, `active.rect.current.translated` /
  `over.rect` from dnd-kit's own `DragEndEvent` shape) was written and
  typechecked against dnd-kit's actual type definitions read directly
  from its installed package, not guessed, but a real click-and-drag
  round-trip - does a block really land where the cursor was released,
  does the click-vs-drag distance threshold feel right - needs a manual
  pass against a real project before relying on it day-to-day. This is
  the single largest gap in this pass, flagged plainly rather than
  glossed over: an interactive drag feature is exactly the kind of thing
  that can typecheck perfectly and still feel wrong in the hand.

## 15. Desktop: Team management

Closes out every section of the original Phase 1 desktop scope list.

### Fix: CORS on `create-technician`, found before it could bite

While reading this function to port it, it had the exact same gap
section 12 found and fixed in `process-scheduled-comms`: no CORS headers
at all, and `supabase.functions.invoke()` is still a browser `fetch()`
under the hood - a custom `Authorization` header always triggers a CORS
preflight. Fixed proactively (same `CORS_HEADERS` + `OPTIONS` handler
pattern) before building the screen that calls it, rather than shipping
Team management and discovering it silently failing the way "Send via
Email" did. One meaningful difference from the email case: there's no
"queue it for later" fallback for creating an account - if this had
shipped un-fixed, creating a technician from desktop would have failed
outright with no graceful degradation at all, every single time. **Needs
redeploying** along with the other function:

```bash
npx supabase functions deploy create-technician
```

### Team screen

- **`src/pages/Team.tsx`** - direct port of `apps/mobile/app/team.tsx`:
  lists technicians (name/email), "+ New technician" modal calling the
  same `create-technician` Edge Function with the same
  `createTechnicianSchema` client-side validation and the same
  `FunctionsHttpError` error-code classification
  (`email_taken`/`weak_password`/`forbidden`/`unauthorized`) mapped to
  clear messages - ported near-verbatim since the logic has nothing
  React-Native-specific in it.
- No `isAdmin` gate on the page itself, same reasoning as Calendar/
  Settings in section 13 - desktop is already admin-only via
  `RequireAdmin`.
- **`apps/desktop/src/pages/Stub.tsx` deleted** - with Team built, no
  route in `App.tsx` references it anymore; removed rather than left as
  dead code.

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean.
- **The technician-creation path was verified at the trigger level**
  against a fresh local Postgres 16 instance with all 23 migrations
  applied: rather than re-testing `fetchTechnicians`'s plain select
  (already verified multiple times in prior sections), this confirmed
  the part specific to this screen - that `create-technician`'s
  `adminClient.auth.admin.createUser()` call, simulated here as a direct
  `auth.users` insert with the exact `raw_user_meta_data` shape the
  function builds (`tenant_id`/`role: technician`/`full_name`), correctly
  drives `handle_new_user()` to create a matching `profiles` row that
  then shows up in the technician list query.
- Loading `/team` directly while signed out (Playwright/Chromium)
  correctly redirects to `/login` with no console errors.

### NOT verified from this sandbox

- The CORS fix hasn't been deployed or exercised against a real browser
  yet - needs `supabase functions deploy create-technician` and a real
  "+ New technician" click to confirm it actually works end-to-end (not
  just that the preflight now succeeds in theory).
- No live Supabase project to actually create a real technician account
  and confirm they can sign into the mobile app with it from this
  sandbox.

### What Phase 1 desktop now covers

All nine items from the original scope list have a real screen: Login,
Dispatch (drag-and-drop), Clients, Job cards (incl. photo upload and roof
measurement), Quotes & Invoices, Price book, Job costing - **actually
still open, see below** - Team, and Company Settings. Calendar was added
alongside Dispatch since the two share `calendar_events` as their source
of truth.

**Job costing is the one item from the original desktop feature list
that was never explicitly built as its own screen** - the quoted-vs-
actual/margin report mobile has on its job card's Costing tab. Worth
flagging plainly now that everything else is done: this wasn't skipped
by accident, it just never came up as its own request during this run of
passes, unlike every other item which got its own explicit go-ahead.

## 16. Desktop: Job Costing report

Closes that last gap. Built as a genuinely different shape from mobile's
version, not a straight port - per the original brief's own note that "a
bigger screen suits a denser report layout."

### One screen, not a tab - and cross-job, not per-job

Mobile's Job Costing lives as a tab on a single job's detail screen -
open one job, see its margin. `src/pages/JobCosting.tsx` is a new
top-level nav item (added to the Sales section in `Layout.tsx`) that
shows **every** job with a linked quote or invoice at once, one row per
job, sortable by margin %/margin $/total charged/job number, with a
grand-total footer row. That's a genuinely more useful report for an
admin surveying the whole business than mobile's screen could ever be -
not just the same information reached differently.

### Same math as mobile, not a redesign of it

The per-job numbers - labour cost, material cost, total charged, margin,
margin % - use the exact same `lineItemLabourCostCents`/
`lineItemMaterialCostCents` helpers and the same `chargedCents -
(labourCents + materialCents)` margin formula as
`apps/mobile/app/(tabs)/sales/jobs/[id].tsx`'s Costing tab, copied
verbatim rather than reimplemented from scratch. That includes carrying
over its two documented caveats unchanged, not fixing them:

- **Margin slightly overstates the true figure** - total charged is each
  document's GST-inclusive `total_cents`, while labour/material cost are
  GST-exclusive, so margin here includes the GST slice of revenue.
- **A quote converted to an invoice is counted under both** - both stay
  linked to the job (`job_card_id` on each), so a converted quote's line
  items get summed twice. Mobile's own comment already flags the fix (filter
  out quotes with a matching invoice) as a deliberate non-fix for now; this
  page carries the same choice forward rather than diverging from mobile's
  behavior. A one-line footer note on the page makes both caveats visible
  to whoever's reading the report, rather than only living in a code
  comment.
- Jobs with **no** linked quote or invoice are simply omitted from the
  table (nothing to report), rather than mobile's "No quotes or invoices
  linked to this job yet" empty-state message, which only made sense in
  the context of one job already being open.

### Verified from this sandbox

- `pnpm typecheck` and `pnpm --filter desktop build` both pass clean.
- **The aggregate math was checked by hand against a fresh local
  Postgres 16 instance** (all 23 migrations applied, same setup as prior
  sections): seeded one job with a quote (accepted, $660 total, one line
  item - $80/hr x 5hrs labour + $200 material) that was converted to an
  invoice carrying the identical line item (as a real conversion would
  copy it) - then computed the expected aggregate by hand (labour $800,
  material $400, charged $1,320, margin $120, margin 9.09%) and confirmed
  it via direct SQL matches exactly what the page's own reduce logic
  would produce, including reproducing the documented double-count
  behavior on purpose (not a bug the SQL happened to reveal - the exact
  behavior mobile already has and this page intentionally kept).
- Loading `/job-costing` directly while signed out (Playwright/Chromium)
  correctly redirects to `/login` with no console errors.

## 17. Desktop: Calendar month view no longer needs scrolling

A follow-up fix, not a new screen. The month grid in
`src/pages/Calendar.tsx` used `aspect-square` on each day cell, which
sizes cell *height* off cell *width* - on a normal desktop window width,
a 6-row grid of square cells came out taller than the viewport, so
reaching the later weeks of the month meant scrolling.

Fix: the day-cell grid now uses `grid-rows-6` (Tailwind's `repeat(6,
minmax(0, 1fr))`) inside a `flex-1` parent, so row height comes from
whatever vertical space is actually available, not from column width.
For that `flex-1`/`h-full` chain to resolve to a real height instead of
`auto`, the same `flex h-full flex-col p-8` root-container pattern
already used in `Dispatch.tsx` was applied to the page's root div, and
the calendar box wrapper gets `min-h-0 flex-1 overflow-hidden` - but only
while `viewMode === "month"`. Day/Week/Year views keep their own natural
scrolling (`overflow-y-auto` on the root div) since only the month grid
has a fixed number of rows that all need to be visible at once; those
other views can have an unbounded number of events per day/week and are
meant to scroll.

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build`
  both pass clean.
- Loading `/calendar` directly while signed out (Playwright/Chromium)
  correctly redirects to `/login` with no console errors beyond the
  expected failed network calls to the placeholder Supabase URL.

### NOT verified from this sandbox

- The actual "does the grid fit without scrolling" visual check needs a
  real signed-in session against a real Supabase project (this sandbox
  has no such backend), so it wasn't screenshotted here - please confirm
  it looks right on your end after pulling this change.

### NOT verified from this sandbox

- No live Supabase project - same caveat as every screen in this
  project: the query shapes and aggregate math are confirmed correct
  against the real schema, but the actual table rendering, sort buttons,
  and search filter haven't been clicked through in a real browser
  against real data.

This closes every item from the original Phase 1 desktop scope list.

## 18. Removed job_cards.status - lifecycle_stage_id is now the only status a job has

Every job card used to carry two parallel status fields: the fixed
`status` enum (new/scheduled/in_progress/completed/invoiced) from the
Phase 1 schema, and `lifecycle_stage_id`, an admin-customizable pipeline
added later specifically *alongside* status (see the
job_categories_lifecycle_stages migration's own comment: "status is NOT
replaced or removed here - too much of the app already keys off it").
Both desktop and mobile job screens ended up showing a Status dropdown
and a Stage dropdown right next to each other, doing the same job - which
is the "these are the exact same thing" observation this migration acts
on.

### Why this wasn't a trivial rename

`status = 'completed'` was load-bearing, not just a UI label - two
Postgres triggers keyed off it directly:

- `schedule_job_completion_summary` (job completion summary email)
- `schedule_maintenance_reminder` (the retention campaign's recurring
  maintenance email, gated additionally on `service_category_id`)

Both only fired on `new.status = 'completed' and new.status is distinct
from old.status` - i.e. the exact moment a job first became completed.
Dropping the column meant these needed a replacement signal for "the job
just became done," and a hardcoded stage *name* would have been exactly
as fragile as the enum it replaced (a tenant can rename/reorder/delete any
stage freely).

### The fix: `is_closed` on `job_lifecycle_stages`

`supabase/migrations/20260819000100_job_status_lifecycle_consolidation.sql`:

- Adds `job_lifecycle_stages.is_closed boolean not null default false`,
  seeded `true` for the two default stages that used to mean "done"
  (Completed, Invoiced) and `false` for everything else - including any
  custom stage a tenant adds; an admin can flip it on a custom "Job
  Finished" stage the same way.
- Rewrites both triggers to fire on "the job's stage just became a closed
  one, having not been closed before" (`v_new_closed and not
  v_old_closed`, comparing the old and new `lifecycle_stage_id`'s
  `is_closed` flag) instead of the literal string 'completed'. This is a
  real behavior improvement, not just a rename: the old check would
  silently never fire for a job whose custom pipeline skips straight from
  an in-progress-equivalent stage to an Invoiced-equivalent one - the new
  check fires correctly the first time the job lands in *either* closed
  default stage, or any custom is_closed stage.
- Adds a `BEFORE INSERT` trigger (`default_job_lifecycle_stage_trigger`)
  that defaults a new job's `lifecycle_stage_id` to its tenant's
  lowest-position stage when one isn't given - `lifecycle_stage_id` was
  previously just an optional tag; now that it's the only status a job
  has, it can't be left null the way `status` (which had `NOT NULL
  DEFAULT 'new'`) never was.
- Backfills any job still missing a stage (a no-op in practice - the
  original migration's own backfill already matched every job's status to
  a same-named stage), then drops `job_cards.status` and the `job_status`
  enum type entirely (verified: `job_status` wasn't used by any other
  table).

### Removed, not replaced: auto-bump to "Scheduled" on dispatch

Both `apps/desktop/src/pages/Dispatch.tsx`'s `scheduleJob` mutation and
`apps/mobile/app/schedule.tsx`'s `+ New event` flow (and desktop's
`CalendarEventNew.tsx`/mobile's `calendar/new.tsx` equivalents) used to
bump a `new` job to `scheduled` the moment a technician was dispatched.
There's no generic equivalent once a tenant's stage pipeline is fully
custom - guessing "the next stage after New" would be wrong for a
tenant who reordered or renamed their pipeline. This convenience is
removed outright rather than approximated; an admin now moves the stage
themselves from the job detail screen if they want to reflect that a
visit's been booked.

### Everywhere else status/stage showed up, updated to stage-only

- **Mobile** `sales/jobs/[id].tsx`: the Status chip row is gone; the
  existing "Lifecycle stage" picker is now the only control, and its
  `handleStageChange` gained the same "send an automated review request?"
  prompt the old Status picker's "completed" tap used to trigger - now
  firing on `next.is_closed && !wasClosed` (entering any closed stage,
  matching the DB triggers' own logic) instead of one specific status
  value.
- **Mobile** `sales/jobs/index.tsx`, `sales/clients/[id].tsx`: status
  badges/columns removed (clients/[id].tsx now shows the job's stage name
  instead, matching what jobs/index.tsx already showed).
- **Mobile** `schedule.tsx`: the "unassigned jobs" filter (`status !==
  'completed' && status !== 'invoiced'`) is now `!closedStageIds.has(...)`,
  fetching `job_lifecycle_stages` fresh for this; the status badge on each
  unassigned job row is now its stage name.
- **Mobile** `job-setup.tsx`: the stage editor gained an "Is closed" toggle
  (a `Switch`, same pattern as Automation Settings' rule toggles) so an
  admin can mark a custom stage as meaning "done."
- **Desktop** `JobDetail.tsx`: the Status dropdown is gone; Category/Stage/
  Technician now share the grid that used to also hold Status.
- **Desktop** `Jobs.tsx`, `ClientDetail.tsx`: same status column/badge
  removal as their mobile counterparts; ClientDetail's job table now shows
  Stage instead of Status (it never showed category/stage tags before,
  unlike Jobs.tsx, so this is a net addition there, not just a swap).
- **Desktop** `Dispatch.tsx`: same `is_closed`-based unassigned-jobs filter
  as mobile's schedule.tsx, fetching `job_lifecycle_stages` alongside jobs/
  technicians/events.
- **packages/shared**: `JobStatus` type removed entirely; `JobCard.status`
  removed; `JobLifecycleStage.is_closed: boolean` added;
  `createJobLifecycleStageSchema` gained `is_closed`; the PowerSync
  `job_cards` table schema dropped its `status` column and
  `job_lifecycle_stages` gained `is_closed` (as `column.integer`, same
  0/1 convention as `is_system_default` - SQLite has no boolean type).

### A new job created offline has no stage until its next sync

Mobile's job-creation `INSERT`s (jobs/index.tsx, clients/[id].tsx) no
longer set `status` at all, and don't set `lifecycle_stage_id` unless the
admin picked one - the new `BEFORE INSERT` trigger that defaults it lives
in Postgres, so a job created offline sits with `lifecycle_stage_id =
NULL` locally until it next syncs and round-trips the server's default
back down. This is the exact same caveat `job_cards.number` (also
server-assigned on insert) already has, documented in the very first
desktop/mobile parity pass - nothing new here, just another field with
the same shape of gap.

### Verified from this sandbox

- `pnpm typecheck` passes clean across `packages/shared`, `apps/mobile`,
  and `apps/desktop`; `pnpm --filter desktop build` also passes.
- **The full migration was run against a fresh local Postgres 16
  instance** with all 24 migrations applied in order (including this
  one) with zero errors - the standard stub setup for this sandbox
  (hand-written `auth.users`/`auth.uid()`/`storage.buckets`/
  `storage.objects`/`storage.foldername()`, since plain Postgres has no
  GoTrue/Storage).
  - Confirmed `job_cards.status` and the `job_status` enum type are both
    gone, and `job_lifecycle_stages.is_closed` seeds `true` for exactly
    the default Completed/Invoiced stages and `false` for the other three.
  - Confirmed the `BEFORE INSERT` default-stage trigger assigns a new
    job with no stage to the tenant's lowest-position stage, and leaves
    an explicitly-set stage alone.
  - Confirmed `schedule_job_completion_summary` fires exactly once when a
    job moves New -> Completed; does **not** refire on a same-stage edit
    or a Completed -> Invoiced move (both already closed); and **does**
    fire on a direct In Progress -> Invoiced move that skips Completed
    entirely - the documented improvement over the old literal-'completed'
    check, verified by hand rather than assumed.
  - Confirmed `schedule_maintenance_reminder` fires the same way and only
    when `service_category_id` is set with a `maintenance_interval_months`
    on that category, with `scheduled_for` landing the right number of
    months out.
- Loading `/jobs`, `/clients/:id`, `/dispatch`, and `/calendar/new`
  directly while signed out (Playwright/Chromium) all correctly redirect
  to `/login` with no unexpected console errors (a single failed-fetch
  404 against the placeholder Supabase URL is expected and appears on
  every route in this sandbox).

### NOT verified from this sandbox

- The actual UI - job detail's Category/Stage/Technician grid, the
  mobile stage picker's review-request prompt, the job-setup stage
  editor's new toggle, Dispatch's unassigned-jobs list - needs a real
  signed-in session against a real Supabase project to click through;
  this sandbox has no such backend, so only the route-guard redirect and
  the underlying SQL were checked here, not the rendered screens
  themselves.
- Existing production data: this was verified against freshly-seeded rows
  in a throwaway database, not against whatever real job_cards/
  job_lifecycle_stages rows already exist in your actual Supabase project.
  Before running this migration there, it's worth spot-checking that every
  existing job already has a `lifecycle_stage_id` set (the original
  job_categories_lifecycle_stages migration's backfill should have handled
  this already) - if any don't, this migration's own backfill pass covers
  them too, but confirming first costs nothing.

## 19. Desktop: Automation & Messaging and Job Setup screens

Closes a real gap: every other admin-only setup screen mobile has
(Company Settings, Team, Price Book, Job Setup, Automation & Messaging)
had already been ported to desktop except these last two - an admin
signed into desktop had no way to touch communication timing/wording or
manage service categories/lifecycle stages at all.

### `src/pages/AutomationSettings.tsx` - direct port of `automation-settings.tsx`

Same scope as mobile: editing the six trigger_keys the communication
engine migrations seed and know how to fire (not a custom "add your own
automation" builder), grouped into the same four sections (Quote
Follow-ups, Invoice Reminders, Field Alerts, Retention), with the same
`summarizeTiming()` plain-English timing summary and the same
maintenance_reminder/dormant_client_reengagement special cases copied
verbatim.

Two things had to change for a browser, not just relabeled:

- **PowerSync's `execute()` becomes a plain Supabase `.update()`.**
  `communication_rules`/`communication_templates` are PowerSync-synced on
  mobile so edits work offline; desktop has no offline mode at all, so
  every read/write here is a direct `supabase.from(...)` call through
  `@tanstack/react-query`, same pattern as every other desktop screen.
- **`Switch`/`DateField` (React Native) become an `<input type="checkbox">`
  and `<input type="time">`.** Quiet hours round-trip through
  `timeToInputValue`/`inputValueToTime` to convert between Postgres's
  `HH:MM:SS` and the HTML time input's `HH:MM`, mirroring mobile's own
  `timeStringToDate`/`dateToTimeString` helpers for the same column.
- **Token insertion at the cursor** uses a plain `<textarea>` ref's
  `selectionStart`/`selectionEnd` instead of RN `TextInput`'s
  `selection`/`onSelectionChange` props - same end result (click a
  `{token}` chip, it lands wherever the cursor was), different API for the
  same job. This is also why the textarea is a raw `<textarea>` rather
  than the shared `TextAreaField` component - forwarding a ref through
  `TextAreaField` would need it rebuilt to accept one, which nothing else
  in this app needs yet.

### `src/pages/JobSetup.tsx` - direct port of `job-setup.tsx`

Same two admin-managed lists (service categories, job lifecycle stages),
same tap-based reordering for stages (Up/Down buttons swapping two rows'
`position` values, no drag-and-drop), same delete-confirmation copy. The
lifecycle stage editor now also has an **"Is closed" checkbox** - not in
mobile's screen when it was first built, added on both apps together as
part of the job_cards.status consolidation (section 18 above), since
`is_closed` didn't exist as a column until that migration.

Desktop doesn't have React Native's `Alert.alert` - delete confirmations
use the browser's own `window.confirm()`, the same one-line native
confirmation dialog, just the web platform's version of it (this is also
the first delete-confirmation UI on desktop at all; nothing before this
needed one).

### Navigation

Both screens are reached from a new "Settings" heading in the left nav
(`Layout.tsx`), replacing the single standalone "Settings" entry:
Company Details (`/settings`, the existing Company Settings screen),
Automation & Messaging (`/settings/automation`), and Job Setup
(`/settings/job-setup`) - grouping the three admin setup screens that
were already conceptually "Settings" together, the way mobile's Home
screen already does with its own setup-screen links.

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build` both
  pass clean.
- **Every Supabase query/update these two screens issue was run by hand
  against a fresh local Postgres 16 instance** (all 24 migrations applied,
  same stub setup as every other section): confirmed the seeded
  `communication_rules`/`communication_templates` rows for all six
  trigger_key groups read back correctly, confirmed editing a rule's
  timing fields and a template's subject/body/active flag round-trip
  correctly, confirmed `tenants.google_review_link` reads/writes, and
  confirmed `service_categories`/`job_lifecycle_stages` (including the new
  `is_closed` column) CRUD and the position-swap reorder all behave
  exactly as the screens expect.
- Loading `/settings/automation` and `/settings/job-setup` directly while
  signed out (Playwright/Chromium) both correctly redirect to `/login`
  with no unexpected console errors.

### NOT verified from this sandbox

- The actual rendered screens - trigger group cards, the rule/template
  edit modals, the token-insertion textarea, the category/stage editors -
  need a real signed-in session against a real Supabase project to click
  through; this sandbox has no such backend.

## 20. Desktop: Inventory screens

Closes the last screen mobile had that desktop didn't: multi-location
stock tracking over inventory's own standalone catalogue
(`inventory_items`, organised by `inventory_categories`/
`inventory_subcategories` - unrelated to the price book, see the
inventory_material_categories migration for why those turned out not to
be the same thing).

### `src/pages/Inventory.tsx` - direct port of `(tabs)/sales/inventory/index.tsx`

Same Location > Category > Subcategory drill-down as chip filters on one
screen, same Stock / Out of Stock tabs, same quantity +/- controls, same
low-stock math (`quantity <= reorder_threshold`) and shopping-list
generation. As with every other desktop screen, PowerSync's `execute()`
becomes plain Supabase calls through `@tanstack/react-query` - there's no
offline mode here, so quantity adjustments write straight through instead
of queuing locally.

One real gap this exposed: **desktop had no PDF export capability at
all** - not even for quotes/invoices. Mobile's shopping list generator
uses `expo-print`'s `printToFileAsync` + the native share sheet, neither
of which exist in a browser. Rather than reach for a PDF library, this
uses the platform's own equivalent:

- `src/lib/shopping-list-pdf.ts` - the same `buildShoppingListPdfHtml`/
  `renderShoppingListTable` HTML-building logic from
  `apps/mobile/lib/pdf.ts`, ported over (duplicated, not shared - same
  reasoning as `lib/errors.ts`: this app has no other dependency on
  mobile's `lib/` directory, and the rest of that file's quote/invoice
  rendering isn't needed here since desktop doesn't export those yet
  either).
- `src/lib/print.ts` - opens the built HTML in a new browser tab and
  calls `window.print()`, which every major browser can "Save as PDF"
  from directly. No PDF library, no backend call - the same
  generate-locally philosophy as mobile's on-device rendering, just the
  web platform's version of "hand off this document."

### `src/pages/InventorySetup.tsx` - direct port of `inventory-setup.tsx`

Same two-level category hierarchy (Material/Tools -> Roofing/Power
Tools) and flat supplier list, same delete-confirmation copy (including
the "this will also delete N items" consequence count) - `window.confirm`
instead of `Alert.alert` again, same as Job Setup's stage deletes.

### Navigation

"Inventory" joins the Sales nav section (a daily tool, same as
Jobs/Quotes/Price Book); "Inventory Setup" joins the "Settings" heading
group alongside Job Setup and Automation & Messaging (an occasional setup
screen, matching where mobile's Home screen puts it).

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build` both
  pass clean.
- **Every table/query this pair of screens touches was run by hand
  against a fresh local Postgres 16 instance** (all 24 migrations
  applied): confirmed category/subcategory/supplier CRUD, confirmed
  creating a location and an item with a reorder threshold/ideal
  stock/supplier, confirmed the insert-then-update path a quantity
  adjustment takes (`handleAdjust`'s "create the level row if it doesn't
  exist yet, else update it"), confirmed the low-stock join
  (`quantity <= reorder_threshold`) returns the right rows with
  location/supplier names attached, and confirmed the category-delete
  consequence counts (subcategories/items) compute correctly.
- Loading `/inventory` and `/settings/inventory-setup` directly while
  signed out (Playwright/Chromium) both correctly redirect to `/login`
  with no unexpected console errors.

### NOT verified from this sandbox

- The actual rendered screens - the drill-down chip filters, the item
  create/edit modal, the low-stock queue, and critically **the shopping
  list PDF export itself** (`window.open` + `window.print()` needs a real
  browser window with pop-ups allowed, which this sandbox's headless
  Playwright check didn't exercise) - all need a real signed-in session
  and a manual click-through to confirm.

## 21. Desktop: Tasks screen

The last screen from the original desktop scope list - `src/pages/
Tasks.tsx` (list + status filter chips + create modal, direct port of
`(tabs)/tasks/index.tsx`) and `src/pages/TaskDetail.tsx` (status chips,
edit modal, linked-job link, photos, notes, delete, direct port of
`(tabs)/tasks/[id].tsx`).

One difference from mobile worth calling out: mobile's list splits
"admin sees everything" vs. "technician sees only tasks assigned to
them," since the same screen serves both roles. Desktop has no
technician role at all (`RequireAdmin` wraps every route - see
`docs/SETUP.md`'s desktop foundation section) - there's no equivalent
split to port, so `fetchTasks` always reads the whole tenant's tasks.

Photos reuse the exact signed-URL pattern `JobDetail.tsx` already
established (the `job-files` bucket is private) rather than mobile's
offline attachment queue - `src/lib/uploads.ts` gained `uploadTaskPhoto`,
a direct-upload sibling to the existing `uploadJobPhoto`, using the same
`<tenant_id>/task-<task_id>/<uuid>.<ext>` storage path convention as
mobile's `addTaskPhoto` (see `apps/mobile/lib/powersync.ts`) so both
apps' task photos land in the same place with the same RLS.

Reached via a new "Tasks" nav item alongside Dispatch (a daily-use tool,
not a Settings-adjacent one).

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build` both
  pass clean.
- **Every query/mutation these two screens issue was run by hand against
  a fresh local Postgres 16 instance** (all 24 migrations applied):
  confirmed task creation (including the auto-assigned `TSK001`-style
  `number`), status transitions, editing title/description/due date, the
  list's sort order (`due_date` ascending with nulls last, then
  `created_at` descending), adding a task note, inserting a task_files row
  with the exact storage_path `uploadTaskPhoto` builds, and deleting a
  task.
- Loading `/tasks` and `/tasks/:id` directly while signed out
  (Playwright/Chromium) both correctly redirect to `/login` with no
  unexpected console errors.

### NOT verified from this sandbox

- The actual rendered screens - status chip clicks, the edit modal, photo
  upload/signed-URL display, notes - need a real signed-in session against
  a real Supabase project to click through; this sandbox has no such
  backend.

This closes every item in the desktop parity scope this session started
with - every screen mobile has now has a desktop equivalent.

## 22. Fix: create-technician's CORS fix (section 15) was incomplete

Section 15's CORS fix added an `Access-Control-Allow-Headers` list, but it
only listed `authorization, content-type` - missing `apikey`. That
mattered because `Team.tsx` calls this function through
`supabase.functions.invoke()`, not a hand-written `fetch()`, and the
supabase-js client always attaches its own `apikey` header (and
`x-client-info`) to every request it makes. The browser's CORS preflight
saw a header the server hadn't explicitly allowed and blocked the whole
request before it ever reached the function - console showed "Cross-
Origin Request Blocked... header 'apikey' is not allowed according to
header 'Access-Control-Allow-Headers'". This is a different failure mode
than the original CORS gap (which had zero CORS headers at all) - the
preflight itself now succeeds/fails based on which headers are listed,
not just whether any are.

`process-scheduled-comms` doesn't have this problem: its only caller
(`dispatch-now.ts` on both apps) uses a plain `fetch()` with just
`Authorization`/`Content-Type`, never `.invoke()`, so its existing header
list was already sufficient. Confirmed by grepping every
`supabase.functions.invoke()` call site across both apps -
`create-technician` (mobile's `team.tsx` and desktop's `Team.tsx`) is the
only one.

Fix: added `apikey` and `x-client-info` to `create-technician`'s
`Access-Control-Allow-Headers`, matching Supabase's own documented CORS
example. **Requires `npx supabase functions deploy create-technician`
again** for this to take effect - a deploy without this fix (as the user
had already done once, confirming the function itself was live and
reachable) would still hit this exact preflight rejection.

### Verified from this sandbox

- Read every `supabase.functions.invoke()` call site in the repo to
  confirm `create-technician` is the only Edge Function ever called that
  way (the only one that needs `apikey` in its allow-list).
- Not independently reproducible in this sandbox (no real Supabase
  project/browser here) - this fix was made directly from the user's own
  browser console output, which named the exact rejected header.

## 23. Fix: Dispatch board had no explicit way to remove a booking

The only way to un-dispatch a job was dragging its block all the way back
up to the "Unassigned jobs" shelf at the top of the screen - reachable,
but not discoverable, and easy to miss given the shelf sits above a
scrollable technician grid. On top of that, doing it didn't fully work:
`unassignEvent` deleted the `calendar_events` row but never cleared
`job_cards.assigned_technician_id`, so the job kept showing an assigned
technician with no actual booking - a real data-consistency bug, not
just a UX gap.

Fix, both in `src/pages/Dispatch.tsx`:

- `unassignEvent`'s mutation now clears `assigned_technician_id` back to
  `null` alongside deleting the calendar event, matching what its own
  comment already claimed it did.
- Added a small `&times;` button directly on each booking block (visible
  on hover via a `group`/`group-hover` pair), calling the same
  `unassignEvent` mutation without needing to drag anywhere.
  `onPointerDown` on the button stops propagation so it doesn't trigger
  the block's own drag-start handler, and the block's outer element
  changed from a `<button>` to a `<div role="button">` since a `<button>`
  can't contain another interactive `<button>` per HTML semantics.
- The shelf's own hint text now mentions both ways to remove a booking.

Drag-to-shelf still works (and is now correct) - the `&times;` button is
an additional, more discoverable path to the same result, not a
replacement.

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build` both
  pass clean.
- Loading `/dispatch` directly while signed out (Playwright/Chromium)
  correctly redirects to `/login` with no unexpected console errors.

### NOT verified from this sandbox

- Actually clicking the new &times; button and confirming both the
  calendar event disappears and the job's technician clears needs a real
  signed-in session against a real Supabase project with an existing
  booking to test against; this sandbox has no such backend.

## 24. Desktop: close remaining mobile-vs-desktop feature gaps

A file-by-file audit of every mobile screen against desktop's equivalent
turned up four features mobile had that desktop didn't. Built here in one
batch (a fifth gap, an "On The Way" quick-SMS button, and a sixth, live
camera capture, were deliberately left out - they don't fit desktop's
always-online admin workflow the same way, or are an inherent
browser-vs-native-device difference).

**PDF export for Quotes/Invoices** - `src/lib/quote-invoice-pdf.ts` is a
direct port of mobile's `lib/pdf.ts` quote/invoice HTML builders
(`buildQuotePdfHtml`/`buildInvoicePdfHtml`), reusing desktop's existing
`lib/print.ts` `exportPdf()` (`window.open` + `win.print()`, the same
browser-native "Save as PDF" path already used for the Inventory shopping
list) instead of mobile's `expo-print`/`expo-sharing`. `QuoteDetail.tsx`
and `InvoiceDetail.tsx` each gained a `tenant` query and an "Export PDF"
button next to "Generate approval link".

**Post-completion review-request prompt** - `JobDetail.tsx`'s Stage
`<select>` now calls `handleStageChange` instead of updating directly;
it compares the old and new stage's `is_closed` flag (not a hardcoded
stage name, matching the DB triggers' own
`schedule_job_completion_summary`/`schedule_maintenance_reminder` logic
from the job-status-lifecycle-consolidation migration) and, on first
entry into any closed stage, `window.confirm`s whether to send an
automated review request. `queueReviewRequest` looks up the tenant's
`job_review_request` communication rule/templates, inserts a
`scheduled_communications` row per matching template, and calls
`triggerImmediateDispatch` (`lib/dispatch-now.ts`, already used for the
Send-via-Email buttons) as a best-effort immediate send, falling back to
the cron sweep - same shape as mobile's `queueScheduledCommunication`.

**Communication Log** - `src/components/CommunicationLog.tsx` is a port
of mobile's component of the same name. `scheduled_communications` has no
`client_id` column (a message is always scoped to the job/quote/invoice
it was scheduled against), so both mobile's SQL `WHERE` and this port's
Supabase `.or()` filter require the caller to supply every relevant
`{entityType, entityId}` pair explicitly. Added to `JobDetail.tsx`
(job + its linked quotes + its linked invoices) and `ClientDetail.tsx`
(the client's jobs only, same as mobile's own client screen - quote/
invoice follow-ups aren't included at the client level there either).

**Per-job Job Costing tab** - `JobDetail.tsx` gained a "Job Costing"
section computed from its linked quotes'/invoices' line items, using the
same `lineItemLabourCostCents`/`lineItemMaterialCostCents` helpers
copied verbatim into every consumer (mobile's `jobs/[id].tsx`, desktop's
existing cross-job `JobCosting.tsx` report, and now this file) rather
than factored into `packages/shared` - matching the established
convention. Same caveats as the cross-job report, called out in-page:
margin compares GST-inclusive charged total against GST-exclusive cost
(slightly overstates true margin), and a quote converted to an invoice
stays linked to the job as both and is summed twice.

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build`
  both pass clean with all four features' combined changes.
- Fresh local Postgres 16 database, all 24 real migrations from
  `supabase/migrations/` applied in order against hand-written stubs for
  `auth.users`/`auth.uid()`/`storage.buckets`/`storage.objects`/
  `storage.foldername()` (including a `raw_user_meta_data` column so
  `handle_new_user()`'s auto-provisioning trigger fires the same way it
  would against real Supabase). Seeded a tenant (which auto-seeds default
  lifecycle stages, communication rules, and communication templates via
  `handle_new_tenant()`), a client, a job, a quote and invoice with line
  items, then ran the exact queries this batch's code issues:
  - The PDF export's quote/client/line-items and invoice/client/line-items
    joins, plus the tenant row, all return the expected shape.
  - The `job_review_request` rule + active-template lookup, and the
    resulting `scheduled_communications` insert, both work as
    `queueReviewRequest` expects.
  - The `CommunicationLog` `.or()` filter, given a job's own entity plus
    its linked quote/invoice entities, correctly returns only messages
    scoped to those three, in `scheduled_for desc` order.
  - The per-job costing queries (`quotes`/`invoices` filtered by
    `job_card_id`, then their line items filtered by the resulting id
    lists) return the expected rows.
  - `job_lifecycle_stages.is_closed` reads correctly off the auto-seeded
    stages for the `handleStageChange` comparison.
  - Database dropped after, no state left behind.
- Playwright/Chromium smoke test with placeholder `.env`: `/quotes/:id`,
  `/invoices/:id`, `/jobs/:id`, and `/clients/:id` all correctly redirect
  to `/login` when signed out, with no unexpected console errors (one
  404 for `favicon.ico` on first load only, unrelated to this batch).
  Dev server killed and `.env` deleted after.

### NOT verified from this sandbox

- Actually exporting a PDF and checking its rendered layout, triggering a
  real review-request send (including the immediate-dispatch path
  hitting a live `process-scheduled-comms` deployment), and seeing the
  Communication Log/Job Costing sections populated from real data all
  need a real signed-in session against a real Supabase project; this
  sandbox has no such backend.

## 25. Real Estate & Strata module - Batch 1 (schema, Directory, Property Profile, Key Management)

New module for high-volume property-management agency work (residential
rent-roll agencies and strata/body corporate managers), added under
`Sales > Real Estate & Strata` in the desktop sidebar. A real-estate job
is still an ordinary `job_cards` row, just tagged with agency/property
metadata - not a parallel job system.

**Schema** (`real_estate_strata` migration): five new tenant-scoped
tables - `agencies` -> `property_managers` -> `properties` ->
`property_assets`, plus `key_logs` - and six new columns on `job_cards`
(`is_real_estate_job`, `agency_id`, `property_manager_id`, `property_id`,
`work_order_number`, `nte_limit_cents`, `nte_exceeded_approved`).
`property_id` wasn't in the original field list but the workflow spec
itself needs it (the Property Profile's Job & Compliance History tab and
the Key Dashboard's "Property Address" column both have to find a job's
property somehow). Money is `nte_limit_cents` (bigint) rather than the
spec's plain decimal, matching every other money column in this schema.
`property_assets.attributes` is a schemaless `jsonb` column - plumbing and
roofing metadata don't overlap at all, and a fixed column set would leave
most rows mostly null (see the migration's own comment).

RLS follows two shapes depending on who edits the data: agencies/
property_managers/properties/property_assets are back-office reference
data (tenant-wide read, admin-only write, same shape as `price_book_*`) -
a technician reads a property's access notes and asset history in the
field but doesn't create agencies or properties from there. `key_logs` is
the opposite - a technician actively updates key status from the field -
so it follows the `job_notes`/`job_files` shape instead: visibility and
write access follow the parent job's `assigned_technician_id` (or admin).

**Desktop UI**: `/real-estate` (Directory + Key Management sub-tabs,
switched with an in-page tab strip - not four separate sidebar links,
since desktop's sidebar has no nested-item concept and a single "Real
Estate & Strata" entry matches the spec's own framing of these as tabs
under one destination) and `/real-estate/properties/:id` (Property
Profile & Asset Register - a drill-down route from Directory, same
relationship Jobs/JobDetail already has, since the spec's own wording is
"when a property is selected" rather than a listing tab). The Recurring
Maintenance Engine (the spec's fourth sub-tab) is deliberately not built
yet - it needs the daily due-date sweep from Batch 3 to have anything
real to show, see task tracking for the follow-up batches.

Known scope decisions:
- Editing a property's own fields (address, tenant contact, access notes)
  after creation isn't built yet - Directory's "Add Managed Property"
  modal creates it, but there's no corresponding edit form on the Property
  Profile page in this batch.
- The Key Dashboard's "past 4:00pm and still not returned" banner is
  computed client-side (comparing the browser's local clock against 4pm
  today) whenever an admin has the tab open - there's no server-side sweep
  or push notification, since that would need its own delivery channel the
  spec doesn't otherwise ask for. It only actually surfaces while someone
  is looking at the screen.
- Property manager email uniqueness is enforced per-tenant (a partial
  unique index on `(tenant_id, email) where email is not null`), not the
  spec's bare `unique` - a schema-wide unique constraint would block two
  different tenants from ever having a PM with the same email, which has
  nothing to do with this app's own data integrity.

**A verification-methodology gap found and fixed while testing this
batch**: every previous batch's SQL verification in this sandbox ran as
the `postgres` role, which has `BYPASSRLS` - meaning RLS policies were
never actually being exercised by any of those "verified" queries, only
their result shape was. This batch is the first to catch it (confirmed via
`select rolname, rolbypassrls from pg_roles`). Fixed for this batch by
creating a throwaway non-superuser `app_test` role
(`nosuperuser nobypassrls login`, granted table/sequence/function
privileges but no RLS bypass) and using `set role app_test;` before
setting `app.current_user_id`, so the policies this migration adds are
genuinely exercised, not just read as SQL text. This doesn't mean prior
batches' RLS policies are wrong (their logic still reads correctly against
the schema), only that "verified RLS enforcement" wasn't a true claim for
them - re-testing all of them wasn't in scope here, but every batch from
this one forward should use the `app_test` role, not `postgres` directly.

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, and `pnpm --filter desktop build` all pass clean.
- Fresh local Postgres 16 database, all 25 real migrations (including this
  batch's) applied in order against the same hand-written
  `auth`/`storage` stubs used in every prior batch.
- Seeded a tenant, an admin, two technicians (one assigned to a real-
  estate job, one not), a client, an agency, a property manager, a
  property, two property assets (one plumbing, one roofing), a real-
  estate-tagged job linked to all of the above, a quote linked to that
  job, and a key log. Then, using the throwaway `app_test` role (RLS
  genuinely enforced, not bypassed):
  - As admin: confirmed read/insert/update across every new table,
    including marking a key returned.
  - As the assigned technician: confirmed tenant-wide read on agencies/
    properties/property_assets, and confirmed they can update the
    key_log tied to their own assigned job (picked_up -> in_van).
  - As the assigned technician: confirmed an INSERT into `agencies` is
    rejected outright by the RLS policy (`new row violates row-level
    security policy`), and an UPDATE to `properties` silently affects 0
    rows (the existing "affects 0 rows for a non-admin" pattern already
    used elsewhere in this schema).
  - As a second, unassigned technician: confirmed both SELECT and UPDATE
    on the same key_log return/affect 0 rows.
  - Database and the `app_test` role both dropped after, no state left
    behind.
- Playwright/Chromium smoke test with placeholder `.env`: `/real-estate`
  and `/real-estate/properties/:id` both correctly redirect to `/login`
  when signed out, with no unexpected console errors (the same benign
  one-time `favicon.ico` 404 seen in every prior batch). Dev server killed
  and `.env` deleted after.

### NOT verified from this sandbox

- Actually clicking through the Directory's accordion/modals, the Asset
  Register's category-conditional attribute form, and the Key
  Dashboard's Mark Returned action against a real signed-in session needs
  a real Supabase project; this sandbox has no such backend.
- The 4:00pm banner's exact visual appearance (it was verified by reading
  the code's time comparison logic, not by advancing a real clock past
  4pm in a live browser session).

## 26. Real Estate & Strata module - Batch 2 (NTE guardrail, key tracking, agency-compliant invoicing)

**NTE (Not-To-Exceed) guardrail and PM approval** (`real_estate_nte_and_invoicing`
migration): three new `job_cards` columns (`nte_variation_token`,
`nte_variation_token_expires_at`, `nte_variation_resolved_at`) and three new
RPCs, reusing the exact token pattern already built for quote/invoice
digital acceptance rather than a new mechanism - `generate_job_nte_variation_link`
(SECURITY INVOKER, subject to the existing "job_cards: update own or admin"
RLS policy, so an admin or the job's own assigned technician can call it),
`get_nte_variation_for_approval`/`approve_nte_variation_by_token`
(SECURITY DEFINER, granted to `anon` since the PM clicking an emailed link
has no session). Unlike quote/invoice approval there's only one resolution
(approve) - a PM declining doesn't change what the job needs to do
differently, so there's no decline path.

Both apps now show a job's real-estate metadata (agency/PM/property badge,
work order #, NTE limit, over-budget status) - desktop's `JobDetail.tsx`
and `Jobs.tsx`'s creation modal (with cascading Agency -> PM -> Property
pickers, the closest honest equivalent of "auto-suggests the matching
Property/PM/Agency" without an OCR engine to parse an uploaded work order),
and mobile's `jobs/[id].tsx`. Mobile's `handleStageChange` blocks entering
a closed (job-done) stage when `totalChargedCents` (already computed for
the existing Job Costing tab) exceeds `nte_limit_cents` and
`nte_exceeded_approved` is still false - a modal explains the overage and
offers "Request NTE Variation", which calls `generate_job_nte_variation_link`,
emails the property manager (not the client - a dedicated send path, not a
reuse of the existing `queueScheduledCommunication` helper, since the
recipient audience is different) via the new `job_nte_variation_request`
trigger_key with the real approval link already rendered into the message
body, same "render before insert" approach already used for
`{tech_first_name}`/`{eta_minutes}`.

The approval page itself (`supabase/static/approval-page.html`) gained a
third `type=nte_variation` branch alongside the existing quote/invoice
one - simpler rendering (no line items table), a single "Approve this
variation" button, no name/reason fields. The `approve` Edge Function
routes `nte_variation` to its own `get_${type}_for_approval`/
`approve_nte_variation_by_token` calls rather than the generic accept/
decline branch quote/invoice use, since NTE only has the one action.

**Key Tracking Lifecycle, mobile side** (Workflow 3 - the Batch 1 Key
Management Dashboard only covered the desktop/admin view): mobile's job
screen shows the property's key tag number and, depending on the most
recent `key_logs` row for this job, a "Keys Picked Up" / "Mark In Van" /
"Mark Returned" action. Entering a closed stage with an outstanding
(not yet returned) key log prompts "Did you return Key Tag #X to
[Agency]?" alongside the existing review-request prompt. `key_logs` isn't
a PowerSync table (same "office reference data, fetched online" treatment
as `agencies`/`properties`/`property_managers`), so all of this needs
connectivity - a disclosed limitation, not an oversight.

**Agency-compliant invoicing** (Workflow 4): desktop's `InvoiceDetail.tsx`
computes `agencyComplianceError` when the linked job `is_real_estate_job`,
its agency `require_work_order_num`, and no `work_order_number` is set -
checked before Export PDF, Send via Email, or Generate Approval Link can
run (at the point the invoice actually goes out, not at creation time,
since the work order number may still be legitimately pending entry
until then). `quote-invoice-pdf.ts`'s `renderBillTo` gained an optional
`agencyBilling` override that swaps the Bill To name line for
"`{owner_landlord_name}` c/- `{agency.name}`" when set, wired through
`buildInvoicePdfHtml`'s new optional `agencyBilling` param. Photo/
certificate email attachments (also mentioned in Workflow 4) are out of
scope for this batch - not called out in the acceptance criteria, and
would need real Storage-fetching + base64 + Resend attachment wiring in
`process-scheduled-comms`; flagged here rather than silently dropped.

**A pre-existing bug found while writing this migration, not fixed here**:
`communication_templates` has no unique constraint covering
`(tenant_id, trigger_key[, type])`, and `seed_default_communication_templates`'s
INSERT has no `ON CONFLICT` guard, unlike `communication_rules`' own
`on conflict (tenant_id, trigger_key) do nothing`. Every migration that
redefines this function and re-calls it in its own backfill DO block (six
so far, this one now the seventh) re-inserts the *full* template list for
every tenant that already existed at that point - for a tenant that's
existed since early in this schema's history (e.g. any real production
tenant that predates several of these migrations), duplicate template
rows accumulate with each one. This migration follows the same
established pattern rather than unilaterally changing shared seeding
behaviour as a side effect of an unrelated feature. A real fix would add
a unique index (e.g. `(tenant_id, trigger_key, type)`) and an
`ON CONFLICT DO NOTHING` to the templates insert, then de-duplicate any
already-accumulated rows for existing tenants - worth doing as its own
follow-up, not bundled into this batch.

**Fixed** in section 29 below, after a real tenant hit exactly this (2-5
duplicate sends of the same email) and it was reported directly.

**Also found and fixed while writing this migration**: an earlier draft of
this migration's `seed_default_communication_templates` redefinition only
listed the one new template (`job_nte_variation_request`) instead of the
full cumulative list every prior migration carries forward - since
`create or replace function` fully replaces the function body, that draft
would have silently stopped seeding all ~17 other templates for any new
tenant created after this migration. Caught before verification by
re-reading the previous migration's full function body and diffing
against it; fixed by carrying the complete list forward, matching
established convention.

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, `pnpm --filter desktop build`, and `pnpm --filter mobile
  typecheck` all pass clean.
- Fresh local Postgres 16 database, all 26 real migrations applied in
  order. Seeded a tenant, admin, two technicians (one assigned to a real-
  estate job, one not), a client, an agency (`require_work_order_num =
  true`), a property manager, a property, a real-estate job with a
  `nte_limit_cents` of $300 and a linked quote totalling $440 (i.e.
  genuinely over budget), all inserted through a throwaway non-superuser
  `app_test` role so RLS is actually enforced (see Batch 1's write-up for
  why `postgres`-as-superuser was the wrong way to "verify" this).
  - Confirmed the tenant's `communication_rules`/`communication_templates`
    seeded all 18 trigger_keys (not just the new one), confirming the
    "carry the full list forward" fix actually worked.
  - As the admin: `generate_job_nte_variation_link` returns a token,
    `get_nte_variation_for_approval` returns the expected job/agency/
    property/limit/current-total shape, `approve_nte_variation_by_token`
    sets `nte_exceeded_approved = true` and `nte_variation_resolved_at`,
    a second approve attempt correctly returns `already_resolved`, and an
    unknown token correctly returns `not_found`.
  - As the assigned technician: confirmed they can also call
    `generate_job_nte_variation_link` for their own job (the RLS policy
    it relies on already allows this).
  - As a different, unassigned technician: confirmed calling
    `generate_job_nte_variation_link` for a job that isn't theirs raises
    "not found or not permitted" (the underlying RLS-scoped UPDATE
    affects 0 rows, which the function's own row-count check turns into
    an explicit error).
  - Confirmed the invoice agency-compliance join (`job_cards.is_real_estate_job`/
    `work_order_number` + `agencies.require_work_order_num`) and the
    Billed To header join (`properties.owner_landlord_name` +
    `agencies.name`) both return the exact shape the desktop code reads.
  - Database and the `app_test` role both dropped after, no state left
    behind.
- Playwright/Chromium smoke test with placeholder `.env`: `/invoices/:id`
  and `/jobs/:id` both still correctly redirect to `/login` when signed
  out, with no unexpected console errors (the usual one-time favicon
  404). Dev server killed and `.env` deleted after.

### NOT verified from this sandbox

- Actually triggering the mobile guardrail modal, sending a real NTE
  variation email, a PM clicking the link on the approval page, and the
  job unblocking after approval all need a real signed-in session and a
  deployed Edge Function/static page against a real Supabase project;
  this sandbox has no such backend.
- The key pickup/in-van/return buttons' and the "did you return the key"
  prompt's actual on-device behaviour (verified by reading the code, not
  by running the Expo app).

## 27. Real Estate & Strata module - Batch 3 (Recurring Maintenance Engine) - final batch

This closes out the Real Estate & Strata module (all four sub-tabs from
the original spec now built, both required approval flows working, and
the module's third and last new Edge Function in place).

**Scope decision, made explicit here**: the Recurring Maintenance Engine
is scoped specifically to the gutter-clean schedule already captured on a
roofing `property_assets` row (`last_gutter_clean_date` +
`gutter_clean_interval_months`) - the spec's other example ("Annual...
Backflow Inspections") has no matching field anywhere in this schema, so
it isn't modelled. Adding a real backflow-inspection schedule would need
its own `property_assets.attributes` fields and is a reasonable follow-up,
not bundled into this batch. The desktop tab's "Asset type" filter still
offers Plumbing/HVAC/General alongside Roofing for forward compatibility,
even though only Roofing assets currently have qualifying due-date data.

**Schema** (`real_estate_maintenance_engine` migration): `scheduled_communications.entity_type`
widened to include `'property_asset'` (same drop/re-add-constraint
pattern the retention migration already used to add `'client'`), and a
new automated trigger_key `property_maintenance_due` (`delay_offset_value`
here IS used - "how many days before the due date to first queue the
reminder", same role `invoice_pre_due`'s offset plays for invoices,
default 30 days).

**Edge Function** (`supabase/functions/process-real-estate-maintenance`):
same shape as `process-retention-campaigns` - a daily `pg_cron`-invoked
sweep (not a Postgres trigger, since "is it nearly due" only becomes true
because the calendar advances), service-role-only, detects due roofing
assets and queues a `pending` `scheduled_communications` row per one -
rendering and sending still happen through the normal
`process-scheduled-comms` 5-minute sweep, same quiet-hours handling as
everything else. Unlike the manually-triggered rows elsewhere in this
module (job_on_the_way, job_review_request, job_nte_variation_request),
this one does NOT pre-render `{property_address}`/`{pm_first_name}`/
`{property_maintenance_due_date}` before insert - it leaves
`rendered_subject`/`rendered_body` as the raw template text, exactly like
`process-retention-campaigns` does for `dormant_client_reengagement`, and
relies on `process-scheduled-comms`'s own `buildEntityContext` (which
gained a new `property_asset` branch) to resolve those tokens at actual
send time. Idempotency mirrors `process-retention-campaigns` too: "has a
`property_maintenance_due` row been queued for this asset SINCE its
`last_gutter_clean_date`" - once the asset's `last_gutter_clean_date` is
updated after the clean happens, the next due cycle gets a fresh
reminder without double-sending for the same cycle.

Deploy separately from the existing functions:
```
supabase functions deploy process-real-estate-maintenance --no-verify-jwt
```
then its own `pg_cron` schedule:
```sql
select cron.schedule(
  'process-real-estate-maintenance',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/process-real-estate-maintenance',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY')
  );
  $$
);
```

**Desktop**: `/real-estate`'s third sub-tab, `RecurringMaintenanceEngine.tsx`
- lists every roofing asset with a computable due date (client-side date
math from `attributes`, same formula the Edge Function uses), filterable
by month/suburb/agency/asset type. "Send Reminder Email to PM" per row
mirrors the "Send via Email" pattern used elsewhere (manual rule/template
lookup + insert + `triggerImmediateDispatch`) rather than waiting for the
next cron sweep. "Batch Generate Draft Jobs" surfaced a real schema gap:
`properties` has no `client_id` of its own (tenant/landlord are plain text
fields, not a `clients` row), but `job_cards.client_id` is required - so
generating a draft job first creates a lightweight `clients` row from the
property's tenant details (falling back to the landlord's name), then the
job itself, tagged with the same `agency_id`/`property_manager_id`/`property_id`
as everywhere else in this module. An admin can merge or edit that
synthetic client afterward same as any other client record.

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, `pnpm --filter desktop build`, and `pnpm --filter mobile
  typecheck` all pass clean.
- Fresh local Postgres 16 database, all 27 real migrations applied in
  order. Seeded a tenant, admin, agency, property manager, property, and
  three property assets (one roofing asset due within 30 days, one
  roofing asset due almost 5 months later, and one plumbing asset with no
  schedule data at all), through the throwaway non-superuser `app_test`
  role.
  - Confirmed the tenant seeded all 19 trigger_keys (18 + the new one),
    confirming the "carry the full list forward" convention held again.
  - Confirmed `scheduled_communications.entity_type` accepts
    `'property_asset'` with a real insert.
  - Replicated the Edge Function's own due-date/window SQL directly: the
    near-term roofing asset correctly flagged due-within-30-days, the
    far-term one correctly flagged not due, and the plumbing asset was
    correctly excluded by the `category = 'roofing'` filter.
  - Confirmed the idempotency check ("has a reminder already been queued
    for this asset since its last_gutter_clean_date") correctly finds a
    just-inserted row.
  - Confirmed the property-manager-lookup join (asset -> property ->
    property_manager) returns the right recipient email.
  - Confirmed the "Batch Generate Draft Jobs" flow's two-step insert
    (synthetic `clients` row from the property's tenant details, then a
    `job_cards` row carrying `is_real_estate_job`/`agency_id`/
    `property_manager_id`/`property_id`) both succeed and return the
    expected shape.
  - Database and the `app_test` role both dropped after, no state left
    behind.
- Playwright/Chromium smoke test with placeholder `.env`: `/real-estate`
  still correctly redirects to `/login` when signed out, with no
  unexpected console errors (the usual one-time favicon 404). Dev server
  killed and `.env` deleted after.

### NOT verified from this sandbox

- The Edge Function itself has never actually run (no deployed instance
  here to invoke it against, and no `pg_cron`/`pg_net` extension in this
  sandbox) - its SQL-equivalent logic was verified directly instead (see
  above), same caveat `process-retention-campaigns` already carries.
- Clicking through the Recurring Maintenance tab's filters, checkboxes,
  and both action buttons against a real signed-in session; this sandbox
  has no such backend.

## 28. Fix: New Agency form asked for contact details that belong to a PM, not the agency

The "New agency" modal (Directory tab) had Billing email and Phone
fields - both already optional at the schema/DB level, but still shown
as if they were something to fill in for the agency itself. Per direct
feedback: an agency's actual contact details are always a specific
property manager's (see `property_managers.email`/`mobile`/`work_phone`),
not the agency's, so asking for them at the agency level was asking for
information that doesn't belong there. Removed both fields from the
form entirely - `createAgency` now only ever inserts `name`, `type`, and
`require_work_order_num`. The `agencies.billing_email`/`phone` columns
and the zod schema's optional fields are untouched (still there for any
future agency-level use), just never populated from this form.

Mobile's `handleRequestNteVariation` still falls back to
`agency?.billing_email` when a job has no property manager assigned -
that's unaffected, it's a defensive fallback for an edge case, not
something this form was ever the only way to populate.

### Verified from this sandbox

- `pnpm --filter desktop typecheck` and `pnpm --filter desktop build`
  both pass clean.
- Fresh local Postgres 16 database, all 27 real migrations applied,
  using the same throwaway non-superuser `app_test` role as every batch
  since Batch 1. Inserted an agency with only `name`/`type`/
  `require_work_order_num` (no `billing_email`/`phone`) as the admin -
  succeeded, with both omitted columns correctly left `null`. Database
  and role dropped after.

### NOT verified from this sandbox

- Actually opening the simplified modal in a browser and confirming the
  two fields are gone visually; this sandbox has no real Supabase
  project to sign in against.

## 29. Fix: clients were receiving 2-5 copies of the same automated email

Reported directly: clients were getting several identical copies of the
same automated email. Root cause was the exact gap flagged (but left
unfixed) in section 26 - `communication_templates` had no unique
constraint over `(tenant_id, trigger_key, type)`, and every migration
since the communication engine was first built re-inserted the *full*
template list into `seed_default_communication_templates`'s backfill DO
block with no `ON CONFLICT` guard, unlike `communication_rules`' own
`unique (tenant_id, trigger_key)` + `on conflict ... do nothing`. A tenant
that's existed since early in this schema's history had accumulated up
to 5 duplicate rows per trigger_key by now (seven migrations have touched
this function).

Duplicate rows alone would just be clutter in the Automation & Messaging
screen - the actual multi-send came from every place that queues a
message off `communication_templates` doing a `for ... in (select ...)
loop`, not a single lookup: `schedule_quote_communications`/
`schedule_invoice_communications` (this same migration file, further
down in it), `schedule_job_prep_checklist`/`schedule_job_completion_summary`,
`schedule_maintenance_reminder`, `process-retention-campaigns`,
`process-real-estate-maintenance`, and mobile's own
`queueScheduledCommunication`. Every one of those inserts (and therefore
sends) one `scheduled_communications` row **per matching template row**
- with `n` duplicate rows for a trigger_key, every one of those call
sites sent `n` copies, automatically, with no code change needed to
trigger it.

Fix, in `fix_duplicate_communication_templates` migration, in order:
1. De-duplicate existing rows per `(tenant_id, trigger_key, type)`. Since
   `set_updated_at` only fires on UPDATE, `updated_at > created_at` on a
   row is a reliable signal "an admin used Edit Message on this exact
   row" - the other duplicates (only ever INSERTed by a reseed, never
   updated) won't have that. The dedup keeps whichever row in each group
   looks most like a genuine edit first, falling back to most recently
   updated, then earliest created (the original seed) as a last resort -
   so if an admin actually customized one of the duplicates, that
   customization survives instead of being silently overwritten by an
   untouched reseed copy.
2. Add the missing `unique (tenant_id, trigger_key, type)` constraint -
   `type` has to be part of it since a trigger_key can legitimately carry
   one sms row and one email row, that's not a duplicate.
3. Redefine `seed_default_communication_templates` with an
   `on conflict (tenant_id, trigger_key, type) do nothing` guard, so no
   future migration's backfill (or a second manual call, or this
   accidentally being re-run) can ever recreate the problem.

`scheduled_communications.template_id` is `on delete set null`, so
deleting a duplicate never breaks an already-scheduled or already-sent
row - that row's own `rendered_subject`/`rendered_body` were already
captured independently at insert time, so losing the `template_id`
pointer afterward changes nothing about what was actually sent.

### Verified from this sandbox

- Fresh local Postgres 16 database, all 27 prior migrations applied,
  using the throwaway non-superuser `app_test` role.
- Simulated the actual historical bug rather than just checking the
  schema: manually inserted 2 extra duplicate `quote_sent` email rows
  (one of them genuinely "edited" - `updated_at` set after `created_at`,
  with different subject/body text) and 2 extra duplicate
  `job_review_request` email rows (all unedited), plus a `client`,
  `quote`, and a `scheduled_communications` row already marked `sent`
  that pointed at one of the duplicate `quote_sent` rows about to be
  deleted - mirroring a real tenant's actual accumulated state, not a
  toy case.
- After applying the fix migration:
  - Zero duplicate `(tenant_id, trigger_key, type)` groups remain.
  - The surviving `quote_sent` row is the genuinely edited one (its
    custom subject/body), not a reseeded default - confirming the dedup
    correctly protects a real admin customization.
  - The surviving `job_review_request` row is the original seed (none of
    those duplicates were edited).
  - The pre-existing `sent` `scheduled_communications` row is untouched
    except `template_id`, which is now `null` as expected - no error, no
    lost history.
  - The unique constraint exists in `pg_constraint`.
  - Re-calling `seed_default_communication_templates` for the *same*
    tenant afterward is now a confirmed no-op (19 rows before, 19 after).
  - A brand-new tenant created afterward still seeds all 19 templates (as
    well as 19 rules and 5 lifecycle stages) correctly - no regression.
  - Database and the `app_test` role both dropped after, no state left
    behind.

### NOT verified from this sandbox

- The actual email volume a real client would have received before this
  fix, or confirming no more duplicates arrive after deploying it -
  needs a real Supabase project with `process-scheduled-comms` actually
  running against real quote/invoice/job activity; this sandbox has no
  such backend.

## 30. Fix: no way to record a landlord's phone/email, or a tenant's contact details

Reported directly after Batch 1-3: the user had created an agency, a
property manager, and a managed property, but "I can not set the landlord
mobile and email nor can I set a tenant and their contact details."

Two distinct gaps, found by reading the schema and the "New managed
property" form side by side rather than assuming either was already
covered:

- `properties.owner_landlord_phone` / `owner_landlord_email` didn't exist
  as columns at all - a real schema gap, not a UI oversight. Added via
  `20260824000100_property_landlord_contact_and_edit.sql`
  (`alter table public.properties add column owner_landlord_phone text,
  add column owner_landlord_email text;`).
- `properties.tenant_name` / `tenant_phone` / `tenant_email` already
  existed (added in the real_estate_strata migration) but the "New
  managed property" form in `RealEstate.tsx` never collected them, and
  there was no edit-property capability anywhere to add them after the
  fact either.

Fix, in `packages/shared` + both fields' worth of desktop UI:

- `Property` type and `createPropertySchema` (shared) gained the two new
  landlord fields, following the existing pattern (`.email().optional().or(z.literal(""))`
  for emails, `.optional()` for phone/name).
- New `updatePropertyContactSchema` (shared) covers all 8 editable fields
  (landlord name/phone/email, tenant name/phone/email, access notes, key
  tag number) for the edit flow.
- `RealEstate.tsx`'s "New managed property" modal now collects landlord
  mobile/email and tenant name/mobile/email alongside the fields it
  already had.
- `PropertyDetail.tsx`'s Access & Contacts tab gained an "Edit" button
  opening a new modal (`updatePropertyContactSchema` -> `properties`
  update by id) and now displays the landlord's phone/email with
  `tel:`/`sms:`/`mailto:` quick-action links, mirroring the tenant
  contact card that already existed.

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, `pnpm --filter mobile typecheck`, and `pnpm --filter
  desktop build` all pass clean.
- Fresh local Postgres 16 database, all 26 real migrations (including
  this one) applied in order against the same hand-written `auth`/
  `storage` stubs used in every prior batch. Confirmed
  `owner_landlord_phone`/`owner_landlord_email` exist as nullable `text`
  columns on `properties`.
- Using the throwaway non-superuser `app_test` role (RLS genuinely
  enforced): seeded a tenant, an admin, a technician, an agency, and a
  property manager. As admin: ran the exact insert the "New managed
  property" modal issues (all 6 landlord/tenant contact fields
  populated) and confirmed the row round-trips correctly; ran the exact
  update the new "Edit access & contacts" modal issues, confirming
  every field updates including `access_notes` and `key_tag_number`;
  confirmed clearing landlord phone/email back to empty (the UI's
  `|| null` behavior) stores `null`, not `""`. As the (non-admin)
  technician: confirmed an `update` on `properties` affects 0 rows, the
  existing "affects 0 rows for a non-admin" pattern used everywhere else
  in this schema - the admin's values were untouched afterward.
  Database and the `app_test` role both dropped after, no state left
  behind.
- Playwright/Chromium smoke test with a placeholder `.env`: `/real-estate`
  and `/real-estate/properties/:id` both correctly redirect to `/login`
  when signed out, with no unexpected console errors (the same benign
  one-time `favicon.ico` 404 seen in every prior batch). Dev server
  killed and `.env` removed after.

### NOT verified from this sandbox

- Manually clicking through the new "Edit access & contacts" modal in a
  real browser session signed in against a live Supabase project - this
  sandbox has no real backend to sign in against, so the modal's wiring
  was verified by tracing the code and exercising the exact SQL it
  issues, not by clicking it.

## 31. B2B Partner & Referral Tracking module (Sales -> B2B & Referrals)

New module tracking B2B partners, BNI/networking groups, and client
referral sources; attributing revenue to partners; calculating BNI "Thank
You For Closed Business" (TYFCB); monitoring referral reciprocity; and
automating referral appreciation emails. Lives under Sales -> B2B &
Referrals (`/b2b-referrals`), as 4 in-page sub-tabs - same "one sidebar
destination, several in-page tabs" relationship RealEstate.tsx already
established for its own four-sub-tab spec.

Two deliberate departures from the spec as given, both explained in the
relevant migration's own comment:

- This app has no separate "lead" entity, so the spec's "Lead, Quote, and
  Job creation forms" becomes job_cards and quotes (the two closest
  equivalents) - a referral source dropdown was added to both the "New
  job" modal (Jobs.tsx) and the "New quote" page (QuoteNew.tsx).
- The spec's single decimal `reward_value` column is split into
  `reward_percent numeric(5,2)` (commission_percent) and
  `reward_flat_cents bigint` (flat_fee/gift_card) - a single field is
  unit-ambiguous, and every other money column in this schema is an
  explicit `_cents` bigint.

### Schema (`b2b_referral_tracking` + `b2b_referral_automation` migrations)

- `referral_groups`, `referral_partners`, `referral_reciprocity_logs` -
  new tables, RLS follows the agencies/properties shape (tenant-wide read,
  admin-only write) since this whole module has no field-technician
  surface.
- `job_cards`/`quotes` gain `referral_partner_id` /`referral_fee_paid` /
  `referral_fee_amount_cents`.
- `invoices` gains `paid_at`, set once by `set_invoice_paid_at` the first
  time status transitions to 'paid' - needed because `updated_at` moves on
  any unrelated edit and would silently corrupt the TYFCB engine's
  date-range filter.
- `calculate_referral_fee_on_invoice_paid` (AFTER UPDATE on invoices,
  same `status -> 'paid'` guard as `paid_at`) computes
  `job_cards.referral_fee_amount_cents` from the partner's reward rule the
  moment the linked job's invoice is paid; `referral_fee_paid` is never
  flipped automatically - an admin marks it once the partner is actually
  paid out (no bank integration to detect that).
- Every metric shown in the UI (referrals sent, closed revenue won,
  reciprocity ratio, TYFCB totals, conversion rate) is computed live from
  job_cards/invoices/referral_reciprocity_logs client-side, not a stored
  running total - same tradeoff Job Costing already makes elsewhere:
  simpler, never drifts out of sync, more client-side aggregation per
  render.

### Automation (`b2b_referral_automation` migration)

Three new trigger_keys on the existing communication_rules/
communication_templates/scheduled_communications engine:

- `referral_lead_received` - AFTER INSERT OR UPDATE on job_cards, fires
  the moment `referral_partner_id` is newly set (new job or later
  attribution). entity_type gains `'referral_partner'`, entity_id is the
  **job's** id (mirrors how `entity_type='job'` resolves client context
  via `job.client_id` - here the dispatcher resolves the partner via
  `job.referral_partner_id`).
- `referral_job_completed` - AFTER UPDATE on invoices, same guard as the
  fee-calc trigger, a separate function so a failure in one can never
  block the other.
- `referral_monthly_digest` - NOT event-triggered. Swept once a month by
  a new Edge Function, `process-referral-digest` (same "calendar-driven
  check" shape as process-retention-campaigns/process-real-estate-
  maintenance). Unlike every other trigger_key, this one is **fully
  rendered before insert** by that function rather than left with raw
  `{tokens}` for process-scheduled-comms to resolve at send time - there's
  no single job/invoice this message is "about" (it's a sum across
  everything that closed last calendar month), so entity_id is the
  partner's own id, a case `buildEntityContext`'s new `referral_partner`
  branch handles as a safe fallback (tries a job_cards lookup by entity_id
  first; if none exists - because it's actually a partner id - falls back
  to a partner-only context, which is a harmless no-op here since the
  digest body has no unrendered tokens left to substitute).
- `communication_templates.category` gains `'partner'` (existing values
  had no natural fit for a message sent to a partner rather than a
  client).
- New placeholder tokens (`packages/shared/src/placeholders.ts` +
  the Deno-native port in `process-scheduled-comms/index.ts`, kept in
  sync by hand per that file's own long-standing note): `partner_first_name`,
  `referred_client_name`, `job_value`, `digest_jobs_count`,
  `digest_total_value`.
- Sub-tab 4 (Automated Partner Workflows) is a scoped-down version of
  AutomationSettings.tsx's rule/template editor, covering only these
  three trigger_keys, living inside the B2B module rather than added to
  the shared Settings page.

### UI

- Sub-tab 1 (Partner Directory & Groups): By Partner / By Group dual
  view, partner cards (referrals sent, closed revenue won, reciprocity),
  Add Partner / Add BNI Group / Log Referral Passed Out.
- Sub-tab 2 (Revenue Analytics & BNI TYFCB): 4-tile KPI ribbon (Total
  Referral Revenue YTD, Conversion Rate, Average Value per Referred Job,
  BNI TYFCB Total YTD) + the TYFCB export tool (BNI group + date-range
  filter with This Week/This Month/Last Month/YTD presets, copy-to-
  clipboard and CSV export).
- Sub-tab 3 (Reciprocity Ledger): inbound-vs-outbound bar per partner +
  a 🟢 Balanced / 🟡 Net Exporter / 🔵 Net Importer badge (ratio > 2x
  either way tips the badge - the spec names the three states but not the
  cutoffs, so this is a documented judgment call, not a spec requirement).
- Sub-tab 4 (Automated Partner Workflows): see Automation above.

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, `pnpm --filter mobile typecheck`, and `pnpm --filter
  desktop build` all pass clean.
- Fresh local Postgres 16 database, all 31 real migrations (including
  both of this module's) applied in order against the same hand-written
  `auth`/`storage` stubs used in every prior batch.
- Using the throwaway non-superuser `app_test` role (RLS genuinely
  enforced): seeded a tenant, an admin, a technician, and a client. As
  admin: created a BNI chapter group, a commission_percent partner in it,
  a flat_fee partner with no group, a job referred by the first partner
  (exact insert the "New job" modal issues), then created and paid an
  invoice for that job (exact update the Invoice detail flow issues) and
  confirmed: `referral_fee_amount_cents` computed correctly (5% of
  $2,000.00 = $100.00 = 10000 cents), `invoices.paid_at` set,
  `referral_lead_received` and `referral_job_completed` both queued with
  the correct partner email as recipient and correct rendered subject,
  a reciprocity log insert round-trips, and a hand-written TYFCB
  aggregation query (paid invoices joined through job_cards to BNI-
  chapter partners) returns the correct partner/count/total. As the
  (non-admin) technician: confirmed an `insert` into `referral_partners`
  is rejected outright by RLS (`new row violates row-level security
  policy`). Database and the `app_test` role both dropped after, no state
  left behind.
- Playwright/Chromium smoke test with a placeholder `.env`:
  `/b2b-referrals` correctly redirects to `/login` when signed out, with
  no unexpected console errors (the same benign one-time `favicon.ico`
  404 seen in every prior batch). Dev server killed and `.env` removed
  after.

### NOT verified from this sandbox

- `process-referral-digest` actually deployed and firing on a real
  monthly pg_cron schedule, or `process-scheduled-comms` actually sending
  a real email through Resend for any of the three new trigger_keys -
  needs a real Supabase project with those Edge Functions deployed and
  cron configured; this sandbox has no such backend. The `select
  cron.schedule(...)` call for `process-referral-digest` needs to be run
  by hand against the deployed project (same as every other cron-driven
  sweep in this schema), e.g. monthly on the 1st:
  `select cron.schedule('referral-digest-monthly', '0 6 1 * *', $$select net.http_post(url:='https://<project>.supabase.co/functions/v1/process-referral-digest', headers:='{"Authorization": "Bearer <service-role-key>"}'::jsonb) $$);`
- Manually clicking through all four sub-tabs (KPI numbers rendering,
  CSV download, the reciprocity bar widths) in a real browser session
  signed in against a live Supabase project - this sandbox has no real
  backend to sign in against, so the UI's data-fetching/aggregation logic
  was verified by tracing the code against the SQL it issues, not by
  clicking it.

## 32. Dynamic Reports & Safety Documentation Engine (SafetyCulture-style)

New module for building, executing, and signing off on custom forms
(SWMS, JSAs, roof audits, site inspections) with photos, risk matrices,
and e-signatures - reachable from the sidebar's "Reports" link
(`/reports`) and from a new "Reports & Safety" section on every Job Card.

Scope decisions, each explained in the relevant file's own comment:

- **Desktop-only**, same precedent as B2B & Referrals and Real Estate &
  Strata - no mobile/field-technician build in this pass. Camera/GPS/
  signature capture are done through the browser's own APIs (file input,
  `navigator.geolocation`, an HTML5 canvas) rather than native device
  APIs.
- **"Homepage tile"** becomes a top-level sidebar nav entry
  (`components/Layout.tsx`, next to Dispatch/Tasks) - desktop has no
  tile-based home dashboard to place a literal tile on (root `/`
  redirects straight to `/dispatch`).
- **PDF compilation is a real client-side compile**, not the browser
  "Print to PDF" dialog every other PDF export in this app uses (quotes/
  invoices, the shopping list). Those are always a deliberate save-this-
  now user action; a report's PDF has to exist with nobody clicking
  through a print dialog, since the whole point is "auto-compile, store
  in cloud storage, make it emailable" with no human in that loop. New
  dependency: `jspdf` (`apps/desktop/src/lib/report-pdf.ts`), the only
  place in this app that produces actual PDF bytes rather than opening a
  print dialog.
- **"Auto-attach to the Job's Documents & Attachments"** becomes "the
  linked report + its PDF appear in the Job Card's own Reports & Safety
  section" rather than a duplicate row in the existing `job_files` table
  - see the migration's own comment for why (job_files' download code
  hardcodes bucket `"job-files"`, and reports live in their own
  `"report-files"` bucket so a standalone report never needs its
  underlying file moved when it's later linked to a job).

### Schema (`reports_safety_engine` migration)

- `report_categories` -> `report_subcategories` -> `report_templates` -
  a fixed three-level taxonomy, admin-managed reference data (tenant
  read, admin write - no field-technician surface for this module, same
  as `referral_partners`/agencies).
- `report_templates.structure_schema` (jsonb) and
  `report_instances.form_data` (jsonb) - a form-builder JSON blob and its
  answers, same "no fixed columns, zod validates the outer shape at the
  app boundary" tradeoff `property_assets.attributes` already makes. See
  `packages/shared/src/reports.ts` for the exact TypeScript shape both
  apps share: `ReportFieldType` = pass_fail / risk_matrix / photo / text
  / long_text / meter_reading / signature; `calculateRiskRating` is a
  standard 5x5 (likelihood x consequence) WHS matrix.
- `report_instances` - `job_card_id`/`client_id` both nullable (Workflow
  2's standalone-or-linked-either-direction requirement); `status`
  draft/completed/archived; `pdf_storage_path` set once, at completion.
- `report_signatures` - SWMS worker sign-off roster, one row per worker
  per report, each individually timestamped.
- New private storage bucket `"report-files"`
  (`<tenant_id>/<report_instance_id>/<filename>`), tenant-scoped RLS,
  admin read/write.
- New `report_sent` trigger_key on the existing communication engine
  (manual send, like `quote_sent`/`invoice_sent` - the user chooses when
  to email a finished report, not a DB trigger). `{report_title}`/
  `{report_pdf_link}` tokens added to `packages/shared/src/placeholders.ts`
  and the Deno dispatcher's own port
  (`supabase/functions/process-scheduled-comms/index.ts`) - the link is a
  7-day signed URL into the private bucket (an external client recipient
  has no Supabase login), same approach quote/invoice approval links use
  for the same reason.

### UI

- **Reports** (`/reports`, 3 tabs): New Report (searchable Category ->
  Subcategory -> Template list), Report History (every report across the
  tenant, status badges, "Link to Job" for any unlinked row), Template
  Studio (category/subcategory CRUD inline, same expandable-tree pattern
  RealEstate.tsx's Directory tab uses for Agency -> PM -> Property).
- **Template editor** (`/reports/templates/new` and `/:id`) - the actual
  form builder: add/remove/reorder (up/down buttons, no drag-and-drop)
  sections and fields, per-field type/required/"fail requires action
  note + photo" toggles, `is_swms` toggle.
- **Report runner + viewer** (`/reports/instances/:id`) - one page for
  both states: while `draft`, renders the dynamic form (conditional
  fail-action-photo sub-question, risk matrix picker with a live colour-
  coded rating badge, photo upload, canvas signature pad, SWMS roster);
  once `completed`, shows a read-only summary with Download PDF / Send
  via Email buttons. "Complete report" validates every required field is
  answered, best-effort captures GPS (`navigator.geolocation`, 5s
  timeout, resolves `null` on any failure rather than blocking
  completion), compiles the PDF, uploads it, and flips status.
- **Job Card "Reports & Safety" section** (`JobDetail.tsx`) - lists
  linked reports; "Create New Report" opens a searchable template picker
  that inserts the draft with `job_card_id`/`client_id` pre-set; "Link
  Existing Report" opens a picker over every report with a null
  `job_card_id`.

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, `pnpm --filter mobile typecheck`, and `pnpm --filter
  desktop build` all pass clean (the build pulls in jsPDF's own
  `html2canvas`/`purify` sub-dependencies, all resolved fine).
- Fresh local Postgres 16 database, all 32 real migrations (including
  this one) applied in order against the same hand-written `auth`/
  `storage` stubs used in every prior batch.
- Using the throwaway non-superuser `app_test` role (RLS genuinely
  enforced): as admin, built a category -> subcategory -> SWMS template
  (matching the exact Template Studio insert shape, including a
  `structure_schema` with a pass_fail and a risk_matrix field), created a
  job, started a report auto-linked to it (the Job Card "Create New
  Report" insert shape), started a SECOND report from the SAME template
  with no job link (confirms no artificial one-report-per-template
  limit - two rows, both present), completed the first report with
  `form_data`/`geo_location`/`pdf_storage_path` set exactly as the runner
  sets them, added a SWMS worker sign-off, retroactively linked the
  second (standalone) report to the job (the Report History "Link to
  Job" update shape), confirmed `report_sent`'s rule and template were
  auto-seeded with the correct subject/tokens, and queued a
  `scheduled_communications` row with `entity_type = 'report'` (the
  "Send via Email" button's exact insert shape). As the (non-admin)
  technician: confirmed an `insert` into `report_templates` is rejected
  outright by RLS, while a plain `select` still returns the template (the
  intended tenant-wide-read-admin-write shape). Database and the
  `app_test` role both dropped after, no state left behind.
- Playwright/Chromium smoke test with a placeholder `.env`: `/reports`,
  `/reports/templates/new`, `/reports/templates/:id`, and
  `/reports/instances/:id` all correctly redirect to `/login` when signed
  out, with no unexpected console errors (the same benign one-time
  `favicon.ico` 404 seen in every prior batch). Dev server killed and
  `.env` removed after.

### NOT verified from this sandbox

- Actually opening the PDF a completed report produces and eyeballing
  its layout, or confirming embedded photos/signatures render correctly
  inside it - jsPDF's own text-wrapping/pagination/image-embedding logic
  was traced by reading `report-pdf.ts`, not executed against a browser
  DOM (jsPDF needs a real Canvas/Image environment this sandbox's
  Node-only verification path doesn't have).
- Uploading a real photo through the browser's camera/file picker, or
  drawing a real signature on the canvas pad and confirming the resulting
  data URI round-trips correctly through Storage and back into a PDF -
  this sandbox has no real backend/browser session to click through
  either flow end to end.
- The `report_sent` email actually being received with a working 7-day
  signed PDF link - needs a real Supabase project with Resend configured
  and a completed report with a real uploaded PDF; this sandbox has
  neither.

## 33. Subcontractor Management & Procurement module (Operations -> Subcontractors)

New module for managing subcontractor companies, their trade/compliance
paperwork, a 5-tier preference system, and Purchase Order/Work Order/Quote
Request issuance with PDF generation and email dispatch - reachable from a
new "Operations" sidebar section (`/subcontractors`) and from a new
"Subcontractors" section on every Job Card.

Scope decisions, each explained in the relevant file's own comment:

- **Desktop-only, admin-managed RLS** (tenant read, admin write) - same
  shape as B2B & Referrals and Reports & Safety, explicitly re-documented
  in the migration's own comments as "no field-technician surface for
  this module." A subcontractor's own quote submission happens through
  the existing token-based external approval page, not a signed-in
  session.
- **One `purchase_orders` table covers both "Quote Request" and "Work
  Order/PO"** via an `is_quote_request` flag plus an added `'quoted'`
  status, rather than two separate tables - the spec's own description of
  both workflows overlaps almost entirely (pick a job, pick a
  subcontractor + contact, line items, a total). A Quote Request becomes
  a real Work Order once its status progresses past `'quoted'`; the flag
  only records how it originated.
- **Compliance-hold status is dual-path automated**, never set directly
  by the app: an `AFTER INSERT OR UPDATE OR DELETE` trigger on
  `subcontractor_compliance_docs` recomputes status immediately, and a new
  daily sweep Edge Function (`process-subcontractor-compliance`, same
  shape as `process-retention-campaigns`/`process-real-estate-
  maintenance`) catches any expiry that happens silently with no row
  change (a document's `expiry_date` passing overnight). The sweep's own
  idempotency check is per-contact, not per-entity like every other
  trigger_key in this schema - multiple contacts at one subcontractor
  each need their own reminder, a deliberate departure documented in the
  migration.
- **PDF compilation reuses the Reports module's jsPDF-direct-to-Blob
  approach** (`apps/desktop/src/lib/po-pdf.ts`, modelled on
  `report-pdf.ts`), not the browser "Print to PDF" dialog quotes/invoices
  use - a Work Order's PDF has to exist unattended to attach a signed
  link to an automated email, the same reasoning as a report's PDF.
- **The external quote-submission link reuses the existing token-based
  approval-page pattern** (`generate_po_quote_link`/
  `get_po_quote_for_approval`/`submit_po_quote_by_token`, all `SECURITY
  DEFINER`, granted to `anon, authenticated`) - a new `po_quote` doc type
  in the shared `approve` Edge Function and `approval-page.html`, not a
  new mechanism.

### Schema (`subcontractor_management` migration)

- `subcontractor_companies` (trades array, `preference_tier` 1-5,
  `status` active/inactive/compliance_hold), `subcontractor_contacts`,
  `subcontractor_compliance_docs` (doc_type, expiry_date, is_verified),
  `purchase_orders` (`line_items` as embedded jsonb rather than a child
  table - a PO line item is just description/quantity/unit_cost_cents,
  far flatter than quote/invoice's labour/material/markup breakdown, so a
  separate table would be pure overhead).
- `assign_po_number()` trigger reuses `next_reference_number()` (prefix
  `PO`, 4-digit pad) - same auto-incrementing pattern as quotes/invoices.
- New private `subcontractor-files` storage bucket, same tenant-scoped
  path convention and RLS shape as `report-files`/`job-files`.
- `scheduled_communications.entity_type` widened to add
  `'purchase_order'`/`'subcontractor'`; three new trigger_keys -
  `subcontractor_quote_request`/`subcontractor_work_order` (manual sends,
  entity_id is the `purchase_orders` row, same shape as `quote_sent`/
  `report_sent`) and `subcontractor_compliance_expired` (queued by the
  daily sweep, entity_id is the `subcontractor_companies` row, one row
  per contact).

### Desktop (`apps/desktop`)

- **`Subcontractors.tsx`** (`/subcontractors`) - three sub-tabs: Directory
  & Tier Board (search/trade/tier/status filters, card grid, "New
  subcontractor" modal), reused by `ComplianceTrackerTab.tsx` (a
  subcontractor x doc-type matrix, colour-coded by days-to-expiry, with a
  "Compliance Hold only" toggle) and `FinancialPerformanceTab.tsx` (per-
  subcontractor cost-paid vs revenue-generated vs margin, using the
  spec's own formulas, KPI tiles at the top).
- **`SubcontractorDetail.tsx`** (`/subcontractors/:id`) - header with a
  tier `<select>`, compliance-hold banner, and four sub-tabs: Contacts,
  Work Orders & Quote Requests (buttons disabled and a warning shown when
  the subcontractor is on compliance hold), Compliance Records (upload/
  verify/delete), Financials & Jobs.
- **`PurchaseOrderNew.tsx`** (`/subcontractors/purchase-orders/new`) and
  **`PurchaseOrderDetail.tsx`** (`/subcontractors/purchase-orders/:id`) -
  creation form and the full editor: status pills, a line item editor
  (`PoLineItemEditor.tsx`), a "Client billed price" field with a live
  margin preview, "Send Quote Request" (generates the token, queues +
  dispatches `subcontractor_quote_request`) or "Send Work Order" (builds
  the PDF, uploads it, queues + dispatches `subcontractor_work_order`),
  and a "Download PDF" button for a manual copy. Arriving with
  `?subcontractorId=`/`?quoteRequest=`/`?jobCardId=` query params pre-
  fills and (for the job) locks the form, same pattern as `QuoteNew.tsx`.
- **Job Card "Subcontractors" section** (`JobDetail.tsx`) - lists POs
  linked to the job; "Assign Subcontractor" opens a tier-sorted picker
  with a trade filter, compliance-hold subcontractors greyed out with a
  warning and their action buttons disabled, and "Request Quote"/"Issue
  Work Order" buttons that navigate to the PO editor pre-filled with this
  job.
- New "Operations" sidebar section (`components/Layout.tsx`).

### Verified from this sandbox

- `pnpm --filter @jmssaas/shared typecheck`, `pnpm --filter desktop
  typecheck`, `pnpm --filter mobile typecheck`, and `pnpm --filter
  desktop build` all pass clean.
- Fresh local Postgres 16 database, all 33 real migrations (including
  this one) applied in order against the same hand-written `auth`/
  `storage` stubs used in every prior batch.
- Using the throwaway non-superuser `app_test` role (RLS genuinely
  enforced), across two tenants: as admin, created a subcontractor with a
  contact, a compliance doc with a future expiry date (status stayed
  `active`), and a Purchase Order (confirmed the `PO0001` auto-numbering).
  Then moved the compliance doc's expiry into the past and confirmed the
  `AFTER UPDATE` trigger flipped the subcontractor to `compliance_hold`
  immediately, with no extra step. As the (non-admin) technician:
  confirmed `select` on `subcontractor_companies`/`purchase_orders`
  returns the tenant's rows (tenant-wide read), while an `insert` is
  rejected outright by RLS and an `update` silently affects 0 rows (the
  established "admin write" pattern). As tenant two's admin: confirmed
  zero rows of tenant one's subcontractor/PO data are visible (tenant
  isolation). Exercised the full external quote-link RPC round trip -
  `generate_po_quote_link` issued a token, `get_po_quote_for_approval`
  returned the correct JSON (po_number, line_items, tenant/subcontractor/
  job names), and `submit_po_quote_by_token` (called with no role/session,
  matching how the public approval page calls it) correctly moved the PO
  to `status = 'quoted'` with the submitted `total_cost_cents` and a
  `quoted_at` timestamp. Database and the `app_test` role both dropped
  after, no state left behind.
- Playwright/Chromium smoke test with a placeholder `.env`: `/subcontractors`,
  `/subcontractors/:id`, `/subcontractors/purchase-orders/new`, and
  `/subcontractors/purchase-orders/:id` all correctly redirect to
  `/login` when signed out, with no unexpected console errors (the same
  benign one-time favicon 404 seen in every prior batch). Dev server
  killed and `.env` removed after.

### NOT verified from this sandbox

- The daily `process-subcontractor-compliance` sweep Edge Function itself
  running end to end (silent-expiry catch-up, per-contact idempotency) -
  it was traced by reading the code against the same pattern as its
  sibling sweep functions, not invoked against a real Deno/Supabase
  runtime; this sandbox has neither.
- Actually opening a compiled Purchase Order PDF and eyeballing its
  layout - `po-pdf.ts`'s pagination/text-wrapping logic was traced by
  reading the code (and mirrors `report-pdf.ts`'s already-established
  approach), not executed against a real jsPDF/Canvas environment.
- The `subcontractor_quote_request`/`subcontractor_work_order`/
  `subcontractor_compliance_expired` emails actually being received -
  needs a real Supabase project with Resend configured; this sandbox has
  neither.
- Clicking through the Directory/Compliance Tracker/Financial Performance
  tabs, the detail profile's four sub-tabs, or the "Assign Subcontractor"
  modal against a real signed-in session - needs a real Supabase project
  with real data; this sandbox's Playwright check only reached the
  logged-out route-guard redirect.

## 34. Bug fixes + Client contacts/addresses + Risk register + Signatures + Stripe + Email composer

A large batch of fixes and features requested together, on branch
`claude/template-risk-client-updates-7ljk6t`:

- **Fix: quote/PO line item decimal entry.** `LineItemEditor.tsx` and
  `PoLineItemEditor.tsx` (desktop) and `LineItemEditor.tsx` (mobile) drove
  their labour rate/hours/material cost/markup/quantity inputs straight off
  `value={someNumber}` - typing "12." parsed to `12`, which redisplayed as
  "12" with the "." silently dropped, so a decimal point could never
  actually be typed (only pasting one worked, since paste bypasses the
  per-keystroke reformat). Fixed with a small `DecimalField`/`DecimalInput`
  wrapper that keeps the raw typed text in local state instead of
  re-deriving it from the numeric value every render.
- **Fix: Template Studio forced a blank field label.** `newField()` in
  `ReportTemplateEditor.tsx` created every new field with `label: ""`, and
  the schema requires a non-empty label to save - so adding a field with no
  label immediately blocked saving the whole template with no obvious way
  out. New fields now default their label to the field type's name (e.g.
  "Risk Assessment Matrix"), editable immediately, never blocking a save.
- **Risk assessment matrix rebuilt as a hazard register.** The old
  `risk_matrix` field was a single likelihood x consequence pick - the
  attached SafeWork NSW WHS Form 04 (Site Specific Risk Assessment) and
  Form 05 (SWMS) templates are actually a *table* of hazards, each with its
  own control measure, which a single pick couldn't represent. `RiskMatrixAnswer`
  in `packages/shared/src/reports.ts` is now `{ rows: RiskHazardRow[] }`,
  each row carrying its own hazard text/likelihood/consequence/rating/
  control-measures text. `ReportInstance.tsx`'s field renderer and
  `report-pdf.ts`'s PDF export both updated to add/remove/edit rows and
  print them as a table. Backwards-compatible read: any report saved
  before this change (no `rows` array) just renders as "no hazards
  recorded" instead of crashing.
- **Clients: company vs individual, contacts, addresses, WorkDrive.**
  `clients` gained `client_type` ('individual'/'company'), `company_name`
  (only meaningful when `client_type = 'company'` - `name` keeps meaning
  "the client's own name" for an individual, "primary contact person" for
  a company), and `workdrive_url`. A new `client_contacts` table covers the
  "a company may have 5 people we deal with" case. `client_sites` already
  existed in the schema (per-job addresses) but had no UI at all and
  `job_cards.site_id` was never set by any screen - `ClientDetail.tsx` now
  has Contacts/Addresses sections (add/remove), and its "New job" modal has
  an address picker (existing site, or "+ Add a new address" which saves to
  the client). `quotes`/`invoices` gained their own `site_id` (defaults to
  the client's primary address when unset), editable from `QuoteDetail.tsx`
  /`InvoiceDetail.tsx`, and `JobDetail.tsx` got the same address-edit
  control plus its own WorkDrive link section. `quote-invoice-pdf.ts`
  prints the resolved site's address (falling back to the client's) instead
  of always the client's own address.
- **Quote/invoice acceptance signature.** The public approval page
  (`supabase/static/approval-page.html`) now has a canvas signature pad on
  the accept form (same base64 PNG data-URI convention as the desktop
  Reports e-signature field) - required to accept, alongside the existing
  typed name. Stored in `quotes.accepted_signature_svg` /
  `invoices.accepted_signature_svg` via `accept_quote_by_token`/
  `accept_invoice_by_token` (now taking an extra `p_signature_svg` param),
  and stamped onto the compiled PDF next to the "Accepted by ..." line.
- **Stripe-linked invoice payment.** Previously the invoice link always
  went to the same accept/decline page a quote uses - useless once already
  accepted. Now: once an invoice is `accepted`, its own link shows a "Pay
  Now" button (tapped explicitly, never auto-fired on page load, same
  anti-prefetch caution as accept/decline) that creates/reuses a Stripe
  Checkout Session via the `approve` function's `getOrCreateStripeCheckoutUrl`
  helper and redirects there. `InvoiceDetail.tsx` also has its own "Create
  Stripe payment link" control for the office to (re)send. A new
  `stripe-webhook` function verifies Stripe's signature by hand (Deno Web
  Crypto, no SDK) and marks the invoice `paid` on `checkout.session.completed`.
  **Needs your own Stripe account** - see the exact secrets to set below;
  until `STRIPE_SECRET_KEY` is set, the payment link button shows "Payment
  not available yet" rather than failing silently.
- **Editable email composer everywhere an email is sent.** New
  `EmailComposeModal` component (desktop): editable To/Cc/Bcc/subject/body
  before sending, with a click-to-add chip list of every email address
  linked to the client card (their own email + `client_contacts`) and any
  email address found written into the job's notes/description text (see
  `packages/shared/src/email-recipients.ts`). Wired into "Send Quote via
  Email", "Send Invoice via Email", and a new "Email" button on the Job
  Card (with a template picker, for a ServiceM8-style free-form send).
  `scheduled_communications` gained `cc_emails`/`bcc_emails` (text arrays),
  passed straight through to Resend's own `cc`/`bcc` fields in
  `process-scheduled-comms`. The "Send review request" action deliberately
  was **not** routed through the composer - it's meant to stay a genuine
  one-tap automated send.

### New Supabase secrets needed

Beyond the existing `RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`APPROVAL_PAGE_URL`:

- `STRIPE_SECRET_KEY` - your Stripe account's secret key (Stripe Dashboard
  -> Developers -> API keys). Test mode (`sk_test_...`) works end-to-end
  against Stripe's test card numbers before you're ready to go live.
- `STRIPE_WEBHOOK_SECRET` - created after you add the webhook endpoint (see
  below), Stripe Dashboard -> Developers -> Webhooks -> your endpoint ->
  "Signing secret".

### Exact steps to push this out to the live site + mobile app

These assume you're on Windows using PowerShell, with `git`, `node`,
`pnpm` (`corepack enable`), and the Supabase CLI already installed per
section 1. Run from the repo root (`cd` there first if PowerShell opens
somewhere else).

**1. Pull the code and install dependencies**

```powershell
git fetch origin
git checkout claude/template-risk-client-updates-7ljk6t
git pull origin claude/template-risk-client-updates-7ljk6t
pnpm install
```

If you instead want this merged into `main` first, open/merge the PR on
GitHub (or `git checkout main; git merge claude/template-risk-client-updates-7ljk6t; git push origin main`),
then do the rest of these steps from `main`.

**2. Push the new database migrations to Supabase**

```powershell
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db push
```

This applies the four new files under `supabase/migrations/` (client
contacts/sites/WorkDrive, signature + Stripe columns, the updated
`accept_quote_by_token`/`accept_invoice_by_token` RPCs, and the
`get_invoice_for_approval` field addition) on top of whatever's already
applied - it's additive, nothing existing is dropped.

**3. Set the new secrets and deploy the changed/new Edge Functions**

```powershell
npx supabase secrets set STRIPE_SECRET_KEY=sk_test_your_key_here
npx supabase functions deploy approve --no-verify-jwt
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

(`process-scheduled-comms` also changed - the `cc`/`bcc` support - so
redeploy that too: `npx supabase functions deploy process-scheduled-comms --no-verify-jwt`.)

Then, in the Stripe Dashboard (Developers -> Webhooks -> Add endpoint):

- Endpoint URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook`
- Events to send: `checkout.session.completed`
- Copy the endpoint's "Signing secret" and set it:
  ```powershell
  npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_your_secret_here
  ```

**4. Re-publish the updated approval page**

`supabase/static/approval-page.html` changed (signature pad, Pay Now
button). Per section on quote/invoice digital acceptance further up, this
file is deployed to whichever external static host you chose (Cloudflare
Pages/Netlify/GitHub Pages/etc, **not** Supabase Storage or an Edge
Function - Supabase force-downgrades HTML served from its own shared
domain). Re-deploy the single updated file the same way you did the first
time (e.g. Cloudflare Pages' dashboard: drag the file in to overwrite; a
Git-connected static host: just push this branch/`main` and it redeploys
automatically). No new environment variable is needed - it's the same
file at the same URL, so `VITE_APPROVAL_PAGE_URL`/
`EXPO_PUBLIC_APPROVAL_PAGE_URL` don't change.

**5. Deploy the desktop app**

If it's already connected to Vercel (see "Deploying to Vercel" above),
pushing to `main` on GitHub is enough - Vercel redeploys automatically:

```powershell
git checkout main
git push origin main
```

No new `VITE_*` environment variables are needed for this batch - Stripe
key/secrets live server-side only (Edge Function secrets, not the desktop
app's env).

**6. Rebuild and reinstall the mobile app**

`apps/mobile/eas.json` only has a `development` build profile (internal
APK distribution, no EAS Update/OTA channel configured, no app-store
submission set up) - per section 6, the only supported way this app has
ever reached your phone is installing a fresh development-build APK
directly, not an over-the-air update. The only mobile-visible change in
this batch is the decimal-input fix in `LineItemEditor.tsx`, so rebuild
and reinstall the same way you did the first time:

```powershell
eas build --profile development --platform android
```

Once the build finishes, EAS gives you a download link/QR code - install
it on the phone the same way as the very first development build (see
section 6), replacing the existing app. Everything else in this batch
(client contacts/addresses UI, risk register, signatures, Stripe, email
composer) is desktop-only for now - see "Known gaps" below.

### Known gaps / judgment calls

- **Mobile app has no UI yet for**: client contacts, client addresses
  (add/edit - `client_sites` was already synced read-only for lookups, just
  never had a management screen anywhere), WorkDrive links, the new risk
  register field (mobile has no Reports screens at all - that module is
  desktop-only), or the email composer/free-form job email. Desktop is
  fully wired; extending these to mobile is follow-up work, not done here.
- **Stripe webhook has no automatic retry/reconciliation job** - if the
  webhook delivery fails for some transient reason and Stripe's own
  retries are exhausted, an invoice could show as paid in Stripe but not
  in this app. Worth a periodic reconciliation sweep if this ever becomes
  a real support burden; not built here since it needs real Stripe usage
  to know if it's actually needed.
- **CC/BCC recipients aren't validated as real email addresses** before
  being sent to Resend - a typo'd address in Cc/Bcc fails at Resend's API
  (surfaced as a failed `scheduled_communications` row), not caught in the
  composer itself.
- Everything above was verified by `tsc --noEmit` (clean on both
  `apps/desktop` and `apps/mobile`) and a production `vite build` (clean,
  aside from the pre-existing "chunk larger than 500kB" advisory notice) -
  not against a real deployed Supabase project/Stripe account/Resend
  account, since none exist in this sandbox. Test the signature pad, the
  Stripe payment link end-to-end with a Stripe test card, and the email
  composer's actual send once deployed.

## 35. Xero integration - Phase 1 (one-way push: this app -> Xero)

Connects a tenant's Xero organisation via OAuth2 (Settings screen), then
lets an admin push an individual invoice (creating/reusing its client as a
Xero Contact, creating/updating the matching Xero Invoice) via a "Sync to
Xero" button on Invoice Detail. Deliberately staged as one-way for now -
see the xero-sync function's own comment for why a full two-way sync
(payments recorded in Xero flowing back to mark an invoice paid here) is
Phase 2, not built in this pass.

### What's built

- `xero_connections` - one row per tenant, holding the OAuth2 access/
  refresh tokens for their connected Xero organisation. No RLS policies
  granted to anon/authenticated at all - only the service role (Edge
  Functions) can read/write it directly. The desktop app only ever calls
  `get_xero_connection_status()`/`disconnect_xero()` (SECURITY DEFINER
  RPCs that never expose the tokens themselves).
- `xero_oauth_states` - short-lived CSRF-protection rows for the OAuth
  handshake, same lockdown.
- `clients.xero_contact_id` / `invoices.xero_invoice_id` /
  `invoices.xero_synced_at` / `invoices.xero_sync_error` - the mapping
  and last-sync-result columns.
- `tenants.xero_sales_account_code` - which chart-of-accounts code
  invoice line items post against in Xero, admin-configurable in Company
  Settings (defaults to '200', Xero's standard default AU "Sales" code -
  not guaranteed to match every tenant's actual chart).
- Three new Edge Functions: `xero-oauth-start` (builds the Xero authorize
  URL), `xero-oauth-callback` (public - Xero's own redirect target,
  exchanges the auth code for tokens, stores the connection, redirects
  back to Settings), `xero-sync` (the actual Contact+Invoice push,
  refreshing the access token first if it's near expiry).
- Settings screen: Connect/Disconnect Xero, connection status, sales
  account code field.
- Invoice Detail: "Sync to Xero"/"Re-sync to Xero" button once the
  invoice is past draft, last-synced time, a "View in Xero" link, and any
  sync error inline.

### New Xero Developer app + secrets needed

1. [developer.xero.com](https://developer.xero.com) -> **My Apps -> New
   app** -> **Web app**.
2. **Redirect URI** (must match exactly):
   ```
   https://YOUR-PROJECT-REF.supabase.co/functions/v1/xero-oauth-callback
   ```
3. Once created, on the app's **Configuration** tab, copy the **Client ID**
   and generate/copy a **Client Secret** (shown once only).
4. Set both as Supabase secrets, plus where the OAuth callback should
   redirect the browser back to once it's resolved (your desktop app's
   Settings page):
   ```powershell
   npx supabase secrets set XERO_CLIENT_ID=your_client_id_here
   npx supabase secrets set XERO_CLIENT_SECRET=your_client_secret_here
   npx supabase secrets set XERO_APP_REDIRECT_URL=https://jmssaas.vercel.app/settings
   ```

### Deploy steps

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx supabase db push
npx supabase functions deploy xero-oauth-start
npx supabase functions deploy xero-oauth-callback --no-verify-jwt
npx supabase functions deploy xero-sync
npx vercel --prod
```

(`xero-oauth-start`/`xero-sync` need the caller's own bearer token and
work fine under the platform's default JWT verification, so no
`--no-verify-jwt` for those two - only `xero-oauth-callback`, which Xero
reaches directly with no Supabase session at all.)

Then in Settings, **Connect to Xero**, approve on Xero's consent screen,
and confirm it redirects back showing "Connected to [org name]". Test a
sync on an already-accepted (non-draft) invoice, then check the Contact
and Invoice actually appear in Xero.

### Known gaps / judgment calls

- **One-way only** - nothing here reads anything back from Xero. A
  payment recorded directly in Xero does not mark the invoice paid in
  this app (Stripe payments still do, via the separate stripe-webhook
  function). Phase 2 (a Xero webhook subscription for
  `Invoices.PaymentUpdated` or similar, verified and applied the same way
  stripe-webhook verifies Stripe's signature) would close that loop -
  intentionally not built yet.
- **No automatic sync** - nothing pushes to Xero on invoice status change;
  every sync is a deliberate button click. Worth automating once Phase 1
  has been exercised against a real Xero org without surprises.
- **Contact matching is exact-name-only** - `ensureXeroContact` searches
  Xero by exact contact name before creating a new one, to avoid
  obviously duplicating a business's existing Xero contacts on first
  connect. It won't catch near-duplicates (e.g. "J Smith" in Xero vs
  "John Smith" here) - those would create a second Xero Contact the first
  time that client's invoice is synced.
- **Single Xero organisation** - if the Xero user connecting has access to
  more than one Xero organisation, the callback takes whichever one Xero's
  `/connections` endpoint lists first, with no picker UI. Disconnect and
  reconnect, authorising only the correct organisation on Xero's consent
  screen, if the wrong one gets linked.
- **Quotes are never pushed** - only invoices. Xero does have its own
  Quote object, but this pass only covers the Stripe-adjacent "get money
  in the door" path (invoices), matching how Phase 1 was scoped.
- Not verified against a real Xero organisation, Client ID/Secret, or
  live OAuth round-trip - none of those exist in this sandbox. Verified:
  `tsc --noEmit` clean, a production `vite build` clean, and the Xero REST
  API shapes (Contacts/Invoices/token endpoints, AU tax types OUTPUT/
  EXEMPTOUTPUT) checked against Xero's own public API documentation by
  reading, not by making a live call.

## 36. Xero integration - Phase 2 (payment read-back: Xero -> app)

Closes the loop Phase 1 deliberately left open: a payment recorded
directly in Xero (not through this app's Stripe flow) now flows back and
marks the matching invoice paid here too.

### How it works

Xero webhooks are subscribed once per **app** (not per connected
organisation) in the Developer Portal - every organisation connected to
this app's Xero integration sends events to the same URL. The payload
itself carries no invoice detail, just "this resource changed" -
`xero-webhook` looks up which of this app's tenants owns that Xero
organisation (via `xero_connections.xero_tenant_id`), finds the matching
`invoices` row (via `xero_invoice_id`), fetches the invoice's current
state from Xero's API, and if Xero now shows it `PAID`, marks it paid
here. The existing `set_invoice_paid_at`/`calculate_referral_fee_on_invoice_paid`
triggers then fire exactly as they would for any other paid transition -
nothing Xero-specific needed there.

Signature verification (HMAC-SHA256 over the raw request body, checked
against the `X-Xero-Signature` header) is done by hand, same approach as
`stripe-webhook`. This also transparently handles Xero's "Intent to
Receive" check - the one-time signed, empty-events request Xero sends
when you first save the webhook URL, which just needs a valid signature
and a 200 back.

### Setup

1. developer.xero.com -> your app -> **Webhooks** tab.
2. Under **Invoices**, set the **Delivery URL**:
   ```
   https://YOUR-PROJECT-REF.supabase.co/functions/v1/xero-webhook
   ```
3. Copy the **Webhook key** shown there and set it as a secret:
   ```powershell
   npx supabase secrets set XERO_WEBHOOK_KEY=your_webhook_key_here
   ```
4. Deploy the function, then click **Send Intent to Receive** on the
   Webhooks tab - it should show as verified within a few seconds:
   ```powershell
   npx supabase functions deploy xero-webhook --no-verify-jwt
   ```

### Test it

Mark an invoice paid **directly in Xero** (not via this app's Stripe
link) - find it in Xero, add a payment against it. Within a few seconds
it should flip to **Paid** in this app too. If it doesn't, check the
Xero Developer Portal's Webhooks tab for delivery failures, and this
function's logs in the Supabase dashboard.

### Known gaps / judgment calls

- **Full payment only** - a partial payment in Xero (invoice still
  `AUTHORISED`, `AmountDue > 0`) doesn't change anything here, matching
  this app's own binary paid/unpaid model (see quote-invoice-pdf.ts's own
  comment on Balance Due - there's no partial-payment tracking to update
  even if this function tried).
- **Voided Xero invoices aren't reflected** - only a `PAID` status is
  read back; a `VOIDED` Xero invoice doesn't flip the matching invoice
  here to `void`. Deliberately conservative for this first pass, to
  avoid a Xero-side bookkeeping action having a surprising effect here -
  worth reconsidering once Phase 2 has run for a while without issues.
- **No automatic push on status change** - creating/sending/accepting an
  invoice here still doesn't automatically push to Xero; "Sync to Xero"
  is still a manual click (see Phase 1's own known-gaps note).
- **One bad/malformed event doesn't fail the whole webhook delivery** -
  each event in a batch is processed independently and logged on
  failure, so one lookup miss (e.g. an invoice Xero knows about that this
  app never pushed) doesn't cause Xero to think the endpoint is down and
  retry-storm it.
- Not verified against a real Xero webhook delivery or a real payment
  recorded in a live Xero org - none of those exist in this sandbox.
  Verified: `tsc --noEmit` clean (no frontend changes this pass), and the
  webhook payload shape/signature scheme checked against Xero's own
  public webhook documentation by reading, not a live delivery.

## 37. Job card file upload + email attachments + auto-attached quote/invoice PDFs

Three related additions from the same request:

1. **Job card file upload** no longer restricted to images - the file
   input's `accept="image/*"` was removed and non-image files now render
   as a document icon + filename instead of a broken image tile. No
   backend change needed - `uploadJobPhoto`/the underlying storage bucket
   were already MIME-agnostic; only the desktop UI enforced images.
2. **Email attachments** - `EmailComposeModal` (used by every "send
   email" button in the app) now has an Attachments section: add any
   number of files (10MB each, no running total cap - see the code
   comment on `MAX_ATTACHMENT_BYTES` in `EmailComposeModal.tsx`), remove
   individual ones before sending. Stored as base64 data URIs in a new
   `attachments` jsonb column on `scheduled_communications` (same
   convention as `accepted_signature_svg` - no Storage bucket, since
   these are one-off transactional payloads, not documents the app needs
   to keep re-serving). `process-scheduled-comms` strips the
   `data:...;base64,` prefix and passes the rest straight to Resend's
   `attachments` field.
3. **Auto-attached quote/invoice PDF** - sending a quote or invoice now
   attaches a real PDF of it alongside the existing "view online" link,
   generated on the spot via a new `quote-invoice-pdf-bytes.ts` (jsPDF,
   producing actual bytes with no print-dialog/human-in-the-loop step,
   unlike the existing "Export PDF" button's `quote-invoice-pdf.ts` +
   browser print flow). If PDF generation fails for any reason, the send
   still goes ahead without it - the view-online link alone is enough to
   not block delivery over this.

### Deploy

```powershell
git pull origin main
npx supabase db push
npx supabase functions deploy process-scheduled-comms --no-verify-jwt
npx vercel --prod
```

No new environment variables or secrets - this reuses the existing
`RESEND_API_KEY`/`RESEND_FROM_EMAIL` setup.

### Test it

1. Open a job card with no files yet -> Upload files -> pick a PDF or
   Word doc (not just an image) -> confirm it appears as a file tile with
   its name, and opens/downloads on click.
2. Open a quote or invoice -> Send via Email -> confirm a PDF attachment
   already shows in the Attachments list before you've added anything
   yourself -> add a second file (e.g. a photo) -> send -> confirm the
   recipient's email has both the quote/invoice PDF and your extra file
   attached, plus the usual view-online link in the body.
3. Job card's free-form Email button -> add an attachment -> send ->
   confirm it arrives.

### Known gaps / judgment calls

- **No total-size guardrail** - only a 10MB-per-file cap, no cap on
  total attachments across a single send. Resend's own request-size
  limit (~40MB) is the real backstop; worth adding a running-total check
  later if this ever becomes a real problem in practice, but not before.
- Not verified against a live Resend send with real attachments - none
  of those exist in this sandbox. Verified: `tsc --noEmit` clean for both
  `apps/desktop` and `apps/mobile`, `vite build` succeeds.

## 38. Editable property details + invoice "Bill to" (landlord vs agency)

Two related Real Estate & Strata gaps:

1. **Property details were only ever settable once, at creation.** The
   Property Profile's "Edit" button only covered the Access & Contacts
   tab (landlord/tenant contact, access notes, key tag) - the property's
   own address, agency, property manager, and property type had no edit
   path at all after the "New managed property" form. There's now a
   separate "Edit property" button on the property header that opens an
   "Edit property details" modal covering exactly those fields.
2. **An invoice's recipient was hard-locked to whichever `clients` row
   the job was created against** - for a real-estate job this is usually
   the agency/property manager, with no way to redirect a specific
   invoice to the landlord/owner instead, even though the property record
   already has landlord contact fields. Invoices now have a "Billed to"
   line (shown only for real-estate jobs) with a "Change" link that lets
   you pick Agency/PM (unchanged default) or Landlord/Owner. Once set to
   Landlord, both the emailed PDF's Bill To name/phone/email and the
   composer's default "To" address use the property's
   `owner_landlord_name/_phone/_email` instead of the client's - the job/
   property address itself is unaffected either way. Regardless of this
   toggle, the landlord's and tenant's emails (if on file) are now always
   offered as recipient chips in the composer too, so a one-off send
   doesn't require flipping the persistent setting first.

### Deploy

```powershell
git pull origin main
npx supabase db push
npx vercel --prod
```

No Edge Function changes this pass - just one new `invoices` column
(`bill_to_landlord`) and frontend changes.

### Test it

1. Real Estate & Strata -> open a managed property -> "Edit property" ->
   change the agency, property manager, or address -> Save -> confirm the
   header and the property's entry back on the Real Estate directory both
   reflect the change.
2. Open an invoice for a real-estate job -> confirm a "Billed to" line
   appears under the address with a "Change" link -> click it -> if the
   property has no landlord contact yet, add one first (property's Access
   & Contacts tab) -> come back, choose Landlord/Owner -> Save -> confirm
   the "Billed to" line now shows the landlord's name, "Send Invoice via
   Email" prefills their email address, and "Export PDF" shows their name/
   contact details in the Bill To box instead of the agency contact's.
3. Switch it back to Agency/PM -> confirm everything reverts to the
   previous (pre-existing) behaviour exactly.

### Known gaps / judgment calls

- **No address override for the landlord** - `properties` only has
  `owner_landlord_name/_phone/_email`, no separate mailing address, so
  the Bill To address line always stays the job/property address
  regardless of who's being billed. Reasonable as-is (the property being
  serviced is still the property being serviced), but worth knowing if a
  landlord ever needs invoices posted somewhere else entirely.
- **The Stripe payment/approval link and Xero sync are untouched** - both
  still use the invoice's `clients` row exclusively; `bill_to_landlord`
  only affects the emailed PDF and the composer's default recipient.
  Redirecting the actual payment/approval flow to the landlord would be a
  much bigger change (it has no `clients` row of its own to authenticate
  against) and wasn't asked for here.
- Not verified against a live property edit or a live invoice send in
  this sandbox (no deployed Supabase project to test against). Verified:
  `tsc --noEmit` clean for both `apps/desktop` and `apps/mobile`,
  `vite build` succeeds.

## 39. Retrofit an existing job/quote/invoice as a real estate / strata job

`is_real_estate_job`/`agency_id`/`property_manager_id`/`property_id`/
`work_order_number`/`nte_limit_cents` all live on `job_cards` and were
previously only ever settable once, at creation, via the "New job" form's
checkbox + Agency/PM/Property pickers - there was no way back in if a job
was created as an ordinary job and only later turned out to be agency
work (or the wrong agency/PM/property was picked at the time).

New shared `RealEstateAssignmentModal` component (same cascading Agency ->
PM -> Property picker as the "New job" form) is now mounted on all three
detail pages, each writing to the same underlying `job_cards` row:

- **JobDetail.tsx** - a "Mark as real estate / strata job" button sits
  between the client/address card and the WorkDrive section (as asked),
  or an "Edit" link inside the existing blue "Agency Job" info box once
  it's already set.
- **QuoteDetail.tsx** / **InvoiceDetail.tsx** - neither page has a
  WorkDrive section, so the equivalent control sits directly under "Edit
  address" instead: "Mark as real estate / strata job", or "Real estate /
  strata job - {Agency} · Edit" once set. Only shown when the quote/
  invoice is actually linked to a job (`job_card_id` isn't null) - there's
  no job_cards row to write to otherwise. Since quotes/invoices already
  read these fields live via their join to `job_cards` (QuoteDetail's own
  join was extended this pass to match InvoiceDetail's pre-existing one),
  setting this from any of the three pages immediately shows up on the
  other two once you're on them too - it's genuinely one shared setting,
  not three separate ones.

### Deploy

```powershell
git pull origin main
npx vercel --prod
```

No database changes this pass - `job_cards` already had every column
this needs; this is purely a missing-UI fix.

### Test it

1. Create (or find) an ordinary job with no agency attached -> open it ->
   confirm "Mark as real estate / strata job" appears between the address
   card and WorkDrive -> click it -> pick an agency/PM/property -> Save ->
   confirm the blue "Agency Job" box now appears with an "Edit" link.
2. Open a quote or invoice linked to that same job -> confirm it now
   shows "Real estate / strata job - {Agency}" under the address (no page
   reload needed if you navigated there fresh) -> click Edit -> change
   the property -> Save -> go back to the job page and confirm it updated
   there too.
3. Open a quote/invoice NOT linked to any job -> confirm no real-estate
   control appears at all (nothing to attach it to).

### Known gaps / judgment calls

- **Unchecking the box clears agency/PM/property/work order/NTE limit**,
  same as leaving them blank on the "New job" form - there's no
  "temporarily hide but remember" state, matching how the field always
  behaved at creation time.
- Not verified against a live deploy in this sandbox. Verified:
  `tsc --noEmit` clean for both `apps/desktop` and `apps/mobile`,
  `vite build` succeeds.

## 40. Dedicated "Work order #" quick-edit

Section 39's `RealEstateAssignmentModal` already let a work order number
be set (it's one of the fields alongside Agency/PM/Property), but reaching
it meant opening the full agency-reassignment modal just to change one
number - the actual blocker reported: an agency with
`require_work_order_num` set blocks sending an invoice
(`agencyComplianceError` in InvoiceDetail.tsx) until a work order number
exists, and the fastest fix wasn't obvious from that error message alone.

New single-field `WorkOrderNumberModal` (same minimal text-field-plus-Save
shape as the existing WorkDrive link modal) is now mounted on all three
pages, each showing a "Work order #: {value or 'Not set'} - Edit/+ Add"
line:

- **InvoiceDetail.tsx** - the line sits right under "Billed to"; the
  `agencyComplianceError` red banner itself also grew an inline "Add it
  now" button so hitting the block and fixing it is immediate, no need to
  first find the quick-edit line above it.
- **QuoteDetail.tsx** - same line, under the "Real estate / strata job"
  line (quotes don't enforce the compliance check, but can still record
  the number).
- **JobDetail.tsx** - the existing "Work order: {value}" text in the blue
  Agency Job box gained its own Edit/+ Add link, instead of only being
  reachable via that box's "Edit" link into the full assignment modal.

All three write straight to the same `job_cards.work_order_number` - no
schema change.

### Deploy

```powershell
git pull origin main
npx vercel --prod
```

### Test it

1. Open a real-estate invoice with no work order number set, for an
   agency that requires one -> confirm the red compliance banner has an
   "Add it now" button -> click it -> type a number -> Save -> confirm
   the banner disappears and "Send Invoice via Email" is no longer
   blocked.
2. Same on a quote -> confirm the "Work order #" line lets you set/edit
   it even though nothing blocks sending a quote without one.
3. Set it from the invoice, then check the job page and the quote (if
   any) - confirm the same number shows up everywhere, since it's one
   shared field.

### Known gaps / judgment calls

- Not verified against a live deploy in this sandbox. Verified:
  `tsc --noEmit` clean for both `apps/desktop` and `apps/mobile`,
  `vite build` succeeds.

## 41. "Insert link" button for automation templates and the email composer

Raw HTML already worked in any email body - `process-scheduled-comms`'s
`sendEmail` renders the body as HTML (`html: body.replace(/\n/g, "<br>")`),
so a hand-typed `<a href="...">text</a>` always rendered as a real
clickable link. The gap was needing to type HTML tags by hand. New shared
`InsertLinkButton` (select some text, click it, paste a URL, defaults to
`https://` if you leave the scheme off) is now wired into:

- **Settings > Automation & Messaging**'s template editor, next to the
  existing "Insert tag" token buttons.
- **`EmailComposeModal`** - the one compose popup reused by every "send
  email" action in the app (quote, invoice, job card's free-form email),
  so this covers "every other place" in one shot rather than needing a
  per-page change.

`TextAreaField` (`FormField.tsx`) gained `forwardRef` support (needed so
`InsertLinkButton` can read cursor position / wrap a selection) and a new
`labelHidden` prop (keeps the `<label>`/`htmlFor` association for
accessibility without rendering visible text, since EmailComposeModal
renders its own "Body" label alongside the button) - both purely additive,
every existing caller is unaffected.

### Deploy

```powershell
git pull origin main
npx vercel --prod
```

No database changes - this only touches how text gets typed into fields
that already existed.

### Test it

1. Settings > Automation & Messaging -> edit any email template -> select
   some existing text (or place the cursor) -> click "🔗 Insert link" ->
   fill in link text + a URL without `https://` -> Insert -> confirm the
   `<a href="https://...">` tag lands in the body and the URL got the
   scheme auto-added.
2. Save that template, trigger the automation (or just open a quote/
   invoice and use "Send via Email" with that template) -> confirm the
   received email has a real clickable link, not literal `<a>` text.
3. Open any "send email" popup (job card's free-form email is the
   quickest) -> same Insert link flow -> confirm it works identically
   there.

### Known gaps / judgment calls

- No rich-text/WYSIWYG editor - the body field is still plain text with
  raw HTML in it; this button only saves typing the `<a>` tag by hand,
  it doesn't add bold/italic/etc. Consistent with the rest of this app's
  "type markup into a plain field" approach (see the reminder-ladder
  templates' own styled `<a>` button links).
- Not verified against a live deploy or a real sent email in this
  sandbox. Verified: `tsc --noEmit` clean for both `apps/desktop` and
  `apps/mobile`, `vite build` succeeds.

## 42. Standalone field-use Android build (no Play Store)

`eas.json` previously only had a `development` build profile
(`developmentClient: true`) - installable without the Play Store, but it
needs a Metro dev server running on a nearby machine that the phone can
reach (same Wi-Fi, USB, or a tunnel) every time the app is opened. Fine
for active development, not for actually taking the app to a job site.

New `preview` profile: same internal-distribution installable `.apk`, but
without `developmentClient` - the JS bundle is built into the app itself,
so once installed it runs completely standalone and just needs normal
internet access to reach Supabase/PowerSync, exactly like a Play-Store
install would, minus the Play Store.

### Build and install it (once)

```powershell
cd apps/mobile
copy .env.example .env
notepad .env
```
Fill in `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
`EXPO_PUBLIC_POWERSYNC_URL`, `EXPO_PUBLIC_APPROVAL_PAGE_URL` with the
same live project values apps/desktop already uses (see docs/SETUP.md's
earlier Supabase/PowerSync setup sections for where to find them).

```powershell
npx eas login
npx eas build --profile preview --platform android
```
This builds in Expo's cloud (no local Android Studio needed) - takes a
few minutes, then prints a QR code and a download link. Scan it (or open
the link) on the Pixel, allow "install from unknown sources" when
prompted, and install the `.apk`.

### The Google Maps key gotcha

The roof-measurement tool's satellite map needs
`GOOGLE_MAPS_API_KEY_ANDROID` - this one is native-only (baked into
`AndroidManifest.xml` at build time by `app.config.js`, never read from
the JS bundle), so it is **not enough** to have it in local `.env` -
`eas build` runs on Expo's servers, which never see your local file.
Register it as an EAS secret once:
```powershell
npx eas env:create --name GOOGLE_MAPS_API_KEY_ANDROID --value "your-key" --visibility sensitive --environment preview
```
(create an API key first at console.cloud.google.com/google/maps-apis,
enable "Maps SDK for Android", restrict it to package name
`au.bingley.jmssaas`). Without this, the app still works - just the
satellite map on the measurement screen won't load.

### After that first install

Ordinary app changes (anything in `apps/mobile` that isn't a new native
dependency) don't need a rebuild - PowerSync/Supabase data syncs live
over the network the same way the desktop app does. A rebuild is only
needed again if a new native module gets added later (a new `expo-*`
package, a new native permission, etc.) - the same trigger that would
require a Play Store update for a normal app.

### Known gaps / judgment calls

- No EAS Update/OTA channel configured - a JS-only change still needs a
  full rebuild + reinstall via this same flow, there's no
  push-an-update-without-reinstalling path yet. Worth adding later if
  iteration speed in the field becomes a problem.
- Not verified against a real EAS build or a real Pixel install in this
  sandbox (no Expo account/EAS credentials here). Verified: `eas.json`
  is valid JSON and matches the shape of the existing `development`
  profile it sits alongside.

## 43. Mobile feature parity, part 1: WorkDrive link, work order number, real estate assignment retrofit

First installment of closing the desktop/mobile feature gap (see the
"what's missing on mobile" comparison from this same conversation) - the
three smallest, highest-value gaps, all living on the job detail screen
(`apps/mobile/app/(tabs)/sales/jobs/[id].tsx`) and all writable through
PowerSync since `job_cards` was already offline-synced with every column
these need except one:

- **`workdrive_url`** was missing from the PowerSync schema entirely
  (`packages/shared/src/powersync/schema.ts`) even though the Postgres
  column has existed since section 7's WorkDrive feature - added now.
  `powersync/sync-rules.yaml` needed no change since its `job_cards`
  bucket already uses `select *`.
- **Work order number** was already synced but read-only on mobile
  (`is_real_estate_job`/`agency_id`/`work_order_number`/etc. were all
  already in the schema and displayed) - now editable via the same modal
  as the real estate assignment below.
- **Real estate assignment retrofit** - mirrors desktop's
  `RealEstateAssignmentModal`: a toggle plus cascading Agency -> Property
  Manager -> Property pickers (using the existing `PickerModal`
  component), reusing the same `updateJobRealEstateAssignmentSchema` from
  `packages/shared` that desktop's version validates against. Agencies/
  property managers/properties aren't PowerSync tables (office/PC-side
  data per the schema's own Phase 1 scope comment), so the picker lists
  are fetched directly via `useSupabaseFetch` the same way this screen
  already fetches the job's own single agency/PM/property record.

### Deploy

No new migration - `workdrive_url` already exists in Postgres. Rebuild
the mobile app (schema.ts changed, which affects the local SQLite schema
PowerSync generates) and redeploy desktop:
```powershell
git pull origin main
npx vercel --prod
cd apps/mobile
npx eas build --profile preview --platform android
```

### Test it

1. Open a job with no agency assigned -> confirm "Mark as real estate /
   strata job" appears, and a WorkDrive "+ Add link" row sits right below
   the client card.
2. Tap "Mark as real estate / strata job" -> toggle on -> pick an agency,
   PM, property, type a work order number -> Save -> confirm the blue
   "AGENCY JOB" card now shows with an "Edit" link, and tapping the work
   order line reopens the same modal.
3. Add a WorkDrive link -> confirm it persists after backgrounding/
   reopening the app (still offline-cached via PowerSync).

### Known gaps / judgment calls

- Not verified against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile`, `apps/desktop`, and
  `packages/shared`.

## 44. Mobile feature parity, part 2: invoice "Bill to" (landlord vs agency)

Mirrors desktop's `bill_to_landlord` control (section 29) on
`apps/mobile/app/(tabs)/sales/invoices/[id].tsx`. Invoices are a
Supabase-direct/office-workflow screen on mobile (not PowerSync-synced,
per the schema's own Phase 1 scope comment), so this needed no local
schema change - just extending the existing `job_cards` join to include
`is_real_estate_job`/`agency_id`/`property_id` (previously only `title`
was selected) and fetching `agency`/`property` the same way
`jobs/[id].tsx` already does.

- A "Billed to: {Agency (Client)} - Change" line appears under the Job
  link for real-estate invoices, opening a centered modal with the same
  two Agency/PM vs Landlord/Owner options as desktop.
- `apps/mobile/lib/pdf.ts`'s `buildInvoicePdfHtml`/`renderBillTo` gained
  the same `agencyBilling` shape desktop's `quote-invoice-pdf.ts` has, so
  "Export PDF" reflects the chosen recipient's name/phone/email.
- `handleSendInvoiceEmail`'s recipient resolution now checks
  `bill_to_landlord` + `property.owner_landlord_email` before falling
  back to the client's email, with a clear error if the toggle is on but
  no landlord email is on file yet.

### Deploy

No migration - `invoices.bill_to_landlord` already exists in Postgres
(section 29's migration). Redeploy both apps:
```powershell
git pull origin main
npx vercel --prod
cd apps/mobile
npx eas build --profile preview --platform android
```

### Test it

1. Open a real-estate invoice on mobile -> confirm "Billed to: ..." shows
   under the Job link -> tap it -> switch to Landlord/Owner -> confirm
   the line updates.
2. Export PDF -> confirm the Bill To box shows the landlord's name/
   contact instead of the agency's.
3. Send Invoice via Email -> confirm it error-prompts correctly if no
   landlord email is on file, and sends to the landlord's email once one
   exists.

### Known gaps / judgment calls

- Setting the landlord's own contact details (name/phone/email) is still
  desktop-only (Property Profile's Access & Contacts tab) - this section
  only adds the ability to *choose* landlord billing on mobile, not to
  enter the landlord's details there too. That gap closes in the next
  installment (the full Real Estate & Strata module on mobile).
- Not verified against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile` and `apps/desktop`.

## 45. Mobile feature parity, part 3: client contacts, addresses, company/individual type

Closes the biggest of the remaining "read-only lookup, no management UI"
gaps: `client_sites` was already PowerSync-synced but had no add/edit
screen anywhere on mobile, and `client_contacts` wasn't synced at all.

- **`client_contacts` added to the PowerSync schema and sync rules** -
  same tenant-wide read/write shape as `clients`/`client_sites` (see the
  migration's own RLS), so it joins the same `tenant_reference_data`
  bucket in `powersync/sync-rules.yaml`.
- **`clients.client_type`/`company_name`/`workdrive_url`** were also
  missing from the PowerSync schema entirely (added after the rest of
  that table) - added now, and the mobile "Edit client" modal gained the
  same company/individual toggle + company name field desktop has.
  (`workdrive_url` itself doesn't have new UI here - clients don't have a
  WorkDrive control on desktop either, only job cards do - just closing
  the schema gap so the column round-trips if it's ever set elsewhere.)
- **New "Contacts" and "Addresses" sections** on
  `apps/mobile/app/(tabs)/sales/clients/[id].tsx`, above the Jobs list -
  add/edit/delete for both, validated against the same shared
  `createClientContactSchema`/`createClientSiteSchema` desktop uses.

### Deploy

No new migration - every column here already exists in Postgres, this
was purely a PowerSync-schema and mobile-UI gap. Rebuild mobile (schema
change) and redeploy desktop:
```powershell
git pull origin main
npx vercel --prod
cd apps/mobile
npx eas build --profile preview --platform android
```
Also re-upload `powersync/sync-rules.yaml` via the PowerSync dashboard
(Instance > Sync Rules) - it changed in this pass (added `client_contacts`)
and dashboard sync rules aren't picked up automatically from the repo.

### Test it

1. Open a client -> toggle "Company client" on in Edit -> set a company
   name -> Save -> confirm the client header now shows the company name
   as the title with the contact person's name below it.
2. Add a contact -> mark it primary -> confirm it appears at the top of
   the Contacts list -> tap it -> Delete -> confirm it's gone.
3. Add a second address -> confirm both show under Addresses, and the
   client header's own single address line is unaffected (that's still
   `clients.address_line1` etc., unrelated to `client_sites`).
4. Background/reopen the app -> confirm contacts/addresses are still
   there (offline-cached via PowerSync, not re-fetched from Supabase).

### Known gaps / judgment calls

- The client header's own single address (`clients.address_line1` etc.)
  and the new Addresses list (`client_sites`) are two separate concepts,
  same as on desktop - editing one never touches the other.
- Not verified against a real device/EAS build or a real PowerSync sync
  rules re-upload in this sandbox. Verified: `tsc --noEmit` clean for
  `apps/mobile`, `apps/desktop`, and `packages/shared`.

## 46. Mobile feature parity, part 4: generic job/task file upload

`components/PhotoAttachments.tsx` was strictly photo-only (camera +
image library) even though the underlying `job_files`/`task_files`
tables and Storage buckets were already MIME-agnostic - the same gap
desktop had before its own generic-upload fix, closed the same way:
non-image files render as a document icon + filename instead of a
(impossible) thumbnail.

- New `expo-document-picker` dependency (any file type, not just
  images) - reads the picked file back off disk as base64 via
  `expo-file-system/legacy` (matching the encoding pattern
  `lib/attachments.ts` already uses) and hands it to the same
  `addJobPhoto`/`addTaskPhoto` PowerSync functions photos already use -
  those were always MIME-agnostic themselves, only this component
  enforced images.
- `jobs/[id].tsx`/`tasks/[id].tsx`'s file queries now also select
  `file_name`/`mime_type` (previously only `id`/`local_uri`, enough for
  a photo thumbnail but not enough to know what a non-image file even
  is), threaded through to the component's extended
  `PhotoAttachmentItem` type.
- Same filename limitation desktop's own generic upload already has -
  the stored `file_name` is a generated `<uuid>.<ext>`, not the original
  picked filename, on both platforms equally, not a mobile-specific
  regression.

### Deploy

New native module (`expo-document-picker`) - this needs a fresh EAS
build, a JS-only redeploy isn't enough:
```powershell
git pull origin main
cd apps/mobile
pnpm install
npx eas build --profile preview --platform android
```

### Test it

1. Open a job -> Files section -> "Attach file" -> pick a PDF or Word
   doc (not a photo) -> confirm it appears as a document-icon tile with
   its picked filename, and tapping it opens/downloads it.
2. Confirm "Take photos"/"Choose photos" still work exactly as before
   (no regression to the existing photo flow).
3. Same on a task's Files section.

### Known gaps / judgment calls

- Not verified against a real device/EAS build in this sandbox (no
  Expo/EAS credentials here). Verified: `tsc --noEmit` clean for
  `apps/mobile` and `apps/desktop` after `pnpm install` pulled in the
  new dependency.

## 47. Mobile feature parity, part 5: Real Estate & Strata module

Mobile previously only showed a job's already-assigned agency/PM/
property read-only (`jobs/[id].tsx`'s blue "AGENCY JOB" card) - there
was no way to browse the agency/PM/property directory, create new ones,
or edit a property's landlord/tenant contact details from the field at
all, which also meant the landlord contact "Bill to landlord" (part 2)
and real estate assignment retrofit (part 1) needed had nowhere to be
entered without switching to desktop.

New `apps/mobile/app/real-estate/` route group (reached from Settings >
Real Estate & Strata, admin-only same as the other Settings items):

- **`index.tsx`** - directory: expandable Agency -> Property Manager ->
  Property list, "+ Agency"/"+ Property manager"/"+ Property" actions.
  Mirrors desktop's `RealEstate.tsx` Directory tab exactly (same
  cascading create flow); its Key Management and Recurring Maintenance
  dashboard tabs are NOT ported - the field-relevant slice of key
  tracking (pickup/in-van/return per job) already exists on
  `jobs/[id].tsx`, and a tenant-wide dashboard of it is a lower-value
  office/admin screen, left desktop-only for now.
- **`[id].tsx`** - property profile: Access & Contacts (landlord/tenant/
  access notes/key tag, editable) plus an "Edit property" action
  (address/agency/PM/type), mirroring `PropertyDetail.tsx`. Asset
  Register and Job & Compliance History tabs aren't ported (same
  scope call, lower field value than the contact/billing information
  this session's earlier parts actually needed).

All Supabase-direct (office/PC-side data, same `useSupabaseFetch`
pattern as quotes/invoices/automation-settings) - no PowerSync schema or
sync-rules change needed.

### Deploy

No migration, no new native module - a straight redeploy of both apps
covers this:
```powershell
git pull origin main
npx vercel --prod
cd apps/mobile
npx eas build --profile preview --platform android
```

### Test it

1. Settings > Real Estate & Strata -> "+ Agency" -> create one -> expand
   it -> "+ Add property manager" -> create one -> "+ Add property" ->
   create one -> confirm it appears nested under the right PM.
2. Tap the property -> "Edit" (Access & Contacts) -> set a landlord name/
   email -> Save -> confirm it shows on the property page.
3. Go create/open an invoice for a job linked to that property (part 1's
   real estate assignment retrofit, part 2's Bill to control) -> confirm
   "Billed to: Landlord/Owner" now shows the name/email just entered,
   closing the loop between all five parts of this pass.

### Known gaps / judgment calls

- Asset Register and Job & Compliance History (desktop's other two
  Property Profile tabs) aren't ported - can follow later if actually
  needed in the field; Access & Contacts was the piece the rest of this
  pass's features depended on.
- Key Management / Recurring Maintenance dashboards aren't ported - see
  above, both are office/admin-facing summary views, not field actions.
- Not verified against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile` and `apps/desktop`.

## 48. Mobile feature parity, part 6: Stripe payment links

Mirrors desktop's `InvoiceDetail.tsx` payment-link card - shown once an
invoice's approval status is "accepted" and it isn't paid yet. Same
`approve` Edge Function call (`action: "create_payment_link"`); once a
`stripe_checkout_url` exists on the invoice, mobile offers "Open payment
page" (`Linking.openURL`) and "Share link" (`Share.share`) instead of
desktop's "Open"/"Copy link" - copying to clipboard isn't the natural
mobile action, sharing straight to a messaging app is.

### Deploy

No migration, no Edge Function change - `approve` already supports this
action from any caller with a valid session token.
```powershell
git pull origin main
cd apps/mobile
npx eas build --profile preview --platform android
```

### Test it

Accept a quote/invoice via its approval link (or mark one accepted
directly) -> open it on mobile -> confirm the green Stripe payment link
card appears -> generate the link -> confirm "Open payment page" and
"Share link" both work.

### Known gaps / judgment calls

- Not verified against a real device/EAS build or live Stripe checkout
  in this sandbox. Verified: `tsc --noEmit` clean for `apps/mobile`.

## 49. Mobile feature parity, part 7: Xero integration

Mirrors desktop's Xero connect/disconnect (Settings) and "Sync to Xero"
(InvoiceDetail.tsx) - same RPCs and Edge Functions, no backend changes.

- **`company-settings.tsx`** gained a Xero card: connection status (via
  `get_xero_connection_status` RPC), Connect/Disconnect, and the Xero
  sales account code field (`xero_sales_account_code` was already in
  `updateCompanySettingsSchema` and on `tenants`, mobile's form just
  never included it).
- **`invoices/[id].tsx`** gained the same "Sync to Xero"/"Re-sync to
  Xero" card desktop has, shown once an invoice leaves draft status.

The one real platform difference: connecting opens the OAuth flow via
`Linking.openURL` in the device's browser (no in-app webview flow here),
and `xero-oauth-callback`'s redirect target is a fixed, server-configured
URL pointing at the desktop web app's Settings page - not
platform-aware. A mobile-initiated connect finishes visibly in the
phone's browser landing on the web app, not back in this native screen
automatically. Since it's one Xero connection per tenant either way,
`company-settings.tsx` refetches Xero status on screen focus
(`useRefetchOnFocus`), so returning to the app after finishing in the
browser picks up the result without needing a custom URL scheme/deep
link back into the app - a real, disclosed limitation rather than a
broken flow, and a reasonable trade against building full deep-linking
OAuth return support for a connect-once admin action.

### Deploy

No migration, no Edge Function change - `xero-oauth-start`, `xero-sync`,
`get_xero_connection_status`, and `disconnect_xero` already exist and
already work for any caller with a valid session token.
```powershell
git pull origin main
cd apps/mobile
npx eas build --profile preview --platform android
```

### Test it

1. Settings > Company Details -> Xero card -> "Connect to Xero" -> confirm
   the device browser opens Xero's consent screen -> approve it -> land
   on the (desktop) web app's Settings page confirming connection ->
   switch back to the native app -> confirm the Xero card now shows
   "Connected to {org}" (may need to leave and re-enter the screen once
   if it doesn't refresh immediately).
2. Open an invoice that's been sent -> confirm the blue Xero card appears
   -> "Sync to Xero" -> confirm it shows "Last synced" + a working "View
   in Xero" link afterward.

### Known gaps / judgment calls

- OAuth connect finishing in the phone's browser rather than
  automatically returning to the native app - see above.
- Not verified against a real device/EAS build or a live Xero OAuth flow
  in this sandbox. Verified: `tsc --noEmit` clean for `apps/mobile` and
  `apps/desktop`.

## 50. Mobile feature parity, part 8: editable email composer, attachments, and the job "Email" button

Brings mobile's quote/invoice/job email sending up to the same "open an
editable composer" model desktop already has (see section 41's "Insert
link" work and the earlier attachments work in section 37), replacing
the old one-tap "send the raw template" buttons.

- **New `components/EmailComposeModal.tsx`** - a full-screen RN `Modal`
  version of desktop's `EmailComposeModal.tsx`: To (with a tappable
  recipient-suggestions list from `recipientOptions`), collapsible
  Cc/Bcc, Subject, Body with an "Insert link" action (tracks the text
  input's selection range and splices `<a href="...">text</a>` at the
  cursor, same as desktop), an attachments list, and Send. Attachments
  can be added from the photo library (`expo-image-picker`, already a
  dependency) or from files (`expo-document-picker`, newly added to
  `apps/mobile/package.json`), both read to base64 via
  `expo-file-system/legacy` and capped at 10 MB each - oversized picks
  show an inline error instead of silently failing on send. An optional
  `templates` prop reuses `PickerModal` for template selection, matching
  desktop's dropdown.
- **`lib/print.ts`** gained `buildPdfDataUri()`, a `printToFileAsync`
  variant that returns a base64 PDF data URI instead of opening the
  share sheet - used to auto-attach the quote/invoice PDF to the
  composer's default attachments, exactly like desktop's
  `queueAndSendEmail` auto-attach behaviour.
- **`quotes/[id].tsx`** and **`invoices/[id].tsx`**: the old one-shot
  "Send Quote/Invoice via Email" handlers were split into `openSendEmail`
  (looks up the enabled communication rule/template, renders the
  default subject/body, builds and attaches the PDF, opens the modal)
  and `handleSendEmail` (the modal's `onSend` - inserts the
  `scheduled_communications` row with the edited to/cc/bcc/subject/
  body/attachments, calls `triggerImmediateDispatch`, marks the
  document "sent"). Recipient suggestions come from a new
  `client_contacts` Supabase fetch combined with the client's own email
  via `collectRecipientEmails` (same helper desktop uses).
- **`jobs/[id].tsx`** gained the free-form "Email" button desktop's
  `JobDetail.tsx` has (section 12) - previously mobile had no equivalent
  at all. It uses `entity_type: 'job'` / `trigger_key: 'manual_email'`
  like desktop, and - unlike this screen's other `scheduled_communications`
  writes (the On The Way/Review Request queueing, which insert straight
  into the local PowerSync table so they queue while offline) - goes
  directly to Supabase, because `cc_emails`/`bcc_emails`/`attachments`
  aren't columns in the local PowerSync schema (`packages/shared/src/
  powersync/schema.ts` only mirrors what every other feature needs).
  Sending a free-form job email therefore needs connectivity, same
  disclosed trade-off as `handleRequestNteVariation` on the same screen.

No schema or sync-rules changes - `client_contacts` was already synced
(section 45) and `scheduled_communications` was already a PowerSync
table.

### Deploy
```powershell
git pull origin main
cd apps/mobile
pnpm install
npx eas build --profile preview --platform android
```

### Test it

1. Open a quote or invoice with a client that has an email on file ->
   "Send ... via Email" -> confirm the composer opens pre-filled with
   the rendered subject/body and the PDF already attached -> edit the
   body, add a Cc, tap "Insert link" and confirm it inserts at the
   cursor -> Send -> confirm it lands in the Communication Log.
2. Attach a photo and a document from the Attachments row, confirm both
   show in the list and can be removed before sending.
3. Open a job card -> tap "Email" near the title -> confirm the same
   composer opens (blank, no template) -> send to a manually-entered
   address.
4. Try the job "Email" button while offline -> confirm it surfaces "needs
   an internet connection" inside the composer rather than silently
   queuing (unlike the On The Way/Review Request buttons on the same
   screen, which do queue offline).

### Known gaps / judgment calls

- Job free-form email requires connectivity (see above) - a real,
  disclosed asymmetry against the rest of the job screen's messaging,
  not an oversight.
- Not tested against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile`, `apps/desktop`, and
  `packages/shared`.

## 51. Mobile feature parity, part 9: Reports & Safety Documentation Engine

Ports desktop's SafetyCulture-style dynamic form builder + runner (SWMS,
JSAs, inspections) to mobile. Like Real Estate & Strata (section 47),
`report_categories`/`report_subcategories`/`report_templates`/
`report_instances`/`report_signatures` aren't PowerSync tables - the
`reports_safety_engine` migration's RLS makes insert/update/delete on all
five **admin-only** for every tenant member (same scope decision the
migration made for agencies/referral_partners), so there's no offline
field-technician write path to support even on desktop today. This is
therefore a Supabase-direct, connectivity-gated port, not a new PowerSync
table - no `schema.ts` or `sync-rules.yaml` changes, and no new migration
(the `report-files` storage bucket already exists).

- **New `app/reports/` route group** (registered in `app/_layout.tsx`,
  linked from Settings > Reports & Safety, admin-gated the same way
  Real Estate & Strata is):
  - **`index.tsx`** - the three sub-tabs from `Reports.tsx`: New Report
    (browse templates by category -> subcategory, tap to insert a draft
    `report_instances` row and open it), Report History (every instance,
    status badge, "Link to Job" for standalone reports), Template Studio
    (category/subcategory CRUD tree - the template body itself opens in
    its own screen, same "too complex for a modal" call desktop made).
  - **`template/[id].tsx`** - the section/field form builder (`id="new"`
    for a new template). Same seven field types, up/down reordering (no
    drag-and-drop), required/"fail requires action+photo" toggles as
    desktop's `ReportTemplateEditor.tsx`.
  - **`instance/[id].tsx`** - the form runner: renders every field type
    (pass/fail, a repeatable risk-matrix hazard register scored via the
    shared `calculateRiskRating`, photo, text/long text/meter reading,
    signature), a draft-only edit lock once completed, GPS best-effort
    capture on complete (`expo-location`, never blocks completion), PDF
    compile + upload, and the SWMS worker sign-off roster.
- **New `components/SignaturePad.tsx`** - there's no `<canvas>` in React
  Native, so this is a from-scratch touch equivalent to desktop's
  canvas-based `SignaturePad.tsx`: `PanResponder` tracks touch points
  into an SVG `Path` (new `react-native-svg` dependency), then
  `react-native-view-shot` (new dependency) rasterizes the drawn strokes
  to a PNG data URI on release - same output shape (a base64 PNG data
  URI) desktop's `canvas.toDataURL("image/png")` produces, so
  `report_signatures.signature_svg_data` / a signature answer's
  `svgData` need no format change between platforms. Unlike desktop, an
  existing signature shows as a static preview rather than a live canvas
  new strokes get added on top of - clearing and re-signing is the way
  to change it, a deliberate simplification.
- **`buffer` dependency** (added to `apps/mobile/package.json`, nothing
  in this app's own code imports it) - `react-native-svg`'s
  `fetchData.ts` (a remote/data-URI SVG loading helper this app never
  actually uses, just `<Svg>`/`<Path>`) does `import { Buffer } from
  "buffer"`, one of the handful of Node core modules Metro doesn't
  polyfill by default. Without this package physically present in
  `node_modules`, Metro's bundler fails outright with "Unable to
  resolve module buffer" - not a warning, a hard build failure (`pnpm
  expo export:embed` exits 1), caught only when actually running an EAS
  build, since `tsc --noEmit` doesn't touch Metro's module graph at
  all. Confirmed fixed by reproducing the exact failing command
  (`npx expo export:embed --eager --platform android --dev false`)
  locally and rerunning it clean after adding the dependency.
- **New `lib/report-pdf.ts`** - `uploadReportPhoto()` (mirrors desktop's
  `uploads.ts`, uploads to the `report-files` bucket at
  `<tenant>/<instance>/<uuid>.<ext>`) and `buildReportPdfHtml()`, an HTML
  builder for `expo-print` (matching this app's existing quote/invoice
  PDF approach - see `lib/pdf.ts`/`lib/print.ts` - rather than porting
  desktop's `jsPDF`-based `report-pdf.ts`, since mobile already had the
  HTML+`expo-print` pipeline built for quotes/invoices and section 50's
  email composer). Report photos referenced by storage path get resolved
  back to data URIs at compile time via `supabase.storage.download()`
  (same technique `lib/attachments.ts` already uses for job file
  downloads); signature answers embed their data URI directly, no
  re-fetch needed.
- **`jobs/[id].tsx`** gained the "Reports & Safety" card desktop's
  `JobDetail.tsx` has: linked reports list, admin-only "+ Create New
  Report" (template search picker, pre-linked to the job) and "Link
  Existing Report" (picker over unlinked standalone instances).

### Deploy
```powershell
git pull origin main
cd apps/mobile
pnpm install
npx eas build --profile preview --platform android
```

### Test it

1. Settings > Reports & Safety > Template Studio -> add a category and
   subcategory -> "+ New template" -> add a section with one of each
   field type, mark one required, save.
2. New Report tab -> find the template -> tap it -> confirm a draft
   report opens. Answer the required field, add a risk matrix hazard row
   and confirm the rating badge updates live as likelihood/consequence
   change, attach a photo, sign a `signature` field.
3. Tap "Complete report" -> confirm it locks to read-only, a PDF gets
   generated, and "Download PDF"/"Send via Email" appear.
4. Open a job card -> "Reports & Safety" -> "+ Create New Report" ->
   confirm the new instance is pre-linked to the job; separately, create
   a standalone report from the Reports tab and "Link Existing Report"
   it to a job afterward.
5. For an `is_swms` template, confirm the Worker Sign-Off Roster section
   appears and multiple workers can each add a name + signature.

### Known gaps / judgment calls

- Read access follows the same admin-gated Settings entry as Real Estate
  & Strata; RLS itself allows any tenant member to *read* all five
  tables, so a non-admin who reached `/reports` directly could view (not
  edit) reports - consistent with desktop's own nav, which shows Reports
  to everyone. Not considered a regression since mobile's Settings tab
  is already a gated "admin configuration" surface by convention.
- SignaturePad doesn't let you add more strokes on top of a previously
  saved signature - clear and re-sign instead. See above.
- Not tested against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile`, `apps/desktop`, and
  `packages/shared`.

## 52. Mobile feature parity, part 10: Subcontractor management & procurement

Ports desktop's subcontractor directory, compliance tracking, preference
tiers, and Purchase Order/Quote Request workflow. Like Reports & Safety
and Real Estate & Strata, `subcontractor_companies`/`_contacts`/
`_compliance_docs`/`purchase_orders` aren't PowerSync tables - RLS is
admin-only for writes, broad tenant-scoped for reads - so this is a
Supabase-direct, connectivity-gated port with no `schema.ts`/
`sync-rules.yaml` changes and no new migration (`subcontractor-files`
storage bucket and the `generate_po_quote_link` RPC already exist).
Desktop's "Financial Performance" tab (directory) and "Financials &
Jobs" tab (subcontractor detail) - both pure margin-analytics dashboards
with no workflow - aren't ported, the same call the Real Estate module
made dropping its own analytics dashboards.

- **New `app/subcontractors/` route group** (registered in
  `app/_layout.tsx`, linked from Settings > Subcontractors, admin-gated
  like Real Estate & Reports):
  - **`index.tsx`** - Directory (search/tier filter, "+ Add
    Subcontractor") and Compliance tabs. The Compliance tab is a
    per-subcontractor card list with a colour-coded doc-type grid
    (red/amber/green/grey) rather than desktop's wide subcontractor x
    doc-type matrix table, which doesn't fit a phone screen - same
    information, a mobile-appropriate layout.
  - **`[id].tsx`** - subcontractor detail: header (trades, inline tier
    picker, compliance-hold banner) plus Contacts, Orders, and
    Compliance Records tabs (upload via `expo-document-picker`, verify
    toggle, delete, signed-URL "View").
  - **`purchase-order/new.tsx`** - the shared Quote Request/Work Order
    creation form (`?subcontractorId=&quoteRequest=&jobCardId=`),
    blocked when the subcontractor is on compliance hold.
  - **`purchase-order/[id].tsx`** - PO detail: the same free-form
    7-status button row as desktop (no gated state machine), "Send
    Quote Request" (generates the external quote-submission token via
    `generate_po_quote_link`, queues + dispatches the
    `subcontractor_quote_request` email) or "Send Work Order" (compiles
    the PO to PDF, uploads it, queues + dispatches
    `subcontractor_work_order`), line items, and a live client-billed/
    margin calculator.
- **New `components/PoLineItemEditor.tsx`** - the flatter PO line-item
  shape (description/quantity/unit_cost_cents, no labour/material/GST
  split), shared by both PO screens, same as desktop's dedicated editor
  rather than reusing quote/invoice's `LineItemEditor`.
- **New `lib/po-pdf.ts`** - `uploadComplianceDoc()` (uploads to the
  `subcontractor-files` bucket) and `buildPurchaseOrderPdfHtml()`, an
  HTML builder for `expo-print` - like `lib/report-pdf.ts`, this reuses
  the app's existing HTML+`expo-print` PDF pipeline rather than porting
  desktop's `jsPDF`-based `po-pdf.ts`. "Download PDF" on the PO detail
  screen uses `exportPdf()` (share sheet), matching every other manual
  PDF export in the app; "Send Work Order" uses `buildPdfDataUri()` to
  get bytes to upload, matching the reports PDF auto-attach flow.
- **`jobs/[id].tsx`** gained the "Subcontractors" panel desktop's
  `JobDetail.tsx` has: linked Purchase Orders/Quote Requests, and an
  admin-only "+ Assign" modal (trade filter, tier shown, "Request
  Quote"/"Issue Work Order" per subcontractor, disabled with a notice
  when on compliance hold) - assigning a subcontractor to a job *is*
  creating a PO, there's no separate assignment table on either
  platform.

### Deploy
```powershell
git pull origin main
cd apps/mobile
pnpm install
npx eas build --profile preview --platform android
```

### Test it

1. Settings > Subcontractors > "+ Add Subcontractor" - fill in company
   name, trades, tier - save, confirm it appears in the Directory.
2. Open the subcontractor -> Contacts tab -> add a contact with an
   email -> Compliance Records tab -> upload a document with an expiry
   date in the past -> confirm the header status flips to "Compliance
   Hold" (the DB trigger, not client-side logic) and the Compliance tab
   shows it red.
3. Open a job -> "Subcontractors" -> "+ Assign" -> confirm the
   compliance-held subcontractor's actions are disabled -> pick a
   different (active) subcontractor -> "Issue Work Order" -> add a line
   item -> "Create work order" -> confirm it lands on the PO detail
   screen, linked to the job.
4. On the PO detail screen, "Send Work Order" -> confirm it compiles +
   uploads a PDF and queues/sends the email; "Download PDF" -> confirm
   the share sheet opens with a correct PDF.
5. For a Quote Request PO, "Send Quote Request" -> confirm it generates
   a token link and queues/sends the `subcontractor_quote_request`
   email.

### Known gaps / judgment calls

- Financial Performance / Financials & Jobs analytics tabs aren't
  ported - see above.
- Compliance tab is a card list, not desktop's wide matrix table - see
  above.
- Not tested against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile`, `apps/desktop`, and
  `packages/shared`.

## 53. Mobile feature parity, part 11: B2B & Referrals

Ports desktop's B2B partner directory, BNI/networking groups, referral
revenue attribution, and reciprocity tracking. `referral_groups`/
`referral_partners`/`referral_reciprocity_logs` are admin-write/tenant-
read (same RLS shape as Real Estate/Reports/Subcontractors) and aren't
PowerSync tables, so `app/b2b-referrals/index.tsx` is Supabase-direct
and connectivity-gated, no `sync-rules.yaml` change.

One thing this batch *did* need, unlike the three prior admin-tool
ports: referral attribution itself lives on `job_cards` (a column, not
a new table), and `job_cards` is already a PowerSync table technicians
create/view offline. So `packages/shared/src/powersync/schema.ts`'s
existing `job_cards` `Table(...)` gained three columns -
`referral_partner_id`, `referral_fee_paid`, `referral_fee_amount_cents`
- mirroring exactly how the WorkDrive link and Real Estate & Strata
columns were added to this same table in earlier batches. Since
`sync-rules.yaml` already does `select * from job_cards`, no sync-rules
change was needed for this either - only the local schema definition.
Quotes' matching three columns needed no schema change at all, since
quotes were never a PowerSync table to begin with.

- **New `app/b2b-referrals/index.tsx`** - two sub-tabs (desktop's other
  two - "Revenue Analytics & BNI TYFCB" and "Automated Partner
  Workflows" - are pure office reporting/export tooling and a narrow
  duplicate of the existing Automation & Messaging settings screen
  respectively, so neither is ported, same call the Real Estate and
  Subcontractor modules made dropping their own analytics-only tabs):
  - **Directory** - By Partner / By Group toggle, admin-only "+ Add
    Group", "+ Add Partner", and "Log Referral" (the outbound
    reciprocity ledger entry - a referral this business passed *to* a
    partner, distinct from inbound attribution). Each partner card
    shows tier, group, referrals sent, closed revenue won, and the
    sent/received reciprocity line, computed by joining the partner
    against `job_cards` (local, PowerSync) and `invoices` (Supabase-
    direct) exactly like desktop's client-side join.
  - **Reciprocity Ledger** - per-partner inbound-vs-outbound bar
    comparison with the same balanced/net-exporter/net-importer status
    bucketing as desktop (`>2x` / `<0.5x` ratio, an explicit judgment
    call carried over verbatim since the spec never defined the
    cutoffs), plus the last-20-entries outbound log table.
- **`jobs/index.tsx`**'s "New Job" modal and **`quotes/new.tsx`**
  gained the same optional "Referral source" picker desktop's Jobs.tsx/
  QuoteNew.tsx have, sourced from `referral_partners` (Supabase-direct
  for both, since the picker's option list itself needs connectivity
  regardless of which table gets the write) - offline job creation
  still works, just without a referral pick available until back
  online (settable later from the B2B & Referrals screen, though there
  is no "edit a job's referral source after creation" UI on either
  platform today - it's set once at creation, matching desktop).

### Deploy
```powershell
git pull origin main
cd apps/mobile
pnpm install
npx eas build --profile preview --platform android
```

### Test it

1. Settings > B2B & Referrals > "+ Add Group" (e.g. a BNI chapter) ->
   "+ Add Partner" assigned to that group -> confirm both appear under
   "By Group".
2. Create a job -> confirm the new "Referral source" picker lists the
   partner -> pick it -> save -> confirm the partner's Directory card
   now shows "1" referral sent.
3. "Log Referral" from the Directory tab -> pick the partner, enter a
   client/lead name and estimated value -> save -> confirm it appears
   in the Reciprocity Ledger's recent log and updates the outbound bar.
4. Mark the referred job's invoice paid (desktop or mobile) -> confirm
   the partner's "Closed revenue won" and the ledger's inbound bar
   update once refetched.

### Known gaps / judgment calls

- Revenue Analytics/BNI TYFCB export and Automated Partner Workflows
  tabs aren't ported - see above.
- No "mark referral fee paid" toggle - desktop itself doesn't appear to
  have one either (the fee amount is computed automatically by a
  Postgres trigger when the referred job's invoice is paid, but marking
  it actually paid out to the partner has no UI found on either
  platform); not a mobile-specific gap.
- Referral source is set once at job/quote creation, not editable
  afterward, on either platform.
- Not tested against a real device/EAS build in this sandbox. Verified:
  `tsc --noEmit` clean for `apps/mobile`, `apps/desktop`, and
  `packages/shared`.

## 54. Google Calendar two-way sync

Every profile (technician or admin) connects their own Google account.
Once connected: jobs/tasks scheduled here push to that person's real
Google Calendar, and any edit/move/delete made either side - in the app
or directly on their phone's Google Calendar app - flows back to the
other, in real time via Google's push notifications (not polling). A
technician's pre-existing personal Google events are also pulled in as
plain "Busy" placeholders so scheduling avoids clashing with them,
without exposing what those personal events actually are to anyone but
the technician themselves.

### Privacy model

Visibility is **per-viewer-ownership**, not role-based: you see full
detail (title/description/location) of events you own; everyone else -
including admins - sees only a "Busy" placeholder for events they don't
own. This is enforced at write time, not by a redaction view: a
`'google_personal'` event's row in `calendar_events` always literally
stores the title `'Busy'`; the real detail lives only in the satellite
table `calendar_event_personal_details`, readable via RLS only by
`owner_profile_id = auth.uid()`. `'app'` events (jobs/tasks scheduled
from this app) are unaffected - full detail for everyone who could see
them before, same as today.

### Architecture

- **`google_calendar_connections`** - one row per profile (not per
  tenant, unlike `xero_connections`), OAuth tokens + the push-
  notification channel's id/expiry + the incremental `sync_token`. Zero
  RLS grants, same service-role-only lockdown as `xero_connections` -
  `get_google_calendar_connection_status()` (self, any profile) and
  `list_google_calendar_connections()` (admin, whole tenant) are the only
  way to read connection state, both SECURITY DEFINER RPCs that never
  expose tokens.
- **`calendar_events`** gained `source` (`'app'` | `'google_personal'`),
  `owner_profile_id`, and `google_calendar_connection_id`. RLS was
  tightened so ordinary write policies only ever apply to `source =
  'app'` rows - a `'google_personal'` row is service-role-written only
  (by the sync functions below), never directly editable through the
  app.
- **`google-oauth-start`** / **`google-oauth-callback`** - the connect
  flow. Unlike `xero-oauth-start`, not admin-gated (any profile connects
  their own account). The callback does the full initial setup inline
  (resolve the real calendar id, import a rolling 7-days-back/180-days-
  forward baseline of existing events, create the first push channel)
  rather than deferring to a cron sweep, so the connection is fully live
  by the time the browser lands back on the app.
- **`google-calendar-push`** - outbound. Called by the client right after
  a `calendar_events` write (and any linked `job_cards.
  assigned_technician_id` reassignment) lands - see `apps/desktop/src/
  lib/google-calendar-sync.ts` / `apps/mobile/lib/google-calendar-sync.ts`
  - same best-effort, swallow-failures shape as `dispatch-now.ts`'s
  `triggerImmediateDispatch`. Only pushes `'app'` events with a resolved
  assignee who's connected; a reassignment deletes from the old
  assignee's calendar and creates fresh on the new one (Google has no
  "move to a different account" operation).
- **`google-calendar-webhook`** - inbound. Google calls this directly
  (`X-Goog-Channel-ID`/`X-Goog-Channel-Token`/`X-Goog-Resource-State`
  headers, no Supabase JWT - see `[functions.google-calendar-webhook]` in
  `supabase/config.toml`) whenever a watched calendar changes. Pulls the
  actual diff via `events.list({syncToken})`, applies each item (delete /
  update an `'app'` event's schedule fields / update a `'google_personal'`
  event's satellite detail / insert a brand-new `'google_personal'`
  event), falls back to a full re-list + local-deletion reconciliation on
  a 410 Gone.
- **`google-calendar-renew-channels`** (cron, daily) - push channels
  expire and can't be renewed in place, only recreated; sweeps every
  connection whose channel is missing or expiring within 24h.
- **`google-calendar-reconcile`** (cron, hourly) - two-part backstop:
  finishes any connection whose inline setup in the callback didn't fully
  complete (missing `sync_token` and/or channel), and pulls an
  incremental diff for every connected calendar in case a push
  notification was ever dropped (Google delivery isn't 100% guaranteed).
- **`google-calendar-disconnect`** - self-serve (disconnect your own) or
  admin-triggered (disconnect anyone on the tenant). Stops the push
  channel and revokes the OAuth grant (both best-effort), deletes local
  `'google_personal'` rows for that connection, and clears the Google-
  sync columns on any `'app'` rows that were synced to it.
- **Desktop**: Settings gained a "Google Calendar" section (self-connect,
  every profile) plus, for admins, a "Team Google Calendar connections"
  list with per-person Disconnect. `Calendar.tsx`/`CalendarEventDetail.tsx`/
  `CalendarEventNew.tsx`/`Dispatch.tsx` all call `pushCalendarEventUpsert`/
  `pushCalendarEventDelete` after their existing writes, and
  `CalendarEventDetail.tsx` renders `'google_personal'` events as a
  simplified read-only card (edit/delete happens on the Google side and
  flows back automatically) instead of the normal edit form.
- **Mobile**: a new always-visible "Google Calendar" row in the Settings
  tab (`app/google-calendar-settings.tsx`, not admin-gated - unlike the
  rest of that tab's list) mirrors the desktop Settings section
  (self-connect + admin team list). `(tabs)/calendar/index.tsx`/
  `(tabs)/calendar/[id].tsx`/`(tabs)/calendar/new.tsx` got the same
  push-call wiring and read-only `'google_personal'` treatment as
  desktop.

### New Google Cloud project + secrets needed

1. [console.cloud.google.com](https://console.cloud.google.com) -> new
   (or existing) project -> **APIs & Services -> Library** -> enable the
   **Google Calendar API**.
2. **APIs & Services -> OAuth consent screen** - External, add the
   `openid`, `email`, and `https://www.googleapis.com/auth/calendar`
   scopes. While the app is in "Testing" publish status only explicitly
   added test users can connect - move to "In production" (may trigger
   Google's verification review, since `calendar` is a sensitive scope)
   once ready for every technician to connect for real.
3. **APIs & Services -> Credentials -> Create Credentials -> OAuth client
   ID** -> Web application. **Authorized redirect URI** (must match
   exactly):
   ```
   https://YOUR-PROJECT-REF.supabase.co/functions/v1/google-oauth-callback
   ```
4. Set secrets:
   ```powershell
   npx supabase secrets set GOOGLE_CLIENT_ID=your_client_id_here
   npx supabase secrets set GOOGLE_CLIENT_SECRET=your_client_secret_here
   npx supabase secrets set GOOGLE_APP_REDIRECT_URL=https://jmssaas.vercel.app/settings
   npx supabase secrets set GOOGLE_CHANNEL_TOKEN=any_long_random_string_you_generate
   ```
   `GOOGLE_CHANNEL_TOKEN` isn't a Google-issued value - it's a shared
   secret this app makes up once (e.g. `openssl rand -hex 32`) and sends
   to Google when creating a watch channel; Google echoes it back on
   every push notification, and `google-calendar-webhook` checks it
   matches before trusting the notification. Treat it like any other
   secret - don't reuse it for anything else.

### Push notifications need a verified domain

Google's `events.watch()` push notifications will only deliver to an
`address` on a domain verified in
[Google Search Console](https://search.google.com/search-console) under
the **same Google Cloud project** as the OAuth client above - the shared
`*.supabase.co` domain every Edge Function otherwise lives on cannot be
verified (Supabase, not this tenant, owns that domain) and Google will
reject the watch request outright. This is why sync is push-based instead
of falling back to polling: it needs the business's own domain wired up
as a [custom domain for Supabase Edge Functions](https://supabase.com/docs/guides/functions/custom-domains)
(or a thin reverse-proxy in front of them on that domain), verified once
in Search Console, before `google-calendar-webhook`'s URL will actually
receive anything from Google. Until that's done, `createWatchChannel`
calls in `google-oauth-callback`/`google-calendar-renew-channels` will
fail (logged, non-fatal - the connection still works, just without live
push; `google-calendar-reconcile`'s hourly sweep becomes the only sync
path in that case).

**Done for this deployment**: `hooks.bingleyroof.com.au` is set up as a
Supabase custom domain (Settings -> Custom Domains, CNAMEd at VentraIP to
`qnlxmpxjmmhcnzzpcabd.supabase.co`), verified and activated via `npx
supabase domains create/reverify/activate --project-ref
qnlxmpxjmmhcnzzpcabd --custom-hostname hooks.bingleyroof.com.au`.
`WEBHOOK_URL` in `google-oauth-callback`/`google-calendar-renew-channels`
is hardcoded to `https://hooks.bingleyroof.com.au/functions/v1/google-calendar-webhook`
rather than derived from `SUPABASE_URL`, since the whole point is that it
must NOT be the default `*.supabase.co` address. One real gotcha hit
during setup worth flagging for next time: this domain briefly had **both**
VentraIP's and Cloudflare's nameservers delegated at once (split-brain
DNS - some resolvers answered from one zone, some from the other,
inconsistently), which made every DNS-dependent step here flaky/
inconsistent until the unused Cloudflare nameservers were removed from
the domain's delegation at VentraIP, leaving only VentraIP's authoritative.
If a future domain hits inexplicably inconsistent DNS behavior during
this same setup, check for exactly that before assuming it's just
propagation delay.

### Deploy steps

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx supabase db push
npx supabase functions deploy google-oauth-start
npx supabase functions deploy google-oauth-callback --no-verify-jwt
npx supabase functions deploy google-calendar-push
npx supabase functions deploy google-calendar-webhook --no-verify-jwt
npx supabase functions deploy google-calendar-renew-channels
npx supabase functions deploy google-calendar-reconcile
npx supabase functions deploy google-calendar-disconnect
npx vercel --prod
```

(Only `google-oauth-callback` and `google-calendar-webhook` need
`--no-verify-jwt` - both are reached with no Supabase session at all, see
their `verify_jwt = false` entries in `supabase/config.toml`. The two
cron functions are called by `pg_net` with the service-role key checked
by exact string match inside the function itself, same pattern as
`process-scheduled-comms` - they still work fine under the platform's
default JWT verification since the service-role key is itself a valid
JWT.)

Then, in the SQL editor, schedule the two cron sweeps (one-time, requires
`pg_cron`/`pg_net`, same as every other scheduled sweep in this schema -
see `process-scheduled-comms`'s own setup notes):
```sql
select cron.schedule(
  'google-calendar-renew-channels',
  '0 3 * * *',
  $$select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/google-calendar-renew-channels',
    headers := '{"Authorization": "Bearer YOUR-SERVICE-ROLE-KEY"}'::jsonb
  )$$
);
select cron.schedule(
  'google-calendar-reconcile',
  '0 * * * *',
  $$select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/google-calendar-reconcile',
    headers := '{"Authorization": "Bearer YOUR-SERVICE-ROLE-KEY"}'::jsonb
  )$$
);
```

### Test it

1. Settings (desktop) or Settings tab -> Google Calendar (mobile) ->
   **Connect Google Calendar** -> approve on Google's consent screen ->
   confirm it redirects back showing "Connected as [email]".
2. Schedule a job to that technician (Dispatch or Calendar > New event) ->
   confirm the event appears on the technician's real Google Calendar
   within a few seconds.
3. Move or rename that event directly in Google Calendar (phone or
   calendar.google.com) -> confirm it updates here too, without
   refreshing anything manually (push, not polling - should be near-
   instant once the webhook domain is verified).
4. Create a brand-new personal event directly in that technician's Google
   Calendar, overlapping a work day -> confirm it shows up here as
   "Busy" for everyone else, with the real title/location visible only
   when signed in as that technician.
5. Disconnect from Settings -> confirm the "Busy" placeholders for that
   person disappear and the badge flips back to "Connect Google
   Calendar".

### Known gaps / judgment calls

- **Requires a verified custom domain to get live push** - see above;
  done for this deployment (`hooks.bingleyroof.com.au`). On a fresh
  project with only the default `*.supabase.co` URL, sync still works but
  only on `google-calendar-reconcile`'s hourly cadence, not "ideally
  instantly" until that's set up - and `WEBHOOK_URL` in `google-oauth-
  callback`/`google-calendar-renew-channels` would need updating to that
  project's own verified domain too, not reused as-is.
- **Recurring events created in this app sync to Google as N separate
  events, not one native recurring series** - see section 55 below
  (`generateRecurrenceOccurrences`) for why and how that works.
  `singleEvents: true` still expands anything recurring *on Google's own
  side* into individual occurrences on import/sync either way, so a
  Google-side recurrence change also shows up as many individual
  occurrence updates here, not a single "edit series" action.
- **One Google Calendar per profile** - always the account's primary
  calendar (`calendars/primary`), no picker for a secondary calendar.
- **`google_personal` events are read-only in-app** - by design (see
  `CalendarEventEditor.tsx`'s own comment): editing/deleting happens on
  the Google Calendar side and flows back automatically, since
  `google-calendar-push` already no-ops any edit to a non-`'app'` event.
- **OAuth consent screen "Testing" mode caps connections at added test
  users** - see the Google Cloud project setup above; moving to
  "In production" needs Google's review since `calendar` is a sensitive
  scope.
- Not verified against a real Google Cloud project, OAuth client, live
  push delivery, or a verified custom domain - none of those exist in
  this sandbox. Verified: `tsc --noEmit` clean and a production `vite
  build` clean for `apps/desktop`/`apps/mobile`/`packages/shared`, the
  migration's RLS/redaction design empirically tested against a real
  local Postgres 16 instance (base-table reads/writes for admins and
  `'app'` events unaffected; owner sees full personal-event detail via
  the satellite table; non-owner sees zero rows there; admin cannot
  write a `'google_personal'` row directly; cross-tenant isolation
  holds), and the Google Calendar API v3 request/response shapes
  (`events.watch`/`events.list` with `syncToken`/`showDeleted`/
  `singleEvents`, the 410 Gone `fullSyncRequired` contract, OAuth
  `access_type=offline&prompt=consent`) checked against Google's own
  public API documentation by reading, not a live call.

## 55. Desktop calendar UI overhaul: Google-Calendar-style popup/editor, colors, recurrence

Rebuilt the desktop Calendar screen to match Google Calendar's own feel,
not just its layout: click an event and a small popup card appears
anchored next to it (grid still visible behind), click the pencil icon
and a larger edit overlay opens over the grid instead of navigating to a
separate page. `apps/desktop/src/pages/CalendarEventNew.tsx` and
`CalendarEventDetail.tsx` (and their `/calendar/new`/`/calendar/:id`
routes) are gone - `CalendarEventPopover.tsx` and `CalendarEventEditor.tsx`
in `components/` replace them, both driven by local state in
`Calendar.tsx` rather than routing. Nothing else in the app linked to
those two routes, so this was a clean removal, not a redirect shim.

### Recurring events

Real recurring events, but deliberately **not** built on Google's native
RRULE/`recurringEventId` model - see `packages/shared/src/calendar-
recurrence.ts`. Creating a "Weekly on Tuesday" event generates every
occurrence as its own independent `calendar_events` row up front
(`generateRecurrenceOccurrences`, capped at 2 years out / 500 occurrences,
whichever comes first - a `never`-ending series doesn't actually go
forever, see the function's own comment), linked only by a shared
`recurrence_group_id` and a denormalized `recurrence_rule` copied onto
every row (not a single "series master"). The payoff: every existing sync
function (`google-calendar-push`/`google-calendar-webhook`/`google-
calendar-renew-channels`/`google-calendar-reconcile`) needed **zero**
changes - from their point of view a recurring event's occurrences are
just N ordinary `'app'` events, pushed/synced independently exactly like
before. The cost: Google sees N separate calendar entries, not one native
recurring series, so bulk operations *on Google's own side* (e.g.
deleting "this and following" from the Google Calendar app) only affect
whichever single occurrence was clicked - the app's own "This event /
This and following / All events" scope picker (`RecurrenceScopeDialog.tsx`)
is where bulk edit/delete for a series actually lives.

Editing "this and following" or "all events" on a series applies
title/description/location/guests/job/task to every affected row, and -
for the clock-time/duration only, never the underlying day-of-week/day-
of-month pattern - shifts every affected occurrence's own start/end by
applying the edited occurrence's new time-of-day onto each row's existing
date (`Calendar.tsx`'s save mutation, the `newTimeOfDayMs`/`durationMs`
block). Deliberately does not attempt to re-anchor the recurrence pattern
itself (e.g. moving occurrence 3 from a Tuesday to a Wednesday does not
shift future occurrences from Tuesdays to Wednesdays) - see the code
comment there for why that was scoped out.

### Colors

Four fixed categories - Job, Task, Personal (Google), General - derived
from an event's own fields by default (`categoryForEvent` in `calendar-
recurrence.ts`: `job_card_id` set -> Job, `task_id` set -> Task,
`source = 'google_personal'` -> Personal, else General). `tenants.
calendar_category_colors` (jsonb, one hex color per category) is
admin-editable from Settings' new "Calendar colors" section, bundled into
the same "Save changes" button as the rest of Company Settings rather
than its own separate save action. Quotes aren't a category - nothing
schedules a quote onto the calendar today, so there was no real category
to color; that'd be a separate feature if wanted later.

**`calendar_events.category_override`** (added in a follow-up pass, see
the `calendar_category_override` migration) lets any `'app'` event's
type/color be set directly from the editor's "Event type" dropdown
(Auto / Job / Task / General), independent of what it's actually linked
to - e.g. a job-linked event can still be colored General, or an
unlinked event can be colored Job. `categoryForEvent` checks this first
and only falls back to the derived category when it's `null`. Deliberately
excludes `'personal'` (enforced by the column's own check constraint) -
that category only ever applies to read-only `'google_personal'` rows,
which never reach the editor this is set from.

### Trimmed from a literal Google Calendar copy

No Google Meet video conferencing, no "Find a time" availability tab, no
notification/reminder delivery, no rich-text HTML description (kept
plain text, matching how description is used everywhere else in the app -
job cards, PDFs, emails), no granular per-guest permissions (kept the
existing simple comma-separated guest email field) - none of these have
any real backing capability in this app, so copying their exact UI would
have been decorative rather than functional. See the chat thread's own
scoping discussion for the full reasoning.

### Test it

1. Calendar -> click any existing event -> confirm the popup card appears
   anchored next to it, grid still visible, with the correct color dot,
   date/time, category, and (if linked) job/task.
2. Click the pencil icon -> confirm the edit overlay opens over the grid
   (no page navigation) with the event's fields populated.
3. Create a new event, set repeat to "Weekly on [today's weekday]",
   "Ends after 4 occurrences" -> Save -> confirm 4 events appear on the
   calendar, one per week, all the same color.
4. Open one of those 4 -> change its time -> Save -> choose "This and
   following events" -> confirm that occurrence and the ones after it
   (not the ones before) moved to the new time, same dates.
5. Settings -> Calendar colors -> change the Job color -> Save changes ->
   confirm job-linked events on the Calendar screen immediately reflect
   the new color after the query refetch.
6. Delete one occurrence of the series with "All events" scope -> confirm
   every occurrence (and its synced Google Calendar event, if the
   assignee is connected) disappears.

### Known gaps / judgment calls

- **Mobile calendar UI is unchanged** - this pass was explicitly scoped
  to desktop only; mobile keeps its existing full-page create/detail
  screens and has no recurrence or color-coding UI.
- **A `never`-ending recurring event is capped at 2 years / 500
  occurrences** - there's no background job to lazily extend a series
  past that horizon; re-saving the event with a later end date is the
  workaround if a series genuinely needs to run longer.
- **"This event only" edits don't detach from the series** - the edited
  row keeps its `recurrence_group_id`, so a later "all events" edit on
  the same series still touches it too. A true per-occurrence "exception"
  model (like Google's own) was scoped out for complexity - see
  `RecurrenceScopeDialog`'s own comment.
- Not tested in a real browser against a live Supabase project - this
  sandbox has no such backend. Verified: `tsc --noEmit` clean and a
  production `vite build` clean for `apps/desktop`/`packages/shared`, the
  recurrence generator's date math (multi-weekday ordering, month-end
  clamping Jan 31 -> Feb 28 without drifting into March, end-date
  bounding) empirically run via `tsx` against real `Date` objects rather
  than only reviewed by eye, and the new migration's `ALTER TABLE`
  statements applied against a real local Postgres 16 instance seeded
  with the relevant existing table shapes.

## 56. Bug-fix batch: job card editing/truncation, referral saving, border contrast, real estate truncation, price book image tiles

Eight fixes/small features reported together, grouped here as one batch
rather than eight tiny sections.

**Job card title/description not editable (desktop).** Mobile's job
detail screen already had a working "Edit" modal; desktop's
`JobDetail.tsx` had none. Added the same shape: an "Edit" button next to
the existing "Email" button opens a modal (Title + Description fields,
reusing `createJobCardSchema` from `@jmssaas/shared` for validation) that
writes straight to `job_cards.title`/`description`. The description
display itself also gained `whitespace-pre-wrap` so line breaks in a
saved description actually render as line breaks.

**Mobile "Log Referral" stuck on "Saving..." forever.** Root cause:
`apps/mobile/app/b2b-referrals/index.tsx`'s `saveGroup`/`savePartner`/
`saveLog` handlers all called `setXSaving(true)` then `setXSaving(false)`
as a plain statement *after* the `await supabase...insert(...)` call -
any thrown exception (a network blip, RLS rejection, anything) skipped
straight past that line and left the saving flag stuck `true` forever.
Same bug, identically shaped, in all three handlers even though only the
referral-log one was reported. Fixed all three with `try/catch/finally`,
`finally { setXSaving(false); }` guaranteeing the flag always clears.

**App randomly looking logged-out / "fresh account" until restarted.**
Investigated, no code change. `auth-context.tsx`'s session handling
already has a documented earlier fix for the closest-sounding bug
(PowerSync `connect()` re-triggering on every token refresh); the session
itself isn't being lost. The far more likely explanation, given how many
`packages/shared/src/powersync/schema.ts` changes shipped across this
project's recent history: PowerSync detecting a local schema version
bump and doing a one-time local resync, which blanks the local SQLite
cache and `hasSynced` flag until it completes - indistinguishable from
"logged out" to a user, and exactly matches "fixed by restarting" if the
device regained connectivity around the same time. This is expected
PowerSync behavior after a schema-changing update, not a bug to fix in
this codebase.

**Category/status labels cut off on the desktop job card.** Traced to
plain `<select>` elements clipping their closed-state text hard at the
box edge (no ellipsis) when the box is narrower than the selected
option's text - not a `truncate` class anywhere, since this app doesn't
use one. `JobDetail.tsx`'s Category/Stage/Technician row was
`grid-cols-2 md:grid-cols-3`, squeezing each select at wider viewports;
flattened to a plain `grid-cols-2` so each select gets more room.

**Separator/border lines too light, app-wide.** Established as a
deliberate, global rule: shift every border color one step darker. Desktop
uses a 3-tier Tailwind gray scale for borders (`border-gray-100` ->
`-200` -> `-300`, darkest already in use); shifted 100->200 and 200->300
across 43 files via a placeholder-based `sed` pass (to avoid the 100->200
values then also being caught by the 200->300 rule). Mobile has two flat
hex border colors used directly in `StyleSheet.create` objects
(`#f0f0f0`, `#e5e7eb`); both collapsed to one darker `#d1d5db` across 33
files, matching only `border*Color:` properties so the same hex used as a
`backgroundColor` (empty-swatch placeholders, archived-status badges) was
left untouched.

**Real estate/strata suburb text cut off.** Same root cause on both
platforms: an address and a suburb rendered as unconstrained siblings in
a row layout, so a long address pushed the suburb past the visible edge.
Desktop's `RealEstate.tsx` PM property list and mobile's
`real-estate/index.tsx` property list both fixed the same way - the
address becomes the element that shrinks and truncates
(`min-w-0 flex-1 truncate` / `flex: 1` + `numberOfLines={1}`), the suburb
becomes the element that always shows in full (`flex-shrink-0` /
`flexShrink: 0`). `PropertyDetail.tsx` (desktop) and `[id].tsx` (mobile)
already wrap safely and needed no change.

**Price book image tiles.** `price_book_categories` and
`price_book_items` each gained an `image_url` column
(`20260905000100_price_book_image_tiles.sql`), plus a public
`price-book-images` storage bucket with the same
public-read/tenant-and-admin-scoped-write RLS shape as the existing
`company-logos` bucket. Desktop only (no scope given for mobile in the
request, and the pricebook browsing UI itself is desktop-only today):

- `PriceBook.tsx`'s "New category" modal and `PriceBookCategory.tsx`'s
  "New item" modal each gained an optional file picker; picking a file
  uploads it to `<tenant_id>/category-<ts>.<ext>` / `item-<ts>.<ext>`
  before the row insert, so the row is created with `image_url` already
  set.
- Existing categories/items get an immediate-upload "Add/Change tile
  image" + "Remove image" control (same pattern as the company logo
  uploader in Settings) - next to "Rename" on the category page, and as
  its own section on `PriceBookItem.tsx`.
- Both tile grids (`PriceBook.tsx` categories, `PriceBookCategory.tsx`
  items) render the image as the tile's `background-image` with the
  name (and, for items, the computed price) overlaid in a bottom
  gradient bar when `image_url` is set, falling back to the existing
  emoji-and-centered-text tile when it isn't.

### Deploy

```powershell
git pull origin main
npx supabase db push
npx vercel --prod
```

Mobile-touching fixes in this batch (referral saving fix, border darkening,
suburb truncation) need a new EAS build to reach devices already installed
from a prior build.

### Test it

1. Open a job card -> Edit -> change the title and description, including
   a line break in the description -> Save -> confirm both show correctly
   and the line break renders.
2. Mobile: B2B & Referrals -> Log Referral -> submit with the device
   offline or against a bad network -> confirm the modal shows an error
   instead of hanging on "Saving..." forever; retry with network back and
   confirm it saves normally.
3. Open a job card at a narrower desktop window width -> confirm the
   Category/Stage/Technician dropdowns show their full selected text
   without clipping.
4. Spot-check a few list/card borders across both apps (job list, price
   book tiles, dispatch board) -> confirm dividing lines are visibly
   darker/more distinct than before.
5. Real Estate -> a property manager with a long address -> confirm the
   suburb still shows in full next to a truncated (not overflowing)
   address, on both desktop and mobile.
6. Price Book -> new category -> attach an image -> Save -> confirm the
   tile shows the image with the name readable at the bottom -> open the
   category -> new item -> same check -> open an existing item -> upload/
   change/remove its image and confirm the tile grid reflects it after
   the query refetch.

### Known gaps / judgment calls

- **Mobile job description "cut off"** - the reported "not editable AND
  cut off on mobile" was two claims; editing already worked on mobile
  (only desktop was missing it, now fixed), but no reproducible
  truncation could be found in `apps/mobile/app/(tabs)/sales/jobs/[id].tsx`'s
  description display (no `numberOfLines`, no fixed-height/overflow
  container) or its edit modal (`CenteredModal` scrolls past 85% height
  rather than clipping). Left as-is; flag it again with a screenshot if
  it's still visible after this deploy - there may be a code path this
  pass didn't reach.
- **Price book image tiles are desktop-only** - the request didn't
  specify mobile, and mobile has no price book browsing UI to attach
  this to today.
- Not tested in a real browser against a live Supabase project - this
  sandbox has no such backend. Verified: `tsc --noEmit` clean across
  `apps/desktop`, `apps/mobile`, `packages/shared`; a production
  `vite build` clean for `apps/desktop`; and the new migration's `ALTER
  TABLE`/bucket/RLS-policy statements applied against a real local
  Postgres 16 instance, including sanity inserts confirming `image_url`
  defaults to `null` when omitted and that the four storage policies
  attach correctly.

## 57. Bug-fix batch: referral partner editability, team roles, price book/inventory polish, calendar coloring, PO numbers, template preview rendering

Eleven more fixes/small features from the same "keep reporting bugs as you
hit them" workflow as section 56.

**Referral partner not editable after creation.** `referral_partner_id`
was only ever set in the desktop "New Job"/"New Quote" creation forms -
`JobDetail.tsx`, `QuoteDetail.tsx`, and (by extension, since invoices have
no column of their own and always derive attribution from the linked job)
`InvoiceDetail.tsx` had no way to set or change it afterward. New shared
`ReferralPartnerModal` component (parameterized by `table: "job_cards" |
"quotes"`) mounted on all three desktop pages, plus the equivalent picker
added to mobile's job/quote/invoice detail screens (job writes through
PowerSync like every other `job_cards` field there; quotes/invoices write
directly via Supabase like the rest of those screens).

**Team member name/role.** `Team.tsx`/`team.tsx` only ever listed
technicians and had no edit action at all. Now lists every team member
(admins included) with an Edit action for name, plus a new free-text
`job_title` column (migration `20260906000100_profile_job_title.sql`) an
admin can set to whatever the person's actual job is - "Foreman", "Office
Manager", "Apprentice", anything. `profiles.role` (admin/technician)
deliberately stays a fixed two-value enum rather than becoming fully
custom - it drives roughly 160 RLS policy references across the schema,
and rewriting that into an arbitrary/tenant-defined set would mean
touching every one of those policies for a purely cosmetic ask. Role
badge shown read-only next to the new job title field.

**Mobile price book category titles clipping ("Roof Repairs" → "Roof").**
Self-inflicted regression from section 56's own image-tile work: the tile
gained `overflow: "hidden"` (to clip the new background image to its
rounded corners) with no `numberOfLines` on the plain-tile label, so a
name wrapping to a second line got silently cut off by the same clip
rather than shown with an ellipsis. Fixed with `numberOfLines={2}` on
both category and item labels, and a shorter aspect ratio (1.3 → 1.05,
taller tiles) so two lines actually fit.

**"Choose photos" not working.** `ImagePicker.launchImageLibraryAsync`'s
own `base64: true` option is unreliable once `allowsMultipleSelection`
triggers the native multi-select picker - assets often come back with no
`base64` data and no error, and the upload loop's `if (!asset.base64)
continue;` silently skipped every one, so nothing visibly happened.
Fixed in all three affected call sites (`PhotoAttachments.tsx`,
`reports/instance/[id].tsx`, `EmailComposeModal.tsx`) by reading each
picked asset back off disk via `expo-file-system` instead - the same
reliable technique `pickDocument` already used.

**Mobile inventory UI, price-book-style with images.** `inventory_items`
gained an `image_url` column (migration
`20260907000100_inventory_item_images.sql`, new `inventory-images`
bucket, same public-read/admin-write shape as `price-book-images`) and a
PowerSync schema column so the existing offline-first inventory screen
can read/write it locally. The flat list of `itemCard` rows became a
2-column tile grid matching the price book's look (image as background +
name/supplier overlaid at the bottom, or the previous plain tile when no
image is set) while keeping the -/qty/+ stepper as its own row below each
tile - that interaction is still the point of this screen, not just a
visual match. The New/Edit item modal gained a photo picker (deferred
upload - only actually uploaded on Save, not the moment a photo is
picked, so cancelling never leaves an orphaned file behind).

**Mobile job stage automation toggle undoing itself after save** (and,
it turned out, four other silently-broken toggles). Empirically
confirmed root cause: PowerSync stores every boolean-shaped flag as
`column.integer` (SQLite has no boolean type), and `connector.ts`'s
`uploadData` was forwarding that raw `0`/`1` straight to Supabase's REST
API as a JSON *number* - which PostgREST rejects for a genuine Postgres
`boolean` column (verified directly against a local Postgres 16 instance:
`('{"v":1}'::jsonb -> 'v')::boolean` raises "cannot cast jsonb numeric to
type boolean", the exact shape of request a `{is_closed: 1}` body
produces). The CRUD upload silently failed and never completed, so the
optimistic local toggle reverted back to the last-synced value once
PowerSync's own consistency check caught up - looking exactly like "I
flipped it, saved, reopened it, and it's back to what it was." Fixed once
in the connector (`coerceBooleanColumns`), for every affected column
across the schema, not just `job_lifecycle_stages.is_closed`:
`client_sites.is_primary`, `client_contacts.is_primary`, `job_cards.
is_real_estate_job`/`nte_exceeded_approved`/`referral_fee_paid`, `job_
lifecycle_stages.is_system_default`/`is_closed`, `communication_rules.
is_enabled`, `communication_templates.is_active`.

**Mobile Schedule: assigning an unassigned job doesn't remove it from
Unassigned** (and the identical bug on desktop's Dispatch board, fixed
alongside it once found there too). Both screens computed "still
unassigned" as "no calendar event with a start time `>= now`" - comparing
against the *exact current moment*, not the day. Scheduling a job for
later *today* at a clock time earlier than right now (e.g. the "new
event" default of 9am, picked mid-afternoon, or Dispatch's own default
1-hour block dropped onto an earlier slot) was already "in the past" the
instant it was created, so the job never left the unassigned list.
Fixed by comparing against the start of today instead of the exact
moment - a job scheduled anywhere on today's date (or later) now counts
as assigned for the rest of that day.

**Desktop Dispatch board filter/search.** Added a search box (job title
or client name) plus category and stage dropdown filters, matching
ServiceM8's own dispatch board search/filter. Applied identically to the
unassigned shelf and to which scheduled blocks show on the technician
rows, so filtering narrows the whole board, not just the jobs still
waiting to be dispatched.

**Calendar colors + full-tile coloring, on mobile too, and both
platforms now fill the whole tile.** Mobile's calendar never read
`tenants.calendar_category_colors` at all - every event rendered
identically regardless of category. Added the same `categoryForEvent`/
color lookup desktop already had. Separately, on **both** platforms, the
color treatment itself changed from a colored left-edge accent (border-
left on a plain gray/white row) to a full solid-color tile with white
text, matching Google Calendar's own event styling rather than the
subtler accent-bar look this app had been using.

**Optional PO number on quotes/invoices, any client type.** New
`po_number` column on both `quotes` and `invoices` (migration
`20260908000100_quote_invoice_po_number.sql`) - distinct from `job_cards.
work_order_number`, which is a different concept (the agency's own
work order, real-estate/strata jobs only) that already existed. Quick-
edit control on both desktop (new `PurchaseOrderNumberModal`) and mobile
detail screens, independent per document (a quote's PO can differ from
its invoice's). Shown on the PDF as a "PO" line in the same dates block
as the issue/expiry/due dates, only when set - no PO number, no line at
all, not even a blank one.

**Email composer showing raw `{tags}` instead of the client's actual
values.** "Send Quote via Email"/"Send Invoice via Email" prefilled the
editable composer with the *literal* stored template - `{client_full_
name}`, `{company_name}`, `{quote_accept_link}` and so on, verbatim. The
actual send path was never broken: `process-scheduled-comms` (the
dispatcher) always re-renders `rendered_subject`/`rendered_body` against
fresh entity data at actual send time regardless of what's stored, so a
client was never going to receive a literal unrendered tag - but the
*editable preview* looked wrong and made it hard to tell what, if
anything, still needed editing before sending. Fixed by rendering the
template (via the existing shared `renderTemplate`, the same function
the dispatcher's own Deno copy is kept in sync with) against the specific
client/quote-or-invoice/company data before showing it in the composer -
on both desktop and mobile, for both quotes and invoices. The one field
that needs an extra step, the accept/decline/payment link, is generated
via the same `generate_quote_approval_link`/`generate_invoice_approval_
link` RPC the existing "copy approval link" button already calls, so the
link shown in the preview is real and clickable, not a placeholder.

### Deploy

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx supabase db push
npx vercel --prod
```

Mobile-touching fixes in this batch (referral partner editing, price book
tile clipping, "Choose photos", inventory images, the boolean-toggle
connector fix, Schedule's unassigned-job bug, calendar colors, PO
numbers, template preview rendering) need a new EAS build to reach
devices already installed from a prior build.

### Test it

1. Open a job card, quote, and invoice each - confirm "Referral source"
   shows and is editable on all three, on both desktop and mobile.
2. Team -> confirm every team member shows (not just technicians), each
   with a Role badge -> Edit one -> change the name and set a job title
   -> Save -> confirm both show immediately.
3. Mobile: Price Book -> a category with a name that wraps to two lines
   -> confirm both lines show fully, no clipping.
4. Mobile: a job or task -> "Choose photos" -> pick several from the
   library -> confirm they actually attach (not silently nothing).
5. Mobile: Inventory -> confirm the item grid looks like tiles (not a
   flat list) -> add/edit an item with a photo -> confirm the tile shows
   the image with the name at the bottom, and the -/qty/+ stepper still
   works underneath it.
6. Mobile: Job Setup -> edit a stage -> toggle "Job is done in this
   stage" -> Save -> leave the screen and come back -> confirm the
   toggle held (previously it silently reverted).
7. Mobile: Schedule -> tap an unassigned job -> schedule it for later
   today with a technician -> confirm it immediately disappears from
   Unassigned (previously it stayed). Same check on desktop's Dispatch
   board by dragging a job onto a technician's row at an earlier time
   slot than right now.
8. Desktop: Dispatch -> type into the search box, or pick a category/
   stage filter -> confirm both the unassigned shelf and the scheduled
   blocks on technician rows narrow to match -> Clear filters -> confirm
   everything reappears.
9. Desktop and mobile Calendar -> confirm events render as solid colored
   tiles (not a thin colored edge on a gray row), and that job/task/
   personal/general events show different colors matching Settings'
   Calendar colors on both platforms now.
10. Open a quote -> "PO number" -> + Add -> type one -> Save -> confirm
    it shows -> export/preview the PDF -> confirm a "PO" line appears.
    Clear it back to empty -> confirm the PDF's PO line disappears
    entirely. Same check on an invoice.
11. Open a quote with a client that has a name/email on file -> "Send
    Quote via Email" -> confirm the subject/body show the client's actual
    name and company details instead of `{client_full_name}`/
    `{company_name}` placeholders, and that the accept/decline links in
    the body are real working links, not empty. Same check on an invoice.

### Known gaps / judgment calls

- **`profiles.role` (admin/technician) is still not customisable** - see
  above; a full custom-role/permission system was scoped out as too big
  and too security-sensitive for this pass. `job_title` covers the
  "identify what they actually do" half of the request without touching
  any RLS policy.
- **Mobile has no upload UI for price book images** - unchanged from
  section 56, still desktop-only; this batch only fixed the *display*
  clipping bug on mobile's existing (read-only) tiles.
- **The boolean-toggle connector fix is a fixed allowlist, not a generic
  mechanism** - `BOOLEAN_COLUMNS_BY_TABLE` in `connector.ts` has to be
  updated by hand if a new boolean-shaped `column.integer` field is added
  to the PowerSync schema later and gets written to from a mobile screen;
  nothing enforces that today.
- **The "in-modal switch template" dropdown inside `EmailComposeModal`
  still inserts a raw, unrendered template** when a different template is
  picked *after* the composer is already open (as opposed to the initial
  "Send Quote/Invoice via Email" prefill, which is fixed) - fixing that
  properly means plumbing a render context/callback through the shared
  component for every one of its callers (job's free-form email button
  has no single obvious entity context to render against), which was out
  of scope for this pass. The initial prefill this batch fixed is the
  path the user actually reported.
- Not tested in a real browser against a live Supabase project - this
  sandbox has no such backend. Verified: `tsc --noEmit` clean across
  `apps/desktop`, `apps/mobile`, `packages/shared`; a production
  `vite build` clean for `apps/desktop`; the PostgREST boolean/numeric
  cast failure empirically reproduced against a real local Postgres 16
  instance via `node-postgres` before writing the fix (not just inferred
  from documentation); and all three new migrations applied and sanity-
  tested (inserts, defaults, bucket/RLS policies where applicable)
  against real local Postgres 16 instances.

## 58. Asana-style task management engine

Upgraded the flat single-list Tasks screen into a full project management
system: Projects, Kanban sections, subtasks, task dependencies,
per-project custom fields, and a system activity log alongside the
existing human-authored notes - on both desktop and mobile.

### Scope decisions (read this before touching `tasks`)

- **`tasks.status` (todo/in_progress/done) was NOT replaced.** Too much
  already keys off it - the Complete button, mobile's status chips, the
  subtask rollup, and the new dependency guardrail's "mark complete"
  check - same reasoning as `job_lifecycle_stages` alongside
  `job_cards.status` (section 32's migration). The new `section_id` is a
  purely organisational Kanban-column position within a project,
  independent of completion state: dragging a card into a "Done"-looking
  section does not itself flip `status`. An admin who wants that
  automatic behaviour drags the completed card there themselves.
- **The JMS "Job" link reuses the existing `job_card_id` column** - this
  schema's job entity is `job_cards`, not a separate `jobs` table, so
  there was nothing new to add there. `client_id`/`property_id` are the
  two genuinely new JMS link columns.
- **No new `task_comments` table.** The existing `task_notes` table
  (already PowerSync-synced) already is exactly that - author, body,
  timestamp - so it's reused as the human-authored half of the "Activity
  & Comment feed". The new `task_activity_logs` table is the
  system-generated half (field-change history), populated by a single
  `AFTER UPDATE` trigger (`log_task_activity()`) rather than scattered
  application-side insert calls at every mutation site.
- **No project-membership/collaborator table, and no notification
  wiring for milestone completion.** There's no existing "who's on this
  project" concept in this schema to notify, and building one plus
  wiring it into the communication/dispatch engine is a separate feature
  in its own right. Milestone completion still gets its own
  `task_activity_logs` entry (`field_name = 'milestone_completed'`),
  just not a push/email - a real, visible gap against the original ask,
  called out here rather than silently dropped.

### Database (`supabase/migrations/20260909000100_asana_task_engine.sql`)

New tables: `task_projects`, `task_sections`, `task_dependencies` (a
directed `blocking_task_id` -> `dependent_task_id` edge, no self-loops,
no duplicate edges), `task_custom_fields` + `task_custom_field_values`
(per-project field definitions, one value row per task+field pair), and
`task_activity_logs`. New columns on `tasks`: `project_id`, `section_id`,
`parent_task_id` (subtasks are ordinary `tasks` rows, no separate
subtask table), `priority` (low/medium/high/urgent), `is_milestone`,
`start_date`, `position_order`, `estimated_hours`/`actual_hours`,
`client_id`/`property_id`. RLS mirrors two existing shapes exactly:
`task_projects`/`task_sections`/`task_custom_fields` are tenant-wide
read, admin-only write (same as `job_lifecycle_stages`/
`service_categories`); `task_dependencies`/`task_custom_field_values`/
`task_activity_logs` are visible/writable via the parent task's own
admin-or-assigned rule (same as `task_notes`/`task_files`).

Empirically tested against a local Postgres 16 instance before being
considered done, same bar as every other migration in this repo: a
minimal mirrored schema (`tenants`/`profiles`/`clients`/`properties`/
`job_cards`/`tasks` plus the `task_status` enum and the
`set_updated_at()`/`current_tenant_id()`/`is_admin()` helper functions
this migration's triggers/RLS depend on), the real migration applied on
top, then real inserts covering: a project + two sections, a task in
each linked to `client_id`/`property_id`, a dependency edge between two
tasks (confirmed the self-loop and duplicate-edge constraints reject bad
inserts), a custom field + its value (confirmed the one-value-per-
task-per-field unique constraint rejects a duplicate), and a single
`UPDATE` changing `status`/`priority`/`assigned_to`/`due_date`/
`section_id` together - confirmed exactly 5 `task_activity_logs` rows
came out of the trigger, plus a separate check that the
`milestone_completed` special-case entry fires only for a milestone task
transitioning to `done` and not for an ordinary one.

### Shared (`packages/shared/src`)

`types.ts`: `Task` extended with the new columns; new `TaskProject`,
`TaskSection`, `TaskDependency`, `TaskCustomField`,
`TaskCustomFieldValue`, `TaskActivityLog` interfaces. `schemas.ts`: new
Zod schemas for all of the above, and `createTaskSchema` extended to
match. `powersync/schema.ts`: `tasks` gained the same new columns;
`task_projects`/`task_sections`/`task_custom_fields` added as new
PowerSync tables. `task_dependencies`/`task_custom_field_values` were
**also** added to the local PowerSync schema (per the original ask) but
deliberately **not** wired into `powersync/sync-rules.yaml`'s
technician-scoped buckets - see the known gap below.

### Desktop (`apps/desktop/src`)

`pages/Tasks.tsx` is now a multi-view workspace: a project sidebar ("All
Tasks" plus each `task_projects` row), a view switcher (Board/List/
Calendar/Timeline - defaulting to the selected project's own
`view_type`, since Board/Timeline need a project's sections/dates to
mean anything and aren't offered for "All Tasks"), quick filters (My
Tasks/Overdue/Unassigned/priority/search), and "+ New Project"/"+ New
Section"/"+ New Task". The four views live in
`components/tasks/{BoardView,ListView,CalendarView,TimelineView}.tsx`:
Board is a `@dnd-kit`-based Kanban (same library already used by
Dispatch's board) with drag-and-drop updating `section_id`/
`position_order` instantly; List is a grouped accordion (by section when
a project is selected, by priority for "All Tasks") with inline editing;
Calendar is a month grid plotting `due_date`/`start_date`; Timeline is a
horizontal Gantt-style bar chart with SVG arrows for dependencies, drawn
between each row's known y-position and the shared date scale - a real,
working implementation, not a polished commercial Gantt (no resize-by-
drag, no cross-project view).

`pages/TaskDetail.tsx` became a slide-over drawer instead of a full-page
navigation: `App.tsx`'s `/tasks/:id` route nests under `/tasks` and
`TasksPage` renders `<Outlet/>` inside a fixed right-side panel (only
when the child route matches, via `useMatch`), so the board/list stays
mounted behind the drawer like real Asana instead of navigating away.
The drawer covers every piece from the spec: breadcrumb (Project /
Section / Parent task), a properties grid (assignee/dates/priority/
estimated vs actual hours), JMS entity link dropdowns (Job/Client/
Property - "combobox" here means the same `<select>` convention every
other entity-link field in this app already uses, not a new rich-text
autocomplete component), dynamic custom-field inputs per the task's
project, a dependencies widget ("Blocked by"/"Blocking" with a search-
to-add box), a subtask checklist (add + up/down reorder + progress),
photos (unchanged from before), and a merged activity/comment feed
(system-generated `task_activity_logs` lines interleaved with
`task_notes` comments by timestamp). @mentions are a lightweight
"tap a name to insert `@Full Name`" row under the comment box, not a
live autocomplete-while-typing or a real notification - there's no rich
text editor in this app to hang that off, and wiring actual mention
notifications is the same out-of-scope problem as the milestone
notification above.

### Mobile (`apps/mobile/app/(tabs)/tasks`)

`index.tsx` gained a project filter row, section tabs (shown once a
project with sections is selected), and quick filter chips (My Tasks/Due
Today), on top of the existing status filter row - the "+ New task"
form (admin-only, unchanged) gained priority chips, a milestone switch,
and an assignee picker (`PickerModal`, the same searchable-list
component quotes/invoices/job detail already use for client/job/
category pickers). `[id].tsx` gained priority chips, an assignee picker,
a start-date field alongside the existing due-date field, and a subtask
checklist (checkbox to toggle status, "+ Add subtask" input) - all
writable offline via the same `powersync.execute()` pattern the existing
status chips already used, no new sync plumbing needed since these are
all just columns/rows in tables mobile already syncs.

### Guardrails (`apps/desktop/src/components/tasks/taskHelpers.ts`)

- **Dependency guardrail**: `unresolvedBlockers()` + `dependencyGuardrailMessage()`
  are shared by every place a desktop task can be marked complete - the
  drawer's Complete button and the List view's inline status
  controls - so completing a task from either place surfaces "This task
  is blocked by X. Resolve dependencies first or override?" rather than
  the warning being bypassable by using the other view. An admin can
  still confirm through it; this is a warning, not a hard block. Not
  enforced on mobile - see the known gap below.
- **Milestone auto-completion**: handled entirely by the
  `log_task_activity()` trigger - no client-side code needed. Does not
  notify collaborators (see the scope decision above).
- **Subtask rollup**: `subtaskProgress()` computes done/total from the
  same in-memory task list every view already has (subtasks are just
  rows with `parent_task_id` set) - shown as an "X/Y" badge on cards, list
  rows, the drawer's subtask section, and mobile's subtask section.
- **JMS integration link**: the Job # badge on Board/List cards is a
  real button (not a static label) that navigates to `/jobs/:id`,
  `stopPropagation`-guarded so clicking it doesn't also open the task
  drawer underneath it.

### Deploy

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx supabase db push
npx vercel --prod
```

A new EAS build is needed for the mobile changes (new tasks columns,
project/section filters, subtasks) to reach devices already installed
from a prior build.

### Test it

1. Tasks -> "+ New Project" -> name it, pick a default view -> confirm it
   appears in the sidebar and is auto-selected.
2. On that project -> "+ New Section" twice -> switch to Board view ->
   confirm both columns appear -> "+ New Task" into one -> drag the card
   into the other column -> confirm it stays there after a refetch
   (`section_id`/`position_order` persisted).
3. Switch to List view -> confirm the same tasks group by section ->
   inline-edit a task's assignee/due date/priority/status directly in
   the row, with no drawer open.
4. Switch to Calendar view -> confirm a task with a due date shows on
   that day; Timeline view -> confirm a task with both start and due
   dates renders as a bar spanning that range.
5. Click a task to open the drawer -> confirm the board stays visible
   behind it. Add a subtask, reorder it, mark it done -> confirm the
   parent's "X/Y" badge updates on close. Link a Client and a Property
   via the JMS dropdowns -> Save -> reopen -> confirm they held.
6. Add a second task -> from the first task's Dependencies widget,
   search for it and add it under "Blocking" -> confirm it now shows
   under "Blocked by" on the second task -> try marking the second task
   complete -> confirm the warning appears -> Cancel -> mark the first
   task done first -> mark the second complete again -> confirm no
   warning this time.
7. On a project with a custom field (add one via Supabase directly for
   this test, no admin UI for defining fields was built beyond the
   migration/table) -> confirm it renders in the drawer and saves.
8. Click a task's Job # badge on a Board or List card -> confirm it
   navigates straight to that job, without opening the task drawer.
9. Mobile: Tasks tab -> filter by project, then by section, then by "My
   Tasks"/"Due Today" -> confirm each narrows the list correctly. Open a
   task -> change its priority and assignee -> add a subtask -> tick it
   done -> confirm it all persists after a background/foreground cycle
   (offline-first via PowerSync).

### Known gaps / judgment calls

- **`task_dependencies`/`task_custom_field_values` are declared in
  mobile's local PowerSync schema but not wired into any
  `sync-rules.yaml` bucket for technician devices** - only into
  `admin_job_data` (so admin devices do get them). They're keyed by
  `task_id` rather than `job_card_id`, so scoping them into
  `technician_assigned_jobs`/`technician_own_tasks` the way
  `task_notes`/`task_files` are would need a join those buckets'
  existing "NOT verified against a real PowerSync instance" caveat
  already flags as uncertain. Mobile's own screens don't yet surface
  dependency management or custom fields either (only desktop does), so
  there's nothing on a technician's device that would need them today -
  revisit both together if mobile ever gains that UI.
- **No admin UI for defining a project's custom fields** - the
  `task_custom_fields` table, RLS, and the drawer's rendering of
  whatever fields exist are all in place, but creating/editing a field
  definition itself is Supabase-direct-only for now (test step 7 above).
  A `task_custom_fields` settings screen is a reasonable, bounded
  follow-up.
- **@mentions are an insert-only affordance, not a real notification
  system** - see the scope decision above; same for milestone
  completion. Both are one clearly-scoped feature away (a project
  collaborators/subscribers concept, wired into the existing
  communication/dispatch engine) from what the original ask implied.
- **The Timeline (Gantt) view has no drag-to-reschedule or resize** -
  bars are click-to-open-drawer only; rescheduling happens through the
  drawer's own date fields. Cross-project Gantt view isn't offered -
  Timeline, like Board, requires a project to be selected.
- Not tested in a real browser against a live Supabase project or a real
  device/EAS build - this sandbox has neither. Verified: `tsc --noEmit`
  clean across `apps/desktop`, `apps/mobile`, `packages/shared`; a
  production `vite build` clean for `apps/desktop`; and the new
  migration applied and empirically sanity-tested (inserts, constraints,
  the activity-log trigger's exact row counts, the milestone special
  case) against a real local Postgres 16 instance, same bar as every
  other migration in this repo.

## 59. Bug-fix batch: task drawer close/header color, nav highlighting, clipping fixes, calendar dead end

A round of small fixes reported after the Asana task engine shipped:

- **Task drawer had no way to close it** - no X button, no
  click-outside backdrop. Added both (either navigates back to
  `/tasks`), and gave the drawer's header band its own blue background
  so it stands out from the white properties/activity area below it.
- **Desktop Settings sidebar**: "Company Details" (`/settings`) stayed
  highlighted on every nested settings route, since `NavLink`'s default
  match is a prefix match, not exact - added `end` so it only lights up
  on its own route.
- **Mobile Inventory screen**: the top nav was a cramped stack of
  scrolling chip rows. Collapsed the location chip row into a header
  picker button, shortened the "Out of Stock / Need to Order" tab label
  to "Low Stock", and pinned "Manage categories" as a fixed gear icon
  beside the category chip scroll instead of inside it (so it doesn't
  get pushed further away as more categories are added). Also wrapped
  the screen in `SafeAreaView` (`edges=["top"]`) - unlike Home/Sales/
  Settings, which already did this, Inventory's custom header had never
  been wrapped and sat right under the status bar/notch with a guessed
  flat `paddingTop`, making the location button hard to tap on some
  devices. And the subcategory chip row's `ScrollView` had never been
  given an explicit `style` (only `contentContainerStyle`, unlike the
  category row above it, which needed one for its own pinned-gear-icon
  layout) - without it, the row could size its own frame wrong before
  content was measured, clipping the top of tall-ascender letters
  (visible on "Roof"/"Blocking", invisible on short words like "All").
- **Mobile Jobs list filter bar**: the "All categories"/"All stages"/
  Clear row had no `flexWrap`, so a long lifecycle stage name pushed the
  row past the screen edge instead of wrapping.
- **Mobile Job Detail's Category/Stage picker fields**: these are the
  only picker fields in the app that lay a color swatch and the label
  out side-by-side in a row - every other picker field just puts the
  label alone in a plain column, which sizes correctly on its own. In a
  row, a `Text` next to a fixed-width sibling needs `flexShrink` to be
  properly constrained by Yoga; without it, a name just over one line's
  width (e.g. "Scheduled", "Enquiry") silently lost its last character
  or two instead of wrapping onto a second line - visible as e.g.
  "Schedule"/"Enquir" with room still left in the box, not a hard clip
  at the border (which is what made this one hard to spot from the
  bug report alone - screenshots were what nailed the exact cause).
- **Mobile Job Setup's category/stage rows**: crammed a name, two tags
  (Default/Closed), and four action links (Up/Down/Edit/Delete) into one
  unwrapped horizontal row, squeezing long stage names down to nothing.
  Split into a label row and an actions row, both wrapping.
- **Mobile calendar "stuck on event card"**: creating an event from
  Schedule's "tap an unassigned job" flow (or the Calendar tab's own
  FAB) used `router.replace()` to swap the "new event" form for the
  created event's detail screen. Since `replace()` only rewrites history
  *within the Calendar tab's own nested stack*, this left the detail
  screen with nothing to pop back to at all - no back arrow, a genuine
  dead end, regardless of which screen the flow started from. Popping
  the form first, then pushing the detail on top, restores a real back
  step.

Two other reports turned out not to be code bugs: the "Job is done in
this stage" toggle reverting, and mobile calendar missing colors, were
both already fixed in earlier commits (the boolean-write connector fix
and the per-category tile coloring, respectively) - if either is still
showing up, the device is running a build from before those commits,
not hitting a live bug. EAS preview builds don't auto-update; the
specific new APK has to be downloaded and reinstalled each time.

### Deploy

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx vercel --prod
```
```powershell
cd apps\mobile
eas build --platform android --profile preview
```
No Supabase migration in this batch - every fix here is UI-only.

## 60. Job Card Quote Tools module

A "Quote Tools" hub added to the Job Card: the Roof Area Tool, a linear
distance measurer, an on-site material tally counter, a photo markup/
annotation editor, a concrete volume calculator, and a material order
form - all six tools, on both desktop and mobile (see "60a" below for
the v2 pass that merged Roof Area in and closed the mobile gap).

### Scope decisions (read this before touching these tables)

- **All four new tables reference `job_cards`, not a `jobs` table** -
  same spec-writer assumption the Asana task engine's own migration
  comment already corrected once this session.
- **No new `communication_logs` table.** Every tool's "Save to Job
  Notes" action inserts into the existing `job_notes` table directly -
  same table job_measurements' own "Save & Append to Job Card" flow
  already uses, no duplicate table needed.
- **The desktop Job Card has no tab system today** - it's one long
  scrolling page of bordered sections (Photos, Job Costing, Notes, ...),
  not tabs, so "add a Quote Tools tab" became a new section
  (`QuoteToolsSection`) with its own internal sub-tab bar for the 6
  tools, matching how the page actually works rather than introducing a
  page-wide tab system for one section for it.
- **`job_material_orders.order_number` is server-assigned** via the
  existing generic `next_reference_number()` helper (same mechanism as
  job/quote/invoice numbers) - "MAT-001", "MAT-002", ... - never set by
  the client.
- **`job_material_orders.pdf_url` stays unpopulated for now.** Desktop's
  own PDF "export" everywhere else (e.g. the Inventory shopping list) is
  a browser print dialog, not a stored file - the Material Order PDF
  follows that same pattern (`buildMaterialOrderPdfHtml` +
  `lib/print.ts`'s `exportPdf`), so there's no file to point `pdf_url`
  at. "Email Order to Supplier" reuses the existing `EmailComposeModal`
  + `queueAndSendEmail` plumbing (the same free-form-email pattern the
  job card's own "Email" button already uses) with the order details in
  the message body - not a real PDF-generation-and-storage-and-attach
  pipeline, which would be a separate feature in its own right.
- **`job_concrete_calculations` has no `updated_at`/update policy** -
  matches the spec's own column list; a recalculation is a new row, not
  an edit-in-place, same append-style-history reasoning as
  job_measurements' own facets.
- **Photo Markup's annotated filename doesn't literally get the
  `_annotated` suffix as the displayed `file_name`** on desktop -
  `uploadJobPhoto` (shared, used by every photo upload in this app)
  always assigns a UUID-based storage filename regardless of the
  `File` object's own name; touching that shared helper for one caller's
  cosmetic naming wasn't worth it. The annotated photo does show up as
  a distinct new photo in the gallery either way.

### Database (`supabase/migrations/20260910000100_quote_tools.sql`)

`job_linear_measurements` (named sets of straight-line runs, each a
jsonb array of `{id, label, coordinates, length_meters}` segments),
`job_material_tallies` (jsonb array of `{id, name, count, category}`
items), `job_concrete_calculations` (one-shot calculation records), and
`job_material_orders` (jsonb array of `{item_name, quantity, unit_type,
notes}` line items, `material_order_status` enum). RLS mirrors
`job_measurements` exactly on all four: visible/writable via the parent
`job_cards` row's own admin-or-assigned-technician rule, admin-only
delete.

Empirically tested against a local Postgres 16 instance before being
considered done: a minimal mirrored schema plus the existing
`next_reference_number()`/`tenant_counters` machinery this migration's
order-number trigger depends on, the real migration applied on top,
then real inserts covering all four tables, confirming the
`assign_material_order_number` trigger assigns "MAT-001" then "MAT-002"
sequentially, the per-tenant unique constraint rejects a duplicate
order number, and the `updated_at` trigger fires on the tables that have
one.

### Shared (`packages/shared/src`)

New `LinearMeasurementSegment`/`JobLinearMeasurement`,
`MaterialTallyItem`/`JobMaterialTally`, `JobConcreteCalculation`, and
`MaterialOrderLineItem`/`JobMaterialOrder`/`MaterialOrderStatus` types
in `types.ts`; matching Zod schemas in `schemas.ts`. Not added to
PowerSync - see the mobile section below.

### Desktop (`apps/desktop/src`)

`components/quote-tools/QuoteToolsSection.tsx` renders the sub-tab bar
(Roof Area links out to the existing `/jobs/:id/measure` route; the
other 5 are inline panels) and owns the one piece of state shared
between two sibling tools - `transferredTallyItems`, populated by
Material Tally's "Transfer to Material Order Form" button and consumed
by the Material Order form, a pure in-memory handoff since both tools
are mounted at once. `LinearMeasurer.tsx` is modeled directly on
`JobMeasure.tsx`'s map/click/overlay pattern (polygons there, polylines
here), using the same `loadGoogleMaps()` helper - now also loading the
`geometry` library for `google.maps.geometry.spherical.computeLength()`.
`MaterialTally.tsx` is a walkthrough counter with 44px +/- steppers and
`truncate` on item names. `PhotoMarkup.tsx` is a plain HTML5 `<canvas>`
editor (pen/line/arrow/rect/circle/text, 5-color palette, stroke
thickness, undo/redo/clear) - no external drawing library, the shape set
is small enough that hand-rolled redraw-from-shape-list is simpler than
pulling one in. `ConcreteCalculator.tsx` computes volume/bags live as
you type. `MaterialOrderForm.tsx` builds line items manually or via the
tally transfer, and exports/emails via `lib/material-order-pdf.ts` +
`lib/print.ts` / `EmailComposeModal`.

### Mobile (`apps/mobile`)

Per the spec's own explicit mobile scope (native touch support for the
Material Counter and Photo Markup tool only, not the full desktop
suite): the Job Card screen gained a third tab, "Quote Tools", visible
to every role (unlike "Job Costing", which stays admin-only) -
`components/MaterialTallyCounter.tsx` (same counter idea, native
44px steppers) and `components/PhotoMarkupEditor.tsx`. There's no
`<canvas>` in React Native, so the markup editor uses `react-native-svg`
for live shape rendering (the same approach `SignaturePad.tsx` already
uses for a single freehand path, extended to five more shape types) over
an `Image` background, then rasterizes the whole Image+Svg overlay to a
PNG via `react-native-view-shot`'s `ViewShot.capture()` - both libraries
were already installed and already used elsewhere in this app for
exactly this "flatten a touch-drawn overlay to a real image" step, nothing
new pulled in. No Redo on mobile (Undo only) - a deliberate trim to keep
the touch toolbar to one row, not an oversight. Text annotations use a
small custom modal (`CenteredModal` + `FormField`) rather than
`Alert.prompt`, which is iOS-only in React Native.

Both tools are Supabase-direct (not PowerSync) - same "occasional site
tool, needs connectivity" treatment as Reports & Safety and Purchase
Orders, not the "must always work offline" treatment tasks/jobs/notes
get. Linear Measurer, Concrete Calculator, and Material Order Form were
not built for mobile at all, per the spec's own scope.

### Deploy

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx supabase db push
npx vercel --prod
```

A new EAS build is needed for the mobile Quote Tools tab to reach
devices already installed from a prior build.

### Test it

1. Open a job -> "Quote Tools" section -> "Linear Measurer" -> "+ New
   Measurement Set" -> name it -> "+ New Run" -> click the map a few
   times -> "Finish run" -> add a second run -> confirm the total length
   sums both -> Save -> confirm it lists below with "Copy Summary to Job
   Notes" -> click it -> confirm a note appears on the job.
2. "Material Tally" -> type a few material names, adjust counts with
   +/- -> "Save Tally to Job Notes" -> confirm a formatted note appears
   -> add another tally -> "Transfer to Material Order Form" -> confirm
   it switches tabs with those items pre-filled as line items.
3. "Photo Markup" -> pick an existing job photo -> draw with each tool
   (pen, line, arrow, rectangle, circle, text) in a couple of colors ->
   Undo one -> Save -> confirm a new `..._annotated.png` photo appears in
   the job's Photos section.
4. "Concrete Calculator" -> enter length/width/depth -> confirm the m³
   and bag count update live -> Save -> confirm it appears in "Past
   calculations" and a note appears on the job.
5. "Material Order" -> add a couple of line items manually -> Save ->
   confirm it shows an auto-assigned "MAT-001" number -> "Export
   Material Order PDF" -> confirm the browser print dialog opens with
   the order details -> "Email Order to Supplier" -> confirm the
   composer pre-fills the order details -> send.
6. Mobile: open a job -> "Quote Tools" tab (visible to both admin and
   technician logins) -> Material Tally counter works with large touch
   steppers -> Photo Markup: pick a downloaded photo, draw a couple of
   shapes plus a text annotation, Save -> confirm the annotated photo
   appears in Photos.

### Known gaps / judgment calls

- **No admin UI restricting who can delete a tool's records beyond the
  existing admin-only RLS** - matches job_measurements' own existing
  behavior, not a new gap introduced here.
- **`job_material_orders.pdf_url`/real PDF attachment on the emailed
  order** - see the scope decision above; the PDF export and the email
  are two independent actions (print-dialog PDF vs. a text-body email),
  not one "attach the exported PDF to the email" flow.
- **Mobile doesn't get the Linear Measurer, Concrete Calculator, or
  Material Order Form** - per the spec's own explicit mobile scope
  (Material Counter + Photo Markup only). Revisit if a technician-facing
  need for the others shows up.
- **No Redo on mobile's Photo Markup** (Undo only) - see the mobile
  section above.
- Not tested in a real browser against a live Supabase project, live
  Google Maps key, or a real device/EAS build - this sandbox has none of
  those. Verified: `tsc --noEmit` clean across `apps/desktop`,
  `apps/mobile`, `packages/shared`; a production `vite build` clean for
  `apps/desktop`; and the new migration applied and empirically
  sanity-tested (inserts, constraints, the order-number trigger's exact
  sequence, the unique-order-number rejection) against a real local
  Postgres 16 instance, same bar as every other migration in this repo.

## 60a. Quote Tools v2 - Roof Area merged in, full mobile parity

Follow-up to section 60, prompted by feedback that the Roof Area Tool
still felt bolted-on next to the other five, and that mobile was missing
three of the six tools entirely. No new tables or migration - this is a
UI consolidation on top of the existing `job_measurements` /
`job_linear_measurements` / `job_concrete_calculations` /
`job_material_orders` schema.

- **Roof Area is now one of the six Quote Tools sub-tabs, not a separate
  page, on both platforms.** Desktop: `JobMeasure.tsx` and its
  `/jobs/:id/measure` route are gone; its logic now lives in
  `components/quote-tools/RoofAreaTool.tsx`, an embeddable version that
  toggles a local `drawing` flag instead of navigating (a `resetDraft()`
  after save instead of `navigate()`). `JobDetail.tsx`'s old standalone
  "Roof Measurement" card is removed - `QuoteToolsSection` is the only
  place it renders now. Mobile: `sales/jobs/measure.tsx` and its route are
  gone; `components/MeasureRoofTool.tsx` is the embeddable equivalent
  (same PowerSync-backed `job_measurements`/`job_notes` writes,
  `react-native-maps` drawing), wired into the Job Card's "Quote Tools"
  tab alongside the others. `job_measurements` stays the one Quote Tools
  table that's PowerSync-synced (pre-dates the other five, which are
  plain-Supabase) - that split is unchanged, just no longer split across
  two different screens per platform.
- **`packages/shared/src/geo.ts` gained `polylineLengthMeters()`** - same
  equirectangular-projection approach as the existing
  `polygonFlatAreaSqm()`/`trueAreaSqm()` (one shared reference latitude,
  planar distance between consecutive points), added so the Linear
  Measurer's distance total is computed identically on both platforms.
  Desktop's `LinearMeasurer.tsx` switched from
  `google.maps.geometry.spherical.computeLength()` to this shared
  function (dropping the `geometry` library from `lib/google-maps.ts`'s
  `loadGoogleMaps()` load chain, since nothing needs it anymore); mobile
  has no Google geometry library available via `react-native-maps` at
  all, so this was the only way to get matching totals rather than two
  independently-rounded numbers from two different formulas.
- **Mobile now has all six tools**, closing the gap from section 60's
  "Mobile doesn't get the Linear Measurer, Concrete Calculator, or
  Material Order Form" known gap - that scope-down was the original
  spec's own explicit call, superseded here:
  - `components/LinearMeasurerTool.tsx` - `react-native-maps` `Polyline`
    drawing, same named-runs/segments model as desktop, Supabase-direct
    (`job_linear_measurements` isn't a PowerSync table).
  - `components/ConcreteCalculatorTool.tsx` - same
    volume = L×W×D×(1+waste%), bags = volume×108 formula, live as you
    type.
  - `components/MaterialOrderFormTool.tsx` - line items manual or
    transferred from Material Tally, a `DateField` for delivery date
    (converted to a plain `YYYY-MM-DD` string on save) instead of
    desktop's `<input type="date">`, a status-chip row (the same
    "row of pressable pills" pattern purchase orders already use on
    mobile, not desktop's `<select>`) instead of `SelectField` (mobile
    has no such component), PDF export via `lib/material-order-pdf.ts` +
    `lib/print.ts`'s `exportPdf` (expo-print + the native share sheet,
    not a browser print dialog), and email send via the same inline
    `scheduled_communications` insert + `triggerImmediateDispatch` +
    `Alert.alert` pattern the job card's own free-form email button
    already uses (mobile has no shared `queueAndSendEmail` helper).
  - `MaterialTallyCounter.tsx` gained the same "Transfer to Material
    Order Form" button desktop's `MaterialTally.tsx` has (an optional
    `onTransferToOrder` prop), and `jobs/[id].tsx` gained the matching
    `transferredTallyItems` in-memory handoff state.
  - The Job Card's "Quote Tools" tab now lists all six tools in the same
    order as desktop's sub-tab bar: Roof Area, Linear Measurer, Material
    Tally, Concrete Calculator, Material Order, Photo Markup.
- **Not done**: converting mobile's "Quote Tools" tab from one long
  stacked list of sections into a sub-tab switcher matching desktop's
  `QuoteToolsSection` (button row + one panel at a time) - all six tools
  are present and functional, just laid out as sequential sections rather
  than sub-tabs. Worth revisiting if the stacked list gets unwieldy on a
  phone-sized screen.
- Verified: `tsc --noEmit` clean across `apps/desktop` and `apps/mobile`;
  a production `vite build` clean for `apps/desktop`. Not tested against
  a live Google Maps key, a real device, or an EAS build - same sandbox
  limitation as section 60. A new EAS build is needed for the mobile
  changes here to reach devices already installed from a prior build.

## 61. Membership Module (Munus)

A "Membership" offer layered on top of the existing client/job/quote/
invoice schema, not a replacement for any of it - same shape as the Real
Estate & Strata module. Clients pay an annual fee (tenant-configurable,
one plan per tenant for now) for: no call-out fee, a discount on repairs/
installations, priority scheduling, an included annual roof inspection,
an included annual plumbing check, and a same-day response guarantee.
Built as four migration batches (mirroring Real Estate & Strata's own
phased-migration style) plus Edge Functions and desktop/mobile UI.

### Corrections to the original brief, found during research

- **This codebase already had Stripe integration** (`supabase/functions/
  approve` + `stripe-webhook`, a single platform-level `STRIPE_SECRET_KEY`
  used for invoice payment links) - contrary to the initial assumption of
  no existing Stripe usage. Membership's Stripe Connect flow is a
  genuinely new, parallel mechanism (per-tenant connected accounts, not
  one shared platform account), matching the existing code's *style* (raw
  `fetch`, hand-verified webhook signatures, no stripe-node SDK) but not
  reusing its functions - different auth model, different webhook
  endpoint/secret entirely.
- **Quote/invoice totals are never trusted from the client** -
  `subtotal_cents`/`gst_cents`/`total_cents` are always recomputed
  server-side from stored line items (`calculate_line_item_totals`,
  confirmed by `atomic_line_item_rpcs.sql`'s own header comment). This
  meant the membership discount couldn't be a client-side calculation
  like the Quote Tools' Concrete Calculator - it had to be threaded into
  that same server-side totals machinery, recomputed on every line-item
  save.
- The `communication_templates` "duplicate seed rows -> duplicate sends"
  bug some earlier migrations' own comments describe as still-unfixed was
  actually fixed by `fix_duplicate_communication_templates.sql` (a real
  unique constraint + `ON CONFLICT` guard) before this module was built -
  confirmed by reading the actual latest state rather than an out-of-date
  comment, since building on the wrong assumption would have meant either
  silently dropping the fix or re-introducing the duplicate-send bug.

### Batch 1 - `20260911000100_membership_plans_and_clients.sql`

`membership_plans` (tenant-wide read, admin-only write - same shape as
`price_book_items`; one active plan per tenant enforced by a partial
unique index, deliberately the *only* thing standing between this and
multi-tier support later), `client_memberships` (tenant-wide read so a
technician can see "this client is a Member" for job context, admin-only
write since enrollment goes through Stripe Checkout / the webhook),
`membership_benefit_usage` (tenant-wide read+insert - a technician logs a
benefit's use from the field, same shape as `scheduled_communications`).
`price_book_items.is_callout_fee` and `tenants.stripe_connect_account_id`/
`stripe_connect_onboarded` added. The `(client_membership_id, benefit_type,
period_start)` unique constraint on `membership_benefit_usage` is the
actual mechanism preventing a client using the same included benefit
twice in one billing year.

Empirically tested against a local Postgres 16 instance (14 checks): the
partial unique indexes correctly reject a second active row while
allowing a second inactive/cancelled one, the benefit-usage anti-double-
use constraint, and RLS (cross-tenant isolation, non-admin read-only,
admin write).

### Batch 2 - `20260912000100_membership_discount_engine.sql`

`quotes`/`invoices` gain `client_membership_id`, `membership_discount_
percent`, `membership_discount_cents`, `membership_discount_overridden`;
their line items gain `is_callout_fee` and `waived_amount_cents`. A
waiver is never a lossy price overwrite - `unit_price_cents` stays the
catalogue price forever, `waived_amount_cents` is what's actually
subtracted at totals time, so turning an admin override back off fully
and correctly re-derives the auto figures from scratch. `calculate_line_
item_totals`/`replace_quote_line_items`/`replace_invoice_line_items`/
`convert_quote_to_invoice` all route through a new `apply_membership_
adjustments` helper. The override is a sticky flag (mirroring
`nte_exceeded_approved`'s shape) that survives further line-item edits;
`set_quote_membership_discount_override`/`set_invoice_membership_
discount_override` toggle it. `convert_quote_to_invoice` re-checks
membership status live rather than trusting the quote's cached figures.

GST is computed on the net (post-waiver) amount per line; the percentage
discount is a lump-sum reduction to the GST-inclusive total rather than a
tax-recalculation - a judgment call worth revisiting if the person wants
the discount itself to reduce the taxable amount.

Empirically tested (6 scenarios): the discount/waiver math exactly as
designed, override persistence across line-item edits and full reversal
when turned off, and a client enrolling in a membership *between* quoting
and invoice conversion correctly getting the waiver on the invoice (not
the quote's stale unmembered state).

### Batch 3 - `20260913000100_membership_communications.sql`

Five new `trigger_key`s (`membership_welcome`, `membership_renewal_
upcoming`, `membership_payment_failed`, `membership_cancelled`,
`membership_annual_benefit_reminder`), seeded via the same full-
cumulative redefinition every trigger_key in this schema uses.
`membership_welcome` fires on a `client_memberships` `INSERT` (status
active at creation); `membership_payment_failed`/`membership_cancelled`
fire on `UPDATE` watching status transitions - deliberately not
deduplicated against a prior send, since a membership can flap active ->
past_due -> active -> past_due again and each transition is real news.
`membership_renewal_upcoming`/`membership_annual_benefit_reminder` have
no natural row-change event, so a new daily cron-swept Edge Function
(`process-membership-reminders`, same shape as `process-real-estate-
maintenance`) detects and queues them. The benefit reminder sends ONE
combined message per membership per period (not one per unused benefit) -
`{membership_benefit_type}` resolves to a joined label at send time,
computed live against `membership_benefit_usage`, sidestepping a need for
a benefit-type-specific idempotency column. `process-scheduled-comms` and
`packages/shared/src/placeholders.ts` both gained a `client_membership`
context/token set.

Empirically tested (8 scenarios): a pre-existing tenant's backfill adds
exactly the 5 new rows (31 total, not duplicated even run twice), each
trigger fires exactly once per real status transition, unrelated column
updates don't double-fire anything, and a disabled rule correctly
suppresses the message.

### Batch 4 - Stripe Connect Edge Functions (no migration)

- **`stripe-connect-onboard`** - starts/resumes Express Connect onboarding
  for a tenant (admin-only), storing `stripe_connect_account_id`/
  `onboarded`. Express, not Standard - keeps onboarding embedded in this
  app's own Settings page rather than handing the tenant an independent
  Stripe dashboard.
- **`create-membership-checkout`** - admin-only; creates (or reuses) a
  Stripe Checkout Session in subscription mode *on the tenant's connected
  account* (every call carries the `Stripe-Account` header), given a
  `client_id`. Lazily creates the plan's Stripe Product/Price the first
  time it's needed (persisting `membership_plans.stripe_price_id`),
  reuses an existing Stripe customer for the client if one already
  exists from a past enrollment.
- **`membership-stripe-webhook`** - a *separate* webhook endpoint and
  signing secret from the existing `stripe-webhook` (Connect events, not
  platform events - new env var `STRIPE_CONNECT_WEBHOOK_SECRET`). Handles
  `checkout.session.completed` (inserts the `client_memberships` row -
  this is what fires `membership_welcome`), `customer.subscription.
  updated`/`deleted`, and `invoice.paid`/`invoice.payment_failed` - keeps
  `status`/`current_period_start`/`current_period_end` in sync. No
  communication-sending logic lives in this file at all; every status
  transition it produces fires the right message automatically via
  Batch 3's triggers.

### Shared (`packages/shared/src`)

New `MembershipStatus`/`MembershipBenefitType`/`MembershipPlan`/
`MembershipBenefitsSnapshot`/`ClientMembership`/`MembershipBenefitUsage`
types and `membershipPlanFormSchema`/`recordMembershipBenefitUsageSchema`
schemas. `Quote`/`Invoice`/`Tenant`/`PriceBookItem` gained their new
columns; `LineItemInput.is_callout_fee`/`waived_amount_cents` and
`PriceBookItem.is_callout_fee` are optional (not required, even though
the DB columns are NOT NULL) so the existing line-item-editor and
price-book-editor call sites across desktop/mobile that build these
objects without them still compile - not yet surfaced as editable toggles
anywhere in the UI (see Known gaps below). Also fixed two pieces of
pre-existing drift found while touching this area: `ScheduledCommunication
EntityType`/`scheduledCommunicationEntityTypeSchema` were missing four
entity types several later migrations had already added (`referral_
partner`/`report`/`purchase_order`/`subcontractor`), and `communication
TemplateCategorySchema` was missing `'partner'`.

### Desktop (`apps/desktop/src`)

`pages/Membership.tsx` (new sidebar link, same structural pattern as
`RealEstate.tsx`) - manage the tenant's one plan (price, benefit toggles,
active flag) and a read-only list of current/past members. `components/
ClientMembershipSection.tsx` on the client detail page - enrol (creates a
Checkout link via `create-membership-checkout` for the admin to copy/send
to the client, mirroring how invoice payment links already work), current
benefit-usage-this-period list, cancel, past-membership history.
`Settings.tsx` gained a "Membership - Stripe Connect" block (same
bearer-token-POST-to-an-Edge-Function shape as the existing Xero/Google
Calendar connect buttons) - unlike those OAuth flows, Stripe's own Express
onboarding just drops the tenant back at `return_url` with no status
attached, so the return leg re-calls the same `stripe-connect-onboard`
function, which already has an "account exists, check its current state"
branch. `Dispatch.tsx`'s Unassigned shelf shows a "Member - Priority"
badge and sorts member-client jobs above non-member jobs (stable
secondary sort, `priority_scheduling`'s tangible effect). `Jobs.tsx`'s and
`ClientDetail.tsx`'s "New Job" modals show a same-day-response reminder
banner when the selected/current client is an active member.

### Mobile (`apps/mobile`)

`components/MembershipStatusCard.tsx` - Supabase-direct (not PowerSync,
same "occasional, needs connectivity" treatment as `MaterialTallyCounter`
- membership status changes happen through the office + Stripe, not from
the field), renders nothing for a non-member client. Shows the status
badge, the benefit chips derived from `benefits_snapshot` ("No call-out
fee", "X% off repairs", "Priority scheduling", "Same-day response"), and
a used/not-yet-used line per included benefit type this period - exactly
the "this client is a Member, no call-out fee, hasn't used their annual
roof inspection yet" field visibility the brief asked for. Dropped into
both the client detail screen (FlatList header, own horizontal margin)
and the job detail screen (already-padded section, no extra margin - the
component itself takes no horizontal margin so it composes correctly in
either container).

### Deploy

New Stripe Dashboard step beyond what already existed for invoice
payments: enable Connect and create a *separate* Connect webhook endpoint
(Developers -> Webhooks -> the **Connect** tab, not the main platform
tab) pointed at the deployed `membership-stripe-webhook` URL, subscribed
to `checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
Set its signing secret as `STRIPE_CONNECT_WEBHOOK_SECRET` (distinct from
the existing `STRIPE_WEBHOOK_SECRET`).

**Important, confirmed against a real account**: Stripe does NOT allow an
existing merchant account (one already accepting payments for its own
business - which is exactly what the invoice-payment feature's account
is) to also become a Connect platform. Attempting to enable Connect on
that account instead shows "Connect is not available for this account -
please create a new account to build a Connect integration. The new
account will be automatically linked to you." Click through that flow to
create the new (linked, same login) platform account, then generate an
API key from THAT account specifically (Developers -> API keys, while
that new account is the one selected in the account switcher, not the
original merchant account) and set it as its own secret -
`STRIPE_CONNECT_SECRET_KEY`, deliberately distinct from the existing
`STRIPE_SECRET_KEY` the invoice-payment feature already uses, since they
are now provably two different Stripe accounts with two different keys,
not one shared platform key as originally assumed:

```powershell
git pull origin claude/template-risk-client-updates-7ljk6t
npx supabase db push
npx supabase secrets set STRIPE_CONNECT_SECRET_KEY=sk_test_or_live_new_platform_account_key_here
npx supabase functions deploy stripe-connect-onboard
npx supabase functions deploy create-membership-checkout
npx supabase functions deploy membership-stripe-webhook --no-verify-jwt
npx supabase functions deploy process-membership-reminders --no-verify-jwt
npx vercel --prod
```

`process-membership-reminders` needs its own daily `pg_cron` schedule
(separate from `process-scheduled-comms`'s 5-minute sweep), same one-time
SQL-editor step every other cron-swept function in this repo needed:

```sql
select cron.schedule(
  'process-membership-reminders-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/process-membership-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
  );
  $$
);
```

A new EAS build is needed for the mobile changes here to reach devices
already installed from a prior build.

### Test it

1. Settings -> "Membership - Stripe Connect" -> Connect Stripe -> confirm
   redirect to Stripe's Express onboarding, then back to Settings showing
   "Connected".
2. Membership page -> set a plan (price, discount %, toggles, included
   benefits) -> Save -> confirm it persists.
3. A client's detail page -> Membership section -> Enrol in Membership ->
   confirm a Checkout link is generated -> complete payment as the client
   -> confirm `membership_welcome` fires and the client's card now shows
   Active with the plan's benefits.
4. Create a quote/invoice for that member client including a call-out-fee
   line item -> confirm it's waived ("Waived - Membership" reflected in
   `waived_amount_cents`) and the discount is applied to the rest,
   `membership_discount_cents` stored on the document.
5. Dispatch board -> confirm the member's unassigned job shows "Member -
   Priority" and sorts above non-member jobs.
6. Mobile -> open that client or one of their jobs -> confirm the
   Membership card shows Active, the right benefit chips, and correct
   used/not-yet-used benefit lines.
7. Cancel the Stripe subscription (or the client detail page's own Cancel
   button) -> confirm `membership_cancelled` fires and status updates
   everywhere.
8. Price Book -> open an item -> toggle "This is the call-out / service
   fee" -> Save -> reopen -> confirm it stuck. Add that item to a member
   client's quote/invoice via the price book search -> Save -> confirm the
   line shows "Waived - Membership" and the Total matches the persisted
   `total_cents` (subtotal + GST - `membership_discount_cents`).
9. Open a job for a member client with included benefits (desktop
   `JobDetail.tsx` or mobile `jobs/[id].tsx`) -> "Mark as used" on an
   unused benefit -> confirm it now shows "Used this period" and a second
   click on the same benefit (or another job) surfaces "Already used this
   period" instead of erroring.

### Known gaps / judgment calls

- ~~No UI yet to flag a price_book_items row as `is_callout_fee`~~ **Closed.**
  The Price Book item editor (desktop `PriceBookItem.tsx`, mobile
  `price-book/items/[id].tsx` and `new.tsx`) now has a "This is the
  call-out / service fee" toggle, persisted via `createPriceBookItemSchema`'s
  new `is_callout_fee` field. `AddLineItemBar` (both apps) carries the flag
  onto the line item when it's added to a quote/invoice from the catalogue.
  Quote/invoice line item editors and the client-facing summary now show a
  per-line "Waived - Membership" label (and a "Call-out fee" badge) wherever
  `waived_amount_cents > 0`, on-screen and on the generated PDF (both apps'
  PDF builders). `money.ts`'s `lineItemSubtotalCents` now also subtracts
  `waived_amount_cents` before summing a document's subtotal/GST, and every
  totals display (`TotalsBox`/`LineItemSummary`, both PDF builders) shows a
  "Membership discount" row and folds `membership_discount_cents` into the
  displayed Total - previously these all silently disagreed with the
  persisted `total_cents` the moment a membership discount applied, since
  neither the per-line waiver nor the document-level percentage discount was
  reflected client-side. `set_quote_membership_discount_override`/
  `set_invoice_membership_discount_override` (the manual override RPCs)
  still have no UI control - out of scope for this pass, since nothing in
  the original ask named them specifically.
- **GST is not recalculated as reduced by the percentage discount** - see
  Batch 2's own note; the discount is a lump-sum reduction to the
  GST-inclusive total, not a taxable-amount recalculation.
- ~~No admin UI for `membership_benefit_usage`~~ **Closed.** Desktop's
  `JobDetail.tsx` gained a `JobMembershipBenefitSection` (new component)
  and mobile's `MembershipStatusCard` gained an optional `jobCardId` prop -
  when supplied (from `jobs/[id].tsx`), each not-yet-used included benefit
  gets a "Mark as used" action. Both platforms proactively re-query
  `membership_benefit_usage` for the current period before inserting (per
  the original spec) and show "Already used this period - bill this visit
  as billable instead" if a record already exists, falling back to the same
  message on a `23505` unique-violation for the rare race. Records
  `job_card_id`/`client_membership_id`/`benefit_type`/`period_start`/
  `period_end`/`created_by` via the existing `recordMembershipBenefitUsageSchema`.
- Not tested against a live Stripe account (real or test-mode Connect
  account, a real webhook delivery, or a real Checkout completion) or a
  real device/EAS build - this sandbox has none of those. Verified:
  `tsc --noEmit` clean across `packages/shared`, `apps/desktop`,
  `apps/mobile`; a production `vite build` clean for `apps/desktop`; all
  four migrations empirically tested (28 total sanity checks across
  Batches 1-3) against a real local Postgres 16 instance, same bar as
  every other migration in this repo. The three Stripe Connect Edge
  Functions have no Deno runtime available in this sandbox to typecheck -
  verified by careful review and structural brace/paren balance checks
  instead, same limitation as every other Edge Function added this
  session.
