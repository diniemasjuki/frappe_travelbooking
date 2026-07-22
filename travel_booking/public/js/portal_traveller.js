/* ============================================================
   travel_booking/public/js/portal_traveller.js
   Traveller form, Save, Passport upload, Validity check
   ============================================================ */

async function _loadTravellerForm(slot, passportReset = false) {
  // Load countries dropdown; pastikan intl-tel-input dah initialize
  // (form traveller boleh dibuka berkali-kali secara dinamik — panggilan
  // kedua dst. di _initPhoneWidgets() adalah no-op, sebab dah check
  // _itiPhone/_itiEcPhone dulu sebelum initialize semula).
  await loadCountries();
  _initPhoneWidgets();

  const isVerified      = slot && (slot.is_verified || slot.document_status === 'Verified');
  const isOpenForUpdate = slot && slot.document_status === 'Open for Update';
  const isRejected      = slot && slot.document_status === 'Rejected';
  const canEdit         = !isVerified || isOpenForUpdate || isRejected;

  document.getElementById('tvl-form-breadcrumb').textContent =
    `${ACTIVE_SLOT.slot_label} · ${BOOKING}`;

  document.getElementById('tvl-ic').value        = slot?.ic_number      || '';
  document.getElementById('tvl-firstname').value = slot?.first_name     || '';
  document.getElementById('tvl-lastname').value  = slot?.last_name      || '';
  document.getElementById('tvl-name').value      = slot?.full_name      || '';
  document.getElementById('tvl-dob').value       = slot?.date_of_birth  || '';
  document.getElementById('tvl-nat').value       = slot?.nationality    || '';
  document.getElementById('tvl-gender').value    = slot?.gender         || '';

  // Phone dan Emergency Phone — set melalui intl-tel-input punya setNumber()
  // (terima nombor PENUH format "+60123456789", library sendiri pecahkan
  // dial-code + baki digit dan papar bendera yang betul).
  _setPhoneValue(_itiPhone, 'tvl-phone-num', slot?.phone);
  _setPhoneValue(_itiEcPhone, 'tvl-ec-phone', slot?.emergency_contact_phone);

  document.getElementById('tvl-email').value = slot?.email         || '';
  document.getElementById('tvl-pp').value    = passportReset ? '' : (slot?.passport_no    || '');
  document.getElementById('tvl-ppexp').value = passportReset ? '' : (slot?.passport_expiry || '');

  // Emergency contact (Tab 2) & Health/Medication (Tab 3) — field sedia
  // ada dalam doctype Traveller, baru ditambah ke UI/form.
  document.getElementById('tvl-ec-name').value         = slot?.emergency_contact_name         || '';
  document.getElementById('tvl-ec-relationship').value = slot?.emergency_contact_relationship || '';
  document.getElementById('tvl-dietary').value       = slot?.dietary_requirements || '';
  document.getElementById('tvl-medical').value       = slot?.medical_conditions  || '';
  document.getElementById('tvl-special-needs').value = slot?.special_needs      || '';

  // Passport reset notice
  const ppResetNotice = document.getElementById('tvl-pp-reset-notice');
  if (ppResetNotice) ppResetNotice.style.display = passportReset ? 'block' : 'none';

  // Reset validity badge
  ['pp-validity-badge','pp-validity-note','pp-validity-info'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const expiryInput = document.getElementById('tvl-ppexp');
  if (expiryInput) expiryInput.style.borderColor = '';

  if (!passportReset && slot?.passport_expiry) checkPassportValidity();

  // IC lookup result reset
  const icLookup = document.getElementById('ic-lookup-result');
  if (icLookup) icLookup.style.display = 'none';

  // Passport upload reset
  document.getElementById('passport-upload-txt').textContent = 'Upload passport copy';
  document.getElementById('passport-upload-area').style.borderColor = '';
  _passportFile = null;
  const existingDiv = document.getElementById('passport-existing');
  if (existingDiv) existingDiv.style.display = slot?.has_passport ? '' : 'none';

  // Visa photo upload reset
  document.getElementById('visa-photo-upload-txt').textContent = 'Upload photo';
  document.getElementById('visa-photo-upload-area').style.borderColor = '';
  _visaPhotoFile = null;
  const visaExistingDiv = document.getElementById('visa-photo-existing');
  if (visaExistingDiv) visaExistingDiv.style.display = slot?.has_visa_photo ? '' : 'none';

  // Lock/unlock form
  const editableInputs = document.querySelectorAll('#S-traveller-form input:not([readonly]), #S-traveller-form select, #S-traveller-form textarea');
  const saveBtn = document.getElementById('tvl-save-btn');
  if (!canEdit) {
    editableInputs.forEach(i => i.disabled = true);
    document.getElementById('passport-upload-area').style.pointerEvents = 'none';
    document.getElementById('visa-photo-upload-area').style.pointerEvents = 'none';
    saveBtn.style.display = 'none';
  } else {
    editableInputs.forEach(i => i.disabled = false);
    document.getElementById('passport-upload-area').style.pointerEvents = '';
    document.getElementById('visa-photo-upload-area').style.pointerEvents = '';
    saveBtn.style.display = '';
  }

  tvlResetTabs();
  sw('S-traveller-form');
}

function syncFullName() {
  const first = (document.getElementById('tvl-firstname')?.value || '').trim();
  const last  = (document.getElementById('tvl-lastname')?.value  || '').trim();
  const nameEl = document.getElementById('tvl-name');
  if (nameEl) nameEl.value = [first, last].filter(Boolean).join(' ');
}

function checkPassportValidity() {
  const expiry      = document.getElementById('tvl-ppexp')?.value;
  const badge       = document.getElementById('pp-validity-badge');
  const note        = document.getElementById('pp-validity-note');
  const infoBox     = document.getElementById('pp-validity-info');
  const infoText    = document.getElementById('pp-validity-info-text');
  const expiryInput = document.getElementById('tvl-ppexp');

  if (!expiry || !badge) return;

  const depDateStr = PORTAL_DATA?.booking?.departure_date || '';
  if (!depDateStr) return;

  const departure  = new Date(depDateStr);
  const minValid   = new Date(departure);
  minValid.setMonth(minValid.getMonth() + 6);
  const expiryDate = new Date(expiry);
  const isValid    = expiryDate >= minValid;

  const fmt = d => d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });

  badge.style.display = note.style.display = 'block';
  if (infoBox) infoBox.style.display = 'block';

  if (isValid) {
    badge.textContent = '✓ Valid';
    badge.style.background = '#DCFCE7'; badge.style.color = '#166534';
    note.textContent = 'Passport is valid for this trip.'; note.style.color = '#166534';
    expiryInput.style.borderColor = '#86EFAC';
    if (infoText) infoText.innerHTML = `Passport must be valid for at least <strong>6 months</strong> from departure <strong>${fmt(departure)}</strong> — valid until at least <strong>${fmt(minValid)}</strong>. ✓ Meets requirement.`;
  } else {
    badge.textContent = '✗ Not valid';
    badge.style.background = '#FEE2E2'; badge.style.color = '#991B1B';
    note.textContent = `Must be valid until at least ${fmt(minValid)}.`; note.style.color = '#991B1B';
    expiryInput.style.borderColor = '#FCA5A5';
    if (infoText) { infoText.innerHTML = `Passport must be valid for at least <strong>6 months</strong> from departure <strong>${fmt(departure)}</strong> — valid until at least <strong>${fmt(minValid)}</strong>. ✗ Passport expires too early.`; infoText.style.color = '#991B1B'; }
  }
}

