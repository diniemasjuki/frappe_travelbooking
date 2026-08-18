/* ============================================================
   travel_booking/public/js/portal_traveller_page.js
   Page: /traveller_portal/booking-traveller?ref=...

   Gabungan logic portal_wizard.js + portal_traveller.js (SPA lama),
   diadaptasikan untuk page berasingan + PENAMBAHAN:
   - Inline per-field validation (GANTI alert chain — fix audit UX)
   - PDPA consent checkbox (wajib, dihantar sebagai pdpa_consent)
   - Semua render di-escape guna _esc() (fix XSS)
   - Slot Verified: klik tunjuk mesej jelas (bukan dead click senyap)
   ============================================================ */

'use strict';

let PORTAL_DATA  = null;   // get_booking_data untuk booking ni
let ACTIVE_SLOT  = null;
let BOOKING      = '';     // booking_number dari URL
let _passportFile = null;
let _visaPhotoFile = null;

/* ── Navigasi antara 2 page: senarai slot (booking_traveller) dan
   aliran dokumen (booking_traveller/docs?ref=..&slot=..) ── */
function tvlDocsUrl(slotName) {
  return '/traveller_portal/booking_traveller/docs?ref=' + encodeURIComponent(BOOKING) +
         '&slot=' + encodeURIComponent(slotName);
}

function tvlBackToList() {
  window.location.href = '/traveller_portal/booking_traveller?ref=' + encodeURIComponent(BOOKING);
}

/* ── View switching dalam page docs (wizard / form) ── */
function showTravellerView(id) {
  ['V-wizard', 'V-form'].forEach(function (v) {
    const el = document.getElementById(v);
    if (el) el.style.display = (v === id) ? '' : 'none';
  });
  const loading = document.getElementById('tvl-docs-loading');
  if (loading) loading.style.display = 'none';
  window.scrollTo(0, 0);
}

/* ══════════════════════════════════════════════
   INLINE FIELD ERRORS (ganti alert chain)
   ══════════════════════════════════════════════ */

function _errSlot(inputEl) {
  let slot = inputEl.parentElement.querySelector(':scope > .f-err');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'f-err';
    slot.setAttribute('role', 'alert');
    slot.style.cssText = 'display:none;font-size:11px;color:#C0392B;margin-top:4px;';
    inputEl.parentElement.appendChild(slot);
  }
  return slot;
}

function fieldError(inputEl, msg) {
  if (!inputEl) return;
  inputEl.style.borderColor = '#F87171';
  const slot = _errSlot(inputEl);
  slot.textContent = msg;
  slot.style.display = 'block';
}

function clearFieldError(inputEl) {
  if (!inputEl) return;
  inputEl.style.borderColor = '';
  const slot = inputEl.parentElement.querySelector(':scope > .f-err');
  if (slot) slot.style.display = 'none';
}

/* ══════════════════════════════════════════════
   SLOT LIST (grouped by cabin — port dari portal_booking.js)
   ══════════════════════════════════════════════ */

function renderTravellerSlots(data) {
  const container = document.getElementById('traveller-slots-container');
  const slots  = data.slots  || [];
  const cabins = data.cabins || [];

  // Stepper
  const filled = slots.filter(s => s.filled).length;
  const total  = slots.length;
  const pct    = total > 0 ? Math.round((filled / total) * 100) : 0;
  document.getElementById('tvl-progress-label').innerHTML =
    '<span>' + filled + ' of ' + total + ' travellers completed</span><span>' + pct + '%</span>';
  document.getElementById('tvl-progress-fill').style.width = pct + '%';
  document.getElementById('tvl-page-sub').textContent =
    (data.booking && data.booking.trip_name ? data.booking.trip_name + ' · ' : '') + BOOKING;

  if (!slots.length) {
    container.innerHTML =
      '<div class="card" style="text-align:center;padding:32px 20px;font-size:13px;color:#7D7A70;">' +
      'No traveller slots yet. Slots are created once your booking is activated — ' +
      'our team will notify you if action is needed.</div>';
    return;
  }

  let html = '';
  const renderCabin = function (cabinNo, roomName, cabinSlots) {
    const cFilled = cabinSlots.filter(s => s.filled).length;
    const allFilled = cFilled === cabinSlots.length;
    const badgeBg = allFilled ? '#DCFCE7' : '#FEF3C7';
    const badgeClr = allFilled ? '#166534' : '#92400E';
    return (
      '<div style="margin-bottom:14px;border:1px solid #EAE7E0;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.05);">' +
        '<div style="background:#F5F3EE;padding:11px 16px;display:flex;align-items:center;gap:12px;border-bottom:0.5px solid #EAE7E0;">' +
          '<div style="width:28px;height:28px;border-radius:8px;background:#C9A84C;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">' + _esc(cabinNo) + '</div>' +
          '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:#1E1C18;">Room ' + _esc(cabinNo) + '</div>' +
          (roomName ? '<div style="font-size:11px;color:#B0AC9F;margin-top:1px;text-transform:uppercase;letter-spacing:.04em;">' + _esc(roomName) + '</div>' : '') +
          '</div>' +
          '<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;background:' + badgeBg + ';color:' + badgeClr + ';white-space:nowrap;">' + cFilled + '/' + cabinSlots.length + ' filled</span>' +
        '</div>' +
        cabinSlots.map(slotCardHtml).join('') +
      '</div>'
    );
  };

  if (cabins.length) {
    cabins.forEach(c => html += renderCabin(c.cabin_no, c.room_name, c.slots || []));
  } else {
    const buckets = {}; const order = [];
    slots.forEach(s => {
      const r = s.room_category || 'Room';
      if (!buckets[r]) { buckets[r] = []; order.push(r); }
      buckets[r].push(s);
    });
    let i = 1;
    order.forEach(r => { html += renderCabin(i, r, buckets[r]); i++; });
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-slot]').forEach(el => {
    el.addEventListener('click', () => openTravellerForm(el.dataset.slot));
  });
}

