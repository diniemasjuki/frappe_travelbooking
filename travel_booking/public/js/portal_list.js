/* ============================================================
   travel_booking/public/js/portal_list.js
   Page: /traveller_portal/bookings — senarai booking dikelompokkan:
     Upcoming Trip (satu sahaja — paling hampir) / Future Trips /
     Past Trips (collapsed).
   Semua nilai server di-escape guna _esc() (portal_common) — fix XSS.
   ============================================================ */

'use strict';

/* ── Status badge maps ── */
function bookingBadge(status) {
  const map = {
    'Pending':    'bd',
    'Accepted':   'p-acc',
    'Processing': 'bt',
    'Confirmed':  'bl',
    'Completed':  'bl',
    'Cancelled':  'p-miss',
    'Abandoned':  'bd',
  };
  return '<span class="badge ' + (map[status] || 'bd') + '">' + _esc(status || '—') + '</span>';
}

function paymentBadge(status) {
  const map = {
    'Pending':        'bd',
    'Partially Paid': 'p-warn',
    'Paid':           'bl',
    'Request Refund': 'p-miss',
    'Pending Refund': 'p-warn',
    'Refunded':       'bt',
  };
  return '<span class="badge ' + (map[status] || 'bd') + '">' + _esc(status || '—') + '</span>';
}

/* Tarikh banding secara tempatan — parse komponen (elak geser TZ). */
function _isoToMs(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

function daysUntil(iso) {
  const t = _isoToMs(iso);
  if (t === null) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / 86400000);
}

/* ── Kad booking ── */
function bookingCard(b, opts = {}) {
  const isUpcoming = !!opts.upcoming;
  const cancelled = b.booking_status === 'Cancelled';
  const sym = b.currency_symbol || b.currency || 'RM';
  const total = b.total_slots || 0;
  const filled = b.filled_count || 0;
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  const days = daysUntil(b.departure_date);

  const dates =
    fmtDate(b.departure_date) + (b.return_date ? ' – ' + fmtDate(b.return_date) : '');

  

  const countdown = (isUpcoming && days !== null && days >= 0)
    ? '<span class="badge bt" style="margin-left:8px;">Departs in ' + days + ' day' + (days === 1 ? '' : 's') + '</span>'
    : '';

  const lock = cancelled
    ? '<span title="Cancelled booking" aria-label="Cancelled booking" style="margin-left:8px;">🔒</span>'
    : '';

  return (
    '<a href="' + (cancelled ? '#' : '/traveller_portal/booking_info?ref=' + encodeURIComponent(b.booking_number)) + '" ' +
       'class="bk-card" style="' + (cancelled ? 'cursor:default;opacity:.72;' : '') + 'display:block;text-decoration:none;' +
       (isUpcoming ? 'border-color:#C9A84C;box-shadow:0 0 0 3px rgba(201,168,76,.12);' : '') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">' +
        '<div style="min-width:0;">' +
          '<div style="font-size:16px;font-weight:600;color:#1E1C18;">' + _esc(b.trip_name) + lock + countdown + '</div>' +
          '<div style="font-size:12px;color:#7D7A70;margin-top:3px;">' + _esc(b.group_name || '') + ' · ' + _esc(dates) + '</div>' +
        '</div>' +
        '<div style="font-family:monospace;font-size:12px;color:#5C5850;background:#F5F3EE;padding:4px 10px;border-radius:6px;white-space:nowrap;">' +
          _esc(b.booking_number) +
        '</div>' +
      '</div>' +

      '<div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;">' +
        bookingBadge(b.booking_status) +
        '<span class="badge bd">Travellers ' + filled + ' / ' + total + '</span>' +
      '</div>' +

      '<div style="display:flex;gap:0;margin-top:14px;border-top:1px solid #E8E5DF;padding-top:12px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:100px;padding-right:10px;">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#B0AC9F;">Total Billed</div>' +
          '<div style="font-size:15px;font-weight:600;color:#1E1C18;">' + fmtDual(b.billed, sym) + '</div>' +
        '</div>' +
        '<div style="flex:1;min-width:100px;padding-right:10px;">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#B0AC9F;">Total Paid</div>' +
          '<div style="font-size:15px;font-weight:600;color:#0F6E56;">' + fmtDual(b.paid, sym) + '</div>' +
        '</div>' +
        '<div style="flex:1;min-width:100px;">' +
          '<div style="font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#B0AC9F;">Balance Due</div>' +
          '<div style="font-size:15px;font-weight:600;color:' + (b.balance > 0 ? '#92400E' : '#0F6E56') + ';">' +
            fmtDual(b.balance, sym) + " &nbsp; " + paymentBadge(b.payment_status) + '</div>' +
        '</div>' +
      '</div>' +

      
    '</a>'
  );
}

