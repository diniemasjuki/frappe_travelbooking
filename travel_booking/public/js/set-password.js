/* ============================================================
   travel_booking/public/js/set-password.js
   Set Password page — first time setup + forgot password reset
   ============================================================ */

'use strict';

/* ── CSRF Token ── */
let _csrfToken = null;

async function initCsrfToken() {
  try {
    await fetch('/api/method/frappe.auth.get_logged_user', { credentials: 'include' });
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    _csrfToken = match ? match[1] : 'fetch';
  } catch {
    _csrfToken = 'fetch';
  }
}

function getCsrfToken() {
  return _csrfToken || 'fetch';
}

const API = (method, params = {}) =>
  fetch(`/api/method/travel_booking.api.portal_auth.${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': getCsrfToken()
    },
    credentials: 'include',
    body: JSON.stringify(params)
  }).then(async r => {
    const d = await r.json();
    if (!r.ok || d.exc) {
      const raw = d._server_messages || d.exc || '';
      let msg = raw;
      try {
        const parsed = JSON.parse(raw);
        msg = Array.isArray(parsed)
          ? JSON.parse(parsed[0]).message
          : parsed.message || raw;
      } catch {}
      throw new Error(msg || 'Ralat berlaku.');
    }
    return d.message;
  });

/* ── Helpers ── */
function showError(msg) {
  document.getElementById('setpw-error-msg').textContent = msg;
  document.getElementById('setpw-error').style.display = 'block';
  document.getElementById('setpw-success').style.display = 'none';
}

function showSuccess() {
  document.getElementById('setpw-error').style.display = 'none';
  document.getElementById('setpw-success').style.display = 'block';
  document.getElementById('setpw-form').style.display = 'none';
  document.getElementById('setpw-footer').style.display = 'none';
}

function showInvalid() {
  document.getElementById('setpw-form').style.display = 'none';
  document.getElementById('setpw-invalid').style.display = 'block';
  document.getElementById('setpw-footer').style.display = 'none';
  document.getElementById('title-first').style.display = 'none';
  document.getElementById('title-reset').style.display = 'none';
}

/* ── Set Password ── */
async function doSetPassword() {
  const params = new URLSearchParams(window.location.search);
  const key    = params.get('key');
  const email  = params.get('email');
  const pw     = document.getElementById('pw-new').value;
  const pwConf = document.getElementById('pw-confirm').value;

  if (!key || !email) {
    showInvalid();
    return;
  }
  if (!pw || !pwConf) {
    showError('Please fill in both password fields.');
    return;
  }
  if (pw.length < 8) {
    showError('Password must be at least 8 characters.');
    return;
  }
  if (pw !== pwConf) {
    showError('Passwords do not match. Please try again.');
    return;
  }

  const btn = document.getElementById('setpw-btn');
  btn.textContent = 'Saving...';
  btn.disabled    = true;

  try {
    await API('set_password', { key, email, new_password: pw });
    showSuccess();
    setTimeout(() => { window.location.href = '/traveller_portal'; }, 2000);
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('expired') || msg.includes('invalid') || msg.includes('Invalid')) {
      showInvalid();
    } else {
      showError(msg || 'An error occurred. Please try again.');
    }
    btn.textContent = 'Set password →';
    btn.disabled    = false;
  }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  await initCsrfToken();

  const params = new URLSearchParams(window.location.search);
  const key    = params.get('key');
  const mode   = params.get('mode');

  if (!key) {
    showInvalid();
    return;
  }

  if (mode === 'reset') {
    document.getElementById('title-first').style.display = 'none';
    document.getElementById('title-reset').style.display = 'block';
  }
});