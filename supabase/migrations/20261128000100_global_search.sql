-- Search everything from the top bar: clients (name, company, phone, email,
-- address), their contacts and other addresses, jobs, job notes, quotes,
-- invoices, files, tasks, notes, assets (brand, model, serial), the price
-- book, knowledge articles, agency properties, agencies and property
-- managers, subcontractors, purchase orders, emails in the inbox, Channels
-- conversations and the team.
--
-- Runs as the person searching (security invoker), so row-level security
-- applies: a technician only finds what they could already open. Phone
-- numbers match on their digits whatever the spacing ("0411000031" finds
-- "0411 000 031", and "+61 411..." too). Up to 6 results of each kind,
-- best matches (starting with the search) first.

create or replace function public.global_search(p_query text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_pat text;
  v_start text;
  v_digits text;
  v_phone text := null;
  v_out jsonb;
begin
  if length(v_q) < 2 then
    return '[]'::jsonb;
  end if;
  -- LIKE wildcards typed by the user are matched literally.
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_start := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(v_q, '\D', '', 'g');
  -- Mostly digits and long enough to be (part of) a phone number: match
  -- on digits only, without the leading 0 or 61.
  if length(v_digits) >= 6 and length(v_digits) >= length(regexp_replace(v_q, '[\s+()-]', '', 'g')) - 1 then
    v_phone := '%' || regexp_replace(v_digits, '^(61|0)', '') || '%';
  end if;

  with hits as (
    -- Clients
    (select 'client' as kind, c.id, c.name as title,
            concat_ws(' · ', nullif(c.company_name, ''), nullif(c.phone, ''), nullif(c.email, ''), nullif(concat_ws(', ', c.address_line1, c.suburb), '')) as subtitle,
            '/clients/' || c.id as link,
            case when c.name ilike v_pat or c.company_name ilike v_pat then null
                 when v_phone is not null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like v_phone then 'phone'
                 when c.email ilike v_pat then 'email' else 'address' end as matched,
            (c.name ilike v_start)::int as rank, c.created_at as at
     from public.clients c
     where c.name ilike v_pat or c.company_name ilike v_pat or c.email ilike v_pat or c.address_line1 ilike v_pat or c.suburb ilike v_pat or c.postcode ilike v_pat
        or (v_phone is not null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like v_phone)
     order by rank desc, c.created_at desc limit 6)
    union all
    -- A client's contacts
    (select 'contact', cc.client_id, cc.name || coalesce(' (' || cl.name || ')', ''),
            concat_ws(' · ', nullif(cc.role, ''), nullif(cc.phone, ''), nullif(cc.email, '')),
            '/clients/' || cc.client_id,
            case when v_phone is not null and regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') like v_phone then 'phone' when cc.email ilike v_pat then 'email' else null end,
            (cc.name ilike v_start)::int, cc.created_at
     from public.client_contacts cc left join public.clients cl on cl.id = cc.client_id
     where cc.name ilike v_pat or cc.email ilike v_pat or (v_phone is not null and regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g') like v_phone)
     order by 7 desc, cc.created_at desc limit 6)
    union all
    -- A client's other addresses
    (select 'address', cs.client_id, concat_ws(', ', cs.address_line1, cs.suburb),
            concat_ws(' · ', cl.name, nullif(cs.label, '')),
            '/clients/' || cs.client_id, 'address',
            (cs.address_line1 ilike v_start)::int, cs.created_at
     from public.client_sites cs left join public.clients cl on cl.id = cs.client_id
     where cs.address_line1 ilike v_pat or cs.suburb ilike v_pat or cs.label ilike v_pat or cs.postcode ilike v_pat
     order by 7 desc, cs.created_at desc limit 6)
    union all
    -- Jobs
    (select 'job', j.id, concat_ws(' ', j.number, j.title),
            concat_ws(' · ', cl.name, st.name),
            '/jobs/' || j.id,
            case when j.title ilike v_pat or j.number ilike v_pat then null when j.work_order_number ilike v_pat then 'work order' else 'description' end,
            (j.number ilike v_start or j.title ilike v_start)::int, j.created_at
     from public.job_cards j
     left join public.clients cl on cl.id = j.client_id
     left join public.job_lifecycle_stages st on st.id = j.lifecycle_stage_id
     where j.title ilike v_pat or j.number ilike v_pat or j.description ilike v_pat or j.work_order_number ilike v_pat
     order by 7 desc, j.created_at desc limit 6)
    union all
    -- Job notes
    (select 'job_note', n.job_card_id, concat_ws(' ', j.number, j.title),
            left(regexp_replace(n.body, '\s+', ' ', 'g'), 120),
            '/jobs/' || n.job_card_id, 'note', 0, n.created_at
     from public.job_notes n join public.job_cards j on j.id = n.job_card_id
     where n.body ilike v_pat
     order by n.created_at desc limit 6)
    union all
    -- Quotes
    (select 'quote', q.id, concat_ws(' ', q.quote_number, '-', cl.name),
            concat_ws(' · ', initcap(q.status::text), to_char(q.total_cents / 100.0, 'FM$999,999,990.00'), q.issue_date::text),
            '/quotes/' || q.id,
            case when q.quote_number ilike v_pat then null when q.po_number ilike v_pat then 'PO number' else 'notes' end,
            (q.quote_number ilike v_start)::int, q.created_at
     from public.quotes q left join public.clients cl on cl.id = q.client_id
     where q.quote_number ilike v_pat or q.po_number ilike v_pat or q.notes ilike v_pat
     order by 7 desc, q.created_at desc limit 6)
    union all
    -- Invoices
    (select 'invoice', i.id, concat_ws(' ', i.invoice_number, '-', cl.name),
            concat_ws(' · ', initcap(i.status::text), to_char(i.total_cents / 100.0, 'FM$999,999,990.00'), i.issue_date::text),
            '/invoices/' || i.id,
            case when i.invoice_number ilike v_pat then null when i.po_number ilike v_pat then 'PO number' else 'notes' end,
            (i.invoice_number ilike v_start)::int, i.created_at
     from public.invoices i left join public.clients cl on cl.id = i.client_id
     where i.invoice_number ilike v_pat or i.po_number ilike v_pat or i.notes ilike v_pat
     order by 7 desc, i.created_at desc limit 6)
    union all
    -- Files on jobs and tasks
    (select 'file', f.id, f.file_name, concat_ws(' ', j.number, j.title), '/jobs/' || f.job_card_id, null, 0, f.created_at
     from public.job_files f join public.job_cards j on j.id = f.job_card_id
     where f.file_name ilike v_pat
     order by f.created_at desc limit 6)
    union all
    (select 'file', f.id, f.file_name, 'Task ' || coalesce(t.number, '') || ' ' || coalesce(t.title, ''), '/tasks/' || f.task_id, null, 0, f.created_at
     from public.task_files f join public.tasks t on t.id = f.task_id
     where f.file_name ilike v_pat
     order by f.created_at desc limit 6)
    union all
    -- Tasks
    (select 'task', t.id, concat_ws(' ', t.number, t.title), initcap(replace(t.status::text, '_', ' ')), '/tasks/' || t.id,
            case when t.title ilike v_pat or t.number ilike v_pat then null else 'description' end,
            (t.title ilike v_start)::int, t.created_at
     from public.tasks t
     where t.title ilike v_pat or t.number ilike v_pat or t.description ilike v_pat
     order by 7 desc, t.created_at desc limit 6)
    union all
    -- Notes
    (select 'note', n.id, coalesce(nullif(n.title, ''), 'Untitled note'), left(regexp_replace(coalesce(n.body, ''), '\s+', ' ', 'g'), 120), '/notes/note/' || n.id,
            case when n.title ilike v_pat then null else 'text' end,
            (n.title ilike v_start)::int, n.updated_at
     from public.notes n
     where not n.is_deleted and (n.title ilike v_pat or n.body ilike v_pat)
     order by 7 desc, n.updated_at desc limit 6)
    union all
    -- Assets (brand, model, serial number...)
    (select 'asset', a.id, a.asset_name, concat_ws(' · ', coalesce(cl.name, p.address_line1), nullif(concat_ws(' ', a.attributes ->> 'brand', a.attributes ->> 'model'), ''), 'SN ' || (a.attributes ->> 'serial_number')),
            case when a.property_id is not null then '/real-estate/properties/' || a.property_id else '/clients/' || a.client_id end,
            case when a.asset_name ilike v_pat then null else 'details' end,
            (a.asset_name ilike v_start)::int, a.created_at
     from public.property_assets a
     left join public.clients cl on cl.id = a.client_id
     left join public.properties p on p.id = a.property_id
     where a.asset_name ilike v_pat or a.attributes::text ilike v_pat or a.location ilike v_pat
     order by 7 desc, a.created_at desc limit 6)
    union all
    -- Price book
    (select 'price_book', pb.id, pb.description, nullif(pb.unit, ''), '/price-book/items/' || pb.id, null, (pb.description ilike v_start)::int, pb.created_at
     from public.price_book_items pb
     where pb.description ilike v_pat
     order by 7 desc, pb.description limit 6)
    union all
    -- Knowledge
    (select 'knowledge', k.id, k.title, null, '/knowledge/articles/' || k.id, null, (k.title ilike v_start)::int, k.created_at
     from public.knowledge_articles k
     where k.title ilike v_pat
     order by 7 desc, k.created_at desc limit 6)
    union all
    -- Agency properties
    (select 'property', p.id, concat_ws(', ', p.address_line1, p.suburb), concat_ws(' · ', nullif(p.tenant_name, ''), nullif(p.owner_landlord_name, ''), 'key ' || nullif(p.key_tag_number, '')),
            '/real-estate/properties/' || p.id,
            case when p.address_line1 ilike v_pat or p.suburb ilike v_pat then 'address'
                 when v_phone is not null and (regexp_replace(coalesce(p.tenant_phone, ''), '\D', '', 'g') like v_phone or regexp_replace(coalesce(p.owner_landlord_phone, ''), '\D', '', 'g') like v_phone) then 'phone'
                 else 'tenant / owner' end,
            (p.address_line1 ilike v_start)::int, p.created_at
     from public.properties p
     where p.address_line1 ilike v_pat or p.suburb ilike v_pat or p.postcode ilike v_pat or p.tenant_name ilike v_pat or p.owner_landlord_name ilike v_pat
        or p.tenant_email ilike v_pat or p.owner_landlord_email ilike v_pat or p.key_tag_number ilike v_pat or p.strata_plan_number ilike v_pat
        or (v_phone is not null and (regexp_replace(coalesce(p.tenant_phone, ''), '\D', '', 'g') like v_phone or regexp_replace(coalesce(p.owner_landlord_phone, ''), '\D', '', 'g') like v_phone))
     order by 7 desc, p.created_at desc limit 6)
    union all
    -- Agencies and property managers
    (select 'agency', ag.id, ag.name, concat_ws(' · ', nullif(ag.phone, ''), nullif(ag.billing_email, '')), '/real-estate', null, (ag.name ilike v_start)::int, ag.created_at
     from public.agencies ag
     where ag.name ilike v_pat or ag.billing_email ilike v_pat or (v_phone is not null and regexp_replace(coalesce(ag.phone, ''), '\D', '', 'g') like v_phone)
     order by 7 desc, ag.created_at desc limit 6)
    union all
    (select 'property_manager', pm.id, concat_ws(' ', pm.first_name, pm.last_name), concat_ws(' · ', ag.name, nullif(pm.mobile, ''), nullif(pm.email, '')), '/real-estate', null,
            (pm.first_name ilike v_start)::int, pm.created_at
     from public.property_managers pm left join public.agencies ag on ag.id = pm.agency_id
     where concat_ws(' ', pm.first_name, pm.last_name) ilike v_pat or pm.email ilike v_pat
        or (v_phone is not null and (regexp_replace(coalesce(pm.mobile, ''), '\D', '', 'g') like v_phone or regexp_replace(coalesce(pm.work_phone, ''), '\D', '', 'g') like v_phone))
     order by 7 desc, pm.created_at desc limit 6)
    union all
    -- Subcontractors
    (select 'subcontractor', sc.id, sc.company_name, nullif(sc.trades::text, '{}'), '/subcontractors/' || sc.id, null, (sc.company_name ilike v_start)::int, sc.created_at
     from public.subcontractor_companies sc
     where sc.company_name ilike v_pat or sc.abn ilike v_pat
     order by 7 desc, sc.created_at desc limit 6)
    union all
    (select 'subcontractor', sp.subcontractor_id, concat_ws(' ', sp.first_name, sp.last_name) || coalesce(' (' || sc.company_name || ')', ''), concat_ws(' · ', nullif(sp.mobile, ''), nullif(sp.email, '')),
            '/subcontractors/' || sp.subcontractor_id, null, 0, sp.created_at
     from public.subcontractor_contacts sp left join public.subcontractor_companies sc on sc.id = sp.subcontractor_id
     where concat_ws(' ', sp.first_name, sp.last_name) ilike v_pat or sp.email ilike v_pat
        or (v_phone is not null and regexp_replace(coalesce(sp.mobile, ''), '\D', '', 'g') like v_phone)
     order by sp.created_at desc limit 6)
    union all
    -- Purchase orders
    (select 'purchase_order', po.id, po.po_number, initcap(replace(po.status::text, '_', ' ')), '/subcontractors/purchase-orders/' || po.id, null, (po.po_number ilike v_start)::int, po.created_at
     from public.purchase_orders po
     where po.po_number ilike v_pat
     order by 7 desc, po.created_at desc limit 6)
    union all
    -- Inbox emails
    (select 'email', m.id, coalesce(nullif(m.subject, ''), '(no subject)'), concat_ws(' · ', coalesce(nullif(m.from_name, ''), m.from_email), to_char(m.received_at at time zone 'Australia/Sydney', 'DD Mon YYYY')),
            '/inbox/' || m.id, case when m.subject ilike v_pat then null when m.from_email ilike v_pat or m.from_name ilike v_pat then 'sender' else 'message' end,
            0, m.received_at
     from public.inbox_messages m
     where m.subject ilike v_pat or m.from_email ilike v_pat or m.from_name ilike v_pat or m.body_text ilike v_pat
     order by m.received_at desc limit 6)
    union all
    -- Channels conversations
    (select 'conversation', cv.id, coalesce(nullif(cv.contact_name, ''), cl.name, cv.external_contact), concat_ws(' · ', upper(cv.channel_type::text), cv.external_contact, left(cv.last_message_preview, 80)),
            '/channels/' || cv.id, null, 0, cv.last_message_at
     from public.channel_conversations cv left join public.clients cl on cl.id = cv.client_id
     where cv.contact_name ilike v_pat or cv.last_message_preview ilike v_pat or cl.name ilike v_pat
        or (v_phone is not null and regexp_replace(coalesce(cv.external_contact, ''), '\D', '', 'g') like v_phone)
     order by cv.last_message_at desc nulls last limit 6)
    union all
    -- The team
    (select 'team', pr.id, pr.full_name, concat_ws(' · ', initcap(pr.role::text), nullif(pr.phone, ''), pr.email), '/team', null, (pr.full_name ilike v_start)::int, pr.created_at
     from public.profiles pr
     where pr.full_name ilike v_pat or pr.email ilike v_pat or (v_phone is not null and regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g') like v_phone)
     order by 7 desc, pr.full_name limit 6)
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'title', title, 'subtitle', nullif(subtitle, ''), 'link', link, 'matched', matched)), '[]'::jsonb)
  into v_out
  from hits;
  return v_out;
end;
$$;

revoke execute on function public.global_search(text) from public, anon;
grant execute on function public.global_search(text) to authenticated;
