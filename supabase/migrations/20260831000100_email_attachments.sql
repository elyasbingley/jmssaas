-- Email attachments (a quote/invoice PDF auto-attached alongside the
-- existing view-online link, plus the ability to attach anything else -
-- images, other documents - from EmailComposeModal). Stored as base64
-- directly on the scheduled_communications row rather than a Storage
-- bucket + signed URLs - these are one-off transactional email payloads,
-- not documents this app needs to keep browsing/re-serving later (the
-- quote/invoice PDF itself is always regenerable on demand), so the extra
-- bucket/signed-URL machinery isn't earning its complexity here. Same
-- "small binary as text in a column" convention this app already uses for
-- signature images (accepted_signature_svg is a base64 PNG data URI too).
alter table public.scheduled_communications
  add column attachments jsonb not null default '[]'::jsonb;