function slotCardHtml(slot) {
  const isFilled   = slot.filled;
  const isVerified = slot.is_verified || slot.document_status === 'Verified';
  const isOpenForUpd = slot.document_status === 'Open for Update';

  const base = 'data-slot="' + _esc(slot.slot_name) + '" style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;background:#fff;"';

  if (isFilled) {
    const name = slot.full_name || '';
    const parts = name.trim().split(' ');
    const initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();

    const badge = isVerified
      ? { bg: '#EBF7F1', fg: '#0F6E56', txt: 'Verified' }
      : isOpenForUpd
        ? { bg: '#EDE9FE', fg: '#5B21B6', txt: 'Edit Requested' }
        : { bg: '#FEF3C7', fg: '#92400E', txt: 'Pending' };

    const requestLink = isVerified
      ? '<button type="button" onclick="event.stopPropagation();requestDocumentUpdate(\'' + _esc(slot.slot_name) + '\')" ' +
        'style="background:none;border:none;padding:0;font-size:11px;color:#7D7A70;text-decoration:underline;cursor:pointer;white-space:nowrap;">Request to edit</button>'
      : '';

    return (
      '<div class="slot-card" ' + base + '>' +
        '<div style="width:38px;height:38px;border-radius:50%;background:' + (isVerified ? '#EBF7F1' : '#FEF9D3') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700;color:' + badge.fg + ';">' + _esc(initials) + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:10px;font-weight:700;color:#B0AC9F;letter-spacing:.07em;text-transform:uppercase;margin-bottom:2px;">' + _esc(slot.slot_label) + '</div>' +
          '<div style="font-size:13px;font-weight:600;color:#1E1C18;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + _esc(name) + '</div>' +
          (slot.ic_number ? '<div style="font-size:11px;color:#7D7A70;margin-top:1px;">' + _esc(slot.ic_number) + '</div>' : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:4px;">' +
          '<span style="font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;background:' + badge.bg + ';color:' + badge.fg + ';white-space:nowrap;">' + badge.txt + '</span>' +
          requestLink +
        '</div>' +
        '<div style="color:#B0AC9F;font-size:16px;flex-shrink:0;">›</div>' +
      '</div>'
    );
  }

  return (
    '<div class="slot-card slot-empty" ' + base + '>' +
      '<div style="width:38px;height:38px;border-radius:50%;border:1.5px dashed #D4D1CC;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;font-weight:300;color:#B0AC9F;">+</div>' +
      '<div style="flex:1;">' +
        '<div style="font-size:10px;font-weight:700;color:#B0AC9F;letter-spacing:.07em;text-transform:uppercase;margin-bottom:2px;">' + _esc(slot.slot_label) + '</div>' +
        '<div style="font-size:13px;color:#7D7A70;">Not filled yet</div>' +
        '<div style="font-size:11px;color:#B0AC9F;margin-top:1px;">Tap to fill in traveller details</div>' +
      '</div>' +
      '<div style="color:#B0AC9F;font-size:16px;flex-shrink:0;">›</div>' +
    '</div>'
  );
}

/* FIX AUDIT (dead click): slot Verified/Open-for-Update klik → mesej jelas,
   bukan return senyap. */
function openTravellerForm(slotName) {
  if (!PORTAL_DATA) return;
  const slot = (PORTAL_DATA.slots || []).find(s => s.slot_name === slotName);
  if (!slot) return;

  const isVerified   = slot.is_verified || slot.document_status === 'Verified';
  const isOpenForUpd = slot.document_status === 'Open for Update';

  if (isVerified || isOpenForUpd) {
    const notice = document.getElementById('tvl-locked-notice');
    document.getElementById('tvl-locked-notice-text').innerHTML =
      isVerified
        ? '<strong>' + _esc(slot.full_name || slot.slot_label) + '</strong> has been verified by our team and is locked. ' +
          'Need a correction? Use the "Request to edit" link on the card.'
        : '<strong>' + _esc(slot.full_name || slot.slot_label) + '</strong> has an edit request pending review by our team. ' +
          'You will be able to edit once it is approved.';
    notice.style.display = 'block';
    notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { notice.style.display = 'none'; }, 6000);
    return;
  }

  ACTIVE_SLOT = slot;
  _passportFile = null;
  _visaPhotoFile = null;

  // Pergi ke page docs — Langkah 1 (upload passport) bila slot kosong,
  // terus borang bila slot sudah terisi (edit semula).
  window.location.href = tvlDocsUrl(slot.slot_name);
}

