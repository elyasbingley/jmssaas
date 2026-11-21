-- Follow-up sequences (Sell Like Crazy plan, "Follow-up sequences to build
-- in JMS"): automatic texts after a checklist sign-up on the website, a
-- storm-morning text you send by hand, and texts after a quote goes quiet.
--
--   storm_checklist  Sequence 1 - starts when someone signs up at
--                    bingleytrades.com.au/storm-check (checklist_signup).
--   storm_morning    Sequence 3 - one text, started by the Storm morning
--                    button after picking suburbs. Nobody gets more than
--                    one storm text in 14 days.
--   quote_quiet      Sequence 4 - starts when a quote is sent.
--
-- Every sequence:
--   * stops when they reply, a job is booked, or they text STOP
--     (follow_up_stop_reason, checked before every send);
--   * only texts between 8:30am and 6pm Sydney time;
--   * is off until switched on (follow_up_sequences.enabled). Test numbers
--     (tenants.follow_up_test_numbers) still go through while it's off, and
--     a test run can be fast-forwarded a step at a time.
--
-- Texts are sent by the process-follow-ups function, which claims due
-- steps with follow_up_claim and writes results back with follow_up_record.
-- Wording lives in follow_up_steps, seeded word for word from the plan, so
-- it can be edited in the app later (e.g. adding Sequence 4's payment plan
-- line back once there's a payment provider).

-- ---------------------------------------------------------------------------
-- Tenant settings
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column follow_up_test_numbers text[] not null default '{}',
  -- Public key the website's sign-up forms send, so a sign-up lands in the
  -- right company. Not a secret in the password sense - it's in the page's
  -- HTML - it only identifies the company.
  add column checklist_signup_key text unique default replace(gen_random_uuid()::text, '-', '');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- An Australian mobile as +614XXXXXXXX, or null if it isn't one. Texts only
-- ever go to mobiles.
create or replace function public.au_mobile_e164(p text)
returns text
language sql
immutable
as $$
  select case
    when d ~ '^04[0-9]{8}$' then '+61' || substr(d, 2)
    when d ~ '^614[0-9]{8}$' then '+' || d
    when d ~ '^6104[0-9]{8}$' then '+61' || substr(d, 4)
    when d ~ '^4[0-9]{8}$' then '+61' || d
    else null
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x
$$;

-- Keeps a text in the plain SMS alphabet: curly quotes become straight ones
-- and long dashes become hyphens, so one stray character doesn't double the
-- cost of every text (the plan's "straight apostrophes and no dashes").
create or replace function public.sms_plain_text(p text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(replace(replace(coalesce(p, ''),
      chr(8216), ''''), chr(8217), ''''), chr(8220), '"'), chr(8221), '"'),
      chr(8211), '-'), chr(8212), '-'), chr(8230), '...'), chr(160), ' '),
    ' {2,}', ' ', 'g'))
$$;

-- Fills {field} placeholders from p_vars, then makes it plain SMS text.
create or replace function public.follow_up_render(p_body text, p_vars jsonb)
returns text
language plpgsql
immutable
as $$
declare
  v_text text := coalesce(p_body, '');
  v_key text;
begin
  for v_key in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb)) loop
    v_text := replace(v_text, '{' || v_key || '}', coalesce(p_vars ->> v_key, ''));
  end loop;
  return public.sms_plain_text(v_text);
end;
$$;

-- When "day N" after p_anchor is due: the same calendar day N in Sydney, at
-- the anchor's time of day kept inside the 8:30am-5:45pm part of the send
-- window (a sign-up at 9pm gets its day 2 text at 5:45pm on day 2, not at
-- 8:30am on day 3).
create or replace function public.follow_up_due_at(p_anchor timestamptz, p_days int)
returns timestamptz
language sql
stable
as $$
  select ((l::date + p_days) + least(greatest(l::time, time '08:30'), time '17:45')) at time zone 'Australia/Sydney'
  from (select p_anchor at time zone 'Australia/Sydney' as l) x
$$;

-- The earliest moment at or after p that's inside the send window
-- (8:30am to 6pm Sydney, every day).
create or replace function public.follow_up_next_send_time(p timestamptz)
returns timestamptz
language sql
stable
as $$
  select case
    when l::time < time '08:30' then (l::date + time '08:30') at time zone 'Australia/Sydney'
    when l::time >= time '18:00' then (l::date + 1 + time '08:30') at time zone 'Australia/Sydney'
    else p
  end
  from (select p at time zone 'Australia/Sydney' as l) x
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.follow_up_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null check (key in ('storm_checklist', 'storm_morning', 'quote_quiet')),
  name text not null,
  enabled boolean not null default false,
  -- storm_checklist: checklist_link, email_from_name (the sign-up email's
  -- sender name). quote_quiet: guarantee (default text),
  -- guarantee_by_category ({category id: text}), payment_plan_line (kept
  -- here to paste back in later; not sent).
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table public.follow_up_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  sequence_id uuid not null references public.follow_up_sequences (id) on delete cascade,
  position int not null,
  day_offset int not null check (day_offset >= 0),
  label text,
  body text not null,
  video_link text,
  -- Also email it, if they gave an email (Sequence 1's first message).
  also_email boolean not null default false,
  email_subject text,
  updated_at timestamptz not null default now(),
  unique (sequence_id, position)
);

create table public.follow_up_enrolments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  sequence_id uuid not null references public.follow_up_sequences (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  job_card_id uuid references public.job_cards (id) on delete set null,
  quote_id uuid references public.quotes (id) on delete set null,
  phone text not null,
  email text,
  -- first_name, suburb, job, quote_total - fixed when they're enrolled.
  vars jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  stop_reason text,
  stopped_at timestamptz,
  enrolled_at timestamptz not null default now(),
  next_position int not null default 0,
  next_due_at timestamptz,
  -- Set by "Send next now" on a test run: skip the wait and the window.
  force_next boolean not null default false,
  claimed_until timestamptz,
  -- Their jobs already booked when they were enrolled, so only a new
  -- booking counts as "a job is booked".
  booked_baseline uuid[] not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index follow_up_enrolments_due_idx on public.follow_up_enrolments (next_due_at) where status = 'active';
create index follow_up_enrolments_phone_idx on public.follow_up_enrolments (tenant_id, phone);
create index follow_up_enrolments_client_idx on public.follow_up_enrolments (client_id);

create table public.follow_up_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  enrolment_id uuid not null references public.follow_up_enrolments (id) on delete cascade,
  step_position int not null,
  channel text not null check (channel in ('sms', 'email')),
  recipient text,
  body text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  detail text,
  external_id text,
  created_at timestamptz not null default now()
);

create index follow_up_messages_enrolment_idx on public.follow_up_messages (enrolment_id);

create trigger set_follow_up_sequences_updated_at before update on public.follow_up_sequences
  for each row execute function public.set_updated_at();
create trigger set_follow_up_steps_updated_at before update on public.follow_up_steps
  for each row execute function public.set_updated_at();
create trigger set_follow_up_enrolments_updated_at before update on public.follow_up_enrolments
  for each row execute function public.set_updated_at();

alter table public.follow_up_sequences enable row level security;
alter table public.follow_up_steps enable row level security;
alter table public.follow_up_enrolments enable row level security;
alter table public.follow_up_messages enable row level security;

create policy "follow_up_sequences: tenant read" on public.follow_up_sequences
  for select using (tenant_id = public.current_tenant_id());
-- Wording and settings are edited directly; switching on goes through
-- set_follow_up_sequence_enabled, which checks it's ready.
create policy "follow_up_sequences: admin update" on public.follow_up_sequences
  for update using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "follow_up_steps: tenant read" on public.follow_up_steps
  for select using (tenant_id = public.current_tenant_id());
create policy "follow_up_steps: admin update" on public.follow_up_steps
  for update using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "follow_up_enrolments: tenant read" on public.follow_up_enrolments
  for select using (tenant_id = public.current_tenant_id());
create policy "follow_up_messages: tenant read" on public.follow_up_messages
  for select using (tenant_id = public.current_tenant_id());

-- The on/off switch only changes through set_follow_up_sequence_enabled.
create or replace function public.guard_follow_up_sequence_enabled()
returns trigger
language plpgsql
as $$
begin
  if new.enabled is distinct from old.enabled and coalesce(current_setting('jms.follow_up_toggle', true), '') <> 'on' then
    new.enabled := old.enabled;
  end if;
  new.key := old.key;
  new.tenant_id := old.tenant_id;
  return new;
end;
$$;

create trigger guard_follow_up_sequence_enabled before update on public.follow_up_sequences
  for each row execute function public.guard_follow_up_sequence_enabled();

-- ---------------------------------------------------------------------------
-- Seed: the plan's wording, word for word
-- ---------------------------------------------------------------------------

create or replace function public.seed_follow_up_sequences(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq uuid;
begin
  -- Lead sources the website sign-ups are filed under.
  insert into public.lead_sources (tenant_id, name, sort_order, is_referral_source)
  select p_tenant_id, n, coalesce((select max(sort_order) from public.lead_sources where tenant_id = p_tenant_id), 0) + o, false
  from (values ('Checklist: roof', 1), ('Checklist: hot water', 2)) v(n, o)
  where not exists (select 1 from public.lead_sources s where s.tenant_id = p_tenant_id and lower(s.name) = lower(v.n));

  if not exists (select 1 from public.follow_up_sequences where tenant_id = p_tenant_id and key = 'storm_checklist') then
    insert into public.follow_up_sequences (tenant_id, key, name, settings)
    values (p_tenant_id, 'storm_checklist', 'Storm checklist sign-up', jsonb_build_object('checklist_link', '', 'email_from_name', 'Elyas'))
    returning id into v_seq;
    insert into public.follow_up_steps (tenant_id, sequence_id, position, day_offset, label, body, also_email, email_subject) values
      (p_tenant_id, v_seq, 0, 0, 'Text, plus email if given',
       'Hi {first_name}, Elyas here, The Leak Detective. Here''s your storm season roof check: {checklist_link} The short video is on the same page. If water''s already coming in, reply with a photo and I''ll tell you what I''d do. Reply STOP to opt out',
       true, 'Your storm season roof check'),
      (p_tenant_id, v_seq, 1, 2, 'Text with video 2',
       'Hi {first_name}, Elyas again. Most leaks show up in the roof space weeks before they reach the ceiling. Here''s what to look for with a torch from the manhole: {video_link} If you spot any of it, text me a photo. Reply STOP to opt out',
       false, null),
      (p_tenant_id, v_seq, 2, 4, 'Text with video 3',
       'Hi {first_name}. Repair or full restoration? Here''s how to tell if you really need the big job, and what to ask any roofer before you say yes: {video_link} Reply STOP to opt out',
       false, null),
      (p_tenant_id, v_seq, 3, 7, 'Text, the offer',
       'Hi {first_name}, did the check turn anything up? I''ve got a few Same-Day Leak Stop spots in {suburb} this week. Fixed price before I come, and if water comes through the same spot within 90 days I''m back free. Reply with a photo. Reply STOP to opt out',
       false, null),
      (p_tenant_id, v_seq, 4, 14, 'Text, a question',
       'Quick one {first_name}: did the roof check turn anything up? Reply 1 if yes, 2 if all good. Reply STOP to opt out',
       false, null);
  end if;

  if not exists (select 1 from public.follow_up_sequences where tenant_id = p_tenant_id and key = 'storm_morning') then
    insert into public.follow_up_sequences (tenant_id, key, name)
    values (p_tenant_id, 'storm_morning', 'The morning after a storm')
    returning id into v_seq;
    insert into public.follow_up_steps (tenant_id, sequence_id, position, day_offset, label, body) values
      (p_tenant_id, v_seq, 0, 0, 'Storm morning text',
       'Hi {first_name}, Elyas from The Leak Detective. Big storm last night. If any water came in, text me a photo and I''ll tell you what I''d do. I''ve got Same-Day Leak Stop spots in {suburb} today. Reply STOP to opt out');
  end if;

  if not exists (select 1 from public.follow_up_sequences where tenant_id = p_tenant_id and key = 'quote_quiet') then
    insert into public.follow_up_sequences (tenant_id, key, name, settings)
    values (p_tenant_id, 'quote_quiet', 'Quotes that go quiet', jsonb_build_object(
      'guarantee', 'if water comes through the same spot within 90 days of my visit, I come back and fix it free',
      'guarantee_by_category', '{}'::jsonb,
      -- Left out of day 5 until there's a payment provider (paste it back
      -- after "{guarantee}." then).
      'payment_plan_line', 'And if it helps, the {quote_total} can be split into payments.'))
    returning id into v_seq;
    insert into public.follow_up_steps (tenant_id, sequence_id, position, day_offset, label, body) values
      (p_tenant_id, v_seq, 0, 2, 'Day 2',
       'Hi {first_name}, just checking you got the price for {job}. Any questions, I''m happy to talk it through. Reply STOP to opt out'),
      (p_tenant_id, v_seq, 1, 5, 'Day 5',
       'Hi {first_name}, one thing I should have mentioned: {guarantee}. Reply STOP to opt out'),
      (p_tenant_id, v_seq, 2, 10, 'Day 10',
       'Hi {first_name}, want me to hold a spot for {job} this week or next? Reply STOP to opt out'),
      (p_tenant_id, v_seq, 3, 21, 'Day 21',
       'Hi {first_name}, I''ll take it you''ve sorted it or put it on hold. No worries either way. If it starts again, you''ve got my number. Reply STOP to opt out');
  end if;
