-- Payout details were readable by anyone (vp_public_read, using=true).
-- Restrict SELECT to the owning brand. The server reads this table with the
-- brand's own token (GET /api/brand/payments), so nothing else is affected.
drop policy if exists vp_public_read on public.vendor_payments;
drop policy if exists vp_owner_read on public.vendor_payments;
create policy vp_owner_read on public.vendor_payments
  for select to authenticated
  using (brand_id = (select auth.uid()));