function triggerPassportUpload() {
  const status  = ACTIVE_SLOT?.document_status;
  const blocked = (status === 'Verified' || ACTIVE_SLOT?.is_verified)
                  && status !== 'Open for Update'
                  && status !== 'Rejected';
  if (blocked) return;

  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = '.jpg,.jpeg,.png';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File size must be under 5MB.'); return; }
    _passportFile = file;
    document.getElementById('passport-upload-txt').textContent = `✓ ${file.name}`;
    document.getElementById('passport-upload-area').style.borderColor = '#0F6E56';
  };
  input.click();
}

function triggerVisaPhotoUpload() {
  const status = ACTIVE_SLOT?.document_status;
  const blocked = (status === 'Verified' || ACTIVE_SLOT?.is_verified)
                  && status !== 'Open for Update'
                  && status !== 'Rejected';
  if (blocked) return;

  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = '.jpg,.jpeg,.png';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File size must be under 5MB.'); return; }
    _visaPhotoFile = file;
    document.getElementById('visa-photo-upload-txt').textContent = `✓ ${file.name}`;
    document.getElementById('visa-photo-upload-area').style.borderColor = '#0F6E56';
  };
  input.click();
}

async function saveTraveller() {
  const ic        = document.getElementById('tvl-ic').value.trim();
  const firstName = document.getElementById('tvl-firstname').value.trim();
  const lastName  = document.getElementById('tvl-lastname').value.trim();
  const name      = document.getElementById('tvl-name').value.trim();
  const gender    = document.getElementById('tvl-gender').value;
  const dob       = document.getElementById('tvl-dob').value;
  const nat       = document.getElementById('tvl-nat').value.trim();
  const pp        = document.getElementById('tvl-pp').value.trim();
  const ppexp     = document.getElementById('tvl-ppexp').value;
  const phoneNum  = _getFullPhoneNumber(_itiPhone, document.getElementById('tvl-phone-num'));
  const ecName    = document.getElementById('tvl-ec-name').value.trim();
  const ecPhone   = _getFullPhoneNumber(_itiEcPhone, document.getElementById('tvl-ec-phone'));
  const ecRel     = document.getElementById('tvl-ec-relationship').value.trim();

  // Wajib: Traveller Info (nama + emergency contact) + Passport (IC,
  // nationality, DOB, gender, passport no/expiry). Email/Phone (Contact) dan
  // Health (Dietary/Medical/Special Needs) KEKAL opsyenal.
  if (!firstName) { alert('First name is required.'); tvlGoToTab('info'); return; }
  if (!lastName)  { alert('Last name is required.'); tvlGoToTab('info'); return; }

  // Phone (Contact) OPSYENAL, tapi kalau diisi, mesti SAH ikut
  // libphonenumber-js (metadata penuh, SAMA ketat dengan library Python
  // 'phonenumbers' yang Frappe check semasa save) — elak customer submit
  // borang penuh, baru kena error backend "is not valid".
  if (phoneNum) {
    if (typeof libphonenumber === 'undefined' || !libphonenumber.isValidPhoneNumber(phoneNum)) {
      alert('Phone number "' + phoneNum + '" does not look like a valid number. Please check the country code and number.');
      tvlGoToTab('info');
      return;
    }
  }

  if (!ecName)    { alert('Emergency contact name is required.'); tvlGoToTab('info'); return; }
  if (!ecPhone)   { alert('Emergency contact phone is required.'); tvlGoToTab('info'); return; }
  if (typeof libphonenumber === 'undefined' || !libphonenumber.isValidPhoneNumber(ecPhone)) {
    alert('Emergency contact phone "' + ecPhone + '" does not look like a valid number. Please check the country code and number.');
    tvlGoToTab('info');
    return;
  }
  if (!ecRel)     { alert('Emergency contact relationship is required.'); tvlGoToTab('info'); return; }
  if (!ic)        { alert('IC Number is required.'); tvlGoToTab('passport'); return; }
  if (!nat)       { alert('Nationality is required.'); tvlGoToTab('passport'); return; }
  if (!dob)       { alert('Date of birth is required.'); tvlGoToTab('passport'); return; }
  if (!gender)    { alert('Please select gender.'); tvlGoToTab('passport'); return; }
  if (!pp)        { alert('Passport number is required.'); tvlGoToTab('passport'); return; }
  if (!ppexp)     { alert('Passport expiry date is required.'); tvlGoToTab('passport'); return; }

  const btn = document.getElementById('tvl-save-btn');
  btn.textContent = 'Saving...';
  btn.disabled    = true;

  try {
    let filedata = '', filename = '';
    if (_passportFile) {
      filedata = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.readAsDataURL(_passportFile);
      });
      filename = _passportFile.name;
    }

    // Visa photo — sebelum ni _visaPhotoFile diisi semasa upload tapi TAK
    // PERNAH dibaca semula di sini, jadi visa photo upload tak berfungsi
    // langsung. Dibetulkan sekali dengan patch tab Health/Emergency Contact.
    let visaFiledata = '', visaFilename = '';
    if (_visaPhotoFile) {
      visaFiledata = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.readAsDataURL(_visaPhotoFile);
      });
      visaFilename = _visaPhotoFile.name;
    }

    const result = await API_TV('save_booking_traveller', {
      booking_number:  BOOKING,
      slot_name:       ACTIVE_SLOT.slot_name,
      age_category:    ACTIVE_SLOT.age_category,
      first_name:      firstName,
      last_name:       lastName,
      full_name:       name,
      gender, ic_number: ic,
      date_of_birth:   dob,
      nationality:     nat,
      passport_no:     pp,
      passport_expiry: ppexp,
      email:           document.getElementById('tvl-email').value || '',
      phone: phoneNum, filedata, filename,
      visa_filedata: visaFiledata, visa_filename: visaFilename,
      emergency_contact_name:         ecName,
      emergency_contact_phone:        ecPhone,
      emergency_contact_relationship: ecRel,
      dietary_requirements: document.getElementById('tvl-dietary').value.trim(),
      medical_conditions:   document.getElementById('tvl-medical').value.trim(),
      special_needs:        document.getElementById('tvl-special-needs').value.trim(),
    });

    const freshData = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = freshData;
    _CACHE.set('booking_' + BOOKING, freshData, _CACHE.TTL.booking);

    if (SESSION && SESSION.bookings) {
      const idx = SESSION.bookings.findIndex(b => (b.booking_number || b.name) === BOOKING);
      if (idx >= 0) {
        SESSION.bookings[idx].filled_count = (freshData.slots || []).filter(s => s.filled).length;
        SESSION.bookings[idx].pax_assigned = result.all_filled ? 1 : 0;
      }
    }

    goBackToPortal();
  } catch (e) {
    alert(e.message || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Save traveller →';
    btn.disabled    = false;
  }
}

