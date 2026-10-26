/* ============================================================
   travel_booking/public/js/portal_traveller_page.js
   Page: /guest_passport?token=... (borang SATU PAGE — Passport,
   Contact Info & Health dalam borang yang sama; user isi semuanya
   sehingga lengkap, tick consent PDPA dan tekan butang Submit —
   submitTraveller() hantar SEMUA section dalam SATU panggilan API &
   confirm sekali).

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

/* Mod guest: co-traveller isi maklumat sendiri via token link (no session).
   Dipasang dari _pageData.mode === 'guest' (page guest_passport.html).
   Bila true, API call bercabang: verify_guest_token / save_booking_traveller
   (dgn guest_token) / get_guest_file / confirm_traveller_documents (dgn
   guest_token). */
let _GUEST_MODE  = false;
let _GUEST_TOKEN = '';

/* ── Navigasi antara 2 page: senarai slot (booking_traveller) dan
   aliran dokumen (booking_traveller/docs?ref=..&slot=..) ── */
function tvlDocsUrl(slotName) {
  return '/traveller/booking_traveller/docs?ref=' + encodeURIComponent(BOOKING) +
         '&slot=' + encodeURIComponent(slotName);
}

function tvlBackToList() {
  window.location.href = '/traveller/booking_traveller?ref=' + encodeURIComponent(BOOKING);
}

/* ── Papar borang docs & sembunyikan loading indicator.
   (Wizard Langkah 1 telah dibuang — imbasan berlaku in-place di
   section Passport Copy.) ── */
function _showDocsForm() {
  const form = document.getElementById('V-form');
  if (form) form.style.display = '';
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

  // data-slot pada baris utama (bukan wrapper) supaya klik pada baris
  // guest-link (email/button) tak membuka borang traveller.
  const rowBase = 'data-slot="' + _esc(slot.slot_name) + '" style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;background:#fff;"';

  let mainRow;
  if (isFilled) {
    const name = slot.full_name || '';
    const parts = name.trim().split(' ');
    const initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();

    const badge = isVerified
      ? { bg: '#EBF7F1', fg: '#0F6E56', txt: 'Verified' }
      : isOpenForUpd
        ? { bg: '#EDE9FE', fg: '#5B21B6', txt: 'Update Needed' }
        : { bg: '#FEF3C7', fg: '#92400E', txt: 'Pending' };

    const requestLink = isVerified
      ? '<button type="button" onclick="event.stopPropagation();requestDocumentUpdate(\'' + _esc(slot.slot_name) + '\')" ' +
        'style="background:none;border:none;padding:0;font-size:11px;color:#7D7A70;text-decoration:underline;cursor:pointer;white-space:nowrap;">Request to edit</button>'
      : '';

    mainRow =
      '<div class="slot-card" ' + rowBase + '>' +
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
      '</div>';
  } else {
    mainRow =
      '<div class="slot-card slot-empty" ' + rowBase + '>' +
        '<div style="width:38px;height:38px;border-radius:50%;border:1.5px dashed #D4D1CC;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;font-weight:300;color:#B0AC9F;">+</div>' +
        '<div style="flex:1;">' +
          '<div style="font-size:10px;font-weight:700;color:#B0AC9F;letter-spacing:.07em;text-transform:uppercase;margin-bottom:2px;">' + _esc(slot.slot_label) + '</div>' +
          '<div style="font-size:13px;color:#7D7A70;">Not filled yet</div>' +
          '<div style="font-size:11px;color:#B0AC9F;margin-top:1px;">Tap to fill in traveller details</div>' +
        '</div>' +
        '<div style="color:#B0AC9F;font-size:16px;flex-shrink:0;">›</div>' +
      '</div>';
  }

  // (a) "Share me" — guest-link trigger: customer jana link utk co-traveller
  // (guest, no login) dan kongsi terus (WhatsApp / Web Share / salin).
  // Mengetik email menyebalkan; orang sekarang kongsi link via WhatsApp.
  // Hanya untuk slot yang belum Verified (slot locked tak boleh diubah).
  const guestRow = isVerified ? '' : (
    '<div class="slot-guest-link" onclick="event.stopPropagation()" style="border-top:0.5px solid #EAE7E0;padding:10px 16px;background:#FAFAF7;">' +
      '<div style="font-size:11px;color:#7D7A70;margin-bottom:6px;">Co-traveller? Share a secure link so they can fill in their own details:</div>' +
      '<button type="button" class="btn btn-g btn-sm" onclick="shareGuestPassportLink(\'' + _esc(slot.slot_name) + '\', this)" style="width:100%;">\uD83D\uDD17 Share passport link</button>' +
      '<div class="guest-link-status" style="font-size:11px;margin-top:6px;display:none;"></div>' +
    '</div>'
  );

  return '<div style="background:#fff;">' + mainRow + guestRow + '</div>';
}

/* FIX AUDIT (dead click): slot Verified klik → mesej jelas, bukan return
   senyap. Slot "Open for Update" KEKAL BOLEH DIEDIT — selari workflow
   doctype Traveller (Open for Update → traveller isi semula → Pending
   Verification) dan laluan borang docs/guest link/API yang hanya
   mengunci "Verified". */
