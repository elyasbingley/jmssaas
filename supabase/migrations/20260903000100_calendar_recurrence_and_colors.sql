-- Recurring events: each occurrence is its own real calendar_events row
-- (generated client-side at create time), not a single Google-style
-- "series master" - deliberately, so every existing sync code path
-- (google-calendar-push/webhook/renew-channels/reconcile) needs zero
-- changes: from their perspective a recurring event's occurrences are
-- just N ordinary 'app' events, each pushed/synced independently. The
-- only two new columns tie those N rows together for the UI's "edit this
-- event / this and following / all events" scope picker:
--   recurrence_rule: the rule itself (denormalized onto every occurrence
--     row in the series, not just a "master" row, so any single
--     occurrence's popup can display "Weekly on Saturday" etc. without a
--     join) - {freq, interval, byWeekday?, endType, endDate?, count?}
--   recurrence_group_id: shared across every occurrence in the same
--     series - "this and following"/"all events" scope operations are
--     just `where recurrence_group_id = ... and start_at >= ...` deletes/
--     updates, no separate exception-tracking needed since every
--     occurrence is already a fully independent row.
alter table public.calendar_events
  add column recurrence_rule jsonb,
  add column recurrence_group_id uuid;

create index calendar_events_recurrence_group_id_idx on public.calendar_events (recurrence_group_id) where recurrence_group_id is not null;

-- Category colors: admin-customizable, one color per the four categories
-- the calendar UI actually distinguishes (Job/Task/Personal-Google/
-- General - see CalendarEvent's own source/job_card_id/task_id fields,
-- there's no fifth category to add here without a real feature behind
-- it, e.g. quotes don't get calendar entries at all today). A single
-- jsonb column rather than four flat columns so adding a category later
-- doesn't need another migration - packages/shared's CalendarCategoryColors
-- type is the source of truth for the expected shape.
alter table public.tenants
  add column calendar_category_colors jsonb not null default '{"job":"#1d4ed8","task":"#16a34a","personal":"#f59e0b","general":"#6b7280"}'::jsonb;