/* ══════════════════════════════════════════════
   CUSTOM PHONE PICKER
   ══════════════════════════════════════════════ */

/* intl-tel-input — SAMA library dengan fieldtype "Phone" di Frappe Desk
   (rujuk source: jackocnr/intl-tel-input), gantikan widget custom kita
   sepenuhnya. Dipasang pada KEDUA-DUA field (Phone dan Emergency Phone)
   supaya konsisten — sebelum ni Phone guna dropdown custom, Emergency
   Phone cuma <input> polos tanpa dial-code selector. */
let _itiPhone   = null;
let _itiEcPhone = null;

function _initPhoneWidgets() {
  if (typeof window.intlTelInput === 'undefined') {
    console.warn('intl-tel-input tidak dimuatkan; field phone jatuh balik ke <input> biasa.');
    return;
  }
  const opts = {
    initialCountry: "my",
    separateDialCode: true,
    utilsScript: undefined, // sudah termasuk dalam bundle intlTelInputWithUtils
  };
  const phoneEl = document.getElementById('tvl-phone-num');
  if (phoneEl && !_itiPhone) _itiPhone = window.intlTelInput(phoneEl, opts);

  const ecPhoneEl = document.getElementById('tvl-ec-phone');
  if (ecPhoneEl && !_itiEcPhone) _itiEcPhone = window.intlTelInput(ecPhoneEl, opts);
}

