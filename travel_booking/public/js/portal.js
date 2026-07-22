/* ============================================================
   travel_booking/public/js/portal.js
   Entry point — State, Cache, API helpers, Nav, Auth, Init
   ============================================================ */

'use strict';

/* ── Global State ── */
let SESSION     = null;
let BOOKING     = null;
let PORTAL_DATA = null;
let ACTIVE_SLOT = null;
let _passportFile = null;
let _visaPhotoFile = null;

/* ── Cache (sessionStorage + TTL) ── */
const _CACHE = {
  TTL: { session: 10 * 60 * 1000, booking: 5 * 60 * 1000, payments: 5 * 60 * 1000 },
  get(key) {
    try {
      const raw = sessionStorage.getItem('rc_' + key);
      if (!raw) return null;
      const { ts, data, ttl } = JSON.parse(raw);
      if (Date.now() - ts > ttl) { sessionStorage.removeItem('rc_' + key); return null; }
      return data;
    } catch { return null; }
  },
  set(key, data, ttl) {
    try { sessionStorage.setItem('rc_' + key, JSON.stringify({ ts: Date.now(), data, ttl })); } catch {}
  },
  del(key)  { try { sessionStorage.removeItem('rc_' + key); } catch {} },
  clear()   { try { Object.keys(sessionStorage).filter(k => k.startsWith('rc_')).forEach(k => sessionStorage.removeItem(k)); } catch {} }
};

/* ── API helpers ── */
const _csrfToken = () => 'fetch';

const _post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
    credentials: 'include',
    body: JSON.stringify(body)
  }).then(async r => {
    const d = await r.json();
    if (!r.ok || d.exc) {
      const raw = d._server_messages || d.exc || '';
      let msg = raw;
      try {
        const p = JSON.parse(raw);
        msg = Array.isArray(p) ? JSON.parse(p[0]).message : p.message || raw;
      } catch {}
      throw new Error(msg || 'Ralat berlaku.');
    }
    return d.message;
  });

const API    = (method, params = {}) => _post(`/api/method/travel_booking.api.portal_auth.${method}`, params);
const API_BK = (method, params = {}) => _post(`/api/method/travel_booking.api.portal_booking.${method}`, params);
const API_PM = (method, params = {}) => _post(`/api/method/travel_booking.api.portal_payment.${method}`, params);
const API_TV = (method, params = {}) => _post(`/api/method/travel_booking.api.portal_traveller.${method}`, params);

/* ── Screen switch ── */
function sw(id) {
  document.querySelectorAll('.sc').forEach(s => s.classList.remove('on'));
  const el = document.getElementById(id);
  if (el) el.classList.add('on');
  window.scrollTo(0, 0);
}

/* ── Nav ── */
function renderNav() {
  if (!SESSION) return;
  const initials = SESSION.customer_name.split(' ').slice(0, 2).map(w => w[0]).join('');
  ['nav-customer-name', 'portal-nav-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = SESSION.customer_name;
  });
  ['nav-avatar', 'portal-nav-av'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = initials;
  });
}

/* ── Auth ── */
function showLoginError(msg) {
  document.getElementById('login-error-msg').textContent = msg;
  document.getElementById('login-error').style.display = 'block';
}
function hideLoginError() {
  document.getElementById('login-error').style.display = 'none';
}

async function doLogin() {
  hideLoginError();
  const email    = document.getElementById('login-em').value.trim();
  const password = document.getElementById('login-pw').value;
  if (!email || !password) { showLoginError('Please enter your email and password.'); return; }

  const btn = document.getElementById('login-btn');
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    const formData = new URLSearchParams();
    formData.append('usr', email);
    formData.append('pwd', password);
    const loginRes = await fetch('/api/method/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Frappe-CSRF-Token': 'fetch' },
      credentials: 'include',
      body: formData
    });
    if (!loginRes.ok) throw new Error('Email atau password tidak sah.');
    window.location.reload();
  } catch (e) {
    const msg = e.message || '';
    showLoginError(msg.includes('tidak sah') || msg.includes('Invalid')
      ? 'Invalid email or password. Please try again.'
      : msg || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Sign in →';
    btn.disabled = false;
  }
}

async function doForgotPassword() {
  const email = document.getElementById('forgot-em').value.trim();
  if (!email) { alert('Sila masukkan email anda.'); return; }
  const btn = document.getElementById('forgot-btn');
  btn.textContent = 'Sending...';
  btn.disabled = true;
  try {
    await API('forgot_password', { email });
    document.getElementById('forgot-success').style.display = 'block';
    btn.style.display = 'none';
  } catch (e) {
    alert(e.message || 'An error occurred.');
  } finally {
    btn.textContent = 'Send reset link →';
    btn.disabled = false;
  }
}

async function doLogout() {
  try {
    await fetch('/api/method/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': 'fetch' },
      credentials: 'include'
    });
  } catch {}
  SESSION = null; BOOKING = null; PORTAL_DATA = null;
  _CACHE.clear();
  sw('S-login');
}

/* ── Payment result (selepas redirect balik dari Stripe checkout) ──
   checkout.html hantar customer balik ke /traveller_portal?paid=1, dan
   Stripe.js SENDIRI tambah payment_intent + payment_intent_client_secret +
   redirect_status pada URL tu. Kita detect param ni SEBELUM masuk S-select,
   papar screen status (Success/Failed/Processing), verify dgn backend guna
   payment_intent id (bukan sekadar percaya redirect_status string dalam
   URL — Stripe sendiri tak jamin param tu rasmi/tak boleh dipalsukan). */
