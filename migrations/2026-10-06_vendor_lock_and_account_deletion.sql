-- Vendor details lock window + brand account deletion.

-- 1) Soft-delete support. Paid orders (and the escrow/payment records behind
--    them) must be kept, so a deleted brand leaves a scrubbed tombstone profile
--    and any product that appears in a kept order is archived, not removed.
alter table public.profiles add column if not exists deleted_at timestamptz;
alter table public.products add column if not exists archived_at timestamptz;

create or replace function public.user_ordered_product(p_product uuid)
returns boolean
language sql security definer stable
set search_path to 'public'
as $$
  select exists (
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.product_id = p_product and o.user_id = auth.uid()
  );
$$;

drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products
  for select to public
  using (archived_at is null or public.user_ordered_product(id));

-- 2) What stops a brand deleting its account.
create or replace function public.brand_deletion_blockers(p_brand uuid)
returns jsonb
language sql security definer stable
set search_path to 'public'
as $$
  select jsonb_build_object(
    'open_orders',     (select count(*) from public.orders
                         where brand_id = p_brand and payment_status = 'paid'
                           and status not in ('completed', 'cancelled')),
    'unsettled_funds', (select count(*) from public.escrow_payments
                         where brand_id = p_brand
                           and status in ('held', 'release_approved', 'disputed')),
    'unpaid_orders',   (select count(*) from public.orders
                         where brand_id = p_brand and payment_status <> 'paid')
  );
$$;

-- 3) The deletion itself (one transaction). Called only by the server after it
--    re-checks the password.
create or replace function public.delete_brand_account_data(p_brand uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_blockers jsonb;
  v_unpaid   uuid[];
  v_keep     uuid[];
  v_kept_orders int;
  v_del_products int;
begin
  perform 1 from public.profiles where id = p_brand and type = 'brand' for update;
  if not found then
    raise exception 'BRAND_NOT_FOUND';
  end if;

  v_blockers := public.brand_deletion_blockers(p_brand);
  if (v_blockers->>'open_orders')::int > 0 or (v_blockers->>'unsettled_funds')::int > 0 then
    raise exception 'BRAND_DELETION_BLOCKED %', v_blockers::text;
  end if;

  -- Unpaid / failed orders: remove entirely (items, history, notifications and
  -- delivery codes cascade; escrow rows have no cascade so go first).
  select coalesce(array_agg(id), '{}') into v_unpaid
    from public.orders where brand_id = p_brand and payment_status <> 'paid';
  delete from public.escrow_events   where escrow_id in (select id from public.escrow_payments where order_id = any(v_unpaid));
  delete from public.escrow_disputes where escrow_id in (select id from public.escrow_payments where order_id = any(v_unpaid));
  delete from public.escrow_payments where order_id = any(v_unpaid);
  delete from public.orders          where id = any(v_unpaid);

  -- Products still referenced by kept (paid) orders are archived; the rest go.
  select coalesce(array_agg(distinct oi.product_id), '{}') into v_keep
    from public.order_items oi join public.orders o on o.id = oi.order_id
   where o.brand_id = p_brand;
  select count(*) into v_kept_orders from public.orders where brand_id = p_brand;

  delete from public.products where brand_id = p_brand and not (id = any(v_keep));
  get diagnostics v_del_products = row_count;

  delete from public.cart_items where product_id = any(v_keep);
  delete from public.wishlists  where product_id = any(v_keep);
  delete from public.product_variants where product_id = any(v_keep);
  update public.products
     set archived_at = now(), seller = 'Deleted brand', stock = 0,
         description = '', tags = '[]'::jsonb, updated_at = now()
   where id = any(v_keep);

  -- Everything personal to the brand.
  delete from public.vendor_kyc             where brand_id = p_brand;
  delete from public.vendor_payments        where brand_id = p_brand;
  delete from public.vendor_payment_methods where brand_id = p_brand;
  delete from public.couriers               where brand_id = p_brand;
  delete from public.notifications          where user_id = p_brand;
  delete from public.cart_items             where user_id = p_brand;
  delete from public.wishlists              where user_id = p_brand;
  delete from public.member_sizes           where user_id = p_brand;
  delete from public.member_badges          where user_id = p_brand;
  delete from public.member_payment_methods where user_id = p_brand;

  update public.profiles
     set name = 'Deleted brand',
         email = 'deleted-' || p_brand::text || '@deleted.invalid',
         phone = null, address = null, bio = null, website = null,
         avatar_url = null, body_profile = null,
         type = 'deleted', deleted_at = now(), updated_at = now()
   where id = p_brand;

  return jsonb_build_object(
    'unpaid_orders_deleted', coalesce(array_length(v_unpaid, 1), 0),
    'products_deleted',      v_del_products,
    'products_archived',     coalesce(array_length(v_keep, 1), 0),
    'orders_retained',       v_kept_orders
  );
end;
$$;

revoke all on function public.brand_deletion_blockers(uuid)   from public, anon, authenticated;
revoke all on function public.delete_brand_account_data(uuid) from public, anon, authenticated;
grant execute on function public.brand_deletion_blockers(uuid)   to service_role;
grant execute on function public.delete_brand_account_data(uuid) to service_role;