end;
$$;

revoke execute on function public.seed_follow_up_sequences(uuid) from public, anon, authenticated;

select public.seed_follow_up_sequences(id) from public.tenants;

create or replace function public.seed_follow_up_sequences_on_tenant_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_follow_up_sequences(new.id);
  return new;
end;
$$;

create trigger seed_follow_up_sequences_on_tenant_insert after insert on public.tenants
  for each row execute function public.seed_follow_up_sequences_on_tenant_insert();

-- ---------------------------------------------------------------------------
-- Stop rules
-- ---------------------------------------------------------------------------

-- A client's jobs that count as booked: scheduled, or moved past the first
-- stage (Enquiry/New).
create or replace function public.follow_up_booked_jobs(p_client_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(j.id), '{}')
  from public.job_cards j
  left join public.job_lifecycle_stages s on s.id = j.lifecycle_stage_id
  where j.client_id = p_client_id
    and (
      j.scheduled_at is not null
      or s.position > (select min(position) from public.job_lifecycle_stages f where f.tenant_id = j.tenant_id)
    )
$$;

revoke execute on function public.follow_up_booked_jobs(uuid) from public, anon, authenticated;

-- Why this enrolment should stop now, or null to carry on.
--   opted_out    texted STOP (or the client is marked opted out)
--   replied      any text from them since they were enrolled
--   booked       a job of theirs got booked, or they accepted a quote
--   quote_closed the quote was declined or expired (Sequence 4)
create or replace function public.follow_up_stop_reason(p_enrolment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e public.follow_up_enrolments;
  v_quote_status text;
begin
  select * into e from public.follow_up_enrolments where id = p_enrolment_id;
  if e.id is null then
    return 'missing';
  end if;

  if exists (select 1 from public.clients c where c.id = e.client_id and c.marketing_opt_out)
     or exists (
       select 1 from public.channel_messages m
       join public.channel_conversations cv on cv.id = m.conversation_id
       where cv.tenant_id = e.tenant_id and cv.channel_type = 'sms' and cv.external_contact = e.phone
         and m.direction = 'inbound' and m.created_at > e.enrolled_at
         and lower(btrim(coalesce(m.body, ''))) in ('stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit')
     ) then
    return 'opted_out';
  end if;

  if exists (
    select 1 from public.channel_messages m
    join public.channel_conversations cv on cv.id = m.conversation_id
    where cv.tenant_id = e.tenant_id and cv.channel_type = 'sms' and cv.external_contact = e.phone
      and m.direction = 'inbound' and m.created_at > e.enrolled_at
  ) then
    return 'replied';
  end if;

  if e.client_id is not null and (
    exists (select 1 from unnest(public.follow_up_booked_jobs(e.client_id)) b(id) where b.id <> all (e.booked_baseline))
    or exists (select 1 from public.quotes q where q.client_id = e.client_id and q.accepted_at > e.enrolled_at)
  ) then
    return 'booked';
  end if;

  if e.quote_id is not null then
    select status::text into v_quote_status from public.quotes where id = e.quote_id;
    if v_quote_status = 'accepted' then
      return 'booked';
    elsif v_quote_status is null or v_quote_status in ('declined', 'expired') then
      return 'quote_closed';
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function public.follow_up_stop_reason(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enrolling
-- ---------------------------------------------------------------------------

create or replace function public.follow_up_first_name(p_client public.clients)
returns text
language sql
immutable
as $$
  select nullif(btrim(coalesce(nullif(btrim(p_client.first_name), ''), split_part(btrim(coalesce(p_client.name, '')), ' ', 1))), '')
$$;

-- Starts a sequence for one person. Returns the enrolment id, or null when
-- it doesn't start (sequence off and not a test number, not a mobile,
-- opted out, or already part-way through this sequence).
create or replace function public.follow_up_enrol(
  p_tenant_id uuid,
  p_key text,
  p_phone text,
  p_client_id uuid,
  p_job_card_id uuid,
  p_quote_id uuid,
  p_email text,
  p_vars jsonb,
  p_anchor timestamptz default now(),
  p_force_test boolean default false,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq public.follow_up_sequences;
  v_phone text := public.au_mobile_e164(p_phone);
  v_test boolean;
  v_test_numbers text[];
  v_first_day int;
  v_id uuid;
begin
  if v_phone is null then
    return null;
  end if;
  select * into v_seq from public.follow_up_sequences where tenant_id = p_tenant_id and key = p_key;
  if v_seq.id is null then
    return null;
  end if;
  select follow_up_test_numbers into v_test_numbers from public.tenants where id = p_tenant_id;
  v_test := p_force_test or v_phone = any (coalesce(v_test_numbers, '{}'));
  if not (v_seq.enabled or v_test) then
    return null;
  end if;
  if not v_test and p_client_id is not null and exists (select 1 from public.clients where id = p_client_id and marketing_opt_out) then
    return null;
  end if;
  if not v_test and exists (
    select 1 from public.follow_up_enrolments
    where sequence_id = v_seq.id and status = 'active' and phone = v_phone and p_key <> 'quote_quiet'
  ) then
    return null;
  end if;

  select day_offset into v_first_day from public.follow_up_steps where sequence_id = v_seq.id order by position limit 1;

  insert into public.follow_up_enrolments (
    tenant_id, sequence_id, client_id, job_card_id, quote_id, phone, email, vars, is_test,
    enrolled_at, next_due_at, booked_baseline, created_by
  ) values (
    p_tenant_id, v_seq.id, p_client_id, p_job_card_id, p_quote_id, v_phone, nullif(btrim(coalesce(p_email, '')), ''),
    coalesce(p_vars, '{}'::jsonb), v_test, p_anchor,
    case when coalesce(v_first_day, 0) = 0 then p_anchor else public.follow_up_due_at(p_anchor, v_first_day) end,
    case when p_client_id is null then '{}' else public.follow_up_booked_jobs(p_client_id) end,
    p_created_by
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.follow_up_enrol(uuid, text, text, uuid, uuid, uuid, text, jsonb, timestamptz, boolean, uuid) from public, anon, authenticated;

-- Sequence 4 trigger: a quote is sent.
create or replace function public.follow_up_quote_vars(p_quote public.quotes)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'first_name', public.follow_up_first_name(c),
    'suburb', c.suburb,
    -- "the price for gutter cleaning": lower-case the title's first letter
    -- unless it looks like an abbreviation (HWS, LED).
    'job', coalesce(
      case
        when j.title ~ '^[A-Z][a-z]' then lower(left(j.title, 1)) || substr(j.title, 2)
        else nullif(btrim(j.title), '')
      end, 'the job'),
    'quote_total', '$' || to_char(coalesce(p_quote.total_cents, 0) / 100.0, 'FM999,999,990.00'),
    'category_id', j.service_category_id
  )
  from public.clients c
  left join public.job_cards j on j.id = p_quote.job_card_id
  where c.id = p_quote.client_id
$$;

revoke execute on function public.follow_up_quote_vars(public.quotes) from public, anon, authenticated;

create or replace function public.enrol_quote_follow_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
begin
  if new.status <> 'sent' or (tg_op = 'UPDATE' and old.status = 'sent') then
    return new;
  end if;
  select * into v_client from public.clients where id = new.client_id;
  if public.au_mobile_e164(v_client.phone) is null then
    return new;
  end if;
  -- A newer quote for the same person replaces the older one's texts.
  update public.follow_up_enrolments e
  set status = 'stopped', stop_reason = 'newer_quote', stopped_at = now()
  from public.follow_up_sequences s
  where s.id = e.sequence_id and s.key = 'quote_quiet' and e.status = 'active' and e.client_id = new.client_id and e.quote_id is distinct from new.id;

  if not exists (
    select 1 from public.follow_up_enrolments e join public.follow_up_sequences s on s.id = e.sequence_id
    where s.key = 'quote_quiet' and e.quote_id = new.id and e.status = 'active'
  ) then
    perform public.follow_up_enrol(new.tenant_id, 'quote_quiet', v_client.phone, v_client.id, new.job_card_id, new.id, null, public.follow_up_quote_vars(new));
  end if;
  return new;
exception when others then
  -- Follow-up texts are a nice-to-have; sending the quote isn't. Never let
  -- a problem here stop a quote being sent.
  raise warning 'quote follow-up not started for quote %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger enrol_quote_follow_up after insert or update of status on public.quotes
  for each row execute function public.enrol_quote_follow_up();

-- ---------------------------------------------------------------------------
-- Website sign-ups (called by the checklist-signup function)
-- ---------------------------------------------------------------------------

create or replace function public.checklist_signup(
  p_key text,
  p_checklist text,
  p_first_name text,
  p_mobile text,
  p_suburb text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_phone text := public.au_mobile_e164(p_mobile);
  v_first text := nullif(btrim(public.sms_plain_text(coalesce(p_first_name, ''))), '');
  v_suburb text := nullif(btrim(coalesce(p_suburb, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_source_name text;
  v_source_id uuid;
  v_client public.clients;
  v_new_client boolean := false;
  v_job_id uuid;
  v_duplicate boolean := false;
  v_enrolment_id uuid;
  v_stage_id uuid;
begin
  select id into v_tenant_id from public.tenants where checklist_signup_key = p_key;
  if v_tenant_id is null then
    raise exception 'unknown_form';
  end if;
  if p_checklist not in ('roof', 'hot_water') then
    raise exception 'unknown_checklist';
  end if;
  if v_phone is null then
    raise exception 'invalid_mobile';
  end if;
  if v_first is null then
    raise exception 'missing_name';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    v_email := null;
  end if;
  -- Title case a suburb typed in capitals or lower case ("st marys" ->
  -- "St Marys") so storm-morning suburbs group together.
  if v_suburb is not null and (v_suburb = lower(v_suburb) or v_suburb = upper(v_suburb)) then
    v_suburb := initcap(v_suburb);
  end if;

  v_source_name := case p_checklist when 'roof' then 'Checklist: roof' else 'Checklist: hot water' end;
  perform public.seed_follow_up_sequences(v_tenant_id);
  select id into v_source_id from public.lead_sources where tenant_id = v_tenant_id and lower(name) = lower(v_source_name) limit 1;

  -- The same person signing up again (or an existing client) is matched by
  -- mobile number.
  select * into v_client from public.clients
  where tenant_id = v_tenant_id and public.au_mobile_e164(phone) = v_phone
  order by created_at desc limit 1;

  if v_client.id is null then
    insert into public.clients (tenant_id, name, first_name, phone, email, suburb, notes)
    values (v_tenant_id, v_first, v_first, '0' || substr(v_phone, 4), v_email, v_suburb,
            'Signed up for the ' || case p_checklist when 'roof' then 'storm season roof' else 'hot water' end || ' checklist on the website.')
    returning * into v_client;
    v_new_client := true;
  else
    -- Fill gaps only; never overwrite what the office has typed. Signing up
    -- on a form that says we'll text them is fresh consent, so a past
    -- opt-out is cleared.
    update public.clients set
      first_name = coalesce(nullif(btrim(first_name), ''), v_first),
      email = coalesce(nullif(btrim(email), ''), v_email),
      suburb = coalesce(nullif(btrim(suburb), ''), v_suburb),
      marketing_opt_out = false
    where id = v_client.id
    returning * into v_client;
  end if;

  -- One lead per checklist per person per day, however many times the form
  -- is submitted.
  select id into v_job_id from public.job_cards
  where client_id = v_client.id and lead_source_id = v_source_id and created_at > now() - interval '1 day'
  order by created_at desc limit 1;

  if v_job_id is not null then
    v_duplicate := true;
  else
    select id into v_stage_id from public.job_lifecycle_stages where tenant_id = v_tenant_id order by position limit 1;
    insert into public.job_cards (tenant_id, client_id, title, description, lifecycle_stage_id, lead_source_id)
    values (
      v_tenant_id, v_client.id,
      case p_checklist when 'roof' then 'Storm checklist sign-up' else 'Hot water checklist sign-up' end,
      'Signed up at bingleytrades.com.au/' || case p_checklist when 'roof' then 'storm-check' else 'hot-water-check' end
        || ' for the free checklist.' || coalesce(' Suburb: ' || v_suburb || '.', '') || coalesce(' Email: ' || v_email || '.', ''),
      v_stage_id, v_source_id
    )
    returning id into v_job_id;

    -- Sequence 1 for the roof checklist. (The hot water checklist has no
    -- sequence yet - those sign-ups are a lead and a notification.)
    if p_checklist = 'roof' then
      v_enrolment_id := public.follow_up_enrol(
        v_tenant_id, 'storm_checklist', v_phone, v_client.id, v_job_id, null, v_email,
        jsonb_build_object('first_name', v_first, 'suburb', coalesce(v_suburb, v_client.suburb))
      );
    end if;
  end if;

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'client_id', v_client.id,
    'job_card_id', v_job_id,
    'enrolment_id', v_enrolment_id,
    'new_client', v_new_client,
    'duplicate', v_duplicate,
    'first_name', v_first,
    'suburb', coalesce(v_suburb, v_client.suburb)
  );
end;
$$;

revoke execute on function public.checklist_signup(text, text, text, text, text, text) from public, anon, authenticated;

-- The email's unsubscribe link.
create or replace function public.follow_up_unsubscribe(p_enrolment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.follow_up_enrolments;
begin
  select * into e from public.follow_up_enrolments where id = p_enrolment_id;
  if e.id is null then
    return false;
  end if;
  update public.clients set marketing_opt_out = true where id = e.client_id;
  update public.follow_up_enrolments set status = 'stopped', stop_reason = 'opted_out', stopped_at = now()
  where tenant_id = e.tenant_id and phone = e.phone and status = 'active';
  return true;
end;
$$;

revoke execute on function public.follow_up_unsubscribe(uuid) from public, anon, authenticated;

-- Called by twilio-sms-webhook for every text that comes in: stops that
-- number's sequences straight away (a reply goes to the inbox for you to
-- answer), and on STOP marks every client with that mobile as opted out.
create or replace function public.follow_up_inbound(p_tenant_id uuid, p_phone text, p_opt_out boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if p_opt_out then
    update public.clients set marketing_opt_out = true
    where tenant_id = p_tenant_id and public.au_mobile_e164(phone) = public.au_mobile_e164(p_phone);
  end if;
  update public.follow_up_enrolments
  set status = 'stopped', stop_reason = case when p_opt_out then 'opted_out' else 'replied' end, stopped_at = now()
  where tenant_id = p_tenant_id and phone = coalesce(public.au_mobile_e164(p_phone), p_phone) and status = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.follow_up_inbound(uuid, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sending (called by process-follow-ups)
-- ---------------------------------------------------------------------------

-- Claims the steps that are due and returns them ready to send. Stops,
-- finishes, skips or reschedules the rest as it goes:
--   * stop rule hit -> stopped;
--   * outside 8:30am-6pm -> moved to the next 8:30am;
--   * more than 36 hours late (e.g. the sequence was off for a while) ->
--     that step is skipped rather than sent days late.
-- p_enrolment_id + p_force is "Send next now" on a test run.
create or replace function public.follow_up_claim(p_limit int default 50, p_enrolment_id uuid default null, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
  v_step public.follow_up_steps;
  v_reason text;
  v_force boolean;
  v_next timestamptz;
  v_vars jsonb;
  v_settings jsonb;
  v_guarantee text;
  v_body text;
  v_out jsonb := '[]'::jsonb;
  v_count int := 0;
  -- The clock the window and lateness checks use. Always now() in real
  -- use; the database tests set jms.follow_up_now to check the window at
  -- a fixed time. Only the sending function can call this.
  v_now timestamptz := coalesce(nullif(current_setting('jms.follow_up_now', true), '')::timestamptz, now());
begin
  for e in
    select en.*, s.key as seq_key, s.enabled as seq_enabled, s.settings as seq_settings, t.sms_phone_number
    from public.follow_up_enrolments en
    join public.follow_up_sequences s on s.id = en.sequence_id
    join public.tenants t on t.id = en.tenant_id
    where en.status = 'active'
      and (en.claimed_until is null or en.claimed_until < now())
      and (
        (p_enrolment_id is null and en.next_due_at <= now() and (s.enabled or en.is_test))
        -- One person's next text: when it's due, or forced on a test run.
        or (en.id = p_enrolment_id and (en.next_due_at <= now() or en.force_next or (p_force and en.is_test)))
      )
    order by en.next_due_at
    limit greatest(p_limit, 1) * 4
    for update of en skip locked
  loop
    exit when v_count >= p_limit;

    v_reason := public.follow_up_stop_reason(e.id);
    if v_reason is not null then
      update public.follow_up_enrolments set status = 'stopped', stop_reason = v_reason, stopped_at = now() where id = e.id;
      continue;
    end if;

    select * into v_step from public.follow_up_steps where sequence_id = e.sequence_id and position = e.next_position;
    if v_step.id is null then
      update public.follow_up_enrolments set status = 'completed' where id = e.id;
      continue;
    end if;

    v_force := (p_force and e.id = p_enrolment_id and e.is_test) or e.force_next;
    if not v_force then
      v_next := public.follow_up_next_send_time(v_now);
      if v_next > v_now then
        update public.follow_up_enrolments set next_due_at = greatest(e.next_due_at, v_next) where id = e.id;
        continue;
      end if;
      if v_now - e.next_due_at > interval '36 hours' then
        insert into public.follow_up_messages (tenant_id, enrolment_id, step_position, channel, recipient, status, detail)
        values (e.tenant_id, e.id, v_step.position, 'sms', e.phone, 'skipped', 'More than 36 hours late (was the sequence switched off?), so skipped rather than sent late');
        perform public.follow_up_advance(e.id);
        continue;
      end if;
    end if;

    v_settings := coalesce(e.seq_settings, '{}'::jsonb);
    v_guarantee := coalesce(
      nullif(btrim(v_settings -> 'guarantee_by_category' ->> (e.vars ->> 'category_id')), ''),
      nullif(btrim(v_settings ->> 'guarantee'), '')
    );
    v_vars := e.vars
      || jsonb_build_object(
        'first_name', coalesce(nullif(btrim(e.vars ->> 'first_name'), ''), 'there'),
        'suburb', coalesce(nullif(btrim(e.vars ->> 'suburb'), ''), 'your area'),
        'job', coalesce(nullif(btrim(e.vars ->> 'job'), ''), 'the job'),
        'checklist_link', coalesce(v_settings ->> 'checklist_link', ''),
        'video_link', coalesce(v_step.video_link, ''),
        'guarantee', coalesce(v_guarantee, '')
      );
    v_body := public.follow_up_render(v_step.body, v_vars);

    if (v_step.body like '%{video_link}%' and nullif(btrim(coalesce(v_step.video_link, '')), '') is null)
       or (v_step.body like '%{checklist_link}%' and nullif(btrim(coalesce(v_settings ->> 'checklist_link', '')), '') is null)
       or (v_step.body like '%{guarantee}%' and v_guarantee is null) then
      insert into public.follow_up_messages (tenant_id, enrolment_id, step_position, channel, recipient, body, status, detail)
      values (e.tenant_id, e.id, v_step.position, 'sms', e.phone, v_body, 'failed', 'Not sent: this step''s link or guarantee hasn''t been filled in');
      perform public.follow_up_advance(e.id);
      continue;
    end if;

    update public.follow_up_enrolments set claimed_until = now() + interval '5 minutes', force_next = false where id = e.id;
    v_count := v_count + 1;
    v_out := v_out || jsonb_build_object(
      'enrolment_id', e.id,
      'tenant_id', e.tenant_id,
      'client_id', e.client_id,
      'position', v_step.position,
      'phone', e.phone,
      'from', e.sms_phone_number,
      'body', v_body,
      'email', case when v_step.also_email then e.email end,
      'email_subject', v_step.email_subject,
      'email_from_name', v_settings ->> 'email_from_name',
      'is_test', e.is_test,
      'sequence', e.seq_key
    );
  end loop;
  return v_out;
end;
$$;

-- Moves an enrolment on to its next step (or finishes it).
create or replace function public.follow_up_advance(p_enrolment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.follow_up_enrolments;
  v_next public.follow_up_steps;
begin
  select * into e from public.follow_up_enrolments where id = p_enrolment_id;
  select * into v_next from public.follow_up_steps where sequence_id = e.sequence_id and position > e.next_position order by position limit 1;
  if v_next.id is null then
    update public.follow_up_enrolments set status = 'completed', next_position = e.next_position + 1, claimed_until = null, next_due_at = null where id = e.id;
  else
    update public.follow_up_enrolments
    set next_position = v_next.position,
        next_due_at = greatest(public.follow_up_due_at(e.enrolled_at, v_next.day_offset), now()),
        claimed_until = null
    where id = e.id;
  end if;
end;
$$;

-- What happened to a claimed step. p_results: [{channel, recipient, body,
-- status (sent/failed), detail, external_id, opted_out}]. A number Twilio
-- says has opted out stops the sequence; anything else moves it on.
create or replace function public.follow_up_record(p_enrolment_id uuid, p_position int, p_results jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.follow_up_enrolments;
  r jsonb;
begin
  select * into e from public.follow_up_enrolments where id = p_enrolment_id;
  if e.id is null then
    return;
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    insert into public.follow_up_messages (tenant_id, enrolment_id, step_position, channel, recipient, body, status, detail, external_id)
    values (e.tenant_id, e.id, p_position, coalesce(r ->> 'channel', 'sms'), r ->> 'recipient', r ->> 'body',
            coalesce(r ->> 'status', 'failed'), r ->> 'detail', r ->> 'external_id');
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x(item) where (x.item ->> 'opted_out')::boolean) then
    update public.clients set marketing_opt_out = true where id = e.client_id;
    update public.follow_up_enrolments set status = 'stopped', stop_reason = 'opted_out', stopped_at = now(), claimed_until = null where id = e.id;
    return;
  end if;
  perform public.follow_up_advance(e.id);
end;
$$;

revoke execute on function public.follow_up_claim(int, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.follow_up_advance(uuid) from public, anon, authenticated;
revoke execute on function public.follow_up_record(uuid, int, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Office actions (desktop Follow-ups page)
-- ---------------------------------------------------------------------------

create or replace function public.follow_up_require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an admin can do this';
  end if;
  return public.current_tenant_id();
end;
$$;

revoke execute on function public.follow_up_require_admin() from public, anon;

-- Switch a sequence on or off. Switching on checks it's ready to send.
create or replace function public.set_follow_up_sequence_enabled(p_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
  v_seq public.follow_up_sequences;
  v_missing text[] := '{}';
begin
  select * into v_seq from public.follow_up_sequences where tenant_id = v_tenant and key = p_key;
  if v_seq.id is null then
    raise exception 'No such sequence';
  end if;
  if p_enabled then
    if (select sms_phone_number from public.tenants where id = v_tenant) is null then
      v_missing := v_missing || 'your SMS number (Company Settings)'::text;
    end if;
    if exists (select 1 from public.follow_up_steps where sequence_id = v_seq.id and body like '%{checklist_link}%')
       and nullif(btrim(coalesce(v_seq.settings ->> 'checklist_link', '')), '') is null then
      v_missing := v_missing || 'the checklist link'::text;
    end if;
    if exists (select 1 from public.follow_up_steps where sequence_id = v_seq.id and body like '%{video_link}%' and nullif(btrim(coalesce(video_link, '')), '') is null) then
      v_missing := v_missing || ('the video link for ' || (
        select string_agg('day ' || day_offset, ', ' order by position) from public.follow_up_steps
        where sequence_id = v_seq.id and body like '%{video_link}%' and nullif(btrim(coalesce(video_link, '')), '') is null))::text;
    end if;
    if exists (select 1 from public.follow_up_steps where sequence_id = v_seq.id and body like '%{guarantee}%')
       and nullif(btrim(coalesce(v_seq.settings ->> 'guarantee', '')), '') is null then
      v_missing := v_missing || 'the guarantee wording'::text;
    end if;
    if array_length(v_missing, 1) > 0 then
      raise exception 'Fill in % before switching this on', array_to_string(v_missing, ', ');
    end if;
  end if;
  perform set_config('jms.follow_up_toggle', 'on', true);
  update public.follow_up_sequences set enabled = p_enabled where id = v_seq.id;
  perform set_config('jms.follow_up_toggle', '', true);
end;
$$;

-- Test numbers: texts to these go out even while a sequence is off, and
-- their runs can be fast-forwarded.
create or replace function public.set_follow_up_test_numbers(p_numbers text[])
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
  v_clean text[];
  v_bad text;
begin
  select n into v_bad from unnest(coalesce(p_numbers, '{}')) n where btrim(n) <> '' and public.au_mobile_e164(n) is null limit 1;
  if v_bad is not null then
    raise exception '% isn''t an Australian mobile number', v_bad;
  end if;
  select coalesce(array_agg(distinct public.au_mobile_e164(n)), '{}') into v_clean from unnest(coalesce(p_numbers, '{}')) n where btrim(n) <> '';
  update public.tenants set follow_up_test_numbers = v_clean where id = v_tenant;
  return v_clean;
end;
$$;

-- Start a test run to a test number with sample details. The first
-- message is due straight away for Sequences 1 and 3; Sequence 4's first
-- is day 2, so press "Send next now" to fast-forward.
create or replace function public.start_follow_up_test(p_key text, p_phone text, p_suburb text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
  v_phone text := public.au_mobile_e164(p_phone);
  v_name text;
  v_id uuid;
begin
  if v_phone is null then
    raise exception 'Enter your mobile number to test with';
  end if;
  if not v_phone = any (coalesce((select t.follow_up_test_numbers from public.tenants t where t.id = v_tenant), '{}'::text[])) then
    raise exception 'Add % as a test number first', p_phone;
  end if;
  select split_part(btrim(full_name), ' ', 1) into v_name from public.profiles where id = auth.uid();
  v_id := public.follow_up_enrol(
    v_tenant, p_key, v_phone, null, null, null, (select email from public.profiles where id = auth.uid()),
    jsonb_build_object('first_name', coalesce(nullif(v_name, ''), 'there'), 'suburb', coalesce(nullif(btrim(p_suburb), ''), 'Blacktown'),
                       'job', 'roof leak repair', 'quote_total', '$650.00'),
    now(), true, auth.uid()
  );
  return v_id;
end;
$$;

create or replace function public.fast_forward_follow_up(p_enrolment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
begin
  update public.follow_up_enrolments set force_next = true, next_due_at = now(), claimed_until = null
  where id = p_enrolment_id and tenant_id = v_tenant and is_test and status = 'active';
  if not found then
    raise exception 'Only an active test run can be fast-forwarded';
  end if;
end;
$$;

create or replace function public.stop_follow_up(p_enrolment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
begin
  update public.follow_up_enrolments set status = 'stopped', stop_reason = 'manual', stopped_at = now()
  where id = p_enrolment_id and tenant_id = v_tenant and status = 'active';
end;
$$;

-- ---------------------------------------------------------------------------
-- Sequence 3: the morning after a storm
-- ---------------------------------------------------------------------------

-- Everyone who could get a storm text: people who signed up for a
-- checklist, plus past clients (a finished job or an invoice sent), with a
-- mobile and not opted out. One row per mobile. skip_reason is set for
-- anyone who's had a storm text in the last 14 days.
create or replace function public.storm_morning_pool(p_tenant_id uuid)
returns table (client_id uuid, name text, first_name text, phone text, suburb text, source text, skip_reason text)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select c.*,
      public.follow_up_first_name(c) as fname,
      public.au_mobile_e164(c.phone) as mobile,
      coalesce(nullif(btrim(c.suburb), ''), (select s.suburb from public.client_sites s where s.client_id = c.id order by s.is_primary desc nulls last, s.created_at limit 1)) as area,
      exists (
        select 1 from public.job_cards j join public.lead_sources ls on ls.id = j.lead_source_id
        where j.client_id = c.id and ls.name ilike 'Checklist:%'
      ) as signed_up,
      (
        exists (
          select 1 from public.job_cards j join public.job_lifecycle_stages st on st.id = j.lifecycle_stage_id
          where j.client_id = c.id and st.is_closed
        )
        or exists (select 1 from public.invoices i where i.client_id = c.id and i.status in ('sent', 'paid', 'overdue'))
      ) as past_client
    from public.clients c
    where c.tenant_id = p_tenant_id and not coalesce(c.marketing_opt_out, false)
  )
  select distinct on (p.mobile)
    p.id, p.name, p.fname, p.mobile, initcap(btrim(p.area)),
    case when p.signed_up then 'checklist' else 'past_client' end,
    case when exists (
      select 1 from public.follow_up_enrolments e join public.follow_up_sequences s on s.id = e.sequence_id
      where s.key = 'storm_morning' and e.tenant_id = p_tenant_id and e.phone = p.mobile and not e.is_test
        and e.enrolled_at > now() - interval '14 days'
    ) then 'storm_text_in_last_14_days' end
  from people p
  where p.mobile is not null and nullif(btrim(p.area), '') is not null and (p.signed_up or p.past_client)
  order by p.mobile, p.signed_up desc, p.updated_at desc
$$;

revoke execute on function public.storm_morning_pool(uuid) from public, anon, authenticated;

-- Suburbs for the picker, with how many would get the text.
create or replace function public.storm_morning_suburbs()
returns table (suburb text, people int, skipped int)
language sql
stable
security definer
set search_path = public
as $$
  select p.suburb, count(*) filter (where p.skip_reason is null)::int, count(*) filter (where p.skip_reason is not null)::int
  from public.storm_morning_pool(public.follow_up_require_admin()) p
  group by p.suburb
  order by p.suburb
$$;

create or replace function public.storm_morning_recipients(p_suburbs text[])
returns table (client_id uuid, name text, first_name text, phone text, suburb text, source text, skip_reason text)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.storm_morning_pool(public.follow_up_require_admin()) p
  where lower(p.suburb) = any (select lower(btrim(s)) from unnest(p_suburbs) s)
  order by p.suburb, p.name
$$;

-- The button. Queues the storm text for everyone in those suburbs who
-- hasn't had one in 14 days. Outside 8:30am-6pm they go out at 8:30am.
create or replace function public.start_storm_morning(p_suburbs text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.follow_up_require_admin();
  r record;
  v_queued int := 0;
  v_skipped int := 0;
begin
  if not (select enabled from public.follow_up_sequences where tenant_id = v_tenant and key = 'storm_morning') then
    raise exception 'Switch the storm morning text on first (send yourself a test before you do)';
  end if;
  if coalesce(array_length(p_suburbs, 1), 0) = 0 then
    raise exception 'Pick the suburbs the storm hit';
  end if;
  for r in select * from public.storm_morning_recipients(p_suburbs) loop
    if r.skip_reason is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if public.follow_up_enrol(v_tenant, 'storm_morning', r.phone, r.client_id, null, null, null,
         jsonb_build_object('first_name', r.first_name, 'suburb', r.suburb), now(), false, auth.uid()) is not null then
      v_queued := v_queued + 1;
    end if;
  end loop;
  return jsonb_build_object('queued', v_queued, 'skipped_recent', v_skipped);
end;
$$;

grant execute on function public.set_follow_up_sequence_enabled(text, boolean) to authenticated;
grant execute on function public.set_follow_up_test_numbers(text[]) to authenticated;
grant execute on function public.start_follow_up_test(text, text, text) to authenticated;
grant execute on function public.fast_forward_follow_up(uuid) to authenticated;
grant execute on function public.stop_follow_up(uuid) to authenticated;
grant execute on function public.storm_morning_suburbs() to authenticated;
grant execute on function public.storm_morning_recipients(text[]) to authenticated;
grant execute on function public.start_storm_morning(text[]) to authenticated;
grant execute on function public.follow_up_require_admin() to authenticated;
