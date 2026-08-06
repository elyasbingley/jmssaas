-- Three independent additions bundled into one migration:
--
--   1. Quote/invoice acceptance signature - accepted_signature_svg holds a
--      drawn signature (same SVG-path capture as report_signatures/the
--      Reports e-signature field) captured on the public approval page at
--      the moment a client accepts, stamped onto the quote/invoice PDF
--      alongside the existing accepted_by_name/accepted_at as real proof of
--      acceptance instead of just a typed name.
--
--   2. Stripe Checkout on invoices - once an invoice is accepted, the
--      invoice link should take the client to pay, not to the same
--      accept/decline page a quote uses (pointless once already accepted).
--      stripe_checkout_url/session/payment_intent are populated by the
--      approve Edge Function calling the Stripe REST API directly (Deno,
--      no SDK) - see docs/SETUP.md for the STRIPE_SECRET_KEY/webhook secret
--      this needs.
--
--   3. CC/BCC on scheduled_communications - every send in this app (quote/
--      invoice delivery, job review requests, and the new free-form job
--      card email) goes through this one table; cc_emails/bcc_emails let
--      the sender's compose step carry those recipients through to Resend.

alter table public.quotes
  add column accepted_signature_svg text;

alter table public.invoices
  add column accepted_signature_svg text,
  add column stripe_checkout_url text,
  add column stripe_checkout_session_id text,
  add column stripe_payment_intent_id text;

alter table public.scheduled_communications
  add column cc_emails text[] not null default '{}',
  add column bcc_emails text[] not null default '{}';