async function _checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const paymentIntentId = params.get('payment_intent');
  if (!paymentIntentId) return false;

  // Buang query params dari address bar (elak re-trigger bila refresh/back).
  window.history.replaceState({}, document.title, window.location.pathname);

  sw('S-payment-result');
  document.getElementById('pr-result-body').innerHTML =
    '<div class="pr-spinner"></div>' +
    '<div class="pr-title">Confirming your payment</div>' +
    '<div class="pr-sub">This usually takes a few seconds. Please don\'t close this page.</div>';

  try {
    // PENTING: get_payment_result() berada di api/stripe_checkout.py,
    // BUKAN api/portal_payment.py — panggil terus path penuh (bukan
    // API_PM, yang akan salah rujuk module dan sentiasa gagal dengan 404,
    // tak kira bayaran sebenar berjaya/gagal).
    const result = await _post(
      "/api/method/travel_booking.api.stripe_checkout.get_payment_result",
      { payment_intent: paymentIntentId }
    );
    renderPaymentResult(result);
  } catch (e) {
    renderPaymentResult({ status: 'unknown' });
  }
  return true;
}

function renderPaymentResult(result) {
  const body = document.getElementById('pr-result-body');
  const fmt  = n => parseFloat(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2 });

  if (result.status === 'succeeded') {
    body.innerHTML = `
      <div class="pr-icon pr-icon-success">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0F6E56" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </div>
      <div class="pr-title">Payment successful</div>
      <div class="pr-sub">Your payment has been received and confirmed.</div>
      <div class="pr-details">
        <div class="pr-row"><span>Amount paid</span><strong>${result.currency || 'MYR'} ${fmt(result.amount)}</strong></div>
        ${result.trip_label ? `<div class="pr-row"><span>Trip</span><strong>${result.trip_label}</strong></div>` : ''}
        ${result.sales_order ? `<div class="pr-row"><span>Sales order</span><strong style="font-family:monospace">${result.sales_order}</strong></div>` : ''}
      </div>
      <button class="btn btn-p btn-full" onclick="_returnToBookingsFromPaymentResult()">Back to my bookings</button>`;
  } else if (result.status === 'processing') {
    body.innerHTML = `
      <div class="pr-spinner"></div>
      <div class="pr-title">Payment processing</div>
      <div class="pr-sub">We'll update your booking as soon as this clears — usually within a few minutes. You'll also get an email confirmation.</div>
      <button class="btn btn-p btn-full" onclick="_returnToBookingsFromPaymentResult()">Back to my bookings</button>`;
  } else if (result.status === 'failed') {
    body.innerHTML = `
      <div class="pr-icon pr-icon-failed">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#991B1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </div>
      <div class="pr-title">Payment failed</div>
      <div class="pr-sub">${result.last_error || 'Your card was declined.'} No amount has been charged — you can try again.</div>
      <div class="pr-btn-row">
        <button class="btn btn-g" onclick="_returnToBookingsFromPaymentResult()">Back to bookings</button>
        <button class="btn btn-p" onclick="_returnToBookingsFromPaymentResult()">Try again</button>
      </div>`;
  } else {
    body.innerHTML = `
      <div class="pr-icon pr-icon-failed">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#991B1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="pr-title">Couldn't confirm payment status</div>
      <div class="pr-sub">Please check the Transactions tab, or contact us if you're unsure whether your payment went through.</div>
      <button class="btn btn-p btn-full" onclick="_returnToBookingsFromPaymentResult()">Back to my bookings</button>`;
  }
}

function _returnToBookingsFromPaymentResult() {
  _CACHE.del('payments');
  _allOrders = [];
  if (SESSION) {
    renderNav();
    renderBookingList();
    sw('S-select');
  } else {
    sw('S-login');
  }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  const cameFromPayment = await _checkPaymentReturn();

  try {
    const cachedSession = _CACHE.get('session');
    if (cachedSession) {
      SESSION = cachedSession;
      renderNav();
      renderBookingList();
      if (!cameFromPayment) sw('S-select');
      // Silent background refresh
      fetch('/api/method/travel_booking.api.portal_auth.check_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': 'fetch' },
        credentials: 'include',
        body: JSON.stringify({})
      }).then(r => r.json()).then(data => {
        if (data.message && data.message.logged_in) {
          SESSION = data.message;
          _CACHE.set('session', SESSION, _CACHE.TTL.session);
          renderBookingList();
        }
      }).catch(() => {});
      return;
    }

    const res  = await fetch('/api/method/travel_booking.api.portal_auth.check_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': 'fetch' },
      credentials: 'include',
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (data.message && data.message.logged_in) {
      SESSION = data.message;
      _CACHE.set('session', SESSION, _CACHE.TTL.session);
      renderNav();
      renderBookingList();
      if (!cameFromPayment) sw('S-select');
      return;
    }
  } catch {}
  if (!cameFromPayment) sw('S-login');
});

async function doMagicLink() {
  const email = (document.getElementById('magic-em').value || '').trim();
  if (!email) { showMagicError('Sila masukkan alamat email.'); return; }

  const btn = document.getElementById('magic-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const r = await API('send_magic_link_by_email', { email });
    document.getElementById('magic-success-msg').textContent =
      r.message || 'Link dihantar. Semak email anda.';
    document.getElementById('magic-success').style.display = 'block';
    document.getElementById('magic-error').style.display   = 'none';
    document.getElementById('magic-em').value = '';
  } catch(e) {
    showMagicError(e.message || 'Ralat. Sila cuba semula.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send login link';
  }
}

function showMagicError(msg) {
  document.getElementById('magic-error-msg').textContent = msg;
  document.getElementById('magic-error').style.display   = 'block';
  document.getElementById('magic-success').style.display = 'none';
}