function openTravellerForm(slotName) {
  if (!PORTAL_DATA) return;
  const slot = (PORTAL_DATA.slots || []).find(s => s.slot_name === slotName);
  if (!slot) return;

  const isVerified = slot.is_verified || slot.document_status === 'Verified';

  if (isVerified) {
    const notice = document.getElementById('tvl-locked-notice');
    document.getElementById('tvl-locked-notice-text').innerHTML =
      '<strong>' + _esc(slot.full_name || slot.slot_label) + '</strong> has been verified by our team and is locked. ' +
      'Need a correction? Use the "Request to edit" link on the card.';
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
  const ok = confirm('Request to edit this traveller\'s details?\n\nThe slot will be unlocked for editing. Please resubmit after making changes — our team will re-verify your documents.');
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
   IMBASAN PASSPORT (in-place di section Passport Copy)
   (gambar passport → check return customer → prefill)
   ══════════════════════════════════════════════ */

let _wizardResult   = null;   // data traveller dari check_traveller_passport
let _wizardExtracted = null; // medan yang berjaya dibaca dari passport (OCR/MRZ)
let _wizardFile     = null;   // File passport yang dipilih untuk imbasan

/* ── Badge enjin scan (AI vs OCR) — dari konfigurasi server (pageData).
   Dipaparkan di section Passport Copy. ── */
function renderEngineBadge() {
  const badge = document.getElementById('pp-engine-badge');
  if (!badge) return;
  // Statement pengiklanan enjin AI dibuang dari UI — bila enjin AI aktif
  // badge TIDAK dipapar terus (tak melabel enjin sebagai OCR yang salah).
  if (typeof _pageData !== 'undefined' && _pageData && _pageData.ai_scan_enabled) {
    badge.style.display = 'none';
    return;
  }
  badge.textContent = 'OCR (Image + MRZ) scanning';
  badge.style.color = '#633806';
  badge.style.background = '#FAEEDA';
  badge.style.display = 'inline-block';
  badge.style.padding = '4px 12px';
  badge.style.borderRadius = '12px';
}

/* Label enjin ikut respons server ("ai" / "ai+ocr" / "ocr" / "pdf-text"
   / "ai+pdf-text"). */
function _engineLabel(engine) {
  if (engine === 'ai') return '🤖 Scanned with AI';
  if (engine === 'ai+ocr') return '🤖 Scanned with AI + OCR (Image + MRZ)';
  if (engine === 'pdf-text') return 'Read from embedded PDF text';
  if (engine === 'ai+pdf-text') return '🤖 Scanned with AI + embedded PDF text';
  return 'Scanned with OCR (Image + MRZ)';
}


/* ── Blocking scan progress modal — menghalang user daripada mengganggu
   proses AI/OCR scan passport. ── */
function _showPassportScanProgress(engineLabel) {
  _hidePassportScanProgress();
  var overlay = document.createElement('div');
  overlay.id = 'rc-passport-scan-progress';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(30,28,24,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;';
  overlay.innerHTML =
    '<div style="background:#fff;border-radius:14px;padding:36px 28px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(30,28,24,.35);text-align:center;font-family:inherit;">' +
      '<div style="font-size:42px;margin-bottom:14px;animation:rcPassSpin2 1s linear infinite;display:inline-block;">⏳</div>' +
      '<div style="font-size:15px;font-weight:700;color:#1E1C18;margin-bottom:6px;">' + _esc(engineLabel || 'Scanning passport with AI...') + '</div>' +
      '<div style="font-size:12.5px;color:#6E6A5F;line-height:1.5;">Please wait while we read your passport. Do not close or refresh this page.</div>' +
    '</div>' +
    '<style>@keyframes rcPassSpin2 { to { transform: rotate(360deg); } }</style>';
  document.body.appendChild(overlay);
}

function _hidePassportScanProgress() {
  var el = document.getElementById('rc-passport-scan-progress');
  if (el) el.remove();
}

/* Ringkasan medan berjaya dibaca dari passport (kongsi wizard + scan Tab 1). */
function _wizReadRows(ex) {
  const readRows = [];
  if (ex.full_name)        readRows.push('Name: ' + ex.full_name);
  if (ex.passport_no)      readRows.push('Passport no: ' + ex.passport_no);
  readRows.push('IC / National ID: ' + (ex.ic_number || 'not detected — please fill in'));
  if (ex.gender)           readRows.push('Gender: ' + ex.gender);
  if (ex.nationality)      readRows.push('Nationality: ' + ex.nationality);
  if (ex.date_of_birth)    readRows.push('Date of birth: ' + ex.date_of_birth);
  if (ex.passport_expiry)  readRows.push('Passport expiry: ' + ex.passport_expiry);
  return readRows;
}

/* Fail passport yang discan dibawa masuk ke tab Passport pada form —
   user tak perlu pilih fail sekali lagi. */
function _applyWizardPassportFile() {
  if (!_wizardFile) return;
  _passportFile = _wizardFile;
  document.getElementById('passport-upload-txt').textContent = '✓ ' + _wizardFile.name;
  document.getElementById('passport-upload-area').style.borderColor = '#0F6E56';
  _showLocalPassportPreview(_wizardFile);
}

/* ── AUTO-SCAN di Tab 1 (section Passport Copy) ──
   Upload terus dalam borang turut mengimbas — hasil dipapar in-place
   (kad found / ringkasan medan dibaca / amaran unreadable) TANPA melompat
   ke wizard. State _wizardFile/_wizardResult/_wizardExtracted dikongsi
   supaya wizardConfirm() (found) boleh diguna semula seadanya. */
function _scanFormPassport(file) {
  const box = document.getElementById('passport-scan-result');
  if (!box) return;
  const aiEnabled = typeof _pageData !== 'undefined' && _pageData && _pageData.ai_scan_enabled;
  _wizardFile = file;
  _wizardResult = null;
  _wizardExtracted = null;
  box.style.display = 'none';
  box.innerHTML = '';
  _showPassportScanProgress(aiEnabled ? 'Scanning passport with AI...' : 'Scanning passport (Image + MRZ OCR)...');

  const showBox = (html) => { box.innerHTML = html; box.style.display = 'block'; };
  const warnHtml = (msg) =>
    '<div style="padding:12px 14px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;font-size:12px;color:#92400E;line-height:1.6;">' +
    _esc(msg) + '</div>';

  (async () => {
    try {
      const readFile = f => new Promise(res => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.readAsDataURL(f);
      });
      const filedata = await readFile(file);
      const payload = { filedata: filedata };
      if (_GUEST_MODE) payload.guest_token = _GUEST_TOKEN;
      const res = await API_TV('check_traveller_passport', payload);
      _hidePassportScanProgress();
      _wizardExtracted = res.extracted || null;

      if (res.status === 'unreadable') {
        showBox(warnHtml('We could not read this passport image. Please upload a clearer photo of the passport photo page — all four corners visible, no glare, text sharp.'));
        return;
      }

      if (res.status === 'found' && res.data) {
        _wizardResult = res.data;
        const fullName = res.data.full_name || '';
        showBox(
          '<div style="display:flex;align-items:center;gap:14px;padding:14px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;">' +
            '<div style="width:44px;height:44px;border-radius:50%;background:#DCFCE7;color:#166534;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + _esc((fullName.trim().charAt(0) || '?').toUpperCase()) + '</div>' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:11px;font-weight:700;color:#0F6E56;letter-spacing:.05em;text-transform:uppercase;margin-bottom:2px;">Return customer found</div>' +
              '<div style="font-size:15px;font-weight:600;color:#1E1C18;">' + _esc(fullName) + '</div>' +
              '<div style="font-size:12px;color:#7D7A70;margin-top:2px;">IC: ' + _esc(res.data.ic_number || '') + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:10px;margin-top:12px;">' +
            '<button type="button" class="btn btn-p" style="flex:1;" onclick="wizardConfirm()">Yes, this is me →</button>' +
          '</div>' +
          '<div style="display:flex;gap:10px;margin-top:8px;">' +
            '<button type="button" class="btn btn-g" style="flex:1;" onclick="_applyScanToForm()">⤓ Use scanned data only</button>' +
            '<button type="button" class="btn btn-g" style="flex:1;" onclick="_dismissFormScan()">Not me / wrong photo</button>' +
          '</div>');
        return;
      }

      // New traveller — auto-isi medan kosong sahaja, kemudian tunjuk
      // ringkasan + butang untuk timpa (overwrite) medan borang secara
      // eksplisit dengan nilai hasil scan.
      const ex = res.extracted || {};
      _prefillFormFromExtracted(ex, false);
      const rows = _wizReadRows(ex);
      showBox(
        '<div style="padding:12px 14px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;">' +
          '<div style="font-size:11px;font-weight:700;color:#1E40AF;letter-spacing:.05em;text-transform:uppercase;">✓ Read from passport — ' + _esc(_engineLabel(res.engine)) + '</div>' +
          '<div style="font-size:12px;color:#1E1C18;line-height:1.7;margin-top:4px;">' +
            rows.map(r => '• ' + _esc(r)).join('<br>') + '</div>' +
          '<div style="font-size:11px;color:#7D7A70;margin-top:6px;">Empty fields were filled automatically. To replace the form values with the scanned data, use overwrite.</div>' +
          '<div style="display:flex;gap:10px;margin-top:12px;">' +
            '<button type="button" class="btn btn-p" style="flex:1;" onclick="_applyScanToForm()">⤓ Overwrite form with scanned data</button>' +
            '<button type="button" class="btn btn-g" onclick="_dismissFormScan()">✓ Done</button>' +
          '</div>' +
        '</div>');
    } catch (e) {
      _hidePassportScanProgress();
      showBox(warnHtml(e.message || 'Something went wrong while scanning. Please try again.'));
    }
  })();
}

/* Pra-isi borang dari hasil scan.
   overwrite=false → medan MASIH KOSONG sahaja (auto-fill selamat).
   overwrite=true  → timpa semua medan yang ada nilai hasil scan
                     (medan tak dikesan kekal tak disentuh). */
function _prefillFormFromExtracted(extracted, overwrite) {
  if (!extracted) return;
  const map = {
    first_name: 'tvl-firstname', last_name: 'tvl-lastname',
    ic_number: 'tvl-ic', date_of_birth: 'tvl-dob', gender: 'tvl-gender',
    passport_no: 'tvl-pp', passport_expiry: 'tvl-ppexp', nationality: 'tvl-nat',
  };
  Object.keys(map).forEach(k => {
    const v = extracted[k];
    if (!v) return;
    const el = document.getElementById(map[k]);
    if (el && (overwrite || !el.value)) el.value = v;
  });
  syncFullName();
  if (extracted.passport_expiry) checkPassportValidity();
}

/* Butang "Overwrite form with scanned data" pada kad hasil scan —
   paksa semua nilai hasil scan ke atas medan borang. */
function _applyScanToForm() {
  if (!_wizardExtracted) return;
  _prefillFormFromExtracted(_wizardExtracted, true);
  const box = document.getElementById('passport-scan-result');
  if (box) {
    box.style.display = 'block';
    box.innerHTML =
      '<div style="padding:12px 14px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;font-size:12px;color:#166534;">' +
      '\u2713 Scanned data applied to the form — please review before saving.</div>';
  }
}

function _dismissFormScan() {
  _wizardResult = null;
  const box = document.getElementById('passport-scan-result');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
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
  // jalan lebih dulu dan fail passport yang discan terpadam.
  await _loadTravellerForm(merged);
  _applyWizardPassportFile();
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

/* Validasi nombor telefon guna intl-tel-input built-in (utils sudah bundled
   dalam intlTelInputWithUtils.min.js). Bekas dependency libphonenumber-js
   dimuatkan dari cdnjs URL yang 404 → global `libphonenumber` sentiasa
   undefined → SEMUA nombor ditolak. iti.isValidNumber() guna utils yang sama
   yang dah load bersama widget. Fallback leniency (≥7 digit) bila widget
   intl-tel-input gagal load — server tetap validate format. */
function _isPhoneValid(iti, num) {
  if (iti) {
    try { return iti.isValidNumber(); } catch (e) { /* fall through */ }
  }
  return (num || '').replace(/\D/g, '').length >= 7;
}

/* ══════════════════════════════════════════════
   NATIONALITY SELECT
   ══════════════════════════════════════════════ */

/* Nationality + Country: autocomplete native (datalist). _countries
   disimpan untuk normalisasi input semasa save (padanan tak kisah huruf
   besar/kecil). */
let _countriesLoaded = false;
let _countries = [];

async function loadCountries() {
  if (_countriesLoaded) return;
  try {
    const countries = await API_TV('get_countries', {});
    if (countries && countries.length) {
      _countries = countries;
      const opts = countries.map(c =>
        '<option value="' + _esc(c.name) + '">' + _esc(c.country_name || c.name) + '</option>').join('');
      const natList = document.getElementById('tvl-nat-list');
      if (natList) natList.innerHTML = opts;
      // Country (alamat) — datalist sama, sumber dokumen Country yang sama.
      const ctryList = document.getElementById('tvl-country-list');
      if (ctryList) ctryList.innerHTML = opts;
    }
    _countriesLoaded = true;
  } catch (e) {
    _countriesLoaded = true;
  }
}

/* Input nationality → nama Country canonical (value select lama, i.e.
   docname) atau '' jika kosong. Pulangkan null jika tiada padanan —
   caller papar ralat field. */
function _canonicalNationality(value) {
  const needle = (value || '').trim().toLowerCase();
  if (!needle) return '';
  const hit = _countries.find(c =>
    (c.name || '').toLowerCase() === needle ||
    (c.country_name || '').toLowerCase() === needle);
  return hit ? hit.name : null;
}

/* Input country alamat → nama Country canonical — corak sama
   _canonicalNationality (padanan tak kisah huruf besar/kecil supaya
   rekod lama "MALAYSIA" ter-normalisasi ke "Malaysia"). */
function _canonicalCountry(value) {
  const needle = (value || '').trim().toLowerCase();
  if (!needle) return '';
  const hit = _countries.find(c =>
    (c.name || '').toLowerCase() === needle ||
    (c.country_name || '').toLowerCase() === needle);
  return hit ? hit.name : null;
}

/* ══════════════════════════════════════════════
   FORM LOAD + PASSPORT VALIDITY (port)
   ══════════════════════════════════════════════ */

/* ── Checkbox "Copy from billing address" (kad Address, panel Contact)
   — TICK: isi medan alamat dengan alamat billing customer yang terkini
   (Booking.cust_* — disegerak dengan Address customer oleh hooks).
   EDIT MANUAL mana-mana medan → tick terlepas (bukan lagi salinan
   billing). Checkbox sentiasa dipaparkan; disabled + tooltip bila
   booking tiada alamat billing (rekod lama). ── */
function _wireCopyBilling(slot) {
  const wrap = document.getElementById('tvl-copy-billing-wrap');
  const cb   = document.getElementById('tvl-copy-billing');
  if (!wrap || !cb) return;
  const b = (slot && slot.billing_address) || {};
  const hasAny = ['address_line1', 'city', 'postcode', 'state', 'country']
    .some(k => (b[k] || '').trim());

  wrap.style.display = 'inline-flex';
  cb.disabled = !hasAny;
  if (!hasAny) {
    wrap.title = 'No billing address on file for this booking.';
    return;
  }
  wrap.title = 'Copy the customer billing address into these fields.';
  cb.checked = false;
  cb.onchange = () => {
    if (!cb.checked) return;
    document.getElementById('tvl-addr1').value    = b.address_line1 || '';
    document.getElementById('tvl-city').value     = b.city          || '';
    document.getElementById('tvl-postcode').value = b.postcode      || '';
    document.getElementById('tvl-state').value    = b.state         || '';
    document.getElementById('tvl-country').value  = b.country       || '';
  };
  // Manual edit → uncheck (sekali sahaja per hook listener per medan)
  ['tvl-addr1', 'tvl-city', 'tvl-postcode', 'tvl-state', 'tvl-country']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.dataset.billingHooked) {
        el.dataset.billingHooked = '1';
        el.addEventListener('input', () => { cb.checked = false; });
      }
    });
}

