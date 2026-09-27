-- Notes module - local-first "second brain" notes (SOPs, ops knowledge,
-- meeting notes, research), modelled on Obsidian's note-taking approach but
-- redesigned for a multi-tenant, multi-user, cloud-backed app: notes are
-- Postgres rows (synced offline to mobile via PowerSync), not files on a
-- disk. Deliberately kept separate from the existing `knowledge_*` module
-- (SOPs/how-tos as published articles, admin-authored, no offline sync,
-- no linking) - different tool for a different job, hence the `note_`
-- prefix throughout rather than reusing "knowledge".
--
-- Desktop stays Supabase-direct/always-online for notes, same as every
-- other desktop screen - offline+PowerSync is mobile-only, per the agreed
-- scope. The conflict-resolution trigger below still applies to every
-- writer regardless of platform (see notes_handle_revision below) - it's
-- not offline-specific, just most likely to actually matter there.
--
-- Permissions: simplified to role tiers (`visibility`/`edit_access` on
-- notes/note_notebooks, each 'tenant' or 'admin_only'), not per-user ACLs -
-- matches every other permission gate in this schema (is_admin()-driven),
-- and nothing in the brief asked for per-person sharing. A note created
-- inside a notebook has its visibility/edit_access copied from the
-- notebook's own defaults at creation time by the app layer (not a live
-- DB-enforced inheritance chain - simpler and avoids a join in every RLS
-- check), then can be overridden per-note afterward.

-- ---------------------------------------------------------------------------
-- note_notebooks - simple hierarchy, per tenant
-- ---------------------------------------------------------------------------

create table public.note_notebooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  parent_id uuid references public.note_notebooks (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  visibility text not null default 'tenant' check (visibility in ('tenant', 'admin_only')),
  edit_access text not null default 'tenant' check (edit_access in ('tenant', 'admin_only')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_note_notebooks_updated_at
  before update on public.note_notebooks
  for each row execute function public.set_updated_at();

create index note_notebooks_tenant_id_idx on public.note_notebooks (tenant_id);
create index note_notebooks_parent_id_idx on public.note_notebooks (parent_id);

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  notebook_id uuid references public.note_notebooks (id) on delete set null,
  title text not null,
  body text not null default '',
  -- Set only for daily notes - lets "open/create today's note" be an
  -- indexed lookup instead of a title-string convention. Unique per
  -- tenant/date so there's only ever one daily note for a given day.
  daily_note_date date,
  visibility text not null default 'tenant' check (visibility in ('tenant', 'admin_only')),
  edit_access text not null default 'tenant' check (edit_access in ('tenant', 'admin_only')),
  -- Conflict-detection counter - see notes_handle_revision() below. Every
  -- save (desktop or mobile) must submit the revision it last read; the
  -- trigger always advances the stored value regardless, and separately
  -- flags the overwritten version as a lost conflict when the submitted
  -- revision was already stale.
  revision integer not null default 1,
  -- Soft delete - deliberately different from this schema's usual hard-
  -- delete-via-RLS convention. Notes are linked to by id/title from other
  -- notes (wikilinks) and can be edited offline on mobile; a hard delete
  -- would orphan backlinks mid-sync and gives an offline user no recovery
  -- path if they delete something by accident. Soft-deleted notes are
  -- filtered out at the application query layer, not by RLS (so a future
  -- "Trash" view / admin restore can still read them).
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) stored
);

create trigger set_notes_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

create index notes_tenant_id_idx on public.notes (tenant_id);
create index notes_notebook_id_idx on public.notes (notebook_id);
create index notes_search_vector_idx on public.notes using gin (search_vector);
create unique index notes_daily_note_idx on public.notes (tenant_id, daily_note_date) where daily_note_date is not null;
-- Case-insensitive exact-title lookup, used constantly by the link
-- resolver/autocomplete/quick switcher.
create index notes_title_idx on public.notes (tenant_id, lower(title));

-- ---------------------------------------------------------------------------
-- note_revisions - edit history (Step 3's "file/edit history") and the
-- offline-conflict audit trail (Step 5) in one table, not two - a
-- conflict-losing version is just a history entry tagged differently.
-- ---------------------------------------------------------------------------

create table public.note_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  note_id uuid not null references public.notes (id) on delete cascade,
  title text not null,
  body text not null,
  revision integer not null,
  edited_by uuid references public.profiles (id),
  edited_at timestamptz not null default now(),
  reason text not null default 'edit' check (reason in ('edit', 'conflict_lost'))
);

