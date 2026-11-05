-- Customisable client tags, prompted by wanting a visible way to track
-- "opted out of SMS marketing" clients (already enforced automatically -
-- see clients.marketing_opt_out and twilio-sms-webhook - but invisible
-- anywhere in the UI until now), plus a general request to tag clients
-- for whatever else the business wants to track.
--
-- Deliberately NOT how the opt-out flag itself is modelled: a tag is
-- freely rename/delete-able by any admin, which would make it a fragile
-- place to hang a Spam Act 2003 compliance guarantee (an admin deleting
-- or renaming an "Opted Out" tag must never silently undo the actual
-- suppression). clients.marketing_opt_out stays the single source of
-- truth broadcast sending already checks - this migration only adds a
-- separate, general-purpose tagging system alongside it. The opted-out
-- badge becomes visible in the UI as its own thing, not as a tag.
--
-- client_tags: the admin-managed list of available tags (name + an
-- optional display colour, same shape as service_categories/
-- job_lifecycle_stages' own colour field). client_tag_assignments: which
-- clients currently have which tags - a plain many-to-many join, nothing
-- else on it.
--
-- Online-only (not PowerSync-synced), same reasoning as notifications/
-- push_tokens and channel_message_templates/whatsapp_templates: this is
-- admin/office list-management data, not something a technician needs
-- offline, and keeping it off PowerSync avoids yet another "redeploy
-- sync-rules.yaml via the dashboard" step to forget.

create table public.client_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index client_tags_tenant_id_idx on public.client_tags (tenant_id);

create table public.client_tag_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  tag_id uuid not null references public.client_tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (client_id, tag_id)
);

create index client_tag_assignments_tenant_id_idx on public.client_tag_assignments (tenant_id);
create index client_tag_assignments_client_id_idx on public.client_tag_assignments (client_id);
create index client_tag_assignments_tag_id_idx on public.client_tag_assignments (tag_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.client_tags enable row level security;

create policy "client_tags: tenant read" on public.client_tags
  for select using (tenant_id = public.current_tenant_id());

create policy "client_tags: admin writes - insert" on public.client_tags
  for insert with check (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "client_tags: admin writes - update" on public.client_tags
  for update using (tenant_id = public.current_tenant_id() and public.is_admin());

create policy "client_tags: admin writes - delete" on public.client_tags
  for delete using (tenant_id = public.current_tenant_id() and public.is_admin());

alter table public.client_tag_assignments enable row level security;

create policy "client_tag_assignments: tenant read" on public.client_tag_assignments
  for select using (tenant_id = public.current_tenant_id());

-- Tagging/untagging a specific client is lower-stakes than defining the
-- tag list itself (same "any team member, not just admin" shape as
-- client_contacts' own insert/update policy) - anyone on the tenant can
-- apply or remove an existing tag, just not invent new ones.
create policy "client_tag_assignments: tenant insert" on public.client_tag_assignments
  for insert with check (tenant_id = public.current_tenant_id());

create policy "client_tag_assignments: tenant delete" on public.client_tag_assignments
  for delete using (tenant_id = public.current_tenant_id());
