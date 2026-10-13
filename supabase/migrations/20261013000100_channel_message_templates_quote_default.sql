-- "Send Quote via SMS" previously had a hardcoded default body baked into
-- the desktop/mobile code (QUOTE_SMS_TEMPLATE) that the admin could only
-- edit per-send, never persist - unlike the email flow, whose default body
-- comes from an editable communication_templates row (quote_sent). This
-- adds the equivalent for SMS: an admin marks one channel_message_templates
-- row per tenant as the Quote-SMS default, and the Quote detail screen
-- looks that up instead of using the hardcoded string. Falls back to the
-- old hardcoded body in code if no default is set yet (e.g. a brand new
-- tenant with no templates at all), so sending never blocks on this being
-- configured - same spirit as the rest of this feature being a manual,
-- always-available tool rather than another automated-engine dependency.
alter table public.channel_message_templates
  add column is_quote_default boolean not null default false;

-- At most one default per tenant - enforced here rather than purely in the
-- app, so a races/bug in the "unset the old one, set the new one" two-step
-- update can never silently leave two defaults active.
create unique index channel_message_templates_one_quote_default_per_tenant
  on public.channel_message_templates (tenant_id)
  where is_quote_default;

-- Backfill: give every existing tenant a starting "Quote via SMS" template,
-- pre-filled with the exact text that used to be hardcoded, so nothing
-- changes for a tenant that hasn't touched this yet - they can rename/edit/
-- unset it like any other template.
insert into public.channel_message_templates (tenant_id, name, body, is_quote_default)
select id, 'Quote via SMS', 'Hi {client_first_name}, here''s your quote from {company_name}: {quote_approval_link}. Reply if you have any questions.', true
from public.tenants;