create index note_revisions_note_id_idx on public.note_revisions (note_id, edited_at desc);

-- ---------------------------------------------------------------------------
-- Conflict resolution: last-write-wins, but self-healing and never silent.
--
-- A BEFORE UPDATE trigger, so it applies to every writer (desktop, mobile,
-- online or synced-from-offline) uniformly - this isn't only an offline-
-- mobile mechanism, it also catches two desktop tabs (or a desktop edit
-- racing a just-synced mobile edit) saving the same note.
--
-- The stored revision always advances by exactly 1 on every write,
-- regardless of what the client submitted - the counter itself never
-- depends on a client's clock or good behaviour. What the client submits
-- in `new.revision` (the revision it last read) is used only as a *signal*:
-- if it's not still equal to what's actually on the server (`old.revision`),
-- this write is overwriting an edit it never saw, so the about-to-be-lost
-- version is snapshotted with reason='conflict_lost' before being replaced.
-- Nothing is ever rejected and nothing is ever silently destroyed - the
-- overwritten version is always recoverable from note_revisions, and the
-- UI (Step 3) surfaces a banner whenever a note's latest revision entry is
-- a conflict.
-- ---------------------------------------------------------------------------

create or replace function public.notes_handle_revision()
returns trigger
language plpgsql
as $$
begin
  insert into public.note_revisions (tenant_id, note_id, title, body, revision, edited_by, reason)
  values (
    old.tenant_id, old.id, old.title, old.body, old.revision, old.updated_by,
    case when new.revision is distinct from old.revision then 'edit' else 'conflict_lost' end
  );
  new.revision := old.revision + 1;
  return new;
end;
$$;

-- Fires only when title/body actually changed, or the client explicitly
-- passed a revision it read (a pure metadata-only update - e.g. moving a
-- note to a different notebook - shouldn't count as a content conflict or
-- spam the history log).
create trigger notes_handle_revision_trigger
  before update on public.notes
  for each row
  when (old.title is distinct from new.title or old.body is distinct from new.body)
  execute function public.notes_handle_revision();

-- ---------------------------------------------------------------------------
-- note_links - parsed [[wikilink]] targets, recomputed wholesale on every
-- save (see notes_recompute_links_and_tags below). target_note_id is null
-- for an unresolved link (target note doesn't exist yet) - target_title is
-- always stored so backlinks/unlinked-mentions/autocomplete all have the
-- raw text regardless of resolution state.
-- ---------------------------------------------------------------------------

create table public.note_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  source_note_id uuid not null references public.notes (id) on delete cascade,
  target_note_id uuid references public.notes (id) on delete cascade,
  target_title text not null,
  created_at timestamptz not null default now(),
  unique (source_note_id, target_title)
);

create index note_links_source_idx on public.note_links (source_note_id);
create index note_links_target_idx on public.note_links (target_note_id);
create index note_links_target_title_idx on public.note_links (tenant_id, lower(target_title));

-- ---------------------------------------------------------------------------
-- note_tags / note_tag_assignments - #tag support (the brief's source
-- material only folds this implicitly into Properties; kept as its own
-- primitive here since Obsidian tags are a first-class thing, not just a
-- property value).
-- ---------------------------------------------------------------------------

create table public.note_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table public.note_tag_assignments (
  tenant_id uuid not null references public.tenants (id),
  note_id uuid not null references public.notes (id) on delete cascade,
  tag_id uuid not null references public.note_tags (id) on delete cascade,
  primary key (note_id, tag_id)
);

create index note_tag_assignments_tag_idx on public.note_tag_assignments (tag_id);
create index note_tag_assignments_tenant_id_idx on public.note_tag_assignments (tenant_id);

-- ---------------------------------------------------------------------------
-- Recompute links + tags on every save - deletes and rebuilds this note's
-- outgoing links/tags wholesale (simplest correct approach - a note's body
-- is never so large that a full rebuild is expensive), then resolves any
-- existing unresolved links elsewhere that were waiting on this note's
-- title (this is what makes "click an unresolved link, the target note
-- gets created, the link resolves" work without a separate code path -
-- creating OR renaming a note re-runs this same resolution step).
-- security definer so it can write note_links/note_tags/note_tag_
-- assignments regardless of the invoking user's own RLS grants on those
-- tables (the only writer of those three tables is this trigger).
-- ---------------------------------------------------------------------------

create or replace function public.notes_recompute_links_and_tags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m text;
  found_tag_id uuid;
