-- Lets an 'app' event's color/category be set directly, independent of
-- whether it's actually linked to a job or task - categoryForEvent (see
-- packages/shared/src/calendar-recurrence.ts) checks this first and only
-- falls back to deriving from job_card_id/task_id/source when it's null.
-- Deliberately excludes 'personal' - that category only ever applies to
-- 'google_personal' rows, which are read-only in-app and never reach the
-- editor this is set from (see CalendarEventEditor's own comment).
alter table public.calendar_events
  add column category_override text check (category_override in ('job', 'task', 'general'));