// Nombor PENUH format E.164 (cth "+60123456789") untuk validate/submit —
// guna method getNumber() bawaan intl-tel-input (dial-code + digit
// digabung automatik), bukan gabung manual macam widget custom sebelum ni.
function _getFullPhoneNumber(iti, fallbackEl) {
  if (iti) return iti.getNumber().trim();
  return (fallbackEl?.value || '').trim();
}

// Set nombor (format PENUH "+60123456789") ke widget intl-tel-input.
// Jatuh balik ke <input>.value terus kalau widget belum initialize
// (contoh: intl-tel-input punya CDN gagal load) — elak field kosong senyap.
function _setPhoneValue(iti, elId, rawValue) {
  const el = document.getElementById(elId);
  if (!rawValue) {
    if (iti) iti.setNumber('');
    else if (el) el.value = '';
    return;
  }
  if (iti) iti.setNumber(rawValue);
  else if (el) el.value = rawValue;
}

document.addEventListener('DOMContentLoaded', _initPhoneWidgets);
// Traveller form boleh dibuka selepas DOMContentLoaded sedia berlaku
// (contoh: dibuka semula guna JS routing, bukan full page reload) —
// panggil sekali lagi bila borang traveller dipaparkan.
document.addEventListener('tvl-form-shown', _initPhoneWidgets);

