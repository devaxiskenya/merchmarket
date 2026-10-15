-- Admin dashboard support. Additive; safe to run before or after the code deploys.
begin;

-- 1. Log of every action taken from the private admin app. Server (service role) only.
create table if not exists public.admin_actions (
  id          bigint generated always as identity primary key,
  admin_email text not null,
  action      text not null,
  target_type text,
  target_id   text,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists admin_actions_created_idx on public.admin_actions(created_at desc);
alter table public.admin_actions enable row level security;
revoke all on public.admin_actions from anon, authenticated;

-- 2. Admin hide for products. Separate from archived_at (which brands control),
--    so a brand cannot undo a takedown.
alter table public.products
  add column if not exists admin_hidden_at     timestamptz,
  add column if not exists admin_hidden_reason text;

create or replace function public.guard_product_admin_fields() returns trigger
language plpgsql set search_path = public as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
begin
  if v_role in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.admin_hidden_at := null;
      new.admin_hidden_reason := null;
    elsif new.admin_hidden_at is distinct from old.admin_hidden_at
       or new.admin_hidden_reason is distinct from old.admin_hidden_reason then
      raise exception 'Only MerchMarket can change a product''s takedown status' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_product_admin_fields() from public, anon, authenticated;

drop trigger if exists trg_guard_product_admin_fields on public.products;
create trigger trg_guard_product_admin_fields before insert or update on public.products
  for each row execute function public.guard_product_admin_fields();

-- Public sees only live products; buyers keep seeing what they ordered; a brand
-- still sees its own hidden products in its dashboard.
drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products for select using (
  (archived_at is null and admin_hidden_at is null)
  or user_ordered_product(id)
  or (brand_id = (select auth.uid()) and archived_at is null)
);

commit;
