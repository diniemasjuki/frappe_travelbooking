/* ============================================================
   travel_booking/public/js/traveller_detail.js
   Booking detail page — Main Info, Payment Summary, Traveller Summary.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var BOOKING_REF = _pageData.booking_ref || '';

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
        wireCollapsibles();
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML =
          '<div class="tv-card tv-text-center" style="padding:40px;">' +
          '<p style="color:var(--c-danger-text);">' + _esc(e.message || 'Failed to load booking.') + '</p>' +
          '<a href="/traveller/bookings" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:16px;">← Back</a>' +
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

    // Financials
    var grandTotal = parseFloat(so.grand_total) || 0;
    var advancePaid = parseFloat(so.advance_paid) || 0;
    var balance = grandTotal - advancePaid;
    var payPct = grandTotal > 0 ? Math.round((advancePaid / grandTotal) * 100) : 0;
    var isPaid = balance <= 0;

    // Traveller stats
    var totalSlots = parseInt(b.total_slots) || slots.length;
    var filledCount = parseInt(b.filled_count) || 0;
    var verifiedCount = parseInt(b.verified_count) || 0;
    var docPct = filledCount > 0 ? Math.round((verifiedCount / filledCount) * 100) : 0;
    var cabinCount = cabins.length || Math.ceil(filledCount / 2);

    var html = '';

    /* Page nav: Back (top) */
    html += '<div style="margin-bottom:20px;">';
    html += '<a href="/traveller/bookings" class="tv-btn tv-btn--ghost tv-btn--sm">← Back to My Bookings</a>';
    html += '</div>';

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
       SECTION B: PAYMENT SUMMARY (Collapsible)
       Header: title + progress bar (always visible)
       Body: stats + bill orders (collapsible)
       ══════════════════════════════════════ */
    html += '<div class="tv-card tv-animate-in">';
    // Header (always visible): title + progress bar
    html += '<div class="tv-collapse-header" data-toggle="payment-summary" style="cursor:pointer;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    html += '<h3 class="tv-card__title">💰 Payment Summary</h3>';
    html += '<button type="button" class="tv-btn tv-btn--ghost tv-btn--sm tv-collapse-toggle" style="flex-shrink:0;">Open</button>';
    html += '</div>';
    // Summary line (replaces stats grid) — always visible, left aligned
    html += '<div style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:8px;">Total Billed: ' + fmtDual(grandTotal) + ' · Balance Due: ' + fmtDual(balance) + '</div>';
    // Progress bar
    html += '<div class="tv-progress" role="progressbar" aria-valuenow="' + payPct + '" aria-valuemin="0" aria-valuemax="100" style="margin-top:12px;">';
    html += '<div class="tv-progress__fill' + (isPaid ? ' done' : '') + '" style="width:' + payPct + '%"></div>';
    html += '</div>';
    var progressLabel = isPaid
      ? '<span class="tv-progress-label--success">✓ Paid in full — thank you!</span>'
      : '<span class="tv-progress-label">' + fmtDual(balance) + ' remaining to settle</span>';
    html += '<div class="tv-progress-label" style="justify-content:flex-end;margin-bottom:0;">' + progressLabel + '</div>';
    html += '</div>'; // header

    // Body (collapsible): bill orders list
    html += '<div class="tv-collapse-body" id="payment-summary-body" style="display:none;padding-top:16px;">';

    // Bill Orders list
    var soList = (data.payment && data.payment.so_list) || [];
    html += '<div class="tv-sec">Bill Orders</div>';

    if (soList.length > 0) {
      soList.forEach(function (sso) {
        var soName = _esc(sso.name || '');
        var soAmt = parseFloat(sso.grand_total) || 0;
        var soPaid = parseFloat(sso.advance_paid) || 0;
        var soBal = soAmt - soPaid;
        // Compute payment status (not SO status)
        var payStatus, payCls;
        if (soBal <= 0) { payStatus = 'Paid'; payCls = 'success'; }
        else if (soPaid > 0) { payStatus = 'Partially Paid'; payCls = 'warning'; }
        else { payStatus = 'Unpaid'; payCls = 'neutral'; }
        var soBillingUrl = '/traveller/billing?ref=' + encodeURIComponent(ref) + '&bill=' + encodeURIComponent(sso.name);

        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-light);">';
        // Left: SO name + payment status + amount
        html += '<div style="min-width:0;flex:1;">';
        html += '<div style="font-family:\'SF Mono\',Monaco,monospace;font-size:13px;font-weight:600;color:var(--text-primary);">' + soName + '</div>';
        html += '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">';
        html += '<span class="tv-badge tv-badge--' + payCls + '">' + payStatus + '</span> · ' + fmtDual(soAmt);
        html += '</div>';
        html += '</div>';
        // Right: Manage button
        html += '<a href="' + soBillingUrl + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;">Manage →</a>';
        html += '</div>';
      });
    } else {
      html += '<p style="font-size:13px;color:var(--text-muted);padding:12px 0;">No bill orders found.</p>';
    }

    html += '</div>'; // collapse body

    html += '</div>'; // payment card

    /* ══════════════════════════════════════
       SECTION C: TRAVELLER SUMMARY (compact)
       Header: title + small summary string + Manage button
       ══════════════════════════════════════ */
    var roomLabel = isCruise ? 'Cabin' : 'Room';

    html += '<div class="tv-card tv-animate-in">';
    // Header: title + summary string (left) + Manage button (right)
    html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">';
    html += '<div>';
    html += '<h3 class="tv-card__title" style="margin:0;">👥 Traveller Summary</h3>';
    html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">' + cabinCount + ' ' + roomLabel.toLowerCase() + '(s) · ' + filledCount + '/' + totalSlots + ' travellers · ' + docPct + '% completed</div>';
    html += '</div>';
    html += '<a href="/traveller/travellers?ref=' + encodeURIComponent(ref) + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;margin-left:auto;">Manage Travellers →</a>';
    html += '</div>'; // header row
    html += '</div>'; // traveller card

    /* ══════════════════════════════════════
       SECTION D: ADD-ONS & EXTRAS (Smart Panel)
       - If no existing orders → "Browse Add-ons" link
       - If has orders → "Manage Add-ons" link + summary
       ══════════════════════════════════════ */
    var addonOrders = (data.addon_orders || []);
    var hasAddonOrders = addonOrders.length > 0;
    var addonUrl  = '/traveller/booking_addons?booking=' + encodeURIComponent(ref);
    var manageUrl = '/traveller/manage_addon?ref=' + encodeURIComponent(ref);

    html += '<div class="tv-card tv-animate-in">';
    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">';
    html += '<div>';
    html += '<h3 class="tv-card__title" style="margin:0;">🎁 Add-ons & Extras</h3>';

    if (!hasAddonOrders) {
      // No orders yet → encourage browsing
      html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Enhance your trip with optional activities, upgrades & more</div>';
    } else {
      // Has orders → show summary
      var totalAddonOrders = addonOrders.length;
      var totalAddonAmount = 0;
      addonOrders.forEach(function(o) { totalAddonAmount += parseFloat(o.total_amount) || 0; });
      html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">';
      html += totalAddonOrders + ' order(s) · Total: ' + fmtDual(totalAddonAmount);
      html += '</div>';
    }

    html += '</div>';
    // CTA Button — Browse (no orders) or Manage (has orders)
    var btnUrl = hasAddonOrders ? manageUrl : addonUrl;
    html += '<a href="' + btnUrl + '" class="tv-btn tv-btn--primary tv-btn--sm" style="text-decoration:none;white-space:nowrap;margin-left:auto;">';
    html += hasAddonOrders ? 'Manage Addon →' : 'Browse Addon →';
    html += '</a>';
    html += '</div>'; // header row
    html += '</div>'; // addons card

    /* Page nav: Back (bottom) */
    html += '<div style="margin-top:24px;">';
    html += '<a href="/traveller/bookings" class="tv-btn tv-btn--ghost tv-btn--sm">← Back to My Bookings</a>';
    html += '</div>';

    return html;
  }

  /* ── Wire collapsible card headers ──
     Convention: header has data-toggle="key", body has id="key-body".
     Toggle button (.tv-collapse-toggle) shows Open/Hide. */
  function wireCollapsibles() {
    var headers = document.querySelectorAll('[data-toggle]');
    for (var i = 0; i < headers.length; i++) {
      (function (header) {
        var key    = header.getAttribute('data-toggle');
        var body   = document.getElementById(key + '-body');
        var toggle = header.querySelector('.tv-collapse-toggle');
        if (!body) return;

        function setLabel(collapsed) {
          if (toggle) toggle.textContent = collapsed ? 'Open' : 'Hide';
        }

        /* Sync initial collapsed state */
        var collapsed = body.style.display === 'none' || !body.style.display;
        body.style.display = collapsed ? 'none' : 'block';
        setLabel(collapsed);

        header.addEventListener('click', function () {
          var hidden = body.style.display === 'none';
          body.style.display = hidden ? 'block' : 'none';
          setLabel(!hidden);
        });
      })(headers[i]);
    }
  }

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
