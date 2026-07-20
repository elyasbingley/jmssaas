-- Private bucket for job card attachments (photos, PDFs, etc).
-- Objects are stored under a `<tenant_id>/<job_card_id>/<filename>` path so
-- storage RLS can enforce the same tenant isolation as the rest of the schema.

insert into storage.buckets (id, name, public)
values ('job-files', 'job-files', false)
on conflict (id) do nothing;

create policy "job-files: tenant read via job access" on storage.objects
  for select using (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and exists (
      select 1 from public.job_cards jc
      where jc.id::text = (storage.foldername(name))[2]
        and jc.tenant_id = public.current_tenant_id()
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job-files: tenant upload via job access" on storage.objects
  for insert with check (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and exists (
      select 1 from public.job_cards jc
      where jc.id::text = (storage.foldername(name))[2]
        and jc.tenant_id = public.current_tenant_id()
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job-files: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );
