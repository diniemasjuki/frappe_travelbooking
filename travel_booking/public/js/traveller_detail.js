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
  // booking pelanggan). mode lalai = booking.html pemilik.
  var MODE = _pageData.mode === 'onbehalf' ? 'onbehalf' : 'self';
  // B2B end-customer: harga disembunyikan (server-authoritative flag dari
  var PRICE_HIDDEN = false;

  function backListUrl() { return MODE === 'onbehalf' ? '/traveller/onbehalf' : '/traveller/bookings'; }
  function backListLabel() { return MODE === 'onbehalf' ? '← Back to On-Behalf Bookings' : '← Back to My Bookings'; }
  // Page billing ikut mod — onbehalf guna page berasingan supaya
  // endpoint data (booking-scoped) & gate tahap akses jelas.
  function billingPageUrl() { return MODE === 'onbehalf' ? '/traveller/onbehalf-billing' : '/traveller/billing'; }

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

    // Flight itinerary (booking-level, dari tabFlight via booking.flight)
    var fi = b.flight_itinerary || {};

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
      var channel = _esc(b.booking_channel || '');
      var levelMeta = {
        'View': { icon: '👁', label: 'View Access', desc: 'You can view this booking’s status, trip & billing summary only.' },
        'Docs': { icon: '📄', label: 'Docs Access', desc: 'You can view everything and manage traveller details & documents (no payments).' },
        'Full': { icon: '🔑', label: 'Full Access', desc: 'You can manage travellers, documents, payments & download documents.' }
      }[level] || { icon: '👁', label: level + ' Access', desc: '' };

      html += '<div class="tv-card tv-animate-in">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">';
      // Kiri: customer name (header utama) + email
      html += '<div style="min-width:220px;">';
      html += '<div class="tv-info-label" style="margin-bottom:2px;">Customer</div>';
      html += '<h2 class="tv-th-name" style="margin:0 0 4px 0;">' + endName + '</h2>';
      if (endEmail) {
        html += '<div style="font-size:13px;color:var(--text-secondary);">' + endEmail + '</div>';
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

    // ── BLOCK 3: 🛫 Flight Itinerary (booking-level flight link) ──
    // fi dari tabFlight (booking.flight). Slot mewarisi flight sama, jadi
    // biasanya satu flight per booking. Hanya papar jika wujud PNR.
    if (fi && fi.pnr) {
      var fiDepDate = fi.departure_date ? fmtDate(fi.departure_date) : '';
      var fiArrDate = fi.arrival_date ? fmtDate(fi.arrival_date) : '';
      // Airport cell: code (bold) + name (small muted)
      var fiAirport = function(code, name) {
        if (!code && !name) return '<span style="color:var(--text-muted);">—</span>';
        var h = '';
        if (code) h += '<div style="font-size:16px;font-weight:700;color:var(--text-primary);">' + _esc(code) + '</div>';
        if (name) h += '<div style="font-size:11px;font-weight:400;color:var(--text-muted);margin-top:2px;">' + _esc(name) + '</div>';
        return h || '<span style="color:var(--text-muted);">—</span>';
      };
      // Airline cell: name + flight class (small subtitle)
      var fiAirline = '—';
      if (fi.airline) {
        fiAirline = _esc(fi.airline);
        if (fi.flight_class) fiAirline += '<div style="font-size:11px;font-weight:400;color:var(--text-muted);margin-top:2px;">' + _esc(fi.flight_class) + '</div>';
      }
      html += '<div class="tv-sec">🛫 Flight Itinerary</div>';
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
    }

    html += '</div>'; // hero

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
        html += '<a href="/traveller/travellers?ref=' + encodeURIComponent(ref) + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;">Manage Travellers →</a>';
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
      var addonUrl  = '/traveller/booking_addons?booking=' + encodeURIComponent(ref);
      var manageUrl = '/traveller/manage_addon?ref=' + encodeURIComponent(ref);

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
