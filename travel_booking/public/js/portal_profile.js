/* ============================================================
   travel_booking/public/js/portal_profile.js
   Page: /traveller_portal/profile — phone, password, PDPA requests.
   Semua feedback inline (role=alert/status) — tiada alert() chain.
   ============================================================ */

'use strict';

async function savePhone() {
  hideInlineError('pf-phone-err');
  const okBox = document.getElementById('pf-phone-ok');
  okBox.style.display = 'none';

  const phone = (document.getElementById('pf-phone').value || '').trim();
  if (!phone) { showInlineError('pf-phone-err', 'Please enter a phone number.'); return; }

  const btn = document.getElementById('pf-phone-btn');
  btn.textContent = 'Updating...';
  btn.disabled = true;
  try {
    const result = await API_PF('update_phone', { phone });
    document.getElementById('pf-phone-ok-msg').textContent = result.message || 'Phone number updated.';
    okBox.style.display = 'block';
  } catch (e) {
    showInlineError('pf-phone-err', e.message || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Update phone';
    btn.disabled = false;
  }
}

async function changePassword() {
  hideInlineError('pf-pw-err');
  const oldPw = document.getElementById('pf-pw-old').value;
  const newPw = document.getElementById('pf-pw-new').value;
  const newPw2 = document.getElementById('pf-pw-new2').value;

  if (!oldPw) { showInlineError('pf-pw-err', 'Please enter your current password.'); return; }
  if (!newPw || newPw.length < 8) { showInlineError('pf-pw-err', 'New password must be at least 8 characters.'); return; }
  if (newPw !== newPw2) { showInlineError('pf-pw-err', 'New passwords do not match.'); return; }
  if (newPw === oldPw) { showInlineError('pf-pw-err', 'New password must be different from your current password.'); return; }

  const btn = document.getElementById('pf-pw-btn');
  btn.textContent = 'Updating...';
  btn.disabled = true;
  try {
    const result = await API_PF('change_password', { old_password: oldPw, new_password: newPw });
    showInlineError('pf-pw-err', result.message || 'Password updated.');
    // Betulkan styling: guna success (hijau) — showInlineError merah; kita
    // tukar style kotak selepas papar.
    const errBox = document.getElementById('pf-pw-err');
    errBox.style.color = '#0F6E56';
    document.getElementById('pf-pw-old').value = '';
    document.getElementById('pf-pw-new').value = '';
    document.getElementById('pf-pw-new2').value = '';
    // Reset warna selepas 6 saat supaya error berikutnya kekal merah.
    setTimeout(() => { errBox.style.color = ''; }, 6000);
  } catch (e) {
    showInlineError('pf-pw-err', e.message || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Update password';
    btn.disabled = false;
  }
}

async function requestDataAction(action) {
  hideInlineError('pf-pdpa-err');
  const okBox = document.getElementById('pf-pdpa-ok');
  okBox.style.display = 'none';

  if (action === 'deletion') {
    const ok = confirm(
      'Submit a data deletion request?\n\n' +
      'Our team will review and contact you about what can be deleted. ' +
      'Some records (payment history) may be retained for legal obligations.'
    );
    if (!ok) return;
  }

  const btn = document.getElementById(action === 'correction' ? 'pf-correct-btn' : 'pf-delete-btn');
  btn.disabled = true;
  try {
    const details = (document.getElementById('pf-pdpa-details').value || '').trim();
    const result = await API_PF('request_data_action', { action, details });
    document.getElementById('pf-pdpa-ok-msg').textContent = result.message || 'Your request has been submitted.';
    okBox.style.display = 'block';
    document.getElementById('pf-pdpa-details').value = '';
  } catch (e) {
    showInlineError('pf-pdpa-err', e.message || 'An error occurred. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();

  try {
    const p = await API_PF('get_profile', {});
    document.getElementById('pf-name').textContent  = p.customer_name || '—';
    document.getElementById('pf-email').textContent = p.email || '—';
    document.getElementById('pf-phone').value      = p.phone || '';
  } catch (e) {
    document.getElementById('pf-name').textContent = 'Could not load profile';
    showInlineError('pf-phone-err', e.message || 'Failed to load profile.');
  }
});
