-- Public bucket hosting the static approval-page shell
-- (supabase/static/approval-page.html) - see docs/SETUP.md "Quote/invoice
-- digital acceptance" for why this moved out of the approve Edge Function:
-- Supabase force-downgrades HTML responses from Edge Functions on the
-- shared *.supabase.co domain to inert text/plain (anti-phishing), with no
-- per-function opt-out short of a paid custom domain. Storage-served files
-- aren't subject to that, so the page itself lives here now and the Edge
-- Function became a plain JSON API.
--
-- Unlike company-logos, this bucket holds exactly one file, uploaded once
-- by whoever deploys this project (via the Supabase CLI/dashboard, not
-- through the app) - see docs/SETUP.md for the upload command. The write
-- policy below exists for that maintenance path, not for any in-app flow.

insert into storage.buckets (id, name, public)
values ('approval-pages', 'approval-pages', true)
on conflict (id) do nothing;

create policy "approval-pages: public read" on storage.objects
  for select using (bucket_id = 'approval-pages');

create policy "approval-pages: admin uploads" on storage.objects
  for insert with check (bucket_id = 'approval-pages' and public.is_admin());

create policy "approval-pages: admin updates" on storage.objects
  for update using (bucket_id = 'approval-pages' and public.is_admin());
