-- Job notes could be added but never edited - no update RLS policy
-- existed at all. Mirrors the existing select/insert policies' exact
-- scoping (admin, or the parent job's assigned technician) rather than
-- restricting to the note's own author, since that's already how this
-- table treats every other permission (anyone who can see/add a note on
-- a job can already see every other team member's notes on it too).

create policy "job_notes: update via parent job" on public.job_notes
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.job_cards jc
      where jc.id = job_notes.job_card_id
        and (public.is_admin() or jc.assigned_technician_id = auth.uid())
    )
  );
