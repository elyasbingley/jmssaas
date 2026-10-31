-- SMS broadcasts - send a plain-text marketing message to many clients at
-- once, each as its own ordinary SMS (not a group), same two-table shape
-- as whatsapp_broadcasts (one row tracks aggregate progress, one row per
-- recipient tracks its own send) for the same reasoning as that
-- migration's own comment. Simpler than WhatsApp's version in one real
-- way: plain SMS has no Twilio Content Template requirement (that's a
-- WhatsApp-platform rule, not a Twilio one), so there's no ContentSid/
-- ContentVariables split to carry - each recipient's rendered_body is
-- already the exact, final text to send, computed client-side at compose
-- time (packages/shared's renderTemplate, using that recipient's own
-- first_name - see the client_first_last_name migration) and stored as-
-- is. body_template on the parent row is reference-only (what was
-- actually typed, with {client_first_name} still in it), same "frozen
-- snapshot, template text is just for display" convention
-- fine_print_templates/job_templates already use elsewhere.
--
-- Spam Act 2003 compliance is enforced one layer up, not in this schema:
-- the compose screen (apps/desktop/src/pages/SmsBroadcast.tsx) blocks
-- Send unless the message includes an opt-out instruction, and
-- twilio-sms-webhook now watches every inbound reply (not just broadcast
-- replies) for STOP/UNSUBSCRIBE/etc. and sets clients.marketing_opt_out -
-- this table only needs to exclude already-opted-out clients at compose
-- time, which is a plain client-side filter against that column.
create type public.sms_broadcast_status as enum ('sending', 'completed');
create type public.sms_broadcast_recipient_status as enum ('queued', 'sent', 'failed');

create table public.sms_broadcasts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  body_template text not null,
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  status public.sms_broadcast_status not null default 'sending',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index sms_broadcasts_tenant_id_idx on public.sms_broadcasts (tenant_id);

create table public.sms_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.sms_broadcasts (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  client_id uuid not null references public.clients (id),
  phone text not null,
  rendered_body text not null,
  status public.sms_broadcast_recipient_status not null default 'queued',
  external_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index sms_broadcast_recipients_broadcast_id_idx on public.sms_broadcast_recipients (broadcast_id);
create index sms_broadcast_recipients_queued_idx on public.sms_broadcast_recipients (status, created_at) where status = 'queued';

alter table public.sms_broadcasts enable row level security;
alter table public.sms_broadcast_recipients enable row level security;

-- Same shape as whatsapp_broadcasts: creation is admin (desktop is
-- entirely admin-gated already, but this matches that table's own
-- policy rather than assuming that stays true forever), status fields
-- only ever advance via process-sms-broadcast (service role, bypasses
-- RLS) - no client update/delete policy on either table.
create policy "sms_broadcasts: tenant read" on public.sms_broadcasts
  for select using (tenant_id = public.current_tenant_id());
create policy "sms_broadcasts: admin writes - insert" on public.sms_broadcasts
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "sms_broadcast_recipients: tenant read" on public.sms_broadcast_recipients
  for select using (tenant_id = public.current_tenant_id());
create policy "sms_broadcast_recipients: admin writes - insert" on public.sms_broadcast_recipients
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
