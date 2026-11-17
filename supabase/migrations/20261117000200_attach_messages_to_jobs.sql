-- Attaching an Inbox email or a Channels message (SMS, WhatsApp, Messenger,
-- Instagram, missed call) to a job that already exists.
--
-- Before this, Inbox only offered "attach to an existing job" when the email
-- had file attachments, and attaching copied only those files - nothing about
-- the email itself showed on the job. Channels offered no attach at all.
--
-- Now attaching adds a job note carrying the message (who it was from, when,
-- and its text), and the app copies any files/voicemail into the job's files.
-- A job note, rather than a new "emails on a job" section, so it shows
-- everywhere job notes already do, including the phone app offline.
--
-- attach_message_to_job builds that note here, from the stored message, so
-- the note is always the real message and the note + link are written in
-- one transaction. It is SECURITY DEFINER because channel_messages has no
-- client write policy (only the Edge Functions write it); it checks admin
-- and company itself instead.

alter table public.channel_messages
  add column linked_job_id uuid references public.job_cards (id) on delete set null;

create index channel_messages_linked_job_id_idx on public.channel_messages (linked_job_id);

create or replace function public.attach_message_to_job(
  p_job_card_id uuid,
  p_inbox_message_id uuid default null,
  p_channel_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_job public.job_cards;
  v_inbox public.inbox_messages;
  v_msg public.channel_messages;
  v_conv public.channel_conversations;
  v_client_name text;
  v_who text;
  v_label text;
  v_files text;
  v_header text[];
  v_text text;
  v_note_id uuid;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can attach messages to a job';
  end if;
  if (p_inbox_message_id is null) = (p_channel_message_id is null) then
    raise exception 'Choose one message to attach';
  end if;

  select * into v_job from public.job_cards where id = p_job_card_id and tenant_id = v_tenant;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;

  if p_inbox_message_id is not null then
    select * into v_inbox from public.inbox_messages where id = p_inbox_message_id and tenant_id = v_tenant for update;
    if v_inbox.id is null then
      raise exception 'Email not found';
    end if;
    if v_inbox.linked_job_id = p_job_card_id then
      raise exception 'This email is already attached to job %', v_job.number;
    end if;

    select string_agg(file_name, ', ' order by file_name) into v_files from public.inbox_attachments where message_id = v_inbox.id;
    v_header := array[
      'Email from ' || case when nullif(trim(v_inbox.from_name), '') is not null then trim(v_inbox.from_name) || ' <' || v_inbox.from_email || '>' else v_inbox.from_email end,
      'Subject: ' || coalesce(nullif(trim(v_inbox.subject), ''), '(no subject)'),
      'Received: ' || to_char(v_inbox.received_at at time zone 'Australia/Sydney', 'DD/MM/YYYY FMHH12:MI am')
    ];
    if v_files is not null then
      v_header := v_header || ('Attachments: ' || v_files || ' (added to this job''s files)');
    end if;
    v_text := coalesce(nullif(trim(v_inbox.body_text), ''), '(no text)');

    update public.inbox_messages set status = 'attached', linked_job_id = p_job_card_id where id = v_inbox.id;
  else
    select * into v_msg from public.channel_messages where id = p_channel_message_id and tenant_id = v_tenant for update;
    if v_msg.id is null then
      raise exception 'Message not found';
    end if;
    if v_msg.linked_job_id = p_job_card_id then
      raise exception 'This message is already attached to job %', v_job.number;
    end if;
    select * into v_conv from public.channel_conversations where id = v_msg.conversation_id;
    select name into v_client_name from public.clients where id = v_conv.client_id;

    v_who := coalesce(nullif(trim(v_client_name), ''), nullif(trim(v_conv.contact_name), ''));
    v_who := case when v_who is not null and v_who <> v_conv.external_contact then v_who || ' (' || v_conv.external_contact || ')' else v_conv.external_contact end;
    v_label := case v_conv.channel_type::text
      when 'sms' then 'SMS'
      when 'whatsapp' then 'WhatsApp'
      when 'messenger' then 'Messenger'
      when 'instagram' then 'Instagram'
      when 'missed_call' then 'Missed call'
      else v_conv.channel_type::text
    end;
    select string_agg(item ->> 'file_name', ', ') into v_files from jsonb_array_elements(coalesce(v_msg.media, '[]'::jsonb)) item;

    if v_conv.channel_type::text = 'missed_call' and v_msg.direction::text = 'inbound' then
      v_header := array['Missed call from ' || v_who];
    elsif v_msg.direction::text = 'outbound' then
      v_header := array[v_label || ' sent to ' || v_who];
    else
      v_header := array[v_label || ' from ' || v_who];
    end if;
    v_header := v_header || (case when v_msg.direction::text = 'outbound' then 'Sent: ' else 'Received: ' end
      || to_char(v_msg.created_at at time zone 'Australia/Sydney', 'DD/MM/YYYY FMHH12:MI am'));
    if v_files is not null then
      v_header := v_header || (case when v_conv.channel_type::text = 'missed_call' then 'Voicemail' else 'Attachments' end || ': ' || v_files || ' (added to this job''s files)');
    end if;
    if v_msg.location is not null then
      v_header := v_header || ('Location: ' || coalesce(nullif(v_msg.location ->> 'label', ''), nullif(v_msg.location ->> 'address', ''), 'shared location')
        || ' - https://www.google.com/maps?q=' || (v_msg.location ->> 'latitude') || ',' || (v_msg.location ->> 'longitude'));
    end if;
    -- A missed call's own body is just the placeholder text the webhook
    -- writes ("📞 Missed call" / "🎙️ Voicemail message").
    v_text := case when v_conv.channel_type::text = 'missed_call' then null else nullif(trim(v_msg.body), '') end;

    update public.channel_messages set linked_job_id = p_job_card_id where id = v_msg.id;
  end if;

  insert into public.job_notes (tenant_id, job_card_id, author_id, body)
  values (v_tenant, p_job_card_id, auth.uid(), array_to_string(v_header, E'\n') || coalesce(E'\n\n' || v_text, ''))
  returning id into v_note_id;

  return jsonb_build_object('note_id', v_note_id, 'job_number', v_job.number);
end;
$$;

revoke execute on function public.attach_message_to_job(uuid, uuid, uuid) from public, anon;
grant execute on function public.attach_message_to_job(uuid, uuid, uuid) to authenticated;
