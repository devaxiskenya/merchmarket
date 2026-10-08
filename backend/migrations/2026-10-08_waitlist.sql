-- Waitlist for the landing page (frontend/landing.html).
-- Anonymous visitors can INSERT only; nobody can read the list from the browser.
-- View/export signups in the Supabase table editor (service role / dashboard).

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  role        text not null check (role in ('buyer','vendor')),
  name        text not null check (char_length(name) between 2 and 80),
  email       text not null check (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone       text check (phone is null or phone ~ '^\+?[0-9 ()-]{7,20}$'),
  brand_name  text check (brand_name is null or char_length(brand_name) <= 80),
  source      text check (source is null or char_length(source) <= 40),
  created_at  timestamptz not null default now()
);

create unique index if not exists waitlist_email_unique on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

revoke all on public.waitlist from anon, authenticated;
-- Column-level grant: visitors cannot set id or created_at.
grant insert (role, name, email, phone, brand_name, source) on public.waitlist to anon, authenticated;

drop policy if exists waitlist_insert on public.waitlist;
create policy waitlist_insert on public.waitlist
  for insert to anon, authenticated
  with check (role in ('buyer','vendor') and char_length(name) >= 2);
