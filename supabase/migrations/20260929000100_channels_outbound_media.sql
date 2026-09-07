-- Channels - lets an admin attach a file to an outbound reply (SMS/MMS or
-- WhatsApp), the same way you'd attach a photo in WhatsApp itself. Until
-- now channel-media only had a tenant-read policy - every object was
-- written by the inbound webhook (service role, bypasses RLS). Sending an
-- attachment means the desktop/mobile app itself needs to upload directly
-- (channel-send-message then reads it back via a signed URL to hand to
-- Twilio as MediaUrl), so this adds one insert policy - same "tenant
-- folder + admin" shape as every other admin-write bucket in this app
-- (e.g. report-files, knowledge-files), simpler than job-files' own
-- policy since there's no "assigned technician" concept here.

create policy "channel-media: admin upload" on storage.objects
  for insert with check (
    bucket_id = 'channel-media'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );
