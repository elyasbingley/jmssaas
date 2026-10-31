-- Splits clients.name (always "the primary contact's full name", for both
-- individual and company clients - see client_contacts_sites_workdrive.sql)
-- into first_name/last_name, so {client_first_name} in a template actually
-- resolves to a real first name instead of splitting on whitespace at
-- render time (which breaks for anyone whose "full name" isn't a plain
-- two-word string). `name` stays exactly as it is everywhere it's already
-- read - nothing elsewhere in the app needs to change - but becomes a
-- value this trigger keeps in sync with first_name/last_name rather than
-- something forms write directly:
--   - Whenever a write sets first_name and/or last_name (the Clients tab's
--     Add/Edit Client forms, on both platforms, from here on), name is
--     recomputed as their trimmed merge - "just the merging of first and
--     last name", exactly as asked.
--   - Whenever a write sets name only and leaves first_name/last_name both
--     null (every pre-existing row, plus the handful of "quick-create a
--     client from one text field" flows off Inbox/Channels messages that
--     aren't being rewritten to collect two fields), this best-effort
--     splits name on its first space so those rows get real first_name
--     data too, without touching those call sites at all.
-- Same split heuristic on both sides (first space = the cut point) so a
-- write that goes one way and gets read back the other round-trips
-- exactly.

alter table public.clients
  add column first_name text,
  add column last_name text;

create or replace function public.clients_sync_full_name()
returns trigger
language plpgsql
as $$
begin
  if new.first_name is not null or new.last_name is not null then
    new.name := trim(regexp_replace(
      concat_ws(' ', new.first_name, nullif(trim(coalesce(new.last_name, '')), '')),
      '\s+', ' ', 'g'
    ));
    if new.name = '' then
      new.name := coalesce(old.name, 'Unnamed');
    end if;
  elsif new.name is not null and new.first_name is null and new.last_name is null then
    new.first_name := split_part(trim(new.name), ' ', 1);
    new.last_name := case
      when position(' ' in trim(new.name)) > 0
        then trim(substring(trim(new.name) from position(' ' in trim(new.name)) + 1))
      else null
    end;
  end if;
  return new;
end;
$$;

create trigger clients_sync_full_name_trigger
  before insert or update on public.clients
  for each row execute function public.clients_sync_full_name();

-- Backfill every existing row the same way the trigger would for a
-- name-only write - explicit here rather than relying on trigger
-- side-effects, so this migration is self-contained and auditable.
update public.clients
set first_name = split_part(trim(name), ' ', 1),
    last_name = case
      when position(' ' in trim(name)) > 0
        then trim(substring(trim(name) from position(' ' in trim(name)) + 1))
      else null
    end
where first_name is null and last_name is null;
