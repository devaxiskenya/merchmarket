/* ============================================================
   vendor-payments-loader.js
   Loads vendor-payments-db.json and exposes it as
   window.__MMVendorPayments for wishlist.html.

   Note: Works when served via http(s). file:// may fail.
   ============================================================ */

(function () {
  async function load() {
    try {
      const res = await fetch('vendor-payments-db.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      window.__MMVendorPayments = json && typeof json === 'object' ? json : null;
      // Remove comment keys if present
      if (window.__MMVendorPayments && window.__MMVendorPayments.__comment) {
        delete window.__MMVendorPayments.__comment;
      }
    } catch (e) {
      console.warn('Failed to load vendor-payments-db.json', e);
      window.__MMVendorPayments = null;
    }
  }

  // Kick off load ASAP, wishlist.js reads window.__MMVendorPayments.
  // It will still show "Not provided" if loading finishes after render,
  // but we re-render when the load completes.
  document.addEventListener('DOMContentLoaded', () => {
    load().then(() => {
      if (typeof window.__MMWishlistRender === 'function') window.__MMWishlistRender();
    });
  });
})();