/* ══════════════════════════════════════════════
   NATIONALITY SELECT — dari Frappe tabCountry
   ══════════════════════════════════════════════ */

let _countriesLoaded = false;

async function loadCountries() {
  if (_countriesLoaded) return;
  try {
    const countries = await API_TV('get_countries', {});
    if (!countries || !countries.length) { _countriesLoaded = true; return; }

    const sel = document.getElementById('tvl-nat');
    if (sel) {
      const current = sel.value || '';
      sel.innerHTML = '<option value="">Select nationality</option>' +
        countries.map(c =>
          `<option value="${c.name}">${c.country_name || c.name}</option>`
        ).join('');
      if (current) sel.value = current;
    }
    _countriesLoaded = true;
  } catch (e) {
    console.warn('loadCountries failed:', e);
    _countriesLoaded = true;
  }
}

/* ============================================================
   TRAVELLER FORM TABS
   Pills di atas boleh diklik terus (jump ke mana-mana tab), dan
   butang Next/Back di bawah setiap tab navigate berturutan mengikut
   TVL_TAB_ORDER. Kedua-dua cara guna function yang sama (tvlShowTab).
   HANYA tab semasa yang diwarna (.on) — tab lain kekal neutral, tak
   kira sama ada pernah dilawat atau tidak.
   ============================================================ */

const TVL_TAB_ORDER = ['info', 'passport', 'visa', 'health'];

function tvlShowTab(tabId) {
  if (!TVL_TAB_ORDER.includes(tabId)) return;

  document.querySelectorAll('.tvl-panel').forEach(function(panel) {
    panel.classList.toggle('on', panel.getAttribute('data-panel') === tabId);
  });

  document.querySelectorAll('.tvl-tab').forEach(function(tab) {
    tab.classList.toggle('on', tab.getAttribute('data-tab') === tabId);
  });

  window.scrollTo(0, 0);
}

// Dipanggil terus dari klik pill — boleh jump ke mana-mana tab tanpa
// perlu ikut urutan (contoh terus dari 'info' ke 'passport').
function tvlGoToTab(tabId) {
  tvlShowTab(tabId);
}

// Dipanggil dari butang "Next: ... →" di bawah setiap tab — ikut
// TVL_TAB_ORDER secara berturutan.
function tvlNext(currentTabId) {
  var idx = TVL_TAB_ORDER.indexOf(currentTabId);
  if (idx === -1 || idx >= TVL_TAB_ORDER.length - 1) return;
  tvlShowTab(TVL_TAB_ORDER[idx + 1]);
}

// Dipanggil dari butang "← Back" di bawah setiap tab (kecuali tab
// pertama, yang guna "Cancel" terus ke goBackToPortal()).
function tvlBack(currentTabId) {
  var idx = TVL_TAB_ORDER.indexOf(currentTabId);
  if (idx <= 0) return;
  tvlShowTab(TVL_TAB_ORDER[idx - 1]);
}

// Reset tab ke keadaan awal (panggil bila form traveller baru dibuka,
// supaya customer sentiasa mula dari tab 'info', bukan tab terakhir
// dari sesi sebelumnya).
function tvlResetTabs() {
  tvlShowTab('info');
}