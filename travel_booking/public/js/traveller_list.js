/* ============================================================
   travel_booking/public/js/traveller_list.js
   Bookings list rendering — grouping (Upcoming / Future / Past),
   carian & penapis (client-side) + pagination SELURUH senarai:
   setiap halaman dihadkan kepada `perPage` baris merentas kumpulan
   (susunan paparan: Upcoming → Future → Past) supaya senarai panjang
   tidak dirender sekali gus.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  /* ── Semua booking dimuatkan sekali — penapis & pagination di browser ── */
  var ALL_BOOKINGS = [];
  var currentPage = 1;
  var perPage = 10;
  var FILTER_DEBOUNCE = null;
  var FILTER_IDS = ['bk-f-status', 'bk-f-payment', 'bk-f-trip'];

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
        ALL_BOOKINGS = bookings;
        // Keutamaan bilangan baris per halaman kekal antara sesi (corak
        // sama dengan page transactions).
        perPage = parseInt(localStorage.getItem('tv_bk_per_page'), 10) || 10;
        setupFilters(bookings);
        renderFiltered();
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

  /* ── Carian & penapis (client-side) ──
     Corak sama dengan onbehalf_list.js — carian merangkumi trip,
     package, group dan no. rujukan. */
  function uniqueSorted(vals) {
    var seen = {}, out = [];
    vals.forEach(function (v) {
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    });
    return out.sort(function (a, b) { return String(a).localeCompare(String(b)); });
  }

  function fillSelect(id, options, allLabel) {
    var sel = document.getElementById(id);
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '<option value="">' + _esc(allLabel) + '</option>' +
      options.map(function (o) {
        return '<option value="' + _esc(o) + '">' + _esc(o) + '</option>';
      }).join('');
    if (current && options.indexOf(current) !== -1) sel.value = current;
  }

  function clearFilterInputs() {
    var search = document.getElementById('bk-search');
    if (search) search.value = '';
    FILTER_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  function setupFilters(bookings) {
    var bar = document.getElementById('bookings-filters');
    if (!bar) return;
    if (!bookings.length) { bar.style.display = 'none'; return; }

    fillSelect('bk-f-status', uniqueSorted(bookings.map(function (b) { return b.booking_status; })), 'All Statuses');
    fillSelect('bk-f-payment', uniqueSorted(bookings.map(function (b) { return b.payment_status; })), 'All Payments');
    fillSelect('bk-f-trip', uniqueSorted(bookings.map(function (b) { return b.trip_name; })), 'All Trips');

    var perPageSel = document.getElementById('bk-f-perpage');
    if (perPageSel) perPageSel.value = String(perPage);

    if (!bar.dataset.wired) {
      bar.dataset.wired = '1';
      var search = document.getElementById('bk-search');
      search.addEventListener('input', function () {
        clearTimeout(FILTER_DEBOUNCE);
        FILTER_DEBOUNCE = setTimeout(function () { renderFiltered(true); }, 200);
      });
      FILTER_IDS.forEach(function (id) {
        document.getElementById(id).addEventListener('change', function () {
          renderFiltered(true);
        });
      });
      document.getElementById('bk-f-clear').addEventListener('click', function () {
        clearFilterInputs();
        renderFiltered(true);
      });
      if (perPageSel) {
        perPageSel.addEventListener('change', function () {
          perPage = parseInt(this.value, 10) || 10;
          localStorage.setItem('tv_bk_per_page', String(perPage));
          renderFiltered(true);
        });
      }
    }
    bar.style.display = 'flex';
  }

  function applyFilters(bookings) {
    var searchEl = document.getElementById('bk-search');
    var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
    function selVal(id) {
      var el = document.getElementById(id);
      return el ? el.value : '';
    }
    var fStatus = selVal('bk-f-status');
    var fPayment = selVal('bk-f-payment');
    var fTrip = selVal('bk-f-trip');

    return bookings.filter(function (b) {
      if (fStatus && (b.booking_status || '') !== fStatus) return false;
      if (fPayment && (b.payment_status || '') !== fPayment) return false;
      if (fTrip && (b.trip_name || '') !== fTrip) return false;
      if (q) {
        var hay = [b.trip_name, b.package_title, b.group_name, b.booking_number, b.name]
          .join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderFiltered(resetPage) {
    if (resetPage) currentPage = 1;
    var content = document.getElementById('bookings-content');
    if (!content) return;
    content.style.display = 'block';

    var list = applyFilters(ALL_BOOKINGS);
    var g = groupBookings(list);

    // Susunan mendatar seluruh senarai: Upcoming → Future (asc) → Past.
    // Pagination menghadkan bilangan baris SETIAP halaman merentas
    // kumpulan — bukan setiap kumpulan berasingan — supaya halaman
    // kekal pendek tanpa mengira kumpulan mana yang besar.
    var flat = (g.upcoming ? [g.upcoming] : []).concat(g.future, g.past);
    var total = flat.length;

    var totalPages = Math.max(1, Math.ceil(total / perPage));
    if (currentPage > totalPages) currentPage = totalPages;
    var startIdx = (currentPage - 1) * perPage;
    var endIdx = Math.min(startIdx + perPage, total);

    // Kerat setiap kumpulan mengikut julat halaman semasa
    function grpSlice(gs, ge) {
      var s = Math.max(startIdx, gs), e = Math.min(endIdx, ge);
      return s < e ? flat.slice(s - gs, e - gs) : [];
    }
    var uLen = g.upcoming ? 1 : 0;
    var parts = {
      upcoming: grpSlice(0, uLen),
      future: grpSlice(uLen, uLen + g.future.length),
      past: grpSlice(uLen + g.future.length, total),
      futureTotal: g.future.length,
      pastTotal: g.past.length
    };

    // Kiraan julat baris halaman semasa — nampak had pagination & penapis
    var count = document.getElementById('bookings-count');
    if (count) {
      count.style.display = 'block';
      count.textContent = 'Showing ' + (total ? (startIdx + 1) + '–' + endIdx : 0)
        + ' of ' + total + ' booking' + (total === 1 ? '' : 's')
        + (list.length !== ALL_BOOKINGS.length ? ' (filtered from ' + ALL_BOOKINGS.length + ')' : '');
    }

    if (!list.length) {
      // Pager di luar content — sembunyikan supaya tiada keadaan lama tertinggal
      var pg = document.getElementById('bookings-pagination');
      if (pg) { pg.style.display = 'none'; pg.innerHTML = ''; }
      content.innerHTML =
        '<div class="tv-bk-nomatch">' +
        '<div class="tv-bk-nomatch__icon">🔍</div>' +
        '<p style="margin:0 0 14px 0;">No bookings match your search or filters.</p>' +
        '<button type="button" class="tv-btn tv-btn--ghost tv-btn--sm" id="bk-f-clear2">Clear Filters</button>' +
        '</div>';
      var btn = document.getElementById('bk-f-clear2');
      if (btn) btn.addEventListener('click', function () {
        clearFilterInputs();
        renderFiltered(true);
      });
      return;
    }

    // Keadaan <details> Past Trips dikekalkan semasa re-render pagination
    var pastDetails = document.getElementById('bk-past-details');
    var pastWasOpen = !!(pastDetails && pastDetails.open);

    content.innerHTML = renderBookings(parts);

    var newDetails = document.getElementById('bk-past-details');
    if (newDetails) newDetails.open = pastWasOpen;

    // Pager global bawah senarai — muncul bila jumlah baris > 1 halaman
    tvRenderPager(document.getElementById('bookings-pagination'), currentPage, totalPages, total, 'bookings', function (p) {
      currentPage = p;
      renderFiltered(false);
      content.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ── Render all groups (halaman semasa sahaja) ──
     Header kumpulan muncul hanya bila kumpulan itu ada baris pada
     halaman ini; label kekal memaparkan JUMLAH penuh kumpulan supaya
     pengguna tahu ada lagi di halaman lain. */
  function renderBookings(parts) {
    var html = '';

    // Upcoming Trip (highlighted)
    if (parts.upcoming.length) {
      html += '<div class="tv-group-label">⭐ Upcoming Trip</div>';
      html += bookingCard(parts.upcoming[0], true);
    }

    // Future Trips
    if (parts.future.length) {
      html += '<div class="tv-group-label">📅 Future Trips (' + parts.futureTotal + ')</div>';
      html += '<div class="tv-stagger">';
      parts.future.forEach(function (b) {
        html += bookingCard(b, false);
      });
      html += '</div>';
    }

    // Past Trips (collapsible)
    if (parts.past.length) {
      html += '<div class="tv-past-summary tv-animate-in">';
      html += '<details id="bk-past-details"><summary>📦 Past Trips (' + parts.pastTotal + ')</summary>';
      html += '<div class="tv-past-list">';
      parts.past.forEach(function (b) {
        html += bookingCard(b, false, true);
      });
      html += '</div>';
      html += '</details></div>';
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

      // Flight block (bukan cruise-only) — sumber kini SLOT:
      // senarai flight distinct booking (Booking Reservation.flight),
      // satu seksyen setiap flight (group boleh berpecah flight).
      var fls = b.flights || [];
      fls.forEach(function(fl) {
        var hasFlight = fl.airline || fl.pnr || fl.from_code || fl.to_code;
        if (!hasFlight) return;
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
      });
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
