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

  // Add item button
  document.getElementById('add-inventory')?.addEventListener('click', e => {
    e.preventDefault();
    showInventoryModal(null);
  });

  // Refresh orders
  document.getElementById('refresh-orders')?.addEventListener('click', () => {
    loadOrdersTab();
    showToast('Orders refreshed!', 'success');
  });

  // Search orders (debounced)
  document.getElementById('orders-search')?.addEventListener('input',
    debounce(() => loadOrdersTab(), 300)
  );

  // Save payment details
  document.getElementById('save-payment-details')?.addEventListener('click', savePaymentDetails);

  // Reset DB
  document.getElementById('reset-db')?.addEventListener('click', resetDatabase);

  // Payment method label switcher
  wirePaymentMethodSwitcher();

  // Load first tab
  tabSwitch('orders');
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
      id, total, status, location, created_at,
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
  const revenue   = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
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
      ? items.map(i => i.products?.name || i.sku || '—').join(', ')
      : '—';
    const date  = order.created_at ? new Date(order.created_at).toLocaleDateString('en-KE') : '—';
    const total = parseFloat(order.total) || 0;
    const st    = order.status || 'pending';

    return `
      <tr>
        <td><strong style="color:#ffd8b5;font-family:monospace;">#${order.id}</strong></td>
        <td>${cust.name || '—'}<br><small style="color:#a0a0a0;">${cust.email || '—'}</small></td>
        <td>${itemLabel}</td>
        <td>${date}<br><small style="color:#a0a0a0;">Updated: ${date}</small></td>
        <td>${order.location || 'Nairobi, Kenya'}</td>
        <td>KES ${total.toLocaleString()}</td>
        <td><span class="status ${st}">${st.toUpperCase()}</span></td>
        <td>
          <button class="action-btn" onclick="viewOrder('${order.id}')">View</button>
          ${st === 'pending' ? `<button class="action-btn" style="background:#4caf50;color:#fff;" onclick="updateOrderStatus('${order.id}','confirmed')">Confirm</button>` : ''}
          ${st === 'confirmed' ? `<button class="action-btn" style="background:#2196f3;color:#fff;" onclick="updateOrderStatus('${order.id}','active')">Ship</button>` : ''}
          ${(st === 'active' || st === 'confirmed') ? `<button class="action-btn" style="background:#ff9800;color:#fff;" onclick="updateOrderStatus('${order.id}','completed')">Complete</button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

/* ─── VIEW ORDER MODAL ────────────────────────────────────── */

