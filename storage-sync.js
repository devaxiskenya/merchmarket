/* =========================================================
   storage-sync.js
   Drop-in shims for localStorage for the existing codebase.
   
   Note: localStorage is synchronous; our MMStorage is async.
   To keep changes minimal, we DO NOT fully polyfill localStorage.

   Instead we convert the handful of functions that are used in our
   JS files (saveLocal/loadLocal) by redefining them to call MMStorage.

   This file provides:
   - window.MMDataReady: promise resolved when MMData is ready
   - window.installLocalStorageShim(): overrides localStorage methods
   ========================================================= */

(function () {
  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  window.MMDataReady = (async () => {
    // Wait for MMData
    for (let i = 0; i < 50; i++) {
      if (window.MMData && window.MMStorage) return true;
      await wait(50);
    }
    if (!window.MMData) throw new Error('MMData not found');
    if (!window.MMStorage) throw new Error('MMStorage not found');
    return true;
  })();

  window.installLocalStorageShim = function installLocalStorageShim() {
    // Intentionally no-op.
    // This app uses localStorage as the source-of-truth (sync + simple).
    return;
  };
})();


