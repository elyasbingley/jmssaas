-- Lets an admin label a team member with a free-text role/position (e.g.
-- "Foreman", "Office Manager", "Apprentice") distinct from `profiles.role`
-- (admin/technician), which stays a fixed two-value enum since it drives
-- every RLS policy and permission check across the schema - rewriting that
-- into an arbitrary/customisable set would mean touching every one of
-- those policies, far riskier than this cosmetic label deserves. This
-- column is purely organisational: shown next to the security role, never
-- read by RLS or any trigger.
alter table public.profiles add column job_title text;
