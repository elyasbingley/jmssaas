-- Client model extensions:
--   1. client_type/company_name - a client is either a 'company' (e.g. a
--      property manager with several staff you deal with) or an
--      'individual' (a regular COD homeowner) - `name` keeps meaning
--      "primary contact / full name" for both, company_name is only set
--      (and only shown) when client_type = 'company'. This mirrors the
--      exact split the person asked for: "Copano Property Services" as a
--      company, a COD job as just a person's name, never both jammed into
--      one field.
--   2. client_contacts - a client (especially a company) can have several
--      people you actually deal with, not just the one `name`/`email`/
--      `phone` on the clients row itself.
--   3. workdrive_url on clients and job_cards - a pasted link to that
--      client's/job's WorkDrive folder, nothing more (no API integration,
--      this app never talks to WorkDrive itself).
--   4. site_id on quotes/invoices - client_sites already exists and
--      job_cards.site_id already points at it (see init_schema), but quotes
--      and invoices had no way to record which of a client's addresses they
--      were for, defaulting silently to the client's own single address.
--      Nullable: a quote/invoice with no site keeps falling back to the
--      client's primary address, same as before this migration.

create type public.client_type as enum ('individual', 'company');

alter table public.clients
  add column client_type public.client_type not null default 'individual',
  add column company_name text,
  add column workdrive_url text;

alter table public.job_cards
  add column workdrive_url text;

alter table public.quotes
  add column site_id uuid references public.client_sites (id);

alter table public.invoices
  add column site_id uuid references public.client_sites (id);

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index client_contacts_tenant_id_idx on public.client_contacts (tenant_id);
create index client_contacts_client_id_idx on public.client_contacts (client_id);

alter table public.client_contacts enable row level security;

create policy "client_contacts: tenant isolation - select" on public.client_contacts
  for select using (tenant_id = public.current_tenant_id());

create policy "client_contacts: tenant isolation - insert" on public.client_contacts
  for insert with check (tenant_id = public.current_tenant_id());

create policy "client_contacts: tenant isolation - update" on public.client_contacts
  for update using (tenant_id = public.current_tenant_id());

create policy "client_contacts: admin deletes" on public.client_contacts
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Carry the quote's site_id over to the invoice it's converted into, same
-- as every other quote field this function already copies across.
create or replace function public.convert_quote_to_invoice(
  p_quote_id uuid,
  p_due_date date,
  p_invoice_number text default null
)
returns uuid
language plpgsql
as $$
declare
  v_quote public.quotes;
  v_items jsonb;
  v_totals record;
  v_invoice_id uuid := gen_random_uuid();
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'Quote % not found', p_quote_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'item_type', item_type,
        'description', description,
        'quantity', quantity,
        'unit_price_cents', unit_price_cents,
        'gst_applicable', gst_applicable,
        'sort_order', sort_order
      )
      order by sort_order
    ),
    '[]'::jsonb
  )
  into v_items
  from public.quote_line_items
  where quote_id = p_quote_id;

  select * into v_totals from public.calculate_line_item_totals(v_items);

  insert into public.invoices (
    id, tenant_id, client_id, job_card_id, quote_id, site_id, invoice_number, status,
    issue_date, due_date, subtotal_cents, gst_cents, total_cents, notes, created_by
  ) values (
    v_invoice_id, v_quote.tenant_id, v_quote.client_id, v_quote.job_card_id, v_quote.id, v_quote.site_id, p_invoice_number, 'draft',
    current_date, p_due_date, v_totals.subtotal_cents, v_totals.gst_cents, v_totals.total_cents, v_quote.notes, auth.uid()
  );

  insert into public.invoice_line_items (
    id, tenant_id, invoice_id, item_type, description, quantity, unit_price_cents, gst_applicable, sort_order
  )
  select
    gen_random_uuid(),
    v_quote.tenant_id,
    v_invoice_id,
    item_type,
    description,
    quantity,
    unit_price_cents,
    gst_applicable,
    sort_order
  from public.quote_line_items
  where quote_id = p_quote_id;

  return v_invoice_id;
end;
$$;
