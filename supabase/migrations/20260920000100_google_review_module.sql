-- Google Review module - a standalone list (desktop only, office task, same
-- shape as Cost of Ops/Lead Source management) of clients who haven't yet
-- left a Google review, with a manual per-client "send email/sms/both"
-- button. No new communication_rules/communication_templates row is added:
-- the button reuses the existing 'job_review_request' trigger_key (see
-- communication_engine.sql), the same message already editable from
-- Settings > Automation & Messaging - just inserted with entity_type
-- 'client' instead of 'job' (already an allowed entity_type as of
-- communication_engine_retention.sql), so process-scheduled-comms' existing
-- entity_type === "client" branch resolves {client_first_name} etc without
-- any Edge Function changes.
--
-- No automatic way to detect an actual Google review was left (no public
-- API for that), so this is a plain manual tick, ticked from the client
-- card - not from this list, to keep a single source of truth for the flag
-- rather than two places that can drift.

alter table public.clients
  add column left_google_review boolean not null default false;
