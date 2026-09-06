-- Lead Source - a tenant-customizable dropdown for "how did this job come
-- to us" (Referral, Google, Facebook, Repeat Customer, ...), replacing
-- Jobs.tsx's always-visible referral-partner picker with a proper
-- categorisation. The referral-partner picker itself only appears once a
-- lead source flagged is_referral_source is chosen - is_referral_source
-- (rather than matching on the name "Referral") lets a tenant rename their
-- referral option without breaking that conditional.
--
-- Same shape as service_categories - back-office reference data an admin
-- maintains, tenant-wide read, admin-only write.

create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  is_referral_source boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lead_sources_tenant_id_idx on public.lead_sources (tenant_id);

create trigger set_lead_sources_updated_at
  before update on public.lead_sources
  for each row execute function public.set_updated_at();

alter table public.job_cards
  add column lead_source_id uuid references public.lead_sources (id) on delete set null;

alter table public.lead_sources enable row level security;

create policy "lead_sources: tenant read" on public.lead_sources
  for select using (tenant_id = public.current_tenant_id());

create policy "lead_sources: admin writes - insert" on public.lead_sources
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "lead_sources: admin writes - update" on public.lead_sources
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "lead_sources: admin writes - delete" on public.lead_sources
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- Seeding - same auto-seed-via-handle_new_tenant + one-time-backfill
-- convention as every other default list in this schema.
-- ---------------------------------------------------------------------------

create or replace function public.seed_default_lead_sources(p_tenant_id uuid)
returns void
language plpgsql
as $$
begin
  if exists (select 1 from public.lead_sources where tenant_id = p_tenant_id) then
    return;
  end if;

  insert into public.lead_sources (tenant_id, name, sort_order, is_referral_source)
  values
    (p_tenant_id, 'Referral', 1, true),
    (p_tenant_id, 'Google Search', 2, false),
    (p_tenant_id, 'Facebook / Social Media', 3, false),
    (p_tenant_id, 'Repeat Customer', 4, false),
    (p_tenant_id, 'Signage / Drive-by', 5, false),
    (p_tenant_id, 'Word of Mouth', 6, false),
    (p_tenant_id, 'Other', 7, false);
end;
$$;

create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
as $$
begin
  perform public.seed_default_lifecycle_stages(new.id);
  perform public.seed_default_communication_rules(new.id);
  perform public.seed_default_communication_templates(new.id);
  perform public.seed_default_cost_of_ops_settings(new.id);
  perform public.seed_default_operating_expenses(new.id);
  perform public.seed_default_lead_sources(new.id);
  return new;
end;
$$;

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_lead_sources(t.id);
  end loop;
end;
$$;
