/* ============================================================
   BRANDFLOW ADMIN — v2.0 (Supabase)
   All data operations migrated from localStorage to Supabase.
   Tables used:
     orders       — id, user_id, brand_id, total, status, location, created_at
     order_items  — id, order_id, product_id, quantity, sku, unit_price
     products     — id, brand_id, name, sku, stock, price, images(jsonb),
                    wear_category, item_type, tags(jsonb), seller, condition
     profiles     — id, name, email, type
     vendor_payments — brand_id, method, label, details(jsonb), updated_at
   ============================================================ */

/* ─── TAB ROUTER ──────────────────────────────────────────── */

function escapeValue(value) {
  if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function tabSwitch(tabName) {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.module').forEach(mod => {
    mod.classList.toggle('active', mod.id === tabName);
  });

  const loaders = {
    orders:    loadOrdersTab,
    inventory: loadInventoryTab,
    payments:  loadPaymentsTab,
    customers: loadCustomersTab,
  };
  if (loaders[tabName]) loaders[tabName]();
}

/* ─── BOOT ────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  console.log('Brandflow admin ready (Supabase mode)');

  // Nav tab clicks
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      tabSwitch(tab.dataset.tab);
    });
  });

  // Add item button — navigates to the dedicated form page instead of
  // opening anything in-page. No modal/dialog timing to get wrong.
  const addBtn = document.getElementById('add-inventory');
  if (!addBtn) {
    console.error('brandflow-admin: missing #add-inventory');
  } else {
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = 'add-item.html';
    });
  }


  // Refresh orders
  document.getElementById('refresh-orders')?.addEventListener('click', () => {
    loadOrdersTab();
    showToast('Orders refreshed!', 'success');
  });

  // Search orders (debounced)
  // debounce() is defined in merchmarket.js — use a local fallback in case load order shifts
  const _debounce = (typeof debounce === 'function') ? debounce : (fn, ms) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  document.getElementById('orders-search')?.addEventListener('input',
    _debounce(() => loadOrdersTab(), 300)
  );

  // Save payment details
  document.getElementById('save-payment-details')?.addEventListener('click', savePaymentDetails);

  // Reset DB
  document.getElementById('reset-db')?.addEventListener('click', resetDatabase);

  // Payment method label switcher
  wirePaymentMethodSwitcher();

  // Load the tab requested via ?tab=inventory (e.g. after saving an item on
  // add-item.html), falling back to Orders as the default landing tab.
  const params = new URLSearchParams(location.search);
  tabSwitch(params.get('tab') || 'orders');
});

/* ─── ORDERS TAB ──────────────────────────────────────────── */

async function loadOrdersTab() {
  const brand = await getBrandUser();
  if (!brand) return;

  const filter = document.getElementById('orders-search')?.value?.toLowerCase() || '';

  // Fetch orders for this brand with joined order_items + products + customer profile
  const { data: orders, error } = await db
    .from('orders')
    .select(`
      id, total_amount, status, location, created_at,
      profiles!orders_user_id_fkey (id, name, email),
      order_items (
        id, quantity, sku, unit_price,
        products (name, sku)
      )
    `)
    .eq('brand_id', brand.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('loadOrdersTab error:', error.message);
    showToast('Failed to load orders', 'error');
    return;
  }

  // Client-side filter
  let filtered = orders || [];
  if (filter) {
    filtered = filtered.filter(o => {
      const cust = o.profiles;
      const name  = (cust?.name  || '').toLowerCase();
      const email = (cust?.email || '').toLowerCase();
      const id    = String(o.id).toLowerCase();
      return name.includes(filter) || email.includes(filter) || id.includes(filter);
    });
  }

  updateStats(calculateOrderStats(filtered));
  renderOrdersTable(filtered);
}

function calculateOrderStats(orders) {
  const total     = orders.length;
  const pending   = orders.filter(o => o.status === 'pending').length;
  const confirmed = orders.filter(o => o.status === 'confirmed').length;
  const active    = orders.filter(o => o.status === 'active').length;
  const completed = orders.filter(o => o.status === 'completed').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const revenue   = orders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
  return { total, pending, confirmed, active, completed, cancelled, revenue };
}

function updateStats(stats) {
  const fields = {
    'total-orders':     stats.total,
    'pending-orders':   stats.pending,
    'confirmed-orders': stats.confirmed,
    'active-orders':    stats.active,
    'completed-orders': stats.completed,
    'cancelled-orders': stats.cancelled,
    'total-revenue':    `KES ${stats.revenue.toLocaleString()}`
  };
  Object.entries(fields).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });
}

