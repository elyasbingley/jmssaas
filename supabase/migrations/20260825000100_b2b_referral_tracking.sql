-- B2B Partner & Referral Tracking module (Sales -> B2B & Referrals). Tracks
-- B2B partners, BNI/networking groups, and referral sources; attributes
-- revenue to partners; supports BNI "Thank You For Closed Business" (TYFCB)
-- reporting; tracks referral reciprocity (leads given vs received); and
-- feeds the communication engine for partner appreciation automation
-- (that last part - trigger_keys/templates - lands in a later batch, same
-- as every other multi-batch module in this schema).
--
-- This app has no separate "lead" entity (the spec's "Lead, Quote, and Job
-- creation forms" - see acceptance criteria) - job_cards is the closest
-- equivalent to a booked piece of work, and quotes the closest to a
-- pre-committal one, so referral attribution lands on both of those, not a
-- new leads table.
--
-- Reward money: the spec's single decimal `reward_value` column is split
-- into two typed columns instead - `reward_percent numeric(5,2)` (used when
-- reward_type = 'commission_percent') and `reward_flat_cents bigint` (used
-- for 'flat_fee'/'gift_card') - a single field would be unit-ambiguous (is
-- 5 a 5% commission or $5?), and every other money column in this schema is
-- an explicit `_cents` bigint to avoid float rounding, so a flat dollar
-- reward follows that convention rather than introducing a one-off decimal.
--
-- RLS: referral_groups/referral_partners/referral_reciprocity_logs are
-- back-office reference data an admin maintains - this whole module lives
-- under the desktop-only Sales section with no field-technician surface, so
-- all three follow the agencies/properties shape (tenant-wide read,
-- admin-only write) rather than the job_notes/key_logs "own or admin" shape.

create type public.referral_group_type as enum ('bni_chapter', 'networking_group', 'trade_association', 'corporate_network');
create type public.referral_partner_type as enum (
  'bni_member', 'real_estate_agent', 'builder_contractor', 'architect', 'insurance_adjuster', 'existing_client', 'other_b2b'
);
create type public.referral_partner_tier as enum ('bronze', 'silver', 'gold', 'vip');
create type public.referral_reward_type as enum ('none', 'commission_percent', 'flat_fee', 'gift_card');
create type public.referral_partner_status as enum ('active', 'inactive');

-- ---------------------------------------------------------------------------
-- referral_groups
-- ---------------------------------------------------------------------------

create table public.referral_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  group_type public.referral_group_type not null default 'networking_group',
  meeting_day text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_referral_groups_updated_at
  before update on public.referral_groups
  for each row execute function public.set_updated_at();

create index referral_groups_tenant_id_idx on public.referral_groups (tenant_id);

-- ---------------------------------------------------------------------------
-- referral_partners
-- ---------------------------------------------------------------------------

create table public.referral_partners (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  group_id uuid references public.referral_groups (id) on delete set null,
  company_name text,
  contact_first_name text not null,
  contact_last_name text,
  email text,
  mobile text,
  partner_type public.referral_partner_type not null default 'other_b2b',
  tier public.referral_partner_tier not null default 'bronze',
  reward_type public.referral_reward_type not null default 'none',
  reward_percent numeric(5, 2),
  reward_flat_cents bigint,
  status public.referral_partner_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_referral_partners_updated_at
  before update on public.referral_partners
  for each row execute function public.set_updated_at();

create index referral_partners_tenant_id_idx on public.referral_partners (tenant_id);
create index referral_partners_group_id_idx on public.referral_partners (group_id);

-- ---------------------------------------------------------------------------
-- referral_reciprocity_logs (referrals passed OUT to partners)
-- ---------------------------------------------------------------------------

create table public.referral_reciprocity_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  partner_id uuid not null references public.referral_partners (id) on delete cascade,
  client_name text not null,
  description text,
  estimated_value_cents bigint,
  date_passed date not null default current_date,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index referral_reciprocity_logs_tenant_id_idx on public.referral_reciprocity_logs (tenant_id);
create index referral_reciprocity_logs_partner_id_idx on public.referral_reciprocity_logs (partner_id);

-- ---------------------------------------------------------------------------
-- Referral attribution on job_cards / quotes
-- ---------------------------------------------------------------------------

alter table public.job_cards
  add column referral_partner_id uuid references public.referral_partners (id) on delete set null,
  add column referral_fee_paid boolean not null default false,
  add column referral_fee_amount_cents bigint;

create index job_cards_referral_partner_id_idx on public.job_cards (referral_partner_id);

alter table public.quotes
  add column referral_partner_id uuid references public.referral_partners (id) on delete set null,
  add column referral_fee_paid boolean not null default false,
  add column referral_fee_amount_cents bigint;

create index quotes_referral_partner_id_idx on public.quotes (referral_partner_id);

-- ---------------------------------------------------------------------------
-- invoices.paid_at - needed for the BNI TYFCB engine's date-range filter.
-- invoices.updated_at isn't usable for this (it moves on every unrelated
-- edit, e.g. a notes tweak after payment), so this is a dedicated timestamp
-- set once, the moment status first transitions to 'paid'. Deliberately not
-- cleared if status ever moves off 'paid' again - a TYFCB report should
-- keep reflecting when the money was actually recognised, not silently lose
-- that history because of a later status correction.
-- ---------------------------------------------------------------------------

alter table public.invoices add column paid_at timestamptz;

create or replace function public.set_invoice_paid_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'paid' and old.status is distinct from new.status and new.paid_at is null then
    new.paid_at := now();
  end if;
  return new;
end;
$$;

create trigger set_invoice_paid_at_trigger
  before update on public.invoices
  for each row execute function public.set_invoice_paid_at();

-- ---------------------------------------------------------------------------
-- Referral fee pre-calculation (Workflow 2): when a referred job's invoice
-- is marked paid, compute the referral fee owed from the partner's reward
-- rules and stamp it onto the job as "pending payment" (referral_fee_paid
-- stays false - an admin flips that manually from the B2B module once the
-- partner is actually paid out, there's no bank integration to detect that
-- automatically).
-- ---------------------------------------------------------------------------

create or replace function public.calculate_referral_fee_on_invoice_paid()
returns trigger
language plpgsql
as $$
declare
  v_job public.job_cards;
  v_partner public.referral_partners;
  v_fee_cents bigint;
begin
  if new.status = 'paid' and old.status is distinct from new.status and new.job_card_id is not null then
    select * into v_job from public.job_cards where id = new.job_card_id;
    if v_job.id is not null and v_job.referral_partner_id is not null then
      select * into v_partner from public.referral_partners where id = v_job.referral_partner_id;
      if v_partner.id is not null then
        v_fee_cents := case v_partner.reward_type
          when 'commission_percent' then round(new.total_cents * coalesce(v_partner.reward_percent, 0) / 100)
          when 'flat_fee' then coalesce(v_partner.reward_flat_cents, 0)
          when 'gift_card' then coalesce(v_partner.reward_flat_cents, 0)
          else null
        end;
        if v_fee_cents is not null then
          update public.job_cards set referral_fee_amount_cents = v_fee_cents where id = v_job.id;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger calculate_referral_fee_on_invoice_paid_trigger
  after update on public.invoices
  for each row execute function public.calculate_referral_fee_on_invoice_paid();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.referral_groups enable row level security;

create policy "referral_groups: tenant read" on public.referral_groups
  for select using (tenant_id = public.current_tenant_id());

create policy "referral_groups: admin writes - insert" on public.referral_groups
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "referral_groups: admin writes - update" on public.referral_groups
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "referral_groups: admin writes - delete" on public.referral_groups
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.referral_partners enable row level security;

create policy "referral_partners: tenant read" on public.referral_partners
  for select using (tenant_id = public.current_tenant_id());

create policy "referral_partners: admin writes - insert" on public.referral_partners
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "referral_partners: admin writes - update" on public.referral_partners
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "referral_partners: admin writes - delete" on public.referral_partners
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.referral_reciprocity_logs enable row level security;

create policy "referral_reciprocity_logs: tenant read" on public.referral_reciprocity_logs
  for select using (tenant_id = public.current_tenant_id());

create policy "referral_reciprocity_logs: admin writes - insert" on public.referral_reciprocity_logs
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "referral_reciprocity_logs: admin writes - update" on public.referral_reciprocity_logs
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "referral_reciprocity_logs: admin writes - delete" on public.referral_reciprocity_logs
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
