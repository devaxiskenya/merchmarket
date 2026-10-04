-- Order tracking, phase 2. Run once, in a single transaction.
-- Status meanings:  pending -> confirmed -> active (being prepared) -> shipped
--                   -> completed (DELIVERED, set only by a courier scan) | cancelled
begin;

-- 0. System actions (courier scan, payment webhook) have no signed-in user. Awarding
--    reward points updates a profile, which fires the audit trigger and would fail on
--    NOT NULL. A null user_id now means "done by the system".
alter table public.audit_logs alter column user_id drop not null;

-- 1. Statuses and new columns -------------------------------------------------
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status = any (array['pending','confirmed','active','shipped','completed','cancelled']));

alter table public.orders
  add column if not exists tracking_number  text,
  add column if not exists carrier          text,
  add column if not exists shipped_at       timestamptz,
  add column if not exists delivered_at     timestamptz,
  add column if not exists last_status_note text;

-- 2. Tables -------------------------------------------------------------------
create table public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status   text not null,
  note        text,
  actor_id    uuid,
  actor_role  text,
  created_at  timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history(order_id, created_at);
alter table public.order_status_history enable row level security;
create policy order_history_read on public.order_status_history for select using (
  exists (select 1 from public.orders o where o.id = order_id
          and (o.user_id = (select auth.uid()) or o.brand_id = (select auth.uid()))));
revoke insert, update, delete on public.order_status_history from anon, authenticated;

create table public.couriers (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  access_code_hash text not null,            -- sha256 hex of the access code
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
alter table public.couriers enable row level security;
revoke all on public.couriers from anon, authenticated;

-- Secrets live here. No RLS policies and no grants: only the server (service role) can read it,
-- so brands can never see a buyer's delivery code.
create table public.delivery_codes (
  order_id    uuid primary key references public.orders(id) on delete cascade,
  token       text not null unique,          -- long random value inside the QR code
  short_code  text not null,                 -- 6-digit backup code
  attempts    int  not null default 0,
  issued_at   timestamptz not null default now(),
  redeemed_at timestamptz,
  courier_id  uuid references public.couriers(id)
);
alter table public.delivery_codes enable row level security;
revoke all on public.delivery_codes from anon, authenticated;

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  order_id   uuid references public.orders(id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);
alter table public.notifications enable row level security;
create policy notifications_read   on public.notifications for select using (user_id = (select auth.uid()));
create policy notifications_mark   on public.notifications for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, update, delete on public.notifications from anon, authenticated;
grant update (read_at) on public.notifications to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- 3. Guard: what a signed-in brand/member session may change ------------------
-- The server (service role) and the SQL editor are exempt, so payment webhooks
-- and the courier scan keep working. Everything else goes through these rules.
create or replace function public.guard_order_changes() returns trigger
language plpgsql set search_path = public as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
begin
  if v_role = 'authenticated' then
    if new.payment_status      is distinct from old.payment_status
    or new.points_awarded      is distinct from old.points_awarded
    or new.pesapal_tracking_id is distinct from old.pesapal_tracking_id
    or new.checkout_group_id   is distinct from old.checkout_group_id
    or new.total_amount        is distinct from old.total_amount
    or new.user_id             is distinct from old.user_id
    or new.brand_id            is distinct from old.brand_id
    or new.shipped_at          is distinct from old.shipped_at
    or new.delivered_at        is distinct from old.delivered_at then
      raise exception 'Payment, totals and delivery fields can only be changed by the system'
        using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('confirmed','cancelled'))
      or (old.status = 'confirmed' and new.status in ('active','shipped','cancelled'))
      or (old.status = 'active'    and new.status in ('shipped','cancelled'))) then
      raise exception 'Order cannot move from % to % this way. Delivery is confirmed by the courier scan.',
        old.status, new.status using errcode = 'check_violation';
    end if;
    if (new.tracking_number is distinct from old.tracking_number or new.carrier is distinct from old.carrier)
       and new.status not in ('confirmed','active','shipped') then
      raise exception 'Tracking details can only be set while an order is open' using errcode = 'check_violation';
    end if;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'shipped'   and new.shipped_at   is null then new.shipped_at   := now(); end if;
    if new.status = 'completed' and new.delivered_at is null then new.delivered_at := now(); end if;
    if new.last_status_note is not distinct from old.last_status_note then new.last_status_note := null; end if;
  end if;
  return new;
end $$;

-- Name sorts before trg_award_purchase_rewards, so it runs first.
create trigger trg_a_guard_order_changes before update on public.orders
  for each row execute function public.guard_order_changes();

-- The existing payment gate did not know about 'shipped'.
create or replace function public.enforce_payment_before_fulfillment() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status in ('confirmed','active','shipped','completed')
     and old.status = 'pending'
     and new.payment_status <> 'paid' then
    raise exception 'Order cannot be progressed until payment_status is paid (order %, payment_status=%)',
      new.id, new.payment_status using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- 4. History, notifications, delivery code issuing ------------------------------