async function requestDocumentUpdate(slotName) {
  const ok = confirm('Request an update for this traveller slot?\n\nAdmin will review and unlock it for editing.');
  if (!ok) return;
  const linkBtns = document.querySelectorAll('button');
  // Double-submit guard ringan — butang request manapun yang sedang aktif.
  try {
    await API_TV('request_document_update', { slot_name: slotName });
    const fresh = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = fresh;
    renderTravellerSlots(fresh);
  } catch (e) {
    alert(e.message || 'Failed to submit request. Please try again.');
  }
}

/* ══════════════════════════════════════════════
   WIZARD — LANGKAH 1: UPLOAD PASSPORT DULU
   (aliran baharu: gambar passport → check return
   customer → prefill / form kosong)
   ══════════════════════════════════════════════ */

let _wizardResult   = null;   // data traveller dari check_traveller_passport
let _wizardExtracted = null; // medan yang berjaya dibaca dari passport (OCR/MRZ)
let _wizardFile     = null;   // File passport yang dipilih di langkah 1

function _resetWizard() {
  _wizardFile = null;
  _wizardResult = null;
  _wizardExtracted = null;
  const msg = document.getElementById('wiz-msg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  document.getElementById('wiz-result-card').style.display = 'none';
  document.getElementById('wiz-new-card').style.display = 'none';
  document.getElementById('wiz-input-card').style.display = 'block';
  document.getElementById('wiz-upload-txt').textContent = 'Upload passport copy';
  document.getElementById('wiz-upload-area').style.borderColor = '';
  const btn = document.getElementById('wiz-btn');
  if (btn) { btn.disabled = false; btn.style.display = 'none'; btn.textContent = 'Check passport →'; }
}

function triggerWizardPassportUpload() {
  _pickImage(file => {
    _wizardFile = file;
    document.getElementById('wiz-upload-txt').textContent = '✓ ' + file.name;
    document.getElementById('wiz-upload-area').style.borderColor = '#0F6E56';
    document.getElementById('wiz-result-card').style.display = 'none';
    document.getElementById('wiz-new-card').style.display = 'none';
    document.getElementById('wiz-btn').style.display = 'block';
    const msg = document.getElementById('wiz-msg');
    if (msg) msg.style.display = 'none';
  }, 'wiz-msg');
}

async function checkWizardPassport() {
  if (!_wizardFile) return;
  const btn = document.getElementById('wiz-btn');
  const msgEl = document.getElementById('wiz-msg');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  if (msgEl) msgEl.style.display = 'none';

  try {
    const readFile = f => new Promise(res => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.readAsDataURL(f);
    });
    const filedata = await readFile(_wizardFile);

    const res = await API_TV('check_traveller_passport', { filedata: filedata });
    btn.disabled = false;
    btn.textContent = 'Check passport →';

    // Imej tak dapat dibaca (bukan halaman foto passport / terlalu kabur)
    // — kekal di Langkah 1, minta upload semula. Jangan buka borang lagi.
    if (res.status === 'unreadable') {
      _wizMsg('We could not read this passport image. Please upload a clearer photo of the passport photo page — all four corners visible, no glare, text sharp.', 'error');
      document.getElementById('wiz-input-card').style.display = 'block';
      return;
    }

    document.getElementById('wiz-input-card').style.display = 'none';

    if (res.status === 'found' && res.data) {
      _wizardResult = res.data;
      _wizardExtracted = res.extracted || null;
      const fullName = res.data.full_name || '';
      document.getElementById('wiz-result-initial').textContent = fullName.trim().charAt(0).toUpperCase() || '?';
      document.getElementById('wiz-result-name').textContent = fullName;
      document.getElementById('wiz-result-ic').textContent = 'IC: ' + (res.data.ic_number || '');
      document.getElementById('wiz-result-card').style.display = 'block';
    } else {
      _wizardResult = null;
      _wizardExtracted = res.extracted || null;
      // Tunjuk SEMUA medan requirement yang berjaya dibaca dari passport —
      // passport no, national ID, gender, nationality, DOB, expiry.
      // Medan tak jumpa ditanda supaya user tahu yang mana perlu isi manual.
      const ex = res.extracted || {};
      const readRows = [];
      if (ex.full_name)        readRows.push('Name: ' + ex.full_name);
      if (ex.passport_no)      readRows.push('Passport no: ' + ex.passport_no);
      readRows.push('IC / National ID: ' + (ex.ic_number || 'not detected — please fill in'));
      if (ex.gender)           readRows.push('Gender: ' + ex.gender);
      if (ex.nationality)      readRows.push('Nationality: ' + ex.nationality);
      if (ex.date_of_birth)    readRows.push('Date of birth: ' + ex.date_of_birth);
      if (ex.passport_expiry)  readRows.push('Passport expiry: ' + ex.passport_expiry);
      const readEl = document.getElementById('wiz-new-read');
      if (readEl) {
        readEl.style.display = 'block';
        readEl.innerHTML =
          '✓ Read from passport:<br>' +
          '<span style="display:inline-block;margin-top:4px;">' +
          readRows.map(r => '• ' + _esc(r)).join('<br>') + '</span>';
      }
      document.getElementById('wiz-new-card').style.display = 'block';
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Check passport →';
    _wizMsg(e.message || 'Something went wrong. Please try again.', 'error');
    document.getElementById('wiz-input-card').style.display = 'block';
  }
}

/* Passport yang dimuat naik di Langkah 1 dibawa masuk ke tab Passport
   pada form — user tak perlu pilih fail sekali lagi. */
function _applyWizardPassportFile() {
  if (!_wizardFile) return;
  _passportFile = _wizardFile;
  document.getElementById('passport-upload-txt').textContent = '✓ ' + _wizardFile.name;
  document.getElementById('passport-upload-area').style.borderColor = '#0F6E56';
}

async function wizardConfirm() {
  if (!_wizardResult) return;
  // Gabung rekod Traveller (doctype — maklumat penuh) dengan hasil scan
  // MRZ/OCR terkini: passport_no & expiry dari passport dalam tangan
  // MENGATASI rekod lama; nama/IC dari rekod kekal melainkan kosong.
  const merged = Object.assign({}, ACTIVE_SLOT, _wizardResult);
  const ex = _wizardExtracted || {};
  ['passport_no', 'passport_expiry', 'date_of_birth', 'gender', 'nationality'].forEach(k => {
    if (ex[k]) merged[k] = ex[k];
  });
  ['first_name', 'last_name', 'full_name', 'ic_number'].forEach(k => {
    if (!merged[k] && ex[k]) merged[k] = ex[k];
  });
  // await PENTING: _loadTravellerForm() me-reset _passportFile = null di
  // tengah aliran asyncnya — jika tak await, _applyWizardPassportFile()
  // jalan lebih dulu dan fail passport dari Langkah  1 terpadam.
  await _loadTravellerForm(merged);
  _applyWizardPassportFile();
}

async function wizardContinueNew() {
  // Prefill dengan medan yang berjaya dibaca daripada passport (MRZ/OCR)
  // — nama, nombor passport, DOB, gender, IC (jika jumpa).
  // await: elak race dgn reset _passportFile dalam _loadTravellerForm.
  await _loadTravellerForm(_wizardExtracted || null);
  _applyWizardPassportFile();
}

function _wizMsg(text, type) {
  const el = document.getElementById('wiz-msg');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#FCEBEB' : '#FAEEDA';
  el.style.color = type === 'error' ? '#501313' : '#633806';
}

/* ══════════════════════════════════════════════
   PHONE WIDGETS (intl-tel-input — port)
   ══════════════════════════════════════════════ */

let _itiPhone = null;
let _itiEcPhone = null;

function _initPhoneWidgets() {
  if (typeof window.intlTelInput === 'undefined') return;
  const opts = { initialCountry: 'my', separateDialCode: true, utilsScript: undefined };
  const phoneEl = document.getElementById('tvl-phone-num');
  if (phoneEl && !_itiPhone) _itiPhone = window.intlTelInput(phoneEl, opts);
  const ecPhoneEl = document.getElementById('tvl-ec-phone');
  if (ecPhoneEl && !_itiEcPhone) _itiEcPhone = window.intlTelInput(ecPhoneEl, opts);
}

function _getFullPhoneNumber(iti, fallbackEl) {
  if (!iti) return (fallbackEl?.value || '').trim();
  const full = iti.getNumber().trim();
  if (full) return full;
  return (fallbackEl?.value || '').trim();
}

function _setPhoneValue(iti, elId, rawValue) {
  const el = document.getElementById(elId);
  if (!rawValue) { if (iti) iti.setNumber(''); else if (el) el.value = ''; return; }
  if (iti) iti.setNumber(rawValue); else if (el) el.value = rawValue;
}

/* ══════════════════════════════════════════════
   NATIONALITY SELECT
   ══════════════════════════════════════════════ */

let _countriesLoaded = false;

async function loadCountries() {
  if (_countriesLoaded) return;
  try {
    const countries = await API_TV('get_countries', {});
    const sel = document.getElementById('tvl-nat');
    if (sel && countries && countries.length) {
      const current = sel.value || '';
      sel.innerHTML = '<option value="">Select nationality</option>' +
        countries.map(c => '<option value="' + _esc(c.name) + '">' + _esc(c.country_name || c.name) + '</option>').join('');
      if (current) sel.value = current;
    }
    _countriesLoaded = true;
  } catch (e) {
    _countriesLoaded = true;
  }
}

/* ══════════════════════════════════════════════
   FORM LOAD + PASSPORT VALIDITY (port)
   ══════════════════════════════════════════════ */

async function _loadTravellerForm(slot, passportReset = false) {
  await loadCountries();
  _initPhoneWidgets();
  _sectionsSaved = { passport: false, contact: false, health: false };

  const isVerified      = slot && (slot.is_verified || slot.document_status === 'Verified');
  const isOpenForUpdate = slot && slot.document_status === 'Open for Update';
  const isRejected      = slot && slot.document_status === 'Rejected';
  const canEdit         = !isVerified || isOpenForUpdate || isRejected;

  document.getElementById('tvl-ic').value        = slot?.ic_number      || '';
  document.getElementById('tvl-firstname').value = slot?.first_name     || '';
  document.getElementById('tvl-lastname').value  = slot?.last_name      || '';
  document.getElementById('tvl-name').value      = slot?.full_name      || '';
  document.getElementById('tvl-dob').value       = slot?.date_of_birth  || '';
  document.getElementById('tvl-nat').value       = slot?.nationality    || '';
  document.getElementById('tvl-gender').value    = slot?.gender         || '';
  _setPhoneValue(_itiPhone, 'tvl-phone-num', slot?.phone);
  _setPhoneValue(_itiEcPhone, 'tvl-ec-phone', slot?.emergency_contact_phone);
  document.getElementById('tvl-email').value = slot?.email || '';
  document.getElementById('tvl-pp').value    = passportReset ? '' : (slot?.passport_no || '');
  document.getElementById('tvl-ppexp').value = passportReset ? '' : (slot?.passport_expiry || '');
  document.getElementById('tvl-ec-name').value         = slot?.emergency_contact_name || '';
  document.getElementById('tvl-ec-relationship').value = slot?.emergency_contact_relationship || '';
  document.getElementById('tvl-dietary').value       = slot?.dietary_requirements || '';
  document.getElementById('tvl-medical').value       = slot?.medical_conditions  || '';
  document.getElementById('tvl-medicine').value      = slot?.medicine_treatment  || '';
  document.getElementById('tvl-special-needs').value = slot?.special_needs      || '';
  document.getElementById('tvl-wheelchair').value    = slot?.wheelchair_assistant || '';

  const ppResetNotice = document.getElementById('tvl-pp-reset-notice');
  if (ppResetNotice) ppResetNotice.style.display = passportReset ? 'block' : 'none';

  ['pp-validity-badge', 'pp-validity-note', 'pp-validity-info'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const expiryInput = document.getElementById('tvl-ppexp');
  if (expiryInput) expiryInput.style.borderColor = '';

  // Reset errors + consent
  document.querySelectorAll('#V-form input, #V-form select, #V-form textarea').forEach(clearFieldError);
  document.getElementById('tvl-pdpa-consent').checked = false;
  document.getElementById('tvl-form-error').style.display = 'none';

  document.getElementById('passport-upload-txt').textContent = 'Upload passport copy';
  document.getElementById('passport-upload-area').style.borderColor = '';
  _passportFile = null;
  const existingDiv = document.getElementById('passport-existing');
  if (existingDiv) existingDiv.style.display = slot?.has_passport ? '' : 'none';

  document.getElementById('visa-photo-upload-txt').textContent = 'Upload photo';
  document.getElementById('visa-photo-upload-area').style.borderColor = '';
  _visaPhotoFile = null;
  const visaExisting = document.getElementById('visa-photo-existing');
  if (visaExisting) visaExisting.style.display = slot?.has_visa_photo ? '' : 'none';
  // Badge pada header card Visa (card collapsible default tertutup —
  // badge beri tahu user visa photo sudah ada on file tanpa buka card).
  const visaBadge = document.getElementById('visa-photo-badge');
  if (visaBadge) visaBadge.style.display = slot?.has_visa_photo ? 'inline-block' : 'none';

  const editableInputs = document.querySelectorAll('#V-form input:not([readonly]), #V-form select, #V-form textarea');
  const confirmBtn = document.getElementById('tvl-confirm-btn');
  editableInputs.forEach(i => i.disabled = !canEdit);
  document.getElementById('passport-upload-area').disabled = !canEdit;
  document.getElementById('visa-photo-upload-area').disabled = !canEdit;
  if (confirmBtn) confirmBtn.style.display = canEdit ? '' : 'none';
  const sectionSaveBtns = document.querySelectorAll('.tvl-panel button');
  sectionSaveBtns.forEach(b => { if (/Save .* section/.test(b.textContent)) b.disabled = !canEdit; });

  if (!passportReset && slot?.passport_expiry) checkPassportValidity();

  tvlResetTabs();
  showTravellerView('V-form');
}

function syncFullName() {
  const first = (document.getElementById('tvl-firstname')?.value || '').trim();
  const last  = (document.getElementById('tvl-lastname')?.value  || '').trim();
  const nameEl = document.getElementById('tvl-name');
  if (nameEl) nameEl.value = [first, last].filter(Boolean).join(' ');
}

function checkPassportValidity() {
  const expiry = document.getElementById('tvl-ppexp')?.value;
  const badge = document.getElementById('pp-validity-badge');
  if (!expiry || !badge) return;

  const depDateStr = PORTAL_DATA?.booking?.departure_date || '';
  if (!depDateStr) return;

  const departure = new Date(depDateStr);
  const minValid = new Date(departure);
  minValid.setMonth(minValid.getMonth() + 6);
  const expiryDate = new Date(expiry);
  const isValid = expiryDate >= minValid;

  const fmtD = d => d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });

  badge.style.display = 'block';
  const note = document.getElementById('pp-validity-note');
  const infoBox = document.getElementById('pp-validity-info');
  const infoText = document.getElementById('pp-validity-info-text');
  if (note) note.style.display = 'block';
  if (infoBox) infoBox.style.display = 'block';
  const expiryInput = document.getElementById('tvl-ppexp');

  if (isValid) {
    badge.textContent = '✓ Valid';
    badge.style.background = '#DCFCE7'; badge.style.color = '#166534';
    if (note) { note.textContent = 'Passport is valid for this trip.'; note.style.color = '#166534'; }
    if (expiryInput) expiryInput.style.borderColor = '#86EFAC';
    if (infoText) infoText.innerHTML = 'Passport must be valid for at least <strong>6 months</strong> from departure <strong>' + fmtD(departure) + '</strong> — valid until at least <strong>' + fmtD(minValid) + '</strong>. ✓ Meets requirement.';
  } else {
    badge.textContent = '✗ Not valid';
    badge.style.background = '#FEE2E2'; badge.style.color = '#991B1B';
    if (note) { note.textContent = 'Must be valid until at least ' + fmtD(minValid) + '.'; note.style.color = '#991B1B'; }
    if (expiryInput) expiryInput.style.borderColor = '#FCA5A5';
    if (infoText) { infoText.innerHTML = 'Passport must be valid for at least <strong>6 months</strong> from departure <strong>' + fmtD(departure) + '</strong>. ✗ Passport expires too early — please renew before the trip.'; infoText.style.color = '#991B1B'; }
  }
}

