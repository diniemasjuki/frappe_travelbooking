/* ============================================================
   travel_booking/public/js/portal_wizard.js
   Wizard Lookup — verify traveller identity before form
   ============================================================ */

let _wizardResult = null;

function _resetWizard() {
  ['wiz-ic', 'wiz-pp', 'wiz-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const msg = document.getElementById('wiz-msg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  const resultCard = document.getElementById('wiz-result-card');
  if (resultCard) resultCard.style.display = 'none';
  const inputCard = document.getElementById('wiz-input-card');
  if (inputCard) inputCard.style.display = 'block';
  const btn = document.getElementById('wiz-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Verify traveller'; }
  _wizardResult = null;
}

function wizardSkip() {
  _loadTravellerForm(null);
}

function wizardConfirm() {
  if (!_wizardResult) return;
  _loadTravellerForm(
    { ...ACTIVE_SLOT, ..._wizardResult.data },
    _wizardResult.passportReset
  );
}

async function doWizardLookup() {
  const ic   = (document.getElementById('wiz-ic')?.value   || '').trim();
  const pp   = (document.getElementById('wiz-pp')?.value   || '').trim().toUpperCase();
  const name = (document.getElementById('wiz-name')?.value || '').trim();

  const msgEl = document.getElementById('wiz-msg');
  const btn   = document.getElementById('wiz-btn');

  if (!ic || !pp || !name) {
    _wizMsg('Please fill in all three fields.', 'warn');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Verifying…';
  if (msgEl) msgEl.style.display = 'none';

  try {
    const res = await API_TV('wizard_lookup', { ic_number: ic, passport_no: pp, full_name: name });

    btn.disabled = false; btn.textContent = 'Verify traveller';

    if (res.status === 'not_found') {
      _wizMsg('Details do not match our records. Please check and try again.', 'error');
      return;
    }

    if (res.status === 'found' || res.status === 'passport_reset') {
      const passportReset = res.status === 'passport_reset';
      _wizardResult = { data: res.data, passportReset };

      const fullName = res.data.full_name || '';
      document.getElementById('wiz-result-initial').textContent = fullName.trim().charAt(0).toUpperCase() || '?';
      document.getElementById('wiz-result-name').textContent    = fullName;
      document.getElementById('wiz-result-ic').textContent      = 'IC: ' + (res.data.ic_number || ic);

      const ppNotice = document.getElementById('wiz-pp-notice');
      if (ppNotice) ppNotice.style.display = passportReset ? 'block' : 'none';

      document.getElementById('wiz-input-card').style.display  = 'none';
      document.getElementById('wiz-result-card').style.display = 'block';
    }
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Verify traveller';
    _wizMsg('Something went wrong. Please try again.', 'error');
  }
}

function _wizMsg(text, type) {
  const el = document.getElementById('wiz-msg');
  if (!el) return;
  el.textContent      = text;
  el.style.display    = 'block';
  el.style.background = type === 'error' ? '#FCEBEB' : '#FAEEDA';
  el.style.color      = type === 'error' ? '#501313' : '#633806';
}
