/* ============================================================
   travel_booking/public/js/traveller_profile.js
   Profile page — account info, phone update, password change,
   PDPA data rights.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  /* ── Init ── */
  async function init() {
    try {
      await ensureSession();
      renderNav();
      await loadProfile();
    } catch (e) {
      console.error('Failed to load profile:', e);
    }
  }

  /* ── Currency list cache (populated once per page load) ── */
  var _currencyList = null;

  async function _loadCurrencyList() {
    if (_currencyList) return _currencyList;
    try {
      _currencyList = await _get(
        '/api/method/travel_booking.api.pricing.get_display_currencies'
      );
    } catch {
      _currencyList = [];
    }
    return _currencyList || [];
  }

  /* ── Sync converter (RC + localStorage + nav select) to a target currency ── */
  async function _syncConverterTo(currency) {
    var code = currency || '';
    var company = RC.company_currency;

    if (!code || code === company) {
      RC.display_currency = null;
      RC.display_symbol = null;
      RC.display_rate = null;
      try { localStorage.removeItem('rc_display_currency'); } catch {}
    } else {
      try {
        var r = await _get(
          '/api/method/travel_booking.api.pricing.get_currency_rate?from_currency='
          + encodeURIComponent(company) + '&to_currency=' + encodeURIComponent(code)
        );
        var rate = (r && r.rate) ? Number(r.rate) : null;
        var list = await _loadCurrencyList();
        var sym = (list.find(function (c) { return c.code === code; }) || {}).symbol || code;
        RC.display_currency = code;
        RC.display_symbol = sym;
        RC.display_rate = rate;
        try {
          localStorage.setItem('rc_display_currency',
            JSON.stringify({ currency: code, symbol: sym, rate: rate }));
        } catch {}
      } catch {
        RC.display_rate = null;
      }
    }

    var navSel = document.getElementById('tvCurrencySelect');
    if (navSel) navSel.value = code || company;
  }

  async function loadProfile() {
    var loading = document.getElementById('profile-loading');
    var content = document.getElementById('profile-content');

    try {
      var data = await API_PF('get_profile', {});

      /* Sync converter dengan server preference (source of truth across
         devices). Kalau server ada preference yang berbeza dari localStorage,
         update localStorage + RC + nav select. */
      var svCurr = data.display_currency || '';
      var lsCurr = RC.display_currency || '';
      if (svCurr !== lsCurr) {
        await _syncConverterTo(svCurr);
      }

      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML = renderProfile(data);
        wireProfileActions();
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML =
          '<div class="tv-card tv-text-center" style="padding:40px;">' +
          '<p style="color:var(--c-danger-text);">' + _esc(e.message || 'Failed to load profile.') + '</p>' +
          '</div>';
      }
    }
  }

  /* ── Render Full Profile Page ── */
  function renderProfile(data) {
    var email = _esc(data.email || '');
    var name = _esc(data.customer_name || '');
    var phone = _esc(data.phone || '');

    var html = '';

    /* ══════════════════════════════════════
       SECTION A: ACCOUNT INFORMATION
       ══════════════════════════════════════ */
    html += '<div class="tv-card tv-animate-in">';
    html += '<div class="tv-sec">👤 Account Information</div>';

    html += '<div class="tv-grid" style="margin-bottom:8px;">';
    // Name
    html += '<div><div class="tv-field__label">Full Name</div>';
    html += '<div class="tv-field__value">' + (name || '—') + '</div></div>';
    // Email
    html += '<div><div class="tv-field__label">Email (Sign-in)</div>';
    html += '<div class="tv-field__value" style="display:flex;align-items:center;gap:8px;">';
    html += (email || '—');
    html += '<span class="tv-badge tv-badge--neutral">Read-only</span>';
    html += '</div></div>';
    // Phone
    html += '<div><div class="tv-field__label">Phone Number</div>';
    html += '<div id="phone-display" class="tv-field__value" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">';
    html += '<span id="phone-value">' + (phone || 'Not set') + '</span>';
    html += '<button id="btn-edit-phone" class="tv-btn-link">Edit →</button>';
    html += '</div></div>';
    html += '</div>'; // grid

    // Phone edit form (hidden by default)
    html += '<div id="phone-form-wrap" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border-light);">';
    html += '<form id="phone-form" autocomplete="off">';
    html += '<div class="tv-form-group"><label class="tv-label">New Phone Number</label>';
    html += '<input type="tel" id="new-phone" class="tv-input" value="' + phone + '" placeholder="+60-xx-xxxx xxxx"/></div>';
    html += '<div style="display:flex;gap:10px;">';
    html += '<button type="submit" class="tv-btn tv-btn--primary tv-btn--sm">Update Phone</button>';
    html += '<button type="button" id="btn-cancel-phone" class="tv-btn tv-btn--ghost tv-btn--sm">Cancel</button>';
    html += '</div></form></div>';

    html += '</div>'; // card

    /* ══════════════════════════════════════
       SECTION B: DISPLAY CURRENCY
       ══════════════════════════════════════ */
    var companyCur = _esc(RC.company_currency || 'MYR');
    var savedCur = _esc(data.display_currency || '');
    var activeCur = savedCur || (RC.display_currency || '');

    html += '<div class="tv-card tv-animate-in">';
    html += '<div class="tv-sec">💱 Display Currency</div>';
    html += '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6;">';
    html += 'All amounts are charged in <strong>' + companyCur + '</strong>. ';
    html += 'Choose a display currency to see approximate converted amounts ';
    html += 'alongside your billing currency. Conversion is for display only — ';
    html += 'your card is always charged in ' + companyCur + '.</p>';

    html += '<div class="tv-form-group">';
    html += '<label class="tv-label" for="pf-currency">Display Currency</label>';
    html += '<select id="pf-currency" class="tv-input" style="cursor:pointer;padding:10px 12px;">';
    html += '<option value="' + companyCur + '">' + companyCur + ' — Charged currency</option>';
    html += '</select>';
    html += '</div>';

    html += '<div id="pf-currency-rate" style="font-size:12px;color:var(--text-muted);margin-bottom:12px;"></div>';

    html += '<div style="display:flex;gap:10px;">';
    html += '<button type="button" id="pf-currency-btn" class="tv-btn tv-btn--primary tv-btn--sm">Save Preference</button>';
    html += '</div>';

    html += '</div>'; // card

    /* ══════════════════════════════════════
       SECTION C: SECURITY (CHANGE PASSWORD)
       ══════════════════════════════════════ */
    html += '<div class="tv-card tv-animate-in">';
    html += '<div class="tv-sec">🔒 Change Password</div>';
    html += '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">';
    html += 'Enter your current password and choose a new one. Minimum 8 characters.</p>';

    html += '<form id="pwd-form" autocomplete="off">';
    html += '<div class="tv-form-group"><label class="tv-label">Current Password</label>';
    html += '<input type="password" id="old-pwd" class="tv-input" required/></div>';

    html += '<div class="tv-grid">';
    html += '<div class="tv-form-group"><label class="tv-label">New Password</label>';
    html += '<input type="password" id="new-pwd" class="tv-input" required minlength="8"/></div>';

    html += '<div class="tv-form-group"><label class="tv-label">Confirm New Password</label>';
    html += '<input type="password" id="confirm-pwd" class="tv-input" required minlength="8"/></div>';
    html += '</div>'; // grid

    html += '<div id="pwd-strength" style="font-size:12px;color:var(--text-muted);margin-bottom:12px;display:none;">';
    html += 'Password strength: <span id="strength-bar"></span></div>';

    html += '<button type="submit" class="tv-btn tv-btn--primary tv-btn--sm">Update Password</button>';
    html += '</form>';

    html += '</div>'; // card

    /* ══════════════════════════════════════
       SECTION D: PDPA DATA RIGHTS
       ══════════════════════════════════════ */
    html += '<div class="tv-card tv-animate-in">';
    html += '<div class="tv-sec">🛡️ Your Data Rights (PDPA)</div>';
    html += '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6;">';
    html += 'Under the Malaysian Personal Data Protection Act 2010, you have the right to request ';
    html += 'correction of your personal data or complete deletion from our systems. ';
    html += 'Our team will respond within 14 business days.</p>';

    html += '<form id="pdpa-form" autocomplete="off">';
    html += '<div class="tv-form-group"><label class="tv-label">Request Type</label>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">';
    html += '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px;padding:14px 16px;border:2px solid var(--c-gold);border-radius:var(--radius-sm);background:var(--c-gold-light);transition:var(--transition);">';
    html += '<input type="radio" name="pdpa-action" value="correction" checked style="accent-color:var(--c-gold);width:18px;height:18px;flex-shrink:0;"/> <span style="font-weight:500;color:var(--text-primary);">Data<br/>Correction</span></label>';
    html += '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px;padding:14px 16px;border:2px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-card);transition:var(--transition);">';
    html += '<input type="radio" name="pdpa-action" value="deletion" style="accent-color:var(--c-gold);width:18px;height:18px;flex-shrink:0;"/> <span style="font-weight:500;color:var(--text-primary);">Account<br/>Deletion</span></label>';
    html += '</div></div>';

    html += '<div class="tv-form-group"><label class="tv-label">Details</label>';
    html += '<textarea id="pdpa-details" class="tv-input" rows="3" placeholder="Please describe what you would like us to correct or any additional details..."></textarea></div>';

    html += '<button type="submit" class="tv-btn tv-btn--ghost tv-btn--sm">Submit Request</button>';
    html += '</form>';

    html += '</div>'; // card

    return html;
  }

  /* ── Display Currency: populate dropdown + wire save ── */
  async function _initCurrencySection() {
    var sel = document.getElementById('pf-currency');
    var rateEl = document.getElementById('pf-currency-rate');
    var btn = document.getElementById('pf-currency-btn');
    if (!sel || !btn) return;

    var company = RC.company_currency || 'MYR';
    var list = await _loadCurrencyList();

    /* Populate options: company currency first, then the rest */
    sel.innerHTML = '';
    list.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.code;
      o.textContent = c.code + ' — ' + _esc(c.name || c.code)
        + (c.is_company ? ' (charged)' : '');
      sel.appendChild(o);
    });

    if (!list.length) {
      var o = document.createElement('option');
      o.value = company; o.textContent = company;
      sel.appendChild(o);
      sel.disabled = true;
      btn.disabled = true;
      return;
    }

    /* Set current value: server preference → localStorage → company */
    sel.value = RC.display_currency || company;

    /* Show rate info for the currently-selected non-company currency */
    function _showRate() {
      if (!rateEl) return;
      var code = sel.value;
      if (!code || code === company) {
        rateEl.textContent = '';
        return;
      }
      if (RC.display_currency === code && RC.display_rate) {
        rateEl.textContent = 'Rate: 1 ' + company + ' = '
          + fmt(RC.display_rate) + ' ' + code
          + ' (indicative, for_selling)';
      } else {
        rateEl.textContent = 'Rate will be fetched when you save.';
      }
    }
    _showRate();

    sel.addEventListener('change', _showRate);

    btn.addEventListener('click', async function () {
      var code = sel.value;
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        var result = await API_PF('set_display_currency', { currency: code });
        /* Sync converter (localStorage + RC + nav select) with new preference */
        await _syncConverterTo(result.display_currency || '');
        if (rateEl) _showRate();

        showInlineError('profile-success',
          result.message || 'Display currency preference saved.');
        showToast('Currency preference saved!', 'success');
      } catch (e) {
        showInlineError('profile-error',
          e.message || 'Failed to save currency preference.');
      }

      btn.disabled = false;
      btn.textContent = 'Save Preference';
    });
  }

  /* ── Wire up all form actions ── */
  function wireProfileActions() {
    /* Display Currency — populate list + wire save */
    _initCurrencySection();

    /* Phone Edit Toggle */
    var editBtn = document.getElementById('btn-edit-phone');
    var cancelBtn = document.getElementById('btn-cancel-phone');
    var formWrap = document.getElementById('phone-form-wrap');

    if (editBtn && formWrap) {
      editBtn.addEventListener('click', function () {
        formWrap.style.display = 'block';
        editBtn.style.display = 'none';
        document.getElementById('new-phone').focus();
      });
    }

    if (cancelBtn && formWrap) {
      cancelBtn.addEventListener('click', function () {
        formWrap.style.display = 'none';
        if (editBtn) editBtn.style.display = '';
      });
    }

    /* Phone Update Form */
    var phoneForm = document.getElementById('phone-form');
    if (phoneForm) {
      phoneForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var newPhone = document.getElementById('new-phone').value.trim();

        if (!newPhone) {
          showInlineError('profile-error', 'Please enter a phone number.');
          return;
        }

        hideInlineError('profile-success');
        var btn = phoneForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Updating...';

        try {
          var result = await API_PF('update_phone', { phone: newPhone });
          showInlineError('profile-success', result.message || 'Phone number updated successfully!');
          document.getElementById('phone-value').textContent = newPhone;

          setTimeout(function () {
            if (formWrap) formWrap.style.display = 'none';
            if (editBtn) editBtn.style.display = '';
          }, 1500);

          showToast('Phone updated!', 'success');
        } catch (e) {
          showInlineError('profile-error', e.message || 'Failed to update phone.');
        }

        btn.disabled = false;
        btn.textContent = 'Update Phone';
      });
    }

    /* Password Form */
    var pwdForm = document.getElementById('pwd-form');
    if (pwdForm) {
      // Strength indicator
      var newPwdInput = document.getElementById('new-pwd');
      if (newPwdInput) {
        newPwdInput.addEventListener('input', function () {
          var strengthEl = document.getElementById('pwd-strength');
          var barEl = document.getElementById('strength-bar');
          if (!strengthEl || !barEl) return;

          var val = this.value;
          if (val.length === 0) { strengthEl.style.display = 'none'; return; }
          strengthEl.style.display = '';

          var score = 0;
          if (val.length >= 8) score++;
          if (/[a-z]/.test(val)) score++;
          if (/[A-Z]/.test(val)) score++;
          if (/[0-9]/.test(val)) score++;
          if (/[^a-zA-Z0-9]/.test(val)) score++;

          var labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
          var colors = ['#EF4444', '#F59E0B', '#F59E0B', '#10B981', '#10B981'];
          barEl.textContent = labels[Math.min(score, 4)];
          barEl.style.color = colors[Math.min(score, 4)];
          barEl.style.fontWeight = '600';
        });
      }

      pwdForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var oldPwd = document.getElementById('old-pwd').value;
        var newPwd = document.getElementById('new-pwd').value;
        var confirmPwd = document.getElementById('confirm-pwd').value;

        if (!oldPwd || !newPwd || !confirmPwd) {
          showInlineError('profile-error', 'Please fill in all password fields.');
          return;
        }
        if (newPwd !== confirmPwd) {
          showInlineError('profile-error', 'New passwords do not match.');
          return;
        }
        if (newPwd.length < 8) {
          showInlineError('profile-error', 'Password must be at least 8 characters.');
          return;
        }

        hideInlineError('profile-success');
        var btn = pwdForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Updating...';

        try {
          var result = await API_PF('change_password', {
            old_password: oldPwd,
            new_password: newPwd
          });
          showInlineError('profile-success', result.message || 'Password updated successfully!');
          pwdForm.reset();
          var strengthEl = document.getElementById('pwd-strength');
          if (strengthEl) strengthEl.style.display = 'none';

          showToast('Password changed!', 'success');
        } catch (e) {
          showInlineError('profile-error', e.message || 'Failed to change password.');
        }

        btn.disabled = false;
        btn.textContent = 'Update Password';
      });
    }

    /* PDPA Form - Radio toggle visual effect */
    var pdpaRadios = document.querySelectorAll('#pdpa-form input[name="pdpa-action"]');
    var pdpaLabels = document.querySelectorAll('#pdpa-form label[style*="grid-template-columns"]');
    pdpaRadios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        pdpaLabels.forEach(function (lbl, idx) {
          if (idx === Array.from(pdpaRadios).indexOf(radio)) {
            lbl.style.borderColor = 'var(--c-gold)';
            lbl.style.background = 'var(--c-gold-light)';
          } else {
            lbl.style.borderColor = 'var(--border-default)';
            lbl.style.background = 'var(--bg-card)';
          }
        });
      });
    });

    /* PDPA Form */
    var pdpaForm = document.getElementById('pdpa-form');
    if (pdpaForm) {
      pdpaForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var action = pdpaForm.querySelector('input[name="pdpa-action"]:checked')?.value || 'correction';
        var details = document.getElementById('pdpa-details').value.trim();

        hideInlineError('profile-success');
        var btn = pdpaForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Submitting...';

        try {
          var result = await API_PF('request_data_action', {
            action: action,
            details: details
          });
          showInlineError('profile-success', result.message || 'Your request has been submitted. We will respond within 14 days.');
          pdpaForm.reset();

          showToast('Request submitted!', 'success');
        } catch (e) {
          showInlineError('profile-error', e.message || 'Failed to submit request.');
        }

        btn.disabled = false;
        btn.textContent = 'Submit Request';
      });
    }
  }

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
