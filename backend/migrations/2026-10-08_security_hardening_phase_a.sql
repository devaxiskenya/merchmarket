-- Security hardening, phase A. Safe to apply before the matching server deploy.

-- A1) A brand may only delete line items of orders that are still unpaid.
--     (It could previously strip items out of paid orders.)
drop policy if exists order_items_brand_delete on public.order_items;
create policy order_items_brand_delete on public.order_items
  for delete to public
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and o.brand_id = (select auth.uid())
      and o.payment_status <> 'paid'
  ));

-- A2) Signup metadata can only ever create a 'member' or 'brand' profile.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.handle_new_user'::regproc);
  if position($q$v_type   text  := coalesce(m->>'type', 'member');$q$ in d) = 0 then
    raise exception 'handle_new_user did not match the expected text';
  end if;
  d := replace(d,
    $q$v_type   text  := coalesce(m->>'type', 'member');$q$,
    $q$v_type   text  := case when m->>'type' = 'brand' then 'brand' else 'member' end;$q$);
  execute d;
end $$;

-- A3) A profile row can only be created for yourself, with your own email, as member/brand.
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (
    (select auth.uid()) = id
    and type in ('member', 'brand')
    and lower(email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
  );

-- A4) Product image bucket: 5 MB per file, real image types only (no SVG/HTML).
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
 where id = 'product-images';
