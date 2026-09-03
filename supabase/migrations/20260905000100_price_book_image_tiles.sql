-- Lets a price book category or item show an uploaded image as its tile
-- background (name overlaid at the bottom) instead of the plain color-
-- swatch tile - same "public bucket, tenant/admin-scoped writes" shape as
-- company-logos (see the invoice_pdf_rebrand migration's own comment on
-- why the bucket has to be public).
alter table public.price_book_categories add column image_url text;
alter table public.price_book_items add column image_url text;

insert into storage.buckets (id, name, public)
values ('price-book-images', 'price-book-images', true)
on conflict (id) do nothing;

create policy "price-book-images: public read" on storage.objects
  for select using (bucket_id = 'price-book-images');

create policy "price-book-images: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'price-book-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "price-book-images: admin updates" on storage.objects
  for update using (
    bucket_id = 'price-book-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "price-book-images: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'price-book-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );
