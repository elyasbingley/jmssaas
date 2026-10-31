-- Fixes a real bug: generate_quote_approval_link/generate_invoice_
-- approval_link/generate_po_quote_link each return an existing
-- access_token unchanged forever, never re-checking or refreshing
-- token_expires_at - so once a quote/invoice/PO's 30-day link window
-- passes, there was no way to make it valid again. Editing the quote/
-- invoice's own expiry_date field (its "valid until" business field,
-- shown on the document itself) does nothing here - that's a completely
-- separate column from token_expires_at (the access link's own expiry),
-- which is exactly the confusing symptom this was reported as: "I
-- changed the expiry date but the link still says expired."
--
-- Fix: same function, same returned token (never mint a new one - a
-- link already pasted into a text/email the client has keeps working),
-- but now refreshes token_expires_at to another 30 days out whenever
-- the existing one has already passed. A still-valid token is returned
-- completely unchanged, same as before - this only changes behaviour
-- for the already-expired case. Since every one of these already has a
-- "Copy/Share link" button in the UI that calls this same function, the
-- fix for an affected quote/invoice/PO is just clicking that button
-- again - no new UI needed.

create or replace function public.generate_quote_approval_link(p_quote_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_existing_expiry timestamptz;
  v_token text;
  v_updated int;
  v_attempt int := 0;
begin
  select access_token, token_expires_at into v_existing_token, v_existing_expiry from public.quotes where id = p_quote_id;
  if v_existing_token is not null then
    if v_existing_expiry is null or v_existing_expiry > now() then
      return v_existing_token;
    end if;
    update public.quotes set token_expires_at = now() + interval '30 days' where id = p_quote_id;
    return v_existing_token;
  end if;

  -- Retry on the rare collision against another row's existing token
  -- (12-char base62 is a ~3.2 * 10^21 space, but this is cheap to make
  -- airtight rather than merely unlikely to fail). A genuinely missing/
  -- not-permitted p_quote_id updates 0 rows without ever raising
  -- unique_violation, so it falls out of the loop on the first attempt
  -- and hits the "not found" check below exactly as before.
  loop
    v_attempt := v_attempt + 1;
    v_token := public.generate_base62_token(12);
    begin
      update public.quotes
      set access_token = v_token,
          token_expires_at = now() + interval '30 days',
          approval_status = coalesce(approval_status, 'sent')
      where id = p_quote_id;
      get diagnostics v_updated = row_count;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise exception 'Failed to generate a unique approval token after % attempts', v_attempt;
      end if;
    end;
  end loop;

  if v_updated = 0 then
    raise exception 'Quote % not found or not permitted', p_quote_id;
  end if;

  return v_token;
end;
$$;

create or replace function public.generate_invoice_approval_link(p_invoice_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_existing_expiry timestamptz;
  v_token text;
  v_updated int;
  v_attempt int := 0;
begin
  select access_token, token_expires_at into v_existing_token, v_existing_expiry from public.invoices where id = p_invoice_id;
  if v_existing_token is not null then
    if v_existing_expiry is null or v_existing_expiry > now() then
      return v_existing_token;
    end if;
    update public.invoices set token_expires_at = now() + interval '30 days' where id = p_invoice_id;
    return v_existing_token;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_token := public.generate_base62_token(12);
    begin
      update public.invoices
      set access_token = v_token,
          token_expires_at = now() + interval '30 days',
          approval_status = coalesce(approval_status, 'sent')
      where id = p_invoice_id;
      get diagnostics v_updated = row_count;
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise exception 'Failed to generate a unique approval token after % attempts', v_attempt;
      end if;
    end;
  end loop;

  if v_updated = 0 then
    raise exception 'Invoice % not found or not permitted', p_invoice_id;
  end if;

  return v_token;
end;
$$;

create or replace function public.generate_po_quote_link(p_po_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_existing_expiry timestamptz;
  v_token text;
  v_updated int;
begin
  select access_token, token_expires_at into v_existing_token, v_existing_expiry from public.purchase_orders where id = p_po_id;
  if v_existing_token is not null then
    if v_existing_expiry is null or v_existing_expiry > now() then
      return v_existing_token;
    end if;
    update public.purchase_orders set token_expires_at = now() + interval '30 days' where id = p_po_id;
    return v_existing_token;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  update public.purchase_orders
  set access_token = v_token,
      token_expires_at = now() + interval '30 days'
  where id = p_po_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'Purchase order % not found or not permitted', p_po_id;
  end if;

  return v_token;
end;
$$;
