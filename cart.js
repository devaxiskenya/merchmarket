/* ========================================
   MERCHMARKET — CART PAGE JS
   Handles cart rendering, qty controls,
   totals, and checkout flow.
   ======================================== */

const FREE_SHIP_THRESHOLD = 75;
const SHIP_COST           = 12;

function loadCart()   { try { return JSON.parse(localStorage.getItem('merchCart')) || []; } catch { return []; } }
function saveCart(c)  { localStorage.setItem('merchCart', JSON.stringify(c)); }

let cart = loadCart();

/* ─── Render ─────────────────────────────────────────────────── */
function renderCart() {
  cart = loadCart();

  const empty    = document.getElementById('cart-empty');
  const contents = document.getElementById('cart-contents');
  const clearBtn = document.getElementById('clear-btn');
  const titleCount = document.getElementById('cart-title-count');

  const totalItems = cart.reduce((s, i) => s + i.quantity, 0);
  if (titleCount) titleCount.textContent = totalItems > 0 ? `(${totalItems})` : '';

  if (cart.length === 0) {
    if (empty)    { empty.style.display    = 'block'; }
    if (contents) { contents.style.display = 'none';  }
    if (clearBtn) { clearBtn.style.display = 'none';  }
    if (typeof updateCartBadge === 'function') updateCartBadge();
    return;
  }

  if (empty)    { empty.style.display    = 'none';   }
  if (contents) { contents.style.display = '';       }
  if (clearBtn) { clearBtn.style.display = '';       }

  /* Items list */
  const list = document.getElementById('cart-items-list');
  if (list) {
    list.innerHTML = cart.map((item, idx) => `
      <div class="cart-item" data-idx="${idx}">
        <div class="item-thumb" style="background:${item.gradient || 'linear-gradient(135deg,#667eea,#764ba2)'}">
          ${item.image ? `<img src="${item.image}" style="width:100%;height:100%;object-fit:cover;">` : ''}
        </div>
        <div class="item-info">
          <div class="item-name">${item.name}</div>
          <div class="item-seller">${item.seller || 'MerchMarket'}</div>
        </div>
        <div class="item-qty">
          <button class="qty-btn" onclick="changeQty(${idx}, -1)">−</button>
          <span class="qty-val">${item.quantity}</span>
          <button class="qty-btn" onclick="changeQty(${idx}, 1)">+</button>
        </div>
        <div class="item-price">KES ${(item.price * item.quantity).toFixed(0)}</div>
        <button class="remove-btn" onclick="removeItem(${idx})" title="Remove">✕</button>
      </div>
    `).join('');
  }

  updateTotals();
  if (typeof updateCartBadge === 'function') updateCartBadge();
}

function updateTotals() {
  const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const shipping  = subtotal >= FREE_SHIP_THRESHOLD ? 0 : SHIP_COST;
  const total     = subtotal + shipping;

  const el = id => document.getElementById(id);
  if (el('s-subtotal')) el('s-subtotal').textContent = `KES ${subtotal.toFixed(0)}`;
  if (el('s-shipping')) el('s-shipping').textContent = shipping === 0 ? 'FREE' : `KES ${shipping.toFixed(0)}`;
  if (el('s-total'))    el('s-total').textContent    = `KES ${total.toFixed(0)}`;

  /* Shipping progress bar */
  const pct = Math.min((subtotal / FREE_SHIP_THRESHOLD) * 100, 100);
  if (el('ship-bar')) el('ship-bar').style.width = pct + '%';
  if (el('ship-note')) {
    const remaining = FREE_SHIP_THRESHOLD - subtotal;
    el('ship-note').textContent = shipping === 0
      ? '🎉 You have free shipping!'
      : `Add KES ${remaining.toFixed(0)} more for free shipping`;
  }

  /* Shipping line visibility */
  const shipLine = document.getElementById('s-ship-line');
  if (shipLine) shipLine.style.opacity = shipping === 0 ? '0.5' : '1';
}

