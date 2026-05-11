/* =========================================================
   data-store.js
   Browser persistence layer backed by IndexedDB.

   Goal: Replace all localStorage usage with a JSON-shaped DB.
   ========================================================= */

const DB_NAME = 'merchmart_db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key, fallback = null) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result !== undefined ? req.result : fallback);
    req.onerror = () => resolve(fallback);
  });
}

async function kvSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function loadDb() {
  // Store the entire JSON under the 'db' key.
  const fallback = {
    merchUsers: [],
    merchInventory: {},
    merchOrders: {},
    merchCart: [],
    meta: { currentUserId: null }
  };
  const db = await kvGet('db', fallback);
  return db;
}

async function saveDb(db) {
  await kvSet('db', db);
}

async function dbGet(path, fallback) {
  const db = await loadDb();
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = db;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

async function dbSet(path, value) {
  const db = await loadDb();
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = db;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  await saveDb(db);
}

async function dbUpdate(mutator) {
  const db = await loadDb();
  await mutator(db);
  await saveDb(db);
}

// Expose a small global API for legacy scripts.
window.MMData = {
  load: loadDb,
  get: dbGet,
  set: dbSet,
  update: dbUpdate
};

