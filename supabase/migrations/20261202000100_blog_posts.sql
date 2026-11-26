-- Website blog posts from finished jobs (see BLOG_SETUP.md).
--
-- Three times a week blog-draft picks a finished job that has photos marked
-- "OK for marketing" (the same flag Google posts use) and has Claude write
-- a case-study post about it. An admin edits and approves it in More > Blog
-- Posts; blog-publish then commits the post and its photos to the website's
-- GitHub repository, and Vercel publishes it.
--
-- Same shape as the Google posts tables (gbp_posts migration): one settings
-- row per company, posts admin-only through RLS, everything written by the
-- functions with the service role.

-- ---------------------------------------------------------------------------
-- 1. Settings, one row per company
-- ---------------------------------------------------------------------------
create table public.blog_settings (
  tenant_id            uuid primary key references public.tenants (id) on delete cascade,
  enabled              boolean not null default false,
  -- The website's GitHub repository ("owner/name") and branch Vercel
  -- deploys from. The access token is a function secret
  -- (WEBSITE_GITHUB_TOKEN), never stored here.
  github_repo          text check (github_repo is null or github_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  github_branch        text not null default 'main' check (github_branch ~ '^[A-Za-z0-9._/-]+$'),
  site_url             text check (site_url is null or site_url ~ '^https://'),
  business_name        text,
  business_description text,
  voice_notes          text,                -- extra writing rules for Claude
  updated_at           timestamptz not null default now()
);

create trigger set_blog_settings_updated_at
  before update on public.blog_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Posts (draft -> approved -> published | failed | skipped)
-- ---------------------------------------------------------------------------
create table public.blog_posts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  job_card_id   uuid references public.job_cards (id) on delete set null,
  slug          text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 90),
  title         text not null check (char_length(title) between 1 and 140),
  description   text not null check (char_length(description) between 1 and 320),
  body          text not null check (char_length(body) between 1 and 20000),
  suburb        text,
  job_type      text,                -- the job's service category name
  -- [{ "job_file_id": uuid, "url": public marketing copy, "alt": text }]
  photos        jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array'),
  -- { "heading", "text", "button" } for the box at the end of the post
  cta           jsonb,
  status        text not null default 'draft'
                check (status in ('draft', 'approved', 'published', 'failed', 'skipped')),
  concerns      text[] not null default '{}',
  error         text,
  approved_by   uuid references public.profiles (id) on delete set null,
  published_url text,
  commit_sha    text,
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  unique (tenant_id, slug)
);

-- One post per job: a skipped post keeps its job from being suggested again.
create unique index blog_posts_one_per_job on public.blog_posts (tenant_id, job_card_id) where job_card_id is not null;
create index blog_posts_tenant_created_idx on public.blog_posts (tenant_id, created_at desc);
create index blog_posts_tenant_status_idx on public.blog_posts (tenant_id, status);

-- ---------------------------------------------------------------------------
-- 3. RLS - admins of the company only
-- ---------------------------------------------------------------------------
alter table public.blog_settings enable row level security;
alter table public.blog_posts    enable row level security;

create policy "blog_settings: admin" on public.blog_settings
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "blog_posts: admin" on public.blog_posts
  for all to authenticated
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id() and public.is_admin());