async function _loadTravellerForm(slot, passportReset = false) {
  await loadCountries();
  _initPhoneWidgets();

  const isVerified      = slot && (slot.is_verified || slot.document_status === 'Verified');
  const isOpenForUpdate = slot && slot.document_status === 'Open for Update';
  const canEdit         = !isVerified || isOpenForUpdate;

  document.getElementById('tvl-ic').value        = slot?.ic_number      || '';
  document.getElementById('tvl-firstname').value = slot?.first_name     || '';
  document.getElementById('tvl-lastname').value  = slot?.last_name      || '';
  document.getElementById('tvl-name').value      = slot?.full_name      || '';
  // Format full name — nilai doctype Traveller; nilai tidak sah → default.
  const fmtEl = document.getElementById('tvl-fullname-format');
  if (fmtEl) {
    fmtEl.value = slot?.fullname_format || 'First Name + Last Name';
    if (fmtEl.selectedIndex === -1) fmtEl.value = 'First Name + Last Name';
  }
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
  // Alamat (optional) — payload dari server sudah bawa fallback: alamat
  // traveller tersimpan → alamat slot (salinan alamat billing booking).
  document.getElementById('tvl-addr1').value    = slot?.address_line1 || '';
  document.getElementById('tvl-city').value     = slot?.city          || '';
  document.getElementById('tvl-postcode').value = slot?.postcode      || '';
  document.getElementById('tvl-state').value    = slot?.state         || '';
  document.getElementById('tvl-country').value  = slot?.country       || '';
  _wireCopyBilling(slot);
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
  document.querySelectorAll('.tvl-pdpa-consent').forEach(cb => { cb.checked = false; });
  document.getElementById('tvl-form-error').style.display = 'none';

  document.getElementById('passport-upload-txt').textContent = 'Upload passport copy';
  document.getElementById('passport-upload-area').style.borderColor = '';
  _passportFile = null;
  _revokePassportPreviewUrl();
  const scanBox = document.getElementById('passport-scan-result');
  if (scanBox) { scanBox.style.display = 'none'; scanBox.innerHTML = ''; }
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
  editableInputs.forEach(i => i.disabled = !canEdit);
  document.getElementById('passport-upload-area').disabled = !canEdit;
  document.getElementById('visa-photo-upload-area').disabled = !canEdit;
  // Bar hantar (consent PDPA + butang Submit) disembunyikan untuk slot
  // Verified (baca sahaja).
  const submitBar = document.getElementById('tvl-submit-bar');
  if (submitBar) submitBar.style.display = canEdit ? '' : 'none';

  if (!passportReset && slot?.passport_expiry) checkPassportValidity();

  _showDocsForm();
  renderEngineBadge();
  // A4 — muat gambar passport sebenar (async, tak halang paparan form).
  _loadPassportPreview(slot);
}

