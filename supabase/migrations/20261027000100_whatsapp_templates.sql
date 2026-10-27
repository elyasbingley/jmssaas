-- WhatsApp approved message templates ("Content Templates" in Twilio's own
-- terms, HSMs in WhatsApp's). Deliberately a separate table from
-- channel_message_templates: that table's rows are plain free-text bodies
-- an admin composes once and the app renders client-side via
-- renderTemplate's {token} placeholders - fine for replying within an
-- already-open 24-hour session, but WhatsApp's own platform rule is that
-- messaging someone *first* (no inbound message from them in the last 24h)
-- requires a template pre-approved by Meta, sent by its Content SID
-- (Twilio's "HXxxxxxxxx...") with positional {{1}}, {{2}}... variables
-- filled in per recipient - not a body string the app can just make up.
-- Approval itself happens outside this app entirely (Twilio Console's
-- Content Template Builder, or the Content API, submitted to Meta for
-- review) - this table only records the already-approved template's SID
-- plus enough metadata (a friendly name, the approved copy for reference,
-- and labels for each positional variable) for the app to offer it in the
-- compose/broadcast UI and know what to ask the admin to fill in. See the
-- whatsapp_broadcasts migration for the actual "send this template to many
-- clients" feature this exists to support - sending it to a single
-- contact from an open conversation also uses the same content_sid path
-- (channel-send-message's own comment covers the send side).
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  content_sid text not null,
  -- The approved template's own copy, e.g. "Hi {{1}}, your invoice from
  -- {{2}} is ready: {{3}}." - stored purely for display in this app's own
  -- UI (so an admin can tell templates apart and see what they're sending
  -- without re-opening the Twilio Console); Twilio resolves the actual
  -- send from content_sid server-side regardless of what's stored here.
  body_preview text not null,
  -- One label per positional {{n}} variable in the approved copy, in
  -- order - e.g. ["Client first name", "Company name", "Invoice link"].
  -- Drives the compose/broadcast UI's per-recipient fill-in form; length
  -- mismatches against what Twilio actually expects surface as a Twilio
  -- API error at send time rather than being validated here (this app has
  -- no way to introspect a Content SID's real variable count without
  -- adding a second Twilio API integration just for that).
  variable_labels jsonb not null default '[]'::jsonb,
  -- Lets an admin retire a template (Meta can also later disable one)
  -- without deleting it out from under a broadcast's own history -
  -- whatsapp_broadcasts.template_id references this table and broadcast
  -- history should stay readable.
  is_active boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, content_sid)
);

create trigger set_whatsapp_templates_updated_at
  before update on public.whatsapp_templates
  for each row execute function public.set_updated_at();

create index whatsapp_templates_tenant_id_idx on public.whatsapp_templates (tenant_id);

alter table public.whatsapp_templates enable row level security;

-- Same "tenant read, admin writes" shape as channel_message_templates -
-- every tenant member can see which templates exist, but creating/editing/
-- sending is admin-only (channel-send-message and the broadcast processor
-- both already enforce admin on the send side).
create policy "whatsapp_templates: tenant read" on public.whatsapp_templates
  for select using (tenant_id = public.current_tenant_id());
create policy "whatsapp_templates: admin writes - insert" on public.whatsapp_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "whatsapp_templates: admin writes - update" on public.whatsapp_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "whatsapp_templates: admin writes - delete" on public.whatsapp_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
