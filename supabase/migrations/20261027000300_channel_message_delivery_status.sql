-- Delivery/read receipts for outbound Channels messages. channel_messages.
-- status previously only covered 'sent' (the value every outbound send
-- already wrote immediately) / 'delivered' / 'failed' / 'received' (every
-- inbound webhook's own value) - 'delivered' and the fourth, real Twilio-
-- reported state 'failed' were declared but nothing ever actually wrote
-- them; this migration adds the rest of Twilio's own MessageStatus values
-- (see the Messages API's StatusCallback: queued -> sending -> sent ->
-- delivered -> read [WhatsApp only] or undelivered/failed at any point)
-- and twilio-status-callback (new Edge Function) is what starts actually
-- writing 'delivered'/'read'/'undelivered' as Twilio reports them.
alter table public.channel_messages drop constraint channel_messages_status_check;
alter table public.channel_messages add constraint channel_messages_status_check
  check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'undelivered', 'failed', 'received'));
