/* ============================================================
   travel_booking/public/js/traveller_list.js
   Bookings list rendering — grouping (Upcoming / Future / Past).
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  /* ── Init: verify session then load bookings ── */
  async function init() {
    try {
      await ensureSession();
      renderNav();
      await loadBookings();
    } catch (e) {
      console.error('Failed to load bookings:', e);
    }
  }

  async function loadBookings() {
    var loading = document.getElementById('bookings-loading');
    var content = document.getElementById('bookings-content');
    var empty = document.getElementById('bookings-empty');

    try {
      var data = await API_BK('get_bookings_list', {});
      var bookings = data.bookings || [];

      if (loading) loading.style.display = 'none';

      if (!bookings.length) {
        if (empty) empty.style.display = 'block';
        return;
      }

      if (content) {
        content.style.display = 'block';
        content.innerHTML = renderBookings(bookings);
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (empty) {
        empty.style.display = 'block';
        empty.querySelector('.tv-empty__title').textContent = 'Unable to Load Bookings';
        empty.querySelector('.tv-empty__desc').textContent =
          e.message || 'Please check your connection and try again.';
      }
    }
  }

  /* ── Group bookings into Upcoming / Future / Past ── */
  function groupBookings(bookings) {
    var now = new Date();
    now.setHours(0,0,0,0);

    // Filter out cancelled for upcoming/future
    var active = bookings.filter(function (b) {
      return b.booking_status !== 'Cancelled' && b.departure_date;
    });

    // Sort by departure date ascending
    active.sort(function (a, b) {
      return new Date(a.departure_date) - new Date(b.departure_date);
    });

    var upcoming = null;  // max 1 — closest future trip
    var future = [];      // remaining active trips
    var past = [];        // past or cancelled

    active.forEach(function (b) {
      var depDate = new Date(b.departure_date + 'T00:00:00');
      if (!upcoming && depDate > now) {
        upcoming = b;
      } else if (depDate > now) {
        future.push(b);
      } else {
        past.push(b);
      }
    });

    // Add cancelled to past
    bookings.forEach(function (b) {
      if (b.booking_status === 'Cancelled') {
        past.push(b);
      }
    });

    return { upcoming: upcoming, future: future, past: past };
  }

  /* ── Render all groups ── */
  function renderBookings(bookings) {
    var g = groupBookings(bookings);
    var html = '';

    // Upcoming Trip (highlighted)
    if (g.upcoming) {
      html += '<div class="tv-group-label">⭐ Upcoming Trip</div>';
      html += bookingCard(g.upcoming, true);
    }

    // Future Trips
    if (g.future.length > 0) {
      html += '<div class="tv-group-label">📅 Future Trips</div>';
      html += '<div class="tv-stagger">';
      g.future.forEach(function (b) {
        html += bookingCard(b, false);
      });
      html += '</div>';
    }

    // Past Trips (collapsible)
    if (g.past.length > 0) {
      html += '<div class="tv-past-summary tv-animate-in">';
      html += '<details><summary>📦 Past Trips (' + g.past.length + ')</summary>';
      html += '<div class="tv-past-list">';
      g.past.forEach(function (b) {
        html += bookingCard(b, false, true);
      });
      html += '</div></details></div>';
    }

    return html;
  }

  /* ── Single Booking Card ── */
  function bookingCard(b, isHighlight, isPast) {
    var ref = _esc(b.booking_number || b.name || '');
    var tripName = _esc(b.trip_name || 'Unnamed Trip');
    var dates = '';
    if (b.departure_date) {
      dates = fmtDate(b.departure_date);
      if (b.return_date && b.return_date !== b.departure_date) {
        dates += ' – ' + fmtDate(b.return_date);
      }
    }
    var group = _esc(b.group_name || b.sailing_no || '');
    var embark = _esc(b.embarkation_port || '');
    var disembark = _esc(b.disembarkation_port || '');
    var sailOn = b.sailing_start ? fmtDate(b.sailing_start) : '';
    var sailOff = (b.sailing_end && b.sailing_end !== b.sailing_start)
      ? fmtDate(b.sailing_end) : '';
    var status = _esc(b.booking_status || 'Pending');
    var payStatus = _esc(b.payment_status || 'Pending');

    var totalSlots = parseInt(b.total_slots) || 0;
    var filledCount = parseInt(b.filled_count) || 0;
    var verifiedCount = parseInt(b.verified_count) || 0;

    var billed = parseFloat(b.billed) || 0;
    var paid = parseFloat(b.paid) || 0;
    var balance = parseFloat(b.balance) || 0;

    var docPct = filledCount > 0 ? Math.round((verifiedCount / filledCount) * 100) : 0;

    // Countdown
    var countdownHtml = '';
    if (!isPast && b.departure_date) {
      var cd = getCountdown(b.departure_date);
      if (cd) {
        countdownHtml = '<span class="tv-countdown">⏰ ' + _esc(cd) + '</span>';
      }
    }

    // Card classes
    var cardClass = 'tv-card tv-bk-card tv-animate-in';
    if (isHighlight) cardClass += ' tv-card--highlight';
    if (status === 'Cancelled') cardClass += ' tv-card--muted';

    // Click handler
    var href = status === 'Cancelled' ? '#' : '/traveller/booking?ref=' + encodeURIComponent(ref);

    var html = '<a href="' + href + '" class="' + cardClass + '">';

    // Hero row: name + ref + countdown
    html += '<div class="tv-bk-card__hero">';
    html += '<div>';
    html += '<div class="tv-bk-card__name">' + tripName;
    if (status === 'Cancelled') html += ' 🔒';
    html += '</div>';

    // Cruise route + sailing info (small font, after trip name)
    var infoRows = '';
    if (embark) {
      if (disembark && disembark !== embark) {
        infoRows += '<div class="tv-bk-card__info-row"><span class="tv-bk-card__info-k">Departure</span> '
          + embark + ' <span class="tv-bk-card__info-arrow">→</span> <span class="tv-bk-card__info-k">Arrival</span> '
          + disembark + '</div>';
      } else {
        infoRows += '<div class="tv-bk-card__info-row"><span class="tv-bk-card__info-k">Port</span> '
          + embark + '</div>';
      }
    }
    if (sailOn) {
      var sailTxt = '<span class="tv-bk-card__info-k">Sailing On</span> ' + sailOn;
      if (sailOff) sailTxt += ' <span class="tv-bk-card__info-sep">·</span> <span class="tv-bk-card__info-k">Off</span> ' + sailOff;
      infoRows += '<div class="tv-bk-card__info-row">' + sailTxt + '</div>';
    }
    if (infoRows) {
      html += '<div class="tv-bk-card__info">' + infoRows + '</div>';
    }

    html += '<div class="tv-bk-card__meta">';
    if (group) html += '<span>' + group + ' · </span>';
    html += '<span>' + dates + '</span>';
    html += '</div>'; // meta
    html += '</div>'; // left col
    html += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">';
    html += '<span class="tv-bk-card__ref"><span class="tv-bk-card__ref-tag">REF</span>' + ref + '</span>';
    if (countdownHtml) html += countdownHtml;
    html += '</div>'; // right col
    html += '</div>'; // hero

    // Doc-readiness badge (shown only when travellers exist)
    if (filledCount > 0) {
      var docCls = docPct >= 100 ? 'success' : (docPct > 0 ? 'warning' : 'neutral');
      html += '<div class="tv-bk-card__badges"><span class="tv-badge tv-badge--' + docCls + '">' + docPct + '% Docs</span></div>';
    }

    // Summary grid: Booking · Travellers · Billed · Paid · Balance · Payment
    html += '<div class="tv-bk-card__fin-row">';
    html += '<div class="tv-bk-fin-item tv-bk-fin-item--badge">';
    html += '<div class="tv-bk-fin-label">Booking</div>';
    html += statusBadge(status, 'booking');
    html += '</div>';
    html += '<div class="tv-bk-fin-item">';
    html += '<div class="tv-bk-fin-label">Travellers</div>';
    html += '<div class="tv-bk-fin-value">' + filledCount + '/' + totalSlots + '</div>';
    html += '</div>';
    html += '<div class="tv-bk-fin-item">';
    html += '<div class="tv-bk-fin-label">Total Billed</div>';
    html += '<div class="tv-bk-fin-value">' + fmtDual(billed) + '</div>';
    html += '</div>';
    html += '<div class="tv-bk-fin-item">';
    html += '<div class="tv-bk-fin-label">Total Paid</div>';
    html += '<div class="tv-bk-fin-value tv-bk-fin-value--success">' + fmtDual(paid) + '</div>';
    html += '</div>';
    html += '<div class="tv-bk-fin-item">';
    html += '<div class="tv-bk-fin-label">Balance Due</div>';
    var balCls = balance <= 0 ? 'tv-bk-fin-value--success' : 'tv-bk-fin-value--warning';
    html += '<div class="tv-bk-fin-value ' + balCls + '">' + fmtDual(balance) + '</div>';
    html += '</div>';
    html += '<div class="tv-bk-fin-item tv-bk-fin-item--badge">';
    html += '<div class="tv-bk-fin-label">Payment</div>';
    html += statusBadge(payStatus, 'payment');
    html += '</div>';
    html += '</div>'; // fin-row

    html += '</a>'; // card
    return html;
  }

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
