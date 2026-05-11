/* =========================================================
   auth-reset.js
   Simple reset helper for MerchMarket auth/app data.

   Clears IndexedDB (merchmart_db) and a few legacy localStorage keys.
   ========================================================= */

(function () {
  function clearLegacyLocalStorage() {
    try {
      const keysToRemove = [
        'currentUserId',
        'merchCart',
        'merchCatalogDirty',
        'merchProducts'
      ];
      keysToRemove.forEach(k => {
        try { localStorage.removeItem(k); } catch (_) {}
      });
    } catch (_) {}
  }

  async function clearIndexedDb() {
    // data-store.js uses: DB_NAME = 'merchmart_db' and store 'kv'
    // We delete the whole database so we remove users/inventory/orders.
    if (!('indexedDB' in window)) return;

    const DB_NAME = 'merchmart_db';
    await new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  async function resetAuthAndData() {
    if (!confirm('⚠️ Reset Auth/Data? This clears your app data (users, inventory, orders, cart).')) return;

    clearLegacyLocalStorage();
    await clearIndexedDb();

    // Hard reload to pick up fresh state
    window.location.href = 'index.html';
  }

  window.resetAuthAndData = resetAuthAndData;
})();

