-- Google Review stars - the Google Reviews module's manual "left a review"
-- tick (see the google_review_module migration) now also records how many
-- stars, so the Analytics page's Customer Feedback section has something
-- to chart. google_review_recorded_at is the date/time the office ticked
-- it, not when the client actually left the review on Google (there's no
-- way to know that) - it's what Analytics filters/plots by, and what's
-- cleared alongside left_google_review/google_review_stars if the office
-- ever unmarks a client back to "not reviewed".

alter table public.clients
  add column google_review_stars smallint check (google_review_stars between 1 and 5),
  add column google_review_recorded_at timestamptz;
