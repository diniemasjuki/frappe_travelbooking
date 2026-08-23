/* ============================================================
   travel_booking/public/js/traveller_common.js
   Shared helpers untuk SEMUA page /traveller/* (multi-page).
   - API fetch + CSRF + session-expiry handling
   - _esc()  — HTML escaping (XSS prevention)
   - fmt()   — currency (en-MY, 2dp)
   - fmtDate() — ISO "2026-09-03" → "3 Sep 2026"
   - ensureSession() — fetch/verify session sekali per page
   - Nav render + logout
   Dipasang pada setiap page SEBELUM page-specific JS.
   ============================================================ */

'use strict';

/* ── pageData (CSRF dari server) ── */
const _pageData = (function () {
  try {
    var el = document.getElementById('pageData');
    return el ? JSON.parse(el.textContent) : {};
  } catch (e) { return {}; }
})();

/* booking_ref fallback — baca terus dari URL (?ref=...) */
if (!_pageData.booking_ref) {
  try {
    _pageData.booking_ref = new URLSearchParams(window.location.search).get('ref') || '';
  } catch (e) { _pageData.booking_ref = ''; }
}

const CSRF_TOKEN = _pageData.csrf_token || '';
const _csrfToken = () => CSRF_TOKEN || (document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '');

/* ── HTML escape — WAJIB untuk semua nilai dari server/user ── */
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/* ── Format helpers ── */
const fmt = (n) => parseFloat(n || 0).toLocaleString('en-MY', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

/* ── Display currency converter (portal-wide) ── */
const RC = (function () {
  let companyCurrency = 'MYR', companySymbol = 'RM';
  try {
    const el = document.getElementById('rcCurrencyData');
    if (el) {
      const d = JSON.parse(el.textContent);
      companyCurrency = d.company_currency || 'MYR';
      companySymbol = d.company_symbol || companyCurrency;
    }
  } catch {}
  let displayCurrency = null, displaySymbol = null, displayRate = null;
  try {
    const raw = localStorage.getItem('rc_display_currency');
    if (raw) {
      const c = JSON.parse(raw);
      if (c && c.currency && c.currency !== companyCurrency && c.rate) {
        displayCurrency = c.currency;
        displaySymbol = c.symbol || c.currency;
        displayRate = Number(c.rate);
      }
    }
  } catch {}
  return { company_currency: companyCurrency, company_symbol: companySymbol,
           display_currency: displayCurrency, display_symbol: displaySymbol,
           display_rate: displayRate };
})();

function fmtDual(amount, companySym) {
  const n = fmt(amount);
  const sym = _esc(companySym || RC.company_symbol || 'RM');
  const base = sym + ' ' + n;
  if (RC.display_currency && RC.display_currency !== RC.company_currency && RC.display_rate) {
    const conv = fmt(parseFloat(amount || 0) * RC.display_rate);
    return _esc(RC.display_symbol || RC.display_currency) + ' ' + conv + ' (' + base + ')';
  }
  return base;
}

async function initTravellerCurrencyConverter() {
  const sel = document.getElementById('tvCurrencySelect');
  if (!sel) return;
  let list = [];
  try {
    list = await _get('/api/method/travel_booking.api.pricing.get_display_currencies');
  } catch {}
  sel.innerHTML = '';
  if (!list || !list.length) {
    const o = document.createElement('option');
    o.value = RC.company_currency; o.textContent = RC.company_currency;
    sel.appendChild(o); sel.disabled = true;
    return;
  }
  list.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.code;
    o.textContent = c.code + (c.is_company ? ' \u2014 charged' : '');
    sel.appendChild(o);
  });
  sel.value = RC.display_currency || RC.company_currency;
  sel.addEventListener('change', async function () {
    const code = this.value;
    if (!code || code === RC.company_currency) {
      RC.display_currency = null; RC.display_symbol = null; RC.display_rate = null;
      try { localStorage.removeItem('rc_display_currency'); } catch {}
      _tvCurrencyRefresh();
      return;
    }
    try {
      const r = await _get('/api/method/travel_booking.api.pricing.get_currency_rate?from_currency='
        + encodeURIComponent(RC.company_currency) + '&to_currency=' + encodeURIComponent(code));
      const rate = (r && r.rate) ? Number(r.rate) : null;
      const sym = (list.find((c) => c.code === code) || {}).symbol || code;
      RC.display_currency = code; RC.display_symbol = sym; RC.display_rate = rate;
      try { localStorage.setItem('rc_display_currency', JSON.stringify({ currency: code, symbol: sym, rate })); } catch {}
    } catch {
      RC.display_rate = null;
    }
    _tvCurrencyRefresh();
  });
}