/* Full Name diira ikut format terpilih (select tvl-fullname-format,
   options = Select fullname_format doctype Traveller) — kesan langsung
   semasa menaip / menukar format. Selari dengan set_full_name()
   controller Traveller; uppercase diselaraskan dengan set_uppercase(). */
function syncFullName() {
  const first = (document.getElementById('tvl-firstname')?.value || '').trim();
  const last  = (document.getElementById('tvl-lastname')?.value  || '').trim();
  const fmt   = document.getElementById('tvl-fullname-format')?.value || 'First Name + Last Name';
  const nameEl = document.getElementById('tvl-name');
  if (!nameEl) return;
  const combined = fmt === 'Last Name + First Name'
    ? [last, first].filter(Boolean).join(' ')
    : [first, last].filter(Boolean).join(' ');
  nameEl.value = combined.toUpperCase();
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

/* Preview dokumen passport yang baru dipilih (lokal, sebelum disimpan) —
   ganti imej contoh dengan gambar dokumen user. Object URL di-revoke bila
   diganti supaya memori tidak membocor. */
let _passportPreviewUrl = null;

function _passportCaption(text) {
  const cap = document.getElementById('passport-preview-cap');
  if (cap) cap.textContent = text;
}

function _revokePassportPreviewUrl() {
  if (_passportPreviewUrl) {
    try { URL.revokeObjectURL(_passportPreviewUrl); } catch (e) { /* noop */ }
    _passportPreviewUrl = null;
  }
}

function _showLocalPassportPreview(file) {
  const preview = document.getElementById('passport-preview');
  const example = document.getElementById('passport-example');
  if (!preview || !example || !file) return;
  // PDF tak boleh dipapar oleh <img> — kekalkan contoh, tunjuk nama fail
  // pada caption (halaman 1 dirender & diimbas oleh server).
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    _revokePassportPreviewUrl();
    preview.style.display = 'none';
    example.style.display = '';
    _passportCaption('✓ ' + file.name + ' — PDF · page 1 will be scanned');
    return;
  }
  _revokePassportPreviewUrl();
  _passportPreviewUrl = URL.createObjectURL(file);
  preview.src = _passportPreviewUrl;
  preview.style.display = '';
  example.style.display = 'none';
  _passportCaption('✓ ' + file.name);
}

function _pickImage(onPicked, errBoxId, opts) {
  const input = document.createElement('input');
  input.type = 'file';
  // JPG/PNG (imej) + PDF (dokumen — halaman 1 dirender & diimbas server).
  input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png,.pdf,application/pdf';
  // capture=environment (peranti sentuh sahaja) — buka kamera belakang terus
  // untuk snap dokumen; di desktop atribut ini diabaikan browser.
  if (opts && opts.capture) input.setAttribute('capture', 'environment');
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    // Jenis fail — JPG/PNG/PDF sahaja (semakan client; server sahkan
    // semula via magic bytes). Fallback extension untuk browser mudah
    // alih yang lapangkan file.type.
    const isAllowed = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)
      || /\.(jpe?g|png|pdf)$/i.test(file.name);
    if (!isAllowed) {
      showInlineError(errBoxId, 'Please upload a JPG, PNG, or PDF file — "' + file.name + '" is not supported.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showInlineError(errBoxId, 'File must be under 5MB — "' + file.name + '" is ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.');
      return;
    }
    hideInlineError(errBoxId);
    onPicked(file);
  };
  input.click();
}

