/* ========================================
   MERCHMARKET — WISHLIST PAGE JS (Supabase)
   - Wishlist rows live in Supabase `wishlists` table
   - Vendor payment details come from `vendor_payments` table
   - Orders are written to `orders` + `order_items` tables
   - No payment is collected on-site
   ======================================== */

(function () {

  /* ─── helpers ─────────────────────────────────────────────── */

  function moneyKES(n) {
    return 'KES ' + (Number(n) || 0).toFixed(0);
  }

  // `db` is the global Supabase client initialised in main.js
  // (const db = createClient(SUPABASE_URL, SUPABASE_KEY))

  /* ─── wishlist badge ───────────────────────────────────────── */
  // Delegates to updateWishlistBadge() defined in merchmarket.js.
  // Avoids a duplicate Supabase query and a race condition on the badge count.
  async function updateWishlistBadge() {
    if (typeof window.updateWishlistBadge === 'function') {
      return window.updateWishlistBadge();
    }
  }

  /* ─── load wishlist ────────────────────────────────────────── */

  async function loadWishlist() {
    const user = await getCurrentUser();

    if (!user) {
      // Guest: read from localStorage session fallback
      return loadLocal('mm_wishlist_guest', []);
    }

    const headers = await getAuthHeader();
    const res = await fetch('/api/member/wishlist', { headers });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('loadWishlist error:', payload.error || res.statusText);
      return [];
    }

    // Flatten into a shape the renderer can use
    return (payload.wishlist || []).map(row => ({
      _wishlistRowId: row.id,
      id: row.products?.id,
      name: row.products?.name || 'Unknown',
      price: parseFloat(row.products?.price) || 0,
      seller: row.products?.seller || 'MerchMarket',
      quantity: row.quantity || 1,
      sku: row.products?.sku || '',
      image: row.products?.images?.[0]?.url || row.products?.images?.[0] || ''
    }));
  }

  /* ─── vendor payment details ───────────────────────────────── */
  // Reads from Supabase `vendor_payments` table:
  //   brand_id (uuid), method, details (jsonb), updated_at

  async function getVendorPaymentProfile(brandId) {
    if (!brandId) return null;

    const { data, error } = await db
      .from('vendor_payments')
      .select('*')
      .eq('brand_id', brandId)
      .maybeSingle();

    if (error) { console.error('getVendorPaymentProfile error:', error.message); return null; }
    return data || null;
  }

  // Returns a map of { [seller name]: brand_id } from `profiles` table
  async function getCatalogBrandMap() {
    const { data, error } = await db
      .from('profiles')
      .select('id, name')
      .eq('type', 'brand');

    if (error) { console.error('getCatalogBrandMap error:', error.message); return {}; }

    const map = {};
    (data || []).forEach(b => { map[b.name] = b.id; });
    return map;
  }

  /* ─── render ───────────────────────────────────────────────── */

  function createWishlistItemRow(item, rowId) {
    const safeImage = typeof window.sanitizeImageUrl === 'function' ? window.sanitizeImageUrl(item.image) : item.image;
    const thumb = safeImage
      ? `<img src="${escapeHtml(safeImage)}" style="width:100%;height:100%;object-fit:cover;" />`
      : '';

    return `
      <div class="wishlist-item" data-wishlist-row="${escapeHtml(rowId)}">
        <div class="item-thumb">${thumb}</div>
        <div>
          <div class="item-name">${escapeHtml(item.name || 'Untitled')}</div>
          <div class="item-sub">Qty: ${escapeHtml(String(item.quantity || 1))}</div>
        </div>
        <div class="item-right">${moneyKES(item.price * item.quantity)}</div>
        <button class="remove-btn" onclick="removeWishlistItem('${escapeHtml(rowId)}')" title="Remove">×</button>
      </div>
    `;
  }

  async function render() {
    const emptyEl   = document.getElementById('wishlist-empty');
    const vendorsEl = document.getElementById('wishlist-vendors');

    const cart = await loadWishlist();

    if (!cart.length) {
      if (emptyEl)   emptyEl.style.display = 'block';
      if (vendorsEl) vendorsEl.innerHTML = '';
      updateWishlistBadge();
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    const brandMap = await getCatalogBrandMap();

    // Group items by seller
    const bySeller = {};
    cart.forEach(item => {
      const seller = item.seller || 'MerchMarket';
      if (!bySeller[seller]) bySeller[seller] = [];
      bySeller[seller].push(item);
    });

    const vendorBlocks = await Promise.all(
      Object.entries(bySeller).map(async ([seller, items]) => {
        const brandId  = brandMap[seller] ?? null;
        const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
        const payment  = brandId ? await getVendorPaymentProfile(brandId) : null;
        const method   = payment?.method || '';
        const details  = payment?.details || null;

        const blockId = `vendor-${String(brandId ?? seller).replace(/[^a-zA-Z0-9_-]/g, '')}`;

        const preview = payment
          ? `<div class="pay-notice" style="margin-top:.25rem;">${escapeHtml(method || 'Payment method')}${details?.phone ? ' • ' + escapeHtml(details.phone) : ''}</div>`
          : `<div class="pay-notice" style="margin-top:.25rem;">Not provided yet</div>`;

        const itemsHtml = items
          .map(it => createWishlistItemRow(it, it._wishlistRowId ?? it.id))
          .join('');

        return `
          <div class="vendor-block">
            <div class="vendor-header">
              <div>
                <div class="vendor-name">${escapeHtml(seller)}</div>
                <div class="vendor-meta">${items.length} item type${items.length !== 1 ? 's' : ''} • ${moneyKES(subtotal)}</div>
              </div>
              <button class="action-btn" style="margin-left:auto;"
                onclick="selectVendor('${blockId}', '${brandId ?? ''}')">
                View payment
              </button>
            </div>
            <div style="background:rgba(255,255,255,.03);border:1px solid rgba(170,111,2,.18);border-radius:14px;padding:.9rem;">
              <div style="max-height:240px;overflow:auto;">
                ${itemsHtml}
              </div>
            </div>
            <div style="margin-top:.6rem;padding-left:.2rem;">
              ${preview}
            </div>
          </div>
        `;
      })
    );

    if (vendorsEl) vendorsEl.innerHTML = vendorBlocks.join('');
    updateWishlistBadge();
  }

  /* ─── vendor payment panel ─────────────────────────────────── */

  window.selectVendor = async function selectVendor(vendorBlockId, brandId) {
    const panel = document.getElementById('wishlist-payment-details');
    if (!panel) return;

    if (!brandId) {
      panel.innerHTML = `<div class="pay-notice">Vendor payment details are not available (vendor not registered).</div>`;
      return;
    }

    const profile = await getVendorPaymentProfile(brandId);

    if (!profile) {
      panel.innerHTML = `
        <div class="pay-notice">Not provided by vendor yet.</div>
        <div class="pay-notice" style="margin-top:.6rem;">The vendor can add payment preferences in Brand Admin → Payment.</div>
      `;
      return;
    }

    const method = profile.method || 'Preferred payment';
    const d      = profile.details || {};
    const rows   = [];

    if (d.phone)                rows.push(`<div class="pay-row"><span>Phone</span><span class="pay-val">${escapeHtml(d.phone)}</span></div>`);
    if (d.bankName)             rows.push(`<div class="pay-row"><span>Bank</span><span class="pay-val">${escapeHtml(d.bankName)}</span></div>`);
    if (d.accountName)          rows.push(`<div class="pay-row"><span>Account name</span><span class="pay-val">${escapeHtml(d.accountName)}</span></div>`);
    if (d.accountNumber)        rows.push(`<div class="pay-row"><span>Account number</span><span class="pay-val">${escapeHtml(d.accountNumber)}</span></div>`);
    if (d.email)                rows.push(`<div class="pay-row"><span>Email</span><span class="pay-val">${escapeHtml(d.email)}</span></div>`);
    if (d.mpesaShortcode)       rows.push(`<div class="pay-row"><span>Paybill/Shortcode</span><span class="pay-val">${escapeHtml(d.mpesaShortcode)}</span></div>`);
    if (d.deliveryInstructions) rows.push(`<div class="pay-row"><span>Instructions</span><span class="pay-val">${escapeHtml(d.deliveryInstructions)}</span></div>`);

    panel.innerHTML = `
      <div class="pay-method">
        <h3>${escapeHtml(method)}</h3>
        ${rows.length ? rows.join('') : '<div class="pay-notice">No method details stored.</div>'}
        <div class="pay-notice" style="margin-top:.7rem;">Updated: ${profile.updated_at ? new Date(profile.updated_at).toLocaleDateString('en-KE') : '—'}</div>
      </div>
    `;
  };

  /* ─── remove item ──────────────────────────────────────────── */

  window.removeWishlistItem = async function removeWishlistItem(rowId) {
    const user = await getCurrentUser();

    if (!user) {
      // Guest: splice from localStorage
      let local = loadLocal('mm_wishlist_guest', []);
      const idx = local.findIndex(i => String(i.id) === String(rowId));
      const name = idx !== -1 ? local[idx].name : 'Item';
      if (idx !== -1) local.splice(idx, 1);
      saveLocal('mm_wishlist_guest', local);
      if (typeof showToast === 'function') showToast(`${name} removed from wishlist.`, 'info');
      render();
      return;
    }

    const headers = await getAuthHeader();
    const res = await fetch(`/api/member/wishlist/${encodeURIComponent(rowId)}`, {
      method: 'DELETE',
      headers
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('removeWishlistItem error:', payload.error || res.statusText);
      if (typeof showToast === 'function') showToast('Could not remove item. Try again.', 'error');
      return;
    }

    if (typeof showToast === 'function') showToast('Item removed from wishlist.', 'info');
    render();
  };

  /* ─── place orders ─────────────────────────────────────────── */

  window.placeWishlistOrders = async function placeWishlistOrders() {
    const cart = await loadWishlist();
    if (!cart.length) return;

    const user = await getCurrentUser();
    if (!user) {
      if (typeof showToast === 'function') showToast('Please sign in to place an order.', 'error');
      return;
    }

    const brandMap = await getCatalogBrandMap();

    // Group by seller
    const bySeller = {};
    cart.forEach(item => {
      const seller = item.seller || 'MerchMarket';
      if (!bySeller[seller]) bySeller[seller] = [];
      bySeller[seller].push(item);
    });

    let ordersCreated = 0;

    const deliveryLocation = (user.address && user.address.trim()) || 'Nairobi, Kenya';

    for (const [seller, items] of Object.entries(bySeller)) {
      const brandId = brandMap[seller];
      if (!brandId) continue;

      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      const orderPayload = {
        brand_id: brandId,
        total_amount: total.toFixed(2),
        location: deliveryLocation,
        items: items.map(i => ({
          product_id: i.id,
          quantity: i.quantity,
          sku: i.sku || '',
          unit_price: i.price
        }))
      };

      const headers = await getAuthHeader();
      const res = await fetch('/api/member/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ orders: [orderPayload] })
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        console.error(`Order insert error for seller ${seller}:`, payload.error || res.statusText);
        continue;
      }

      ordersCreated++;
    }

    if (ordersCreated === 0) {
      if (typeof showToast === 'function') showToast('No valid brand sellers found.', 'error');
      return;
    }

    // Clear wishlist after placing orders
    const headers = await getAuthHeader();
    const clearRes = await fetch('/api/member/wishlist/clear', {
      method: 'POST',
      headers
    });
    const clearPayload = await clearRes.json().catch(() => ({}));

    if (!clearRes.ok) {
      console.error('Clear wishlist error:', clearPayload.error || clearRes.statusText);
    }

    render();

    if (typeof showToast === 'function') showToast('Wishlist order request sent! ✅', 'success');
    setTimeout(() => { window.location.href = 'orders.html'; }, 1200);
  };

  /* ─── boot ─────────────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    render();
    updateWishlistBadge();
  });

})();