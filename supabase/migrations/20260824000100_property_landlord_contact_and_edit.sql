-- Fixes a real gap reported directly: creating a property had no way to
-- record the landlord's phone/email at all (the columns didn't exist),
-- and no way to record the tenant's contact details either (those columns
-- already existed on `properties` since the real_estate_strata migration,
-- but the "New managed property" form never collected them, and there was
-- no edit-property capability at all to add them afterward - both gaps
-- close together here rather than adding the columns now and leaving the
-- UI gap for a later batch, since the UI gap is the actual thing blocking
-- the user right now).

alter table public.properties
  add column owner_landlord_phone text,
  add column owner_landlord_email text;
