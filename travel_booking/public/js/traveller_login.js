/* ============================================================
   travel_booking/public/js/traveller_login.js
   Login page logic — password, magic link, Google OAuth, forgot pwd.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  /* ── View Switching ── */
  function showView(id) {
    document.querySelectorAll('.tv-view').forEach(function (v) {
      v.classList.remove('on');
    });
    var target = document.getElementById(id);
    if (target) target.classList.add('on');
  }

  function hideAllMsgs() {
    ['login-error', 'magic-error', 'magic-success'].forEach(
      function (id) { hideInlineError(id); }
    );
  }

  /* ── Password Login ── */
  var loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAllMsgs();

      var email = document.getElementById('login-email').value.trim();
      var pwd = document.getElementById('login-password').value;
      var btn = document.getElementById('btn-login');

      if (!email || !pwd) {
        showInlineError('login-error', 'Please enter both email and password.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Signing in...';

      try {
        var r = await fetch('/api/method/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Frappe-CSRF-Token': _csrfToken()
          },
          credentials: 'include',
          body: JSON.stringify({ usr: email, pwd: pwd })
        });

        var d = await r.json().catch(() => ({}));

        if (r.status === 403 || (d._server_messages && !d.message)) {
          // Session/CSRF issue or auth failure
          var msg = '';
          try {
            var raw = d._server_messages || '';
            var p = JSON.parse(raw);
            msg = Array.isArray(p) ? JSON.parse(p[0]).message : raw;
          } catch (e) { msg = d.message || 'Invalid email or password.'; }

          showInlineError('login-error', msg);
          btn.disabled = false;
          btn.textContent = 'Sign In with Password';
          return;
        }

        if (d.home_url || d.message === '/traveller/bookings' || d.message === '/traveller/bookings') {
          // Login successful — redirect to bookings
          window.location.href = '/traveller/bookings';
          return;
        }

        // Check for full session redirect
        if (r.ok && (d.full_name || d.message === 'logged in')) {
          window.location.href = '/traveller/bookings';
          return;
        }

        // Default success redirect
        if (r.ok) {
          window.location.href = '/traveller/bookings';
          return;
        }

        showInlineError('login-error', 'Invalid email or password. Please try again.');

      } catch (err) {
        showInlineError('login-error', 'Connection error. Please check your internet and try again.');
      }

      btn.disabled = false;
      btn.textContent = 'Sign In with Password';
    });
  }

  /* ── Enter key handler on password field ── */
  var pwField = document.getElementById('login-password');
  if (pwField) {
    pwField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (loginForm) loginForm.dispatchEvent(new Event('submit'));
      }
    });
  }

  /* ── Magic Link Toggle & Submit ── */
  var magicToggle = document.getElementById('btn-magic-toggle');
  if (magicToggle) {
    magicToggle.addEventListener('click', function () {
      hideAllMsgs();
      showView('V-magic');
      var emailInput = document.getElementById('magic-email');
      if (emailInput) {
        // Pre-fill from login form if available
        var loginEmail = document.getElementById('login-email');
        if (loginEmail && loginEmail.value.trim()) {
          emailInput.value = loginEmail.value.trim();
        }
        emailInput.focus();
      }
    });
  }

  var magicForm = document.getElementById('magic-form');
  if (magicForm) {
    magicForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAllMsgs();

      var email = document.getElementById('magic-email').value.trim();
      var btn = document.getElementById('btn-magic-send');

      if (!email) {
        showInlineError('magic-error', 'Please enter your email address.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        var result = await API('send_magic_link_by_email', { email: email });
        showInlineError('magic-success', result.message ||
          'If this email is registered, a login link will be sent shortly.');
        btn.textContent = 'Link Sent!';
        btn.disabled = true;

        // Auto-switch back after 3 seconds
        setTimeout(function () {
          showView('V-login');
        }, 3500);

      } catch (err) {
        showInlineError('magic-error', err.message || 'Failed to send link. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Send Login Link';
      }
    });
  }

  /* ── Google OAuth ── */
  var googleBtn = document.getElementById('btn-google');
  if (googleBtn) {
    googleBtn.addEventListener('click', async function () {
      try {
        var url = await API('get_google_login_url', {
          redirect_to: '/traveller/bookings'
        });
        if (url && typeof url === 'string' && url.startsWith('http')) {
          window.location.href = url;
        } else {
          showToast('Google sign-in is not configured.', 'warning');
        }
      } catch (err) {
        showToast('Could not initiate Google sign-in.', 'error');
      }
    });
  }

  /* ── Back to Login Links ── */
  var backToLogin = document.getElementById('link-back-login');
  if (backToLogin) {
    backToLogin.addEventListener('click', function (e) {
      e.preventDefault();
      hideAllMsgs();
      showView('V-login');
    });
  }


  /* ── Check for session expired flag ── */
  try {
    if (sessionStorage.getItem('tv_session_expired')) {
      sessionStorage.removeItem('tv_session_expired');
      context.session_expired = true; // Template already rendered, just visual cue
    }
  } catch (e) {}

})();
