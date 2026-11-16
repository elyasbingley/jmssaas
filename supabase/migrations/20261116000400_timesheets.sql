-- Timesheets: what each person worked, and where the time went.
--
--   timesheet_shifts          one row per clock-on / clock-off
--   timesheet_activities      what the time inside a shift was spent on -
--                             a job, travel, a break, or admin/yard
--   timesheet_week_approvals  an admin signing off one person's Mon-Sun
--                             week, which locks that week's entries
--
-- Activities are not children of a shift (no shift_id): they belong to a
-- shift only by overlapping it in time. Entries are written offline on a
-- phone and uploaded later, in whatever order and however late; a parent
-- key would turn "the shift was corrected in the office meanwhile" into a
-- foreign-key failure on upload.
--
-- That is the rule behind every choice below: NOTHING HERE MAY REJECT A
-- WRITE COMING FROM A PHONE. apps/mobile's PowerSync connector retries a
-- failed upload forever, so one rejected row would stop every later
-- change on that device (job notes, tasks, everything) from ever syncing.
-- So there are no CHECK constraints on times, no "one open shift" unique
-- index, and the approved-week lock skips a change instead of raising -
-- the device then simply syncs back to what the server kept. Bad or
-- overlapping times are surfaced by the reports, not blocked here.

create type public.timesheet_activity_type as enum ('job', 'travel', 'break', 'admin');

create table public.timesheet_shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  started_at timestamptz not null,
  -- Null while the person is still clocked on.
  ended_at timestamptz,
  -- One GPS reading at each tap, when the phone allowed it. No tracking
  -- in between.
  start_latitude double precision,
  start_longitude double precision,
  start_accuracy_m double precision,
  end_latitude double precision,
  end_longitude double precision,
  end_accuracy_m double precision,
  -- 'timer' = tapped live on a phone; 'manual' = typed in afterwards.
  source text not null default 'timer',
  note text,
  -- Set by the guard trigger, never by a client, whenever a recorded time
  -- is changed after the fact.
  edited_at timestamptz,
  edited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.timesheet_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  activity_type public.timesheet_activity_type not null,
  -- Set for a 'job' activity. Goes null if the job is later deleted - the
  -- time was still worked.
  job_card_id uuid references public.job_cards (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  start_latitude double precision,
  start_longitude double precision,
  start_accuracy_m double precision,
  end_latitude double precision,
  end_longitude double precision,
  end_accuracy_m double precision,
  source text not null default 'timer',
  note text,
  edited_at timestamptz,
  edited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.timesheet_week_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- The Monday the approved week starts on.
  week_start date not null,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz not null default now(),
  unique (profile_id, week_start)
);

create index timesheet_shifts_profile_started_idx on public.timesheet_shifts (profile_id, started_at);
create index timesheet_shifts_tenant_started_idx on public.timesheet_shifts (tenant_id, started_at);
create index timesheet_activities_profile_started_idx on public.timesheet_activities (profile_id, started_at);
create index timesheet_activities_tenant_started_idx on public.timesheet_activities (tenant_id, started_at);
create index timesheet_activities_job_card_id_idx on public.timesheet_activities (job_card_id);
create index timesheet_week_approvals_tenant_week_idx on public.timesheet_week_approvals (tenant_id, week_start);

create trigger set_timesheet_shifts_updated_at
  before update on public.timesheet_shifts
  for each row execute function public.set_updated_at();
