-- UX overhaul pass: auto-generated reference numbers, client/job addresses,
-- and task notes/files (parity with job cards).

-- ---------------------------------------------------------------------------
-- Sequential, per-tenant, human-readable reference numbers
--
-- Quotes and invoices are created online-only (direct Supabase inserts from
-- the app - see apps/mobile/app/quotes/new.tsx and invoices/new.tsx), so a
-- single-row-per-tenant counter incremented under a row lock is safe: there's
-- never more than one in-flight insert per tenant racing to claim a number
-- (and even if there were, the UPDATE ... RETURNING below serializes on the
-- counter row, so no two inserts can ever read the same next_value).
--
-- job_cards and tasks are different: they're offline-capable via PowerSync
-- (see packages/shared/src/powersync/schema.ts), so two technicians can each
-- create a job card while both offline, on devices that have no way to
-- coordinate a shared counter. A naive "MAX(number) + 1 on the device"
-- approach would let both devices independently compute the same number and
-- collide the moment they both sync back up - Postgres's unique constraint
-- would then reject the second row's upload, silently losing a technician's
-- work with no clear error surfaced in the UI.
--
-- Chosen approach: reconcile on sync, not on-device. The `number` column on
-- job_cards/tasks starts NULL and is only ever assigned by this same
-- tenant_counters mechanism, running as a BEFORE INSERT trigger in Postgres -
-- i.e. the authoritative assignment happens once the row lands in Postgres
-- via the PowerSync upload path (see apps/mobile/lib/connector.ts's
-- uploadData), not on the device. Two technicians creating job cards offline
-- at the same moment therefore cannot collide - by the time either row is
-- assigned a number, it's already serialized through this one trigger.
-- The tradeoff: a job card/task created offline shows no number (the app
-- displays "Pending sync") until the device reconnects and that row's
-- upload completes and syncs back down - never a fabricated, possibly-wrong
-- number. For a small crew this delay is at most the gap until the next
-- connection, which matches how the rest of the offline-capable data in this
-- app already behaves (see the "isWaitingForFirstSync" gating in
-- apps/mobile/lib/auth-context.tsx for the same "offline first, sync later"
-- posture applied elsewhere). No manual-renumber fallback UI is included in
-- this pass - flagged as a known gap in docs/SETUP.md since a genuine
-- collision is not actually possible with this design (the trigger, not the
-- client, assigns the number), so there is nothing to renumber in practice.

create table public.tenant_counters (
  tenant_id uuid not null references public.tenants (id),
  entity_type text not null,
  next_value int not null default 1,
  primary key (tenant_id, entity_type)
);

create or replace function public.next_reference_number(
  p_tenant_id uuid,
  p_entity_type text,
  p_prefix text,
  p_pad int
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value int;
begin
  insert into public.tenant_counters (tenant_id, entity_type, next_value)
  values (p_tenant_id, p_entity_type, 2)
  on conflict (tenant_id, entity_type)
    do update set next_value = tenant_counters.next_value + 1
  returning next_value - 1 into v_value;

  return p_prefix || lpad(v_value::text, p_pad, '0');
end;
$$;

-- job_cards: J001, J002, ...
alter table public.job_cards add column number text;

create or replace function public.assign_job_card_number()
returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    new.number := public.next_reference_number(new.tenant_id, 'job_card', 'J', 3);
  end if;
  return new;
end;
$$;

create trigger assign_job_cards_number
  before insert on public.job_cards
  for each row execute function public.assign_job_card_number();

create unique index job_cards_tenant_number_unique
  on public.job_cards (tenant_id, number) where number is not null;

-- tasks: TSK001, TSK002, ...
alter table public.tasks add column number text;

create or replace function public.assign_task_number()
returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    new.number := public.next_reference_number(new.tenant_id, 'task', 'TSK', 3);
  end if;
  return new;
end;
$$;

create trigger assign_tasks_number
  before insert on public.tasks
  for each row execute function public.assign_task_number();

create unique index tasks_tenant_number_unique
  on public.tasks (tenant_id, number) where number is not null;

-- quotes: QT001, QT002, ... (online-only - assigned synchronously on insert,
-- always available immediately, no "pending sync" state needed)
create or replace function public.assign_quote_number()
returns trigger
language plpgsql
as $$
begin
  if new.quote_number is null or new.quote_number = '' then
    new.quote_number := public.next_reference_number(new.tenant_id, 'quote', 'QT', 3);
  end if;
  return new;
end;
$$;

create trigger assign_quotes_number
  before insert on public.quotes
  for each row execute function public.assign_quote_number();

alter table public.quotes alter column quote_number drop not null;

-- invoices: INV001, INV002, ...
create or replace function public.assign_invoice_number()
returns trigger
language plpgsql
as $$
begin
  if new.invoice_number is null or new.invoice_number = '' then
    new.invoice_number := public.next_reference_number(new.tenant_id, 'invoice', 'INV', 3);
  end if;
  return new;
end;
$$;

create trigger assign_invoices_number
  before insert on public.invoices
  for each row execute function public.assign_invoice_number();

alter table public.invoices alter column invoice_number drop not null;

-- ---------------------------------------------------------------------------
-- Client primary address
--
-- client_sites already models job-site addresses (one client can have many,
-- e.g. a commercial client with several properties, each flagged
-- is_primary). The address requested here is different: a single "this is
-- where the client is" field on the client record itself, so it's always on
-- file the moment a client is created - without forcing a client_sites row
-- to exist just to record an address for the common case (one residential
-- client, one address). Kept as separate columns on clients rather than
-- reusing client_sites, since client_sites' is_primary/label/notes columns
-- model something client_sites is for (multiple named sites), not "the
-- client's own address" - conflating the two would make "primary site" and
-- "client's address" the same concept when they're not (a client's billing
-- address and their job site are often different for commercial clients).
-- ---------------------------------------------------------------------------

