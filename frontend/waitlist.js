(function () {
  'use strict';
  // Publishable (anon) key — public by design; same as merchmarket.js. Access is limited by RLS (insert-only).
  var SUPABASE_URL = 'https://omyzcnizwxumvookotsy.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_2Dvox3zHhG4WG7An-sn0tQ_eZ9z6xh8';

  var form = document.getElementById('waitlist-form');
  var msg = document.getElementById('wl-msg');
  var btn = document.getElementById('wl-submit');
  var success = document.getElementById('wl-success');
  var brandGroup = document.getElementById('brand-group');
  var vendorLink = document.getElementById('wl-vendor-link');
  var db = (window.supabase && window.supabase.createClient) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  // ?src=ambassador-name lets you see which ambassador/agent drove a signup
  var src = (new URLSearchParams(location.search).get('src') || '').replace(/[^\w.-]/g, '').slice(0, 40) || null;

  function role() { return form.querySelector('input[name="role"]:checked').value; }
  function say(text, isError) { msg.textContent = text; msg.className = 'form-msg' + (isError ? ' error' : ''); }
  function done() {
    var isVendor = role() === 'vendor';
    form.hidden = true;
    vendorLink.hidden = !isVendor;
    success.hidden = false;
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'role') brandGroup.hidden = role() !== 'vendor';
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (form.company.value) { done(); return; } // honeypot: pretend success to bots
    var name = form.name.value.trim();
    var email = form.email.value.trim().toLowerCase();
    var phone = form.phone.value.trim();
    var brand = form.brand_name.value.trim();

    if (name.length < 2) return say('Please enter your name.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('Please enter a valid email address.', true);
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return say('Please enter a valid phone number or leave it blank.', true);
    if (!db) return say('Something went wrong loading the page. Please refresh and try again.', true);

    btn.disabled = true; say('Adding you to the list…');
    var row = { role: role(), name: name, email: email, phone: phone || null, source: src,
                brand_name: role() === 'vendor' && brand ? brand : null };
    var res = await db.from('waitlist').insert(row);

    btn.disabled = false;
    // 23505 = already signed up: show success anyway so the list can't be probed for emails
    if (!res.error || res.error.code === '23505') { say(''); done(); return; }
    say('Could not join right now. Please try again in a moment.', true);
  });
})();
