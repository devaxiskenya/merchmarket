-- Security hardening, phase B. APPLY ONLY AFTER the server + frontend changes
-- (service-client order creation, whitelisted profile PATCH) are deployed, or
-- checkout and profile saving will break.

-- B1) Browsers may only change harmless profile columns. type, role, email, points,
--     completed_purchases, deleted_at can no longer be set by the user.
revoke update on public.profiles from anon, authenticated;
grant update (name, phone, address, bio, website, avatar_url, body_profile, adaptive_sizing_enabled, updated_at)
  on public.profiles to authenticated;
revoke insert on public.profiles from anon, authenticated;
grant insert (id, email, name, type, phone, address, bio, website, avatar_url, body_profile, adaptive_sizing_enabled, created_at, updated_at)
  on public.profiles to authenticated;

-- B2) Orders and their lines are created only by the server (service role), which
--     prices them from the database. Buyers can no longer insert their own,
--     e.g. an order already marked paid.
drop policy if exists orders_member_insert on public.orders;
drop policy if exists order_items_insert on public.order_items;
