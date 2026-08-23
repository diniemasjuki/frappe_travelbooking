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

    // ── INFO GRID: 3 columns per row ──
    html += '<div class="tv-hero-grid">';

    // Row 1: Departure Date | Return Date | Fly From
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Departure Date</div><div class="tv-hero-value">' + (depDate || '—') + '</div></div>';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Return Date</div><div class="tv-hero-value">' + (retDate || '—') + '</div></div>';
    // Fly From: Airport Code (bold big) + Airport Name (small muted)
    var flyFromHtml = '<span style="color:var(--text-muted);">—</span>';
    if (!cruiseOnly && packageType !== 'Ground Only' && (airportCode || airportCity)) {
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

    // Row 2 (cruise only): Sailing Start | Sailing End | Ship
    if (isCruise) {
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Sailing Start</div><div class="tv-hero-value">' + (sailingStart || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Sailing End</div><div class="tv-hero-value">' + (sailingEnd || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Ship</div><div class="tv-hero-value">' + (shipName || '—') + '</div></div>';
    }

    // Row 3: Embarkation Port | Disembarkation Port
    if (isCruise) {
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Embarkation Port</div><div class="tv-hero-value">' + (embarkPort || '—') + '</div></div>';
      html += '<div class="tv-hero-cell"><div class="tv-hero-label">Disembarkation Port</div><div class="tv-hero-value">' + (disembarkPort || '—') + '</div></div>';
    }

    html += '</div>'; // grid

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
    html += '<span class="tv-collapse-arrow" style="font-size:18px;color:var(--text-muted);transition:transform .2s;">▾</span>';
    html += '</div>';
    // Progress bar
    html += '<div class="tv-progress" role="progressbar" aria-valuenow="' + payPct + '" aria-valuemin="0" aria-valuemax="100" style="margin-top:12px;">';
    html += '<div class="tv-progress__fill' + (isPaid ? ' done' : '') + '" style="width:' + payPct + '%"></div>';
    html += '</div>';
    var progressLabel = isPaid
      ? '<span class="tv-progress-label--success">✓ Paid in full — thank you!</span>'
      : '<span class="tv-progress-label">' + fmtDual(balance) + ' remaining to settle</span>';
    html += '<div class="tv-progress-label" style="justify-content:center;margin-bottom:0;">' + progressLabel + '</div>';
    html += '</div>'; // header

    // Body (collapsible)
    html += '<div class="tv-collapse-body" id="payment-summary-body" style="display:none;padding-top:16px;">';

    // Stats row
    html += '<div class="tv-stats">';
    html += '<div class="tv-stat"><div class="tv-stat__value">' + fmtDual(grandTotal) + '</div><div class="tv-stat__label">Total Billed</div></div>';
    html += '<div class="tv-stat"><div class="tv-stat__value tv-bk-fin-value--success">' + fmtDual(advancePaid) + '</div><div class="tv-stat__label">Total Paid</div></div>';
    html += '<div class="tv-stat"><div class="tv-stat__value ' + (isPaid ? 'tv-bk-fin-value--success' : 'tv-bk-fin-value--warning') + '">' + fmtDual(balance) + '</div><div class="tv-stat__label">Balance Due</div></div>';
    html += '</div>'; // stats

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
       SECTION C: TRAVELLER SUMMARY (Collapsible)
       Header: title + 3-col stats + Manage button (always visible)
       Body: cabin/room overview preview (collapsible)
       ══════════════════════════════════════ */
    var roomLabel = isCruise ? 'Cabin' : 'Room';

    html += '<div class="tv-card tv-animate-in">';
    // Header (always visible): title + 3-col grid + button
    html += '<div class="tv-collapse-header" data-toggle="traveller-summary" style="cursor:pointer;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
    html += '<h3 class="tv-card__title" style="margin:0;">👥 Traveller Summary</h3>';
    html += '<span class="tv-collapse-arrow" style="font-size:18px;color:var(--text-muted);transition:transform .2s;">▾</span>';
    html += '</div>';

    // 3-column stats grid
    html += '<div class="tv-hero-grid" style="margin-bottom:16px;">';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">' + roomLabel + 's</div><div class="tv-hero-value">' + cabinCount + '</div></div>';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Travellers</div><div class="tv-hero-value">' + filledCount + ' / ' + totalSlots + '</div></div>';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Completions</div><div class="tv-hero-value">' + docPct + '% (' + verifiedCount + '/' + filledCount + ')</div></div>';
    html += '</div>'; // grid

    // Manage button
    html += '<a href="/traveller/travellers?ref=' + encodeURIComponent(ref) + '" class="tv-btn tv-btn--primary tv-btn--sm" style="width:100%;text-decoration:none;" onclick="event.stopPropagation();">';
    html += 'Manage Travellers →';
    html += '</a>';
    html += '</div>'; // header

    // Body (collapsible): cabin/room overview
    html += '<div class="tv-collapse-body" id="traveller-summary-body" style="display:none;padding-top:16px;margin-top:16px;">';

    if (cabins.length > 0) {
      html += '<div class="tv-sec">' + roomLabel + ' Overview</div>';
      cabins.forEach(function (cabin) {
        var cabinLabel = _esc(cabin.cabin_assignment || cabin.room_name || roomLabel);
        var cabinSlots = cabin.slots || [];

        html += '<div class="tv-cabin">';
        html += '<div class="tv-cabin__header">';
        html += '<span>' + cabinLabel + '</span>';
        html += '<span style="font-size:12px;color:var(--text-muted);">' + cabinSlots.length + ' slot(s)</span>';
        html += '</div>';
        html += '<div class="tv-cabin__body">';

        cabinSlots.forEach(function (slot) {
          var slotName = _esc(slot.slot_label || slot.pax_type || 'Slot');
          var isFilled = slot.filled || slot.traveller_id;
          var isVerified = slot.is_verified || slot.document_status === 'Verified';
          var travellerName = isFilled ? (_esc(slot.full_name || (slot.first_name || '') + ' ' + (slot.last_name || ''))) : '';
          var statusCls = isVerified ? 'verified' : (isFilled ? 'pending' : 'empty');

          html += '<div class="tv-slot-item">';
          html += '<div class="tv-slot-status tv-slot-status--' + statusCls + '"></div>';
          html += '<div class="tv-slot-name">';
          if (travellerName) {
            html += travellerName;
            html += '<div class="tv-slot-type">' + slotName + (isVerified ? ' ✓' : '') + '</div>';
          } else {
            html += '<span style="color:var(--text-muted);">' + slotName + '</span>';
            html += '<div class="tv-slot-type">Empty</div>';
          }
          html += '</div>'; // name
          html += '</div>'; // slot-item
        });

        html += '</div>'; // body
        html += '</div>'; // cabin
      });
    } else {
      html += '<p style="font-size:13px;color:var(--text-muted);padding:12px 0;">No ' + roomLabel.toLowerCase() + ' assignments found.</p>';
    }

    html += '</div>'; // collapse body
    html += '</div>'; // traveller card

    /* Back button */
    html += '<div style="margin-top:24px;text-align:center;">';
    html += '<a href="/traveller/bookings" class="tv-btn-link">← Back to My Bookings</a>';
    html += '</div>';

    return html;
  }

  /* ── Wire collapsible card headers ──
     Convention: header has data-toggle="key", body has id="key-body".
     Arrow (.tv-collapse-arrow) rotates -90deg when collapsed. */
  function wireCollapsibles() {
    var headers = document.querySelectorAll('[data-toggle]');
    for (var i = 0; i < headers.length; i++) {
      (function (header) {
        var key   = header.getAttribute('data-toggle');
        var body  = document.getElementById(key + '-body');
        var arrow = header.querySelector('.tv-collapse-arrow');
        if (!body) return;

        /* Sync initial collapsed state */
        var collapsed = body.style.display === 'none' || !body.style.display;
        body.style.display = collapsed ? 'none' : 'block';
        if (arrow) arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';

        header.addEventListener('click', function () {
          var hidden = body.style.display === 'none';
          body.style.display = hidden ? 'block' : 'none';
          if (arrow) arrow.style.transform = hidden ? '' : 'rotate(-90deg)';
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
