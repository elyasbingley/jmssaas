-- Public, unauthenticated read access to a completed leak check - the
-- "proof of inspection" report a tech/admin can send a client or agent.
-- Same shape as the quote/invoice approval token pattern (see the
-- quote_invoice_approval migration's own header comment): a nullable
-- `text unique` token (already added to job_leak_checks by the leak_check_
-- checklist migration), generated on demand, with every actual read going
-- through a SECURITY DEFINER RPC that re-validates the token itself since
-- the caller is genuinely unauthenticated (no auth.uid(), no tenant).
--
-- Unlike quotes/invoices, this report shows photos - and the job-files
-- storage bucket is private, so a signed URL for each photo has to be
-- minted somewhere with Storage access this anonymous caller doesn't have.
-- That can't happen in this RPC (Postgres has no way to call Storage's
-- signing endpoint), so this function returns bare storage_path values and
-- leaves signing to the Edge Function layer (supabase/functions/
-- leak-check-share), which has the service role key available for exactly
-- this - the same role that function already uses for other privileged
-- reads. The token itself is already the validated credential by the time
-- the Edge Function signs anything.

create or replace function public.generate_leak_check_share_link(p_leak_check_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_token text;
  v_updated int;
begin
  select share_token into v_existing_token from public.job_leak_checks where id = p_leak_check_id;
  if v_existing_token is not null then
    return v_existing_token;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  update public.job_leak_checks
  set share_token = v_token,
      shared_at = now()
  where id = p_leak_check_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Leak check % not found or not permitted', p_leak_check_id;
  end if;

  return v_token;
end;
$$;

create or replace function public.get_leak_check_for_share(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leak_check public.job_leak_checks;
  v_job public.job_cards;
  v_tenant public.tenants;
  v_client public.clients;
  v_categories jsonb;
begin
  select * into v_leak_check from public.job_leak_checks where share_token = p_token;
  if v_leak_check.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into v_job from public.job_cards where id = v_leak_check.job_card_id;
  select * into v_tenant from public.tenants where id = v_leak_check.tenant_id;
  select * into v_client from public.clients where id = v_job.client_id;

  -- One row per category, each carrying its own items array with that
  -- item's photo storage_paths nested inside - a single query per level
  -- (categories, items, item_files) rather than N+1, assembled with
  -- jsonb_agg/jsonb_build_object the same way get_quote_for_approval
  -- assembles its line_items array.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', c.name,
        'items', (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'label', i.label,
                'item_type', i.item_type,
                'result', i.result,
                'notes', i.notes,
                'meter_start_reading', i.meter_start_reading,
                'meter_end_reading', i.meter_end_reading,
                'meter_wait_minutes', i.meter_wait_minutes,
                'photo_paths', (
                  select coalesce(jsonb_agg(f.storage_path order by f.created_at), '[]'::jsonb)
                  from public.job_leak_check_item_files f
                  where f.item_id = i.id
                )
              )
              order by i.sort_order
            ),
            '[]'::jsonb
          )
          from public.job_leak_check_items i
          where i.category_id = c.id
        )
      )
      order by c.sort_order
    ),
    '[]'::jsonb
  )
  into v_categories
  from public.job_leak_check_categories c
  where c.leak_check_id = v_leak_check.id;

  return jsonb_build_object(
    'title', v_leak_check.title,
    'status', v_leak_check.status,
    'completed_at', v_leak_check.completed_at,
    'tenant_name', v_tenant.name,
    'tenant_logo_url', v_tenant.logo_url,
    'client_name', v_client.name,
    'job_title', v_job.title,
    'categories', v_categories
  );
end;
$$;

grant execute on function public.generate_leak_check_share_link(uuid) to authenticated;

-- Revoked from public and granted only to anon/authenticated - same
-- explicit spelling-out as the quote/invoice approval migration, rather
-- than relying on Postgres's default "grant execute to public" for a new
-- function.
revoke execute on function public.get_leak_check_for_share(text) from public;
grant execute on function public.get_leak_check_for_share(text) to anon, authenticated;
