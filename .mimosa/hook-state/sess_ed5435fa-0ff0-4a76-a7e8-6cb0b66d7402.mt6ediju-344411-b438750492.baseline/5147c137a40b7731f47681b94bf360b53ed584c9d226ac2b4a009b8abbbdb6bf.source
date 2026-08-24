/* ============================================================
   travel_booking/public/js/traveller_travellers.js
   Traveller management page — DUA MOD:
   
   1) SENARAI (tiada 'res' parameter)
      Papar cabin + slot sebagai kad klik sahaja.
      Klik → redirect ke ?ref=XXX&res=YYY (individual slot page).
   
   2) INDIVIDU (ada 'res'=slot_name parameter)
      Passport OCR wizard → form dengan tab (Passport/Contact/Health).
      Proses bermula dengan upload passport image untuk validasi OCR.
   
   Reuses portal_traveller.py APIs.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var BOOKING_REF = _pageData.booking_ref || '';
  var SLOT_RES    = _pageData.slot_res || '';  // slot_name bila ada = mod individu
  var bookingData = null;
  var countries   = [];

  /* ── Mod individu globals (wizard + form) ── */
  let ACTIVE_SLOT     = null;
  let _passportFile   = null;
  let _visaPhotoFile  = null;
  let _wizardResult   = null;    // data traveller dari check_traveller_passport
  let _wizardExtracted = null;   // medan yang berjaya dibaca dari passport (OCR/MRZ)
  let _wizardFile     = null;    // File passport yang dipilih di langkah 1
  let _sectionsSaved  = { passport: false, contact: false, health: false };

  /* ── Init ── */
  async function init() {
    if (!BOOKING_REF) return;
    try {
      await ensureSession();
      renderNav();

      if (SLOT_RES) {
        // ══ MOD INDIVIDU: load specific slot for editing ══
        await initDetailMode();
      } else {
        // ══ MOD SENARAI: show all slots for selection ══
        await initListMode();
      }
    } catch (e) {
      console.error('Failed to load travellers:', e);
    }
  }

  /* ══════════════════════════════════════════════════════════
     MOD 1: SENARAI SLOT (selection only — no inline forms)
     ══════════════════════════════════════════════════════════ */

  async function initListMode() {
    var loading = document.getElementById('travellers-loading');
    var content = document.getElementById('travellers-content');

    try {
      bookingData = await API_BK('get_booking_data', { booking_number: BOOKING_REF });

      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML = renderSlotList(bookingData);
        wireListActions();
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML =
          '<div class="tv-card tv-text-center" style="padding:40px;">' +
          '<p style="color:var(--c-danger-text);">' + _esc(e.message || 'Failed to load travellers.') + '</p>' +
          '<a href="/traveller/booking?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:16px;">← Back</a>' +
          '</div>';
      }
    }
  }

  function renderSlotList(data) {
    var b = data.booking || {};
    var cabins = data.cabins || [];
    var slots = data.slots || [];

    if (!cabins.length && !slots.length) {
      return '<div class="tv-empty"><div class="tv-empty__icon">👥</div>' +
             '<h3 class="tv-empty__title">No Slots Found</h3>' +
             '<p class="tv-empty__desc">No traveller slots are assigned to this booking.</p></div>';
    }

    var tripName = _esc(b.trip_name || 'Booking');
    var ref = _esc(b.booking_number || b.name || '');

    var html = '';

    /* Header */
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">';
    html += '<h1 class="tv-section-title" style="margin-bottom:0;">Manage Travellers</h1>';
    html += '<span class="tv-badge tv-badge--neutral">' + tripName + ' · ' + ref + '</span>';
    html += '</div>';

    /* PDPA Notice */
    html += '<div class="tv-msg tv-msg--info on" style="margin-bottom:20px;">';
    html += '🛡️ All personal data is protected under PDPA. By saving traveller information, you consent to our data processing.';
    html += '</div>';

    /* Cabin / Slot List — clickable cards, no inline forms */
    cabins.forEach(function (cabin, cIdx) {
      var cabinSlots = cabin.slots || [];
      var cabinLabel = _esc(cabin.cabin_assignment || cabin.room_name || ('Cabin ' + (cIdx + 1)));

      html += '<div class="tv-cabin tv-animate-in">';
      html += '<div class="tv-cabin__header">';
      html += '<span>🛏️ ' + cabinLabel + '</span>';
      html += '<span>' + cabinSlots.length + ' slot(s)</span>';
      html += '</div>';
      html += '<div class="tv-cabin__body">';

      cabinSlots.forEach(function (slot, sIdx) {
        html += renderSelectableSlotCard(slot, cIdx, sIdx);
      });

      html += '</div>'; // body
      html += '</div>'; // cabin
    });

    // If no cabins but has slots (legacy)
    if (!cabins.length && slots.length) {
      html += '<div class="tv-sec">Traveller Slots</div>';
      slots.forEach(function (slot, idx) {
        html += renderSelectableSlotCard(slot, -1, idx);
      });
    }

    /* Back link */
    html += '<div style="margin-top:24px;text-align:center;">';
    html += '<a href="/traveller/booking?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn-link">← Back to Booking Details</a>';
    html += '</div>';

    return html;
  }

  /* ── Selectable Slot Card (click navigates to individual page) ── */
  function renderSelectableSlotCard(slot, cIdx, sIdx) {
    var slotName = _esc(slot.slot_label || slot.pax_type || ('Slot ' + (sIdx + 1)));
    var slotKey = _esc(slot.slot_name || ('slot-' + cIdx + '-' + sIdx));
    var isFilled = slot.filled || slot.traveller_id;
    var isVerified = slot.is_verified || slot.document_status === 'Verified';
    var statusCls = isVerified ? 'verified' : (isFilled ? 'pending' : 'empty');

    var name = isFilled
      ? (_esc(slot.full_name || (slot.first_name || '') + ' ' + (slot.last_name || '')))
      : '';

    // Build URL for individual slot page
    var detailUrl = '/traveller/travellers?ref=' + encodeURIComponent(BOOKING_REF) +
                    '&res=' + encodeURIComponent(slotKey);

    var html = '';
    html += '<div class="tv-slot-item" data-slot-key="' + slotKey + '" data-url="' + _esc(detailUrl) + '">';
    html += '<div class="tv-slot-status tv-slot-status--' + statusCls + '"></div>';

    // Summary row (clickable → navigate to individual page)
    html += '<div class="tv-slot-name selectable-slot" style="cursor:pointer;" data-act="go-to-slot">';
    if (name) {
      html += '<strong>' + name + '</strong>';
      html += '<div class="tv-slot-type">' + slotName;
      if (isVerified) html += ' <span style="color:var(--c-success);">✓ Verified</span>';
      else if (isFilled) html += ' <span style="color:var(--c-warning);">⏳ Pending Review</span>';
      else html += ' <span style="color:var(--text-muted);">Empty</span>';
      html += '</div>';
    } else {
      html += '<span style="color:var(--text-muted);">' + slotName + '</span>';
      html += '<div class="tv-slot-type">Click to fill details →</div>';
    }
    html += '</div>'; // summary

    /* Share button (generate guest link + QR) */
    html += '<button class="tv-slot-share-btn" data-slot-share="' + slotKey + '" title="Generate share link for this traveller">🔗</button>';

    html += '</div>'; // slot-item
    return html;
  }

  function wireListActions() {
    // Click on slot card → navigate to individual page
    document.querySelectorAll('[data-act="go-to-slot"]').forEach(function (el) {
      el.addEventListener('click', function () {
        var slotItem = this.closest('[data-slot-key]');
        if (slotItem) {
          var url = slotItem.dataset.url;
          if (url) window.location.href = url;
        }
      });
    });

    // Share button → generate guest link + QR modal
    document.querySelectorAll('[data-slot-share]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation(); // prevent triggering slot navigation
        var slotKey = this.dataset.slotShare;
        if (slotKey) handleSlotShare(slotKey, this);
      });
    });
  }

  /* ── Generate Guest Share Link + QR Modal ── */
  async function handleSlotShare(slotName, btn) {
    var origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '…';
    try {
      var res = await API_TV('request_guest_passport_link', {
        booking_number: BOOKING_REF,
        slot_name: slotName
      });
      var link = res.link || '';
      var qrUri = res.qr_data_uri || '';
      var exp = res.expires_on ? res.expires_on.slice(0, 10) : '';
      if (!link) throw new Error('Could not generate share link.');
      showTravellerShareModal(link, qrUri, exp);
    } catch (e) {
      showToast(e.message || 'Failed to generate share link.', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }

  function showTravellerShareModal(shareUrl, qrUri, expiryDate) {
    // Remove existing modal if any
    var existing = document.getElementById('tvShareModal');
    if (existing) existing.remove();

    // Build modal DOM
    var overlay = document.createElement('div');
    overlay.id = 'tvShareModal';
    overlay.className = 'rc-share-modal';

    var waLink = 'https://wa.me/?text=' + encodeURIComponent(
      'Please fill in your passport and travel details for our trip:\n' + shareUrl
    );

    overlay.innerHTML =
      '<div class="rc-share-card">' +
        '<button class="rc-share-close" id="tvShareClose">&times;</button>' +
        '<h3 class="rc-share-title">Share Traveller Link</h3>' +
        '<div class="rc-share-qr-wrap">' +
          (qrUri ? '<img class="rc-share-qr" src="' + _esc(qrUri) + '" alt="QR Code">' :
            '<div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;color:#B0AC9F;border:1px solid #eee;border-radius:12px;">No QR</div>') +
        '</div>' +
        '<div class="rc-share-url">' + _esc(shareUrl) + '</div>' +
        '<button class="rc-share-copy" id="tvShareCopy">Copy Link</button>' +
        '<a href="' + _esc(waLink) + '" target="_blank" rel="noopener" class="rc-share-copy" ' +
          'style="display:block;margin-top:8px;background:#25D366;color:#fff;text-decoration:none;">Share via WhatsApp</a>' +
        (expiryDate ? '<p class="rc-booking-note">Link valid until ' + _esc(expiryDate) + '</p>' : '') +
      '</div>';

    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(function () {
      overlay.classList.add('rc-share-modal-show');
    });

    // Close handlers
    var closeFn = function () {
      overlay.classList.remove('rc-share-modal-show');
      setTimeout(function () { overlay.remove(); }, 300);
    };
    document.getElementById('tvShareClose').addEventListener('click', closeFn);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeFn(); });

    // Copy handler
    document.getElementById('tvShareCopy').addEventListener('click', function () {
      copyToClipboard(shareUrl);
      showToast('Link copied to clipboard!', 'success');
    });
  }

  /* ── Clipboard helper (same pattern as trip_detail.js) ── */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { /* fallback */ });
    } else {
      var inp = document.createElement('input');
      inp.value = text;
      inp.style.position = 'fixed'; inp.style.opacity = '0';
      document.body.appendChild(inp);
      inp.select();
      try { document.execCommand('copy'); } catch (e) { /* silent */ }
      document.body.removeChild(inp);
    }
  }

  /* ══════════════════════════════════════════════════════════
     MOD 2: INDIVIDU SLOT (passport OCR wizard + form tabs)
     ══════════════════════════════════════════════════════════ */

  async function initDetailMode() {
    try {
      var data = await API_BK('get_booking_data', { booking_number: BOOKING_REF });
      bookingData = data;

      // Find the requested slot
      var slot = null;
      var allSlots = data.slots || [];
      (data.cabins || []).forEach(function (c) {
        (c.slots || []).forEach(function (s) { allSlots.push(s); });
      });
      
      // Try slot_res from pageData first, then URL param
      var resParam = SLOT_RES;
      if (!resParam) {
        try { resParam = new URLSearchParams(window.location.search).get('res') || ''; } catch (e) {}
      }
      
      slot = allSlots.find(function (s) { return s.slot_name === resParam; });

      if (!slot) {
        showDetailError('Traveller slot not found. Please go back and select a valid traveller.');
        return;
      }

      ACTIVE_SLOT = slot;

      // Hide loading
      var loading = document.getElementById('tvl-docs-loading');
      if (loading) loading.style.display = 'none';

      // Load countries for nationality dropdown
      try { countries = await API_TV('get_countries', {}); } catch (e) {}

      // Determine starting view based on slot state
      if (slot.filled || slot.traveller_id) {
        // Slot already has data → go straight to form (edit mode)
        _loadTravellerForm(slot);
      } else {
        // Empty slot → start with passport upload wizard (Step 1)
        resetWizard();
        showDetailView('V-wizard');
      }
    } catch (e) {
      showDetailError(e.message || 'Failed to load traveller details.');
    }
  }

  function showDetailView(viewId) {
    ['V-wizard', 'V-form'].forEach(function (v) {
      var el = document.getElementById(v);
      if (el) el.style.display = (v === viewId) ? '' : 'none';
    });
    window.scrollTo(0, 0);
  }

  function showDetailError(msg) {
    var loading = document.getElementById('tvl-docs-loading');
    if (loading) {
      loading.style.display = 'block';
      loading.innerHTML = '<div style="font-size:14px;color:var(--c-danger-text);padding:20px;">' + _esc(msg) + '</div>' +
        '<div style="margin-top:12px;"><a href="/traveller/travellers?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--ghost tv-btn--sm">← Back to Traveller List</a></div>';
    }
  }

  /* ── WIZARD: Step 1 — Upload Passport for OCR ── */

  function resetWizard() {
    _wizardFile = null;
    _wizardResult = null;
    _wizardExtracted = null;

    // Hide all messages
    var msg = document.getElementById('wiz-msg');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }

    // Hide result cards
    var resultCard = document.getElementById('wiz-result-card');
    var newCard = document.getElementById('wiz-new-card');
    if (resultCard) resultCard.style.display = 'none';
    if (newCard) newCard.style.display = 'none';

    // Show input card with upload area visible, checking hidden
    var inputCard = document.getElementById('wiz-input-card');
    if (inputCard) inputCard.style.display = 'block';

    var uploadArea = document.getElementById('wiz-upload-area');
    var checkingState = document.getElementById('wiz-checking-state');
    if (uploadArea) {
      uploadArea.style.display = '';
      uploadArea.style.borderColor = '';
    }
    if (checkingState) checkingState.style.display = 'none';

    // Reset upload text
    var uploadTxt = document.getElementById('wiz-upload-txt');
    if (uploadTxt) uploadTxt.textContent = 'Upload passport copy';

    // Reset button
    var btn = document.getElementById('wiz-btn');
    if (btn) { btn.disabled = false; btn.style.display = 'none'; btn.textContent = 'Check passport →'; }
  }

  function triggerWizardPassportUpload() {
    _pickImage(function (file) {
      _wizardFile = file;
      var txt = document.getElementById('wiz-upload-txt');
      if (txt) txt.textContent = '✓ ' + file.name;
      var area = document.getElementById('wiz-upload-area');
      if (area) area.style.borderColor = '#0F6E56';
      var resultCard = document.getElementById('wiz-result-card');
      var newCard = document.getElementById('wiz-new-card');
      if (resultCard) resultCard.style.display = 'none';
      if (newCard) newCard.style.display = 'none';
      var btn = document.getElementById('wiz-btn');
      if (btn) { btn.style.display = 'block'; }
      var msg = document.getElementById('wiz-msg');
      if (msg) msg.style.display = 'none';
    }, 'wiz-msg');
  }

  async function checkWizardPassport() {
    if (!_wizardFile) return;

    // ── UI State: HIDE upload area, SHOW checking spinner ──
    var uploadArea = document.getElementById('wiz-upload-area');
    var checkingState = document.getElementById('wiz-checking-state');
    var btn = document.getElementById('wiz-btn');
    var msgEl = document.getElementById('wiz-msg');

    if (uploadArea) uploadArea.style.display = 'none';
    if (checkingState) checkingState.style.display = 'block';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
    if (msgEl) msgEl.style.display = 'none';

    try {
      var filedata = await _readFileAsDataURL(_wizardFile);

      var res = await API_TV('check_traveller_passport', { filedata: filedata });

      // ── Hide checking state regardless of result ──
      if (checkingState) checkingState.style.display = 'none';
      if (btn) { btn.disabled = false; btn.textContent = 'Check passport →'; }

      // Imej tak dapat dibaca → show error + upload area again
      if (res.status === 'unreadable') {
        _wizMsg('We could not read this passport image. Please upload a clearer photo of the passport photo page — all four corners visible, no glare, text sharp.', 'error');
        if (uploadArea) uploadArea.style.display = '';
        return;
      }

      // Success: hide upload area, show result card
      if (uploadArea) uploadArea.style.display = 'none';
      if (btn) btn.style.display = 'none';

      if (res.status === 'found' && res.data) {
        _wizardResult = res.data;
        _wizardExtracted = res.extracted || null;

        // Merge existing traveller data with latest OCR extraction for complete display
        var displayData = Object.assign({}, res.extracted || {}, res.data);

        var fullName = displayData.full_name || '';
        var initialEl = document.getElementById('wiz-result-initial');
        var nameEl = document.getElementById('wiz-result-name');
        var icEl = document.getElementById('wiz-result-ic');
        if (initialEl) initialEl.textContent = fullName.trim().charAt(0).toUpperCase() || '?';
        if (nameEl) nameEl.textContent = fullName;
        if (icEl) icEl.textContent = 'IC: ' + (displayData.ic_number || '');

        // Show ALL extracted fields in result card
        var foundFieldsEl = document.getElementById('wiz-result-fields');
        if (foundFieldsEl) {
          foundFieldsEl.innerHTML = _renderExtractedFields(displayData);
          foundFieldsEl.style.display = 'block';
        }

        var resultCard = document.getElementById('wiz-result-card');
        if (resultCard) resultCard.style.display = 'block';

      } else {
        _wizardResult = null;
        _wizardExtracted = res.extracted || null;
        var ex = res.extracted || {};

        // Show ALL extracted fields — comprehensive list
        var readEl = document.getElementById('wiz-new-read');
        if (readEl) {
          readEl.style.display = 'block';
          readEl.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">✓ Read from passport:</div>' +
            _renderExtractedFields(ex);
        }

        var newCard = document.getElementById('wiz-new-card');
        if (newCard) newCard.style.display = 'block';
      }
    } catch (e) {
      // Restore UI: hide checking, show upload area with error
      var checkingState = document.getElementById('wiz-checking-state');
      var uploadArea = document.getElementById('wiz-upload-area');
      
      if (checkingState) checkingState.style.display = 'none';
      if (uploadArea) uploadArea.style.display = '';
      if (btn) { btn.disabled = false; btn.textContent = 'Check passport →'; }
      _wizMsg(e.message || 'Something went wrong. Please try again.', 'error');
    }
  }

  /* Passport dari wizard dibawa ke form */
  function _applyWizardPassportFile() {
    if (!_wizardFile) return;
    _passportFile = _wizardFile;
    var txt = document.getElementById('passport-upload-txt');
    if (txt) txt.textContent = '✓ ' + _wizardFile.name;
    var area = document.getElementById('passport-upload-area');
    if (area) area.style.borderColor = '#0F6E56';
  }

  /* ── Render ALL extracted passport fields in a nice format ──
     Maps raw field names to user-friendly labels and shows everything
     that was successfully extracted from the passport OCR/MRZ. */
  function _renderExtractedFields(data) {
    if (!data || typeof data !== 'object') return '';

    // Field definitions: [key, label, icon, transform fn]
    var fieldDefs = [
      ['full_name',        'Full Name',           '👤', null],
      ['first_name',       'First Name',          '👤', null],
      ['last_name',        'Last Name',           '👤', null],
      ['passport_no',      'Passport Number',      '🛂', null],
      ['ic_number',        'IC / National ID',    '🆔', null],
      ['date_of_birth',    'Date of Birth',        '🎂', null],
      ['gender',           'Gender',               '⚥',  function(v) { return v === 'M' ? 'Male' : (v === 'F' ? 'Female' : v); }],
      ['nationality',      'Nationality',          '🌏', null],
      ['nationality_code', 'Nationality Code',     '🌏', null],
      ['passport_expiry',  'Passport Expiry',      '📅', null],
      ['place_of_birth',   'Place of Birth',       '📍', null],  // if available from visual OCR
      ['issue_date',       'Issue Date',           '📋', null]    // if available from visual OCR
    ];

    var rows = [];
    var filledCount = 0;

    fieldDefs.forEach(function (def) {
      var key = def[0];
      var label = def[1];
      var icon = def[2];
      var transform = def[3];
      var value = data[key];

      // Skip empty values (but show IC as "not detected" for visibility)
      if (!value && value !== 0) {
        if (key === 'ic_number') {
          value = 'not detected — please fill in manually';
        } else {
          return; // skip other empty fields
        }
      }

      // Apply transform if exists (e.g., gender M→Male)
      if (transform && typeof transform === 'function') {
        value = transform(value);
      }

      // Format value display
      var displayVal = String(value).trim();
      var isEmptyOrPlaceholder = !displayVal || displayVal === 'not detected — please fill in manually';

      var rowClass = isEmptyOrPlaceholder ? 'style="color:var(--text-muted);"' : 'style="color:var(--text-primary);"';
      var valClass = isEmptyOrPlaceholder ? 'font-style:italic;font-size:12px;' : 'font-weight:500;';

      rows.push(
        '<div style="display:flex;align-items:baseline;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-light);">' +
          '<span style="font-size:12px;color:var(--text-muted);min-width:24px;">' + icon + '</span>' +
          '<span style="font-size:12px;color:var(--text-secondary);min-width:130px;flex-shrink:0;">' + label + '</span>' +
          '<span ' + rowClass + ' class="' + valClass + '">' + _esc(displayVal) + '</span>' +
        '</div>'
      );

      if (!isEmptyOrPlaceholder) filledCount++;
    });

    // Summary header with count
    var html = '<div style="background:var(--c-success-bg);border-radius:8px;padding:14px;margin-top:8px;">';
    html += '<div style="font-size:13px;font-weight:600;color:var(--c-success-text);margin-bottom:10px;display:flex;align-items:center;gap:6px;">';
    html += '<span>✓</span> <span>' + filledCount + ' field(s) extracted from passport</span></div>';
    html += '<div>';
    html += rows.join('');
    html += '</div></div>';

    return html;
  }

  async function wizardConfirm() {
    if (!_wizardResult) return;

    // Merge: slot data → existing traveller record → latest OCR extraction
    // Priority: OCR extraction (newest) > existing traveller > current slot
    var merged = Object.assign({}, ACTIVE_SLOT || {}, _wizardResult, _wizardExtracted || {});

    // Ensure first_name/last_name are properly split from full_name if needed
    if (merged.full_name && (!merged.first_name && !merged.last_name)) {
      var parts = String(merged.full_name).trim().split(/\s+/);
      if (parts.length >= 2) {
        merged.first_name = parts[0];
        merged.last_name = parts.slice(1).join(' ');
      } else if (parts.length === 1) {
        merged.first_name = parts[0];
      }
    }

    await _loadTravellerForm(merged);
    _applyWizardPassportFile();
  }

  async function wizardContinueNew() {
    // Use ALL extracted data for new traveller
    var formData = Object.assign({}, _wizardExtracted || {});

    // Ensure first_name/last_name are split from full_name
    if (formData.full_name && (!formData.first_name && !formData.last_name)) {
      var parts = String(formData.full_name).trim().split(/\s+/);
      if (parts.length >= 2) {
        formData.first_name = parts[0];
        formData.last_name = parts.slice(1).join(' ');
      } else if (parts.length === 1) {
        formData.first_name = parts[0];
      }
    }

    await _loadTravellerForm(formData);
    _applyWizardPassportFile();
  }

  function _wizMsg(text, type) {
    var el = document.getElementById('wiz-msg');
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.background = type === 'error' ? '#FCEBEB' : '#FAEEDA';
    el.style.color = type === 'error' ? '#501313' : '#633806';
  }

  /* ── FORM: Load & Display ── */

  async function _loadTravellerForm(slot) {
    await _loadCountries();
    _sectionsSaved = { passport: false, contact: false, health: false };

    var isVerified      = slot && (slot.is_verified || slot.document_status === 'Verified');
    var isOpenForUpdate = slot && slot.document_status === 'Open for Update';
    var canEdit         = !isVerified || isOpenForUpdate;

    // Fill form fields
    _setVal('tvl-ic', slot?.ic_number || '');
    _setVal('tvl-firstname', slot?.first_name || '');
    _setVal('tvl-lastname', slot?.last_name || '');
    _setVal('tvl-name', slot?.full_name || '');
    _setVal('tvl-dob', slot?.date_of_birth || '');
    _setVal('tvl-nat', slot?.nationality || '');
    _setVal('tvl-gender', slot?.gender || '');
    _setVal('tvl-phone-num', slot?.phone || '');
    _setVal('tvl-ec-phone', slot?.emergency_contact_phone || '');
    _setVal('tvl-email', slot?.email || '');
    _setVal('tvl-pp', slot?.passport_no || '');
    _setVal('tvl-ppexp', slot?.passport_expiry || '');
    _setVal('tvl-ec-name', slot?.emergency_contact_name || '');
    _setVal('tvl-ec-relationship', slot?.emergency_contact_relationship || '');
    _setVal('tvl-dietary', slot?.dietary_requirements || '');
    _setVal('tvl-medical', slot?.medical_conditions || '');
    _setVal('tvl-medicine', slot?.medicine_treatment || '');
    _setVal('tvl-special-needs', slot?.special_needs || '');
    _setVal('tvl-wheelchair', slot?.wheelchair_assistant || '');

    // Reset errors + consent
    _clearAllFieldErrors();
    var consent = document.getElementById('tvl-pdpa-consent');
    if (consent) consent.checked = false;
    var formErr = document.getElementById('tvl-form-error');
    if (formErr) formErr.style.display = 'none';

    // Reset passport upload — toggle between "uploaded" and "empty" states
    _passportFile = null;
    var ppUploaded = document.getElementById('passport-uploaded');   // State A: has image
    var ppArea = document.getElementById('passport-upload-area');  // State B: empty, show upload
    if (slot?.has_passport) {
      // Show uploaded state with preview
      if (ppUploaded) ppUploaded.style.display = '';
      if (ppArea) ppArea.style.display = 'none';
    } else {
      // Show empty upload area
      if (ppUploaded) ppUploaded.style.display = 'none';
      if (ppArea) {
        ppArea.style.display = '';
        ppArea.style.borderColor = '';
      }
      var ppTxt = document.getElementById('passport-upload-txt');
      if (ppTxt) ppTxt.textContent = 'Upload passport copy';
    }

    // Reset visa upload
    var visaTxt = document.getElementById('visa-photo-upload-txt');
    if (visaTxt) visaTxt.textContent = 'Upload photo';
    var visaArea = document.getElementById('visa-photo-upload-area');
    if (visaArea) visaArea.style.borderColor = '';
    _visaPhotoFile = null;
    var visaExisting = document.getElementById('visa-photo-existing');
    if (visaExisting) visaExisting.style.display = slot?.has_visa_photo ? '' : 'none';
    var visaBadge = document.getElementById('visa-photo-badge');
    if (visaBadge) visaBadge.style.display = slot?.has_visa_photo ? 'inline-block' : 'none';

    // Passport validity check
    ['pp-validity-badge', 'pp-validity-note', 'pp-validity-info'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    var ppexpInput = document.getElementById('tvl-ppexp');
    if (ppexpInput) ppexpInput.style.borderColor = '';

    // Editable state
    var inputs = document.querySelectorAll('#V-form input:not([readonly]), #V-form select, #V-form textarea');
    inputs.forEach(function (i) { i.disabled = !canEdit; });
    var confirmBtn = document.getElementById('tvl-confirm-btn');
    if (confirmBtn) confirmBtn.style.display = canEdit ? '' : 'none';

    // Check passport validity if expiry exists
    if (slot?.passport_expiry) _checkPassportValidity();

    _resetTabs();
    showDetailView('V-form');

    // Load passport preview
    _loadPassportPreview(slot);

    // Update slot header info
    _renderSlotHeader(slot);
  }

  function _renderSlotHeader(slot) {
    var hdr = document.getElementById('tvl-slot-header');
    if (!hdr || !slot) return;
    var isFilled = slot.filled || slot.traveller_id;
    var isVerified = slot.is_verified || slot.document_status === 'Verified';
    var statusText = isVerified ? '✓ Verified' : (isFilled ? '⏳ Pending Review' : 'Not filled');
    var statusColor = isVerified ? 'var(--c-success)' : (isFilled ? 'var(--c-warning)' : 'var(--text-muted)');
    
    hdr.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">' + _esc(slot.slot_label || 'Traveller') + '</div>' +
        '<span style="font-size:12px;font-weight:600;color:' + statusColor + ';">' + statusText + '</span>' +
      '</div>' +
      (slot.full_name ? '<div style="font-size:15px;font-weight:600;margin-top:4px;">' + _esc(slot.full_name) + '</div>' : '') +
      (slot.ic_number ? '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + _esc(slot.ic_number) + '</div>' : '');
  }

  function _setVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val;
  }

  function _clearAllFieldErrors() {
    document.querySelectorAll('#V-form .f-err').forEach(function (el) { el.style.display = 'none'; el.textContent = ''; });
    document.querySelectorAll('#V-form input, #V-form select, #V-form textarea').forEach(function (el) { el.style.borderColor = ''; });
  }

  function _loadCountries() {
    if (countries && countries.length) {
      var sel = document.getElementById('tvl-nat');
      if (sel) {
        var current = sel.value || '';
        sel.innerHTML = '<option value="">Select nationality</option>' +
          countries.map(function (c) {
            var name = c.name || c.country_name || c;
            return '<option value="' + _esc(name) + '">' + _esc(name) + '</option>';
          }).join('');
        if (current) sel.value = current;
      }
    }
  }

  function _checkPassportValidity() {
    var expiry = document.getElementById('tvl-ppexp')?.value;
    var badge = document.getElementById('pp-validity-badge');
    if (!expiry || !badge) return;

    var depDateStr = bookingData?.booking?.departure_date || '';
    if (!depDateStr) return;

    var departure = new Date(depDateStr);
    var minValid = new Date(departure);
    minValid.setMonth(minValid.getMonth() + 6);
    var expiryDate = new Date(expiry);
    var isValid = expiryDate >= minValid;

    var fmtD = function (d) { return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }); };

    badge.style.display = 'inline-block';
    var note = document.getElementById('pp-validity-note');
    var infoBox = document.getElementById('pp-validity-info');
    var infoText = document.getElementById('pp-validity-info-text');
    var ppexpInput = document.getElementById('tvl-ppexp');

    if (isValid) {
      badge.textContent = '✓ Valid';
      badge.style.background = '#DCFCE7'; badge.style.color = '#166534';
      if (note) { note.style.display = 'block'; note.textContent = 'Passport is valid for this trip.'; note.style.color = '#166534'; }
      if (ppexpInput) ppexpInput.style.borderColor = '#86EFAC';
      if (infoText) infoText.innerHTML = 'Passport must be valid for at least <strong>6 months</strong> from departure <strong>' + fmtD(departure) + '</strong> — valid until at least <strong>' + fmtD(minValid) + '</strong>. ✓ Meets requirement.';
    } else {
      badge.textContent = '✗ Not valid';
      badge.style.background = '#FEE2E2'; badge.style.color = '#991B1B';
      if (note) { note.style.display = 'block'; note.textContent = 'Must be valid until at least ' + fmtD(minValid) + '.'; note.style.color = '#991B1B'; }
      if (ppexpInput) ppexpInput.style.borderColor = '#FCA5A5';
      if (infoText) infoText.innerHTML = 'Passport must be valid for at least <strong>6 months</strong> from departure <strong>' + fmtD(departure) + '</strong>. ✗ Passport expires too early — please renew before the trip.'; infoText.style.color = '#991B1B';
    }
    if (note) note.style.display = 'block';
    if (infoBox) infoBox.style.display = 'block';
  }

  /* ── File Upload Helpers ── */

  function _pickImage(onPicked, errBoxId, opts) {
    var skipValidation = opts && opts.skipValidation;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png';
    input.onchange = function (e) {
      var file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        _showInlineError(errBoxId, 'File must be under 5MB — "' + file.name + '" is ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.');
        return;
      }
      _hideInlineError(errBoxId);

      // Only run quality validation for passport images (not visa)
      if (skipValidation) {
        onPicked(file);
        return;
      }

      _validatePassportImage(file, errBoxId, function (isValid, warnings) {
        onPicked(file);
      });
    };
    input.click();
  }

  /* ── Client-side passport image quality validation ──
     Checks image dimensions and basic quality before uploading.
     Returns (isValid, warnings[]) — doesn't block upload, just warns user.
  */
  function _validatePassportImage(file, errBoxId, callback) {
    var warnings = [];
    
    // Use FileReader to get image data URL for canvas analysis
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var w = img.width;
        var h = img.height;
        
        // Check 1: Minimum dimensions (OCR needs sufficient resolution)
        if (w < 800 || h < 500) {
          warnings.push('Image may be too small (' + w + '×' + h + '). For best results, use a photo at least 1200px wide.');
        }
        
        // Check 2: Aspect ratio (passport is roughly 1.42:1 for ID-3)
        var ratio = w / h;
        if (ratio < 1.2 || ratio > 2.0) {
          warnings.push('Unusual aspect ratio. Make sure the entire passport page is visible, including MRZ zone at bottom.');
        }
        
        // Check 3: Analyze brightness/contrast using canvas
        try {
          var canvas = document.createElement('canvas');
          var ctx = canvas.getContext('2d');
          canvas.width = Math.min(w, 200); // Sample at smaller size for performance
          canvas.height = Math.min(h, Math.floor(200 * h / w));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          
          var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var data = imageData.data;
          
          // Calculate average brightness
          var totalBrightness = 0;
          var pixelCount = data.length / 4;
          for (var i = 0; i < data.length; i += 4) {
            // Convert to perceived brightness (luminance formula)
            totalBrightness += (0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
          }
          var avgBrightness = totalBrightness / pixelCount;
          
          // Calculate contrast (standard deviation of brightness)
          var sumDiffSq = 0;
          for (var j = 0; j < data.length; j += 4) {
            var b = (0.299 * data[j] + 0.587 * data[j+1] + 0.114 * data[j+2]);
            sumDiffSq += Math.pow(b - avgBrightness, 2);
          }
          var contrast = Math.sqrt(sumDiffSq / pixelCount);
          
          // Warn if too dark (underexposed) or too bright (overexposed/glare)
          if (avgBrightness < 80) {
            warnings.push('Image appears quite dark. Ensure good lighting when photographing the passport.');
          } else if (avgBrightness > 220) {
            warnings.push('Image may be overexposed or have glare. Avoid direct flash on laminated surface.');
          }
          
          // Warn if low contrast (blurry or uniform lighting)
          if (contrast < 30) {
            warnings.push('Low image contrast — possible blur or glare. Hold steady and ensure text is sharp.');
          }
          
        } catch (canvasErr) {
          // Canvas analysis failed — continue without it
          console.warn('Canvas analysis skipped:', canvasErr);
        }
        
        // Return results
        callback(true, warnings);
      };
      img.onerror = function () {
        // Image load failed — allow upload anyway
        callback(true, ['Could not analyze image preview. Upload will proceed.']);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function triggerPassportUpload() {
    _pickImage(function (file) {
      _passportFile = file;
      
      // Check if we're in "replace" mode (uploaded state visible) or "new upload" mode
      var ppUploaded = document.getElementById('passport-uploaded');
      var ppArea = document.getElementById('passport-upload-area');
      
      if (ppUploaded && ppUploaded.style.display !== 'none') {
        // Replace mode: update the replace area to show new file selected
        var replaceArea = document.getElementById('passport-replace-area');
        if (replaceArea) {
          replaceArea.innerHTML = '<span style="color:var(--c-success);">✓</span> <strong>' + _esc(file.name) + '</strong> — Save to confirm replacement';
          replaceArea.style.background = 'var(--c-success-bg)';
          replaceArea.style.borderColor = 'var(--c-success)';
        }
      } else {
        // New upload mode: update the upload area
        var txt = document.getElementById('passport-upload-txt');
        if (txt) txt.textContent = '✓ ' + file.name;
        var area = document.getElementById('passport-upload-area');
        if (area) area.style.borderColor = '#0F6E56';
      }
    }, 'passport-upload-err');
  }

  function triggerVisaPhotoUpload() {
    _pickImage(function (file) {
      _visaPhotoFile = file;
      var txt = document.getElementById('visa-photo-upload-txt');
      if (txt) txt.textContent = '✓ ' + file.name;
      var area = document.getElementById('visa-photo-upload-area');
      if (area) area.style.borderColor = '#0F6E56';
    }, 'visa-upload-err', { skipValidation: true });
  }

  /* Toggle visa card */
  window.toggleVisaCard = function () {
    var body = document.getElementById('visa-photo-body');
    if (!body) return;
    var open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    var chev = document.getElementById('visa-photo-chevron');
    if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
  };

  /* ── Save by Section ── */

  window.saveTraveller = async function (section, btnEl) {
    var get = function (id) { return document.getElementById(id); };

    var firstName = get('tvl-firstname').value.trim();
    var lastName  = get('tvl-lastname').value.trim();
    var phoneNum  = get('tvl-phone-num').value.trim();
    var ecName    = get('tvl-ec-name').value.trim();
    var ecPhone   = get('tvl-ec-phone').value.trim();
    var ecRel     = get('tvl-ec-relationship').value.trim();
    var ic        = get('tvl-ic').value.trim();
    var nat       = get('tvl-nat').value;
    var dob       = get('tvl-dob').value;
    var gender    = get('tvl-gender').value;
    var pp        = get('tvl-pp').value.trim();
    var ppexp     = get('tvl-ppexp').value;
    var consent   = get('tvl-pdpa-consent').checked;

    // Clear errors
    _clearAllFieldErrors();
    var formErr = get('tvl-form-error');
    if (formErr) formErr.style.display = 'none';

    var fail = function (el, msg, tab) {
      if (el) el.style.borderColor = '#F87171';
      var slot = el.parentElement.querySelector(':scope > .f-err');
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'f-err';
        slot.setAttribute('role', 'alert');
        slot.style.cssText = 'display:none;font-size:11px;color:#C0392B;margin-top:4px;';
        el.parentElement.appendChild(slot);
      }
      slot.textContent = msg;
      slot.style.display = 'block';
      tvlGoToTab(tab);
      if (el) el.focus({ preventScroll: false });
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    };

    // Validate section-specific fields
    if (section === 'passport') {
      if (!firstName) return fail(get('tvl-firstname'), 'First name is required.', 'passport');
      if (!lastName)  return fail(get('tvl-lastname'), 'Last name is required.', 'passport');
      if (!ic)        return fail(get('tvl-ic'), 'IC Number is required.', 'passport');
    }
    if (section === 'contact') {
      var emailVal = get('tvl-email').value.trim();
      if (!phoneNum) return fail(get('tvl-phone-num'), 'Phone number is required.', 'contact');
      if (!emailVal) return fail(get('tvl-email'), 'Email is required.', 'contact');
      if ((ecName || ecPhone || ecRel) && (!ecName || !ecPhone || !ecRel)) {
        if (!ecName) return fail(get('tvl-ec-name'), 'Please complete emergency contact.', 'contact');
        if (!ecPhone) return fail(get('tvl-ec-phone'), 'Please complete emergency contact.', 'contact');
        return fail(get('tvl-ec-relationship'), 'Please complete emergency contact.', 'contact');
      }
    }

    // PDPA consent required
    if (!consent) {
      fail(get('tvl-pdpa-consent'), 'Please accept the Privacy Notice.', 'passport');
      _showInlineError('tvl-form-error', 'Please accept the Privacy Notice so we can store these details.');
      return;
    }

    var btn = btnEl || get('tvl-confirm-btn');
    var btnLabel = btn ? btn.textContent : '';
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

    try {
      var payload = {
        booking_number: BOOKING_REF,
        slot_name: ACTIVE_SLOT.slot_name,
        section: section,
        pdpa_consent: true
      };

      if (section === 'passport') {
        var filedata = '', filename = '';
        if (_passportFile) { 
          var fd = await _readFileAsDataURL(_passportFile);
          filedata = fd; filename = _passportFile.name; 
        }
        Object.assign(payload, {
          first_name: firstName, last_name: lastName,
          full_name: get('tvl-name').value.trim(),
          gender: gender, ic_number: ic,
          date_of_birth: dob, nationality: nat,
          passport_no: pp, passport_expiry: ppexp,
          filedata: filedata, filename: filename
        });
      } else if (section === 'contact') {
        var visaFd = '', visaFn = '';
        if (_visaPhotoFile) { 
          var vfd = await _readFileAsDataURL(_visaPhotoFile);
          visaFd = vfd; visaFn = _visaPhotoFile.name; 
        }
        Object.assign(payload, {
          email: get('tvl-email').value || '',
          phone: phoneNum,
          emergency_contact_name: ecName,
          emergency_contact_phone: ecPhone,
          emergency_contact_relationship: ecRel,
          visa_filedata: visaFd, visa_filename: visaFn
        });
      } else {
        Object.assign(payload, {
          dietary_requirements: get('tvl-dietary').value.trim(),
          medical_conditions: get('tvl-medical').value.trim(),
          special_needs: get('tvl-special-needs').value.trim(),
          wheelchair_assistant: get('tvl-wheelchair').value,
          medicine_treatment: get('tvl-medicine').value.trim()
        });
      }

      await API_TV('save_booking_traveller', payload);
      _sectionsSaved[section] = true;

      // Refresh data
      var fresh = await API_BK('get_booking_data', { booking_number: BOOKING_REF });
      bookingData = fresh;
      if (ACTIVE_SLOT) {
        var s = (fresh.slots || []).find(function (x) { return x.slot_name === ACTIVE_SLOT.slot_name; });
        if (s) ACTIVE_SLOT = s;
      }

      // Reset file fields after save
      if (section === 'passport') {
        _passportFile = null;
        
        // Reset replace area (if in replace mode)
        var replaceArea = document.getElementById('passport-replace-area');
        if (replaceArea) {
          replaceArea.innerHTML = '<span>📷</span> Replace passport image';
          replaceArea.style.background = '';
          replaceArea.style.borderColor = '';
        }
        
        // Reset upload area text (if in new upload mode)
        var pptxt = document.getElementById('passport-upload-txt');
        if (pptxt) pptxt.textContent = 'Upload passport copy';
        
        // Reload preview to show updated state
        _loadPassportPreview(ACTIVE_SLOT);
      }
      if (section === 'contact') {
        _visaPhotoFile = null;
        var vtxt = document.getElementById('visa-photo-upload-txt');
        if (vtxt) vtxt.textContent = 'Upload photo';
        var ve = document.getElementById('visa-photo-existing');
        if (ve) ve.style.display = (ACTIVE_SLOT && ACTIVE_SLOT.has_visa_photo) ? '' : 'none';
      }

      // Show saved notification
      var note = document.getElementById('tvl-saved-note');
      if (note) {
        note.style.display = 'block';
        note.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function () { note.style.display = 'none'; }, 4000);
      }

      showToast(section.charAt(0).toUpperCase() + section.slice(1) + ' saved!', 'success');
    } catch (e) {
      _showInlineError('tvl-form-error', e.message || 'An error occurred. Please try again.');
    } finally {
      if (btn) { btn.textContent = btnLabel; btn.disabled = false; }
    }
  };

  /* ── Confirm All Sections ── */

  window.confirmTravellerDocs = async function () {
    var get = function (id) { return document.getElementById(id); };
    var formErr = get('tvl-form-error');
    if (formErr) formErr.style.display = 'none';

    if (!ACTIVE_SLOT) return;

    var notSaved = ['passport', 'contact', 'health'].filter(function (s) { return !_sectionsSaved[s]; });
    if (notSaved.length && !ACTIVE_SLOT.filled) {
      _showInlineError('tvl-form-error', 'Please save every section (Passport, Contact Info, Health) before confirming.');
      return;
    }

    var btn = get('tvl-confirm-btn');
    btn.textContent = 'Confirming...';
    btn.disabled = true;
    try {
      await API_TV('confirm_traveller_documents', {
        booking_number: BOOKING_REF,
        slot_name: ACTIVE_SLOT.slot_name
      });
      // Go back to list after confirmation
      window.location.href = '/traveller/travellers?ref=' + encodeURIComponent(BOOKING_REF);
    } catch (e) {
      _showInlineError('tvl-form-error', e.message || 'An error occurred. Please try again.');
      btn.textContent = '✓ I confirm all information is complete';
      btn.disabled = false;
    }
  };

  /* ── TABS ── */

  var TVL_TAB_ORDER = ['passport', 'contact', 'health'];

  window.tvlShowTab = function (tabId) {
    if (TVL_TAB_ORDER.indexOf(tabId) === -1) return;
    document.querySelectorAll('.tvl-panel').forEach(function (p) {
      p.classList.toggle('on', p.getAttribute('data-panel') === tabId);
      p.style.display = '';
    });
    document.querySelectorAll('.tvl-tab').forEach(function (t) {
      var on = t.getAttribute('data-tab') === tabId;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    window.scrollTo(0, 0);
  };

  window.tvlGoToTab = function (tabId) { tvlShowTab(tabId); };
  
  function _resetTabs() { tvlShowTab('passport'); }

  /* ── Passport Preview ── */

  async function _loadPassportPreview(slot) {
    var preview = document.getElementById('passport-preview');
    var filenameEl = document.getElementById('passport-filename');
    
    // If no passport or element missing, ensure upload state is shown
    if (!preview || !slot || !slot.has_passport) {
      var ppUploaded = document.getElementById('passport-uploaded');
      var ppArea = document.getElementById('passport-upload-area');
      if (ppUploaded) ppUploaded.style.display = 'none';
      if (ppArea) ppArea.style.display = '';
      return;
    }

    try {
      var res = await API_TV('get_slot_file', {
        booking_number: BOOKING_REF,
        slot_name: slot.slot_name,
        field: 'passport_image'
      });

      if (res && res.data_url) {
        // Show uploaded state with image preview
        preview.src = res.data_url;
        preview.style.display = '';
        preview.classList.remove('preview-zoom');

        // Show filename if available
        if (filenameEl) {
          filenameEl.textContent = res.filename || 'passport_image.jpg';
        }

        // Ensure uploaded container is visible, hide empty upload area
        var ppUploaded = document.getElementById('passport-uploaded');
        var ppArea = document.getElementById('passport-upload-area');
        if (ppUploaded) ppUploaded.style.display = '';
        if (ppArea) ppArea.style.display = 'none';

      } else {
        // No image data — show upload area instead
        var ppUploaded = document.getElementById('passport-uploaded');
        var ppArea = document.getElementById('passport-upload-area');
        if (ppUploaded) ppUploaded.style.display = 'none';
        if (ppArea) ppArea.style.display = '';
      }
    } catch (e) {
      // Error loading — show upload area as fallback
      console.warn('Failed to load passport preview:', e);
      var ppUploaded = document.getElementById('passport-uploaded');
      var ppArea = document.getElementById('passport-upload-area');
      if (ppUploaded) ppUploaded.style.display = 'none';
      if (ppArea) ppArea.style.display = '';
    }
  }

  /* ── Helpers ── */

  function _readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function _showInlineError(boxId, msg) {
    var el = document.getElementById(boxId);
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  }

  function _hideInlineError(boxId) {
    var el = document.getElementById(boxId);
    if (el) el.style.display = 'none';
  }

  /* Sync full name from first + last */
  document.addEventListener('input', function (e) {
    if (e.target.id === 'tvl-firstname' || e.target.id === 'tvl-lastname') {
      var first = (document.getElementById('tvl-firstname')?.value || '').trim();
      var last  = (document.getElementById('tvl-lastname')?.value || '').trim();
      var nameEl = document.getElementById('tvl-name');
      if (nameEl) nameEl.value = [first, last].filter(Boolean).join(' ');
    }
  });

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── Expose functions to global scope for HTML onclick handlers ── */
  window.triggerWizardPassportUpload = triggerWizardPassportUpload;
  window.checkWizardPassport = checkWizardPassport;
  window.wizardConfirm = wizardConfirm;
  window.wizardContinueNew = wizardContinueNew;
  window.triggerPassportUpload = triggerPassportUpload;
  window.triggerVisaPhotoUpload = triggerVisaPhotoUpload;

})();