/* ── Grouping + render ── */
function renderBookings(bookings) {
  const root = document.getElementById('bookings-content');
  if (!bookings || !bookings.length) {
    root.innerHTML =
      '<div class="card" style="text-align:center;padding:48px 24px;">' +
        '<div style="font-size:36px;margin-bottom:12px;">🧳</div>' +
        '<div style="font-size:16px;font-weight:600;color:#1E1C18;margin-bottom:6px;">No bookings yet</div>' +
        '<p style="font-size:13px;color:#7D7A70;line-height:1.6;max-width:380px;margin:0 auto 18px;">' +
          'When you make a trip booking, it will appear here with your itinerary, ' +
          'traveller details and payment status.</p>' +
        '<a href="/booking" class="btn btn-p" style="text-decoration:none;display:inline-block;">Browse Trips</a>' +
      '</div>';
    return;
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const active = [];   // departure >= hari ni
  const past = [];     // departure < hari ni
  bookings.forEach(b => {
    const t = _isoToMs(b.departure_date);
    if (t === null || t >= todayMs) active.push(b); else past.push(b);
  });

  // Upcoming Trip = YANG PERTAMA (paling hampir berlepas, list dah sorted
  // ASC ikut departure dari backend) dan bukan Cancelled.
  let upcomingTrip = null;
  const future = [];
  active.forEach(b => {
    if (!upcomingTrip && b.booking_status !== 'Cancelled') upcomingTrip = b;
    else future.push(b);
  });

  let html = '';

  if (upcomingTrip) {
    html +=
      '<div style="margin-bottom:26px;">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#C9A84C;margin-bottom:10px;">⏵ Upcoming Trip</div>' +
        bookingCard(upcomingTrip, { upcoming: true }) +
      '</div>';
  }

  if (future.length) {
    html +=
      '<div style="margin-bottom:26px;">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7D7A70;margin-bottom:10px;">Future Trips</div>' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
          future.map(b => bookingCard(b)).join('') +
        '</div>' +
      '</div>';
  }

  if (past.length) {
    html +=
      '<details style="margin-top:6px;">' +
        '<summary style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7D7A70;cursor:pointer;margin-bottom:10px;user-select:none;">' +
          'Past Trips (' + past.length + ')</summary>' +
        '<div style="display:flex;flex-direction:column;gap:12px;margin-top:10px;">' +
          past.map(b => bookingCard(b)).join('') +
        '</div>' +
      '</details>';
  }

  root.innerHTML = html;
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();

  const root = document.getElementById('bookings-content');
  try {
    const res = await API_BK('get_bookings_list', {});
    const _bk = (res && res.bookings) || [];
    renderBookings(_bk);
    window.rcRefreshCurrency = () => renderBookings(_bk);
  } catch (e) {
    root.innerHTML =
      '<div class="card" style="text-align:center;padding:32px 24px;">' +
        '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">Failed to load bookings: ' + _esc(e.message || 'unknown error') + '</div>' +
        '<button class="btn btn-g" onclick="window.location.reload()" style="font-size:12px;">Retry</button>' +
      '</div>';
  }
});
