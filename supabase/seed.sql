-- Local/dev seed: Phase 1 runs a single tenant. Fixed UUID so it's easy to
-- reference from docs/SETUP.md when creating the first admin user via the
-- Supabase Admin API.

insert into public.tenants (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Bingley Roof Consulting')
on conflict (id) do nothing;
