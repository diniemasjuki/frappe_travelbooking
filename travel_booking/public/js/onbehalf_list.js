/* ============================================================
   travel_booking/public/js/onbehalf_list.js
   On-Behalf Bookings list — booking yang user (manager: affiliate /
   sales user) buat BAGI PIHAK customer lain. Page /traveller/onbehalf.

   Perbezaan dari traveller_list.js (My Bookings):
   - Data dari get_on_behalf_bookings_list (booked_by = user,
     booking_channel != Direct).
   - Paparan TABLE (bukan kad): satu .tv-bk-table, baris dikumpul
     Future / Running / Past melalui baris tajuk kumpulan; dalam
     setiap kumpulan susunan ikut tarikh berangkat/sailing.
   - Lajur pertama = CUSTOMER AKHIR (nama + email) — identiti utama
     baris supaya manager tahu serta-merta booking milik siapa.
   - Ref dalam lajur kedua.
   - Baris boleh diklik → /traveller/onbehalf-booking?ref= (page
     onbehalf dgn kawalan tahap akses); baris Cancelled statik.

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
      console.error('Failed to load on-behalf bookings:', e);
    }
  }

  async function loadBookings() {
    var loading = document.getElementById('bookings-loading');
    var content = document.getElementById('bookings-content');
    var empty = document.getElementById('bookings-empty');

    try {
      var data = await API_BK('get_on_behalf_bookings_list', {});
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
        perPage = parseInt(localStorage.getItem('tv_ob_per_page'), 10) || 10;
        setupFilters(bookings);
        renderFiltered(true);
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
     Cruise kadang tiada departure_date — guna sailing_start/end. */
  function tripStart(b) {
    return b.departure_date || b.sailing_start || b.sailing_end || '';
  }
  function tripEnd(b) {
    return b.return_date || b.sailing_end || tripStart(b);
  }

  /* ── Kumpul booking ke Future / Running / Past ──
     Future  : tarikh mula belum sampai.
     Running : sudah berangkat, belum tamat (return/sailing_end >= hari ini).
     Past    : perjalanan selesai; booking Cancelled & tarikh kosong masuk sini. */
  function groupBookings(bookings) {
    var now = new Date();
    now.setHours(0,0,0,0);

    var future = [], running = [], past = [];

    bookings.forEach(function (b) {
      var start = tripStart(b);
      if (b.booking_status === 'Cancelled' || !start) {
        past.push(b);
        return;
      }
      var startDate = new Date(start + 'T00:00:00');
      var endDate = new Date(tripEnd(b) + 'T00:00:00');
      if (startDate > now) future.push(b);
      else if (endDate >= now) running.push(b);
      else past.push(b);
    });

    // Order ikut tarikh berangkat/sailing: belum perjalanan paling hampir
    // dulu; yang lepas paling terkini dulu.
    function byStartAsc(a, b) {
      return String(tripStart(a)).localeCompare(String(tripStart(b)));
    }
    future.sort(byStartAsc);
    running.sort(byStartAsc);
    past.sort(function (a, b) { return byStartAsc(b, a); });

    return { future: future, running: running, past: past };
  }

  /* ── Render semua kumpulan (TABLE view — halaman semasa sahaja) ──
     Baris dikumpul dgn baris tajuk kumpulan (Future / Running / Past);
     header muncul hanya bila kumpulan itu ada baris pada halaman ini,
     dan kekal memaparkan JUMLAH penuh kumpulan. Pager dirender di bawah
     table oleh renderFiltered(). */
  function renderBookings(parts) {
    var html = '';
    html += '<div class="tv-table-wrap tv-animate-in">';
    html += '<table class="tv-bk-table">';
    html += '<thead><tr>'
      + '<th>Customer</th>'
      + '<th>Ref</th>'
      + '<th>Package</th>'
      + '<th>Departure</th>'
      + '<th class="tv-bk-table__num">Travellers</th>'
      + '<th>Status</th>'
      + '<th class="tv-bk-table__num">Billed</th>'
      + '<th class="tv-bk-table__num">Balance</th>'
      + '<th>Payment</th>'
      + '</tr></thead>';
    html += '<tbody>';

    if (parts.future.length) {
      html += groupRow('📅 Future Trip (' + parts.futureTotal + ')');
      parts.future.forEach(function (b) {
        html += bookingRow(b, false);
      });
    }
    if (parts.running.length) {
      html += groupRow('🚢 Running Trip (' + parts.runningTotal + ')');
      parts.running.forEach(function (b) {
        html += bookingRow(b, false);
      });
    }
    if (parts.past.length) {
      html += groupRow('📦 Past Trip (' + parts.pastTotal + ')');
      parts.past.forEach(function (b) {
        html += bookingRow(b, true);
      });
    }

    html += '</tbody></table></div>';
    return html;
  }

  /* ── Baris tajuk kumpulan (colspan penuh) ── */
  function groupRow(label) {
    return '<tr class="tv-bk-table__group"><td colspan="9">' + label + '</td></tr>';
  }

  /* ── Single On-Behalf Booking ROW ──
     Customer akhir kekal identiti UTAMA baris (nama + email + phone di
     lajur pertama). Baris boleh diklik → /traveller/onbehalf-booking?ref=
     (delegation didengar di wireRowLinks); baris Cancelled tidak aktif. */
  function bookingRow(b, isPast) {
    var ref = _esc(b.booking_number || b.name || '');
    // Package title (dari Trip Package booking) — fallback ke trip_name
    var pkgTitle = _esc(b.package_title || b.trip_name || 'Unnamed Package');
    var endName = _esc(b.end_customer_name || 'Unknown Customer');
    var endEmail = _esc(b.end_customer_email || '');
    var endPhone = _esc(b.end_customer_phone || '');
    var status = _esc(b.booking_status || 'Pending');
    var payStatus = _esc(b.payment_status || 'Pending');

    var totalSlots = parseInt(b.total_slots) || 0;
    var filledCount = parseInt(b.filled_count) || 0;
    var billed = parseFloat(b.billed) || 0;
    var balance = parseFloat(b.balance) || 0;
    // Currency booking (dari SO utama) — jumlah kad ikut currency ni
    var sym = curSym(b);

    // Departure: dua baris — tarikh berangkat di atas, tarikh pulang di bawah
    var dates = '—';
    if (b.departure_date) {
      dates = '<div>' + fmtDate(b.departure_date) + '</div>';
      if (b.return_date && b.return_date !== b.departure_date) {
        dates += '<div>' + fmtDate(b.return_date) + '</div>';
      }
    }

    var cancelled = status === 'Cancelled';
    var rowCls = 'tv-bk-table__row';
    if (cancelled) rowCls += ' tv-bk-table__row--muted';

    var balCls = balance <= 0 ? 'tv-bk-fin-value--success' : 'tv-bk-fin-value--warning';

    var html = '<tr class="' + rowCls + '"' + (cancelled ? '' : ' data-href="/traveller/onbehalf-booking?ref=' + encodeURIComponent(ref) + '"') + '>';

    // 1) CUSTOMER (identiti utama baris) — nama, email & phone
    html += '<td class="tv-bk-table__cell">';
    html += '<div class="tv-bk-table__cust">' + endName + (cancelled ? ' 🔒' : '') + '</div>';
    if (endEmail) html += '<div class="tv-bk-table__sub">' + endEmail + '</div>';
    if (endPhone) html += '<div class="tv-bk-table__sub">' + endPhone + '</div>';
    html += '</td>';

    // 2) REF
    html += '<td class="tv-bk-table__cell">';
    html += '<span class="tv-bk-table__ref">' + ref + '</span>';
    html += '</td>';

    // 3) PACKAGE (div had lebar — package_title panjang wrap, tak melebarkan table)
    html += '<td class="tv-bk-table__cell tv-bk-table__cell--trip"><div class="tv-bk-table__tripname">' + pkgTitle + '</div></td>';

    // 4) DEPARTURE (nowrap — setiap tarikh kekal satu baris)
    html += '<td class="tv-bk-table__cell tv-bk-table__date">' + dates + '</td>';

    // 5) TRAVELLERS
    html += '<td class="tv-bk-table__cell tv-bk-table__num">' + filledCount + '/' + totalSlots + '</td>';

    // 6) STATUS
    html += '<td class="tv-bk-table__cell">' + statusBadge(status, 'booking') + '</td>';

    // 7-8) FINANAS
    html += '<td class="tv-bk-table__cell tv-bk-table__num">' + fmtDual(billed, sym) + '</td>';
    html += '<td class="tv-bk-table__cell tv-bk-table__num"><span class="' + balCls + '">' + fmtDual(balance, sym) + '</span></td>';

    // 9) PAYMENT
    html += '<td class="tv-bk-table__cell">' + statusBadge(payStatus, 'payment') + '</td>';

    html += '</tr>';
    return html;
  }

  /* ── Klik mana-mana baris → buka detail (delegation sekali) ── */
  var _rowLinksWired = false;
  function wireRowLinks() {
    var content = document.getElementById('bookings-content');
    if (!content || _rowLinksWired) return;
    _rowLinksWired = true;
    content.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) return; // biarkan pautan sebenar bergerak sendiri
      var row = ev.target.closest('tr[data-href]');
      if (row) window.location.href = row.getAttribute('data-href');
    });
  }

  /* ── Carian & penapis (client-side) ──
     Senarai manager biasanya kecil — tapis di browser sahaja, tiada
     panggilan API setiap taipan. Carian merangkumi nama customer,
     emel dan no. rujukan. Pagination menghadkan bilangan baris setiap
     halaman merentas kumpulan supaya senarai panjang tidak dirender
     sekali gus. */
  var ALL_BOOKINGS = [];
  var currentPage = 1;
  var perPage = 10;
  var FILTER_DEBOUNCE = null;
  var FILTER_IDS = ['ob-f-status', 'ob-f-payment', 'ob-f-trip'];

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
    var search = document.getElementById('ob-search');
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

    fillSelect('ob-f-status', uniqueSorted(bookings.map(function (b) { return b.booking_status; })), 'All Statuses');
    fillSelect('ob-f-payment', uniqueSorted(bookings.map(function (b) { return b.payment_status; })), 'All Payments');
    fillSelect('ob-f-trip', uniqueSorted(bookings.map(function (b) { return b.trip_name; })), 'All Trips');

    var perPageSel = document.getElementById('ob-f-perpage');
    if (perPageSel) perPageSel.value = String(perPage);

    if (!bar.dataset.wired) {
      bar.dataset.wired = '1';
      var search = document.getElementById('ob-search');
      search.addEventListener('input', function () {
        clearTimeout(FILTER_DEBOUNCE);
        FILTER_DEBOUNCE = setTimeout(function () { renderFiltered(true); }, 200);
      });
      FILTER_IDS.forEach(function (id) {
        document.getElementById(id).addEventListener('change', function () {
          renderFiltered(true);
        });
      });
      document.getElementById('ob-f-clear').addEventListener('click', function () {
        clearFilterInputs();
        renderFiltered(true);
      });
      if (perPageSel) {
        perPageSel.addEventListener('change', function () {
          perPage = parseInt(this.value, 10) || 10;
          localStorage.setItem('tv_ob_per_page', String(perPage));
          renderFiltered(true);
        });
      }
    }
    bar.style.display = 'flex';
  }

  function applyFilters(bookings) {
    var searchEl = document.getElementById('ob-search');
    var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
    function selVal(id) {
      var el = document.getElementById(id);
      return el ? el.value : '';
    }
    var fStatus = selVal('ob-f-status');
    var fPayment = selVal('ob-f-payment');
    var fTrip = selVal('ob-f-trip');

    return bookings.filter(function (b) {
      if (fStatus && (b.booking_status || '') !== fStatus) return false;
      if (fPayment && (b.payment_status || '') !== fPayment) return false;
      if (fTrip && (b.trip_name || '') !== fTrip) return false;
      if (q) {
        var hay = [b.end_customer_name, b.end_customer_email, b.booking_number, b.name]
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

    var count = document.getElementById('bookings-count');

    if (!list.length) {
      // Pager di luar content — sembunyikan supaya tiada keadaan lama tertinggal
      var pg = document.getElementById('bookings-pagination');
      if (pg) { pg.style.display = 'none'; pg.innerHTML = ''; }
      if (count) {
        count.style.display = 'block';
        count.textContent = 'Showing 0 of ' + ALL_BOOKINGS.length
          + ' booking' + (ALL_BOOKINGS.length === 1 ? '' : 's') + ' (filtered)';
      }
      content.innerHTML =
        '<div class="tv-bk-nomatch">' +
        '<div class="tv-bk-nomatch__icon">🔍</div>' +
        '<p style="margin:0 0 14px 0;">No bookings match your search or filters.</p>' +
        '<button type="button" class="tv-btn tv-btn--ghost tv-btn--sm" id="ob-f-clear2">Clear Filters</button>' +
        '</div>';
      var btn = document.getElementById('ob-f-clear2');
      if (btn) btn.addEventListener('click', function () {
        clearFilterInputs();
        renderFiltered(true);
      });
      return;
    }

    var g = groupBookings(list);

    // Susunan mendatar seluruh senarai: Future (asc) → Running (asc) →
    // Past (terkini dulu). Pagination menghadkan bilangan baris SETIAP
    // halaman merentas kumpulan.
    var flat = g.future.concat(g.running, g.past);
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
    var fLen = g.future.length, rLen = g.running.length;
    var parts = {
      future: grpSlice(0, fLen),
      running: grpSlice(fLen, fLen + rLen),
      past: grpSlice(fLen + rLen, total),
      futureTotal: fLen,
      runningTotal: rLen,
      pastTotal: g.past.length
    };

    // Kiraan julat baris halaman semasa — nampak had pagination & penapis
    if (count) {
      count.style.display = 'block';
      count.textContent = 'Showing ' + (startIdx + 1) + '–' + endIdx
        + ' of ' + total + ' booking' + (total === 1 ? '' : 's')
        + (list.length !== ALL_BOOKINGS.length ? ' (filtered from ' + ALL_BOOKINGS.length + ')' : '');
    }

    content.innerHTML = renderBookings(parts);

    // Pager global bawah table — muncul bila jumlah baris > 1 halaman
    tvRenderPager(document.getElementById('bookings-pagination'), currentPage, totalPages, total, 'bookings', function (p) {
      currentPage = p;
      renderFiltered(false);
      content.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    wireRowLinks();
  }


  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