async function viewOrder(orderId) {
  const { data: order, error } = await db
    .from('orders')
    .select(`
      id, total, status, location, created_at,
      profiles!orders_user_id_fkey (name, email),
      order_items (
        quantity, sku, unit_price,
        products (name)
      )
    `)
    .eq('id', orderId)
    .single();

  if (error || !order) {
    showToast('Order not found', 'error');
    return;
  }

  const cust  = order.profiles || {};
  const items = order.order_items || [];
  const date  = order.created_at ? new Date(order.created_at).toLocaleDateString('en-KE') : '—';
  const total = parseFloat(order.total) || 0;
  const st    = order.status || 'pending';

  const itemsHtml = items.length
    ? items.map(i => `<li>${i.products?.name || i.sku || '—'} — Qty: ${i.quantity} — KES ${parseFloat(i.unit_price || 0).toLocaleString()}</li>`).join('')
    : '<li>No items</li>';

  const modal = document.getElementById('inventory-modal');
  if (!modal) return;

  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()" style="
        max-width:560px;max-height:90vh;overflow-y:auto;
        background:white;border-radius:20px;padding:2.5rem;
        box-shadow:0 25px 60px rgba(0,0,0,.3);position:relative;
        animation:modalSlideIn .3s cubic-bezier(.4,0,.2,1);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
          <h2 style="margin:0;font-size:1.6rem;font-weight:700;color:#1a1a1a;">Order #${order.id}</h2>
          <button onclick="closeModal()" style="background:none;border:none;font-size:1.6rem;cursor:pointer;color:#999;">×</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:1.2rem;color:#333;font-size:.95rem;">
          <div style="background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <h4 style="margin:0 0 .6rem 0;color:#667eea;">👤 Customer</h4>
            <p><strong>Name:</strong> ${cust.name || '—'}</p>
            <p><strong>Email:</strong> ${cust.email || '—'}</p>
          </div>
          <div style="background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <h4 style="margin:0 0 .6rem 0;color:#667eea;">📦 Items</h4>
            <ul style="padding-left:1.2rem;">${itemsHtml}</ul>
          </div>
          <div style="background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <h4 style="margin:0 0 .6rem 0;color:#667eea;">📍 Shipping</h4>
            <p><strong>Location:</strong> ${order.location || 'Nairobi, Kenya'}</p>
            <p><strong>Date:</strong> ${date}</p>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;background:#f8f9fa;border-radius:12px;padding:1.2rem;">
            <p><strong>Status:</strong> <span class="status ${st}">${st.toUpperCase()}</span></p>
            <div style="font-size:1.3rem;font-weight:700;color:#1a1a1a;">KES ${total.toLocaleString()}</div>
          </div>
        </div>

        <div style="display:flex;gap:1rem;justify-content:flex-end;margin-top:1.5rem;">
          ${st === 'pending'   ? `<button onclick="updateOrderStatus('${order.id}','confirmed');closeModal();" style="padding:1rem 2rem;border:none;border-radius:12px;background:#4caf50;color:#fff;font-weight:600;cursor:pointer;">Confirm</button>` : ''}
          ${st === 'confirmed' ? `<button onclick="updateOrderStatus('${order.id}','active');closeModal();"    style="padding:1rem 2rem;border:none;border-radius:12px;background:#2196f3;color:#fff;font-weight:600;cursor:pointer;">Mark Shipped</button>` : ''}
          <button onclick="closeModal()" style="padding:1rem 2rem;border:none;border-radius:12px;background:#f5f5f5;color:#666;font-weight:600;cursor:pointer;">Close</button>
        </div>

        <style>
          @keyframes modalSlideIn { from{opacity:0;transform:translateY(-30px) scale(.95)} to{opacity:1;transform:translateY(0) scale(1)} }
          .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:2rem;}
        </style>
      </div>
    </div>`;

  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
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
    return `
      <tr>
        <td>${p.name}</td>
        <td style="font-family:monospace;color:#a0a0a0;">${p.sku || '—'}</td>
        <td>${p.stock ?? '—'}</td>
        <td>KES ${parseFloat(p.price || 0).toLocaleString()}</td>
        <td>${imgCount} image${imgCount !== 1 ? 's' : ''}</td>
        <td>
          <button class="action-btn" onclick="showInventoryModal('${p.id}')">Edit</button>
          <button class="action-btn" style="background:#f44336;color:#fff;" onclick="deleteInventoryItem('${p.id}')">Delete</button>
        </td>
      </tr>`;
  }).join('');
}

/* ─── INVENTORY MODAL (Add / Edit) ───────────────────────── */

async function showInventoryModal(productId = null) {
  const brand = await getBrandUser();
  if (!brand) { showToast('Brand login required', 'error'); return; }

  // Fetch existing product if editing
  let item = null;
  if (productId) {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('id', productId)
      .eq('brand_id', brand.id)
      .single();
    if (error || !data) { showToast('Product not found', 'error'); return; }
    item = data;
  }

  const isEdit = !!item;
  const modal  = document.getElementById('inventory-modal');
  if (!modal) return;

  const sel = (field, val) => {
    const opts = { official: 'Official Wear', street: 'Street Wear', casual: 'Casual Wear', other: 'Other' };
    return Object.entries(opts).map(([k, v]) =>
      `<option value="${k}" ${(val === k) ? 'selected' : ''}>${v}</option>`).join('');
  };
  const selType = (val) => {
    const opts = { torso: 'Torso', trunks: 'Trunks', innies: 'Innies', shoes: 'Shoes', socks: 'Socks', other: 'Other' };
    return Object.entries(opts).map(([k, v]) =>
      `<option value="${k}" ${(val === k) ? 'selected' : ''}>${v}</option>`).join('');
  };

  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeModal()">
      <div class="modal-content" onclick="event.stopPropagation()" style="
        max-width:580px;max-height:90vh;overflow-y:auto;
        background:white;border-radius:20px;padding:2.5rem;
        box-shadow:0 25px 60px rgba(0,0,0,.3);
        animation:modalSlideIn .3s cubic-bezier(.4,0,.2,1);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem;">
          <h2 style="margin:0;font-size:1.8rem;font-weight:700;color:#1a1a1a;">${isEdit ? 'Edit Item' : 'Add New Item'}</h2>
          <button onclick="closeModal()" style="background:none;border:none;font-size:1.6rem;cursor:pointer;color:#999;">×</button>
        </div>

        <form id="inventory-form" style="display:flex;flex-direction:column;gap:1.4rem;">

          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Item Name *</label>
            <input type="text" id="item-name" required value="${item?.name || ''}"
              style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;"
              placeholder="e.g. Custom Logo Hoodie">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">SKU *</label>
              <input type="text" id="item-sku" required value="${item?.sku || ''}"
                style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;"
                placeholder="e.g. HOD-001">
            </div>
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Stock *</label>
              <input type="number" id="item-stock" min="0" required value="${item?.stock ?? 0}"
                style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;">
            </div>
          </div>

          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Price (KES) *</label>
            <input type="number" id="item-price" min="0" step="0.01" required value="${item?.price || ''}"
              style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;"
              placeholder="e.g. 2500">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Wear Category</label>
              <select id="item-wear-category" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;">
                ${sel('wear_category', item?.wear_category)}
              </select>
            </div>
            <div>
              <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Item Type</label>
              <select id="item-type" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;">
                ${selType(item?.item_type)}
              </select>
            </div>
          </div>

          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Condition</label>
            <select id="item-condition" style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;">
              <option value="new"      ${item?.condition === 'new'      ? 'selected' : ''}>New</option>
              <option value="like_new" ${item?.condition === 'like_new' ? 'selected' : ''}>Like New</option>
              <option value="used"     ${item?.condition === 'used'     ? 'selected' : ''}>Used</option>
              <option value="vintage"  ${item?.condition === 'vintage'  ? 'selected' : ''}>Vintage</option>
            </select>
          </div>

          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Tags (comma-separated)</label>
            <input type="text" id="item-tags" value="${Array.isArray(item?.tags) ? item.tags.join(', ') : ''}"
              style="width:100%;padding:1rem;border:2px solid #e5e5e5;border-radius:12px;font-size:1rem;box-sizing:border-box;"
              placeholder="e.g. trendy, limited, summer">
          </div>

          <div>
            <label style="display:block;margin-bottom:.4rem;font-weight:600;color:#333;">Images</label>
            <input type="file" id="item-image-files" accept="image/*" multiple style="display:none">
            <button type="button" id="btn-select-images"
              style="padding:.8rem 1.2rem;border:2px dashed #c0c0c0;border-radius:12px;background:#fafafa;color:#555;font-weight:600;font-size:.95rem;cursor:pointer;width:100%;">
              📁 Choose images from device
            </button>
            <div id="image-preview-list" style="display:flex;flex-wrap:wrap;gap:.6rem;margin-top:.8rem;"></div>
            <small style="color:#888;font-size:.82rem;">Images are stored as base64 in Supabase. For production, use Supabase Storage instead.</small>
          </div>

          <div style="display:flex;gap:1rem;justify-content:flex-end;margin-top:.5rem;">
            <button type="button" onclick="closeModal()"
              style="padding:.9rem 1.8rem;border:none;border-radius:12px;background:#f5f5f5;color:#666;font-weight:600;cursor:pointer;">
              Cancel
            </button>
            ${isEdit ? `<button type="button" onclick="deleteInventoryItem('${productId}');closeModal();"
              style="padding:.9rem 1.8rem;border:none;border-radius:12px;background:#f44336;color:#fff;font-weight:600;cursor:pointer;">
              Delete
            </button>` : ''}
            <button type="submit"
              style="padding:.9rem 2rem;border:none;border-radius:12px;background:linear-gradient(135deg,#c47d2e,#ffd8b5);color:#0a0a0a;font-weight:700;cursor:pointer;">
              ${isEdit ? 'Update Item' : 'Add Item'}
            </button>
          </div>
        </form>

        <style>
          @keyframes modalSlideIn { from{opacity:0;transform:translateY(-30px) scale(.95)} to{opacity:1;transform:none} }
          .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:2rem;}
          #inventory-form input:focus, #inventory-form select:focus {outline:none;border-color:#c47d2e !important;box-shadow:0 0 0 3px rgba(196,125,46,.15);}
        </style>
      </div>
    </div>`;

  modal.classList.add('active');
  document.body.style.overflow = 'hidden';

  // ─── Image handling ───
  const fileInput   = document.getElementById('item-image-files');
  const selectBtn   = document.getElementById('btn-select-images');
  const previewList = document.getElementById('image-preview-list');

  // Normalize existing images to plain string URLs
  let currentImages = (item?.images || []).map(img =>
    typeof img === 'string' ? img : (img?.url || '')
  ).filter(Boolean);

  function renderPreviews() {
    if (!previewList) return;
    previewList.innerHTML = currentImages.map((src, idx) => `
      <div style="position:relative;width:70px;height:70px;border-radius:8px;overflow:hidden;border:1px solid #ddd;flex-shrink:0;">
        <img src="${src}" style="width:100%;height:100%;object-fit:cover;" loading="lazy">
        <button type="button" data-idx="${idx}" class="btn-rm-img" style="
          position:absolute;top:2px;right:2px;width:20px;height:20px;border:none;border-radius:50%;
          background:#f44336;color:#fff;font-size:12px;cursor:pointer;line-height:1;">×</button>
      </div>`).join('');

    previewList.querySelectorAll('.btn-rm-img').forEach(btn => {
      btn.onclick = () => {
        currentImages.splice(parseInt(btn.dataset.idx), 1);
        renderPreviews();
      };
    });
  }

  selectBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    let done = 0;
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        currentImages.push(ev.target.result);
        done++;
        if (done === files.length) { renderPreviews(); fileInput.value = ''; }
      };
      reader.readAsDataURL(file);
    });
  });
  renderPreviews();

  // ─── Form submit ───
  document.getElementById('inventory-form').onsubmit = async function(e) {
    e.preventDefault();

    const name         = document.getElementById('item-name').value.trim();
    const sku          = document.getElementById('item-sku').value.trim();
    const stock        = parseInt(document.getElementById('item-stock').value) || 0;
    const price        = parseFloat(document.getElementById('item-price').value) || 0;
    const wear_category = document.getElementById('item-wear-category').value;
    const item_type    = document.getElementById('item-type').value;
    const condition    = document.getElementById('item-condition').value;
    const tags         = document.getElementById('item-tags').value
      .split(',').map(t => t.trim()).filter(Boolean);

    if (!name || !sku) { showToast('Name and SKU are required', 'error'); return; }

    const payload = {
      brand_id:      brand.id,
      name,
      sku,
      stock,
      price,
      seller:        brand.name,
      wear_category,
      item_type,
      condition,
      tags,
      images:        currentImages.map(url => ({ url })),
      updated_at:    new Date().toISOString()
    };

    let dbError;
    if (isEdit) {
      const { error } = await db
        .from('products')
        .update(payload)
        .eq('id', productId)
        .eq('brand_id', brand.id);
      dbError = error;
    } else {
      payload.created_at = new Date().toISOString();
      const { error } = await db.from('products').insert(payload);
      dbError = error;
    }

    if (dbError) {
      console.error('saveInventoryItem error:', dbError.message);
      showToast('Failed to save item: ' + dbError.message, 'error');
      return;
    }

    showToast(`Item ${isEdit ? 'updated' : 'added'} successfully!`, 'success');
    closeModal();
    loadInventoryTab();
  };
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
    .select('total, profiles!orders_user_id_fkey(id, name, email)')
    .eq('brand_id', brand.id);

  if (error) { console.error('loadCustomersTab error:', error.message); return; }

  // Aggregate by customer
  const map = {};
  (orders || []).forEach(o => {
    const prof  = o.profiles || {};
    const email = prof.email || 'unknown';
    if (!map[email]) map[email] = { name: prof.name || '—', email, orders: 0, total: 0 };
    map[email].orders++;
    map[email].total += parseFloat(o.total) || 0;
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
      <td>${c.name}</td>
      <td>${c.email}</td>
      <td>${c.orders}</td>
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

/* ─── MODAL CLOSE ─────────────────────────────────────────── */

function closeModal() {
  const modal = document.getElementById('inventory-modal');
  if (modal) { modal.innerHTML = ''; modal.classList.remove('active'); }
  document.body.style.overflow = '';
}

/* ─── HELPERS ─────────────────────────────────────────────── */

// Returns the current brand's full profile, or null + redirects
async function getBrandUser() {
  const user = await getCurrentUser();
  if (!user || user.type !== 'brand') {
    showToast('Brand account required', 'error');
    return null;
  }
  return user;
}
