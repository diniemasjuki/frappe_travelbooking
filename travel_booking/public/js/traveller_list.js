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

  /* ── Tarikh efektif perjalanan: departure dulu, fallback sailing ──
     Cruise-only kadang tiada departure_date — guna sailing_start/end
     (selari dengan onbehalf_list.js). */
  function tripStart(b) {
    return b.departure_date || b.sailing_start || b.sailing_end || '';
  }
  function tripEnd(b) {
    return b.return_date || b.sailing_end || tripStart(b);
  }

  /* ── Group bookings into Upcoming / Future / Past ── */
  function groupBookings(bookings) {
    var now = new Date();
    now.setHours(0,0,0,0);

    // Filter out cancelled for upcoming/future
    var active = bookings.filter(function (b) {
      return b.booking_status !== 'Cancelled' && tripStart(b);
    });

    // Sort by departure date ascending
    active.sort(function (a, b) {
      return new Date(tripStart(a)) - new Date(tripStart(b));
    });

    var upcoming = null;  // max 1 — closest future trip
    var future = [];      // remaining active trips
    var past = [];        // past or cancelled

    active.forEach(function (b) {
      var depDate = new Date(tripStart(b) + 'T00:00:00');
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

  /* ── Single Booking Card ──
     Struktur kad (atas → bawah):
       1. Hero       : Trip Name (tajuk) + Subtitle 1 = Trip Group Date Name,
                       Subtitle 2 = Trip Package Name | REF + countdown
       2. Trip info  : ikut jenis trip —
                       cruise-only  → cruise info sahaja
                       bukan cruise → departure/return + flight info
                       cruise lain  → kedua-duanya
       3. Fin row    : status · travellers · billed · paid · balance · pay
  */
  function bookingCard(b, isHighlight, isPast) {
    var ref = _esc(b.booking_number || b.name || '');
    var tripName = _esc(b.trip_name || 'Unnamed Trip');
    var status = _esc(b.booking_status || 'Pending');
    var payStatus = _esc(b.payment_status || 'Pending');
    // B2B: tempahan partner bagi pihak customer ini — TIADA angka kewangan
    // (server dah menapis billed/paid/balance = null).
    var priceHidden = !!b.price_hidden;

    var pkg = _esc(b.package_title || '');
    var group = _esc(b.group_name || '');
    var cat = _esc(b.trip_category || '');
    var isCruise = !!b.is_cruise;
    var cruiseOnly = isCruise && !!b.cruise_only;

    var totalSlots = parseInt(b.total_slots) || 0;
    var filledCount = parseInt(b.filled_count) || 0;
    var verifiedCount = parseInt(b.verified_count) || 0;

    var billed = parseFloat(b.billed) || 0;
    var paid = parseFloat(b.paid) || 0;
    var balance = parseFloat(b.balance) || 0;
    // Currency booking (dari SO utama) — jumlah kad ikut currency ni
    var sym = curSym(b);

    var docPct = filledCount > 0 ? Math.round((verifiedCount / filledCount) * 100) : 0;

    // Countdown
    var countdownHtml = '';
    if (!isPast && tripStart(b)) {
      var cd = getCountdown(tripStart(b));
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

    // ── 1. Hero: Trip Name + subtitles | REF + countdown ──
    html += '<div class="tv-bk-card__hero">';
    html += '<div class="tv-bk-card__hero-left">';
    if (cat) {
      var ico = /cruise/i.test(cat) ? '🚢' : (/fly/i.test(cat) ? '✈️' : '🧭');
      html += '<span class="tv-bk-cat">' + ico + ' ' + cat + '</span>';
    }
    html += '<div class="tv-bk-card__name">' + tripName;
    if (status === 'Cancelled') html += ' 🔒';
    html += '</div>';
    if (group) {
      html += '<div class="tv-bk-card__sub tv-bk-card__sub--group">' + group + '</div>';
    }
    if (pkg) {
      html += '<div class="tv-bk-card__sub tv-bk-card__sub--pkg">' + pkg + '</div>';
    }
    html += '</div>'; // hero-left
    html += '<div class="tv-bk-card__side">';
    html += '<span class="tv-bk-card__ref"><span class="tv-bk-card__ref-tag">REF</span>' + ref + '</span>';
    if (countdownHtml) html += countdownHtml;
    html += '</div>'; // side col
    html += '</div>'; // hero

    // Duration text
    var durTxt = '';
    var dDays = parseInt(b.total_days) || 0;
    var dNights = parseInt(b.total_nights) || 0;
    if (dDays > 0 && dNights > 0) durTxt = dDays + 'D ' + dNights + 'N';
    else if (dDays > 0) durTxt = dDays + (dDays > 1 ? ' Days' : ' Day');
    else if (dNights > 0) durTxt = dNights + (dNights > 1 ? ' Nights' : ' Night');

    // ── 2a. Departure/return facts — BUKAN cruise-only sahaja ──
    if (!cruiseOnly) {
      html += '<div class="tv-bk-facts">';
      var startD = tripStart(b), endD = tripEnd(b);
      html += '<div class="tv-bk-fact"><div class="tv-bk-fact__label">Departure</div>'
        + '<div class="tv-bk-fact__value">' + (startD ? fmtDate(startD) : '—') + '</div></div>';
      html += '<div class="tv-bk-fact"><div class="tv-bk-fact__label">Return</div>'
        + '<div class="tv-bk-fact__value">' + (endD ? fmtDate(endD) : '—') + '</div></div>';
      html += '<div class="tv-bk-fact"><div class="tv-bk-fact__label">Duration</div>'
        + '<div class="tv-bk-fact__value">' + (durTxt ? _esc(durTxt) : '—') + '</div></div>';
      html += '</div>';

      // Flight block (bukan cruise-only, jika ada flight arrangement)
      var fl = b.flight || {};
      var hasFlight = fl.airline || fl.pnr || fl.from_code || fl.to_code;
      if (hasFlight) {
        var flHead = '✈️ Flight';
        if (fl.airline) flHead += ' — ' + _esc(fl.airline);
        if (fl.pnr) flHead += ' <span class="tv-bk-card__info-sep">·</span> PNR <span class="tv-bk-pnr">' + _esc(fl.pnr) + '</span>';
        html += '<div class="tv-bk-sec tv-bk-sec--flight">';
        html += '<div class="tv-bk-sec__head">' + flHead + '</div>';
        var flBits = [];
        if (fl.from_code && fl.to_code && fl.from_code !== fl.to_code) {
          flBits.push(_esc(fl.from_code) + ' <span class="tv-bk-card__info-arrow">→</span> ' + _esc(fl.to_code));
        } else if (fl.from_city || fl.to_city) {
          flBits.push(_esc(fl.from_city || '') + (fl.to_city ? ' <span class="tv-bk-card__info-arrow">→</span> ' + _esc(fl.to_city) : ''));
        }
        if (fl.dep_date) flBits.push('Dep ' + fmtDate(fl.dep_date));
        if (fl.ret_arrival_date) flBits.push('Return arr. ' + fmtDate(fl.ret_arrival_date));
        if (fl.flight_class) flBits.push(_esc(fl.flight_class));
        if (flBits.length) {
          html += '<div class="tv-bk-sec__line">' + flBits.join(' <span class="tv-bk-card__info-sep">·</span> ') + '</div>';
        }
        html += '</div>';
      }
    }

    // ── 2b. Cruise block — jika trip cruise (cruise-only: cruise SAHAJA) ──
    if (isCruise) {
      var ship = _esc(b.ship_name || '');
      var embark = _esc(b.embarkation_port || '');
      var disembark = _esc(b.disembarkation_port || '');
      var sailOn = b.sailing_start ? fmtDate(b.sailing_start) : '';
      var sailOff = (b.sailing_end && b.sailing_end !== b.sailing_start)
        ? fmtDate(b.sailing_end) : '';
      var crHead = '🚢 Cruise';
      if (ship) crHead += ' — ' + ship;
      html += '<div class="tv-bk-sec tv-bk-sec--cruise">';
      html += '<div class="tv-bk-sec__head">' + crHead + '</div>';
      var crBits = [];
      if (sailOn) {
        var s = 'Sailing ' + sailOn;
        if (sailOff) s += ' – ' + sailOff;
        crBits.push(s);
      }
      // cruise-only: facts strip tersembunyi — duration dipindah ke sini
      if (cruiseOnly && durTxt) crBits.push(_esc(durTxt));
      if (embark && disembark && disembark !== embark) {
        crBits.push(embark + ' <span class="tv-bk-card__info-arrow">→</span> ' + disembark);
      } else if (embark || disembark) {
        crBits.push(embark || disembark);
      }
      if (crBits.length) {
        html += '<div class="tv-bk-sec__line">' + crBits.join(' <span class="tv-bk-card__info-sep">·</span> ') + '</div>';
      }
      html += '</div>';
    }

    // ── 3. Doc-readiness badge (shown only when travellers exist) ──
    if (filledCount > 0) {
      var docCls = docPct >= 100 ? 'success' : (docPct > 0 ? 'warning' : 'neutral');
      html += '<div class="tv-bk-card__badges"><span class="tv-badge tv-badge--' + docCls + '">' + docPct + '% Docs</span></div>';
    }

    // ── Summary grid: Booking · Travellers · Billed · Paid · Balance · Payment ──
    html += '<div class="tv-bk-card__fin-row">';
    html += '<div class="tv-bk-fin-item tv-bk-fin-item--badge">';
    html += '<div class="tv-bk-fin-label">Booking</div>';
    html += statusBadge(status, 'booking');
    html += '</div>';
    html += '<div class="tv-bk-fin-item">';
    html += '<div class="tv-bk-fin-label">Travellers</div>';
    html += '<div class="tv-bk-fin-value">' + filledCount + '/' + totalSlots + '</div>';
    html += '</div>';
    if (priceHidden) {
      // B2B — billing diuruskan agen; hanya badge status umum.
      html += '<div class="tv-bk-fin-item">';
      html += '<div class="tv-bk-fin-label">Billing</div>';
      html += '<div class="tv-bk-fin-value" style="font-size:12px;color:var(--text-muted);">Via your agent</div>';
      html += '</div>';
    } else {
      html += '<div class="tv-bk-fin-item">';
      html += '<div class="tv-bk-fin-label">Total Billed</div>';
      html += '<div class="tv-bk-fin-value">' + fmtDual(billed, sym) + '</div>';
      html += '</div>';
      html += '<div class="tv-bk-fin-item">';
      html += '<div class="tv-bk-fin-label">Total Paid</div>';
      html += '<div class="tv-bk-fin-value tv-bk-fin-value--success">' + fmtDual(paid, sym) + '</div>';
      html += '</div>';
      html += '<div class="tv-bk-fin-item">';
      html += '<div class="tv-bk-fin-label">Balance Due</div>';
      var balCls = balance <= 0 ? 'tv-bk-fin-value--success' : 'tv-bk-fin-value--warning';
      html += '<div class="tv-bk-fin-value ' + balCls + '">' + fmtDual(balance, sym) + '</div>';
      html += '</div>';
      html += '<div class="tv-bk-fin-item tv-bk-fin-item--badge">';
      html += '<div class="tv-bk-fin-label">Payment</div>';
      html += statusBadge(payStatus, 'payment');
      html += '</div>';
    }
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
