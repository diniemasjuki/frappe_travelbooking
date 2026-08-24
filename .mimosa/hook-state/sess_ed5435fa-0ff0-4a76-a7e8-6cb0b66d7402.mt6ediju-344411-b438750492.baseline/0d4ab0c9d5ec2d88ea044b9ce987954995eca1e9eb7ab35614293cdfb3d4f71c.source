/* ============================================================
   travel_booking/public/js/portal_login.js
   Page: /traveller_portal (index) — login, magic link, forgot password.
   Bergantung pada portal_common.js (dimuatkan dahulu).
   ============================================================ */

'use strict';

/* Toggle antara kad login / magic / forgot dalam page ni sahaja. */
function showAuthView(id) {
  ['V-login', 'V-magic', 'V-forgot'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle('on', v === id);
  });
  window.scrollTo(0, 0);
}

function showLoginError(msg) {
  showInlineError('login-error', msg);
  document.getElementById('login-error-msg').textContent = msg;
  document.getElementById('login-error').style.display = 'block';
}
function hideLoginError() {
  hideInlineError('login-error');
}

/* Google — dengan double-submit guard (fix audit: butang boleh double-click
   sebelum ni, dua auth URL request di-fire). */
async function signInWithGoogle() {
  hideLoginError();
  const btn = document.getElementById('google-signin-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const authUrl = await API('get_google_login_url', { redirect_to: '/traveller_portal/bookings' });
    window.location.href = authUrl;
  } catch (e) {
    showLoginError((e && e.message) || 'Could not start Google sign-in. Please try again.');
    btn.disabled = false;
  }
}

async function doLogin() {
  hideLoginError();
  const email = (document.getElementById('login-em').value || '').trim();
  const password = document.getElementById('login-pw').value || '';
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include',
      body: formData
    });
    if (!loginRes.ok) throw new Error('Invalid email or password.');
    window.location.href = '/traveller_portal/bookings';
  } catch (e) {
    const msg = e.message || '';
    showLoginError(msg.includes('Invalid') || msg.includes('invalid')
      ? 'Invalid email or password. Please try again.'
      : msg || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Sign in →';
    btn.disabled = false;
  }
}

/* Forgot — inline error ganti alert() (fix audit: satu-satunya flow yang
   masih guna alert untuk validation). */
async function doForgotPassword() {
  hideInlineError('forgot-error');
  const email = (document.getElementById('forgot-em').value || '').trim();
  if (!email) { showInlineError('forgot-error', 'Please enter your email address.'); return; }
  const btn = document.getElementById('forgot-btn');
  btn.textContent = 'Sending...';
  btn.disabled = true;
  try {
    await API('forgot_password', { email });
    document.getElementById('forgot-success').style.display = 'block';
    btn.style.display = 'none';
  } catch (e) {
    showInlineError('forgot-error', e.message || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Send reset link →';
    btn.disabled = false;
  }
}

async function doMagicLink() {
  const email = (document.getElementById('magic-em').value || '').trim();
  if (!email) { showMagicError('Please enter your email address.'); return; }

  const btn = document.getElementById('magic-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const r = await API('send_magic_link_by_email', { email });
    document.getElementById('magic-success-msg').textContent =
      r.message || 'Link sent. Check your email (and your spam folder if you don\'t see it).';
    document.getElementById('magic-success').style.display = 'block';
    document.getElementById('magic-error').style.display = 'none';
    document.getElementById('magic-em').value = '';
  } catch (e) {
    showMagicError(e.message || 'An error occurred. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send login link';
  }
}

function showMagicError(msg) {
  document.getElementById('magic-error-msg').textContent = msg;
  document.getElementById('magic-error').style.display = 'block';
  document.getElementById('magic-success').style.display = 'none';
}

/* ── Init: mesej session-expired (flag dari portal_common 403 handler) ── */
document.addEventListener('DOMContentLoaded', () => {
  const expiredFlag = sessionStorage.getItem('rc_session_expired');
  if (expiredFlag) {
    sessionStorage.removeItem('rc_session_expired');
    _CACHE.del('session');
    showLoginError('Your session has expired. Please sign in again to continue.');
  }
});