/* ─── Actions ────────────────────────────────────────────────── */
function changeQty(idx, delta) {
  cart[idx].quantity = Math.max(1, cart[idx].quantity + delta);
  saveCart(cart);
  renderCart();
}

function removeItem(idx) {
  const name = cart[idx]?.name || 'Item';
  cart.splice(idx, 1);
  saveCart(cart);
  renderCart();
  showCartToast(`${name} removed from cart.`, 'info');
}

function clearCart() {
  if (cart.length === 0) return;
  if (!confirm('Remove all items from your cart?')) return;
  cart = [];
  saveCart(cart);
  renderCart();
  showCartToast('Cart cleared.', 'info');
}

function checkout() {
  if (cart.length === 0) { showCartToast('Your cart is empty!', 'error'); return; }

  const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (!user) {
    showCartToast('Please log in to checkout.', 'error');
    setTimeout(() => { window.location.href = 'login.html'; }, 1500);
    return;
  }

  // Group cart items by seller
  const bySeller = {};
  cart.forEach(item => {
    const seller = item.seller || 'MerchMarket';
    if (!bySeller[seller]) bySeller[seller] = [];
    bySeller[seller].push(item);
  });

  // Find brand IDs for sellers
  const allUsers = typeof loadLocal === 'function' ? loadLocal('merchUsers', []) : [];
  const brandMap = {};
  allUsers.filter(u => u.type === 'brand').forEach(b => { brandMap[b.name] = b.id; });

  // Create orders for each seller
  let ordersCreated = 0;
  Object.entries(bySeller).forEach(([seller, items]) => {
    const brandId = brandMap[seller];
    if (!brandId) return; // Skip if seller is not a registered brand

    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const orderItems = items.map(i => {
      const sku = (i.sku || i.itemSku || '').toString().trim() || (i.id || '').toString().trim();
      const tracking = sku; // tracking = SKU
      return { ...i, sku, tracking };
    });

    const order = {
      id: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      customer: { name: user.name, email: user.email },
      item: orderItems.map(i => `${i.tracking} (x${i.quantity})`).join(', '),
      items: orderItems,
      dateOrdered: new Date().toLocaleDateString(),
      dateUpdated: new Date().toLocaleDateString(),
      location: 'Nairobi, Kenya',
      total: total.toFixed(0),
      status: 'pending'
    };

    const ordersKey = `merchOrders_${brandId}`;
    const existing = typeof loadLocal === 'function' ? loadLocal(ordersKey, []) : [];
    existing.push(order);
    if (typeof saveLocal === 'function') saveLocal(ordersKey, existing);
    ordersCreated++;
  });

  if (ordersCreated === 0) {
    showCartToast('No valid brand sellers found for checkout.', 'error');
    return;
  }

  // Clear cart
  cart = [];
  saveCart(cart);
  if (typeof updateCartBadge === 'function') updateCartBadge();
  showCartToast('Order placed successfully! 🎉', 'success');

  setTimeout(() => { window.location.href = 'orders.html'; }, 1200);
}

/* ─── Toast (standalone, no dependency on merchmarket.js) ─────── */
function showCartToast(msg, type = 'default') {
  let toast = document.getElementById('cart-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cart-toast';
    toast.style.cssText = `
      position:fixed;bottom:2rem;right:2rem;z-index:9999;
      padding:.9rem 1.6rem;border-radius:12px;font-weight:600;
      font-family:'DM Sans',sans-serif;font-size:.95rem;
      background:#1e1e1e;border:1px solid rgba(170,111,2,.5);
      color:#ffd8b5;transform:translateY(120%);
      transition:transform .35s cubic-bezier(.4,0,.2,1);
      display:flex;align-items:center;gap:.6rem;
    `;
    document.body.appendChild(toast);
  }
  const icons = { success:'✅', error:'⚠️', info:'ℹ️', default:'📢' };
  toast.innerHTML = `<span>${icons[type]||'📢'}</span><span>${msg}</span>`;
  toast.style.transform = 'translateY(0)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.transform = 'translateY(120%)'; }, 3500);
}

/* ─── Wire checkout button ────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Cart disabled; wishlist replaced it.
});
