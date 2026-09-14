-- Lets an invoice for a real-estate/strata job be redirected to bill the
-- property's landlord/owner instead of the agency/PM client row the job
-- was created against - see InvoiceDetail.tsx's "Bill to" control. Only
-- meaningful when job_cards.is_real_estate_job is true and the property
-- has owner_landlord_name/_phone/_email on file (see the
-- property_landlord_contact_and_edit migration); otherwise this stays
-- false and behaves exactly as before this column existed.
alter table public.invoices
  add column bill_to_landlord boolean not null default false;