function triggerPassportUpload(useCamera) {
  _pickImage(file => {
    _passportFile = file;
    document.getElementById('passport-upload-txt').textContent = '✓ ' + file.name;
    document.getElementById('passport-upload-area').style.borderColor = '#0F6E56';
    _showLocalPassportPreview(file);
    // AUTO-SCAN: imbasan bermula serta-merta selepas gambar dipilih /
    // dicapture; hasil dipapar in-place dalam section ini.
    _scanFormPassport(file);
  }, 'passport-upload-err', { capture: !!useCamera });
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
   SUBMIT — satu page form: sahkan SEMUA medan (Passport + Contact Info +
   Health), kemudian SATU panggilan API save_booking_traveller
   (sections=passport,contact,health + confirm=1 — server cipta/kemas
   kini Traveller & tulis SEKALI sahaja; status Incomplete untuk semakan
   admin).
   ══════════════════════════════════════════════ */

async function submitTraveller(btnEl) {
  const get = id => document.getElementById(id);

  const firstName = get('tvl-firstname').value.trim();
  const lastName  = get('tvl-lastname').value.trim();
  const phoneNum  = _getFullPhoneNumber(_itiPhone, get('tvl-phone-num'));
  const ecName    = get('tvl-ec-name').value.trim();
  const ecPhone   = _getFullPhoneNumber(_itiEcPhone, get('tvl-ec-phone'));
  const ecRel     = get('tvl-ec-relationship').value.trim();
  const ic        = get('tvl-ic').value.trim();
  let   nat       = get('tvl-nat').value;
  const dob       = get('tvl-dob').value;
  const gender    = get('tvl-gender').value;
  const pp        = get('tvl-pp').value.trim();
  const ppexp     = get('tvl-ppexp').value;
  const addr1     = get('tvl-addr1').value.trim();
  const city      = get('tvl-city').value.trim();
  const postcode  = get('tvl-postcode').value.trim();
  const state     = get('tvl-state').value.trim();
  let   country   = get('tvl-country').value.trim();
  const wheelchair = get('tvl-wheelchair').value;
  // Consent — SATU checkbox di bar hantar.
  const consent   = !!document.querySelector('.tvl-pdpa-consent:checked');

  // Bersihkan error lama dulu.
  document.querySelectorAll('#V-form input, #V-form select').forEach(clearFieldError);
  get('tvl-form-error').style.display = 'none';

  const fail = (el, msg) => {
    fieldError(el, msg);
    el.focus({ preventScroll: false });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  };

  // ── Validasi SEMUA section (satu page — semua medan kelihatan). ──
  // Passport: salinan dokumen wajib ada (baru dipilih atau sudah on file).
  if (!_passportFile && !(ACTIVE_SLOT && ACTIVE_SLOT.has_passport))
    return fail(get('passport-upload-area'), 'Please upload your passport copy.');
  // SEMUA maklumat Identity & Passport WAJIB (server enforce sama).
  if (!firstName) return fail(get('tvl-firstname'), 'First name is required.');
  if (!lastName)  return fail(get('tvl-lastname'), 'Last name is required.');
  if (!ic)        return fail(get('tvl-ic'), 'IC Number is required.');
  if (!nat)       return fail(get('tvl-nat'), 'Nationality is required.');
  // Nationality autocomplete: normalisasi input ke nama Country sebenar
  // (padanan tak kisah huruf besar/kecil) supaya nilai sah masuk Link
  // field Country. Langkau bila senarai negara gagal dimuatkan — server
  // tetap validate.
  if (nat && _countries.length) {
    const canonical = _canonicalNationality(nat);
    if (canonical === null)
      return fail(get('tvl-nat'), 'Please pick a nationality from the suggestion list.');
    nat = canonical;
  }
  if (!dob)       return fail(get('tvl-dob'), 'Date of birth is required.');
  if (!gender)    return fail(get('tvl-gender'), 'Gender is required.');
  if (!pp)        return fail(get('tvl-pp'), 'Passport number is required.');
  if (!ppexp)     return fail(get('tvl-ppexp'), 'Passport expiry is required.');
  // Contact: phone & email wajib — diperlukan untuk hubungi traveller
  // sepanjang trip & pengesahan tempahan.
  if (!phoneNum)
    return fail(get('tvl-phone-num'), 'Phone number is required.');
  if (!_isPhoneValid(_itiPhone, phoneNum))
    return fail(get('tvl-phone-num'), 'This does not look like a valid phone number. Please check the country code.');
  if (!get('tvl-email').value.trim())
    return fail(get('tvl-email'), 'Email is required.');
  // Address WAJIB lengkap (server enforce sama) — perlu untuk pengurusan
  // trip (visa, dokumen, kecemasan).
  const addrFields = [
    [get('tvl-addr1'), addr1, 'Street address'],
    [get('tvl-city'), city, 'City'],
    [get('tvl-postcode'), postcode, 'Postcode'],
    [get('tvl-state'), state, 'State'],
    [get('tvl-country'), country, 'Country'],
  ];
  for (const [el, val, label] of addrFields) {
    if (!val) return fail(el, label + ' is required.');
  }
  // Country autocomplete: normalisasi input ke nama Country canonical
  // (padanan tak kisah huruf besar/kecil) — selari perlakuan nationality.
  // Langkau bila senarai negara gagal dimuatkan — server tetap terima.
  if (country && _countries.length) {
    const canonicalCountry = _canonicalCountry(country);
    if (canonicalCountry === null)
      return fail(get('tvl-country'), 'Please pick a country from the suggestion list.');
    country = canonicalCountry;
  }
  // Emergency contact: kalau satu diisi, pasangannya mesti lengkap
  // (cermin check server-side). Mandatory penuh hanya di /traveller
  // (traveller_travellers.js) — halaman guest kekal optional.
  if ((ecName || ecPhone || ecRel) && (!ecName || !ecPhone || !ecRel)) {
    if (!ecName) return fail(get('tvl-ec-name'), 'Please complete the emergency contact (name, phone & relationship).');
    if (!ecPhone) return fail(get('tvl-ec-phone'), 'Please complete the emergency contact (name, phone & relationship).');
    return fail(get('tvl-ec-relationship'), 'Please complete the emergency contact (name, phone & relationship).');
  }
  if (ecPhone && !_isPhoneValid(_itiEcPhone, ecPhone))
    return fail(get('tvl-ec-phone'), 'This does not look like a valid phone number. Please check the country code.');
  // Health: Wheelchair Assistance WAJIB dipilih — persiapan bantuan oleh
  // kru trip.
  if (!wheelchair)
    return fail(get('tvl-wheelchair'), 'Wheelchair Assistance is required — please select an option.');

  // PDPA consent wajib — tiada tick → MODAL POPUP (bukan inline error).
  // "Accept & Continue" tick checkbox consent.
  if (!consent) {
    _showConsentModal();
    return;
  }

  const btn = btnEl || get('tvl-submit-btn');
  const btnLabel = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Submitting...'; btn.disabled = true; }

  try {
    const readFile = f => new Promise(res => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.readAsDataURL(f);
    });

    const base = {
      booking_number: BOOKING,
      slot_name: ACTIVE_SLOT.slot_name,
      pdpa_consent: true,
    };
    if (_GUEST_MODE) base.guest_token = _GUEST_TOKEN;

    // SATU panggilan API untuk SEMUA section + confirm — server terapkan
    // semua medan pada SATU dokumen Traveller dan tulis SEKALI sahaja.
    // (Legacy wizard: 3 panggilan section + 1 confirm = 4 save
    // berturutan → notification emel berulang untuk satu submission.)
    let filedata = '', filename = '';
    if (_passportFile) { filedata = await readFile(_passportFile); filename = _passportFile.name; }
    let visaFiledata = '', visaFilename = '';
    if (_visaPhotoFile) { visaFiledata = await readFile(_visaPhotoFile); visaFilename = _visaPhotoFile.name; }
    await API_TV('save_booking_traveller', Object.assign({}, base, {
      sections: 'passport,contact,health',
      confirm: 1,
      first_name: firstName, last_name: lastName,
      full_name: get('tvl-name').value.trim(),
      fullname_format: get('tvl-fullname-format').value,
      gender, ic_number: ic,
      date_of_birth: dob, nationality: nat,
      passport_no: pp, passport_expiry: ppexp,
      filedata, filename,
      email: get('tvl-email').value || '',
      phone: phoneNum,
      emergency_contact_name: ecName,
      emergency_contact_phone: ecPhone,
      emergency_contact_relationship: ecRel,
      address_line1: addr1,
      city: city, postcode: postcode, state: state, country: country,
      visa_filedata: visaFiledata, visa_filename: visaFilename,
      dietary_requirements: get('tvl-dietary').value.trim(),
      medical_conditions: get('tvl-medical').value.trim(),
      special_needs: get('tvl-special-needs').value.trim(),
      wheelchair_assistant: wheelchair,
      medicine_treatment: get('tvl-medicine').value.trim(),
    }));

    // Segar semula slot (flag has_passport dll.). Mod guest guna
    // verify_guest_token (tiada session); customer guna get_booking_data.
    if (_GUEST_MODE) {
      ACTIVE_SLOT = await API_TV('verify_guest_token', { token: _GUEST_TOKEN });
    } else {
      const fresh = await API_BK('get_booking_data', { booking_number: BOOKING });
      PORTAL_DATA = fresh;
      if (ACTIVE_SLOT) {
        const s = (fresh.slots || []).find(x => x.slot_name === ACTIVE_SLOT.slot_name);
        if (s) ACTIVE_SLOT = s;
      }
    }

    if (_GUEST_MODE) {
      // Guest tiada senarai untuk kembali — tunjuk pengesahan berjaya &
      // sembunyi borang (slot kini Pending — admin akan semak).
      const form = get('V-form');
      if (form) {
        const msg = document.createElement('div');
        msg.className = 'card';
        msg.style.cssText = 'text-align:center;padding:32px 20px;background:#F0FDF4;border:1px solid #BBF7D0;';
        msg.innerHTML = '<div style="font-size:15px;font-weight:600;color:#166534;margin-bottom:6px;">\u2713 Thank you! Your details have been submitted.</div>' +
          '<div style="font-size:12px;color:#7D7A70;">Our team will review your information. You may close this page now.</div>';
        form.parentNode.insertBefore(msg, form);
        form.style.display = 'none';
      }
    } else {
      tvlBackToList();
    }
  } catch (e) {
    showInlineError('tvl-form-error', e.message || 'An error occurred. Please try again.');
  } finally {
    if (btn) { btn.textContent = btnLabel; btn.disabled = false; }
  }
}