function renderOrdersTable(orders) {
  const tbody = document.getElementById('orders-table-body');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:3rem;color:var(--text-secondary);">No orders found</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map(order => {
    const cust  = order.profiles || {};
    const items = order.order_items || [];
    const itemLabel = items.length
      ? items.map(i => escapeValue(i.products?.name || i.sku || '—')).join(', ')
      : '—';
    const date  = order.created_at ? new Date(order.created_at).toLocaleDateString('en-KE') : '—';
    const total = parseFloat(order.total_amount) || 0;
    const st    = String(order.status || 'pending');
    const safeName = escapeValue(cust.name || '—');
    const safeEmail = escapeValue(cust.email || '—');
    const safeLocation = escapeValue(order.location || 'Nairobi, Kenya');

    return `
      <tr>
        <td><strong style="color:#ffd8b5;font-family:monospace;">#${escapeValue(order.id)}</strong></td>
        <td>${safeName}<br><small style="color:#a0a0a0;">${safeEmail}</small></td>
        <td>${itemLabel}</td>
        <td>${date}<br><small style="color:#a0a0a0;">Updated: ${date}</small></td>
        <td>${safeLocation}</td>
        <td>KES ${total.toLocaleString()}</td>
        <td><span class="status ${st}">${st.toUpperCase()}</span></td>
        <td>
          <a class="action-btn" href="view-order.html?id=${escapeValue(order.id)}" style="text-decoration:none;">View</a>
          ${st === 'pending' ? `<button class="action-btn" style="background:#4caf50;color:#fff;" onclick="updateOrderStatus('${escapeValue(order.id)}','confirmed')">Confirm</button>` : ''}
          ${st === 'confirmed' ? `<button class="action-btn" style="background:#2196f3;color:#fff;" onclick="updateOrderStatus('${escapeValue(order.id)}','active')">Ship</button>` : ''}
          ${(st === 'active' || st === 'confirmed') ? `<button class="action-btn" style="background:#ff9800;color:#fff;" onclick="updateOrderStatus('${escapeValue(order.id)}','completed')">Complete</button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

/* ─── ORDER STATUS UPDATE ─────────────────────────────────── */

async function updateOrderStatus(orderId, newStatus) {
  const { error } = await db
    .from('orders')
    .update({ status: newStatus })
    .eq('id', orderId);

  if (error) {
    showToast('Failed to update order status', 'error');
    console.error('updateOrderStatus error:', error.message);
    return;
  }

  showToast(`Order marked as ${newStatus}`, 'success');
  loadOrdersTab();
}

// Legacy alias kept so old HTML onclick="confirmOrder(...)" still works
async function confirmOrder(id) {
  await updateOrderStatus(id, 'confirmed');
}

/* ─── INVENTORY TAB ───────────────────────────────────────── */

async function loadInventoryTab() {
  const brand = await getBrandUser();
  if (!brand) return;

  const { data: products, error } = await db
    .from('products')
    .select('*')
    .eq('brand_id', brand.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('loadInventoryTab error:', error.message);
    showToast('Failed to load inventory', 'error');
    return;
  }

  const tbody = document.getElementById('inventory-table-body');
  if (!tbody) return;

  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:3rem;color:var(--text-secondary);">No inventory items. Click + Add Item to start.</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => {
    const imgCount = Array.isArray(p.images) ? p.images.length : 0;
    const name = escapeValue(p.name || 'Untitled');
    const sku = escapeValue(p.sku || '—');
    const stock = escapeValue(p.stock ?? '—');
    return `
      <tr>
        <td>${name}</td>
        <td style="font-family:monospace;color:#a0a0a0;">${sku}</td>
        <td>${stock}</td>
        <td>KES ${parseFloat(p.price || 0).toLocaleString()}</td>
        <td>${imgCount} image${imgCount !== 1 ? 's' : ''}</td>
        <td>
          <a class="action-btn" href="add-item.html?id=${escapeValue(p.id)}" style="text-decoration:none;">Edit</a>
          <button class="action-btn" style="background:#f44336;color:#fff;" onclick="deleteInventoryItem('${escapeValue(p.id)}')">Delete</button>
        </td>
      </tr>`;
  }).join('');
}


/* ─── DELETE INVENTORY ITEM ───────────────────────────────── */

async function deleteInventoryItem(productId) {
  if (!confirm('Delete this item? This also removes it from the marketplace.')) return;

  const brand = await getBrandUser();
  if (!brand) return;

  const { error } = await db
    .from('products')
    .delete()
    .eq('id', productId)
    .eq('brand_id', brand.id);

  if (error) {
    showToast('Failed to delete item', 'error');
    console.error('deleteInventoryItem error:', error.message);
    return;
  }

  showToast('Item deleted', 'success');
  loadInventoryTab();
}

/* ─── PAYMENTS TAB ────────────────────────────────────────── */

async function loadPaymentsTab() {
  const brand = await getBrandUser();
  if (!brand) return;

  const { data, error } = await db
    .from('vendor_payments')
    .select('*')
    .eq('brand_id', brand.id)
    .maybeSingle();

  if (error) { console.error('loadPaymentsTab error:', error.message); return; }
  if (!data) return; // no saved payment details yet

  const d = data.details || {};
  document.getElementById('pm-method').value         = data.method   || 'mpesa';
  document.getElementById('pm-label').value          = data.label    || '';
  document.getElementById('pm-detail').value         = d.phone || d.accountNumber || d.email || '';
  document.getElementById('pm-account-name').value   = d.accountName   || '';
  document.getElementById('pm-bank-name').value      = d.bankName      || '';
  document.getElementById('pm-account-number').value = d.accountNumber || '';
  document.getElementById('pm-email').value          = d.email         || '';
  document.getElementById('pm-instructions').value   = d.deliveryInstructions || '';

  wirePaymentMethodSwitcher();
}

