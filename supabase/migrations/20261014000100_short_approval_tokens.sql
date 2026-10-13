-- Shorter quote/invoice approval tokens. generate_quote_approval_link/
-- generate_invoice_approval_link used to mint a 64-char hex token
-- (encode(gen_random_bytes(32), 'hex')) - correct but needlessly long for
-- a link a client taps from a text message. New tokens are 12-char
-- base62 instead (~71 bits of entropy - still unguessable, especially
-- alongside the existing 30-day expiry and one-time accept/decline state
-- machine already enforced in get_quote_for_approval/accept_quote_by_token
-- etc). access_token stays a plain `text unique` column with no length
-- constraint, so this needs no schema change and no backfill - an
-- existing long token already stored there keeps resolving through the
-- exact same `where access_token = p_token` lookup every get_*_for_
-- approval/accept_*_by_token/decline_*_by_token function already uses;
-- only *new* tokens (a quote/invoice that doesn't have one yet) get the
-- short form.

-- Cryptographically sourced (pgcrypto's gen_random_bytes, the same
-- OpenSSL RAND_bytes-backed source the old 32-byte hex token already
-- used), with rejection sampling rather than a plain `% 62` so the
-- base62 mapping stays uniform: 256 isn't a multiple of 62, so a naive
-- modulo would make the first 8 alphabet characters ~25% more likely
-- than the rest. Bytes >= 248 (4*62) are rejected and redrawn instead.
create or replace function public.generate_base62_token(p_length int default 12)
returns text
language plpgsql
as $$
declare
  v_alphabet text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_result text := '';
  v_byte int;
begin
  while length(v_result) < p_length loop
    v_byte := get_byte(gen_random_bytes(1), 0);
    if v_byte < 248 then
      v_result := v_result || substr(v_alphabet, (v_byte % 62) + 1, 1);
    end if;
  end loop;
  return v_result;
end;
$$;

create or replace function public.generate_quote_approval_link(p_quote_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing_token text;
  v_token text;
  v_updated int;
  v_attempt int := 0;
begin
  select access_token into v_existing_token from public.quotes where id = p_quote_id;
  if v_existing_token is not null then
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
  v_token text;
  v_updated int;
  v_attempt int := 0;
begin
  select access_token into v_existing_token from public.invoices where id = p_invoice_id;
  if v_existing_token is not null then
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
