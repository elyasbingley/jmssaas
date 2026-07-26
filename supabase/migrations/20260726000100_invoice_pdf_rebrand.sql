-- Matches the quote/invoice PDF export to the person's real reference
-- templates: adds the company email/website fields and a logo, both shown
-- on the exported PDF (see apps/mobile/lib/pdf.ts).
--
-- logo_url stores a public Storage URL rather than a bucket path - the PDF
-- is rendered client-side by expo-print from a plain HTML string handed to
-- a WebView, which has no Supabase auth context to sign a private URL with,
-- so the bucket has to be public and the stored value has to be something
-- an <img src> can load directly.

alter table public.tenants
  add column email text,
  add column website text,
  add column logo_url text;

insert into storage.buckets (id, name, public)
values ('company-logos', 'company-logos', true)
on conflict (id) do nothing;

-- Public bucket - the PDF's <img> tag reads the public URL with no auth
-- context, so read access has to be unrestricted. Writes stay tenant/admin
-- scoped like every other storage bucket in this schema, keyed by
-- <tenant_id>/... same as job-files.
create policy "company-logos: public read" on storage.objects
  for select using (bucket_id = 'company-logos');

create policy "company-logos: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "company-logos: admin updates" on storage.objects
  for update using (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "company-logos: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );
