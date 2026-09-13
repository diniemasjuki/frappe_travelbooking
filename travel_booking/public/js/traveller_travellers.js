/* ============================================================
   travel_booking/public/js/traveller_travellers.js
   Traveller management page — DUA MOD:
   
   1) SENARAI (tiada 'res' parameter)
      Papar cabin + slot sebagai kad klik sahaja.
      Klik → redirect ke ?ref=XXX&res=YYY (individual slot page).
   
   2) INDIVIDU (ada 'res'=slot_name parameter)
      Form dengan tab (Passport/Contact/Health) terus dibuka.
      Step 1 wizard passport check DIMANSUHKAN — upload passport
      berada di panel Passport dengan auto-scan (AI/OCR) selepas
      gambar dipilih; medan borang diisi automatik.
      SETIAP panel ada bar navigasi bawah sendiri (← Back |
      Save [Section] | Next →) + consent PDPA per panel — corak
      sama dengan guest_passport (traveller_docs_form.html /
      portal_traveller_page.js). Butang confirm di bar akhir kekal
      disabled sehingga semua section disimpan (atau slot sudah
      terisi dari sesi sebelumnya).
   
   Reuses portal_traveller.py APIs.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var BOOKING_REF = _pageData.booking_ref || '';
  var SLOT_RES    = _pageData.slot_res || '';  // slot_name bila ada = mod individu
  var AI_SCAN_ENABLED = !!_pageData.ai_scan_enabled;  // badge/hint: AI vs OCR
  var bookingData = null;
  var countries   = [];

  /* ── Mod individu globals (form) ── */
  let ACTIVE_SLOT     = null;
  let _passportFile   = null;
  let _visaPhotoFile  = null;
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

      // Butang "Add Traveller" per cabin (cabin sharing) — data kelayakan +
      // kadar kategori dari get_shareable_cabins, dipadankan ke senarai
      // cabin ikut cabin_no. Asinkron dengan fail-silent supaya kegagalan
      // endpoint tak sesekali rosakkan senarai utama.
      _shareCabinsMap = await loadShareCabinsMap();

      // Butang "Add Cabin & Traveller" (header senarai) — pilihan kategori
      // bilik pada kadar solo dari get_new_cabin_options. Fail-silent sama:
      // kegagalan endpoint hanya menyembunyikan butang, senarai kekal utuh.
      _newCabinOptions = await loadNewCabinOptions();

      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML = renderSlotList(bookingData, _shareCabinsMap);
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

  /* ── Kelayakan cabin sharing ikut cabin_no (untuk butang Add Traveller
     pada setiap cabin berkekosongan). Return {} bila tiada — B2B
     end-customer (harga tersembunyi): urusan bayaran perbezaan harga
     melibatkan partner, jangan papar butang langsung. ── */
  async function loadShareCabinsMap() {
    if (bookingData && bookingData.booking && bookingData.booking.price_hidden) return {};
    try {
      var res = await API_CS('get_shareable_cabins', { booking_number: BOOKING_REF });
      var map = {};
      ((res && res.cabins) || []).forEach(function (c) {
        if (c && c.eligible) map[c.cabin_no] = c;
      });
      return map;
    } catch (e) {
      console.warn('loadShareCabinsMap failed:', e);
      return {};
    }
  }

  /* ── Pilihan CABIN BAHARU untuk butang "Add Cabin & Traveller" di
     header senarai. Return null bila tidak layak (trip penuh / had
     cabin maksimum) atau B2B end-customer (harga tersembunyi — urusan
     tambahan melibatkan partner, rujuk _share_context). ── */
  async function loadNewCabinOptions() {
    if (bookingData && bookingData.booking && bookingData.booking.price_hidden) return null;
    try {
      var res = await API_CS('get_new_cabin_options', { booking_number: BOOKING_REF });
      return (res && res.eligible && (res.categories || []).length) ? res : null;
    } catch (e) {
      console.warn('loadNewCabinOptions failed:', e);
      return null;
    }
  }

  function renderSlotList(data, shareMap) {
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

    /* Header — butang "Add Cabin & Traveller" di sebelah tajuk bila
       booking layak (dari loadNewCabinOptions). flex-wrap supaya butang
       turun baris dengan kemas di skrin kecil. */
    var newCabinBtn = '';
    if (_newCabinOptions) {
      newCabinBtn = '<button type="button" class="tv-btn tv-btn--primary tv-btn--sm" data-new-cabin style="white-space:nowrap;">＋ Add Cabin &amp; Traveller</button>';
    }
    html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:24px;">';
    html += '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:14px;">';
    html += '<h1 class="tv-section-title" style="margin-bottom:0;">Manage Travellers</h1>';
    html += newCabinBtn;
    html += '</div>';
    html += '<span class="tv-badge tv-badge--neutral">' + tripName + '<br/>' + ref + '</span>';
    html += '</div>';

    /* PDPA Notice */
    html += '<div class="tv-msg tv-msg--info on" style="margin:20px 0;">';
    html += '🛡️ All personal data is protected under PDPA. By saving traveller information, you consent to our data processing.';
    html += '</div>';

    /* Cabin / Slot List — collapsible cards, ALL COLLAPSED by default.
       Klik header cabin untuk buka/tutup senarai slot dalam cabin.
       Header memaparkan nombor giliran rooming (1..N ikut urutan paparan);
       summary rooming + butang "Add Traveller" berada dalam CONTENT panel
       (bukan header — elak elemen interaktif bersarang dalam toggle). */
    cabins.forEach(function (cabin, cIdx) {
      var cabinSlots = cabin.slots || [];
      /* Label header SENTIASA kategori bilik — JANGAN diganti dengan
         stateroom/delegate bila nilai itu wujud (maklumat berkenaan
         dipaparkan dalam summary content panel). */
      var cabinLabel = _esc(cabin.room_name || ('Cabin ' + (cIdx + 1)));
      var filledCount = cabinSlots.filter(function (s) {
        return s.filled || s.traveller_id;
      }).length;

      /* Cabin sharing — padan cabin_no + room_category (fail-safe untuk
         rekod lama yang nombor cabin paparannya di-nombor semula). */
      var share = (shareMap && shareMap[cabin.cabin_no]) || null;
      if (share && cabin.room_category && share.room_category !== cabin.room_category) share = null;

      /* Summary rooming — nilai pertama yang tersedia dalam cabin
         (stateroom boleh datang dari sibling); kosong → NA. */
      var roomId = '', delegateNo = '', stateroom = cabin.stateroom_no || cabin.cabin_assignment || '';
      cabinSlots.forEach(function (s) {
        if (!roomId && s.room_id) roomId = s.room_id;
        if (!stateroom && s.stateroom_no) stateroom = s.stateroom_no;
        if (!delegateNo && s.delegate_no) delegateNo = s.delegate_no;
      });

      html += '<div class="tv-cabin tv-animate-in">';
      html += '<button type="button" class="tv-cabin__header" data-act="toggle-cabin" aria-expanded="false">';
      html += '<span class="tv-cabin__title">🛏️ ' + _esc(cabin.cabin_no || (cIdx + 1)) + '. ' + cabinLabel + '</span>';
      html += '<span class="tv-cabin__meta">' + filledCount + '/' + cabinSlots.length + ' filled · ' + cabinSlots.length + ' guest(s)';
      html += '<span class="tv-cabin__chev">▾</span>';
      html += '</span>';
      html += '</button>';
      html += '<div class="tv-cabin__body" style="display:none;">';

      /* Summary info + butang Add Traveller */
      html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:2px 0 12px;border-bottom:1px solid #eaeaea;margin-bottom:5px;">';
      html += '<div style="font-size:12px;color:var(--text-secondary);line-height:1.8;min-width:0;">';
      html += '<div><span style="display:inline-block;min-width:96px;color:var(--text-muted);">Room ID</span>: ' + (roomId ? _esc(roomId) : 'NA') + '</div>';
      html += '<div><span style="display:inline-block;min-width:96px;color:var(--text-muted);">Stateroom No</span>: ' + (stateroom ? _esc(stateroom) : 'NA') + '</div>';
      html += '<div><span style="display:inline-block;min-width:96px;color:var(--text-muted);">Delegate No</span>: ' + (delegateNo ? _esc(delegateNo) : 'NA') + '</div>';
      html += '</div>';
      if (share) {
        html += '<button type="button" class="tv-btn tv-btn--primary tv-btn--sm" data-share-cabin="' + _esc(cabin.cabin_no) + '" style="white-space:nowrap;">＋ Add Traveller</button>';
      }
      html += '</div>';

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

    /* Guest Sequence — nombor tetamu DALAM cabin (format rooming list
       kapal: Guest 1, Guest 2, ...). NA untuk rekod lama yang kosong. */
    html += '<span style="font-size:11px;font-weight:600;text-align:center;line-height:1.2;margin:10px;color:var(--text-muted);white-space:nowrap;">Guest:<br/><span style="font-size:20px" >' + (slot.guest_sequence ? _esc(slot.guest_sequence) : 'NA') + '</span></span>';

    /* Share button (generate guest link + QR) */
    html += '<button class="tv-slot-share-btn" data-slot-share="' + slotKey + '" title="Generate share link for this traveller">🔗</button>';

    html += '</div>'; // slot-item
    return html;
  }

  function wireListActions() {
    // Cabin header → toggle collapse/expand (default: semua collapsed)
    document.querySelectorAll('[data-act="toggle-cabin"]').forEach(function (hdr) {
      hdr.addEventListener('click', function () {
        var cabin = this.closest('.tv-cabin');
        var body = cabin && cabin.querySelector('.tv-cabin__body');
        if (!body) return;
        var isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        cabin.classList.toggle('tv-cabin--open', !isOpen);
        this.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      });
    });

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

    // Add Traveller (per cabin berkekosongan) → modal pilih kategori pax.
    // stopPropagation supaya header cabin tidak terogol sekali.
    document.querySelectorAll('[data-share-cabin]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var cabinNo = parseInt(this.dataset.shareCabin, 10);
        if (!isNaN(cabinNo)) openAddTravellerModal(cabinNo);
      });
    });

    // Add Cabin & Traveller (header senarai) → modal pilih kategori bilik.
    document.querySelectorAll('[data-new-cabin]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openNewCabinModal();
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

  /* ── Cabin sharing: butang "Add Traveller" pada header cabin ──
     Mana-mana cabin yang masih ada kekosongan boleh terima traveller
     tambahan (cabin & roommate sudah ditetapkan — slot baharu mendapat
     room_id sama di server). Klik → MODAL pilih KATEGORI pax dahulu
     (Main Adult / Extra Bed / Infant) sebelum order disubmit — server
     cipta & submit SO terus, customer selesaikan bayaran di page billing.
     Cabin masih solo: kadar NET Main Adult selepas kredit lebihan
     single-supplement (kredit pada Main Adult SAHAJA); Extra Bed & Infant
     kadar penuh. Slot traveller baharu aktif selepas SO dibayar penuh;
     detail traveller diisi melalui flow sedia ada di page ini. */

  /* Data kelayakan + kadar kategori per cabin_no — diisi loadShareCabinsMap(). */
  var _shareCabinsMap = {};

  /* Data pilihan cabin baharu — diisi loadNewCabinOptions(). */
  var _newCabinOptions = null;

  function openAddTravellerModal(cabinNo) {
    var cabin = _shareCabinsMap[cabinNo];
    if (!cabin || !(cabin.categories || []).length) return;

    var old = document.getElementById('rcAddTravellerModal');
    if (old) old.remove();

    var sym = curSym(cabin);
    var rows = '';
    var firstEnabled = false;
    cabin.categories.forEach(function (cat) {
      /* Rule kapasiti selari booknow — server hantar disabled + reason
         (Extra Bed hanya bila base capacity penuh; Main Adult hanya bila
         belum penuh). Kategori disabled: radio off + row pudar + sebab. */
      var dis = !!cat.disabled;
      var checked = !dis && !firstEnabled;
      if (checked) firstEnabled = true;
      /* Kredit single-supplement (Main Adult sahaja): harga asal
         di-strikethrough + kadar net selepas kredit — deduction nampak
         berapa dimansuhkan sekali pandang. Tiada kredit → harga biasa. */
      var hasCredit = parseFloat(cat.rate) > parseFloat(cat.net_rate);
      var priceHtml = hasCredit
        ? '<s style="color:#9B968A;font-weight:500;margin-right:6px;">' + fmtDual(cat.rate, sym) + '</s>' +
          fmtDual(cat.net_rate, sym)
        : fmtDual(cat.net_rate, sym);
      rows += '<label style="display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid #D8D3C6;border-radius:10px;margin-bottom:8px;font-size:13px;' +
              (dis ? 'opacity:.55;cursor:not-allowed;' : 'cursor:pointer;') + '">';
      rows += '<input type="radio" name="rcShareCategory" value="' + _esc(cat.key) + '"' +
              (checked ? ' checked' : '') + (dis ? ' disabled' : '') + ' style="margin-top:3px;flex-shrink:0;"/>';
      rows += '<span style="flex:1;min-width:0;">';
      rows += '<span style="display:flex;justify-content:space-between;gap:8px;font-weight:600;">' + _esc(cat.label) +
              '<span style="white-space:nowrap;">' + priceHtml + '</span></span>';
      var noteTxt = (dis && cat.disabled_reason) ? cat.disabled_reason : cat.note;
      if (noteTxt) {
        rows += '<span style="display:block;font-size:11.5px;color:#6E6A5F;margin-top:3px;">' + _esc(noteTxt) + '</span>';
      }
      rows += '</span>';
      rows += '</label>';
    });

    var ov = document.createElement('div');
    ov.id = 'rcAddTravellerModal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(30,28,24,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    ov.innerHTML =
      '<div role="dialog" aria-modal="true" aria-label="Add traveller to cabin" style="background:#fff;border-radius:14px;max-width:440px;width:100%;max-height:85vh;overflow:auto;padding:22px;box-shadow:0 18px 48px rgba(30,28,24,.3);font-family:inherit;color:#1E1C18;">' +
        '<h3 style="margin:0 0 4px;font-size:17px;">➕ Add Traveller — ' +
          _esc(cabin.room_name || 'Cabin') + (cabin.cabin_no ? ' · Cabin ' + _esc(cabin.cabin_no) : '') + '</h3>' +
        '<p style="margin:0 0 14px;font-size:12.5px;color:#6E6A5F;line-height:1.5;">' +
          'Select the traveller category for this order. The order is submitted straight to a Sales Order — ' +
          'complete the payment on the billing page to confirm the slot.</p>' +
        rows +
        '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">' +
          '<button type="button" id="rcShareCancel" class="tv-btn tv-btn--ghost">Cancel</button>' +
          '<button type="button" id="rcShareConfirm" class="tv-btn tv-btn--primary">Submit Order</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);

    var closeFn = function () { ov.remove(); };
    ov.querySelector('#rcShareCancel').addEventListener('click', closeFn);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeFn(); });
    ov.querySelector('#rcShareConfirm').addEventListener('click', function () {
      var sel = ov.querySelector('input[name="rcShareCategory"]:checked');
      var category = (sel && sel.value) || 'main_adult';
      closeFn();
      submitAdditionalTravellerOrder(cabinNo, category);
    });
  }

  async function submitAdditionalTravellerOrder(cabinNo, category) {
    try {
      var res = await API_CS('create_additional_traveller_order', {
        booking_number: BOOKING_REF,
        cabin_no: cabinNo,
        category: category,
      });
      if (res && res.fully_covered) {
        alert(res.message || 'Additional traveller added.');
        // Refresh senarai — slot traveller baharu keluar dalam cabin.
        window.location.reload();
        return;
      }
      if (res && res.billing_url) {
        window.location.href = res.billing_url;
        return;
      }
      // Fallback — refresh supaya slot/order baharu nampak dalam senarai.
      window.location.reload();
    } catch (e) {
      alert(e.message || 'Failed to create the additional traveller order.');
    }
  }

  /* ── CABIN BAHARU + TETAMU (create_new_cabin_order) ──
     Butang level page (header senarai): tambah cabin BAHARU beserta
     tetamu — bukan sekadar isi kekosongan cabin sedia ada. Modal memilih
     KATEGORI BILIK + KUANTITI TETAMU (Main Guest / Extra Bed / Infant)
     dengan rule reservasi cruise yang sama dengan booknow (capFor):
       - Main Guest 1..capacity; 1 tetamu = kadar solo (single supplement
         terkandung), 2+ = kadar twin-share seorang
       - Extra Bed hanya terbuka bila base capacity penuh
       - Infant perlu >= 1 main guest; semua tetamu berkongsi
         max_capacity cabin (0 = unlimited)
       - Had peringkat trip: jumlah tetamu <= seats_left
     Harga dipaparkan ikut _price_selection server; rule & harga DISEMAK
     SEMULA di server masa submit (create_new_cabin_order). Server cipta
     & submit SO BAHARU dan pautkan ke booking (custom_booking); customer
     selesaikan bayaran di page billing. Slot traveller cabin baharu
     aktif selepas SO dibayar penuh; detail traveller diisi melalui flow
     sedia ada di page ini. */

  /* Label kapasiti — cermin booknow: "2 Pax" bila capacity ==
     max_capacity, "2-4 Pax" bila berbeza; capacity sahaja bila
     max_capacity <= 0 (unlimited). */
  function _cabinCapLabel(cat) {
    if (!cat.max_capacity || Number(cat.max_capacity) <= 0) return cat.capacity + ' Pax';
    return Number(cat.capacity) === Number(cat.max_capacity)
      ? cat.capacity + ' Pax'
      : cat.capacity + '-' + cat.max_capacity + ' Pax';
  }

  /* Had kuantiti tetamu — cermin capFor() booknow (model cruise),
     ditutup lagi dengan had peringkat trip (seats_left). Return nilai
     MAX ALLOWED bagi setiap kiraer. */
  function _newCabinCaps(cat, sel) {
    var unlimited = Number(cat.max_capacity) === 0;
    var maxCap = unlimited ? Infinity : (Number(cat.max_capacity) || Number(cat.capacity) || 0);
    var mainCap = Number(cat.capacity) > 0 ? Number(cat.capacity) : Infinity;
    var caps = {
      main_guests: Math.min(mainCap, maxCap - sel.extra_beds - sel.infants),
      extra_beds: 0,
      infants: 0
    };
    if (Number(cat.capacity) > 0) {
      caps.extra_beds = (sel.main_guests === Number(cat.capacity))
        ? Math.max(0, maxCap - sel.main_guests - sel.infants) : 0;
    } else {
      caps.extra_beds = sel.main_guests >= 1
        ? Math.max(0, maxCap - sel.main_guests - sel.infants) : 0;
    }
    caps.infants = sel.main_guests >= 1
      ? Math.max(0, maxCap - sel.main_guests - sel.extra_beds) : 0;
    var gs = _newCabinOptions ? Number(_newCabinOptions.seats_left) : 0;
    if (gs && gs < 100000) {  // 999999 = unlimited (marker server)
      var total = sel.main_guests + sel.extra_beds + sel.infants;
      ['main_guests', 'extra_beds', 'infants'].forEach(function (k) {
        caps[k] = Math.min(caps[k], Math.max(0, gs - (total - sel[k])));
      });
    }
    return caps;
  }

  /* Jumlah harga — cermin _price_selection() server (cruise):
     1 main guest = kadar solo; >= 2 = kadar adult x setiap org; extra
     bed & infant pada kadar penuh masing-masing. */
  function _newCabinTotal(cat, sel) {
    var total = 0;
    if (sel.main_guests === 1) total += Number(cat.solo_rate || 0);
    else if (sel.main_guests >= 2) total += Number(cat.adult_rate || 0) * sel.main_guests;
    total += Number(cat.upperberth_rate || 0) * sel.extra_beds;
    total += Number(cat.infant_rate || 0) * sel.infants;
    return total;
  }

  /* Keadaan selection modal semasa (null bila modal tertutup). */
  var _newCabinSel = null;

  function openNewCabinModal() {
    var opts = _newCabinOptions;
    if (!opts || !(opts.categories || []).length) return;

    var old = document.getElementById('rcNewCabinModal');
    if (old) old.remove();

    var first = opts.categories[0];
    _newCabinSel = { room_category: first.room_category, main_guests: 1, extra_beds: 0, infants: 0 };

    var ov = document.createElement('div');
    ov.id = 'rcNewCabinModal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(30,28,24,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    ov.innerHTML =
      '<div role="dialog" aria-modal="true" aria-label="Add new cabin and travellers" style="background:#fff;border-radius:14px;max-width:460px;width:100%;max-height:88vh;overflow:auto;padding:22px;box-shadow:0 18px 48px rgba(30,28,24,.3);font-family:inherit;color:#1E1C18;">' +
        '<div id="rcNewCabinBody"></div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">' +
          '<button type="button" id="rcNewCabinCancel" class="tv-btn tv-btn--ghost">Cancel</button>' +
          '<button type="button" id="rcNewCabinConfirm" class="tv-btn tv-btn--primary">Submit Order</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(ov);

    var closeFn = function () { ov.remove(); _newCabinSel = null; };
    ov.querySelector('#rcNewCabinCancel').addEventListener('click', closeFn);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeFn(); });

    // Tukar kategori bilik — reset kuantiti ke lalai (1 main guest).
    ov.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'rcNewCabinCategory') {
        _newCabinSel.room_category = e.target.value;
        _newCabinSel.main_guests = 1;
        _newCabinSel.extra_beds = 0;
        _newCabinSel.infants = 0;
        _renderNewCabinBody();
      }
    });

    // Stepper +/- kuantiti tetamu (delegation — body dirender semula).
    ov.addEventListener('click', function (e) {
      var t = e.target.closest('[data-step]');
      if (!t || t.disabled) return;
      _onNewCabinStep(t.dataset.step, parseInt(t.dataset.dir, 10));
    });

    ov.querySelector('#rcNewCabinConfirm').addEventListener('click', function () {
      if (!_newCabinSel) return;
      var sel = Object.assign({}, _newCabinSel);
      closeFn();
      submitNewCabinOrder(sel);
    });

    _renderNewCabinBody();
  }

  function _renderNewCabinBody() {
    var opts = _newCabinOptions, sel = _newCabinSel;
    var body = document.getElementById('rcNewCabinBody');
    if (!body || !opts || !sel) return;

    var cat = opts.categories.find(function (c) {
      return c.room_category === sel.room_category;
    }) || opts.categories[0];
    var sym = curSym(opts);
    var caps = _newCabinCaps(cat, sel);

    /* Kategori bilik (radio) — kapasiti + kadar solo setiap satu. */
    var rows = '';
    opts.categories.forEach(function (c) {
      var checked = c.room_category === sel.room_category;
      rows += '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #D8D3C6;border-radius:10px;margin-bottom:8px;font-size:13px;cursor:pointer;">';
      rows += '<input type="radio" name="rcNewCabinCategory" value="' + _esc(c.room_category) + '"' +
              (checked ? ' checked' : '') + ' style="margin-top:3px;flex-shrink:0;"/>';
      rows += '<span style="flex:1;min-width:0;">';
      rows += '<span style="display:flex;justify-content:space-between;gap:8px;font-weight:600;">' + _esc(c.room_name) +
              '<span style="white-space:nowrap;font-weight:500;color:#6E6A5F;">' + _esc(_cabinCapLabel(c)) + ' · ' + fmtDual(c.solo_rate, sym) + '</span></span>';
      rows += '<span style="display:block;font-size:11.5px;color:#6E6A5F;margin-top:3px;">Solo fare — single supplement included</span>';
      rows += '</span>';
      rows += '</label>';
    });

    /* Baris stepper kuantiti — butang +/- dihadkan oleh caps (mirip
       capFor booknow: butang + disabled, BUKAN clamp senyap). */
    function stepperRow(key, label, noteHtml, min) {
      function btn(dir, dis) {
        return '<button type="button" data-step="' + key + '" data-dir="' + dir + '"' + (dis ? ' disabled' : '') +
               ' style="width:30px;height:30px;border-radius:8px;border:1px solid #D8D3C6;background:' + (dis ? '#F5F3EE' : '#fff') +
               ';font-size:16px;font-weight:700;color:' + (dis ? '#B9B4A8' : '#1E1C18') +
               ';cursor:' + (dis ? 'not-allowed' : 'pointer') + ';line-height:1;flex-shrink:0;">' + (dir < 0 ? '\u2212' : '+') + '</button>';
      }
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #D8D3C6;border-radius:10px;margin-bottom:8px;font-size:13px;">' +
        '<span style="flex:1;min-width:0;"><strong>' + _esc(label) + '</strong>' +
        '<span style="display:block;font-size:11.5px;color:#6E6A5F;margin-top:2px;">' + noteHtml + '</span></span>' +
        btn(-1, sel[key] <= min) +
        '<span style="min-width:24px;text-align:center;font-weight:700;">' + sel[key] + '</span>' +
        btn(1, sel[key] >= caps[key]) +
        '</div>';
    }

    var mgNote = (sel.main_guests === 1)
      ? fmtDual(cat.solo_rate, sym) + '/pax \u00b7 solo (single supplement included)'
      : fmtDual(cat.adult_rate, sym) + '/pax \u00b7 twin-share';
    var ebNote = (Number(cat.capacity) > 0)
      ? fmtDual(cat.upperberth_rate, sym) + '/pax \u00b7 unlocked once the base capacity (' + _esc(cat.capacity) + ' pax) is filled'
      : fmtDual(cat.upperberth_rate, sym) + '/pax';
    var infNote = fmtDual(cat.infant_rate, sym) + '/pax \u00b7 requires at least 1 main guest';

    var maxCapTxt = (Number(cat.max_capacity) === 0)
      ? 'no limit'
      : (Number(cat.max_capacity) || cat.capacity) + ' pax';
    var gs = Number(opts.seats_left || 0);
    var seatsTxt = (gs && gs < 100000) ? gs + ' seat(s) left for this trip date' : 'seats available';

    /* Kotak peraturan reservasi cruise — ringkasan rule yang di-enforce
       semula di server (_validate_selection_capacity + seats + max
       cabins), supaya customer nampak SYARAT sebelum submit. */
    var rules =
      '<div style="background:#FAF8F3;border:1px solid #E5E1D8;border-radius:10px;padding:12px 14px;margin-top:6px;font-size:11.5px;color:#4C4739;line-height:1.7;">' +
        '<div style="font-weight:700;font-size:12px;color:#633806;margin-bottom:4px;">\uD83D\uDDF3\uFE0F Cruise reservation rules</div>' +
        '<ul style="margin:0;padding-left:16px;">' +
          '<li>Main guests: up to ' + (Number(cat.capacity) > 0 ? _esc(cat.capacity) : '\u2014') + ' per cabin (base capacity). 1 guest pays the solo fare; 2+ guests pay the twin-share rate per person.</li>' +
          '<li>Extra Bed is available only once the base capacity is filled. Infants require at least 1 main guest.</li>' +
          '<li>All guests share the cabin maximum capacity (' + _esc(maxCapTxt) + ').</li>' +
          '<li>Maximum ' + _esc(opts.max_cabins) + ' cabins per booking \u00b7 ' + _esc(seatsTxt) + '.</li>' +
          '<li>Traveller slots are confirmed after full payment \u2014 traveller details are filled afterwards on this page.</li>' +
        '</ul>' +
      '</div>';

    body.innerHTML =
      '<h3 style="margin:0 0 4px;font-size:17px;">\uD83D\uDECF\uFE0F Add New Cabin &amp; Traveller</h3>' +
      '<p style="margin:0 0 14px;font-size:12.5px;color:#6E6A5F;line-height:1.5;">' +
        'A new cabin (Cabin ' + _esc(opts.next_cabin_no) + ') will be added to this booking. ' +
        'Choose the room category and the number of guests \u2014 the order is submitted straight to a Sales Order; ' +
        'complete the payment on the billing page to confirm it.</p>' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#6E6A5F;margin-bottom:6px;">ROOM CATEGORY</div>' +
      rows +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#6E6A5F;margin:12px 0 6px;">GUESTS IN THE NEW CABIN</div>' +
      stepperRow('main_guests', 'Main Guest', mgNote, 1) +
      stepperRow('extra_beds', 'Extra Bed', ebNote, 0) +
      stepperRow('infants', 'Infant', infNote, 0) +
      rules +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:14px;">' +
        '<span style="color:#6E6A5F;">Total</span>' +
        '<strong>' + fmtDual(_newCabinTotal(cat, sel), sym) + '</strong>' +
      '</div>';
  }

  function _onNewCabinStep(key, dir) {
    var opts = _newCabinOptions, sel = _newCabinSel;
    if (!opts || !sel) return;
    var cat = opts.categories.find(function (c) {
      return c.room_category === sel.room_category;
    }) || opts.categories[0];
    var caps = _newCabinCaps(cat, sel);
    var min = (key === 'main_guests') ? 1 : 0;
    var next = sel[key] + dir;
    if (next < min || next > caps[key]) return;
    sel[key] = next;
    _renderNewCabinBody();
  }

  async function submitNewCabinOrder(sel) {
    try {
      var res = await API_CS('create_new_cabin_order', {
        booking_number: BOOKING_REF,
        room_category: sel.room_category,
        main_guests: sel.main_guests,
        extra_beds: sel.extra_beds,
        infants: sel.infants,
      });
      if (res && res.fully_covered) {
        alert(res.message || 'New cabin added.');
        // Refresh senarai — cabin + slot traveller baharu keluar terus.
        window.location.reload();
        return;
      }
      if (res && res.billing_url) {
        window.location.href = res.billing_url;
        return;
      }
      // Fallback — refresh supaya cabin/order baharu nampak dalam senarai.
      window.location.reload();
    } catch (e) {
      alert(e.message || 'Failed to create the new cabin order.');
    }
  }

  /* ══════════════════════════════════════════════════════════
     MOD 2: INDIVIDU SLOT (form tabs + upload passport auto-scan)
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

      // Step 1 wizard passport check DIMANSUHKAN — terus buka borang.
      // Upload passport berada di atas panel Passport dengan auto-scan
      // selepas gambar dipilih (scanPassportIntoForm).
      _loadTravellerForm(slot);
    } catch (e) {
      showDetailError(e.message || 'Failed to load traveller details.');
    }
  }

  function showDetailView(viewId) {
    ['V-form'].forEach(function (v) {
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

  /* ── Phone widgets (intl-tel-input — format antarabangsa, port dari
     portal_traveller_page.js / guest_passport). Lib dimuatkan di page
     (intlTelInputWithUtils.min.js — utils bundled, tiada utilsScript). ── */
  var _itiPhone   = null;
  var _itiEcPhone = null;

  function _initPhoneWidgets() {
    if (typeof window.intlTelInput === 'undefined') return;
    var opts = { initialCountry: 'my', separateDialCode: true, utilsScript: undefined };
    var phoneEl = document.getElementById('tvl-phone-num');
    if (phoneEl && !_itiPhone) _itiPhone = window.intlTelInput(phoneEl, opts);
    var ecPhoneEl = document.getElementById('tvl-ec-phone');
    if (ecPhoneEl && !_itiEcPhone) _itiEcPhone = window.intlTelInput(ecPhoneEl, opts);
  }

  /* Nombor penuh E.164 (+60123456789) untuk save — fallback nilai input
     bila widget gagal load. */
  function _getFullPhoneNumber(iti, fallbackEl) {
    if (!iti) return ((fallbackEl && fallbackEl.value) || '').trim();
    var full = iti.getNumber().trim();
    if (full) return full;
    return ((fallbackEl && fallbackEl.value) || '').trim();
  }

  /* Isi semula widget dari nilai tersimpan (format server "+60-123456789"
     di-parse oleh libphonenumber tanpa masalah). */
  function _setPhoneValue(iti, elId, rawValue) {
    var el = document.getElementById(elId);
    if (!rawValue) { if (iti) iti.setNumber(''); else if (el) el.value = ''; return; }
    if (iti) iti.setNumber(rawValue); else if (el) el.value = rawValue;
  }

  /* Validasi guna isValidNumber() widget (utils bundled). Fallback longgar
     (≥7 digit) bila widget gagal load — server tetap validate format. */
  function _isPhoneValid(iti, num) {
    if (iti) {
      try { return iti.isValidNumber(); } catch (e) { /* fall through */ }
    }
    return (num || '').replace(/\D/g, '').length >= 7;
  }

  /* ── Badge enjin scan (AI vs OCR) — dipaparkan di kawasan upload borang ── */  function renderEngineBadge() {
    var badge = document.getElementById('passport-engine-badge');
    if (!badge) return;
    if (AI_SCAN_ENABLED) {
      badge.textContent = '🤖 AI-powered scanning';
      badge.style.color = '#0F6E56';
      badge.style.background = '#E8F4EF';
    } else {
      badge.textContent = 'OCR (Image + MRZ) scanning';
      badge.style.color = '#633806';
      badge.style.background = '#FAEEDA';
    }
    badge.style.display = 'inline-block';
    badge.style.padding = '4px 12px';
    badge.style.borderRadius = '12px';
  }

