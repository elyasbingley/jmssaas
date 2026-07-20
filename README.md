# Bingley Job Management

Job management SaaS for trade businesses, built first as an internal tool for
Bingley Roof Consulting. Phase 1 is a single-tenant MVP: client cards, job
cards, tasks, quotes/invoices and a calendar, offline-first on mobile with
real-time sync to a shared backend. Multi-tenancy, billing and public sign-up
are deliberately out of scope until the workflow is validated in the field
(Phase 3).

See `docs/SETUP.md` to provision the real Supabase/PowerSync services this
repo is scaffolded against.

## Tech stack

- **Backend**: [Supabase](https://supabase.com) (Postgres, Auth, Storage) with
  Row Level Security enforcing tenant isolation on every table from day one
- **Offline sync**: [PowerSync](https://powersync.com) - local SQLite on
  device, bi-directional sync with conflict resolution, writes routed through
  Supabase so RLS applies uniformly
- **Mobile + web**: [Expo](https://expo.dev) / React Native (Expo Router,
  New Architecture) - one codebase for iOS, Android and web
- **Desktop** (planned, not yet scaffolded): [Tauri](https://tauri.app)
  wrapping the same Expo web build
- **Email/Calendar** (planned): Gmail API and Google Calendar API via OAuth,
  sending as the connected Google account rather than a generic transactional
  sender

## Repo structure

```
apps/
  mobile/            Expo app (iOS, Android, web) - Expo Router, PowerSync, Supabase
packages/
  shared/            Cross-platform domain types, zod schemas, GST/quote math,
                      PowerSync client schema (shared by mobile and, later, desktop)
supabase/
  migrations/        Postgres schema + RLS policies + storage bucket policies
  seed.sql           Phase 1 single-tenant seed data
  config.toml        Supabase CLI config
powersync/
  sync-rules.yaml    PowerSync bucket definitions (tenant-scoped)
docs/
  SETUP.md           Provisioning walkthrough (Supabase, PowerSync, Google OAuth)
```

## Development

```bash
pnpm install
pnpm dev:mobile      # starts Expo - press w for web, or scan the QR with Expo Go
pnpm typecheck       # typecheck every workspace package
```

## Data model

Every business table carries `tenant_id`, and Postgres RLS policies (in
`supabase/migrations/20260720000200_rls_policies.sql`) scope every query to the
caller's tenant plus their role (admin sees everything; technicians see and
edit only jobs/tasks assigned to them). Phase 1 runs a single tenant, but
nothing here needs to change to add a second one in Phase 3 - it's a matter of
provisioning another `tenants` row and inviting users into it.

Core entities: `tenants`, `profiles`, `clients` (+ `client_sites`), `job_cards`
(+ `job_notes`, `job_files`), `tasks`, `templates`, `quotes` (+
`quote_line_items`), `invoices` (+ `invoice_line_items`), `calendar_events`.

Only the tables required to be offline-editable per Phase 1 scope - clients,
client sites, job cards, job notes/files, and tasks - are synced to devices via
PowerSync (see `powersync/sync-rules.yaml`). Quotes, invoices, templates and
calendar events are office/PC workflows read directly from Supabase.