async function savePaymentDetails() {
  const brand = await getBrandUser();
  if (!brand) { showToast('Brand login required', 'error'); return; }

  const method = document.getElementById('pm-method').value;
  const label  = document.getElementById('pm-label').value.trim();
  const phone  = document.getElementById('pm-detail').value.trim();

  const details = {
    phone:                phone,
    accountName:          document.getElementById('pm-account-name').value.trim(),
    bankName:             document.getElementById('pm-bank-name').value.trim(),
    accountNumber:        document.getElementById('pm-account-number').value.trim(),
    email:                document.getElementById('pm-email').value.trim(),
    deliveryInstructions: document.getElementById('pm-instructions').value.trim()
  };

  // Remove empty keys
  Object.keys(details).forEach(k => { if (!details[k]) delete details[k]; });

  const { error } = await db
    .from('vendor_payments')
    .upsert({
      brand_id:   brand.id,
      method,
      label,
      details,
      updated_at: new Date().toISOString()
    }, { onConflict: 'brand_id' });

  if (error) {
    showToast('Failed to save payment details: ' + error.message, 'error');
    console.error('savePaymentDetails error:', error.message);
    return;
  }

  showToast('Payment details saved!', 'success');
}

function wirePaymentMethodSwitcher() {
  const methodEl    = document.getElementById('pm-method');
  const detailLabel = document.getElementById('pm-detail-label');
  const pmDetail    = document.getElementById('pm-detail');
  if (!methodEl || !detailLabel) return;

  const update = () => {
    const m = methodEl.value;
    if (m === 'mpesa') {
      detailLabel.textContent = 'M-Pesa Phone / Paybill / Shortcode';
      pmDetail.placeholder    = 'e.g. 07xx xxx xxx or Paybill number';
    } else if (m === 'bank') {
      detailLabel.textContent = 'Bank Account Number';
      pmDetail.placeholder    = 'e.g. 0123456789';
    } else if (m === 'paypal') {
      detailLabel.textContent = 'PayPal Email';
      pmDetail.placeholder    = 'e.g. vendor@paypal.com';
    } else {
      detailLabel.textContent = 'Cash Handling Instructions';
      pmDetail.placeholder    = 'e.g. Pay cash to rider on delivery';
    }
  };

  methodEl.removeEventListener('change', update); // avoid double binds
  methodEl.addEventListener('change', update);
  update();
}

/* ─── CUSTOMERS TAB ───────────────────────────────────────── */

async function loadCustomersTab() {
  const brand = await getBrandUser();
  if (!brand) return;

  // Aggregate customer spend from orders for this brand
  const { data: orders, error } = await db
    .from('orders')
    .select('total_amount, profiles!orders_user_id_fkey(id, name, email)')
    .eq('brand_id', brand.id);

  if (error) { console.error('loadCustomersTab error:', error.message); return; }

  // Aggregate by customer
  const map = {};
  (orders || []).forEach(o => {
    const prof  = o.profiles || {};
    const email = prof.email || 'unknown';
    if (!map[email]) map[email] = { name: prof.name || '—', email, orders: 0, total: 0 };
    map[email].orders++;
    map[email].total += parseFloat(o.total_amount) || 0;
  });

  const customers = Object.values(map);
  const tbody = document.getElementById('customers-table-body');
  if (!tbody) return;

  if (!customers.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--text-secondary);">No customers yet</td></tr>';
    return;
  }

  tbody.innerHTML = customers.map(c => `
    <tr>
      <td>${escapeValue(c.name || '—')}</td>
      <td>${escapeValue(c.email || '—')}</td>
      <td>${escapeValue(c.orders)}</td>
      <td>KES ${c.total.toLocaleString()}</td>
      <td><button class="action-btn">View</button></td>
    </tr>`).join('');
}

/* ─── RESET DATABASE ──────────────────────────────────────── */

async function resetDatabase() {
  if (!confirm('⚠️ RESET? This permanently deletes ALL your orders, order items, and products. Cannot be undone.')) return;

  const brand = await getBrandUser();
  if (!brand) return;

  // Delete in dependency order
  const productIds = await db
    .from('products')
    .select('id')
    .eq('brand_id', brand.id)
    .then(r => (r.data || []).map(p => p.id));

  if (productIds.length) {
    await db.from('order_items').delete().in('product_id', productIds);
    await db.from('wishlists').delete().in('product_id', productIds);
    await db.from('products').delete().eq('brand_id', brand.id);
  }

  await db.from('orders').delete().eq('brand_id', brand.id);

  showToast('All brand data reset.', 'success');
  setTimeout(() => tabSwitch('orders'), 1200);
}

/* ─── HELPERS ─────────────────────────────────────────────── */
// getBrandUser() now lives in merchmarket.js (shared with add-item.html / view-order.html)
