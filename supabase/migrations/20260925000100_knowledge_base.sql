-- Knowledge base - SOPs/how-tos/educational articles for staff and
-- clients (ServiceM8's "Knowledge" module). categories -> articles is a
-- two-level taxonomy, same shape as price_book_categories -> price_book_
-- items and report_categories -> ... -> report_templates.
--
-- articles.content_blocks is a jsonb array of typed blocks (text/image/
-- video_embed) - same "no fixed columns for an editor's content" tradeoff
-- report_templates.structure_schema and property_assets.attributes already
-- make. Postgres doesn't validate its internal shape; zod in
-- packages/shared/src/schemas.ts validates the outer shape at the app
-- boundary, and the block editor UI only ever writes one of the three
-- known block variants - see packages/shared/src/knowledge.ts.
--
-- Video is embed-only (a YouTube/Vimeo/Loom URL stored on the block, no
-- video file upload/hosting) - deliberately out of scope for this pass:
-- self-hosting video is a real storage/bandwidth cost and Supabase
-- Storage isn't built for video streaming at scale. The block shape
-- doesn't preclude adding a video_upload variant later without a rework.
--
-- Storage: one new "knowledge-files" bucket holds both an article's
-- inline images and its compiled "Email/Download as PDF" export, under
-- `<tenant_id>/<article_id>/<filename>` - same private, tenant/admin-
-- scoped shape as report-files (not price-book-images' public bucket):
-- nothing here needs to be publicly link-shareable, since "forward this
-- around" (the spec's own wording) means forwarding the compiled PDF
-- itself (images embedded as PDF content), not a link back into the app.
--
-- RLS: tenant-wide read (any signed-in staff member, technicians
-- included - "accessible on site with the app" is the whole point),
-- admin-only writes - same shape as report_categories/report_templates.

create table public.knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_knowledge_categories_updated_at
  before update on public.knowledge_categories
  for each row execute function public.set_updated_at();

create index knowledge_categories_tenant_id_idx on public.knowledge_categories (tenant_id);

create table public.knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  category_id uuid references public.knowledge_categories (id) on delete set null,
  title text not null,
  content_blocks jsonb not null default '[]'::jsonb,
  -- Draft articles are still admin-visible/editable but hidden from the
  -- tenant-wide read every other staff member gets - same "not ready yet"
  -- gate a report_instance's own draft status provides on that side.
  is_published boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_knowledge_articles_updated_at
  before update on public.knowledge_articles
  for each row execute function public.set_updated_at();

create index knowledge_articles_tenant_id_idx on public.knowledge_articles (tenant_id);
create index knowledge_articles_category_id_idx on public.knowledge_articles (category_id);

insert into storage.buckets (id, name, public)
values ('knowledge-files', 'knowledge-files', false)
on conflict (id) do nothing;

create policy "knowledge-files: tenant read" on storage.objects
  for select using (
    bucket_id = 'knowledge-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

create policy "knowledge-files: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'knowledge-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "knowledge-files: admin updates" on storage.objects
  for update using (
    bucket_id = 'knowledge-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "knowledge-files: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'knowledge-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

alter table public.knowledge_categories enable row level security;
alter table public.knowledge_articles enable row level security;

create policy "knowledge_categories: tenant read" on public.knowledge_categories
  for select using (tenant_id = public.current_tenant_id());
create policy "knowledge_categories: admin writes - insert" on public.knowledge_categories
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "knowledge_categories: admin writes - update" on public.knowledge_categories
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "knowledge_categories: admin writes - delete" on public.knowledge_categories
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

-- Published articles are readable tenant-wide; unpublished (draft) ones
-- are admin-only to read, same "not ready yet" visibility gate as the
-- is_published column comment above describes.
create policy "knowledge_articles: tenant read published" on public.knowledge_articles
  for select using (tenant_id = public.current_tenant_id() and (is_published or public.is_admin()));
create policy "knowledge_articles: admin writes - insert" on public.knowledge_articles
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "knowledge_articles: admin writes - update" on public.knowledge_articles
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());
create policy "knowledge_articles: admin writes - delete" on public.knowledge_articles
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());
