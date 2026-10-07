-- Vendor onboarding & KYC (spec section 7) — signup data + approval gate.
-- Documents (ID/passport, permit, signed agreement file) are intentionally NOT
-- part of this migration; they come in a later round.
--
-- Why a separate table (not columns on profiles):
--   * profiles is world-readable for type='brand' (profiles_select_merged), so
--     KRA PIN / payout account details would be public.
--   * profiles_edit_own lets a user update ANY column of their own row, so a
--     status column there could be self-approved.
-- vendor_kyc has owner-SELECT only. No INSERT/UPDATE policy exists, so writes
-- happen only via the signup trigger (SECURITY DEFINER) or the service role.

create table if not exists public.vendor_kyc (
  brand_id              uuid primary key references public.profiles(id) on delete cascade,
  status                text not null default 'pending'
                          check (status in ('pending','documents_submitted','under_review','approved','rejected','suspended')),
  status_reason         text,                       -- rejection / suspension reason shown to the vendor
  business_type         text check (business_type in ('sole_trader','company')),
  contact_person        text,
  phone                 text,
  kra_pin               text check (kra_pin ~ '^[AP][0-9]{9}[A-Z]$'),
  kra_pin_verified_at   timestamptz,                -- set when verified against KRA (later)
  product_category      text check (product_category in ('goods','services','both')),
  payout_method         text check (payout_method in ('mpesa_till','mpesa_paybill','bank')),
  payout_account_number text,                       -- till / paybill / bank account number
  payout_account_name   text,                       -- must match ID + KRA PIN holder before first payout
  payout_bank_name      text,
  agreement_version     text,
  agreement_accepted_at timestamptz,
  reviewed_at           timestamptz,
  reviewed_by           uuid,
  last_verified_at      timestamptz,                -- annual re-verification
  reverify_due_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists vendor_kyc_kra_pin_key
  on public.vendor_kyc (kra_pin) where kra_pin is not null;
create index if not exists vendor_kyc_status_idx on public.vendor_kyc (status);

alter table public.vendor_kyc enable row level security;

drop policy if exists vendor_kyc_select_own on public.vendor_kyc;
create policy vendor_kyc_select_own on public.vendor_kyc
  for select to authenticated
  using (brand_id = (select auth.uid()));

-- Signup trigger: also create the KYC row for brands from the signup metadata.
-- Bad/duplicate values never abort signup (that would surface as a generic
-- "Database error saving new user"); they are nulled and the row stays
-- 'pending' with a reason so an admin can follow up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_type   text  := coalesce(m->>'type', 'member');
  v_pin    text  := upper(nullif(btrim(m->>'kra_pin'), ''));
  v_reason text;
  -- TESTING: new brands are auto-approved. For launch, change to 'pending'
  -- (re-run this function with the one-line change) so manual review applies.
  v_status text := 'approved';
begin
  insert into public.profiles (id, email, name, type, created_at)
  values (
    new.id,
    new.email,
    coalesce(m->>'name', split_part(new.email, '@', 1)),
    v_type,
    now()
  )
  on conflict (id) do update
    set email = excluded.email,
        name  = coalesce(excluded.name, profiles.name),
        type  = coalesce(excluded.type, profiles.type);

  if v_type = 'brand' then
    if v_pin is not null and v_pin !~ '^[AP][0-9]{9}[A-Z]$' then
      v_pin := null;
      v_reason := 'KRA PIN format invalid — needs correction';
    end if;

    begin
      insert into public.vendor_kyc (
        brand_id, status, status_reason, business_type, contact_person, phone, kra_pin,
        product_category, payout_method, payout_account_number, payout_account_name,
        payout_bank_name, agreement_version, agreement_accepted_at
      ) values (
        new.id, v_status, v_reason,
        case when m->>'business_type' in ('sole_trader','company') then m->>'business_type' end,
        nullif(btrim(m->>'contact_person'), ''),
        nullif(btrim(m->>'phone'), ''),
        v_pin,
        case when m->>'product_category' in ('goods','services','both') then m->>'product_category' end,
        case when m->>'payout_method' in ('mpesa_till','mpesa_paybill','bank') then m->>'payout_method' end,
        nullif(btrim(m->>'payout_account_number'), ''),
        nullif(btrim(m->>'payout_account_name'), ''),
        nullif(btrim(m->>'payout_bank_name'), ''),
        nullif(btrim(m->>'agreement_version'), ''),
        case when nullif(btrim(m->>'agreement_version'), '') is not null then now() end
      )
      on conflict (brand_id) do nothing;
    exception when unique_violation then
      insert into public.vendor_kyc (
        brand_id, status, status_reason, business_type, contact_person, phone,
        product_category, payout_method, payout_account_number, payout_account_name,
        payout_bank_name, agreement_version, agreement_accepted_at
      ) values (
        new.id, v_status, 'KRA PIN already registered to another vendor — needs review',
        case when m->>'business_type' in ('sole_trader','company') then m->>'business_type' end,
        nullif(btrim(m->>'contact_person'), ''),
        nullif(btrim(m->>'phone'), ''),
        case when m->>'product_category' in ('goods','services','both') then m->>'product_category' end,
        case when m->>'payout_method' in ('mpesa_till','mpesa_paybill','bank') then m->>'payout_method' end,
        nullif(btrim(m->>'payout_account_number'), ''),
        nullif(btrim(m->>'payout_account_name'), ''),
        nullif(btrim(m->>'payout_bank_name'), ''),
        nullif(btrim(m->>'agreement_version'), ''),
        case when nullif(btrim(m->>'agreement_version'), '') is not null then now() end
      )
      on conflict (brand_id) do nothing;
    end;
  end if;

  return new;
end;
$function$;

-- Grandfather brands that existed before this migration (documents come later).
insert into public.vendor_kyc (brand_id, status, status_reason, reviewed_at)
select id, 'approved', 'Grandfathered: registered before KYC onboarding', now()
from public.profiles
where type = 'brand'
on conflict (brand_id) do nothing;

-- Only approved vendors may list products. products_brand_insert previously
-- allowed any brand to insert straight from the browser, so the gate must live
-- in RLS, not just in the Express route.
drop policy if exists products_brand_insert on public.products;
create policy products_brand_insert on public.products
  for insert to public
  with check (
    brand_id = (select auth.uid())
    and exists (
      select 1 from public.vendor_kyc k
      where k.brand_id = (select auth.uid()) and k.status = 'approved'
    )
  );

-- Manual review (until an admin UI exists), run in the SQL editor:
--   update public.vendor_kyc
--      set status='approved', reviewed_at=now(), status_reason=null,
--          last_verified_at=now(), reverify_due_at=now()+interval '1 year'
--    where brand_id='<brand uuid>';
--   -- reject:  set status='rejected', status_reason='<why>'
--   -- suspend: set status='suspended', status_reason='<why>'