begin
  if tg_op = 'UPDATE' and old.title = new.title and old.body = new.body then
    return new;
  end if;

  delete from public.note_links where source_note_id = new.id;
  for m in
    select distinct trim((regexp_matches(coalesce(new.body, ''), '\[\[([^\]|]+)(\|[^\]]*)?\]\]', 'g'))[1])
  loop
    if length(m) = 0 then
      continue;
    end if;
    insert into public.note_links (tenant_id, source_note_id, target_note_id, target_title)
    values (
      new.tenant_id, new.id,
      (select id from public.notes where tenant_id = new.tenant_id and lower(title) = lower(m) and is_deleted = false and id != new.id limit 1),
      m
    )
    on conflict (source_note_id, target_title) do nothing;
  end loop;

  update public.note_links
  set target_note_id = new.id
  where tenant_id = new.tenant_id and lower(target_title) = lower(new.title) and target_note_id is null and source_note_id != new.id;

  delete from public.note_tag_assignments where note_id = new.id;
  for m in
    select distinct (regexp_matches(coalesce(new.body, ''), '(?:^|\s)#([a-zA-Z0-9_][a-zA-Z0-9_/-]*)', 'g'))[1]
  loop
    found_tag_id := null;
    insert into public.note_tags (tenant_id, name)
    values (new.tenant_id, m)
    on conflict (tenant_id, name) do nothing
    returning id into found_tag_id;

    if found_tag_id is null then
      select id into found_tag_id from public.note_tags where tenant_id = new.tenant_id and name = m;
    end if;

    insert into public.note_tag_assignments (tenant_id, note_id, tag_id)
    values (new.tenant_id, new.id, found_tag_id)
    on conflict do nothing;
  end loop;

  return new;
end;
$$;

create trigger notes_recompute_links_and_tags_trigger
  after insert or update on public.notes
  for each row execute function public.notes_recompute_links_and_tags();

-- ---------------------------------------------------------------------------
-- note_properties - typed structured metadata (YAML-frontmatter
-- equivalent). Modelled as one row per property (EAV) rather than a jsonb
-- column specifically so Step 4's Bases-equivalent table/card views can
-- filter/sort per property key with plain SQL instead of jsonb key
-- extraction.
-- ---------------------------------------------------------------------------

create table public.note_properties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  note_id uuid not null references public.notes (id) on delete cascade,
  key text not null,
  value_type text not null check (value_type in ('text', 'number', 'checkbox', 'date', 'list')),
  value_text text,
  value_number numeric,
  value_checkbox boolean,
  value_date date,
  value_list text[],
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, key)
);

create trigger set_note_properties_updated_at
  before update on public.note_properties
  for each row execute function public.set_updated_at();

create index note_properties_note_id_idx on public.note_properties (note_id);
create index note_properties_key_idx on public.note_properties (tenant_id, key);

-- ---------------------------------------------------------------------------
-- note_templates - reusable note skeletons. Reuses the same {token} style
-- placeholder convention as communication_templates (e.g. {date}) rather
-- than inventing new templating syntax.
-- ---------------------------------------------------------------------------

create table public.note_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  body text not null default '',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_note_templates_updated_at
  before update on public.note_templates
  for each row execute function public.set_updated_at();

create index note_templates_tenant_id_idx on public.note_templates (tenant_id);

-- ---------------------------------------------------------------------------
-- note_attachments - Supabase Storage-backed, same private/tenant-scoped
-- bucket shape as the existing knowledge-files bucket, path convention
-- <tenant_id>/<note_id>/<filename> so storage policies can gate on both
-- tenant AND the specific note's visibility/edit_access.
-- ---------------------------------------------------------------------------

create table public.note_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  note_id uuid not null references public.notes (id) on delete cascade,
  storage_path text not null,
  filename text not null,
  content_type text,
  size_bytes bigint,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index note_attachments_note_id_idx on public.note_attachments (note_id);

insert into storage.buckets (id, name, public)
values ('note-files', 'note-files', false)
on conflict (id) do nothing;

create policy "note-files: tenant read" on storage.objects
  for select using (
    bucket_id = 'note-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and exists (
      select 1 from public.notes n
      where n.id = ((storage.foldername(name))[2])::uuid
        and (n.visibility = 'tenant' or public.is_admin())
    )
  );