create or replace function public.log_order_changes() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role  text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', 'system');
  v_brand text;
  v_title text;
  v_body  text;
begin
  if tg_op = 'INSERT' then
    insert into order_status_history(order_id, from_status, to_status, actor_id, actor_role)
    values (new.id, null, new.status, auth.uid(), v_role);
    return new;
  end if;

  select name into v_brand from profiles where id = new.brand_id;
  v_brand := coalesce(v_brand, 'The seller');

  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    insert into notifications(user_id, order_id, type, title, body)
    values (new.user_id, new.id, 'order_paid', 'Payment received',
            'We received your payment. ' || v_brand || ' can now prepare your order.');
  end if;

  if new.status is distinct from old.status then
    insert into order_status_history(order_id, from_status, to_status, note, actor_id, actor_role)
    values (new.id, old.status, new.status, new.last_status_note, auth.uid(), v_role);

    v_title := case new.status
      when 'confirmed' then 'Order confirmed'
      when 'active'    then 'Order being prepared'
      when 'shipped'   then 'Your order has shipped'
      when 'completed' then 'Order delivered'
      when 'cancelled' then 'Order cancelled' end;
    v_body := case new.status
      when 'confirmed' then v_brand || ' confirmed your order.'
      when 'active'    then v_brand || ' is getting your items ready.'
      when 'shipped'   then v_brand || ' has shipped your order.'
                            || coalesce(' Tracking number: ' || new.tracking_number || '.', '')
                            || ' Show your delivery QR code to the courier when it arrives.'
      when 'completed' then 'Your order was delivered. Thanks for shopping with MerchMarket.'
      when 'cancelled' then v_brand || ' cancelled this order.' end;
    if v_title is not null then
      insert into notifications(user_id, order_id, type, title, body)
      values (new.user_id, new.id, 'order_' || new.status, v_title, v_body);
    end if;

    if new.status = 'shipped' then
      insert into delivery_codes(order_id, token, short_code)
      values (new.id,
              replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
              lpad(((('x' || substr(md5(gen_random_uuid()::text), 1, 7))::bit(28)::bigint) % 1000000)::text, 6, '0'))
      on conflict (order_id) do nothing;
    end if;
  end if;
  return new;
end $$;

create trigger trg_log_order_insert after insert on public.orders
  for each row execute function public.log_order_changes();
create trigger trg_log_order_update after update on public.orders
  for each row execute function public.log_order_changes();

-- 5. Courier scan: the only way an order becomes 'completed' -----------------------
-- Called by the server with the service role. Failed attempts are counted and kept,
-- so it returns a result instead of raising.
create or replace function public.confirm_delivery(
  p_courier uuid, p_token text, p_order_id uuid, p_short_code text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code  delivery_codes%rowtype;
  v_order orders%rowtype;
  v_cname text;
begin
  if p_token is not null then
    select * into v_code from delivery_codes where token = p_token for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  elsif p_order_id is not null and p_short_code is not null then
    select * into v_code from delivery_codes where order_id = p_order_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
    if v_code.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
    if v_code.short_code <> p_short_code then
      update delivery_codes set attempts = attempts + 1 where order_id = v_code.order_id;
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  if v_code.redeemed_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_redeemed');
  end if;
  select * into v_order from orders where id = v_code.order_id for update;
  if v_order.status <> 'shipped' then return jsonb_build_object('ok', false, 'reason', 'not_shipped'); end if;
  if v_order.payment_status <> 'paid' then return jsonb_build_object('ok', false, 'reason', 'unpaid'); end if;

  select name into v_cname from couriers where id = p_courier;
  update orders set status = 'completed',
         last_status_note = 'Delivery confirmed by courier' || coalesce(' (' || v_cname || ')', '')
   where id = v_order.id;
  update delivery_codes set redeemed_at = now(), courier_id = p_courier where order_id = v_order.id;
  return jsonb_build_object('ok', true, 'order_id', v_order.id);
end $$;

revoke all on function public.confirm_delivery(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_delivery(uuid, text, uuid, text) to service_role;

-- 6. Backfill one history row per existing order -------------------------------------
insert into public.order_status_history(order_id, from_status, to_status, note, actor_role, created_at)
select id, null, status, 'Existing order', 'system', created_at from public.orders;

-- 7. Brands may delete only unpaid orders; a paid order is a record that must be kept.
drop policy if exists orders_brand_delete on public.orders;
create policy orders_brand_delete on public.orders for delete
  using (brand_id = (select auth.uid()) and payment_status <> 'paid');

commit;

-- ---------------------------------------------------------------------------
-- Brand riders (applied as migration "order_tracking_brand_riders"):
--  * couriers.brand_id  (null = platform courier, set = that brand's own rider)
--  * unique index on access_code_hash
--  * confirm_delivery() rejects a brand rider scanning another brand's order
--    (answers "invalid", and does not count against the buyer's backup-code attempts)
-- See the live function definition for the current body.
