-- Phase 6 of the "bug fixes, price book, line-item redesign, PDF generation,
-- nav restructure" pass: minimal company-level settings, added specifically
-- to support Phase 5's PDF export (company name/logo block, ABN, business
-- address, bank details) - not a general settings feature.
--
-- Stored as new columns on `tenants` rather than a separate
-- `company_settings` table: `tenants` is already exactly "one row per
-- company" (it already carries `name`), a 1:1 `company_settings` table
-- would just be that same row split in two for no structural reason (no
-- other table references company_settings, there's no independent
-- lifecycle), and every other address in this schema (clients, client_sites)
-- already uses the same structured line1/line2/suburb/state/postcode shape
-- rather than a single free-text field, so the business address follows
-- that same established convention here for consistency.
--
-- `tenants` had no UPDATE policy at all before this (only "read own
-- tenant" - provisioning writes went through the service role during
-- setup, see docs/SETUP.md), so this migration adds one, admin-only, so the
-- new settings screen can actually persist changes.

alter table public.tenants
  add column abn text,
  add column business_address_line1 text,
  add column business_address_line2 text,
  add column business_suburb text,
  add column business_state text,
  add column business_postcode text,
  add column license_number text,
  add column bank_account_name text,
  add column bank_account_number text,
  add column bank_bsb text;

create policy "tenants: admin updates" on public.tenants
  for update using (id = public.current_tenant_id() and public.is_admin());
