/* ============================================================
   travel_booking/public/js/traveller_detail.js
   Booking detail page — dashboard grid: Trip Hero (penuh),
   Payment Summary + Traveller Summary (50% grid), Add-ons &
   Extras (50%). Panel tambah-peserta-cabin penuh ada di page
   /traveller/travellers — di sini hanya notis pintasan.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var BOOKING_REF = _pageData.booking_ref || '';
  // mode "onbehalf" = page /traveller/onbehalf-booking (manager mengurus
  // booking pelanggan). mode "staff" = page desk /app/booking-manager
  // (staf dalaman mengurus SEMUA booking — behavior sama, URL ke page
  // desk). mode lalai = booking.html pemilik.
  var MODE = (_pageData.mode === 'onbehalf' || _pageData.mode === 'staff')
    ? _pageData.mode : 'self';
  // B2B end-customer: harga disembunyikan (server-authoritative flag dari
  var PRICE_HIDDEN = false;

  // Route desk Booking Manager untuk mod staff — ref dihantar sebagai
  // segmen path (bukan ?ref=) supaya router page boleh baca terus.
  // Base path dari booking_manager.js (window.BM_PAGE_HOME — /desk atau
  // /app ikut versi Frappe); fallback /app untuk kes penggunaan luar page.
  function _staffBookingUrl(view) {
    const base = window.BM_PAGE_HOME || '/app/booking-manager';
    return base + '/b/' + encodeURIComponent(BOOKING_REF) + (view ? '/' + view : '');
  }
  function backListUrl() {
    if (MODE === 'staff') return window.BM_PAGE_HOME || '/app/booking-manager';
    return MODE === 'onbehalf' ? '/traveller/onbehalf' : '/traveller/bookings';
  }
  function backListLabel() {
    if (MODE === 'staff') return '← Back to All Bookings';
    return MODE === 'onbehalf' ? '← Back to On-Behalf Bookings' : '← Back to My Bookings';
  }
  // Page billing ikut mod — onbehalf guna page berasingan supaya
  // endpoint data (booking-scoped) & gate tahap akses jelas.
  function billingPageUrl() {
    if (MODE === 'staff') return _staffBookingUrl('billing');
    return MODE === 'onbehalf' ? '/traveller/onbehalf-billing' : '/traveller/billing';
  }
  // Page traveller & addon ikut mod juga — page berasingan dengan guard
  // role on-behalf (corak sama dengan billingPageUrl()).
  function travellersPageUrl() {
    if (MODE === 'staff') return _staffBookingUrl('travellers');
    return MODE === 'onbehalf' ? '/traveller/onbehalf-travellers' : '/traveller/travellers';
  }
  function addonsPageUrl() {
    if (MODE === 'staff') return _staffBookingUrl('addons');
    return MODE === 'onbehalf' ? '/traveller/onbehalf-addons' : '/traveller/booking_addons';
  }
  function manageAddonsUrl() {
    if (MODE === 'staff') return _staffBookingUrl('addons') + '?tab=manage';
    return '/traveller/manage_addon?ref=' + encodeURIComponent(BOOKING_REF);
  }

  /* ── Init ── */
  async function init() {
    if (!BOOKING_REF) return;
    try {
      await ensureSession();
      renderNav();
      await loadDetail();
    } catch (e) {
      console.error('Failed to load detail:', e);
    }
  }

  async function loadDetail() {
    var loading = document.getElementById('detail-loading');
    var content = document.getElementById('detail-content');

    try {
      var data = await API_BK('get_booking_data', { booking_number: BOOKING_REF });
      var b = data.booking;

      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML = renderDetail(data);
        wireBillsModal();
        wireCustomerEditModal(data);
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML =
          '<div class="tv-card tv-text-center" style="padding:40px;">' +
          '<p style="color:var(--c-danger-text);">' + _esc(e.message || 'Failed to load booking.') + '</p>' +
          '<a href="' + backListUrl() + '" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:16px;">' + backListLabel() + '</a>' +
          '</div>';
      }
    }
  }

  /* ── Render Full Detail Page ── */
  function renderDetail(data) {
    var b = data.booking || {};
    var slots = data.slots || [];
    var cabins = data.cabins || [];
    var payment = data.payment || {};
    var so = payment.so || {};

    var ref = _esc(b.booking_number || b.name || '');
    var tripName = _esc(b.trip_name || 'Unnamed Trip');
    var status = _esc(b.booking_status || 'Pending');

    // ── ON-BEHALF: customer akhir + tahap akses (server-authoritative) ──
    // isOnbehalf ikut bendera server (data.booking.on_behalf_view) — client
    // tak boleh "paksa" mod manager. Level menentukan butang yang dipapar:
    //   View (0): baca sahaja · Docs (1): + travellers/documents/add-ons
    //   Full (2): + pembayaran & muat turun PDF
    var isOnbehalf = MODE === 'onbehalf' || !!b.on_behalf_view;
    var LEVEL_RANK = { 'View': 0, 'Docs': 1, 'Full': 2 };
    var level = isOnbehalf ? (LEVEL_RANK[b.on_behalf_access_level] !== undefined
      ? b.on_behalf_access_level : 'View') : 'Full';
    var canDocs = LEVEL_RANK[level] >= 1;
    var canFull = LEVEL_RANK[level] >= 2;

    // ── B2B: end-customer tempahan partner — TIADA harga/billing ──
    // Server (get_booking_data) dah menapis payload kewangan; di sini kita
    // gantikan kad Payment Summary dengan notis "diuruskan oleh agen".
    var priceHidden = !!b.price_hidden;
    PRICE_HIDDEN = priceHidden;

    // Trip classification from API
    var isCruise = !!b.is_cruise;
    var cruiseOnly = !!b.cruise_only;
    var packageType = _esc(b.package_type || '');
    var tripCategory = _esc(b.trip_category || (isCruise ? 'Cruise Trip' : 'Tour Package'));

    // Dates
    var depDate = b.departure_date ? fmtDate(b.departure_date) : '';
    var retDate = b.return_date ? fmtDate(b.return_date) : '';
    var sailingStart = b.sailing_start ? fmtDate(b.sailing_start) : '';
    var sailingEnd = b.sailing_end ? fmtDate(b.sailing_end) : '';

    // Ports & Ship (cruise)
    var embarkPort = _esc(b.embarkation_port || '');
    var disembarkPort = _esc(b.disembarkation_port || '');
    var shipName = _esc(b.ship_name || '');

    // Airport (fly packages)
    var airportCode = _esc(b.airport_code || '');
    var airportCity = _esc(b.airport_city || '');
    var airportName = _esc(b.airport_name || airportCity);

    // Flight itinerary (slot-level — senarai blok, satu per flight
    // distinct dari Booking Reservation.flight; Booking tak lagi simpan
    // flight). Booking group kini sah berpecah ke beberapa flight.
    var fis = b.flight_itineraries || [];

    // Group/Trip code
    var groupName = _esc(b.group_name || '');
    var packageTitle = _esc(b.package_title || '');

    // Financials — papar ikut currency SO utama (server kembalikan
    // currency/currency_symbol ringkasan; pecahan per-SO ada di so_list)
    var soSym = curSym(so);
    var grandTotal = parseFloat(so.grand_total) || 0;
    var advancePaid = parseFloat(so.advance_paid) || 0;
    var balance = grandTotal - advancePaid;
    var payPct = grandTotal > 0 ? Math.round((advancePaid / grandTotal) * 100) : 0;
    var isPaid = balance <= 0;
    // No payment made yet (and there's an amount to pay) → lock the
    // Traveller Summary & Add-ons panels and prompt the customer to pay.
    var noPayment = (advancePaid <= 0 && grandTotal > 0);

    // Traveller stats
    var totalSlots = parseInt(b.total_slots) || slots.length;
    var filledCount = parseInt(b.filled_count) || 0;
    var verifiedCount = parseInt(b.verified_count) || 0;
    var docPct = filledCount > 0 ? Math.round((verifiedCount / filledCount) * 100) : 0;
    var cabinCount = cabins.length || Math.ceil(filledCount / 2);

    var html = '';

    /* Page nav: Back (top) */
    html += '<div style="margin-bottom:20px;">';
    html += '<a href="' + backListUrl() + '" class="tv-btn tv-btn--ghost tv-btn--sm">' + backListLabel() + '</a>';
    html += '</div>';

    /* ══════════════════════════════════════
       SECTION 0 (onbehalf sahaja): CUSTOMER BLOCK
       Customer akhir yang booking ini untuk — header utama page
       (seperti kad listing), + channel & tahap akses manager.
       booking.html (pemilik) TIDAK memaparkan blok ini.
       ══════════════════════════════════════ */
    if (isOnbehalf) {
      var endName = _esc(b.end_customer_name || 'Unknown Customer');
      var endEmail = _esc(b.end_customer_email || '');
      var endPhone = _esc(b.end_customer_phone || '');
      var endAddr = _esc(b.end_customer_address || '');
      var channel = _esc(b.booking_channel || '');
      var levelMeta = MODE === 'staff'
        ? { icon: '🛠', label: 'Staff Access', desc: 'You are managing this booking as internal staff — travellers, documents, payments & documents are fully accessible.' }
        : {
        'View': { icon: '👁', label: 'View Access', desc: 'You can view this booking’s status, trip & billing summary only.' },
        'Docs': { icon: '📄', label: 'Docs Access', desc: 'You can view everything and manage traveller details & documents (no payments).' },
        'Full': { icon: '🔑', label: 'Full Access', desc: 'You can manage travellers, documents, payments & download documents.' }
      }[level] || { icon: '👁', label: level + ' Access', desc: '' };

      html += '<div class="tv-card tv-animate-in">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">';
      // Kiri: customer name (header utama) + contact info
      html += '<div style="min-width:220px;">';
      html += '<div class="tv-info-label" style="margin-bottom:2px;">Customer</div>';
      html += '<h2 class="tv-th-name" style="margin:0 0 4px 0;">' + endName + '</h2>';
      if (endEmail) {
        html += '<div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">✉️ ' + endEmail + '</div>';
      }
      if (endPhone) {
        html += '<div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">📞 ' + endPhone + '</div>';
      }
      if (endAddr) {
        // Alamat billing customer (teks terformat dari Address customer —
        // baris baharu dikekalkan melalui white-space:pre-line)
        html += '<div style="font-size:13px;color:var(--text-secondary);margin-top:8px;white-space:pre-line;line-height:1.55;">' + endAddr + '</div>';
      }
      // Edit billing info (tahap Full sahaja — server gate endpooint "Full")
      if (canFull) {
        html += '<button type="button" id="tvl-edit-cust-btn" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:12px;">✏️ Edit Billing Info</button>';
      }
      html += '</div>';
      // Kanan: badge channel + access level
      html += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">';
      if (channel) {
        html += '<span class="tv-badge tv-badge--neutral">' + channel + ' Booking</span>';
      }
      html += '<span class="tv-badge tv-badge--info">' + levelMeta.icon + ' ' + _esc(levelMeta.label) + '</span>';
      html += '</div>';
      html += '</div>';
      if (levelMeta.desc) {
        html += '<p style="font-size:12px;color:var(--text-muted);margin:10px 0 0 0;line-height:1.6;">' + _esc(levelMeta.desc) + '</p>';
      }
      html += '</div>'; // customer card
    }

    /* ══════════════════════════════════════
       SECTION A: TRIP HERO (Main Info)
       ══════════════════════════════════════ */
    html += '<div class="tv-card tv-animate-in">';

    // ── Row 1: Booking Ref (left) + Booking Status with label (right) ──
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:16px;">';
    // Left: Ref
    html += '<div>';
    html += '<div class="tv-info-label" style="margin-bottom:2px;">Booking Ref. No.</div>';
    html += '<div class="tv-th-ref" style="font-size:18px;">' + ref + '</div>';
    html += '</div>';
    // Right: Status label + badge
    html += '<div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">';
    html += '<div class="tv-info-label" style="margin:0;">Booking Status</div>';
    html += '<span style="font-weight:700;font-size:16px;color:var(--text-primary);">' + _esc(status) + '</span>';
    html += '</div>';
    html += '</div>';

    // ── Row 2: Trip Name ──
    html += '<h2 class="tv-th-name">' + tripName + '</h2>';

    // ── Row 3: Left (Trip Group + Package) | Right (Type badge) ──
    var catCls = isCruise ? 'info' : 'success';
    var catIcon = isCruise ? '🚢' : '🏖️';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:16px;">';
    // Left: subtitles
    html += '<div style="color:var(--text-secondary);font-size:14px;line-height:1.6;flex:1;min-width:200px;">';
    if (groupName) {
      html += '<div style="display:flex;align-items:center;gap:6px;">';
      html += '<span class="tv-info-label" style="margin:0;min-width:90px;">Trip Group</span>';
      html += '<span style="font-weight:400;color:var(--text-primary);">' + groupName + '</span>';
      html += '</div>';
    }
    if (packageTitle) {
      html += '<div style="display:flex;align-items:center;gap:6px;">';
      html += '<span class="tv-info-label" style="margin:0;min-width:90px;">Package</span>';
      html += '<span style="font-weight:400;color:var(--text-primary);">' + packageTitle + '</span>';
      html += '</div>';
    }
    html += '</div>';
    // Right: Type badge
    html += '<span class="tv-badge tv-badge--' + catCls + '" style="font-size:13px;font-weight:500;padding:4px 10px;">';
    html += catIcon + ' ' + tripCategory;
    html += '</span>';
    html += '</div>';

    // ── BLOCK 1: ✈ Departure & Arrival (disembunyikan untuk Cruise Only;
    //              tarikh relevan cruise ada dlm blok Cruise & Sailing) ──
    if (!cruiseOnly) {
      html += '<div class="tv-sec">✈ Departure &amp; Arrival</div>';
      html += '<div class="tv-hero-grid">';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Departure Date</div><div class="tv-hero-value">' + (depDate || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Return Date</div><div class="tv-hero-value">' + (retDate || '—') + '</div></div>';
      // Fly From: Airport Code (bold) + Airport Name (small muted)
      var flyFromHtml = '<span style="color:var(--text-muted);">—</span>';
      if (packageType !== 'Ground Only' && (airportCode || airportCity)) {
        flyFromHtml = '';
        if (airportCode) {
          flyFromHtml += '<div style="font-size:16px;font-weight:700;color:var(--text-primary);">' + _esc(airportCode) + '</div>';
        }
        if (airportName) {
          flyFromHtml += '<div style="font-size:11px;font-weight:400;color:var(--text-muted);margin-top:2px;">' + _esc(airportName) + '</div>';
        }
        if (!flyFromHtml) flyFromHtml = '<span style="color:var(--text-muted);">—</span>';
      }
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Fly From</div><div class="tv-hero-value">' + flyFromHtml + '</div></div>';
      html += '</div>'; // grid Block 1
    }

    // ── BLOCK 2: ⚓ Cruise & Sailing (cruise sahaja) ──
    if (isCruise) {
      html += '<div class="tv-sec">⚓ Cruise &amp; Sailing</div>';
      html += '<div class="tv-hero-grid">';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Sailing Start</div><div class="tv-hero-value">' + (sailingStart || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Sailing End</div><div class="tv-hero-value">' + (sailingEnd || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Ship</div><div class="tv-hero-value">' + (shipName || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Embarkation Port</div><div class="tv-hero-value">' + (embarkPort || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Disembarkation Port</div><div class="tv-hero-value">' + (disembarkPort || '—') + '</div></div>';
      html += '</div>'; // grid Block 2
    }

    // ── BLOCK 3: 🛫 Flight Itinerary (slot-level flight) ──
    // Satu blok setiap flight distinct dalam booking. Hanya papar flight
    // yang ada PNR; bila booking berpecah flight, setiap blok dilabel.
    var fiAirport = function(code, name) {
      if (!code && !name) return '<span style="color:var(--text-muted);">—</span>';
      var h = '';
      if (code) h += '<div style="font-size:16px;font-weight:700;color:var(--text-primary);">' + _esc(code) + '</div>';
      if (name) h += '<div style="font-size:11px;font-weight:400;color:var(--text-muted);margin-top:2px;">' + _esc(name) + '</div>';
      return h || '<span style="color:var(--text-muted);">—</span>';
    };
    var shownFlights = fis.filter(function(f) { return f && f.pnr; });
    shownFlights.forEach(function(fi, flightIdx) {
      var fiDepDate = fi.departure_date ? fmtDate(fi.departure_date) : '';
      var fiArrDate = fi.arrival_date ? fmtDate(fi.arrival_date) : '';
      // Airline cell: name + flight class (small subtitle)
      var fiAirline = '—';
      if (fi.airline) {
        fiAirline = _esc(fi.airline);
        if (fi.flight_class) fiAirline += '<div style="font-size:11px;font-weight:400;color:var(--text-muted);margin-top:2px;">' + _esc(fi.flight_class) + '</div>';
      }
      var fiSecLabel = '🛫 Flight Itinerary';
      if (shownFlights.length > 1) fiSecLabel += ' — Flight ' + (flightIdx + 1);
      html += '<div class="tv-sec">' + fiSecLabel + '</div>';
      html += '<div class="tv-hero-grid">';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">PNR</div><div class="tv-hero-value">' + _esc(fi.pnr) + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Airline</div><div class="tv-hero-value">' + fiAirline + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Departure</div><div class="tv-hero-value">' + (fiDepDate || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Return Arrival</div><div class="tv-hero-value">' + (fiArrDate || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Departure Airport</div><div class="tv-hero-value">' + fiAirport(fi.home_airport_code, fi.home_airport_name) + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Arrival Airport</div><div class="tv-hero-value">' + fiAirport(fi.dest_airport_code, fi.dest_airport_name) + '</div></div>';
      html += '</div>'; // grid Block 3
      // Rich itinerary (admin-entered Text Editor HTML — trusted source)
      if (fi.itinerary_html) {
        html += '<div class="tv-flight-itinerary-html">' + fi.itinerary_html + '</div>';
      }
    });

    html += '</div>'; // hero

    /* ══════════════════════════════════════
       SECTION A2: BOOKING NOTE — pesanan customer semasa checkout
       (Booking.customer_message, "Message to Us"). Dipaparkan untuk
       SEMUA mod (self / onbehalf / staff) supaya customer nampak semula
       apa yang dihantar dan manager/staf nampak konteks permintaan khas
       tanpa buka Desk. Kosong → kad disembunyi.
       ══════════════════════════════════════ */
    var bookingNote = (b.customer_message || '').trim();
    if (bookingNote) {
      html += '<div class="tv-card tv-animate-in">';
      html += '<div style="display:flex;align-items:flex-start;gap:12px;">';
      html += '<div style="font-size:22px;line-height:1.2;">📝</div>';
      html += '<div style="flex:1;min-width:0;">';
      html += '<h3 class="tv-card__title" style="margin:0 0 6px 0;">Booking Note</h3>';
      html += '<p style="font-size:13px;color:var(--text-secondary);margin:0;line-height:1.6;white-space:pre-line;word-break:break-word;">' + _esc(bookingNote) + '</p>';
      html += '</div>';
      html += '</div>';
      html += '</div>'; // note card
    }

    /* ══════════════════════════════════════
       DASHBOARD GRID — ROW 1
       Card 2: Payment Summary (50%) · Card 3: Traveller Summary (50%)
       B2B end-customer: kad Payment diganti notis billing-agen (tiada angka).
       ══════════════════════════════════════ */
    var soList = (data.payment && data.payment.so_list) || [];
    html += '<div class="tv-dash-grid">';

    if (priceHidden) {
      // ── Card 2 (B2B): notis billing-agen — tiada angka kewangan ──
      html += '<div class="tv-card tv-animate-in">';
      html += '<div style="display:flex;align-items:flex-start;gap:12px;">';
      html += '<div style="font-size:22px;line-height:1.2;">🧾</div>';
      html += '<div style="flex:1;min-width:0;">';
      html += '<h3 class="tv-card__title" style="margin:0 0 6px 0;">Billing</h3>';
      html += '<p style="font-size:13px;color:var(--text-secondary);margin:0;line-height:1.6;">Billing and payments for this booking are handled by your travel agent. Your booking status and trip progress will be updated here.</p>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
    } else {
      // ── Card 2: Payment Summary — numeric tiles + payment progress ──
      html += '<div class="tv-card tv-animate-in">';
      // Header: title + butang modal pemilihan bill/SO
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">';
      html += '<h3 class="tv-card__title">💰 Payment Summary</h3>';
      // Butang urus bill — pembayaran/PDF di tahap Full sahaja (server gate:
      // create_payment_request, submit_manual_payment, get_document_pdf).
      if (canFull) {
        html += '<button type="button" class="tv-btn tv-btn--primary tv-btn--sm" data-act="open-bills" style="white-space:nowrap;">Manage Bill →</button>';
      }
      html += '</div>';

      // Numeric tiles — angka utama ringkasan bayaran
      html += '<div class="tv-num-row" style="margin-top:16px;">';
      html += _numTile('Total Billed', fmtDual(grandTotal, soSym), '');
      html += _numTile('Paid', fmtDual(advancePaid, soSym), 'success');
      html += _numTile('Balance Due', fmtDual(balance, soSym), isPaid ? 'success' : 'warning');
      html += '</div>';

      // Payment progress bar
      html += '<div class="tv-progress" role="progressbar" aria-valuenow="' + payPct + '" aria-valuemin="0" aria-valuemax="100" style="margin-top:16px;">';
      html += '<div class="tv-progress__fill' + (isPaid ? ' done' : '') + '" style="width:' + payPct + '%"></div>';
      html += '</div>';
      var progressLabel = isPaid
        ? '<span class="tv-progress-label--success">✓ Paid in full — thank you!</span>'
        : '<span>' + payPct + '% paid · ' + fmtDual(balance, soSym) + ' remaining to settle</span>';
      html += '<div class="tv-progress-label" style="justify-content:center;margin-bottom:0;">' + progressLabel + '</div>';

      // Belum bayar langsung → amaran + pintasan bayar (level Full sahaja)
      if (noPayment && canFull) {
        var payUrl = billingPageUrl() + '?ref=' + encodeURIComponent(ref);
        if (b.sales_order) payUrl += '&bill=' + encodeURIComponent(b.sales_order);
        html += '<div style="display:flex;align-items:flex-start;gap:10px;margin-top:14px;padding:10px 12px;border:1px solid var(--c-warning);background:var(--c-warning-bg);border-radius:10px;">';
        html += '<span style="font-size:15px;line-height:1.4;">🔒</span>';
        html += '<div style="flex:1;min-width:0;font-size:12.5px;color:var(--text-secondary);line-height:1.5;">Payment required to unlock traveller &amp; add-on management. <a href="' + payUrl + '" style="font-weight:600;color:var(--c-warning-text);">Pay Now →</a></div>';
        html += '</div>';
      }
      html += '</div>'; // payment card
    }

    // ── Card 3: Traveller Summary — status ringkas + pintasan ke page
    //    /traveller/travellers. Dilock jika belum bayar (self mode).
    if (!noPayment || isOnbehalf) {
      var roomLabel = isCruise ? 'Cabin' : 'Room';

      html += '<div class="tv-card tv-animate-in">';
      // Header: title + Manage Travellers (tahap Docs ke atas — server gate:
      // save_booking_traveller dkk = "Docs". View nampak ringkasan sahaja).
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">';
      html += '<h3 class="tv-card__title">👥 Traveller Summary</h3>';
      if (canDocs) {
        html += '<a href="' + travellersPageUrl() + '?ref=' + encodeURIComponent(ref) + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;">Manage Travellers →</a>';
      }
      html += '</div>';

      // Numeric tiles — status traveller
      html += '<div class="tv-num-row" style="margin-top:16px;">';
      html += _numTile(roomLabel + 's', String(cabinCount), '');
      html += _numTile('Travellers', filledCount + '/' + totalSlots, '');
      html += _numTile('Docs Verified', docPct + '%', docPct >= 100 ? 'success' : '');
      html += '</div>';
      html += '</div>'; // traveller card
    }

    html += '</div>'; // end dash grid row 1

    /* ══════════════════════════════════════
       DASHBOARD GRID — ROW 2
       Card 4: Add-ons & Extras (50%) · notis tambah traveller cabin (50%)
       (dilock jika belum bayar — self mode; onbehalf sentiasa nampak)
       ══════════════════════════════════════ */
    if (!noPayment || isOnbehalf) {
      var addonOrders = (data.addon_orders || []);
      var hasAddonOrders = addonOrders.length > 0;
      var addonUrl  = addonsPageUrl() + '?booking=' + encodeURIComponent(ref);
      var manageUrl = manageAddonsUrl();

      html += '<div class="tv-dash-grid">';

      // ── Card 4: Add-ons & Extras — simple status (bilangan order) ──
      html += '<div class="tv-card tv-animate-in">';
      // Header: title + CTA. Add-on endpoints digate "Docs" (addon_manager)
      // — View nampak ringkasan sahaja tanpa butang.
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">';
      html += '<h3 class="tv-card__title">🎁 Add-ons &amp; Extras</h3>';
      if (canDocs) {
        var btnUrl = hasAddonOrders ? manageUrl : addonUrl;
        html += '<a href="' + btnUrl + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;">';
        html += hasAddonOrders ? 'Manage Addon →' : 'Browse Addon →';
        html += '</a>';
      }
      html += '</div>';

      // Angka utama — berapa pakej order
      html += '<div style="display:flex;align-items:baseline;gap:10px;margin-top:14px;">';
      html += '<span style="font-family:var(--font-heading);font-size:28px;font-weight:700;color:var(--text-primary);line-height:1;">' + addonOrders.length + '</span>';
      html += '<span style="font-size:13px;color:var(--text-muted);">package order' + (addonOrders.length === 1 ? '' : 's') + '</span>';
      html += '</div>';

      if (!hasAddonOrders) {
        // No orders yet → encourage browsing
        html += '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">Enhance your trip with optional activities, upgrades &amp; more</div>';
      } else if (priceHidden) {
        // B2B — jumlah addon juga maklumat billing; papar bilangan sahaja.
        html += '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">Billed via your travel agent</div>';
      } else {
        // Jumlah addon DIKUMPULKAN PER CURRENCY (addon SO boleh berlainan
        // currency dari SO utama) — sesama currency digabung, antara
        // currency dipaparkan berasingan.
        var addonBySym = {};
        addonOrders.forEach(function(o) {
          var s = curSym(o);
          addonBySym[s] = (addonBySym[s] || 0) + (parseFloat(o.total_amount) || 0);
        });
        var addonTotalTxt = Object.keys(addonBySym).map(function (s) {
          return fmtDual(addonBySym[s], s);
        }).join(' &nbsp;+&nbsp; ');
        html += '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">Total: ' + addonTotalTxt + '</div>';
      }
      html += '</div>'; // addons card

      // Notis cabin sharing (self mode sahaja) — diisi oleh loadShareCabins()
      // selepas mount; panel penuh tambah peserta ada di /traveller/travellers.
      if (!isOnbehalf) {
        html += '<div id="tvShareNotice"></div>';
      }

      html += '</div>'; // end dash grid row 2
    } // end if (!noPayment || isOnbehalf)

    // Modal pemilihan bill/SO (level Full, bukan B2B)
    if (!priceHidden && canFull) {
      html += _buildBillsModal(soList, ref);
    }

    /* Page nav: Back (bottom) */
    html += '<div style="margin-top:24px;">';
    html += '<a href="' + backListUrl() + '" class="tv-btn tv-btn--ghost tv-btn--sm">' + backListLabel() + '</a>';
    html += '</div>';

    return html;
  }


  /* ── Numeric tile helper (dashboard cards) ── */
  function _numTile(label, value, tone) {
    return '<div class="tv-num-card' + (tone ? ' tv-num-card--' + tone : '') + '">' +
      '<div class="tv-num-card__label">' + label + '</div>' +
      '<div class="tv-num-card__value">' + value + '</div>' +
      '</div>';
  }

  /* ── Modal: pilih bill/SO untuk diuruskan ──
     Dibina sekali dalam renderDetail (hidden), dibuka melalui butang
     "Manage Bill " pada kad Payment Summary. Setiap baris link ke
     page billing dengan param bill — aliran bayaran sama seperti dulu. */
  function _buildBillsModal(soList, ref) {
    var rows = '';
    if (soList.length > 0) {
      soList.forEach(function (sso) {
        var soAmt = parseFloat(sso.grand_total) || 0;
        var soPaid = parseFloat(sso.advance_paid) || 0;
        var soBal = soAmt - soPaid;
        // Payment status (bukan SO status)
        var payStatus, payCls;
        if (soBal <= 0) { payStatus = 'Paid'; payCls = 'success'; }
        else if (soPaid > 0) { payStatus = 'Partially Paid'; payCls = 'warning'; }
        else { payStatus = 'Unpaid'; payCls = 'neutral'; }
        var soBillingUrl = billingPageUrl() + '?ref=' + encodeURIComponent(ref) + '&bill=' + encodeURIComponent(sso.name || '');

        rows += '<div class="tv-modal__row">';
        rows += '<div style="min-width:0;flex:1;">';
        rows += '<div class="tv-modal__so">' + _esc(sso.name || '') + '</div>';
        rows += '<div class="tv-modal__meta"><span class="tv-badge tv-badge--' + payCls + '">' + payStatus + '</span> · Total ' + fmtDual(soAmt, curSym(sso)) + ' · Balance ' + fmtDual(soBal, curSym(sso)) + '</div>';
        rows += '</div>';
        rows += '<a href="' + soBillingUrl + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;">Manage →</a>';
        rows += '</div>';
      });
    } else {
      rows = '<p style="font-size:13px;color:var(--text-muted);padding:12px 0;">No bill orders found.</p>';
    }

    var html = '';
    html += '<div class="tv-modal-overlay" id="tvBillsModal" hidden>';
    html += '<div class="tv-modal" role="dialog" aria-modal="true" aria-label="Select bill to manage">';
    html += '<div class="tv-modal__head">';
    html += '<h3 class="tv-modal__title">Manage Bill</h3>';
    html += '<button type="button" class="tv-modal__close" data-act="close-bills" aria-label="Close">&times;</button>';
    html += '</div>';
    html += '<p class="tv-modal__sub">Booking ' + _esc(ref) + ' — select which bill order (Sales Order) you want to manage.</p>';
    html += rows;
    html += '</div>';
    html += '</div>';
    return html;
  }

  /* ── Wire modal "Edit Billing Info" (panel Customer, onbehalf sahaja) ──
     Butang dirender bila tahap akses Full; klik → buka modal borang
     email / telefon / alamat billing customer. */
  function wireCustomerEditModal(data) {
    var btn = document.getElementById('tvl-edit-cust-btn');
    if (!btn) return;
    var b = (data && data.booking) || {};
    btn.addEventListener('click', function () { openCustomerEditModal(b); });
  }

  function openCustomerEditModal(b) {
    var existing = document.getElementById('tvl-cust-modal');
    if (existing) existing.remove();

    var billing = b.end_customer_billing || {};
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    var inp = 'width:100%;padding:10px 12px;border:1.5px solid var(--border-default);border-radius:8px;font:inherit;font-size:13.5px;color:var(--text-primary);box-sizing:border-box;background:#fff;';
    var lbl = 'display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin:10px 0 4px;';

    // Country = dropdown dari dokumen Country (context page controller) —
    // nilai canonical supaya sentiasa sah untuk Address.customer. Nilai
    // lama yang tersimpan (cth. free-text rekod lama) tetap dipapar sebagai
    // opsyen tambahan supaya tak hilang.
    var countries = _pageData.billing_countries || [];
    var curCountry = billing.country || '';
    var countryOptions = '<option value="">Select country</option>';
    countries.forEach(function (c) {
      var sel = (c === curCountry) ? ' selected' : '';
      countryOptions += '<option value="' + _esc(c) + '"' + sel + '>' + _esc(c) + '</option>';
    });
    if (curCountry && countries.indexOf(curCountry) === -1) {
      countryOptions += '<option value="' + _esc(curCountry) + '" selected>' + _esc(curCountry) + '</option>';
    }

    var overlay = document.createElement('div');
    overlay.id = 'tvl-cust-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(30,28,24,.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:14px;padding:24px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(30,28,24,.35);font-family:inherit;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
          '<div style="font-size:16px;font-weight:700;color:var(--text-primary);">✏️ Edit Billing Info</div>' +
          '<button type="button" id="tce-close" aria-label="Close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);line-height:1;">×</button>' +
        '</div>' +
        '<p style="font-size:12px;color:var(--text-muted);margin:0 0 6px;line-height:1.5;">' +
          'Update the customer’s billing contact details. These details are used on billing documents. ' +
          'The customer’s portal login email is not changed. All fields are required.</p>' +
        '<label style="' + lbl + '">Email <span style="color:#DC2626;">*</span></label>' +
        '<input type="email" id="tce-email" required style="' + inp + '" value="' + _esc(b.end_customer_email || '') + '" autocomplete="email"/>' +
        '<label style="' + lbl + '">Phone <span style="color:#DC2626;">*</span></label>' +
        '<input type="tel" id="tce-phone" required style="' + inp + '" value="' + _esc(b.end_customer_phone || '') + '" autocomplete="tel"/>' +
        '<label style="' + lbl + '">Street Address <span style="color:#DC2626;">*</span></label>' +
        '<input type="text" id="tce-street" required style="' + inp + '" value="' + _esc(billing.address_line1 || '') + '" autocomplete="street-address"/>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
          '<div><label style="' + lbl + '">City <span style="color:#DC2626;">*</span></label>' +
          '<input type="text" id="tce-city" required style="' + inp + '" value="' + _esc(billing.city || '') + '" autocomplete="address-level2"/></div>' +
          '<div><label style="' + lbl + '">Postcode <span style="color:#DC2626;">*</span></label>' +
          '<input type="text" id="tce-postcode" required style="' + inp + '" value="' + _esc(billing.postcode || '') + '" autocomplete="postal-code"/></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
          '<div><label style="' + lbl + '">State <span style="color:#DC2626;">*</span></label>' +
          '<input type="text" id="tce-state" required style="' + inp + '" value="' + _esc(billing.state || '') + '" autocomplete="address-level1"/></div>' +
          '<div><label style="' + lbl + '">Country <span style="color:#DC2626;">*</span></label>' +
          '<select id="tce-country" required style="' + inp + '" autocomplete="country-name">' + countryOptions + '</select></div>' +
        '</div>' +
        '<div id="tce-error" style="display:none;margin-top:12px;padding:10px 12px;border-radius:8px;background:#FDECEC;color:#991B1B;font-size:12.5px;line-height:1.5;"></div>' +
        '<div style="display:flex;gap:10px;margin-top:18px;">' +
          '<button type="button" id="tce-cancel" class="tv-btn tv-btn--ghost" style="flex:1;">Cancel</button>' +
          '<button type="button" id="tce-save" class="tv-btn tv-btn--primary" style="flex:1;">Save Changes</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    function close() {
      overlay.remove();
      document.body.style.overflow = '';
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#tce-close').addEventListener('click', close);
    overlay.querySelector('#tce-cancel').addEventListener('click', close);

    overlay.querySelector('#tce-save').addEventListener('click', async function () {
      var errBox = overlay.querySelector('#tce-error');
      errBox.style.display = 'none';

      // Semua medan dalam modal ini wajib sebelum Save Changes —
      // validasi tempatan form ini sahaja (endpoint server kekal menerima
      // medan pilihan untuk panggilan lain).
      var requiredIds = ['tce-email', 'tce-phone', 'tce-street', 'tce-city',
                         'tce-postcode', 'tce-state', 'tce-country'];
      var firstEmpty = null;
      requiredIds.forEach(function (id) {
        var el = overlay.querySelector('#' + id);
        if (!el) return;
        var empty = !(el.value || '').trim();
        el.style.borderColor = empty ? '#DC2626' : '';
        if (empty && !firstEmpty) firstEmpty = el;
      });
      if (firstEmpty) {
        errBox.textContent = 'Please fill in all fields — every field is required to save changes.';
        errBox.style.display = 'block';
        firstEmpty.focus();
        return;
      }

      var email = val('tce-email');
      if (email && email.indexOf('@') === -1) {
        errBox.textContent = 'Please enter a valid email address.';
        errBox.style.display = 'block';
        return;
      }
      var saveBtn = overlay.querySelector('#tce-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await API_BK('update_end_customer_info', {
          booking_number: BOOKING_REF,
          email: email,
          phone: val('tce-phone'),
          address_line1: val('tce-street'),
          city: val('tce-city'),
          postcode: val('tce-postcode'),
          state: val('tce-state'),
          country: val('tce-country'),
        });
        window.location.reload();  // refresh panel customer dengan nilai baharu
      } catch (e) {
        errBox.textContent = e.message || 'Failed to update. Please try again.';
        errBox.style.display = 'block';
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    });
  }

  /* ── Wire modal pemilihan bill/SO ──
     Buka: butang data-act="open-bills". Tutup: butang ×, klik overlay,
     atau Escape. Scroll body dikunci semasa modal terbuka. */
  function wireBillsModal() {
    var modal = document.getElementById('tvBillsModal');
    if (!modal) return;

    function open() {
      modal.removeAttribute('hidden');
      document.body.style.overflow = 'hidden';
    }
    function close() {
      modal.setAttribute('hidden', '');
      document.body.style.overflow = '';
    }

    document.querySelectorAll('[data-act="open-bills"]').forEach(function (btn) {
      btn.addEventListener('click', open);
    });
    modal.querySelectorAll('[data-act="close-bills"]').forEach(function (btn) {
      btn.addEventListener('click', close);
    });
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hasAttribute('hidden')) close();
    });
  }

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
