-- When a quote is accepted, its job moves to the "Accepted" stage - however
-- it was accepted: the client on the approval page (status and
-- approval_status both become accepted), or someone setting the quote's
-- status to Accepted in JMS.
--
-- The "Accepted" stage is the tenant's own stage of that name; if there
-- isn't one it's created straight after the first stage (Enquiry), and it
-- can be renamed or moved afterwards (the tenant remembers which it is).
--
-- A job only ever moves forward: one already further along (Scheduled, In
-- Progress, Completed, Invoiced, or a recurring visit's To book) stays
-- where it is. Never stops a quote from being accepted.

alter table public.tenants
  add column accepted_stage_id uuid references public.job_lifecycle_stages (id) on delete set null;

create or replace function public.quote_accepted_ensure_stage(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_first int;
begin
  select s.id into v_id from public.tenants t join public.job_lifecycle_stages s on s.id = t.accepted_stage_id
  where t.id = p_tenant_id and s.tenant_id = p_tenant_id;
  if v_id is not null then
    return v_id;
  end if;
  select id into v_id from public.job_lifecycle_stages
  where tenant_id = p_tenant_id and lower(btrim(name)) in ('accepted', 'quote accepted') and not is_closed order by position limit 1;
  if v_id is null then
    select min(position) into v_first from public.job_lifecycle_stages where tenant_id = p_tenant_id;
    update public.job_lifecycle_stages set position = position + 1
    where tenant_id = p_tenant_id and position > coalesce(v_first, 0);
    insert into public.job_lifecycle_stages (tenant_id, name, position, color, is_closed)
    values (p_tenant_id, 'Accepted', coalesce(v_first, 0) + 1, '#22c55e', false)
    returning id into v_id;
  end if;
  update public.tenants set accepted_stage_id = v_id where id = p_tenant_id;
  return v_id;
end;
$$;

revoke execute on function public.quote_accepted_ensure_stage(uuid) from public, anon, authenticated;

create or replace function public.quote_accepted_move_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage uuid;
  v_stage_pos int;
  v_current record;
begin
  if new.job_card_id is null then
    return new;
  end if;
  -- coalesce: approval_status is null until the client responds online, and
  -- a null here must mean "not accepted", not "unknown".
  if not coalesce(
    (new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted'))
    or (new.approval_status = 'accepted' and (tg_op = 'INSERT' or old.approval_status is distinct from 'accepted')),
    false
  ) then
    return new;
  end if;
  begin
    v_stage := public.quote_accepted_ensure_stage(new.tenant_id);
    select position into v_stage_pos from public.job_lifecycle_stages where id = v_stage;
    select j.id, j.lifecycle_stage_id, s.position, coalesce(s.is_closed, false) as is_closed
      into v_current
    from public.job_cards j left join public.job_lifecycle_stages s on s.id = j.lifecycle_stage_id
    where j.id = new.job_card_id and j.tenant_id = new.tenant_id;
    if v_current.id is null or v_current.lifecycle_stage_id = v_stage then
      return new;
    end if;
    -- Forward only.
    if v_current.lifecycle_stage_id is null or (not v_current.is_closed and v_current.position < v_stage_pos) then
      update public.job_cards set lifecycle_stage_id = v_stage where id = new.job_card_id;
    end if;
  exception when others then
    raise warning 'quote_accepted_move_job: quote %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger quote_accepted_move_job
  after insert or update of status, approval_status on public.quotes
  for each row execute function public.quote_accepted_move_job();
