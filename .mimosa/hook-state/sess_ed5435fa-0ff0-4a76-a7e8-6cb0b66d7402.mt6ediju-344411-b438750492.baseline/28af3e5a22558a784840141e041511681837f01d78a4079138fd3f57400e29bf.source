/* ============================================================
   travel_booking/public/js/portal_common.js
   Shared helpers untuk SEMUA page /traveller_portal/* (multi-page).
   - API fetch + CSRF + session-expiry handling
   - _esc()  — HTML escaping (FIX XSS: data server tak boleh terus
     interpolate ke innerHTML tanpa escape)
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

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ISO date "2026-09-03" → "3 Sep 2026" (selamat untuk timezone — parse
   komponen, bukan new Date(string) yang boleh geser sehari ikut TZ). */
function fmtDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return parseInt(m[3], 10) + ' ' + _MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
}

/* ── SessionStorage cache (profil sahaja — data booking/payment sentiasa fresh) ── */
const _CACHE = {
  TTL: { session: 10 * 60 * 1000 },
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
  del(key) { try { sessionStorage.removeItem('rc_' + key); } catch {} },
  clear() {
    try {
      Object.keys(sessionStorage).filter(k => k.startsWith('rc_'))
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

    // Session/CSRF tamat → refresh page sekali (server embed token baharu +
    // guard redirect ke login bila perlu). Flag rc_session_expired supaya
    // login page papar sebab ("session expired"), bukan login kosong.
    if (r.status === 403) {
      const txt = (d && (d.message || (d._server_messages && JSON.stringify(d._server_messages)))) || '';
      if (/csrf|token|session|expired|invalid request/i.test(txt) || !txt) {
        _CACHE.del('session');
        try { sessionStorage.setItem('rc_session_expired', '1'); } catch {}
        if (!sessionStorage.getItem('rc_csrf_reload')) {
          sessionStorage.setItem('rc_csrf_reload', '1');
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
    sessionStorage.removeItem('rc_csrf_reload');
    return d.message;
  });

const _get = (path) =>
  fetch(path, { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      if (d && d.exc) throw new Error('Request failed.');
      return d.message;
    });

/* ── Endpoint namespaces ── */
const API    = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_auth.${m}`, p);
const API_BK = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_booking.${m}`, p);
const API_PM = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_payment.${m}`, p);
const API_TV = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_traveller.${m}`, p);
const API_PF = (m, p = {}) => _post(`/api/method/travel_booking.api.portal_profile.${m}`, p);
const API_STRIPE = (m, p = {}) => _post(`/api/method/travel_booking.api.stripe_checkout.${m}`, p);

/* ── Session ── */
let SESSION = null;

/* Fetch + verify session sekali per page. Pulangkan session object atau
   null (guest). Page guard server-side dah redirect Guest sebelum render,
   jadi null di sini bermaksud session baru sahaja tamat antara render dan
   fetch — arahkan ke login secara lembut. */
async function ensureSession() {
  if (SESSION) return SESSION;
  try {
    const s = await API('check_session', {});
    if (s && s.logged_in && s.status === 'ok') {
      SESSION = s;
      _CACHE.set('session', s, _CACHE.TTL.session);
      return s;
    }
    if (s && s.status === 'no_customer_link') {
      window.location.href = '/traveller_portal';
      return null;
    }
  } catch (e) {
    const cached = _CACHE.get('session');
    if (cached && cached.status === 'ok') { SESSION = cached; return cached; }
  }
  window.location.href = '/traveller_portal';
  return null;
}

/* ── Nav (setiap page ada elemen ber-id ni dalam include portal_nav) ── */
function renderNav() {
  if (!SESSION) return;
  const name = SESSION.customer_name || '';
  const initials = name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  ['nav-customer-name', 'portal-nav-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = name;
  });
  ['nav-avatar', 'portal-nav-av'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = initials;
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
  window.location.href = '/traveller_portal';
}

/* ── Utility: inline error box helper ──
   Ganti alert() untuk semua feedback. Elemen sasaran mesti wujud;
   role="alert" supaya screen reader announce. */
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
