-- CSV import for bulk-adding past clients (e.g. a ServiceM8 export) -
-- see the desktop Import from CSV page (apps/desktop/src/pages/
-- ClientImport.tsx). Duplicate detection itself runs client-side during
-- the import preview (name/phone/email against the tenant's existing
-- clients, plus within the file itself) - nothing server-side needs to
-- re-derive that, so this migration is just the two things a review
-- workflow and a marketing list both need to persist:
--
--   1. client_import_batches - one row per completed import, purely a
--      record of what happened (file name, row/duplicate counts) for the
--      Clients page's own history, same "a batch's own row tracks
--      aggregate counts" shape as whatsapp_broadcasts.
--   2. clients.possible_duplicate_of_client_id - set on an imported row
--      the preview flagged as a likely match to an existing client, so
--      it stays findable as a review queue after the fact (the Clients
--      page filters on this) even though nothing blocks the import
--      itself. Nullable FK with "on delete set null", not a hard
--      dependency - clearing it is how "reviewed, looks fine" is
--      recorded (no separate reviewed_at/by - the column being null IS
--      "nothing left to review" for this client).
--   3. clients.marketing_opt_out - needed regardless of import (any
--      client can ask to stop getting marketing texts), added here
--      because a freshly-imported list of old clients is exactly the
--      case this matters most for. Checked by the SMS broadcast
--      recipient picker; set by the inbound-STOP handling in
--      twilio-sms-webhook.

create table public.client_import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  file_name text not null,
  total_rows integer not null default 0,
  imported_count integer not null default 0,
  possible_duplicate_count integer not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index client_import_batches_tenant_id_idx on public.client_import_batches (tenant_id);

alter table public.client_import_batches enable row level security;

-- Same "small crew, mutual trust" shape as clients itself (see
-- rls_policies.sql's own comment on that table) - tenant-wide read and
-- insert, no update/delete policy since a batch row is a plain
-- after-the-fact record nothing ever revises.
create policy "client_import_batches: tenant isolation - select" on public.client_import_batches
  for select using (tenant_id = public.current_tenant_id());
create policy "client_import_batches: tenant isolation - insert" on public.client_import_batches
  for insert with check (tenant_id = public.current_tenant_id());

alter table public.clients
  add column import_batch_id uuid references public.client_import_batches (id) on delete set null,
  add column possible_duplicate_of_client_id uuid references public.clients (id) on delete set null,
  add column marketing_opt_out boolean not null default false;

-- The Clients page's "N possible duplicates to review" banner/filter -
-- partial index keeps it small regardless of how much the client list
-- grows, same idea as every other "only the still-pending rows matter"
-- index in this schema (e.g. scheduled_communications' pending index).
create index clients_possible_duplicate_idx on public.clients (tenant_id) where possible_duplicate_of_client_id is not null;