/* ── Blocking scan progress modal — menghalang user daripada mengganggu
   proses AI/OCR scan passport. Tiada butang tutup; overlay click tidak
   melakukan apa-apa. Ditutup hanya oleh _hidePassportScanProgress(). ── */
function _showPassportScanProgress(engineLabel) {
  _hidePassportScanProgress();
  var overlay = document.createElement('div');
  overlay.id = 'rc-passport-scan-progress';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(30,28,24,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;';
  overlay.innerHTML =
    '<div style="background:#fff;border-radius:14px;padding:36px 28px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(30,28,24,.35);text-align:center;font-family:inherit;">' +
      '<div style="font-size:42px;margin-bottom:14px;animation:rcPassSpin 1s linear infinite;display:inline-block;">⏳</div>' +
      '<div style="font-size:15px;font-weight:700;color:#1E1C18;margin-bottom:6px;">' + _esc(engineLabel || 'Scanning passport with AI...') + '</div>' +
      '<div style="font-size:12.5px;color:#6E6A5F;line-height:1.5;">Please wait while we read your passport. Do not close or refresh this page.</div>' +
    '</div>' +
    '<style>@keyframes rcPassSpin { to { transform: rotate(360deg); } }</style>';
  document.body.appendChild(overlay);
}

function _hidePassportScanProgress() {
  var el = document.getElementById('rc-passport-scan-progress');
  if (el) el.remove();
}

  /* ── FORM: Load & Display ── */

  async function _loadTravellerForm(slot) {
    await _loadCountries();
    // Widget telefon antarabangsa — init SEBELUM nilai diisi supaya
    // setNumber() mengesan dial code dengan betul.
    _initPhoneWidgets();
    _sectionsSaved = { passport: false, contact: false, health: false };

    var isVerified      = slot && (slot.is_verified || slot.document_status === 'Verified');
    var isOpenForUpdate = slot && slot.document_status === 'Open for Update';
    var canEdit         = !isVerified || isOpenForUpdate;

    // Fill form fields
    _setVal('tvl-ic', slot?.ic_number || '');
    _setVal('tvl-firstname', slot?.first_name || '');
    _setVal('tvl-lastname', slot?.last_name || '');
    _setVal('tvl-fullname-format', slot?.fullname_format || 'First Name + Last Name');
    _setVal('tvl-name', slot?.full_name || '');
    _syncFullName();
    _setVal('tvl-dob', slot?.date_of_birth || '');
    _setVal('tvl-nat', slot?.nationality || '');
    _setVal('tvl-gender', slot?.gender || '');
    _setPhoneValue(_itiPhone, 'tvl-phone-num', slot?.phone);
    _setPhoneValue(_itiEcPhone, 'tvl-ec-phone', slot?.emergency_contact_phone);
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

    // Reset errors + consent (checkbox consent wujud di SETIAP panel)
    _clearAllFieldErrors();
    document.querySelectorAll('.tvl-pdpa-consent').forEach(function (cb) { cb.checked = false; });
    var formErr = document.getElementById('tvl-form-error');
    if (formErr) formErr.style.display = 'none';

    // Reset passport upload — toggle between "uploaded" and "empty" states
    _passportFile = null;
    var ppUploaded = document.getElementById('passport-uploaded');      // State A: has image
    var ppGrid = document.getElementById('passport-upload-grid');       // State B: contoh + upload grid
    var ppArea = document.getElementById('passport-upload-area');       // kotak dashed dalam grid
    if (slot?.has_passport) {
      // Show uploaded state with preview
      if (ppUploaded) ppUploaded.style.display = '';
      if (ppGrid) ppGrid.style.display = 'none';
    } else {
      // Show empty upload area (grid: contoh kiri + upload kanan)
      if (ppUploaded) ppUploaded.style.display = 'none';
      if (ppGrid) ppGrid.style.display = '';
      if (ppArea) ppArea.style.borderColor = '';
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
    // Bar navigasi bawah (Back/Save/Next) + row consent hanya relevan
    // bila borang boleh diedit (slot Verified & bukan Open for Update
    // = baca sahaja).
    document.querySelectorAll('#V-form .tvl-panel-nav, #V-form .tvl-consent-row')
      .forEach(function (el) { el.style.display = canEdit ? '' : 'none'; });
    // Confirm mula DISABLED — aktif selepas semua section disimpan.
    _updateConfirmState();

    // Badge enjin scan (AI vs OCR) di kawasan upload passport.
    renderEngineBadge();

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
    // capture=environment (peranti sentuh) — buka kamera belakang terus
    // untuk snap dokumen; di desktop atribut ini diabaikan browser.
    if (opts && opts.capture) input.setAttribute('capture', 'environment');
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

  function triggerPassportUpload(useCamera, ev) {
    // Butang kamera berada DALAM kawasan dashed yang juga klikabel —
    // hentikan propagation supaya dialog fail tak terbuka dua kali.
    if (ev && ev.stopPropagation) ev.stopPropagation();
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

      // AUTO-SCAN pada SETIAP tukar/ganti dokumen — maklumat passport
      // terbaharu dibaca (AI didahulukan, fallback OCR) dan medan borang
      // dikemas kini supaya selari dengan dokumen baharu.
      scanPassportIntoForm(file);
    }, 'passport-upload-err', { capture: !!useCamera });
  }

  /* Imbas dokumen (upload/ganti) → kemas kini medan borang Passport.
     Guna endpoint yang sama dengan wizard (check_traveller_passport).

     Medan KOSONG diisi terus senyap. Medan yang SEDIA ADA NILAI dan
     berbeza dengan imbasan → modal popup "data mismatch" meminta
     keputusan user: replace dengan nilai dokumen baharu atau kekalkan. */
  async function scanPassportIntoForm(file) {
    var box = document.getElementById('passport-scan-result');
    if (!box) return;
    box.style.display = 'block';
    box.style.background = 'var(--bg-secondary)';
    box.style.border = '1px solid var(--border-default)';
    box.style.color = 'var(--text-secondary)';
    box.innerHTML = '⏳ Scanning passport' + (AI_SCAN_ENABLED ? ' with AI' : '') + '...';
    _showPassportScanProgress('Scanning passport' + (AI_SCAN_ENABLED ? ' with AI' : '') + '...');

    try {
      var filedata = await _readFileAsDataURL(file);
      var res = await API_TV('check_traveller_passport', { filedata: filedata });

      // Extraction dokumen baharu mengatasi data rekod (kalau jumpa padanan).
      var merged = Object.assign({}, res.data || {}, res.extracted || {});
      if (merged.full_name && !merged.first_name && !merged.last_name) {
        var parts = String(merged.full_name).trim().split(/\s+/);
        if (parts.length >= 2) {
          merged.first_name = parts[0];
          merged.last_name = parts.slice(1).join(' ');
        } else if (parts.length === 1) {
          merged.first_name = parts[0];
        }
      }

      _hidePassportScanProgress();
      var engineTag = (res.engine === 'ai') ? '🤖 Scanned with AI'
        : (res.engine === 'ai+ocr') ? '🤖 Scanned with AI + OCR (Image + MRZ)'
        : 'Scanned with OCR (Image + MRZ)';

      // Banding nilai imbasan dengan nilai semasa borang.
      function _norm(v) { return String(v || '').trim().toUpperCase(); }
      var FIELD_MAP = [
        ['tvl-firstname', merged.first_name, 'First name'],
        ['tvl-lastname',  merged.last_name,  'Last name'],
        ['tvl-ic',        merged.ic_number,  'IC / National ID'],
        ['tvl-dob',       merged.date_of_birth, 'Date of birth'],
        ['tvl-gender',    merged.gender,     'Gender'],
        ['tvl-nat',       merged.nationality, 'Nationality'],
        ['tvl-pp',        merged.passport_no, 'Passport no'],
        ['tvl-ppexp',     merged.passport_expiry, 'Passport expiry'],
      ];
      var filled = [];
      var mismatches = [];
      FIELD_MAP.forEach(function (f) {
        var el = document.getElementById(f[0]);
        if (!el || !f[1]) return;
        var current = (el.value || '').trim();
        var next = String(f[1]).trim();
        if (!current) {
          el.value = next;                 // kosong → isi terus
          filled.push(f[2]);
        } else if (_norm(current) !== _norm(next)) {
          mismatches.push({ el: f[0], label: f[2], current: current, next: next });
        }
      });
      // Full Name (read-only) tak terjejas oleh event input pengisian
      // senyap di atas — kira semula ikut First/Last + Full Name Format.
      if (filled.length) _syncFullName();

      function _box(bg, border, color, html) {
        box.style.background = bg;
        box.style.border = '1px solid ' + border;
        box.style.color = color;
        box.innerHTML = html;
      }

      if (mismatches.length) {
        // Data dokumen BAHARU berbeza dengan data sedia ada → modal
        // minta keputusan user sebelum sebarang nilai diganti.
        showPassportMismatchModal(mismatches, engineTag, function (replace) {
          if (replace) {
            mismatches.forEach(function (m) {
              var el = document.getElementById(m.el);
              if (el) el.value = m.next;
            });
            _syncFullName();
            _box('#EBF7F1', '#0F6E56', '#0F6E56',
              '<strong>' + engineTag + '</strong> — replaced with new passport data: ' +
              mismatches.map(function (m) { return _esc(m.label); }).join(', ') +
              (filled.length ? '. Auto-filled: ' + filled.map(_esc).join(', ') : '') +
              '. Please review before saving.');
          } else {
            _box('#FAEEDA', '#B0862A', '#633806',
              '<strong>' + engineTag + '</strong> — you kept the existing details' +
              (filled.length ? '. Auto-filled: ' + filled.map(_esc).join(', ') : '') +
              '. The uploaded image will still be saved with the form.');
          }
        });
        return;
      }

      if (filled.length) {
        _box('#EBF7F1', '#0F6E56', '#0F6E56',
          '<strong>' + engineTag + '</strong> — updated from passport: ' +
          filled.map(_esc).join(', ') + '. Please review before saving.');
      } else {
        _box('#EBF7F1', '#0F6E56', '#0F6E56',
          '<strong>' + engineTag + '</strong> — scanned details match the form. No changes needed.');
      }
    } catch (e) {
      _hidePassportScanProgress();
      box.style.background = '#FCEBEB';
      box.style.border = '1px solid #991B1B';
      box.style.color = '#501313';
      box.innerHTML = 'Scan failed — details were not changed. You can fill in the form manually.';
    }
  }

  /* Modal popup "data mismatch" — dokumen baharu berbeza dengan data
     sedia ada dalam borang. User pilih: replace dengan nilai dokumen
     baharu, atau kekalkan nilai semasa. onChoose(replaceBool). */
  function showPassportMismatchModal(mismatches, engineTag, onChoose) {
    var old = document.getElementById('rcMismatchModal');
    if (old) old.remove();

    var ov = document.createElement('div');
    ov.id = 'rcMismatchModal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(30,28,24,.55);display:flex;align-items:center;justify-content:center;padding:20px;';

    var boxEl = document.createElement('div');
    boxEl.style.cssText = 'background:#FFFFFF;border-radius:14px;max-width:520px;width:100%;max-height:85vh;overflow:auto;padding:22px;box-shadow:0 18px 48px rgba(30,28,24,.3);font-family:var(--font-body,Archivo,system-ui,sans-serif);color:#1E1C18;';

    var title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 4px;font-size:17px;color:#991B1B;';
    title.textContent = '⚠️ Passport data mismatch';
    var sub = document.createElement('p');
    sub.style.cssText = 'margin:0 0 14px;font-size:12.5px;color:#6E6A5F;line-height:1.5;';
    sub.textContent = 'The uploaded passport (' + engineTag + ') shows different details from what is currently in the form:';
    boxEl.appendChild(title);
    boxEl.appendChild(sub);

    var list = document.createElement('div');
    mismatches.forEach(function (m) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:10px 12px;border:1px solid #D8D3C6;border-radius:10px;margin-bottom:8px;font-size:13px;';
      row.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px;">' + _esc(m.label) + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="color:#6E6A5F;text-decoration:line-through;">' + _esc(m.current) + '</span>' +
          '<span style="color:#B0862A;">→</span>' +
          '<span style="font-weight:700;color:#0F6E56;">' + _esc(m.next) + '</span>' +
        '</div>';
      list.appendChild(row);
    });
    boxEl.appendChild(list);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:6px;';
    var keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'Keep current';
    keep.style.cssText = 'border:1px solid #D8D3C6;background:none;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;font-family:inherit;color:#1E1C18;';
    keep.addEventListener('click', function () { ov.remove(); onChoose(false); });
    var rep = document.createElement('button');
    rep.type = 'button';
    rep.textContent = 'Replace with new';
    rep.style.cssText = 'border:none;background:#C9A84C;color:#1E1C18;font-weight:700;border-radius:8px;padding:9px 18px;font-size:13px;cursor:pointer;font-family:inherit;';
    rep.addEventListener('click', function () { ov.remove(); onChoose(true); });
    btnRow.appendChild(keep);
    btnRow.appendChild(rep);
    boxEl.appendChild(btnRow);

    ov.appendChild(boxEl);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) { ov.remove(); onChoose(false); } });
    document.body.appendChild(ov);
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

  /* ── Wizard Save (semua section sekali klik) ── */

  var _SECTION_LABELS = { passport: 'Passport', contact: 'Contact Info', health: 'Health' };

  /* Butang confirm DISABLED sehingga ketiga-tiga section disimpan
     (ATAU slot sudah terisi dari sesi sebelumnya — corak guest_passport).
     Hint di bawah butang nyatakan section yang belum siap. */
  function _updateConfirmState() {
    var btn = document.getElementById('tvl-confirm-btn');
    if (!btn) return;
    var allSaved = _sectionsSaved.passport && _sectionsSaved.contact && _sectionsSaved.health;
    var canConfirm = allSaved || !!(ACTIVE_SLOT && ACTIVE_SLOT.filled);
    btn.disabled = !canConfirm;
    var hint = document.getElementById('tvl-confirm-hint');
    if (hint) {
      if (canConfirm) {
        hint.textContent = '\u2713 All sections complete \u2014 press confirm to submit for review.';
        hint.style.color = '#0F6E56';
      } else {
        var pending = ['passport', 'contact', 'health']
          .filter(function (s) { return !_sectionsSaved[s]; })
          .map(function (s) { return _SECTION_LABELS[s]; });
        hint.textContent = 'Please complete and save: ' + pending.join(', ') + '.';
        hint.style.color = '#92400E';
      }
    }
  }

  /* Validasi medan wajib sesuatu section (tanpa panggilan API).
     Return true jika lulus; gagal → tandakan medan + lompat ke tab. */
  function _validateSection(section) {
    var get = function (id) { return document.getElementById(id); };

    var firstName = get('tvl-firstname').value.trim();
    var lastName  = get('tvl-lastname').value.trim();
    var phoneNum  = _getFullPhoneNumber(_itiPhone, get('tvl-phone-num'));
    var ecPhone   = _getFullPhoneNumber(_itiEcPhone, get('tvl-ec-phone'));
    var ecName    = get('tvl-ec-name').value.trim();
    var ecRel     = get('tvl-ec-relationship').value.trim();
    var ic        = get('tvl-ic').value.trim();

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
      // _validateSection() semak nilai pulangan ini — FALSE = gagal.
      return false;
    };

    if (section === 'passport') {
      if (!firstName) return fail(get('tvl-firstname'), 'First name is required.', 'passport');
      if (!lastName)  return fail(get('tvl-lastname'), 'Last name is required.', 'passport');
      if (!ic)        return fail(get('tvl-ic'), 'IC Number is required.', 'passport');
    }
    if (section === 'contact') {
      var emailVal = get('tvl-email').value.trim();
      if (!phoneNum) return fail(get('tvl-phone-num'), 'Phone number is required.', 'contact');
      if (!_isPhoneValid(_itiPhone, phoneNum))
        return fail(get('tvl-phone-num'), 'This does not look like a valid phone number. Please check the country code.', 'contact');
      if (!emailVal) return fail(get('tvl-email'), 'Email is required.', 'contact');
      if ((ecName || ecPhone || ecRel) && (!ecName || !ecPhone || !ecRel)) {
        if (!ecName) return fail(get('tvl-ec-name'), 'Please complete emergency contact.', 'contact');
        if (!ecPhone) return fail(get('tvl-ec-phone'), 'Please complete emergency contact.', 'contact');
        return fail(get('tvl-ec-relationship'), 'Please complete emergency contact.', 'contact');
      }
      if (ecPhone && !_isPhoneValid(_itiEcPhone, ecPhone))
        return fail(get('tvl-ec-phone'), 'This does not look like a valid phone number. Please check the country code.', 'contact');
    }
    return true;
  }

  /* Simpan SATU section ke server (andaian: validasi lulus).
     Server wajib section passport dahulu — cipta Traveller + link ke
     slot sebelum contact/health boleh disimpan. */
  async function _saveSection(section) {
    var get = function (id) { return document.getElementById(id); };
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
        first_name: get('tvl-firstname').value.trim(),
        last_name: get('tvl-lastname').value.trim(),
        full_name: get('tvl-name').value.trim(),
        fullname_format: (get('tvl-fullname-format') && get('tvl-fullname-format').value) || 'First Name + Last Name',
        gender: get('tvl-gender').value,
        ic_number: get('tvl-ic').value.trim(),
        date_of_birth: get('tvl-dob').value,
        nationality: get('tvl-nat').value,
        passport_no: get('tvl-pp').value.trim(),
        passport_expiry: get('tvl-ppexp').value,
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
        phone: _getFullPhoneNumber(_itiPhone, get('tvl-phone-num')),
        emergency_contact_name: get('tvl-ec-name').value.trim(),
        emergency_contact_phone: _getFullPhoneNumber(_itiEcPhone, get('tvl-ec-phone')),
        emergency_contact_relationship: get('tvl-ec-relationship').value.trim(),
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
  }

  /* Reset kawasan upload/preview selepas section passport disimpan. */
  function _afterPassportSaved() {
    _passportFile = null;

    // Reset replace area (jika dalam mod ganti)
    var replaceArea = document.getElementById('passport-replace-area');
    if (replaceArea) {
      replaceArea.innerHTML = '<span>\ud83d\udcf7</span> Replace passport image';
      replaceArea.style.background = '';
      replaceArea.style.borderColor = '';
    }

    // Reset upload area text (mod upload baharu)
    var pptxt = document.getElementById('passport-upload-txt');
    if (pptxt) pptxt.textContent = 'Upload passport copy';
    var ppArea = document.getElementById('passport-upload-area');
    if (ppArea) ppArea.style.borderColor = '';

    // Reload preview to show updated state
    _loadPassportPreview(ACTIVE_SLOT);
  }

  /* Reset kawasan upload visa selepas section contact disimpan. */
  function _afterContactSaved() {
    _visaPhotoFile = null;
    var vtxt = document.getElementById('visa-photo-upload-txt');
    if (vtxt) vtxt.textContent = 'Upload photo';
    var ve = document.getElementById('visa-photo-existing');
    if (ve) ve.style.display = (ACTIVE_SLOT && ACTIVE_SLOT.has_visa_photo) ? '' : 'none';
  }

  /* ── Save per-section (corak guest_passport) ──
     Setiap bar navigasi bawah panel menyimpan section berkenaan sahaja
     (Passport → Contact → Health). Bar confirm akhir aktif selepas
     ketiga-tiga section disimpan (atau slot sudah terisi). */

  /* PDPA consent — modal popup bila Save ditekan tanpa tick (corak sama
     dengan portal_traveller_page.js). "Accept & Continue" tick semua
     checkbox consent & tutup modal. */
  function _showConsentModal() {
    _hideConsentModal();
    var overlay = document.createElement('div');
    overlay.id = 'rc-consent-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(30,28,24,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;';
    overlay.innerHTML =
      '<div role="dialog" aria-modal="true" aria-label="Privacy consent required" style="background:#fff;border-radius:14px;padding:28px 24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(30,28,24,.35);font-family:inherit;">' +
        '<div style="font-size:34px;margin-bottom:10px;text-align:center;">\uD83D\uDD12</div>' +
        '<div style="font-size:15px;font-weight:700;color:#1E1C18;margin-bottom:8px;text-align:center;">Privacy consent required</div>' +
        '<p style="font-size:12.5px;color:#6E6A5F;line-height:1.6;margin-bottom:18px;">Please accept the Privacy Notice before saving \u2014 we need your consent to store traveller and passport details for trip arrangements.</p>' +
        '<div style="display:flex;gap:10px;">' +
          '<button type="button" class="tv-btn tv-btn--ghost" style="flex:1;" data-consent-cancel>Cancel</button>' +
          '<button type="button" class="tv-btn tv-btn--primary" style="flex:1;" data-consent-accept>\u2713 Accept &amp; Continue</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector('[data-consent-cancel]').addEventListener('click', _hideConsentModal);
    overlay.querySelector('[data-consent-accept]').addEventListener('click', _acceptConsentFromModal);
    document.body.appendChild(overlay);
  }

  function _hideConsentModal() {
    var el = document.getElementById('rc-consent-modal');
    if (el) el.remove();
  }

  function _acceptConsentFromModal() {
    document.querySelectorAll('.tvl-pdpa-consent').forEach(function (cb) { cb.checked = true; });
    _hideConsentModal();
  }

  window.tvlConsentToggled = function (el) {
    document.querySelectorAll('.tvl-pdpa-consent').forEach(function (cb) { cb.checked = el.checked; });
  };

  /* Simpan SATU section. section = 'passport' | 'contact' | 'health'. */
  window.saveTraveller = async function (section, btnEl) {
    var get = function (id) { return document.getElementById(id); };
    if (!ACTIVE_SLOT || TVL_TAB_ORDER.indexOf(section) === -1) return;

    var formErr = get('tvl-form-error');
    if (formErr) formErr.style.display = 'none';
    _clearAllFieldErrors();

    // Validasi inline section ini sahaja — gagal → lompat ke medan pertama.
    if (!_validateSection(section)) return;

    // PDPA — tiada tick → MODAL POPUP (bukan inline error), corak
    // guest_passport. Server juga enforce (save_booking_traveller).
    if (!document.querySelector('.tvl-pdpa-consent:checked')) {
      _showConsentModal();
      return;
    }

    var btn = btnEl || get('tvl-save-btn-' + section);
    var btnLabel = btn ? btn.textContent : '';
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

    try {
      await _saveSection(section);
      if (section === 'passport') _afterPassportSaved();
      if (section === 'contact') _afterContactSaved();

      // Refresh data + slot terkini (flag has_passport dll.)
      var fresh = await API_BK('get_booking_data', { booking_number: BOOKING_REF });
      bookingData = fresh;
      if (ACTIVE_SLOT) {
        var s = (fresh.slots || []).find(function (x) { return x.slot_name === ACTIVE_SLOT.slot_name; });
        if (s) ACTIVE_SLOT = s;
      }

      // Notis "section saved" — user boleh terus isi bahagian lain atau
      // tekan Next / confirm bila dah selesai.
      var note = get('tvl-saved-note');
      if (note) {
        note.style.display = 'block';
        note.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function () { note.style.display = 'none'; }, 4000);
      }

      showToast(_SECTION_LABELS[section] + ' section saved!', 'success');
      _updateConfirmState();
    } catch (e) {
      _showInlineError('tvl-form-error', e.message || 'An error occurred. Please try again.');
      var errBox = get('tvl-form-error');
      if (errBox) errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      // Butang confirm disabled sehingga semua saved (atau slot sudah
      // terisi dari sesi sebelumnya) — ini guard tambahan.
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
      _updateConfirmState();
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

  /* Navigasi bawah panel (corak guest_passport): Next → tab berikutnya,
     ← Back → tab sebelumnya, ← Back (panel 1) → senarai traveller. */
  window.tvlNext = function (tabId) {
    var idx = TVL_TAB_ORDER.indexOf(tabId);
    if (idx === -1 || idx >= TVL_TAB_ORDER.length - 1) return;
    tvlShowTab(TVL_TAB_ORDER[idx + 1]);
  };

  window.tvlBack = function (tabId) {
    var idx = TVL_TAB_ORDER.indexOf(tabId);
    if (idx <= 0) return;
    tvlShowTab(TVL_TAB_ORDER[idx - 1]);
  };

  window.tvlBackToList = function () {
    window.location.href = '/traveller/travellers?ref=' + encodeURIComponent(BOOKING_REF);
  };

  function _resetTabs() { tvlShowTab('passport'); }

  /* ── Passport Preview ── */

  async function _loadPassportPreview(slot) {
    var preview = document.getElementById('passport-preview');
    var filenameEl = document.getElementById('passport-filename');
    
    // If no passport or element missing, ensure upload state is shown
    if (!preview || !slot || !slot.has_passport) {
      var ppUploaded = document.getElementById('passport-uploaded');
      var ppGrid = document.getElementById('passport-upload-grid');
      if (ppUploaded) ppUploaded.style.display = 'none';
      if (ppGrid) ppGrid.style.display = '';
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

        // Ensure uploaded container is visible, hide empty upload grid
        var ppUploaded = document.getElementById('passport-uploaded');
        var ppGrid = document.getElementById('passport-upload-grid');
        if (ppUploaded) ppUploaded.style.display = '';
        if (ppGrid) ppGrid.style.display = 'none';

      } else {
        // No image data — show upload grid instead
        var ppUploaded = document.getElementById('passport-uploaded');
        var ppGrid = document.getElementById('passport-upload-grid');
        if (ppUploaded) ppUploaded.style.display = 'none';
        if (ppGrid) ppGrid.style.display = '';
      }
    } catch (e) {
      // Error loading — show upload grid as fallback
      console.warn('Failed to load passport preview:', e);
      var ppUploaded = document.getElementById('passport-uploaded');
      var ppGrid = document.getElementById('passport-upload-grid');
      if (ppUploaded) ppUploaded.style.display = 'none';
      if (ppGrid) ppGrid.style.display = '';
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

  /* Sync Full Name (read-only) dari First + Last mengikut Full Name
     Format — kelakian sama dengan doctype Traveller (set_full_name):
     "First Name + Last Name" (default) atau "Last Name + First Name". */
  function _syncFullName() {
    var first = (document.getElementById('tvl-firstname')?.value || '').trim();
    var last  = (document.getElementById('tvl-lastname')?.value || '').trim();
    var nameEl = document.getElementById('tvl-name');
    if (!nameEl) return;
    if (!first && !last) return; // kekalkan nilai sedia ada bila kedua-dua kosong
    var fmtEl = document.getElementById('tvl-fullname-format');
    var fmt = (fmtEl && fmtEl.value) || 'First Name + Last Name';
    nameEl.value = fmt === 'Last Name + First Name'
      ? [last, first].filter(Boolean).join(' ')
      : [first, last].filter(Boolean).join(' ');
  }
  document.addEventListener('input', function (e) {
    if (e.target.id === 'tvl-firstname' || e.target.id === 'tvl-lastname' || e.target.id === 'tvl-fullname-format') {
      _syncFullName();
    }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'tvl-fullname-format') {
      _syncFullName();
    }
  });

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── Expose functions to global scope for HTML onclick handlers ── */
  window.triggerPassportUpload = triggerPassportUpload;
  window.triggerVisaPhotoUpload = triggerVisaPhotoUpload;

})();