function _tvCurrencyRefresh() {
  if (typeof window.tvRefreshCurrency === 'function') {
    try { window.tvRefreshCurrency(); return; } catch {}
  }
  window.location.reload();
}

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ISO date "2026-09-03" → "3 Sep 2026" (timezone-safe) */
function fmtDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return parseInt(m[3], 10) + ' ' + _MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
}

/* ── SessionStorage cache ── */
const _CACHE = {
  TTL: { session: 10 * 60 * 1000 },
  get(key) {
    try {
      const raw = sessionStorage.getItem('tv_' + key);
      if (!raw) return null;
      const { ts, data, ttl } = JSON.parse(raw);
      if (Date.now() - ts > ttl) { sessionStorage.removeItem('tv_' + key); return null; }
      return data;
    } catch { return null; }
  },
  set(key, data, ttl) {
    try { sessionStorage.setItem('tv_' + key, JSON.stringify({ ts: Date.now(), data, ttl })); } catch {}
  },
  del(key) { try { sessionStorage.removeItem('tv_' + key); } catch {} },
  clear() {
    try {
      Object.keys(sessionStorage).filter(k => k.startsWith('tv_'))
        .forEach(k => sessionStorage.removeItem(k));
    } catch {}
  }
};

/* ── POST helper (CSRF + error unwrap + session-expiry reload) ── */
const _post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
    credentials: 'include',
    body: JSON.stringify(body)
  }).then(async r => {
    const d = await r.json().catch(() => ({}));

    /* Session/CSRF tamat → refresh page sekali */
    if (r.status === 403) {
      const txt = (d && (d.message || (d._server_messages && JSON.stringify(d._server_messages)))) || '';
      if (/csrf|token|session|expired|invalid request/i.test(txt) || !txt) {
        _CACHE.del('session');
        try { sessionStorage.setItem('tv_session_expired', '1'); } catch {}
        if (!sessionStorage.getItem('tv_csrf_reload')) {
          sessionStorage.setItem('tv_csrf_reload', '1');
          window.location.reload();
          return new Promise(() => {});
        }
      }
    }

    if (!r.ok || d.exc) {
      const raw = d._server_messages || d.exc || '';
      let msg = raw;
      try {
        const p = JSON.parse(raw);
        msg = Array.isArray(p) ? JSON.parse(p[0]).message : p.message || raw;
      } catch {}
      throw new Error(msg || 'An error occurred.');
    }
    sessionStorage.removeItem('tv_csrf_reload');
    return d.message;
  });

const _get = (path) =>
  fetch(path, { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      if (d && d.exc) throw new Error('Request failed.');
      return d.message;
    });

