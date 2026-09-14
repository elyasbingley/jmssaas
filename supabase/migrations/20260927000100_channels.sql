-- Channels - a consolidated per-client communications hub (SMS, WhatsApp,
-- Facebook Messenger, Instagram DMs), two-way (you can reply from the
-- app, not just view), with "create a job/task from this conversation"
-- the same way Inbox lets you create a job from an email. Email itself is
-- NOT duplicated into these tables - the Channels UI folds the existing
-- inbox_messages rows in as a virtual "email" conversation (grouped by
-- from_email) at query time, so there is exactly one source of truth for
-- email and no risk of the two ever drifting apart.
--
-- Phase 1 (this migration + the matching Edge Functions) only wires SMS
-- all the way through (inbound webhook + outbound send, via Twilio) - see
-- docs/SETUP.md's own note on why: WhatsApp needs Meta Business
-- verification and approved message templates before you can message a
-- new contact first, and Messenger/Instagram both need Meta App Review
-- before a SaaS can message through a business's own Page/IG account at
-- all (an external process only the tenant/platform owner can submit).
-- channel_connections exists for all four non-email types from day one so
-- the schema doesn't need to change again once those are ready - they
-- just sit at status 'not_connected' until then.
--
-- A second SMS attempt on purpose: docs/SETUP.md's "SMS removed" section
-- names the two real bugs from last time (wrong Twilio credentials/From
-- number, and phone numbers stored in local AU format instead of E.164) -
-- both are process/data-hygiene bugs, not a reason SMS can't work, hence
-- packages/shared's new toE164 helper and this schema storing every phone
-- number pre-normalised.

create type public.channel_type as enum ('sms', 'whatsapp', 'messenger', 'instagram');
create type public.channel_connection_status as enum ('not_connected', 'connected');
create type public.channel_message_direction as enum ('inbound', 'outbound');

-- One row per tenant per non-email channel type, tracking whether it's
-- usable yet. `config` is a free-form jsonb blob (Postgres doesn't
-- validate its internal shape, same pattern as report_templates'
-- structure_schema) since each channel type needs different fields - e.g.
-- {"phone_number": "+61..."} for sms, {"page_id": "...", "access_token
-- handled server-side only": true} for messenger once that's built. No
-- OAuth token ever belongs in this table directly if/when Messenger/
-- Instagram connect - store those the same service-role-only,
-- never-exposed-to-the-client way xero_connections/
-- google_calendar_connections already do, in a table of their own.
create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  channel_type public.channel_type not null,
  status public.channel_connection_status not null default 'not_connected',
  config jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel_type)
);

create trigger set_channel_connections_updated_at
  before update on public.channel_connections
  for each row execute function public.set_updated_at();

-- One row per external contact per channel (a phone number for sms/
-- whatsapp, a Page-Scoped ID for messenger, an Instagram-Scoped ID for
-- instagram) - the thread the side panel opens. client_id is set once a
-- message from this contact is matched to (or used to create) a client,
-- same "attach now, not before" idea as Inbox's linked_job_id.
create table public.channel_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  channel_type public.channel_type not null,
  external_contact text not null,
  contact_name text,
  client_id uuid references public.clients (id) on delete set null,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  unread_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, channel_type, external_contact)
);

create index channel_conversations_tenant_id_idx on public.channel_conversations (tenant_id);
create index channel_conversations_last_message_idx on public.channel_conversations (tenant_id, last_message_at desc);

create table public.channel_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.channel_conversations (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  direction public.channel_message_direction not null,
  body text,
  -- Array of {storage_path, file_name, mime_type} - inbound MMS/WhatsApp
  -- media only in this pass (see the channel-send-message Edge Function's
  -- own comment on why outbound is text-only for now).
  media jsonb not null default '[]'::jsonb,
  external_message_id text,
  status text not null default 'sent' check (status in ('sent', 'delivered', 'failed', 'received')),
  sent_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index channel_messages_conversation_id_idx on public.channel_messages (conversation_id);

insert into storage.buckets (id, name, public)
values ('channel-media', 'channel-media', false)
on conflict (id) do nothing;

create policy "channel-media: tenant read" on storage.objects
  for select using (
    bucket_id = 'channel-media'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

-- No insert/update/delete storage policies for authenticated users - every
-- object is written by the inbound webhook (service role, bypasses RLS),
-- same as inbox-attachments.

alter table public.channel_connections enable row level security;
alter table public.channel_conversations enable row level security;
alter table public.channel_messages enable row level security;

create policy "channel_connections: tenant read" on public.channel_connections
  for select using (tenant_id = public.current_tenant_id());
create policy "channel_connections: admin writes - insert" on public.channel_connections
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "channel_connections: admin writes - update" on public.channel_connections
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "channel_connections: admin writes - delete" on public.channel_connections
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "channel_conversations: tenant read" on public.channel_conversations
  for select using (tenant_id = public.current_tenant_id());
-- Admin can relink a conversation to a different/new client or reset
-- unread_count on open - inserts/last_message updates are always done by
-- the service-role webhook or send function, never directly by a client.
create policy "channel_conversations: admin writes - update" on public.channel_conversations
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "channel_messages: tenant read" on public.channel_messages
  for select using (tenant_id = public.current_tenant_id());

-- Each tenant's own SMS-capable number (E.164, e.g. "+61491570156") -
-- bought/ported by the tenant in the platform's Twilio account and pasted
-- into Company Settings; the inbound webhook matches an incoming
-- message's `To` number against this column to find the right tenant,
-- same "look up tenant by the address a message arrived at" shape as
-- inbox_local_part.
alter table public.tenants add column sms_phone_number text unique;
