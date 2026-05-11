/* =========================================================
   storage.js
   localStorage-like API implemented using IndexedDB via data-store.js.

   It is intentionally minimal: get/set/remove/keys.
   ========================================================= */

(function () {
  function ensure() {
    if (!window.MMData) throw new Error('MMData not initialized. Include data-store.js first.');
    return window.MMData;
  }

  // We keep an in-memory cache of the whole db for speed.
  let cache = null;
  let cacheAt = 0;
  const CACHE_TTL_MS = 500; // small to avoid stale UI

  async function getCache() {
    const now = Date.now();
    if (!cache || (now - cacheAt) > CACHE_TTL_MS) {
      cache = ensure().load();
      cacheAt = now;
    }
    return cache;
  }

  async function loadDb() {
    const dbPromise = await getCache();
    return dbPromise;
  }

  function toKeyParts(key) {
    // legacy localStorage keys are like: merchUsers, merchInventory_{id}, merchOrders_{id}, merchCart, currentUserId
    if (key === 'merchUsers') return ['merchUsers'];
    if (key === 'merchCart') return ['merchCart'];
    if (key === 'currentUserId') return ['meta', 'currentUserId'];
    if (key.startsWith('merchInventory_')) {
      const brandId = key.substring('merchInventory_'.length);
      return ['merchInventory', brandId];
    }
    if (key.startsWith('merchOrders_')) {
      const brandId = key.substring('merchOrders_'.length);
      return ['merchOrders', brandId];
    }
    if (key === 'merchProducts') return ['merchProducts']; // optional
    return null;
  }

  async function getItem(key) {
    const parts = toKeyParts(key);
    if (!parts) return null;
    const db = await loadDb();
    let cur = db;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur === undefined ? null : JSON.stringify(cur);
  }

  async function setItem(key, json) {
    const parts = toKeyParts(key);
    if (!parts) return;
    const value = JSON.parse(json);
    await ensure().update(async (db) => {
      let cur = db;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = value;
    });
  }

  async function removeItem(key) {
    const parts = toKeyParts(key);
    if (!parts) return;
    await ensure().update(async (db) => {
      let cur = db;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!cur[p]) return;
        cur = cur[p];
      }
      delete cur[parts[parts.length - 1]];
    });
  }

  async function keys() {
    // Only keys we know about for this app.
    const db = await loadDb();
    const out = [];
    if (db.merchUsers) out.push('merchUsers');
    if (Array.isArray(db.merchCart)) out.push('merchCart');
    if (db.meta && db.meta.currentUserId != null) out.push('currentUserId');

    if (db.merchInventory) {
      for (const brandId of Object.keys(db.merchInventory)) {
        out.push(`merchInventory_${brandId}`);
      }
    }
    if (db.merchOrders) {
      for (const brandId of Object.keys(db.merchOrders)) {
        out.push(`merchOrders_${brandId}`);
      }
    }
    return out;
  }

  // Expose globally
  window.MMStorage = { getItem, setItem, removeItem, keys };

  // Legacy sync helpers (source of truth: localStorage)
  function lsGet(key, fallback){
    try{
      const raw = localStorage.getItem(key);
      if(raw == null) return fallback;
      return JSON.parse(raw);
    }catch{ return fallback; }
  }
  function lsSet(key, value){
    localStorage.setItem(key, JSON.stringify(value));
  }
  function lsRemove(key){
    localStorage.removeItem(key);
  }

  // Async-compatible wrapper that mirrors MMStorage signatures,
  // but actually uses localStorage under the hood.
  window.MMStorageSync = {
    getItem: async (key) => {
      const v = lsGet(key, null);
      return v === null ? null : JSON.stringify(v);
    },
    setItem: async (key, json) => {
      lsSet(key, JSON.parse(json));
    },
    removeItem: async (key) => {
      lsRemove(key);
    },
    keys: async () => Object.keys(localStorage)
  };
})();


