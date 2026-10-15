/* MerchMarket admin dashboard. All data comes from this app's own /api, which
   only answers a signed-in admin. Every value from the database is escaped. */
(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kes = (n) => 'KES ' + (Number(n) || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const short = (id) => String(id || '').slice(0, 8);
  const dt = (d) => d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const date = (d) => d ? new Date(d).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : '—';
  let STATE = { me: null, commission: 0.12 };

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 404 && path === '/api/me') { location.href = '/login'; throw new Error('signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404 && !data.error) { location.href = '/login'; throw new Error('signed out'); }
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }
  // Writes always send JSON (the server requires it).
  const post = (path, body) => api(path, 'POST', body || {});

  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 3500);
  }

  // A small dialog for confirmations that need a reason or extra fields.
  function ask({ title, text, fields = [], ok = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const d = $('ask');
      $('ask-title').textContent = title;
      $('ask-text').textContent = text || '';
      $('ask-text').style.display = text ? '' : 'none';
      $('ask-fields').innerHTML = fields.map((f, i) => {
        if (f.type === 'select') {
          return `<label class="field">${esc(f.label)}<select data-k="${esc(f.name)}">${f.options.map(o =>
            `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select></label>`;
        }
        if (f.type === 'checkbox') {
          return `<label class="check"><input type="checkbox" data-k="${esc(f.name)}" ${f.checked ? 'checked' : ''}>${esc(f.label)}</label>`;
        }
        const tag = f.type === 'textarea' ? 'textarea' : 'input';
        return `<label class="field">${esc(f.label)}<${tag} data-k="${esc(f.name)}" maxlength="${f.max || 300}" ${f.required ? 'required' : ''}
          placeholder="${esc(f.placeholder || '')}" ${i === 0 ? 'autofocus' : ''}>${tag === 'textarea' ? '</textarea>' : ''}</label>`;
      }).join('');
      const okBtn = $('ask-ok');
      okBtn.textContent = ok;
      okBtn.className = 'btn' + (danger ? ' danger' : '');
      const done = (val) => { d.close(); cleanup(); resolve(val); };
      const onSubmit = (e) => {
        e.preventDefault();
        const out = {};
        $('ask-fields').querySelectorAll('[data-k]').forEach(el => {
          out[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value.trim();
        });
        for (const f of fields) if (f.required && !out[f.name]) return;
        done(out);
      };
      const onCancel = () => done(null);
      const cleanup = () => {
        $('ask-form').removeEventListener('submit', onSubmit);
        $('ask-cancel').removeEventListener('click', onCancel);
        d.removeEventListener('cancel', onCancel);
      };
      $('ask-form').addEventListener('submit', onSubmit);
      $('ask-cancel').addEventListener('click', onCancel);
      d.addEventListener('cancel', onCancel);
      d.showModal();
    });
  }

  // ── Drawer ───────────────────────────────────────────────────
  let lastFocus = null;
  function openDrawer(title, html) {
    lastFocus = document.activeElement;
    $('drawer-title').textContent = title;
    $('drawer-body').innerHTML = html;
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawer-close').focus();
  }
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    if (lastFocus) lastFocus.focus();
  }
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('drawer').classList.contains('open') && !$('ask').open) closeDrawer(); });

  // ── Status labels ────────────────────────────────────────────
  const ORDER_STATUS = {
    pending: ['Placed', ''], confirmed: ['Confirmed', 'info'], active: ['Being prepared', 'info'],
    shipped: ['Shipped', 'warn'], completed: ['Delivered', 'good'], cancelled: ['Cancelled', 'bad']
  };
  const statusPill = (s) => { const [l, c] = ORDER_STATUS[s] || [s, '']; return `<span class="pill ${c}">${esc(l)}</span>`; };
  const payPill = (p) => p === 'paid' ? '<span class="pill good">Paid</span>'
    : p === 'failed' ? '<span class="pill bad">Failed</span>' : `<span class="pill warn">${esc(p ? p[0].toUpperCase() + p.slice(1) : 'Unpaid')}</span>`;

  // ── Chart: single-series bars with hover tooltip ─────────────
  function barChart(values, labels, fmt, integer) {
    const W = 600, H = 190, padL = 44, padB = 22, padT = 8, padR = 4;
    const max = Math.max(1, ...values);
    const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); const m = max / p; const n = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; return integer ? Math.max(2, Math.ceil(n / 2) * 2) : n; })();
    const iw = W - padL - padR, ih = H - padT - padB;
    const bw = iw / values.length;
    const gap = 2;
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">`;
    [0, .5, 1].forEach(f => {
      const y = padT + ih - ih * f;
      svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      svg += `<text class="axis" x="${padL - 6}" y="${y + 4}" text-anchor="end">${esc(fmt(nice * f, true))}</text>`;
    });
    values.forEach((v, i) => {
      const h = v > 0 ? Math.max(2, ih * v / nice) : 0;
      const x = padL + i * bw + gap / 2, w = Math.max(1, bw - gap), y = padT + ih - h;
      if (h > 0) {
        const r = Math.min(4, w / 2, h);
        svg += `<path class="bar" data-i="${i}" d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z"/>`;
      }
      svg += `<rect class="hit" data-i="${i}" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${ih}"/>`;
    });
    [0, Math.floor(values.length / 2), values.length - 1].forEach(i => {
      svg += `<text class="axis" x="${padL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(labels[i].slice(5))}</text>`;
    });
    return svg + '</svg>';
  }
  function wireChart(el, values, labels, fmt) {
    const tip = $('tip');
    el.querySelectorAll('.hit').forEach(hit => {
      const i = +hit.dataset.i;
      const show = (e) => {
        el.querySelectorAll('.bar').forEach(b => b.classList.toggle('dim', +b.dataset.i !== i));
        tip.innerHTML = `${esc(new Date(labels[i] + 'T12:00:00').toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' }))}: <b>${esc(fmt(values[i]))}</b>`;
        tip.classList.add('on');
        const pt = e.touches ? e.touches[0] : e;
        tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, pt.clientX + 12) + 'px';
        tip.style.top = (pt.clientY - 34) + 'px';
      };
      hit.addEventListener('mousemove', show);
      hit.addEventListener('touchstart', show, { passive: true });
    });
    const hide = () => { tip.classList.remove('on'); el.querySelectorAll('.bar').forEach(b => b.classList.remove('dim')); };
    el.addEventListener('mouseleave', hide);
    el.addEventListener('touchend', () => setTimeout(hide, 1200));
  }
  function chartTable(values, labels, fmt) {
    return `<div class="table-wrap" style="max-height:240px;overflow:auto;"><table><thead><tr><th>Day</th><th class="r">Value</th></tr></thead><tbody>${
      values.map((v, i) => `<tr><td>${esc(labels[i])}</td><td class="r num">${esc(fmt(v))}</td></tr>`).reverse().join('')}</tbody></table></div>`;
  }

  // ── Views ────────────────────────────────────────────────────
  const view = () => $('view');
  const loading = () => { view().innerHTML = '<div class="loading">Loading…</div>'; };
  const fail = (e) => { view().innerHTML = `<div class="notice">${esc(e.message)}</div>`; };

  async function renderOverview() {
    loading();
    const d = await api('/api/overview');
    const pct = Math.round(d.commission_rate * 100);
    const k = (label, value, sub, cls) => `<div class="kpi ${cls || ''}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
    const status = Object.entries(d.by_status).sort((a, b) => b[1] - a[1]);
    view().innerHTML = `
      <div class="section-head"><div><h1>Overview</h1><p>Paid orders only, excluding cancelled. Commission at ${pct}%.</p></div>
        <button class="btn ghost sm" id="refresh">Refresh</button></div>
      <div class="kpis">
        ${k('Sales (paid)', kes(d.gmv), `${d.orders_paid} paid orders`, 'hero')}
        ${k('MerchMarket commission', kes(d.commission), `${pct}% of sales`, 'hero')}
        ${k('Owed to brands', kes(d.owed_to_brands), 'Delivered orders, after commission')}
        ${k('To ship', d.orders_to_ship, 'Paid, not yet shipped', d.orders_to_ship ? 'alert' : '')}
        ${k('In transit', d.orders_in_transit, 'Waiting for courier scan')}
        ${k('Awaiting payment', d.orders_awaiting_payment, 'Not paid yet')}
        ${k('Members', d.members, `${d.signups_30d} new in 30 days`)}
        ${k('Brands', d.brands)}
        ${k('Live products', d.products_live, d.products_hidden ? `${d.products_hidden} hidden by you` : '')}
        ${k('Active couriers', d.couriers_active, d.couriers_active ? '' : 'Add one so deliveries can be confirmed', d.couriers_active ? '' : 'alert')}
        ${k('Waitlist', d.waitlist)}
      </div>
      <div class="grid2">
        <div class="panel"><div class="panel-head"><div><h2>Daily sales</h2><div class="sub">Paid orders, last 30 days (KES)</div></div>
          <button class="link" data-toggle="sales">Table</button></div><div id="c-sales"></div></div>
        <div class="panel"><div class="panel-head"><div><h2>New signups</h2><div class="sub">Members and brands, last 30 days</div></div>
          <button class="link" data-toggle="signups">Table</button></div><div id="c-signups"></div></div>
      </div>
      <div class="grid2">
        <div class="panel"><h2>Orders by status</h2><div class="sub">All ${d.orders_total} orders</div>
          <ul class="status-list">${status.map(([s, n]) => `<li><a href="#orders?status=${encodeURIComponent(s)}">${statusPill(s)}</a><span class="num">${n}</span></li>`).join('') || '<li class="muted">No orders yet</li>'}</ul></div>
      </div>`;
    const kFmt = (v, axis) => axis ? (v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v))) : kes(v);
    const nFmt = (v) => String(Math.round(v));
    const charts = { sales: [d.sales, kFmt, false], signups: [d.signups, nFmt, true] };
    const draw = (key, asTable) => {
      const [vals, fmt, integer] = charts[key];
      const el = $('c-' + key);
      el.innerHTML = asTable ? chartTable(vals, d.days, fmt) : barChart(vals, d.days, fmt, integer);
      if (!asTable) wireChart(el, vals, d.days, fmt);
    };
    draw('sales'); draw('signups');
    view().querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
      const t = b.textContent === 'Table';
      b.textContent = t ? 'Chart' : 'Table';
      draw(b.dataset.toggle, t);
    }));
    $('refresh').addEventListener('click', () => route());
  }

  async function renderOrders(params) {
    loading();
    const qs = new URLSearchParams();
    ['status', 'payment', 'brand', 'user', 'q'].forEach(k => { if (params.get(k)) qs.set(k, params.get(k)); });
    const d = await api('/api/orders?' + qs);
    const sel = (name, opts) => `<select data-f="${name}"><option value="">${name === 'status' ? 'All statuses' : 'All payments'}</option>${
      opts.map(([v, l]) => `<option value="${esc(v)}" ${params.get(name) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const scoped = params.get('brand') || params.get('user');
    view().innerHTML = `
      <div class="section-head"><div><h1>Orders</h1><p>${d.orders.length} shown${scoped ? ' · filtered to one ' + (params.get('brand') ? 'brand' : 'buyer') + ' <a href="#orders">(clear)</a>' : ''}</p></div></div>
      <form class="filters" id="of">
        <input type="search" data-f="q" placeholder="Search order, buyer, brand, tracking no." value="${esc(params.get('q') || '')}">
        ${sel('status', Object.entries(ORDER_STATUS).map(([v, [l]]) => [v, l]))}
        ${sel('payment', [['paid', 'Paid'], ['unpaid', 'Unpaid'], ['failed', 'Failed']])}
        <button class="btn sm" type="submit">Apply</button>
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Order</th><th>Buyer</th><th class="hide-sm">Brand</th><th>Status</th><th class="hide-sm">Payment</th><th class="r">Total</th><th class="hide-sm">Placed</th></tr></thead>
        <tbody>${d.orders.map(o => `<tr class="click" data-id="${esc(o.id)}" tabindex="0">
          <td class="mono">#${esc(short(o.id))}</td>
          <td>${esc(o.buyer.name || '—')}<div class="muted hide-sm" style="font-size:12px">${esc(o.buyer.email || '')}</div></td>
          <td class="hide-sm">${esc(o.brand.name || '—')}</td>
          <td>${statusPill(o.status)}</td>
          <td class="hide-sm">${payPill(o.payment_status)}</td>
          <td class="r num">${esc(kes(o.total_amount))}</td>
          <td class="hide-sm">${esc(date(o.created_at))}</td></tr>`).join('')}</tbody>
      </table>${d.orders.length ? '' : '<div class="empty">No orders match.</div>'}</div>`;
    $('of').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new URLSearchParams();
      ['brand', 'user'].forEach(k => { if (params.get(k)) p.set(k, params.get(k)); });
      e.target.querySelectorAll('[data-f]').forEach(el => { if (el.value) p.set(el.dataset.f, el.value); });
      location.hash = 'orders' + (p.toString() ? '?' + p : '');
    });
    view().querySelectorAll('tr[data-id]').forEach(tr => {
      const open = () => orderDetail(tr.dataset.id);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  async function orderDetail(id) {
    openDrawer('Order #' + short(id), '<div class="loading">Loading…</div>');
    let d;
    try { d = await api('/api/orders/' + encodeURIComponent(id)); } catch (e) { $('drawer-body').innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
    const o = d.order;
    const open = !['completed', 'cancelled'].includes(o.status);
    const items = (o.order_items || []).map(i => `<tr><td>${esc(i.products?.name || i.sku || 'Item')}${i.size ? ` <span class="muted">(${esc(i.size)})</span>` : ''}</td>
      <td class="r num">${Number(i.quantity) || 0}</td><td class="r num">${esc(kes((Number(i.unit_price) || 0) * (Number(i.quantity) || 0)))}</td></tr>`).join('');
    const hist = (o.order_status_history || []).map(h => `<li><strong>${esc((ORDER_STATUS[h.to_status] || [h.to_status])[0])}</strong>
      <div class="when">${esc(dt(h.created_at))} · ${esc(h.actor_role === 'admin' ? 'you' : h.actor_role === 'authenticated' ? 'brand' : h.actor_role || 'system')}</div>
      ${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}</li>`).join('');
    const dl = d.delivery;
    $('drawer-body').innerHTML = `
      <div class="row" style="margin-bottom:12px">${statusPill(o.status)} ${payPill(o.payment_status)}</div>
      <div class="block"><h4>People</h4><dl class="kv">
        <dt>Buyer</dt><dd>${esc(d.buyer?.name || '—')} <span class="muted">${esc(d.buyer?.email || '')}</span> · <a href="#orders?user=${encodeURIComponent(o.user_id)}">their orders</a></dd>
        <dt>Brand</dt><dd>${esc(d.brand?.name || '—')} · <a href="#orders?brand=${encodeURIComponent(o.brand_id)}">brand orders</a></dd>
        <dt>Deliver to</dt><dd>${esc(o.location || '—')}${o.recipient_phone ? ' · ' + esc(o.recipient_phone) : ''}</dd>
      </dl></div>
      <div class="block"><h4>Items</h4><table><tbody>${items || '<tr><td class="muted">No items</td></tr>'}</tbody></table>
        <dl class="kv" style="margin-top:10px"><dt>Total</dt><dd class="num"><strong>${esc(kes(o.total_amount))}</strong></dd>
        <dt>Commission</dt><dd class="num">${esc(kes(d.commission))}</dd>
        <dt>Brand gets</dt><dd class="num">${esc(kes((Number(o.total_amount) || 0) - d.commission))}</dd></dl></div>
      <div class="block"><h4>Delivery</h4><dl class="kv">
        <dt>Carrier</dt><dd>${esc(o.carrier || '—')}</dd><dt>Tracking no.</dt><dd class="mono">${esc(o.tracking_number || '—')}</dd>
        <dt>Shipped</dt><dd>${esc(dt(o.shipped_at))}</dd><dt>Delivered</dt><dd>${esc(dt(o.delivered_at))}</dd>
        <dt>Delivery code</dt><dd>${dl ? (dl.redeemed_at ? `Scanned ${esc(dt(dl.redeemed_at))}${dl.courier ? ' by ' + esc(dl.courier) : ''}` : `Issued ${esc(dt(dl.issued_at))}, not scanned${dl.attempts ? ` · ${dl.attempts} wrong backup-code tries` : ''}`) : 'Not issued (issued when shipped)'}</dd>
      </dl></div>
      <div class="block"><h4>History</h4><ul class="timeline">${hist || '<li>No history</li>'}</ul></div>
      <div class="row">
        <button class="btn ghost" id="o-note">Post update to buyer</button>
        ${open ? '<button class="btn danger" id="o-cancel">Cancel order</button>' : ''}
      </div>
      <p class="muted" style="font-size:12px;margin-top:10px">Order ID <span class="mono">${esc(o.id)}</span></p>`;
    $('o-note').addEventListener('click', async () => {
      const r = await ask({ title: 'Post an update', text: 'Shown on the buyer’s tracking page and the brand’s order page.',
        fields: [{ name: 'note', label: 'Update', type: 'textarea', required: true }, { name: 'notify', label: 'Also send the buyer a notification', type: 'checkbox', checked: true }], ok: 'Post' });
      if (!r) return;
      try { await post(`/api/orders/${encodeURIComponent(o.id)}/note`, r); toast('Update posted.'); orderDetail(o.id); } catch (e) { toast(e.message, true); }
    });
    if (open) $('o-cancel').addEventListener('click', async () => {
      const r = await ask({ title: 'Cancel this order?', danger: true, ok: 'Cancel order',
        text: o.payment_status === 'paid' ? 'This order is PAID. Cancelling does not refund the buyer automatically; you’ll need to refund them through Pesapal.' : 'The buyer and brand will see this.',
        fields: [{ name: 'reason', label: 'Reason (the buyer sees it)', required: true }] });
      if (!r) return;
      try {
        const out = await post(`/api/orders/${encodeURIComponent(o.id)}/cancel`, r);
        toast(out.refund_needed ? 'Cancelled. Remember to refund the buyer.' : 'Order cancelled.');
        orderDetail(o.id);
        if (location.hash.startsWith('#orders')) renderOrders(new URLSearchParams(location.hash.split('?')[1] || ''));
      } catch (e) { toast(e.message, true); }
    });
  }

  async function renderBrands() {
    loading();
    const d = await api('/api/brands');
    const pct = Math.round(d.commission_rate * 100);
    const kycPill = (k) => {
      if (!k) return '<span class="pill warn">No vendor details</span>';
      const st = k.status === 'approved' ? 'good' : k.status === 'rejected' ? 'bad' : 'warn';
      const lock = k.reopened ? `<span class="pill warn">Reopened until ${esc(dt(k.reopened_until))}</span>`
        : k.editable ? `<span class="pill info">Editable until ${esc(dt(k.lock_at))}</span>` : '<span class="pill">Locked</span>';
      return `<span class="pill ${st}">${esc(k.status || 'pending')}</span> ${lock}`;
    };
    const totalOwed = d.brands.reduce((t, b) => t + b.owed, 0);
    view().innerHTML = `
      <div class="section-head"><div><h1>Brands &amp; payouts</h1>
        <p>“Owed” = delivered, paid orders minus ${pct}% commission. Payouts aren’t recorded yet, so this is everything ever delivered.</p></div>
        <div class="kpi hero" style="min-width:200px"><div class="label">Total owed to brands</div><div class="value">${esc(kes(totalOwed))}</div></div></div>
      <div class="cards">${d.brands.map(b => `
        <div class="card" data-id="${esc(b.id)}">
          <div class="panel-head"><div><h3>${esc(b.name || '(no name)')}${b.deleted_at ? ' <span class="pill bad">Deleted</span>' : ''}</h3>
            <div class="muted" style="font-size:12px">${esc(b.email || '')}${b.phone ? ' · ' + esc(b.phone) : ''}</div></div></div>
          <div class="row" style="margin-top:8px">${kycPill(b.kyc)}</div>
          <div class="facts">
            <div><span>Sales</span><strong>${esc(kes(b.sales))}</strong></div>
            <div><span>Commission</span><strong>${esc(kes(b.commission))}</strong></div>
            <div><span>Owed</span><strong>${esc(kes(b.owed))}</strong></div>
            <div><span>In progress</span><strong>${esc(kes(b.pending_value))}</strong></div>
            <div><span>Orders</span><strong>${b.orders}</strong></div>
            <div><span>Products</span><strong>${b.products}${b.products_hidden ? ` (${b.products_hidden} hidden)` : ''}</strong></div>
          </div>
          ${b.kyc ? `<dl class="kv" style="margin-bottom:12px">
            <dt>Business</dt><dd>${esc(b.kyc.business_type || '—')} · KRA ${esc(b.kyc.kra_pin || '—')}</dd>
            <dt>Payout to</dt><dd>${esc([b.kyc.payout_method, b.kyc.payout_bank_name, b.kyc.payout_account_number].filter(Boolean).join(' · ') || '—')}</dd>
            <dt>Account name</dt><dd>${esc(b.kyc.payout_account_name || '—')}</dd>
            ${b.kyc.reopened_by ? `<dt>Last reopened</dt><dd>${esc(dt(b.kyc.reopened_at))}: ${esc(b.kyc.reopen_reason || '')}</dd>` : ''}
          </dl>` : ''}
          <div class="row">
            <a class="btn ghost sm" href="#orders?brand=${encodeURIComponent(b.id)}">Orders</a>
            <a class="btn ghost sm" href="#products?brand=${encodeURIComponent(b.id)}">Products</a>
            ${b.kyc ? `<button class="btn ghost sm" data-act="reopen">Reopen details</button>${b.kyc.reopened ? '<button class="btn ghost sm" data-act="lock">Lock now</button>' : ''}` : ''}
          </div>
        </div>`).join('') || '<div class="empty">No brands yet.</div>'}</div>`;
    view().querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id;
      try {
        if (btn.dataset.act === 'reopen') {
          const r = await ask({ title: 'Reopen vendor details', text: 'The brand can edit their KYC and payout details for this long.',
            fields: [{ name: 'hours', label: 'For', type: 'select', options: [['24', '24 hours'], ['48', '48 hours'], ['72', '72 hours']] },
                     { name: 'reason', label: 'Reason (audit trail)', required: true }], ok: 'Reopen' });
          if (!r) return;
          await post(`/api/brands/${encodeURIComponent(id)}/reopen`, { hours: Number(r.hours), reason: r.reason });
          toast('Reopened.');
        } else {
          await post(`/api/brands/${encodeURIComponent(id)}/lock`);
          toast('Locked.');
        }
        renderBrands();
      } catch (e) { toast(e.message, true); }
    }));
  }

  async function renderUsers(params) {
    loading();
    const q = params.get('q') || '';
    const d = await api('/api/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    view().innerHTML = `
      <div class="section-head"><div><h1>Users</h1><p>${d.users.length} members</p></div></div>
      <form class="filters" id="uf"><input type="search" name="q" placeholder="Search name, email, phone" value="${esc(q)}"><button class="btn sm">Search</button></form>
      <div class="table-wrap"><table>
        <thead><tr><th>Member</th><th class="hide-sm">Phone</th><th class="hide-sm">Joined</th><th class="r">Orders</th><th class="r">Spent</th><th class="r hide-sm">Points</th></tr></thead>
        <tbody>${d.users.map(u => `<tr>
          <td>${esc(u.name || '—')}${u.deleted_at ? ' <span class="pill bad">Deleted</span>' : ''}<div class="muted" style="font-size:12px">${esc(u.email || '')}</div></td>
          <td class="hide-sm">${esc(u.phone || '—')}</td><td class="hide-sm">${esc(date(u.created_at))}</td>
          <td class="r num">${u.orders ? `<a href="#orders?user=${encodeURIComponent(u.id)}">${u.orders}</a>` : 0}</td>
          <td class="r num">${esc(kes(u.spent))}</td><td class="r num hide-sm">${Number(u.points) || 0}</td></tr>`).join('')}</tbody>
      </table>${d.users.length ? '' : '<div class="empty">No members match.</div>'}</div>`;
    $('uf').addEventListener('submit', (e) => { e.preventDefault(); const v = e.target.q.value.trim(); location.hash = 'users' + (v ? '?q=' + encodeURIComponent(v) : ''); });
  }

  async function renderProducts(params) {
    loading();
    const qs = new URLSearchParams();
    ['brand', 'hidden', 'q'].forEach(k => { if (params.get(k)) qs.set(k, params.get(k)); });
    const d = await api('/api/products?' + qs);
    view().innerHTML = `
      <div class="section-head"><div><h1>Products</h1><p>${d.products.length} shown. Hidden products disappear from the marketplace; buyers who ordered one still see it in their orders. The brand can’t unhide it.${params.get('brand') ? ' <a href="#products">(clear brand filter)</a>' : ''}</p></div></div>
      <form class="filters" id="pf"><input type="search" name="q" placeholder="Search product, brand, category" value="${esc(params.get('q') || '')}">
        <label class="check" style="margin:0"><input type="checkbox" name="hidden" ${params.get('hidden') === '1' ? 'checked' : ''}> Hidden only</label>
        <button class="btn sm">Apply</button></form>
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>Product</th><th class="hide-sm">Brand</th><th class="r">Price</th><th class="r hide-sm">Stock</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.products.map(p => `<tr data-id="${esc(p.id)}">
          <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="thumb"></div>'}</td>
          <td>${esc(p.name)}<div class="muted" style="font-size:12px">${esc(p.category || '')}</div></td>
          <td class="hide-sm">${esc(p.brand.name || '—')}</td>
          <td class="r num">${esc(kes(p.price))}</td><td class="r num hide-sm">${p.stock ?? '—'}</td>
          <td>${p.hidden_at ? `<span class="pill bad" title="${esc(p.hidden_reason || '')}">Hidden</span>` : '<span class="pill good">Live</span>'}</td>
          <td class="r">${p.hidden_at ? '<button class="btn ghost sm" data-act="unhide">Unhide</button>' : '<button class="btn danger sm" data-act="hide">Hide</button>'}</td></tr>`).join('')}</tbody>
      </table>${d.products.length ? '' : '<div class="empty">No products match.</div>'}</div>`;
    $('pf').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new URLSearchParams();
      if (params.get('brand')) p.set('brand', params.get('brand'));
      if (e.target.q.value.trim()) p.set('q', e.target.q.value.trim());
      if (e.target.hidden.checked) p.set('hidden', '1');
      location.hash = 'products' + (p.toString() ? '?' + p : '');
    });
    view().querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id;
      try {
        if (btn.dataset.act === 'hide') {
          const r = await ask({ title: 'Hide this product?', text: 'It disappears from the marketplace right away.', danger: true, ok: 'Hide',
            fields: [{ name: 'reason', label: 'Reason (audit trail)', required: true }] });
          if (!r) return;
          await post(`/api/products/${encodeURIComponent(id)}/hide`, r);
          toast('Hidden.');
        } else {
          await post(`/api/products/${encodeURIComponent(id)}/unhide`);
          toast('Live again.');
        }
        renderProducts(params);
      } catch (e) { toast(e.message, true); }
    }));
  }

  let revealed = null;
  async function renderCouriers() {
    loading();
    const d = await api('/api/couriers');
    view().innerHTML = `
      <div class="section-head"><div><h1>Couriers</h1><p>Couriers confirm deliveries at <span class="mono">merchmarket.co.ke/courier.html</span> by scanning the buyer’s QR code. An access code is shown once, here.</p></div></div>
      <div id="reveal"></div>
      <form class="filters" id="cf"><input name="name" maxlength="80" placeholder="Courier or rider name, e.g. Sendy – John K." required><button class="btn">Add courier</button></form>
      <div class="table-wrap"><table>
        <thead><tr><th>Courier</th><th>Status</th><th class="r">Deliveries</th><th class="hide-sm">Added</th><th></th></tr></thead>
        <tbody>${d.couriers.map(c => `<tr data-id="${esc(c.id)}" data-name="${esc(c.name)}">
          <td>${esc(c.name)}<div class="muted" style="font-size:12px">${c.brand_name ? 'Rider for ' + esc(c.brand_name) + ' (their orders only)' : 'MerchMarket courier (any order)'}</div></td>
          <td>${c.active ? '<span class="pill good">Active</span>' : '<span class="pill bad">Deactivated</span>'}</td>
          <td class="r num">${c.deliveries}</td><td class="hide-sm">${esc(date(c.created_at))}</td>
          <td class="r"><div class="row end"><button class="btn ghost sm" data-act="reset">Reset code</button>
            <button class="btn ${c.active ? 'danger' : 'ghost'} sm" data-act="${c.active ? 'off' : 'on'}">${c.active ? 'Deactivate' : 'Reactivate'}</button></div></td></tr>`).join('')}</tbody>
      </table>${d.couriers.length ? '' : '<div class="empty">No couriers yet. Add one so deliveries can be confirmed.</div>'}</div>`;
    const showCode = (name, code) => {
      revealed = { name, code };
      $('reveal').innerHTML = `<div class="reveal"><div>Access code for <strong>${esc(name)}</strong>:</div><div class="code">${esc(code)}</div>
        <div class="muted" style="font-size:13px;margin-bottom:8px">Send it to them privately. It won’t be shown again; reset it if it’s lost.</div>
        <div class="row"><button class="btn sm" id="copy">Copy</button><button class="btn ghost sm" id="hidecode">Hide</button></div></div>`;
      $('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(code); toast('Copied.'); } catch (e) { toast('Select the code and copy it.', true); } });
      $('hidecode').addEventListener('click', () => { revealed = null; $('reveal').innerHTML = ''; });
      $('reveal').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    if (revealed) showCode(revealed.name, revealed.code);
    $('cf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      try { const r = await post('/api/couriers', { name }); revealed = { name: r.courier.name, code: r.access_code }; renderCouriers(); }
      catch (x) { toast(x.message, true); }
    });
    view().querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async () => {
      const tr = btn.closest('[data-id]'); const id = tr.dataset.id; const name = tr.dataset.name;
      try {
        if (btn.dataset.act === 'reset') {
          const r = await ask({ title: `Reset ${name}'s code?`, text: 'Their old code stops working immediately.', ok: 'Reset' });
          if (!r) return;
          const out = await post(`/api/couriers/${encodeURIComponent(id)}/reset-code`);
          revealed = { name, code: out.access_code };
        } else {
          if (btn.dataset.act === 'off') {
            const r = await ask({ title: `Deactivate ${name}?`, text: 'They won’t be able to confirm deliveries.', ok: 'Deactivate', danger: true });
            if (!r) return;
          }
          await post(`/api/couriers/${encodeURIComponent(id)}/active`, { active: btn.dataset.act === 'on' });
        }
        renderCouriers();
      } catch (e) { toast(e.message, true); }
    }));
  }

  const ACTION_LABEL = {
    'login': 'Signed in', 'order.cancel': 'Cancelled order', 'order.note': 'Posted order update',
    'brand.kyc_reopen': 'Reopened vendor details', 'brand.kyc_lock': 'Locked vendor details',
    'product.hide': 'Hid product', 'product.unhide': 'Unhid product',
    'courier.add': 'Added courier', 'courier.reset_code': 'Reset courier code',
    'courier.activate': 'Reactivated courier', 'courier.deactivate': 'Deactivated courier'
  };
  async function renderActivity() {
    loading();
    const d = await api('/api/actions');
    const detail = (a) => {
      const x = a.details || {};
      return esc(x.reason || x.note || x.name || (x.hours ? x.hours + 'h' : '') || '');
    };
    view().innerHTML = `
      <div class="section-head"><div><h1>Activity</h1><p>Every action taken in this dashboard (last 200).</p></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Action</th><th class="hide-sm">Target</th><th>Detail</th></tr></thead>
        <tbody>${d.actions.map(a => `<tr><td style="white-space:nowrap">${esc(dt(a.created_at))}</td>
          <td>${esc(ACTION_LABEL[a.action] || a.action)}<div class="muted" style="font-size:12px">${esc(a.admin_email)}</div></td>
          <td class="hide-sm">${a.target_type === 'order' ? `<a href="#" data-order="${esc(a.target_id)}" class="mono">#${esc(short(a.target_id))}</a>` : esc(a.target_type ? a.target_type + ' ' + short(a.target_id) : '')}</td>
          <td>${detail(a)}</td></tr>`).join('')}</tbody>
      </table>${d.actions.length ? '' : '<div class="empty">Nothing yet.</div>'}</div>`;
    view().querySelectorAll('[data-order]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); orderDetail(a.dataset.order); }));
  }

  // ── Router ───────────────────────────────────────────────────
  const ROUTES = { overview: renderOverview, orders: renderOrders, brands: renderBrands, users: renderUsers,
    products: renderProducts, couriers: renderCouriers, activity: renderActivity };
  async function route() {
    const [name, query] = (location.hash.slice(1) || 'overview').split('?');
    const fn = ROUTES[name] || renderOverview;
    document.querySelectorAll('#tabs a').forEach(a => {
      const on = a.dataset.tab === (ROUTES[name] ? name : 'overview');
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    closeDrawerIfOpen();
    $('tip').classList.remove('on');
    try { await fn(new URLSearchParams(query || '')); } catch (e) { fail(e); }
  }
  function closeDrawerIfOpen() { if ($('drawer').classList.contains('open')) { $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); } }
  window.addEventListener('hashchange', route);

  $('logout').addEventListener('click', async () => {
    try { await post('/api/logout'); } catch (e) {}
    location.href = '/login';
  });

  (async () => {
    try {
      STATE.me = await api('/api/me');
      $('who').textContent = STATE.me.email;
      route();
    } catch (e) { /* redirected to login */ }
  })();
})();
