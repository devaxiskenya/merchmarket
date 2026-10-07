-- APPLY WHEN feat/vendor-kyc-signup IS MERGED AND DEPLOYED. The old server code
-- writes vendor_payments with the brand's own token; dropping these earlier
-- would break payout saving on the live site.
-- Payout details can only be written through the server (which enforces the
--    42h edit window). Direct browser writes would bypass it.
drop policy if exists vp_brand_insert on public.vendor_payments;
drop policy if exists vp_brand_update on public.vendor_payments;