/* ══════════════════════════════════════════════
   PDPA CONSENT — modal popup
   ══════════════════════════════════════════════ */

/* Modal popup: Submit ditekan tanpa consent. "Accept & Continue" tick
   checkbox consent & tutup modal — user terus boleh tekan Submit lagi. */
function _showConsentModal() {
  _hideConsentModal();
  const overlay = document.createElement('div');
  overlay.id = 'rc-consent-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(30,28,24,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;';
  overlay.innerHTML =
    '<div role="dialog" aria-modal="true" aria-label="Privacy consent required" style="background:#fff;border-radius:14px;padding:28px 24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(30,28,24,.35);font-family:inherit;">' +
      '<div style="font-size:34px;margin-bottom:10px;text-align:center;">\uD83D\uDD12</div>' +
      '<div style="font-size:15px;font-weight:700;color:#1E1C18;margin-bottom:8px;text-align:center;">Privacy consent required</div>' +
      '<p style="font-size:12.5px;color:#6E6A5F;line-height:1.6;margin-bottom:18px;">Please accept the Privacy Notice before saving — we need your consent to store traveller and passport details for trip arrangements.</p>' +
      '<div style="display:flex;gap:10px;">' +
        '<button type="button" class="btn btn-g" style="flex:1;" onclick="_hideConsentModal()">Cancel</button>' +
        '<button type="button" class="btn btn-p" style="flex:1;" onclick="_acceptConsentFromModal()">\u2713 Accept &amp; Continue</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function _hideConsentModal() {
  const el = document.getElementById('rc-consent-modal');
  if (el) el.remove();
}

function _acceptConsentFromModal() {
  document.querySelectorAll('.tvl-pdpa-consent').forEach(cb => { cb.checked = true; });
  _hideConsentModal();
}

/* ══════════════════════════════════════════════
   GUEST MODE — co-traveller via token link (no session)
   ══════════════════════════════════════════════ */

/* Header guest: trip info dalam kotak maklumat tersusun (label–nilai:
   Dates / Package / Traveller) + trip title + nota "signed in as guest".
   Diikuti panel Room Info (slot label / kategori / jenis penumpang /
   room id / privasi) + panel Cruise Cabin bila booking bercruise.
   Dipanggil selepas verify_guest_token pulangkan konteks slot. */
