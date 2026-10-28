-- Leak check item photos reuse the job-files storage bucket under a
-- `<tenant_id>/leak-<item_id>/` prefix, exactly the way task files reuse it
-- under `<tenant_id>/task-<task_id>/` (see the ux_overhaul migration's own
-- comment) - same tenant-isolation pattern, just keyed off
-- job_leak_check_items instead of tasks, and reachable through the same
-- admin-or-assigned-technician check every other leak check table uses
-- (joining through job_cards via the item's own denormalized job_card_id,
-- same shape as job-files' own job-access policies).

create policy "job-files: tenant read via leak check item access" on storage.objects
  for select using (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and (storage.foldername(name))[2] like 'leak-%'
    and exists (
      select 1 from public.job_leak_check_items i
      join public.job_cards jc on jc.id = i.job_card_id
      where i.id::text = substring((storage.foldername(name))[2] from 6)
        and i.tenant_id = public.current_tenant_id()
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );

create policy "job-files: tenant upload via leak check item access" on storage.objects
  for insert with check (
    bucket_id = 'job-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and (storage.foldername(name))[2] like 'leak-%'
    and exists (
      select 1 from public.job_leak_check_items i
      join public.job_cards jc on jc.id = i.job_card_id
      where i.id::text = substring((storage.foldername(name))[2] from 6)
        and i.tenant_id = public.current_tenant_id()
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
