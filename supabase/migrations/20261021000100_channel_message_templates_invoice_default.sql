-- "Send Invoice via SMS" - same gap as the quote side before
-- channel_message_templates_quote_default.sql: Invoices had no way at all
-- to send via SMS/Channels (QuoteDetail.tsx/quotes/[id].tsx had it, Invoice
-- detail never did). This adds the equivalent default-template support for
-- invoices, mirroring is_quote_default exactly: an admin marks one
-- channel_message_templates row per tenant as the Invoice-SMS default, and
-- the Invoice detail screen looks that up instead of using a hardcoded
-- fallback string. Falls back to the hardcoded body in code if no default
-- is set yet, so sending never blocks on this being configured.
alter table public.channel_message_templates
  add column is_invoice_default boolean not null default false;

-- At most one default per tenant - same reasoning as the quote index.
create unique index channel_message_templates_one_invoice_default_per_tenant
  on public.channel_message_templates (tenant_id)
  where is_invoice_default;

-- Backfill: give every existing tenant a starting "Invoice via SMS"
-- template, so nothing needs configuring before the feature works.
insert into public.channel_message_templates (tenant_id, name, body, is_invoice_default)
select id, 'Invoice via SMS', 'Hi {client_first_name}, here''s your invoice from {company_name}: {invoice_payment_link}. Reply if you have any questions.', true
from public.tenants;
