-- Lets an inventory item show an uploaded photo as its tile background
-- (name overlaid at the bottom) on mobile's inventory screen, same
-- "public bucket, tenant/admin-scoped writes" shape as company-logos and
-- price-book-images.
alter table public.inventory_items add column image_url text;

insert into storage.buckets (id, name, public)
values ('inventory-images', 'inventory-images', true)
on conflict (id) do nothing;

create policy "inventory-images: public read" on storage.objects
  for select using (bucket_id = 'inventory-images');

create policy "inventory-images: admin uploads" on storage.objects
  for insert with check (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "inventory-images: admin updates" on storage.objects
  for update using (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );

create policy "inventory-images: admin deletes" on storage.objects
  for delete using (
    bucket_id = 'inventory-images'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
    and public.is_admin()
  );
