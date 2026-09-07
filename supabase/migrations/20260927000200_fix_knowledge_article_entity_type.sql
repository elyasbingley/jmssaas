-- Bug fix, found while building Channels: the Knowledge feature's "Email
-- PDF" button (KnowledgeArticle.tsx/mobile articles/[id].tsx) inserts a
-- scheduled_communications row with entity_type: "knowledge_article" (see
-- packages/shared/src/types.ts's ScheduledCommunicationEntityType union),
-- but the DB check constraint was never extended to allow it - every
-- other feature that added a new entity_type value did this same
-- drop+add, this one was simply missed. Without it, every "Email PDF"
-- send on a Knowledge article fails outright with a check constraint
-- violation.

alter table public.scheduled_communications
  drop constraint scheduled_communications_entity_type_check;

alter table public.scheduled_communications
  add constraint scheduled_communications_entity_type_check
  check (entity_type in ('quote', 'invoice', 'job', 'calendar_event', 'client', 'property_asset', 'referral_partner', 'report', 'purchase_order', 'subcontractor', 'client_membership', 'knowledge_article'));
