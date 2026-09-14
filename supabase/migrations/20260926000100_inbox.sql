-- Inbox - a ServiceM8-style tenant-specific email address: a client (or
-- anyone) emailing it with a PDF/photo/file gets that file ready to attach
-- to an existing job or create a new one from; an email that's just a text
-- body describing a quote request/work order gets AI-parsed into a
-- suggested job draft for an admin to review (never auto-created - see
-- packages/shared/src/inbox.ts's own comment on why).
--
-- Mail routing: each tenant forwards from their own real inbox (the
-- address their clients already use) to this generated address, rather
-- than clients emailing a platform-branded address directly - see
-- tenants.inbox_local_part below. The receiving side is still one
-- platform-owned domain verified with the email provider's inbound
-- webhook (Resend) - <inbox_local_part>@<that domain> - see the
-- resend-inbound-webhook Edge Function and docs/SETUP.md for the actual
-- domain verification/forwarding-instructions setup, which is an action
-- outside this migration (DNS + the provider's dashboard).
--
-- Office/admin surface only, same "tenant read, admin write" RLS shape as
-- every other admin-scoped module (Subcontractors, Reports, B2B &
-- Referrals) - the inbound webhook and AI-parsing function both run as
-- the service role and bypass RLS entirely, so this only governs what an
-- authenticated app user can see/do with what's already landed.

alter table public.tenants add column inbox_local_part text unique;

create or replace function public.slugify_for_inbox(value text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(value, 'inbox')), '[^a-z0-9]+', '-', 'g'));
$$;

-- Auto-generates a unique local-part (before the @) from the tenant's
-- company name on insert, appending -1/-2/... on collision - same
-- "assigned once, admin can rename later" pattern as everything else
-- generated this way in the app (job/quote/invoice numbers). Only fires
-- when left null, so an admin's own chosen value (set via an app screen
-- after creation) is never overwritten.
create or replace function public.set_tenant_inbox_local_part()
returns trigger
language plpgsql
as $$
declare
  base text;
  candidate text;
  suffix int := 0;
begin
  if new.inbox_local_part is not null then
    return new;
  end if;
  base := public.slugify_for_inbox(new.name);
  candidate := base;
  while exists (select 1 from public.tenants where inbox_local_part = candidate) loop
    suffix := suffix + 1;
    candidate := base || '-' || suffix::text;
  end loop;
  new.inbox_local_part := candidate;
  return new;
end;
$$;

create trigger set_tenant_inbox_local_part
  before insert on public.tenants
  for each row execute function public.set_tenant_inbox_local_part();

-- Backfill any tenant rows that already existed before this migration.
do $$
declare
  t record;
  base text;
  candidate text;
  suffix int;
begin
  for t in select id, name from public.tenants where inbox_local_part is null order by created_at loop
    base := public.slugify_for_inbox(t.name);
    candidate := base;
    suffix := 0;
    while exists (select 1 from public.tenants where inbox_local_part = candidate) loop
      suffix := suffix + 1;
      candidate := base || '-' || suffix::text;
    end loop;
    update public.tenants set inbox_local_part = candidate where id = t.id;
  end loop;
end $$;

create type public.inbox_message_status as enum ('unprocessed', 'needs_review', 'attached', 'dismissed');

create table public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  from_email text not null,
  from_name text,
  subject text,
  body_text text,
  body_html text,
  received_at timestamptz not null default now(),
  status public.inbox_message_status not null default 'unprocessed',
  -- Set once an admin attaches this message's files (or itself, if no
  -- files) to a job - the message stays in the list either way, this just
  -- moves it out of the unprocessed/needs-review queues.
  linked_job_id uuid references public.job_cards (id) on delete set null,
  -- The AI-drafted job suggestion (see InboxJobSuggestion in
  -- packages/shared/src/inbox.ts) - null until the AI-parsing function has
  -- run, and only ever a suggestion: nothing here ever creates a job_cards
  -- row by itself, an admin reviewing it from the Inbox screen does.
  parsed_job_suggestion jsonb,
  parsed_at timestamptz,
  created_at timestamptz not null default now()
);

create index inbox_messages_tenant_id_idx on public.inbox_messages (tenant_id);
create index inbox_messages_status_idx on public.inbox_messages (tenant_id, status);

create table public.inbox_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  message_id uuid not null references public.inbox_messages (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes integer,
  created_at timestamptz not null default now()
);

create index inbox_attachments_message_id_idx on public.inbox_attachments (message_id);

insert into storage.buckets (id, name, public)
values ('inbox-attachments', 'inbox-attachments', false)
on conflict (id) do nothing;

create policy "inbox-attachments: tenant read" on storage.objects
  for select using (
    bucket_id = 'inbox-attachments'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

-- No insert/update/delete policies for authenticated users - every
-- attachment is written by the inbound webhook (service role, bypasses
-- RLS); deleting one only ever happens as part of dismissing/cleaning up
-- a message, also done server-side.

alter table public.inbox_messages enable row level security;
alter table public.inbox_attachments enable row level security;

create policy "inbox_messages: tenant read" on public.inbox_messages
  for select using (tenant_id = public.current_tenant_id());
create policy "inbox_messages: admin writes - update" on public.inbox_messages
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "inbox_messages: admin writes - delete" on public.inbox_messages
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "inbox_attachments: tenant read" on public.inbox_attachments
  for select using (tenant_id = public.current_tenant_id());
