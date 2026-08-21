/* ========================================
   MERCHMARKET — CART PAGE JS
   - Cart rows live in Supabase `cart_items` table, served via
     /api/member/cart (separate from `wishlists`/wishlist.js).
   - Checkout groups items by seller and posts to /api/member/orders,
     the same endpoint and payload shape wishlist.js uses.
   - No payment is collected on-site.
   ======================================== */

(function () {

  function moneyKES(n) {
    return 'KES ' + (Number(n) || 0).toFixed(0);
  }

  /* ─── load cart ───────────────────────────────────────────── */

  async function loadCart() {
    const items = await getCart(); // getCart() lives in merchmarket.js

    if (Array.isArray(items) && items.length && items[0].products !== undefined) {
      // Authenticated shape from /api/member/cart: { id, quantity, products:{...} }
      return items.map(row => ({
        _cartRowId: row.id,
        id: row.products?.id,
        name: row.products?.name || 'Unknown',
        price: parseFloat(row.products?.price) || 0,
        seller: row.products?.seller || 'MerchMarket',
        quantity: row.quantity || 1,
        sku: row.products?.sku || '',
        stock: row.products?.stock,
        image: row.products?.images?.[0]?.url || row.products?.images?.[0] || ''
      }));
    }

    // Guest shape from localStorage already matches the flat item shape
    return (items || []).map(item => ({ ...item, _cartRowId: item.product_id }));
  }

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

  /* ─── render ──────────────────────────────────────────────── */

  function createCartItemRow(item) {
    const rowId = item._cartRowId;
    const safeImage = typeof window.sanitizeImageUrl === 'function' ? window.sanitizeImageUrl(item.image) : item.image;
    const thumb = safeImage
      ? `<img src="${escapeHtml(safeImage)}" style="width:100%;height:100%;object-fit:cover;" />`
      : '';

    return `
      <div class="cart-item" data-cart-row="${escapeHtml(rowId)}">
        <div class="item-thumb">${thumb}</div>
        <div class="item-info">
          <div class="item-name">${escapeHtml(item.name || 'Untitled')}</div>
          <div class="item-seller">${escapeHtml(item.seller || 'MerchMarket')}</div>
        </div>
        <div class="item-qty">
          <button class="qty-btn" onclick="changeCartQty('${escapeHtml(rowId)}', -1)">−</button>
          <span class="qty-val">${escapeHtml(String(item.quantity || 1))}</span>
          <button class="qty-btn" onclick="changeCartQty('${escapeHtml(rowId)}', 1)">+</button>
        </div>
        <div class="item-price">${moneyKES(item.price * item.quantity)}</div>
        <button class="remove-btn" onclick="removeCartItem('${escapeHtml(rowId)}')" title="Remove">×</button>
      </div>
    `;
  }

  let _cartCache = [];

  async function render() {
    const emptyEl    = document.getElementById('cart-empty');
    const guestEl    = document.getElementById('cart-guest');
    const contentsEl = document.getElementById('cart-contents');
    const clearBtn   = document.getElementById('clear-btn');
    const titleCount = document.getElementById('cart-title-count');
    const listEl     = document.getElementById('cart-items-list');

    _cartCache = await loadCart();

    if (!_cartCache.length) {
      if (emptyEl)    emptyEl.style.display = 'block';
      if (guestEl)    guestEl.style.display = 'none';
      if (contentsEl) contentsEl.style.display = 'none';
      if (clearBtn)   clearBtn.style.display = 'none';
      if (titleCount) titleCount.textContent = '';
      updateCartCount();
      return;
    }

    if (emptyEl)    emptyEl.style.display = 'none';
    if (guestEl)    guestEl.style.display = 'none';
    if (contentsEl) contentsEl.style.display = 'grid';
    if (clearBtn)   clearBtn.style.display = 'inline-block';

    const itemCount = _cartCache.reduce((s, i) => s + (i.quantity || 1), 0);
    if (titleCount) titleCount.textContent = `(${itemCount})`;

    if (listEl) listEl.innerHTML = _cartCache.map(createCartItemRow).join('');

    const subtotal = _cartCache.reduce((s, i) => s + i.price * i.quantity, 0);
    const subtotalEl = document.getElementById('s-subtotal');
    const totalEl    = document.getElementById('s-total');
    if (subtotalEl) subtotalEl.textContent = moneyKES(subtotal);
    if (totalEl)    totalEl.textContent    = moneyKES(subtotal);

    updateCartCount();
  }

  /* ─── quantity / remove ──────────────────────────────────────── */

  window.changeCartQty = async function changeCartQty(rowId, delta) {
    const item = _cartCache.find(i => String(i._cartRowId) === String(rowId));
    if (!item) return;

    const newQty = (item.quantity || 1) + delta;
    if (newQty < 1) { return removeCartItem(rowId); }

    const user = await getCurrentUser();

    if (!user) {
      let local = loadLocal('mm_cart_guest', []);
      const idx = local.findIndex(i => String(i.product_id) === String(rowId));
      if (idx !== -1) { local[idx].quantity = newQty; saveLocal('mm_cart_guest', local); }
      render();
      return;
    }

    const headers = await getAuthHeader();
    const res = await fetch(`/api/member/cart/${encodeURIComponent(rowId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ quantity: newQty })
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('changeCartQty error:', payload.error || res.statusText);
      showToast('Could not update quantity.', 'error');
      return;
    }

    render();
  };

  window.removeCartItem = async function removeCartItem(rowId) {
    const user = await getCurrentUser();

    if (!user) {
      let local = loadLocal('mm_cart_guest', []);
      const idx = local.findIndex(i => String(i.product_id) === String(rowId));
      const name = idx !== -1 ? local[idx].name : 'Item';
      if (idx !== -1) local.splice(idx, 1);
      saveLocal('mm_cart_guest', local);
      showToast(`${name} removed from cart.`, 'info');
      render();
      return;
    }

    const headers = await getAuthHeader();
    const res = await fetch(`/api/member/cart/${encodeURIComponent(rowId)}`, {
      method: 'DELETE',
      headers
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('removeCartItem error:', payload.error || res.statusText);
      showToast('Could not remove item. Try again.', 'error');
      return;
    }

    showToast('Item removed from cart.', 'info');
    render();
  };

  window.clearCart = async function clearCart() {
    const user = await getCurrentUser();

    if (!user) {
      saveLocal('mm_cart_guest', []);
      render();
      return;
    }

    const headers = await getAuthHeader();
    const res = await fetch('/api/member/cart/clear', { method: 'POST', headers });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('clearCart error:', payload.error || res.statusText);
      showToast('Could not clear cart.', 'error');
      return;
    }

    showToast('Cart cleared.', 'info');
    render();
  };

  /* ─── checkout ────────────────────────────────────────────── */

  window.checkoutCart = async function checkoutCart() {
    if (!_cartCache.length) return;

    const user = await getCurrentUser();
    if (!user) {
      showToast('Please sign in to check out.', 'error');
      return;
    }

    const brandMap = await getCatalogBrandMap();

    const bySeller = {};
    _cartCache.forEach(item => {
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
      showToast('No valid brand sellers found.', 'error');
      return;
    }

    const headers = await getAuthHeader();
    const clearRes = await fetch('/api/member/cart/clear', { method: 'POST', headers });
    const clearPayload = await clearRes.json().catch(() => ({}));
    if (!clearRes.ok) {
      console.error('Clear cart error:', clearPayload.error || clearRes.statusText);
    }

    render();
    showToast('Order request sent! ✅', 'success');
    setTimeout(() => { window.location.href = 'orders.html'; }, 1200);
  };

  /* ─── boot ────────────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    render();
    updateCartCount();
  });

})();
