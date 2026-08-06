-- Phase 1 schema. Single tenant in practice, but every business table carries
-- tenant_id from day one so Phase 3 multi-tenancy is a RLS/config change,
-- not a schema rewrite.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.user_role as enum ('admin', 'technician');

create type public.job_status as enum (
  'new', 'scheduled', 'in_progress', 'completed', 'invoiced'
);

create type public.task_status as enum ('todo', 'in_progress', 'done');

create type public.quote_status as enum (
  'draft', 'sent', 'accepted', 'declined', 'expired'
);

create type public.invoice_status as enum (
  'draft', 'sent', 'paid', 'overdue', 'void'
);

create type public.line_item_type as enum (
  'materials', 'labour', 'markup', 'other'
);

create type public.template_type as enum ('quote', 'invoice');

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles (one row per auth.users, drives tenant + role)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  role public.user_role not null default 'technician',
  full_name text not null,
  email text not null,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create index profiles_tenant_id_idx on public.profiles (tenant_id);

-- Auto-create a profile row when an admin provisions a new auth user.
-- Expects tenant_id, role and full_name in raw_user_meta_data (set via the
-- Supabase Admin API when the account is created - see docs/SETUP.md).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, tenant_id, role, full_name, email)
  values (
    new.id,
    (new.raw_user_meta_data ->> 'tenant_id')::uuid,
    coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'technician'),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.email
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- clients + site addresses
-- ---------------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  email text,
  phone text,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

create index clients_tenant_id_idx on public.clients (tenant_id);

create table public.client_sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id) on delete cascade,
  label text,
  address_line1 text not null,
  address_line2 text,
  suburb text not null,
  state text not null,
  postcode text not null,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create index client_sites_tenant_id_idx on public.client_sites (tenant_id);
create index client_sites_client_id_idx on public.client_sites (client_id);

-- ---------------------------------------------------------------------------
-- job cards, notes, files
-- ---------------------------------------------------------------------------

create table public.job_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id),
  site_id uuid references public.client_sites (id),
  title text not null,
  description text,
  status public.job_status not null default 'new',
  assigned_technician_id uuid references public.profiles (id),
  quote_id uuid,
  invoice_id uuid,
  scheduled_at timestamptz,
  completed_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_job_cards_updated_at
  before update on public.job_cards
  for each row execute function public.set_updated_at();

create index job_cards_tenant_id_idx on public.job_cards (tenant_id);
create index job_cards_client_id_idx on public.job_cards (client_id);
create index job_cards_assigned_technician_id_idx on public.job_cards (assigned_technician_id);
create index job_cards_status_idx on public.job_cards (status);

create table public.job_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  author_id uuid references public.profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index job_notes_tenant_id_idx on public.job_notes (tenant_id);
create index job_notes_job_card_id_idx on public.job_notes (job_card_id);

create table public.job_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid not null references public.job_cards (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index job_files_tenant_id_idx on public.job_files (tenant_id);
create index job_files_job_card_id_idx on public.job_files (job_card_id);

-- ---------------------------------------------------------------------------
-- tasks (standalone or linked to a job card)
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_card_id uuid references public.job_cards (id) on delete cascade,
  title text not null,
  description text,
  status public.task_status not null default 'todo',
  assigned_to uuid references public.profiles (id),
  due_date date,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

create index tasks_tenant_id_idx on public.tasks (tenant_id);
create index tasks_job_card_id_idx on public.tasks (job_card_id);
create index tasks_assigned_to_idx on public.tasks (assigned_to);

-- ---------------------------------------------------------------------------
-- templates
-- ---------------------------------------------------------------------------

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  type public.template_type not null,
  name text not null,
  default_line_items jsonb not null default '[]'::jsonb,
  terms_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_templates_updated_at
  before update on public.templates
  for each row execute function public.set_updated_at();

create index templates_tenant_id_idx on public.templates (tenant_id);

-- ---------------------------------------------------------------------------
-- quotes + line items
-- ---------------------------------------------------------------------------

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id),
  job_card_id uuid references public.job_cards (id),
  template_id uuid references public.templates (id),
  quote_number text not null,
  status public.quote_status not null default 'draft',
  issue_date date not null default current_date,
  expiry_date date,
  -- money stored in cents (integer) to avoid float rounding on GST math
  subtotal_cents bigint not null default 0,
  gst_cents bigint not null default 0,
  total_cents bigint not null default 0,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, quote_number)
);

create trigger set_quotes_updated_at
  before update on public.quotes
  for each row execute function public.set_updated_at();

create index quotes_tenant_id_idx on public.quotes (tenant_id);
create index quotes_client_id_idx on public.quotes (client_id);

create table public.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  item_type public.line_item_type not null default 'other',
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_price_cents bigint not null default 0,
  gst_applicable boolean not null default true,
  sort_order int not null default 0
);

create index quote_line_items_tenant_id_idx on public.quote_line_items (tenant_id);
create index quote_line_items_quote_id_idx on public.quote_line_items (quote_id);

-- ---------------------------------------------------------------------------
-- invoices + line items (converted from a quote, or standalone)
-- ---------------------------------------------------------------------------

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id),
  job_card_id uuid references public.job_cards (id),
  quote_id uuid references public.quotes (id),
  invoice_number text not null,
  status public.invoice_status not null default 'draft',
  issue_date date not null default current_date,
  due_date date,
  subtotal_cents bigint not null default 0,
  gst_cents bigint not null default 0,
  total_cents bigint not null default 0,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, invoice_number)
);

create trigger set_invoices_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

create index invoices_tenant_id_idx on public.invoices (tenant_id);
create index invoices_client_id_idx on public.invoices (client_id);

create table public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  item_type public.line_item_type not null default 'other',
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_price_cents bigint not null default 0,
  gst_applicable boolean not null default true,
  sort_order int not null default 0
);

create index invoice_line_items_tenant_id_idx on public.invoice_line_items (tenant_id);
create index invoice_line_items_invoice_id_idx on public.invoice_line_items (invoice_id);

-- job_cards -> quotes/invoices forward references added after both tables exist
alter table public.job_cards
  add constraint job_cards_quote_id_fkey foreign key (quote_id) references public.quotes (id),
  add constraint job_cards_invoice_id_fkey foreign key (invoice_id) references public.invoices (id);

-- ---------------------------------------------------------------------------
-- calendar events (linked to jobs/tasks, two-way synced with Google Calendar)
-- ---------------------------------------------------------------------------

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  job_card_id uuid references public.job_cards (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  google_calendar_id text,
  google_event_id text,
  last_synced_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_calendar_events_updated_at
  before update on public.calendar_events
  for each row execute function public.set_updated_at();

create index calendar_events_tenant_id_idx on public.calendar_events (tenant_id);
create index calendar_events_job_card_id_idx on public.calendar_events (job_card_id);
create index calendar_events_task_id_idx on public.calendar_events (task_id);
create unique index calendar_events_google_event_unique
  on public.calendar_events (tenant_id, google_calendar_id, google_event_id)
  where google_event_id is not null;