create policy "note-files: uploads by note editors" on storage.objects
  for insert with check (
    bucket_id = 'note-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and exists (
      select 1 from public.notes n
      where n.id = ((storage.foldername(name))[2])::uuid
        and (n.edit_access = 'tenant' or public.is_admin())
    )
  );

create policy "note-files: deletes by note editors" on storage.objects
  for delete using (
    bucket_id = 'note-files'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and exists (
      select 1 from public.notes n
      where n.id = ((storage.foldername(name))[2])::uuid
        and (n.edit_access = 'tenant' or public.is_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.note_notebooks enable row level security;

create policy "note_notebooks: select" on public.note_notebooks
  for select using (tenant_id = public.current_tenant_id() and (visibility = 'tenant' or public.is_admin()));
create policy "note_notebooks: insert" on public.note_notebooks
  for insert with check (tenant_id = public.current_tenant_id());
create policy "note_notebooks: update" on public.note_notebooks
  for update using (tenant_id = public.current_tenant_id() and (edit_access = 'tenant' or public.is_admin()));
create policy "note_notebooks: admin deletes" on public.note_notebooks
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.notes enable row level security;

create policy "notes: select" on public.notes
  for select using (tenant_id = public.current_tenant_id() and (visibility = 'tenant' or public.is_admin()));
create policy "notes: insert" on public.notes
  for insert with check (tenant_id = public.current_tenant_id());
create policy "notes: update" on public.notes
  for update using (tenant_id = public.current_tenant_id() and (edit_access = 'tenant' or public.is_admin()));
create policy "notes: admin deletes" on public.notes
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.note_revisions enable row level security;

create policy "note_revisions: select via parent note" on public.note_revisions
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_revisions.note_id and (n.visibility = 'tenant' or public.is_admin()))
  );
-- notes_handle_revision() is a plain (non security-definer) trigger, so it
-- runs as the invoking user and needs its own insert policy here.
create policy "note_revisions: insert via parent note edit access" on public.note_revisions
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_revisions.note_id and (n.edit_access = 'tenant' or public.is_admin()))
  );

alter table public.note_links enable row level security;

create policy "note_links: select via source note" on public.note_links
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_links.source_note_id and (n.visibility = 'tenant' or public.is_admin()))
  );
-- Insert/update/delete only ever happen via notes_recompute_links_and_tags(),
-- which is security definer (bypasses RLS entirely) - no write policies needed.

alter table public.note_tags enable row level security;

create policy "note_tags: tenant read" on public.note_tags
  for select using (tenant_id = public.current_tenant_id());
-- Written only by the security-definer trigger - no write policies needed.

alter table public.note_tag_assignments enable row level security;

create policy "note_tag_assignments: select via note" on public.note_tag_assignments
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_tag_assignments.note_id and (n.visibility = 'tenant' or public.is_admin()))
  );
-- Written only by the security-definer trigger - no write policies needed.

alter table public.note_properties enable row level security;

create policy "note_properties: select via note" on public.note_properties
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_properties.note_id and (n.visibility = 'tenant' or public.is_admin()))
  );
create policy "note_properties: insert via note edit access" on public.note_properties
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_properties.note_id and (n.edit_access = 'tenant' or public.is_admin()))
  );
create policy "note_properties: update via note edit access" on public.note_properties
  for update using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_properties.note_id and (n.edit_access = 'tenant' or public.is_admin()))
  );
create policy "note_properties: delete via note edit access" on public.note_properties
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_properties.note_id and (n.edit_access = 'tenant' or public.is_admin()))
  );

alter table public.note_templates enable row level security;

create policy "note_templates: tenant isolation - select" on public.note_templates
  for select using (tenant_id = public.current_tenant_id());
create policy "note_templates: tenant isolation - insert" on public.note_templates
  for insert with check (tenant_id = public.current_tenant_id());
create policy "note_templates: tenant isolation - update" on public.note_templates
  for update using (tenant_id = public.current_tenant_id());
create policy "note_templates: admin deletes" on public.note_templates
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.note_attachments enable row level security;

create policy "note_attachments: select via note" on public.note_attachments
  for select using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_attachments.note_id and (n.visibility = 'tenant' or public.is_admin()))
  );
create policy "note_attachments: insert via note edit access" on public.note_attachments
  for insert with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_attachments.note_id and (n.edit_access = 'tenant' or public.is_admin()))
  );
create policy "note_attachments: delete via note edit access" on public.note_attachments
  for delete using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.notes n where n.id = note_attachments.note_id and (n.edit_access = 'tenant' or public.is_admin()))
  );
