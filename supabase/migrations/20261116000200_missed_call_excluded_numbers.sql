-- Missed-call text-back (see 20261116000100's own comment) treats every
-- unanswered call as a potential lead - a friend or family member calling
-- gets a client + job_cards row created for them too, which is noise, not
-- a lead. This adds an admin-maintained exclude list (Settings' existing
-- Missed-Call Text-Back card): a call from one of these numbers still
-- rings through, still gets its voicemail saved to Channels, and still
-- gets the auto-text reply (so the caller isn't left hanging either way) -
-- only the job_cards insert is skipped, per the Edge Function change
-- alongside this migration.

alter table public.tenants
  add column missed_call_excluded_numbers text[] not null default '{}';
