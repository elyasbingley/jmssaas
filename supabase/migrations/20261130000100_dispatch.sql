-- Dispatch board rebuild (desktop Dispatch: Map, Schedule, Stages, Tasks,
-- Recurring).
--
-- geocode_cache: the map needs coordinates for job addresses. The desktop
-- looks an address up with Google once and saves it here, so the map
-- doesn't pay for (or wait on) the same lookup every time it opens. Keyed
-- by the normalised address text, per company; anyone in the company can
-- read and add (the map is used by the whole office).
--
-- job_cards.stage_changed_at: when the job last moved stage, so the Stages
-- board can show how long a job has sat in its column.

create table public.geocode_cache (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  address_key text not null check (btrim(address_key) <> ''),
  lat double precision,
  lng double precision,
  formatted_address text,
  -- 'ok', or 'not_found' so an address Google can't place isn't retried
  -- on every load.
  status text not null default 'ok' check (status in ('ok', 'not_found')),
  created_at timestamptz not null default now(),
  unique (tenant_id, address_key)
);

alter table public.geocode_cache enable row level security;
create policy "geocode_cache: tenant read" on public.geocode_cache
  for select using (tenant_id = public.current_tenant_id());
create policy "geocode_cache: tenant insert" on public.geocode_cache
  for insert with check (tenant_id = public.current_tenant_id());
create policy "geocode_cache: tenant update" on public.geocode_cache
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());

alter table public.job_cards add column stage_changed_at timestamptz;
update public.job_cards set stage_changed_at = coalesce(updated_at, created_at) where stage_changed_at is null;
alter table public.job_cards alter column stage_changed_at set default now();

create or replace function public.job_cards_stamp_stage_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.lifecycle_stage_id is distinct from old.lifecycle_stage_id then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger job_cards_stamp_stage_change
  before insert or update of lifecycle_stage_id on public.job_cards
  for each row execute function public.job_cards_stamp_stage_change();

-- PowerSync publications that list tables one by one don't need
-- geocode_cache (desktop only); job_cards' new column travels with it.
