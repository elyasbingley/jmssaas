-- Channels - WhatsApp via Twilio. Turns out to be a much smaller lift than
-- Messenger/Instagram: WhatsApp messaging through Twilio uses the exact
-- same Messages API and inbound-webhook shape as SMS (see the channels
-- migration), just with a "whatsapp:" prefix on the From/To numbers -
-- there's no Meta App Review wall the way there is for messaging through
-- someone else's Facebook Page/Instagram account, and Twilio's free
-- Sandbox number lets you test send/receive immediately, before a
-- permanent Business-verified sender is approved. See twilio-whatsapp-
-- webhook and docs/SETUP.md's Channels section for the full picture.
--
-- A separate column from sms_phone_number (not reused) since a tenant's
-- WhatsApp sender is very likely a different number in practice - Twilio's
-- Sandbox number for early testing, a dedicated WhatsApp-enabled number
-- once Business-verified, either way not assumed to be the same number
-- already registered for plain SMS.

alter table public.tenants add column whatsapp_phone_number text unique;
