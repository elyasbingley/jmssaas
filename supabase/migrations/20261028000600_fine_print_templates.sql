-- Fine Print templates - reusable named terms/conditions text blocks an
-- admin manages in Settings, picked from a dropdown on a quote/invoice.
-- Same flat admin-managed/tenant-wide-read shape as job_templates/
-- channel_message_templates (name + body, no children).
--
-- Picking one COPIES its current body onto the quote/invoice's own
-- fine_print_text column below - a frozen snapshot, not a live reference
-- (deliberately no fine_print_template_id FK kept anywhere), same
-- "detached copy" pattern job_templates itself already uses when creating
-- a new job (job_cards has no job_template_id column either). Editing a
-- fine_print_templates row later never changes what an already-created
-- quote/invoice shows - a client should never see terms silently change
-- after being sent something. Once copied, fine_print_text is just a
-- plain editable text field, same as the existing notes column -
-- including staying editable after client acceptance:
-- enforce_accepted_document_money_lock (quote_invoice_approval migration)
-- only locks subtotal_cents/gst_cents/total_cents, not the whole row, so
-- this needs no changes there to match notes' existing behaviour.

create table public.fine_print_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  body text not null default '',
  sort_order int not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_fine_print_templates_updated_at
  before update on public.fine_print_templates
  for each row execute function public.set_updated_at();

create index fine_print_templates_tenant_id_idx on public.fine_print_templates (tenant_id);

alter table public.fine_print_templates enable row level security;

create policy "fine_print_templates: tenant read" on public.fine_print_templates
  for select using (tenant_id = public.current_tenant_id());

create policy "fine_print_templates: admin writes - insert" on public.fine_print_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "fine_print_templates: admin writes - update" on public.fine_print_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "fine_print_templates: admin writes - delete" on public.fine_print_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------

alter table public.quotes add column fine_print_text text;
alter table public.invoices add column fine_print_text text;
