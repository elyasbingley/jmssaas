-- Google Business Profile auto-posting (via Zapier). See GBP_SETUP.md.
--
-- Fitted to JMS's schema (the original draft assumed jobs / job_photos /
-- tenant_members):
--   * jobs        -> job_cards. There's no suburb or job_type on a job: the
--                    suburb comes from its site, else its agency property,
--                    else its client; the "job type" is its service
--                    category's name.
--   * job_photos  -> job_files (photos and other files together; only
--                    image/* rows can be flagged). Its job link is
--                    job_card_id, a foreign key to job_cards.
--   * tenant_members -> profiles (id = auth.uid(), tenant_id, role 'admin' |
--                    'technician'), via the existing current_tenant_id() and
--                    is_admin() helpers. There is no 'owner' role: admins
--                    manage posting.
--   * job_files has no UPDATE policy (nothing in JMS edits a file row), so
--     the marketing flag is set through set_job_file_marketing() below
--     rather than a direct update - the same job access rule as uploading.
--   * pg_cron / pg_net are already enabled from the dashboard (the other
--     sweeps use them); the schedule itself is one-time SQL in
--     GBP_SETUP.md, as for the other sweeps.

-- ---------------------------------------------------------------------------
-- 1. Settings, one row per company
-- ---------------------------------------------------------------------------
create table public.gbp_settings (
  tenant_id            uuid primary key references public.tenants (id) on delete cascade,
  enabled              boolean not null default false,
  zapier_webhook_url   text,                -- treat as a secret
  auto_publish         boolean not null default false,
  business_name        text,
  -- Who the business is, for the caption writer, e.g. "a roofing and
  -- plumbing business in Western Sydney". (The draft had this hard-coded.)
  business_description text,
  default_cta_type     text not null default 'LEARN_MORE'
                       check (default_cta_type in ('LEARN_MORE', 'CALL')),
  default_cta_url      text,
  -- e.g. {"roof-repairs": "https://bingleytrades.com.au/roof-repairs", ...}
  service_urls         jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(service_urls) = 'object'),
  voice_notes          text,                -- extra caption rules for Claude
  updated_at           timestamptz not null default now()
);

create trigger set_gbp_settings_updated_at
  before update on public.gbp_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Posts (draft -> approved -> published | failed | skipped)
-- ---------------------------------------------------------------------------
create table public.gbp_posts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  job_card_id   uuid references public.job_cards (id) on delete set null,
  job_file_id   uuid references public.job_files (id) on delete set null,
  job_type      text,                -- the job's service category name
  photo_url     text not null,
  summary       text not null check (char_length(summary) <= 1500),
  service_key   text,
  cta_type      text not null default 'LEARN_MORE'
                check (cta_type in ('LEARN_MORE', 'CALL')),
  cta_url       text,
  status        text not null default 'draft'
                check (status in ('draft', 'approved', 'published', 'failed', 'skipped')),
  concerns      text[] not null default '{}',
  error         text,
  approved_by   uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);

create index gbp_posts_tenant_created_idx on public.gbp_posts (tenant_id, created_at desc);
create index gbp_posts_tenant_status_idx on public.gbp_posts (tenant_id, status);

-- ---------------------------------------------------------------------------
-- 3. Photo flags on job_files
-- ---------------------------------------------------------------------------
alter table public.job_files
  add column marketing_ok    boolean not null default false,
  add column marketing_path  text,   -- path inside the 'marketing' bucket
  add column used_in_post_id uuid references public.gbp_posts (id) on delete set null;

create index job_files_marketing_idx
  on public.job_files (tenant_id, created_at desc)
  where marketing_ok and marketing_path is not null and used_in_post_id is null;

-- Flag (p_marketing_path set) or unflag (null) a job photo for marketing.
-- Anyone who can see the job - admins, or the job's technician - can flag
-- its photos, as GBP_SETUP.md intends ("you or a tech"). Only touches the
-- two marketing columns; the path must be this company's folder in the
-- marketing bucket.
create or replace function public.set_job_file_marketing(p_job_file_id uuid, p_marketing_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.job_files;
begin
  select * into f from public.job_files where id = p_job_file_id;
  if not found
     or f.tenant_id is distinct from public.current_tenant_id()
     or not exists (
       select 1 from public.job_cards jc
       where jc.id = f.job_card_id
         and (public.is_admin() or jc.assigned_technician_id = auth.uid())
     ) then
    raise exception 'job file not found' using errcode = 'P0002';
  end if;
  if p_marketing_path is not null then
    if coalesce(f.mime_type, '') not like 'image/%' then
      raise exception 'only photos can be used for marketing' using errcode = '22023';
    end if;
    if p_marketing_path not like f.tenant_id::text || '/%' then
      raise exception 'marketing path must be in this company''s folder' using errcode = '22023';
    end if;
  end if;
  update public.job_files
     set marketing_ok = p_marketing_path is not null,
         marketing_path = p_marketing_path
   where id = p_job_file_id;
end;
$$;

revoke execute on function public.set_job_file_marketing(uuid, text) from public, anon;
grant execute on function public.set_job_file_marketing(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS - admins of the company only
-- ---------------------------------------------------------------------------
alter table public.gbp_settings enable row level security;
alter table public.gbp_posts    enable row level security;

create policy "gbp_settings: admin" on public.gbp_settings
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "gbp_posts: admin" on public.gbp_posts
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. Public 'marketing' bucket (resized copies with no EXIF/GPS only)
--    Objects are stored as  <tenant_id>/<job_file_id>.jpg
--    Public buckets are readable by URL without a policy; these cover
--    writes, by anyone in the company (a tech can flag a photo).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('marketing', 'marketing', true)
on conflict (id) do nothing;

create policy "marketing: tenant insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'marketing' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

create policy "marketing: tenant update" on storage.objects
  for update to authenticated
  using (bucket_id = 'marketing' and (storage.foldername(name))[1] = public.current_tenant_id()::text)
  with check (bucket_id = 'marketing' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

create policy "marketing: tenant delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'marketing' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

-- Upserting an object (upload with upsert: true) also needs SELECT on it.
create policy "marketing: tenant select" on storage.objects
  for select to authenticated
  using (bucket_id = 'marketing' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
