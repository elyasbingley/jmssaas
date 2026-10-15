-- Price Book gets the two line-item-rework fields that make sense on a
-- reusable catalogue entry without requiring a full editor rebuild: unit
-- (so a catalogue item can already carry its benchmark unit, e.g. "lm" for
-- a "Ridge re-bed" entry) and warranty_text (so a standard warranty is
-- authored once on the catalogue item rather than retyped on every quote
-- line it's added to).
--
-- The full itemized cost-rate/charge-rate/margin split from the
-- line_item_rework_schema migration is deliberately NOT added here - Price
-- Book items are still priced by labour_rate_cents/labour_hours/
-- material_cost_cents/markup_percent exactly as before. Itemizing the
-- catalogue itself (its own crew/materials breakdown) is a larger editor
-- rebuild across both apps' four price-book forms, left for a later pass
-- if wanted; these two fields are additive and useful on their own.
--
-- AddLineItemBar (desktop and mobile) carries both straight through when a
-- line item is added from a catalogue item, variation, or bundle - a new
-- quote/invoice line's unit/warranty_text start pre-filled from the
-- catalogue the same way its price already does.

alter table public.price_book_items
  add column unit text,
  add column warranty_text text;

alter table public.price_book_item_variations
  add column unit text,
  add column warranty_text text;