/* ══════════════════════════════════════════════
   UPLOADS (keyboard-accessible button; inline error ganti alert)
   ══════════════════════════════════════════════ */

function _pickImage(onPicked, errBoxId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showInlineError(errBoxId, 'File must be under 5MB — "' + file.name + '" is ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.');
      return;
    }
    hideInlineError(errBoxId);
    onPicked(file);
  };
  input.click();
}

function triggerPassportUpload() {
  _pickImage(file => {
    _passportFile = file;
    document.getElementById('passport-upload-txt').textContent = '✓ ' + file.name;
    document.getElementById('passport-upload-area').style.borderColor = '#0F6E56';
  }, 'passport-upload-err');
}

function triggerVisaPhotoUpload() {
  _pickImage(file => {
    _visaPhotoFile = file;
    document.getElementById('visa-photo-upload-txt').textContent = '✓ ' + file.name;
    document.getElementById('visa-photo-upload-area').style.borderColor = '#0F6E56';
  }, 'visa-upload-err');
}

/* Visa Photo card — collapsible (opsional, default tertutup). */
function toggleVisaCard() {
  const body = document.getElementById('visa-photo-body');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  const chev = document.getElementById('visa-photo-chevron');
  if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
  const btn = document.getElementById('visa-photo-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'false' : 'true');
}

/* ══════════════════════════════════════════════
   SAVE — inline validation (ganti alert chain) + PDPA consent
   ══════════════════════════════════════════════ */

/* Simpan IKUT SECTION — hanya medan section berkenanan dihantar;
   server hanya sentuh medan section itu (tidak menimpa section lain). */
async function saveTraveller(section, btnEl) {
  const get = id => document.getElementById(id);

  const firstName = get('tvl-firstname').value.trim();
  const lastName  = get('tvl-lastname').value.trim();
  const phoneNum  = _getFullPhoneNumber(_itiPhone, get('tvl-phone-num'));
  const ecName    = get('tvl-ec-name').value.trim();
  const ecPhone   = _getFullPhoneNumber(_itiEcPhone, get('tvl-ec-phone'));
  const ecRel     = get('tvl-ec-relationship').value.trim();
  const ic        = get('tvl-ic').value.trim();
  const nat       = get('tvl-nat').value;
  const dob       = get('tvl-dob').value;
  const gender    = get('tvl-gender').value;
  const pp        = get('tvl-pp').value.trim();
  const ppexp     = get('tvl-ppexp').value;
  const consent   = get('tvl-pdpa-consent').checked;

  // Bersihkan error lama dulu.
  document.querySelectorAll('#V-form input, #V-form select').forEach(clearFieldError);
  get('tvl-form-error').style.display = 'none';

  const fail = (el, msg, tab) => {
    fieldError(el, msg);
    tvlGoToTab(tab);
    el.focus({ preventScroll: false });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  };

  // Validasi inline — hanya medan section berkenanan.
  if (section === 'passport') {
    if (!firstName) return fail(get('tvl-firstname'), 'First name is required.', 'passport');
    if (!lastName)  return fail(get('tvl-lastname'), 'Last name is required.', 'passport');
    if (!ic)        return fail(get('tvl-ic'), 'IC Number is required.', 'passport');
  }
  if (section === 'contact') {
    if (phoneNum && (typeof libphonenumber === 'undefined' || !libphonenumber.isValidPhoneNumber(phoneNum)))
      return fail(get('tvl-phone-num'), 'This does not look like a valid phone number. Please check the country code.', 'contact');
    // Emergency contact: kalau satu diisi, pasangannya mesti lengkap
    // (cermin check server-side).
    if ((ecName || ecPhone || ecRel) && (!ecName || !ecPhone || !ecRel)) {
      if (!ecName) return fail(get('tvl-ec-name'), 'Please complete the emergency contact (name, phone & relationship).', 'contact');
      if (!ecPhone) return fail(get('tvl-ec-phone'), 'Please complete the emergency contact (name, phone & relationship).', 'contact');
      return fail(get('tvl-ec-relationship'), 'Please complete the emergency contact (name, phone & relationship).', 'contact');
    }
    if (ecPhone && (typeof libphonenumber === 'undefined' || !libphonenumber.isValidPhoneNumber(ecPhone)))
      return fail(get('tvl-ec-phone'), 'This does not look like a valid phone number. Please check the country code.', 'contact');
  }

  // PDPA consent wajib untuk setiap simpanan.
  if (!consent) {
    fieldError(get('tvl-pdpa-consent'), 'Please accept the Privacy Notice to continue.');
    showInlineError('tvl-form-error', 'Please accept the Privacy Notice so we can store these details for your trip arrangements.');
    return;
  }

  const btn = btnEl || get('tvl-confirm-btn');
  const btnLabel = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  try {
    const readFile = f => new Promise(res => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.readAsDataURL(f);
    });

    let payload = {
      booking_number: BOOKING,
      slot_name: ACTIVE_SLOT.slot_name,
      section: section,
      pdpa_consent: true,
    };

    if (section === 'passport') {
      let filedata = '', filename = '';
      if (_passportFile) { filedata = await readFile(_passportFile); filename = _passportFile.name; }
      Object.assign(payload, {
        first_name: firstName, last_name: lastName,
        full_name: get('tvl-name').value.trim(),
        gender, ic_number: ic,
        date_of_birth: dob, nationality: nat,
        passport_no: pp, passport_expiry: ppexp,
        filedata, filename,
      });
    } else if (section === 'contact') {
      let visaFiledata = '', visaFilename = '';
      if (_visaPhotoFile) { visaFiledata = await readFile(_visaPhotoFile); visaFilename = _visaPhotoFile.name; }
      Object.assign(payload, {
        email: get('tvl-email').value || '',
        phone: phoneNum,
        emergency_contact_name: ecName,
        emergency_contact_phone: ecPhone,
        emergency_contact_relationship: ecRel,
        visa_filedata: visaFiledata, visa_filename: visaFilename,
      });
    } else {
      Object.assign(payload, {
        dietary_requirements: get('tvl-dietary').value.trim(),
        medical_conditions: get('tvl-medical').value.trim(),
        special_needs: get('tvl-special-needs').value.trim(),
        wheelchair_assistant: get('tvl-wheelchair').value,
        medicine_treatment: get('tvl-medicine').value.trim(),
      });
    }

    await API_TV('save_booking_traveller', payload);
    _sectionsSaved[section] = true;

    // Simpanan bertahap: kekal di page + tunjuk notis. Data disegar semula
    // supaya flag (has_passport dll.) dikemaskini — user boleh terus isi
    // bahagian lain atau tekan "← Back" bila dah selesai.
    const fresh = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = fresh;
    if (ACTIVE_SLOT) {
      const s = (fresh.slots || []).find(x => x.slot_name === ACTIVE_SLOT.slot_name);
      if (s) ACTIVE_SLOT = s;
    }
    if (section === 'passport') {
      _passportFile = null;
      document.getElementById('passport-upload-txt').textContent = 'Upload passport copy';
      const pe = document.getElementById('passport-existing');
      if (pe) pe.style.display = (ACTIVE_SLOT && ACTIVE_SLOT.has_passport) ? '' : 'none';
    }
    if (section === 'contact') {
      _visaPhotoFile = null;
      document.getElementById('visa-photo-upload-txt').textContent = 'Upload photo';
      const ve = document.getElementById('visa-photo-existing');
      if (ve) ve.style.display = (ACTIVE_SLOT && ACTIVE_SLOT.has_visa_photo) ? '' : 'none';
    }
    const note = document.getElementById('tvl-saved-note');
    if (note) {
      note.style.display = 'block';
      note.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { note.style.display = 'none'; }, 4000);
    }
  } catch (e) {
    showInlineError('tvl-form-error', e.message || 'An error occurred. Please try again.');
  } finally {
    if (btn) { btn.textContent = btnLabel; btn.disabled = false; }
  }
}

