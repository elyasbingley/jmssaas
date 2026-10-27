-- WhatsApp broadcasts - send one whatsapp_templates row to many clients at
-- once (marketing to a list of existing clients, e.g. a seasonal reminder),
-- each as its own ordinary 1:1 WhatsApp message via Twilio's Content API,
-- not Twilio's Conversations-API "group" workaround - that only reaches
-- people who've messaged the business in the last 24 hours, useless for
-- reaching clients who haven't been in contact recently, which is exactly
-- the point of a marketing broadcast. A template is required (not a plain
-- body) because WhatsApp's own platform rule is that messaging someone
-- first needs Meta pre-approval - see whatsapp_templates' own comment.
--
-- Two tables, not one row-per-recipient-array-column: a broadcast's own
-- row tracks aggregate progress (total/sent/failed counts, overall status)
-- while whatsapp_broadcast_recipients tracks each send individually
-- (queued/sent/failed, the actual Twilio message SID, any per-recipient
-- error) - mirrors scheduled_communications' own "one row per thing to
-- send, a status column, process in batches" shape (see process-scheduled-
-- comms), reused here instead of overloading that table since a broadcast
-- recipient isn't a scheduled_communications concept (no trigger_key/
-- entity_type, no quiet-hours deferral, per-recipient WhatsApp variables
-- instead of a single rendered body) - unrelated enough that forcing it
-- into that shape would cost more than this small amount of duplication.
create type public.whatsapp_broadcast_status as enum ('sending', 'completed');
create type public.whatsapp_broadcast_recipient_status as enum ('queued', 'sent', 'failed');

create table public.whatsapp_broadcasts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  template_id uuid not null references public.whatsapp_templates (id),
  name text not null,
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  status public.whatsapp_broadcast_status not null default 'sending',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index whatsapp_broadcasts_tenant_id_idx on public.whatsapp_broadcasts (tenant_id);

create table public.whatsapp_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.whatsapp_broadcasts (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id),
  phone text not null,
  -- Positional, zipped against the parent template's variable_labels by
  -- index at send time (["John", "Bingley Trade Services"] -> {{1}}, {{2}}).
  variable_values jsonb not null default '[]'::jsonb,
  status public.whatsapp_broadcast_recipient_status not null default 'queued',
  external_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index whatsapp_broadcast_recipients_broadcast_id_idx on public.whatsapp_broadcast_recipients (broadcast_id);
-- The processor's own work queue - partial index keeps it small regardless
-- of how much broadcast history accumulates, same idea as scheduled_
-- communications' pending-row queries.
create index whatsapp_broadcast_recipients_queued_idx on public.whatsapp_broadcast_recipients (status, created_at) where status = 'queued';

alter table public.whatsapp_broadcasts enable row level security;
alter table public.whatsapp_broadcast_recipients enable row level security;

-- Creation (insert) is admin, same as every other Channels write. There is
-- deliberately no client-side update/delete policy on either table past
-- that: sent_count/failed_count/status and each recipient's own status
-- are only ever advanced by the process-whatsapp-broadcast Edge Function
-- (service role, bypasses RLS) - same "status changes are service-role-
-- only, never directly by a client" shape channel_conversations/
-- channel_messages already use.
create policy "whatsapp_broadcasts: tenant read" on public.whatsapp_broadcasts
  for select using (tenant_id = public.current_tenant_id());
create policy "whatsapp_broadcasts: admin writes - insert" on public.whatsapp_broadcasts
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "whatsapp_broadcast_recipients: tenant read" on public.whatsapp_broadcast_recipients
  for select using (tenant_id = public.current_tenant_id());
create policy "whatsapp_broadcast_recipients: admin writes - insert" on public.whatsapp_broadcast_recipients
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
