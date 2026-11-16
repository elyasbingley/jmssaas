-- Missed-call text-back: a client's mobile forwards an unanswered call
-- (conditional/"no answer" call forwarding, set on the carrier side - not
-- something Postgres or Twilio config can do) to the tenant's existing
-- Twilio number. twilio-voice-webhook (new Edge Function) answers it,
-- plays the tenant's own voicemail greeting, records a message if the
-- caller leaves one, texts the caller back immediately, and logs the
-- call as a lead - same "a phone number is one external contact" model
-- Channels already uses for SMS/WhatsApp, not a new concept.
--
-- Reuses the existing sms_phone_number/TWILIO_ACCOUNT_SID/
-- TWILIO_AUTH_TOKEN - no new Twilio credential, this is the same number
-- already receiving SMS, just with its Voice webhook also pointed here.

-- A missed call's conversation thread is its own channel_type, same
-- partitioning SMS vs WhatsApp already use for the same phone number -
-- deliberately not reusing 'sms' for this, so a missed-call thread with
-- its auto-reply doesn't get mixed into (and confused with) a real SMS
-- conversation with the same caller.
alter type public.channel_type add value if not exists 'missed_call';

alter table public.tenants
  add column voicemail_greeting_url text,
  add column missed_call_reply_template text not null default 'Sorry I missed you, I''m on a roof. Reply with a photo of the problem and where it is, and I''ll call you back shortly. Elyas';

comment on column public.tenants.voicemail_greeting_url is
  'Audio file URL (mp3/wav) played to a caller before recording - Twilio fetches this itself, so it needs to be reachable with no auth (a public Storage URL, or any public host). Null falls back to a generic text-to-speech greeting.';
comment on column public.tenants.missed_call_reply_template is
  'Plain SMS text sent to a caller immediately after a missed call - no {tokens}, unlike communication_templates, since there is nothing per-call to personalise beyond the caller''s own number (already implicit in who receives it).';

-- Backfill a 'Missed call' lead_sources row for every tenant that doesn't
-- already have one (same name a tenant could also have typed in by hand -
-- checked by name, not a dedicated flag column, so this never creates a
-- duplicate if a tenant already added their own). New tenants get one via
-- the webhook's own find-or-create at first use rather than
-- seed_default_lead_sources - deliberately NOT edited here, see the
-- approval_page_redesign_fields/sync_quote_status_on_decision migrations'
-- own lesson this session already ran into twice: redefining an existing
-- function from an old copy risks silently dropping something it already
-- did.
insert into public.lead_sources (tenant_id, name, sort_order, is_referral_source)
select t.id, 'Missed call', 98, false
from public.tenants t
where not exists (
  select 1 from public.lead_sources ls where ls.tenant_id = t.id and ls.name = 'Missed call'
);
