-- Reusable quick-compose text for Channels' SMS/WhatsApp sends ("make
-- template sms messages") - deliberately separate from communication_
-- templates/communication_rules (the trigger_key-driven automated engine).
-- That engine's SMS branch was removed after real Twilio reliability
-- problems (see docs/SETUP.md's "SMS removed" section) and dispatchOne
-- still hard-fails any non-email row - reusing those tables here would
-- risk tangling this manual, one-off "admin picks some canned text while
-- composing a message by hand" feature back into that disabled automated
-- path. This is a plain CRUD table with no trigger/schedule machinery to
-- go wrong: an admin writes a few reusable snippets, the compose UI lets
-- them insert one, and {token} placeholders (packages/shared/src/
-- placeholders.ts's renderTemplate, same token set as communication_
-- templates) get rendered client-side against whatever context is
-- available at insert time - client/company always, quote context too
-- when composing from a Quote.
create table public.channel_message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  body text not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_channel_message_templates_updated_at
  before update on public.channel_message_templates
  for each row execute function public.set_updated_at();

create index channel_message_templates_tenant_id_idx on public.channel_message_templates (tenant_id);

alter table public.channel_message_templates enable row level security;

-- Same "tenant read, admin writes" shape as channel_connections - every
-- tenant member can see the templates (useful context even for whoever's
-- drafting), but actually sending anything through Channels already
-- requires admin (channel-send-message's own role check), so creating/
-- editing/deleting a template is admin-only too.
create policy "channel_message_templates: tenant read" on public.channel_message_templates
  for select using (tenant_id = public.current_tenant_id());
create policy "channel_message_templates: admin writes - insert" on public.channel_message_templates
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "channel_message_templates: admin writes - update" on public.channel_message_templates
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "channel_message_templates: admin writes - delete" on public.channel_message_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
