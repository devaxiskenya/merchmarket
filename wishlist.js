/* ========================================
   MERCHMARKET — WISHLIST PAGE JS
   - Uses localStorage.merchCart as wishlist source
   - Displays vendor (brand) preferred payment details
   - Does NOT take payment on the site
   - Creates orders (optional wire-up) without collecting payment
   ======================================== */

(function () {
  const CART_KEY = 'merchCart';

  // Wishlist badge sync (header counters)
  function updateWishlistBadge() {
    const count = loadCart().reduce((s, i) => s + (i.quantity || 1), 0);
    const badge = document.getElementById('wishlist-count');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  }


  // In-memory "separate database": do NOT persist merchant payment details in localStorage.
  // For now this page supports the existing cart (stored in localStorage) but pulls payment
  // profile from a separate JSON "database" file when available.
  //
  // Because browser code cannot read arbitrary files via file:// reliably,
  // we fallback to window.__MMVendorPayments if merchmarket.js provided it.
  // If neither exists, UI shows "Not provided".

  function safeParse(json, fallback) {
    try {
      const v = JSON.parse(json);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  function loadCartSyncFallback() {
    try {
      return safeParse(localStorage.getItem(CART_KEY), []);
    } catch {
      return [];
    }
  }

  function loadCart() {
    // Source of truth: localStorage (sync)
    return loadCartSyncFallback();
  }



  // Vendor payment database (separate from localStorage)
  // Wishlist tries to load vendor-payments-db.json into window.__MMVendorPayments.
  // Expected shape:
  // {
  //   [brandId]: { method: 'mpesa'|'bank'|'paypal'|'cash', details: {...}, updatedAt: '...' }
  // }
  function getVendorPaymentProfile(brandId) {
    const db = window.__MMVendorPayments;
    if (!db) return null;
    return db[String(brandId)] || null;
  }

  function getCatalogBrandMap() {
    // seller name -> brandId
    const users = typeof loadLocal === 'function' ? loadLocal('merchUsers', []) : [];
    const map = {};
    users.filter(u => u.type === 'brand').forEach(b => {
      map[b.name] = b.id;
    });
    return map;
  }

  function moneyKES(n) {
    const num = Number(n) || 0;
    return 'KES ' + num.toFixed(0);
  }

  function createWishlistItemRow(item, idx) {
    const thumb = item.image
      ? `<img src="${item.image}" style="width:100%;height:100%;object-fit:cover;" />`
      : '';

    return `
      <div class="wishlist-item" data-cart-index="${idx}">
        <div class="item-thumb">${thumb || ''}</div>
        <div>
          <div class="item-name">${item.name}</div>
          <div class="item-sub">Qty: ${item.quantity}</div>
        </div>
        <div class="item-right">${moneyKES(item.price * item.quantity)}</div>
        <button class="remove-btn" onclick="removeWishlistItem(${idx})" title="Remove">×</button>
      </div>
    `;
  }

  function render() {
    const cart = loadCart();
    const emptyEl = document.getElementById('wishlist-empty');
    const vendorsEl = document.getElementById('wishlist-vendors');

    const totalItems = cart.reduce((s, i) => s + (i.quantity || 1), 0);
    if (!cart.length) {
      if (emptyEl) emptyEl.style.display = 'block';
      if (vendorsEl) vendorsEl.innerHTML = '';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    const bySeller = {};
    cart.forEach((item, idx) => {
      const seller = item.seller || 'MerchMarket';
      if (!bySeller[seller]) bySeller[seller] = [];
      bySeller[seller].push({ ...item, _cartIndex: idx });
    });

    const brandMap = getCatalogBrandMap();

    const vendorBlocks = Object.entries(bySeller).map(([seller, items]) => {
      const brandId = brandMap[seller];

      const blockId = `vendor-${String(brandId ?? seller).replace(/[^a-zA-Z0-9_-]/g, '')}`;
      const firstItem = items[0];
      const subtotal = items.reduce((s, i) => s + (i.price * i.quantity), 0);

      const payment = brandId ? getVendorPaymentProfile(brandId) : null;
      const method = payment?.method || '';
      const details = payment?.details || null;

      // Lightweight preview
      const preview = payment
        ? `<div class="pay-notice" style="margin-top:.25rem;">${method || 'Payment method'}${details?.phone ? ' • ' + details.phone : ''}</div>`
        : `<div class="pay-notice" style="margin-top:.25rem;">Not provided yet</div>`;

      const itemsHtml = items
        .map((it) => createWishlistItemRow(it, it._cartIndex))
        .join('');

      return `
        <div class="vendor-block" >
          <div class="vendor-header">
            <div>
              <div class="vendor-name">${seller}</div>
              <div class="vendor-meta">${items.length} item types • ${moneyKES(subtotal)}</div>
            </div>
            <button class="action-btn" style="margin-left:auto;" onclick="selectVendor('${blockId}', ${JSON.stringify(brandId ?? null)})">View payment</button>
          </div>
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(170,111,2,.18);border-radius:14px;padding:.9rem;">
            <div style="max-height:240px;overflow:auto;">
              ${itemsHtml}
            </div>
          </div>
          <div style="margin-top:.6rem; padding-left:.2rem;">
            ${preview}
          </div>
        </div>
      `;
    }).join('');

    vendorsEl.innerHTML = vendorBlocks;
  }

  // Selected vendor panel
  function selectVendor(vendorBlockId, brandId) {
    const panel = document.getElementById('wishlist-payment-details');
    if (!panel) return;

    if (!brandId) {
      panel.innerHTML = `
        <div class="pay-notice">Vendor payment details are not available (vendor not registered).</div>
      `;
      return;
    }

    const profile = getVendorPaymentProfile(brandId);

    if (!profile) {
      panel.innerHTML = `
        <div class="pay-notice">Not provided by vendor yet.</div>
        <div class="pay-notice" style="margin-top:.6rem;">The vendor can add payment preferences in Brand Admin → Payment.</div>
      `;
      return;
    }

    const method = profile.method || 'Preferred payment';
    const d = profile.details || {};

    const detailsRows = [];
    if (d.phone) detailsRows.push(`<div class="pay-row"><span>Phone</span><span class="pay-val">${d.phone}</span></div>`);
    if (d.bankName) detailsRows.push(`<div class="pay-row"><span>Bank</span><span class="pay-val">${d.bankName}</span></div>`);
    if (d.accountName) detailsRows.push(`<div class="pay-row"><span>Account name</span><span class="pay-val">${d.accountName}</span></div>`);
    if (d.accountNumber) detailsRows.push(`<div class="pay-row"><span>Account number</span><span class="pay-val">${d.accountNumber}</span></div>`);
    if (d.email) detailsRows.push(`<div class="pay-row"><span>Email</span><span class="pay-val">${d.email}</span></div>`);
    if (d.mpesaShortcode) detailsRows.push(`<div class="pay-row"><span>Paybill/Shortcode</span><span class="pay-val">${d.mpesaShortcode}</span></div>`);
    if (d.deliveryInstructions) detailsRows.push(`<div class="pay-row"><span>Instructions</span><span class="pay-val">${d.deliveryInstructions}</span></div>`);

    panel.innerHTML = `
      <div class="pay-method">
        <h3>${method}</h3>
        ${detailsRows.length ? detailsRows.join('') : '<div class="pay-notice">No method details stored.</div>'}
        <div class="pay-notice" style="margin-top:.7rem;">Updated: ${profile.updatedAt || '—'}</div>
      </div>
    `;
  }

  // Remove from wishlist (cart)
  window.removeWishlistItem = function removeWishlistItem(idx) {
    const cart = loadCart();
    if (!cart[idx]) return;
    const name = cart[idx]?.name || 'Item';
    cart.splice(idx, 1);

    // Persist via MMStorage when available; fallback to localStorage.
    try {
      if (typeof saveLocal === 'function') {
        saveLocal(CART_KEY, cart);
      } else {
        localStorage.setItem(CART_KEY, JSON.stringify(cart));
      }
    } catch {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    }

    render();
    if (typeof showToast === 'function') showToast(`${name} removed from wishlist.`, 'info');
  };



  // Place wishlist orders request (creates orders like cart checkout)
  window.placeWishlistOrders = function placeWishlistOrders() {
    const cart = loadCart();
    if (!cart.length) return;

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    if (!user) {
      if (typeof showToast === 'function') showToast('Please log in first.', 'error');
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1200);
      return;
    }

    // Group items by seller
    const bySeller = {};
    cart.forEach(item => {
      const seller = item.seller || 'MerchMarket';
      if (!bySeller[seller]) bySeller[seller] = [];
      bySeller[seller].push(item);
    });

    const users = typeof loadLocal === 'function' ? loadLocal('merchUsers', []) : [];
    const brandMap = {};
    users.filter(u => u.type === 'brand').forEach(b => { brandMap[b.name] = b.id; });

    let ordersCreated = 0;
    Object.entries(bySeller).forEach(([seller, items]) => {
      const brandId = brandMap[seller];
      if (!brandId) return;

      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      const orderItems = items.map(i => {
        const sku = (i.sku || i.itemSku || '').toString().trim() || (i.id || '').toString().trim();
        const tracking = sku; // tracking = SKU
        return { ...i, sku, tracking };
      });

      const order = {
        id: `WISHLIST-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
        customer: { name: user.name, email: user.email },
        item: orderItems.map(i => `${i.tracking} (x${i.quantity})`).join(', '),
        items: orderItems,
        dateOrdered: new Date().toLocaleDateString(),
        dateUpdated: new Date().toLocaleDateString(),
        location: 'Nairobi, Kenya',
        total: total.toFixed(0),
        status: 'pending',
        payment: {
          // Snapshot reference only (no user payment taken here)
          vendor: seller,
          brandId,
          note: 'Customer requested order. Vendor payment details shown in wishlist.'
        }
      };

      const ordersKey = `merchOrders_${brandId}`;
      const existing = typeof loadLocal === 'function' ? loadLocal(ordersKey, []) : [];
      existing.push(order);
      if (typeof saveLocal === 'function') saveLocal(ordersKey, existing);
      ordersCreated++;
    });

    if (ordersCreated === 0) {
      if (typeof showToast === 'function') showToast('No valid brand sellers found.', 'error');
      return;
    }

    // Clear cart after placing wishlist orders
    try {
      if (typeof saveLocal === 'function') {
        saveLocal(CART_KEY, []);
      } else {
        localStorage.setItem(CART_KEY, JSON.stringify([]));
      }
    } catch {
      localStorage.setItem(CART_KEY, JSON.stringify([]));
    }
    render();


    if (typeof showToast === 'function') showToast('Wishlist order request sent! ✅', 'success');
    setTimeout(() => {
      window.location.href = 'orders.html';
    }, 1200);
  };

  // Boot
  document.addEventListener('DOMContentLoaded', () => {
    render();
    updateWishlistBadge();


    // select first vendor by default
    // (if any vendor exists, use selectVendor later on user action)
  });

})();