function renderGuestHeader(ctx) {
  const hdr = document.getElementById('guest-header');
  if (!hdr) return;
  const dep = ctx.departure_date ? fmtDate(ctx.departure_date) : '';
  const ret = ctx.return_date ? fmtDate(ctx.return_date) : '';

  // Tarikh trip: julat "14 Sep 2026 – 21 Sep 2026" bila tarikh pulang
  // ada; kalau tak, cukup tarikh pergi.
  let dateVal = '';
  if (dep && ret) dateVal = dep + ' \u2013 ' + ret;
  else if (dep)   dateVal = 'Departs ' + dep;

  // Nama pakej sahaja — package_code tidak dipaparkan.
  const pkgVal = ctx.package_title || ctx.package_type || '';

  // Baris label–nilai: icon | label | HTML nilai (dah di-escape oleh
  // pemanggil). Baris terakhir tiada garisan pemisah. Grid kekal kemas
  // pada mobile (value wrap, word-break).
  const rowHtml = (r, last) =>
    '<div style="display:grid;grid-template-columns:18px 110px 1fr;gap:8px;align-items:baseline;padding:8px 0;' +
    (last ? '' : 'border-bottom:1px dashed #EAE7E0;') + '">' +
      '<span aria-hidden="true" style="font-size:12px;">' + r[0] + '</span>' +
      '<span style="font-size:10px;font-weight:700;color:#B0AC9F;letter-spacing:.06em;text-transform:uppercase;">' + r[1] + '</span>' +
      '<span style="font-size:12.5px;font-weight:500;color:#1E1C18;word-break:break-word;">' + r[2] + '</span>' +
    '</div>';
  const boxHtml = rows =>
    '<div style="background:#FAFAF7;border:1px solid #EAE7E0;border-radius:10px;padding:2px 14px;">' +
      rows.map((r, i) => rowHtml(r, i === rows.length - 1)).join('') +
    '</div>';
  // Sub-tajuk seksyen (Room Info / Cruise Cabin) — gaya sama dgn tajuk
  // panel "Guest Passport Submission" tetapi lebih kecil.
  const secHtml = label =>
    '<div style="font-size:10px;font-weight:700;color:#B0AC9F;letter-spacing:.07em;text-transform:uppercase;margin:14px 0 6px;">' + label + '</div>';

  const tripRows = [];
  if (dateVal) tripRows.push(['\uD83D\uDCC5', 'Dates', _esc(dateVal)]);
  // Nama pakej sahaja (package_code tidak dipaparkan). Format package_title
  // ialah "Trip : Jenis : Variasi" — parse " : " sebagai baris baru supaya
  // tersusun dan mudah dibaca.
  if (pkgVal) tripRows.push(['\uD83C\uDFAB', 'Package',
    pkgVal.split(' : ').map(s => _esc(s.trim())).filter(Boolean).join('<br>')]);
  tripRows.push(['\uD83D\uDC64', 'Traveller', _esc(ctx.slot_label || 'Traveller')]);

  // ── Room Info — hanya baris berdata dipaparkan (rekod lama mungkin
  // kosong); seksyen dibuang terus bila tiada apa-apa untuk ditunjuk.
  const roomRows = [];
  if (ctx.guest_label) roomRows.push(['\uD83C\uDFF7', 'Slot Label', _esc(ctx.guest_label)]);
  const rcVal = ctx.room_category_label || ctx.room_category || '';
  if (rcVal) roomRows.push(['\uD83D\uDECF\uFE0F', 'Room Category', _esc(rcVal)]);
  if (ctx.pax_type) roomRows.push(['\uD83D\uDC65', 'Passenger Type', _esc(ctx.pax_type)]);
  if (ctx.room_id) roomRows.push(['\uD83D\uDD11', 'Room ID', _esc(ctx.room_id)]);
  if (ctx.room_privacy) roomRows.push(['\uD83D\uDD12', 'Room Privacy', _esc(ctx.room_privacy)]);

  // ── Cruise Cabin — HANYA bila trip/pakej bercruise (is_a_cruise dari
  // server, flag is_a_cruise_trip). Nilai kabin semata-mata tak mencukupi;
  // baris tanpa nilai ditinggalkan, dan bila bercruise tapi penempatan
  // belum dibuat, papar nota "to be assigned".
  const cruiseRows = [];
  if (ctx.stateroom_no) cruiseRows.push(['\uD83D\uDEA2', 'Stateroom No', _esc(ctx.stateroom_no)]);
  if (ctx.delegate_no) cruiseRows.push(['\uD83D\uDCCB', 'Delegate No', _esc(ctx.delegate_no)]);
  if (ctx.aroya_guest_no) cruiseRows.push(['\uD83D\uDEF3', 'Aroya Guest No', _esc(ctx.aroya_guest_no)]);
  const showCruise = !!ctx.is_a_cruise;
  if (showCruise && !cruiseRows.length) {
    cruiseRows.push(['\uD83D\uDEF3', 'Stateroom', '<span style="color:#7D7A70;">To be assigned by our team</span>']);
  }

  hdr.innerHTML =
    '<div style="font-size:11px;font-weight:700;color:#B0AC9F;letter-spacing:.07em;text-transform:uppercase;margin-bottom:4px;">Guest Passport Submission</div>' +
    '<div style="font-size:16px;font-weight:600;color:#1E1C18;line-height:1.3;">' + _esc(ctx.trip_title || ctx.trip_name || 'Trip') + '</div>' +
    '<div style="margin-top:10px;background:#FAFAF7;border:1px solid #EAE7E0;border-radius:10px;padding:2px 14px;">' +
      tripRows.map((r, i) => rowHtml(r, i === tripRows.length - 1)).join('') +
    '</div>' +
    (roomRows.length
      ? secHtml('Room Info') + boxHtml(roomRows)
      : '') +
    (showCruise
      ? secHtml('Cruise Cabin') + boxHtml(cruiseRows)
      : '') +
    '<div style="font-size:11px;color:#92400E;margin-top:10px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:6px 10px;display:inline-block;">You are filling in details via a secure email link — no login required.</div>';
  hdr.style.display = 'block';
}

/* A4 — papar gambar passport sebenar (dari server, base64 data URL) bila
   has_passport; contoh kekal sebagai placeholder bila tiada. Gambar disimpan
   is_private pada Traveller — tak boleh diakses terus via /private/files/,
   jadi fetch endpoint khusus (get_slot_file utk customer / get_guest_file
   utk guest). */
async function _loadPassportPreview(slot) {
  const preview = document.getElementById('passport-preview');
  const example = document.getElementById('passport-example');
  if (!preview || !example) return;
  _revokePassportPreviewUrl();
  if (!slot || !slot.has_passport) {
    preview.style.display = 'none';
    example.style.display = '';
    _passportCaption('Photo page · All corners visible');
    return;
  }
  try {
    const res = _GUEST_MODE
      ? await API_TV('get_guest_file', { token: _GUEST_TOKEN, field: 'passport_image' })
      : await API_TV('get_slot_file', { booking_number: BOOKING, slot_name: slot.slot_name, field: 'passport_image' });
    if (res && res.data_url) {
      preview.src = res.data_url;
      preview.style.display = '';
      example.style.display = 'none';
      _passportCaption('Passport copy on file');
    } else {
      preview.style.display = 'none';
      example.style.display = '';
      _passportCaption('Photo page · All corners visible');
    }
  } catch (e) {
    preview.style.display = 'none';
    example.style.display = '';
    _passportCaption('Photo page · All corners visible');
  }
}

/* (a) "Share me" — customer jana link passport utk co-traveller (guest, no
   login) dan kongsi terus. Mengetik email menyebalkan; orang sekarang
   kongsi link via WhatsApp. Web Share API (mobile → share sheet termasuk
   WhatsApp) dipilih pertama; fallback: salin + butang WhatsApp utk desktop. */
async function shareGuestPassportLink(slotName, btn) {
  const card = btn.closest('.slot-guest-link');
  const status = card && card.querySelector('.guest-link-status');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Generating\u2026';
  if (status) status.style.display = 'none';
  try {
    const res = await API_TV('request_guest_passport_link', {
      booking_number: BOOKING, slot_name: slotName,
    });
    const link = res.link || '';
    if (!link) throw new Error('Could not generate link.');
    const exp = res.expires_on ? res.expires_on.slice(0, 10) : '';

    // Web Share API (mobile → share sheet termasuk WhatsApp) — paling
    // friendly. Cancellable (user tutup sheet) → fallback ke copy+WhatsApp.
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Passport & travel details',
          text: 'Please fill in your passport and travel details for our trip:',
          url: link,
        });
        if (status) {
          status.innerHTML = '\u2713 Link shared.' +
            (exp ? ' <span style="color:#7D7A70;">Valid until ' + _esc(exp) + '</span>' : '');
          status.style.color = '#0F6E56'; status.style.display = 'block';
        }
        return;
      } catch (e) { /* user cancel share → fallback copy+WhatsApp */ }
    }

    // Fallback (desktop / tiada Web Share): link readonly + Copy + WhatsApp.
    _renderShareLinkUi(status, link, exp);
  } catch (e) {
    if (status) { status.textContent = e.message || 'Failed to generate link.'; status.style.color = '#991B1B'; status.style.display = 'block'; }
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* UI fallback (desktop / tiada Web Share): link readonly + Copy + WhatsApp. */
function _renderShareLinkUi(status, link, exp) {
  if (!status) return;
  const waLink = 'https://wa.me/?text=' + encodeURIComponent(
    'Please fill in your passport and travel details for our trip:\n' + link
  );
  status.innerHTML =
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
      '<input type="text" readonly value="' + _esc(link) + '" onclick="this.select()" ' +
      'style="flex:1;min-width:0;font-size:11px;padding:5px 8px;border:1px solid #D4D1CC;border-radius:6px;background:#fff;"/>' +
      '<button type="button" class="btn btn-g btn-sm" onclick="_copyShareLink(this)">Copy</button>' +
    '</div>' +
    '<a href="' + _esc(waLink) + '" target="_blank" rel="noopener" class="btn btn-p btn-sm" ' +
    'style="display:inline-block;text-decoration:none;text-align:center;width:100%;">' +
    'Open WhatsApp</a>' +
    (exp ? '<div style="color:#7D7A70;margin-top:4px;">Valid until ' + _esc(exp) + '</div>' : '');
  status.style.color = '#0F6E56'; status.style.display = 'block';
}

function _copyShareLink(btn) {
  const input = btn.parentElement.querySelector('input');
  if (!input) return;
  const text = input.value;
  const done = () => { const l = btn.textContent; btn.textContent = '\u2713 Copied'; setTimeout(() => { btn.textContent = l; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { input.select(); document.execCommand('copy'); done(); });
  } else {
    input.select(); document.execCommand('copy'); done();
  }
}

/* Init path guest: langkau ensureSession/renderNav (tiada session), validate
   token via verify_guest_token, muat borang terus (tiada wizard auto-fill). */
async function initGuestMode() {
  document.body.classList.add('tvl-guest-mode');
  document.querySelectorAll('[data-guest-hide]').forEach(el => el.style.display = 'none');

  let token = _pageData.token || '';
  if (!token) {
    try { token = new URLSearchParams(window.location.search).get('token') || ''; } catch (e) { token = ''; }
  }

  const loading = document.getElementById('tvl-docs-loading');
  if (!token) {
    if (loading) {
      loading.style.display = 'block';
      loading.innerHTML = '<div style="font-size:14px;color:#991B1B;">This passport link is invalid or missing. Please request a new link from the person who booked your trip.</div>';
    }
    return;
  }
  _GUEST_TOKEN = token;

  const dobEl = document.getElementById('tvl-dob');
  if (dobEl) dobEl.max = new Date().toISOString().split('T')[0];

  try {
    const ctx = await API_TV('verify_guest_token', { token: token });
    _GUEST_MODE = true;
    BOOKING = ctx.booking_number || '';
    // PORTAL_DATA bentuk minimum supaya checkPassportValidity (baca
    // PORTAL_DATA.booking.departure_date) berfungsi di mod guest.
    PORTAL_DATA = { booking: { trip_name: ctx.trip_name, departure_date: ctx.departure_date } };
    ctx.filled = !!ctx.traveller_id;   // supaya guard "save all sections" tak
                                       // halang confirm bila slot sudah terisi.
    renderGuestHeader(ctx);
    ACTIVE_SLOT = ctx;
    _passportFile = null;
    _visaPhotoFile = null;
    // Guest terus ke borang (wizard Langkah 1 telah dibuang) — imbasan
    // passport berlaku in-place di section Passport Copy.
    await _loadTravellerForm(ctx);
  } catch (e) {
    if (loading) {
      loading.style.display = 'block';
      loading.innerHTML = '<div style="font-size:14px;color:#991B1B;">' + _esc(e.message || 'This passport link is invalid or has expired. Please request a new link.') + '</div>';
    }
  }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  // Guest passport-link page: tiada session — langkau ensureSession/nav,
  // validate token & muat borang terus.
  if (_pageData.mode === 'guest') {
    initGuestMode();
    return;
  }

  const ok = await ensureSession();
  if (!ok) return;
  renderNav();

  BOOKING = _pageData.booking_ref || '';
  if (!BOOKING) return;

  const isDocsPage = !!document.getElementById('V-form');

  // DOB tak boleh masa depan.
  const dobEl = document.getElementById('tvl-dob');
  if (dobEl) dobEl.max = new Date().toISOString().split('T')[0];

  try {
    const data = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = data;

    if (isDocsPage) {
      // Page docs: ?slot= menentukan slot yang diisi. slot_name boleh datang
      // dari pageData Jinja ATAU URL (belt & braces).
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
      // Semua slot (kosong @ terisi) terus ke borang — imbasan passport
      // berlaku in-place di section Passport Copy selepas upload.
      _loadTravellerForm(slot);
    } else {
      renderTravellerSlots(data);
    }
  } catch (e) {
    const listContainer = document.getElementById('traveller-slots-container');
    if (listContainer) {
      listContainer.innerHTML =
        '<div class="card" style="text-align:center;padding:32px 20px;">' +
          '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">' + _esc(e.message || 'Failed to load travellers.') + '</div>' +
          '<a href="/traveller/bookings" class="btn btn-g" style="text-decoration:none;display:inline-block;font-size:12px;">← Back to My Bookings</a>' +
        '</div>';
    }
  }
});
