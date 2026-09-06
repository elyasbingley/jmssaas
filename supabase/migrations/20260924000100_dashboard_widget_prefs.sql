-- Per-user Dashboard customisation (see docs the Dashboard screen's own
-- comment) - which of the four summary widgets (jobs booked today/tomorrow,
-- invoices, quotes) show on that user's Dashboard. Deliberately a column on
-- profiles, not a new table: it's a one-row-per-user display preference,
-- the same shape as everything else already on this row (role, full_name),
-- and profiles already has "update own profile" RLS (see
-- 20260720000200_rls_policies.sql), so no new policy is needed - a user can
-- freely toggle their own widgets, same as an admin editing any profile.
--
-- Fetched/written directly via Supabase on both apps, not through
-- PowerSync's local schema - same treatment as tenants (company settings):
-- a personal settings screen, not offline-critical field data.
alter table public.profiles
  add column dashboard_widgets jsonb not null default '{
    "jobs_today": true,
    "jobs_tomorrow": true,
    "invoices": true,
    "quotes": true
  }'::jsonb;
