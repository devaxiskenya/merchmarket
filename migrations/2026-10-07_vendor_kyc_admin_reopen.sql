-- Lets an admin reopen a vendor's locked details for a limited time.
alter table public.vendor_kyc
  add column if not exists reopened_until  timestamptz,
  add column if not exists reopened_by     text,
  add column if not exists reopen_reason   text,
  add column if not exists reopened_at     timestamptz;
