-- Row Level Security: every business table is scoped to the caller's
-- tenant_id, resolved server-side from their profile row (never trusted
-- from client input). Phase 1 has exactly one tenant, but every policy
-- here is written as if there were many, so Phase 3 multi-tenancy needs
-- no policy rewrite - just more tenants.

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can read profiles without
-- recursing into the RLS policy that also guards profiles).
-- ---------------------------------------------------------------------------

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role() = 'admin', false)
$$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;

create policy "tenants: read own tenant" on public.tenants
  for select using (id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

create policy "profiles: read within tenant" on public.profiles
  for select using (tenant_id = public.current_tenant_id());

create policy "profiles: update own profile" on public.profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid() and tenant_id = public.current_tenant_id());

create policy "profiles: admin manages tenant profiles" on public.profiles
  for update
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

-- Row creation happens via the handle_new_user trigger (security definer)
-- when an admin provisions an account through the Supabase Admin API, not
-- via direct client inserts.

-- ---------------------------------------------------------------------------
-- clients / client_sites - tenant-wide read, tenant-wide write (small crew,
-- everyone needs to be able to add a client on site)
-- ---------------------------------------------------------------------------

alter table public.clients enable row level security;

create policy "clients: tenant isolation - select" on public.clients
  for select using (tenant_id = public.current_tenant_id());

create policy "clients: tenant isolation - insert" on public.clients
  for insert with check (tenant_id = public.current_tenant_id());

create policy "clients: tenant isolation - update" on public.clients
  for update using (tenant_id = public.current_tenant_id());

create policy "clients: admin deletes" on public.clients
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.client_sites enable row level security;

create policy "client_sites: tenant isolation - select" on public.client_sites
  for select using (tenant_id = public.current_tenant_id());

create policy "client_sites: tenant isolation - insert" on public.client_sites
  for insert with check (tenant_id = public.current_tenant_id());

create policy "client_sites: tenant isolation - update" on public.client_sites
  for update using (tenant_id = public.current_tenant_id());

create policy "client_sites: admin deletes" on public.client_sites
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- job_cards - admin sees/manages everything; technicians see and edit only
-- jobs assigned to them
-- ---------------------------------------------------------------------------

alter table public.job_cards enable row level security;

create policy "job_cards: select own or admin" on public.job_cards
  for select using (
    tenant_id = public.current_tenant_id()
    and (public.is_admin() or assigned_technician_id = auth.uid())
  );

create policy "job_cards: admin creates" on public.job_cards
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "job_cards: update own or admin" on public.job_cards
  for update using (
    tenant_id = public.current_tenant_id()
    and (public.is_admin() or assigned_technician_id = auth.uid())
  );

create policy "job_cards: admin deletes" on public.job_cards
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- job_notes / job_files - visibility follows the parent job card
-- ---------------------------------------------------------------------------

alter table public.job_notes enable row level security;

create policy "job_notes: select via parent job" on public.job_notes
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_notes.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_notes: insert via parent job" on public.job_notes
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_notes.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

alter table public.job_files enable row level security;

create policy "job_files: select via parent job" on public.job_files
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_files.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_files: insert via parent job" on public.job_files
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_files.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job_files: admin deletes" on public.job_files
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- tasks - admin sees/manages everything; technicians see and update only
-- tasks assigned to them
-- ---------------------------------------------------------------------------

alter table public.tasks enable row level security;

create policy "tasks: select own or admin" on public.tasks
  for select using (
    tenant_id = public.current_tenant_id()
    and (public.is_admin() or assigned_to = auth.uid())
  );

create policy "tasks: admin creates" on public.tasks
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "tasks: update own or admin" on public.tasks
  for update using (
    tenant_id = public.current_tenant_id()
    and (public.is_admin() or assigned_to = auth.uid())
  );

create policy "tasks: admin deletes" on public.tasks
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- templates, quotes, invoices - office/money workflow, admin-managed;
-- readable tenant-wide so a tech can see what was quoted on their job
-- ---------------------------------------------------------------------------

alter table public.templates enable row level security;

create policy "templates: tenant read" on public.templates
  for select using (tenant_id = public.current_tenant_id());

create policy "templates: admin writes - insert" on public.templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "templates: admin writes - update" on public.templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "templates: admin writes - delete" on public.templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.quotes enable row level security;

create policy "quotes: tenant read" on public.quotes
  for select using (tenant_id = public.current_tenant_id());

create policy "quotes: admin writes - insert" on public.quotes
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quotes: admin writes - update" on public.quotes
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quotes: admin writes - delete" on public.quotes
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.quote_line_items enable row level security;

create policy "quote_line_items: tenant read" on public.quote_line_items
  for select using (tenant_id = public.current_tenant_id());

create policy "quote_line_items: admin writes - insert" on public.quote_line_items
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quote_line_items: admin writes - update" on public.quote_line_items
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "quote_line_items: admin writes - delete" on public.quote_line_items
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.invoices enable row level security;

create policy "invoices: tenant read" on public.invoices
  for select using (tenant_id = public.current_tenant_id());

create policy "invoices: admin writes - insert" on public.invoices
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoices: admin writes - update" on public.invoices
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoices: admin writes - delete" on public.invoices
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.invoice_line_items enable row level security;

create policy "invoice_line_items: tenant read" on public.invoice_line_items
  for select using (tenant_id = public.current_tenant_id());

create policy "invoice_line_items: admin writes - insert" on public.invoice_line_items
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoice_line_items: admin writes - update" on public.invoice_line_items
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "invoice_line_items: admin writes - delete" on public.invoice_line_items
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- calendar_events - tenant-wide read (everyone needs the calendar);
-- admin manages events, or the tech on the linked job/task can reschedule it
-- ---------------------------------------------------------------------------

alter table public.calendar_events enable row level security;

create policy "calendar_events: tenant read" on public.calendar_events
  for select using (tenant_id = public.current_tenant_id());

create policy "calendar_events: admin creates" on public.calendar_events
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "calendar_events: admin or linked assignee updates" on public.calendar_events
  for update using (
    tenant_id = public.current_tenant_id()
    and (
      public.is_admin()
      or exists (
        select 1 from public.job_cards jc
        where jc.id = calendar_events.job_card_id and jc.assigned_technician_id = auth.uid()
      )
      or exists (
        select 1 from public.tasks t
        where t.id = calendar_events.task_id and t.assigned_to = auth.uid()
      )
    )
  );

create policy "calendar_events: admin deletes" on public.calendar_events
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