/* ── Endpoint namespaces (same APIs as old portal) ── */
const API    = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_auth.${m}`, p);
const API_BK = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_booking.${m}`, p);
const API_PM = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_payment.${m}`, p);
const API_TV = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_traveller.${m}`, p);
const API_PF = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_profile.${m}`, p);
const API_STRIPE = (m, p = {}) => _post(`/api/method/travel_booking.api.stripe_checkout.${m}`, p);
const API_ADDON = (m, p = {}) => _post(`/api/method/travel_booking.api.addon_manager.${m}`, p);

/* ── Session ── */
let SESSION = null;

async function ensureSession() {
  if (SESSION) return SESSION;
  try {
    const s = await API('check_session', {});
    if (s && s.logged_in && s.status === 'ok') {
      SESSION = s;
      _CACHE.set('session', s, _CACHE.TTL.session);
      return s;
    }
    if (s && s.status === 'under_review') {
      window.location.href = '/traveller';
      return null;
    }
  } catch (e) {
    const cached = _CACHE.get('session');
    if (cached && cached.status === 'ok') { SESSION = cached; return cached; }
  }
  window.location.href = '/traveller';
  return null;
}

/* ── Nav render ── */
function renderNav() {
  if (!SESSION) return;
  const name = SESSION.customer_name || '';
  const email = SESSION.email || '';
  const img = SESSION.user_image || '';
  const initials = name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

  /* Avatar: user photo (background-image) if available, else initials */
  ['tv-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (img) {
      el.textContent = '';
      el.style.backgroundImage = 'url("' + _esc(img) + '")';
    } else {
      el.textContent = initials;
      el.style.backgroundImage = '';
    }
  });

  /* Dropdown header: name + email */
  const nameEl = document.getElementById('tv-menu-name');
  if (nameEl) nameEl.textContent = name || '—';
  const emailEl = document.getElementById('tv-menu-email');
  if (emailEl) emailEl.textContent = email || '—';

  _wireUserMenu();
}

/* ── User menu dropdown toggle ── */
function _wireUserMenu() {
  const trigger = document.getElementById('tv-user-trigger');
  const menu = document.getElementById('tv-user-menu');
  if (!trigger || !menu || trigger._tvWired) return;
  trigger._tvWired = true;

  function close() {
    menu.setAttribute('hidden', '');
    trigger.setAttribute('aria-expanded', 'false');
  }
  function open() {
    menu.removeAttribute('hidden');
    trigger.setAttribute('aria-expanded', 'true');
  }

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.hasAttribute('hidden')) open(); else close();
  });

  document.addEventListener('click', function (e) {
    if (menu.hasAttribute('hidden')) return;
    if (!menu.contains(e.target) && !trigger.contains(e.target)) close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hasAttribute('hidden')) {
      close();
      trigger.focus();
    }
  });
}

async function doLogout() {
  try {
    await fetch('/api/method/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include'
    });
  } catch {}
  _CACHE.clear();
  window.location.href = '/traveller';
}

/* ── Utility: inline error box helper ── */
function showInlineError(boxId, msg) {
  const box = document.getElementById(boxId);
  if (!box) { console.error(msg); return; }
  box.textContent = msg;
  box.style.display = 'block';
}
function hideInlineError(boxId) {
  const box = document.getElementById(boxId);
  if (box) box.style.display = 'none';
}

/* ── Toast notification system ── */
function showToast(message, type = 'info') {
  let container = document.getElementById('tv-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'tv-toast-container';
    container.style.cssText =
      'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const colors = {
    success: '#10B981',
    error: '#EF4444',
    warning: '#F59E0B',
    info: '#3B82F6'
  };

  toast.style.cssText =
    `padding:14px 20px;border-radius:10px;background:${colors[type]||colors.info};color:#fff;` +
    'font-family:"Jost",sans-serif;font-size:14px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.12);' +
    'animation:fadeIn .3s ease forwards;max-width:360px;';

  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all .3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ── Countdown helper ── */
function getCountdown(departureDate) {
  if (!departureDate) return null;
  const dep = new Date(departureDate + 'T00:00:00');
  const now = new Date();
  now.setHours(0,0,0,0);
  const diff = Math.ceil((dep - now) / (1000 * 60 * 60 * 24));
  if (diff <= 0) return null;
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return `${diff} days`;
  if (diff < 30) return `${Math.floor(diff / 7)} week${diff >= 14 ? 's' : ''}`;
  return `${Math.floor(diff / 30)} month${diff >= 60 ? 's' : ''}`;
}

/* ── Status badge helper ── */
function statusBadge(status, type = 'booking') {
  const map = {
    booking: {
      'Pending': 'neutral',
      'Accepted': 'gold',
      'Processing': 'info',
      'Confirmed': 'success',
      'Completed': 'success',
      'Cancelled': 'danger',
      'Abandoned': 'neutral'
    },
    payment: {
      'Pending': 'warning',
      'Partially Paid': 'warning',
      'Paid': 'success',
      'Request Refund': 'danger',
      'Pending Refund': 'warning',
      'Refunded': 'info'
    },
    tx: {
      'Verified': 'success',
      'Pending': 'warning',
      'Cancelled': 'danger'
    }
  };
  const cls = (map[type] || {})[status] || 'neutral';
  return `<span class="tv-badge tv-badge--${cls}">${_esc(status)}</span>`;
}

/* ── Auto-init currency converter ── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTravellerCurrencyConverter);
} else {
  initTravellerCurrencyConverter();
}
