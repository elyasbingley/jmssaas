-- Client Assets - generalizes the existing property_assets table (until now
-- always owned by a managed real-estate property) to also allow a direct
-- client as the owner. Same tracked info (category, name, the schemaless
-- attributes jsonb) either way - a hot water system matters the same
-- whether the property is agency-managed or a direct COD client's own
-- home, so this widens the existing table rather than standing up a
-- parallel one. Not renamed (stays property_assets) to avoid rippling
-- through every existing reference (PropertyDetail.tsx, the recurring
-- maintenance engine, reports.ts, communication engine placeholder
-- resolution) for what's ultimately just an internal table name.
--
-- Job cards resolve which owner a new asset belongs to themselves (see
-- AssetsSection's callers): job.property_id when set (an agency-managed
-- job), otherwise job.client_id - never both.

alter table public.property_assets
  alter column property_id drop not null,
  add column client_id uuid references public.clients (id) on delete cascade;

alter table public.property_assets
  add constraint property_assets_exactly_one_owner_check
  check ((property_id is not null) <> (client_id is not null));

create index property_assets_client_id_idx on public.property_assets (client_id);
