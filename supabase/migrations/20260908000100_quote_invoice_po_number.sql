-- Optional client purchase order reference, settable on any quote or
-- invoice regardless of client type - previously the only PO-like concept
-- was job_cards.work_order_number, which is real-estate/strata-only and a
-- different thing (the agency's internal work order, not a client-supplied
-- PO). Shown on the PDF as "PO <number>" only when set - see
-- quote-invoice-pdf.ts/apps/mobile/lib/pdf.ts's own conditional rendering.
alter table public.quotes add column po_number text;
alter table public.invoices add column po_number text;