/* ══════════════════════════════════════════════
   BAR BAWAH — pengesahan akhir (maklumat lengkap)
   ══════════════════════════════════════════════ */

let _sectionsSaved = { passport: false, contact: false, health: false };

async function confirmTravellerDocs() {
  const get = id => document.getElementById(id);
  get('tvl-form-error').style.display = 'none';

  if (!ACTIVE_SLOT) return;

  // Pastikan ketiga-tiga section pernah disimpan sekurang-kurangnya sekali
  // dalam sesi ni (atau slot sudah terisi dari sesi sebelumnya).
  const notSaved = ['passport', 'contact', 'health'].filter(s => !_sectionsSaved[s]);
  if (notSaved.length && !ACTIVE_SLOT.filled) {
    showInlineError('tvl-form-error',
      'Please save every section (Passport, Contact Info, Health) before confirming.');
    return;
  }

  const btn = get('tvl-confirm-btn');
  btn.textContent = 'Confirming...';
  btn.disabled = true;
  try {
    await API_TV('confirm_traveller_documents', {
      booking_number: BOOKING,
      slot_name: ACTIVE_SLOT.slot_name,
    });
    tvlBackToList();
  } catch (e) {
    showInlineError('tvl-form-error', e.message || 'An error occurred. Please try again.');
    btn.textContent = '✓ I confirm all information is complete';
    btn.disabled = false;
  }
}