create trigger set_timesheet_activities_updated_at
  before update on public.timesheet_activities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Weeks run Monday-Sunday in Sydney time (the same zone the communication
-- engine's quiet hours already assume), so "which week is this entry in"
-- has one answer whatever zone a phone or browser happens to be set to.
-- ---------------------------------------------------------------------------

create or replace function public.timesheet_week_start(p_at timestamptz)
returns date
language sql
stable
as $$
  select date_trunc('week', p_at at time zone 'Australia/Sydney')::date
$$;

-- One guard for both entry tables. See the header comment: it never
-- raises.
--   INSERT  always goes in. If it lands in a week that was already
--           approved (a phone that was offline for days), the approval is
--           removed so the week shows as needing sign-off again, rather
--           than real worked time being thrown away.
--   UPDATE / DELETE of an entry in an approved week is skipped.
--   UPDATE that changes a recorded time, or what an activity was, stamps
--           edited_at/edited_by. Stopping a running timer (ended_at going
--           from null to a value) is not an edit.
create or replace function public.timesheet_entry_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked boolean;
begin
  if tg_op = 'INSERT' then
    delete from public.timesheet_week_approvals
    where profile_id = new.profile_id and week_start = public.timesheet_week_start(new.started_at);
    return new;
  end if;

  select exists (
    select 1 from public.timesheet_week_approvals a
    where a.profile_id = old.profile_id and a.week_start = public.timesheet_week_start(old.started_at)
  ) into v_locked;

  if not v_locked and tg_op = 'UPDATE' then
    select exists (
      select 1 from public.timesheet_week_approvals a
      where a.profile_id = new.profile_id and a.week_start = public.timesheet_week_start(new.started_at)
    ) into v_locked;
  end if;

  if v_locked then
    return null;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.started_at is distinct from old.started_at
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
     or (to_jsonb(new) -> 'activity_type') is distinct from (to_jsonb(old) -> 'activity_type')
     or (to_jsonb(new) -> 'job_card_id') is distinct from (to_jsonb(old) -> 'job_card_id') then
    new.edited_at := now();
    new.edited_by := auth.uid();
  else
    new.edited_at := old.edited_at;
    new.edited_by := old.edited_by;
  end if;
  return new;
end;
$$;

-- Named to sort before set_timesheet_*_updated_at, so a skipped update
-- never reaches it.
create trigger guard_timesheet_shifts
  before insert or update or delete on public.timesheet_shifts
  for each row execute function public.timesheet_entry_guard();
create trigger guard_timesheet_activities
  before insert or update or delete on public.timesheet_activities
  for each row execute function public.timesheet_entry_guard();

-- Approving is only ever done by an admin from the office app, so this one
-- does raise: a week can't be signed off until it has finished and nobody
-- is still clocked on in it.
create or replace function public.timesheet_approval_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.week_start <> date_trunc('week', new.week_start::timestamp)::date then
    raise exception 'A timesheet week must start on a Monday';
  end if;
  if new.week_start + 7 > (now() at time zone 'Australia/Sydney')::date then
    raise exception 'This week has not finished yet - it can be approved from the following Monday';
  end if;
  if exists (
    select 1 from public.timesheet_shifts s
    where s.profile_id = new.profile_id and s.ended_at is null and public.timesheet_week_start(s.started_at) = new.week_start
  ) or exists (
    select 1 from public.timesheet_activities a
    where a.profile_id = new.profile_id and a.ended_at is null and public.timesheet_week_start(a.started_at) = new.week_start
  ) then
    raise exception 'This person still has a running timer in that week - close it before approving';
  end if;
  if not exists (select 1 from public.profiles p where p.id = new.profile_id and p.tenant_id = new.tenant_id) then
    raise exception 'That person is not in this company';
  end if;
  new.approved_by := coalesce(auth.uid(), new.approved_by);
  return new;
end;
$$;

create trigger check_timesheet_week_approval
  before insert on public.timesheet_week_approvals
  for each row execute function public.timesheet_approval_check();

-- ---------------------------------------------------------------------------
-- RLS: everyone reads and writes their own entries; admins read and write
-- everyone's in their company. Only admins approve. (Select is granted on
-- every table a phone upserts into - PostgREST's upsert is INSERT ... ON
-- CONFLICT DO UPDATE, which needs select as well as insert and update;
-- see the push_tokens_select_policy migration.)
-- ---------------------------------------------------------------------------

alter table public.timesheet_shifts enable row level security;
alter table public.timesheet_activities enable row level security;
alter table public.timesheet_week_approvals enable row level security;

create policy "timesheet_shifts: own or admin - select" on public.timesheet_shifts
  for select using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_shifts: own or admin - insert" on public.timesheet_shifts
  for insert with check (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_shifts: own or admin - update" on public.timesheet_shifts
  for update using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()))
  with check (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_shifts: own or admin - delete" on public.timesheet_shifts
  for delete using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));

create policy "timesheet_activities: own or admin - select" on public.timesheet_activities
  for select using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_activities: own or admin - insert" on public.timesheet_activities
  for insert with check (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_activities: own or admin - update" on public.timesheet_activities
  for update using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()))
  with check (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_activities: own or admin - delete" on public.timesheet_activities
  for delete using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));

create policy "timesheet_week_approvals: own or admin - select" on public.timesheet_week_approvals
  for select using (tenant_id = public.current_tenant_id() and (profile_id = auth.uid() or public.is_admin()));
create policy "timesheet_week_approvals: admin - insert" on public.timesheet_week_approvals
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "timesheet_week_approvals: admin - delete" on public.timesheet_week_approvals
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- PowerSync replicates through a publication named "powersync". If it was
-- created FOR ALL TABLES these are already in it; if it lists tables one
-- by one, add them. A project with no such publication is left alone.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'powersync' and not puballtables) then
    alter publication powersync add table public.timesheet_shifts, public.timesheet_activities, public.timesheet_week_approvals;
  end if;
end $$;