alter table public.clients
  add column address_line1 text,
  add column address_line2 text,
  add column suburb text,
  add column state text,
  add column postcode text;

-- ---------------------------------------------------------------------------
-- task_notes / task_files - parity with job_notes/job_files, same shape and
-- RLS pattern (visibility follows the parent task, same as job files follow
-- the parent job). Kept as separate tables mirroring job_notes/job_files
-- rather than a polymorphic "notes"/"files" table with a parent_type column:
-- the codebase already has two of these pairs by hand (job_cards and now
-- tasks) and a generic polymorphic table would need its own join logic in
-- every RLS policy anyway (still has to look up the parent row to check
-- assignment), so it wouldn't actually simplify the policies below - it
-- would just trade two clear, statically-typed tables for one table with a
-- runtime-checked parent_type discriminant. Matches the existing convention.
-- ---------------------------------------------------------------------------

-- job_card_id and assigned_to are denormalized from the parent task (kept in
-- sync by the trigger below) rather than joined at query time - PowerSync's
-- sync rules `data` queries are (per its docs, not verified against a live
-- instance in this environment - see the caution at the top of
-- powersync/sync-rules.yaml) single-table selects, so scoping task_notes/
-- task_files to "the job this task belongs to" or "who this task is
-- assigned to" needs those values on the row itself, the same way
-- job_notes/job_files already carry job_card_id directly instead of joining
-- to job_cards.

create table public.task_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  task_id uuid not null references public.tasks (id) on delete cascade,
  job_card_id uuid,
  assigned_to uuid,
  author_id uuid references public.profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index task_notes_tenant_id_idx on public.task_notes (tenant_id);
create index task_notes_task_id_idx on public.task_notes (task_id);

create table public.task_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  task_id uuid not null references public.tasks (id) on delete cascade,
  job_card_id uuid,
  assigned_to uuid,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index task_files_tenant_id_idx on public.task_files (tenant_id);
create index task_files_task_id_idx on public.task_files (task_id);

create or replace function public.stamp_task_note_parent()
returns trigger
language plpgsql
as $$
begin
  select job_card_id, assigned_to into new.job_card_id, new.assigned_to
  from public.tasks where id = new.task_id;
  return new;
end;
$$;

create trigger stamp_task_notes_parent
  before insert on public.task_notes
  for each row execute function public.stamp_task_note_parent();

create or replace function public.stamp_task_file_parent()
returns trigger
language plpgsql
as $$
begin
  select job_card_id, assigned_to into new.job_card_id, new.assigned_to
  from public.tasks where id = new.task_id;
  return new;
end;
$$;

create trigger stamp_task_files_parent
  before insert on public.task_files
  for each row execute function public.stamp_task_file_parent();

alter table public.task_notes enable row level security;

create policy "task_notes: select via parent task" on public.task_notes
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.tasks t
      where t.id = task_notes.task_id
        and (public.is_admin() or t.assigned_to = auth.uid())
    )
  );

create policy "task_notes: insert via parent task" on public.task_notes
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.tasks t
      where t.id = task_notes.task_id
        and (public.is_admin() or t.assigned_to = auth.uid())
    )
  );

alter table public.task_files enable row level security;

create policy "task_files: select via parent task" on public.task_files
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.tasks t
      where t.id = task_files.task_id
        and (public.is_admin() or t.assigned_to = auth.uid())
    )
  );

create policy "task_files: insert via parent task" on public.task_files
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.tasks t
      where t.id = task_files.task_id
        and (public.is_admin() or t.assigned_to = auth.uid())
    )
  );

create policy "task_files: admin deletes" on public.task_files
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Reuses the job-files storage bucket under a `<tenant_id>/task-<task_id>/`
-- prefix rather than creating a second bucket - same tenant-isolation
-- pattern as job-files, just keyed off tasks instead of job_cards.

create policy "job-files: tenant read via task access" on storage.objects
  for select using (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and (storage.foldername(name))[2] like 'task-%'
    and exists (
      select 1 from public.tasks t
      where t.id::text = substring((storage.foldername(name))[2] from 6)
        and t.tenant_id = public.current_tenant_id()
        and (public.is_admin() or t.assigned_to = auth.uid())
    )
  );

create policy "job-files: tenant upload via task access" on storage.objects
  for insert with check (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and (storage.foldername(name))[2] like 'task-%'
    and exists (
      select 1 from public.tasks t
      where t.id::text = substring((storage.foldername(name))[2] from 6)
        and t.tenant_id = public.current_tenant_id()
        and (public.is_admin() or t.assigned_to = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Calendar: location (tappable -> opens Google Maps) and guests. "Link" from
-- the Google-Calendar-style creation flow is deliberately not a separate
-- column - it's free text, same shape as a note, so it belongs in the
-- existing `description` field rather than adding a column that would just
-- duplicate it.
-- ---------------------------------------------------------------------------

alter table public.calendar_events
  add column location text,
  add column guests text;