/* ══════════════════════════════════════════════
   TABS (port dari portal_traveller.js)
   ══════════════════════════════════════════════ */

const TVL_TAB_ORDER = ['passport', 'contact', 'health'];

function tvlShowTab(tabId) {
  if (!TVL_TAB_ORDER.includes(tabId)) return;
  // PANEL: visibility dikawal oleh CSS class (portal.css:
  // .tvl-panel{display:none} / .tvl-panel.on{display:block}) — BUKAN
  // inline style. Toggle class 'on' + clear inline style supaya edit
  // manual display:block/none dalam HTML tak menghalang CSS.
  document.querySelectorAll('.tvl-panel').forEach(p => {
    p.classList.toggle('on', p.getAttribute('data-panel') === tabId);
    p.style.display = '';
  });
  document.querySelectorAll('.tvl-tab').forEach(t => {
    const on = t.getAttribute('data-tab') === tabId;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  window.scrollTo(0, 0);
}

function tvlGoToTab(tabId) { tvlShowTab(tabId); }

function tvlNext(currentTabId) {
  const idx = TVL_TAB_ORDER.indexOf(currentTabId);
  if (idx === -1 || idx >= TVL_TAB_ORDER.length - 1) return;
  tvlShowTab(TVL_TAB_ORDER[idx + 1]);
}

function tvlBack(currentTabId) {
  const idx = TVL_TAB_ORDER.indexOf(currentTabId);
  if (idx <= 0) return;
  tvlShowTab(TVL_TAB_ORDER[idx - 1]);
}

function tvlResetTabs() { tvlShowTab('passport'); }

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();

  BOOKING = _pageData.booking_ref || '';
  if (!BOOKING) return;

  const isDocsPage = !!document.getElementById('V-form');

  // DOB tak boleh masa depan.
  const dobEl = document.getElementById('tvl-dob');
  if (dobEl) dobEl.max = new Date().toISOString().split('T')[0];

  // Butang pengesahan akhir (bar bawah).
  const confirmBtn = document.getElementById('tvl-confirm-btn');
  if (confirmBtn) confirmBtn.addEventListener('click', confirmTravellerDocs);

  try {
    const data = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = data;

    if (isDocsPage) {
      // Page docs: ?slot= menentukan slot yang diisi. Slot kosong →
      // Langkah 1 (upload passport); slot terisi → borang edit.
      // slot_name boleh datang dari pageData Jinja ATAU URL (belt & braces).
      let slotName = _pageData.slot_name || '';
      if (!slotName) {
        try { slotName = new URLSearchParams(window.location.search).get('slot') || ''; } catch (e) { slotName = ''; }
      }
      const slot = (PORTAL_DATA.slots || []).find(s => s.slot_name === slotName);
      if (!slot) {
        tvlBackToList();
        return;
      }
      ACTIVE_SLOT = slot;
      _passportFile = null;
      _visaPhotoFile = null;
      // Slot kosong (traveller belum ada pada Booking Reservation): WAJIB
      // mula dengan Langkah 1 — upload passport untuk semakan readable +
      // ekstraksi data + matching traveller terdahulu. Slot sudah terisi
      // → terus borang (edit semula).
      if (slot.filled) {
        _loadTravellerForm(slot);
      } else {
        showTravellerView('V-wizard');
      }
    } else {
      renderTravellerSlots(data);
    }
  } catch (e) {
    const listContainer = document.getElementById('traveller-slots-container');
    if (listContainer) {
      listContainer.innerHTML =
        '<div class="card" style="text-align:center;padding:32px 20px;">' +
          '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">' + _esc(e.message || 'Failed to load travellers.') + '</div>' +
          '<a href="/traveller_portal/bookings" class="btn btn-g" style="text-decoration:none;display:inline-block;font-size:12px;">← Back to My Bookings</a>' +
        '</div>';
    }
  }
});
