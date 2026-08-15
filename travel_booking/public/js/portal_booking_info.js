/* ============================================================
   travel_booking/public/js/portal_booking_info.js
   Page: /traveller_portal/booking-info?ref=... — ringkasan booking:
   hero, info grid, cabins/stateroom/flight (read-only), payment summary.
   Semua nilai server di-escape guna _esc().
   ============================================================ */

'use strict';

let INFO_DATA = null;

function renderInfoPage(data) {
  const bk = data.booking || {};
  const sym = (bk.currency_symbol) || (data.payment && data.payment.so && data.payment.so.currency_symbol) || 'RM';

  document.getElementById('info-bk-ref').textContent    = bk.booking_number || '';
  document.getElementById('info-trip-name').textContent = bk.trip_name || '-';
  document.getElementById('info-trip-dates').textContent =
    (bk.departure_date ? fmtDate(bk.departure_date) : '') +
    (bk.return_date ? ' – ' + fmtDate(bk.return_date) : '') +
    (bk.group_name ? ' · ' + bk.group_name : '');

  // Status badges
  const bs = { 'Pending': 'bd', 'Accepted': 'p-acc', 'Processing': 'bt', 'Confirmed': 'bl', 'Completed': 'bl', 'Cancelled': 'p-miss' };
  const ps = { 'Pending': 'bd', 'Partially Paid': 'p-warn', 'Paid': 'bl', 'Request Refund': 'p-miss', 'Pending Refund': 'p-warn', 'Refunded': 'bt' };
  document.getElementById('info-badges').innerHTML =
    '<span class="badge ' + (bs[bk.booking_status] || 'bd') + '">' + _esc(bk.booking_status || '—') + '</span>' +
    '<span class="badge ' + (ps[bk.payment_status] || 'bd') + '">' + _esc(bk.payment_status || '—') + '</span>' +
    '<span class="badge bd">Travellers ' + (bk.filled_count || 0) + ' / ' + (bk.total_slots || 0) + '</span>';

  // Info grid
  const filled = bk.filled_count || 0, total = bk.total_slots || 0;
  document.getElementById('booking-info-grid').innerHTML = [
    ['Trip', bk.trip_name],
    ['Group / Sailing', bk.group_name || '-'],
    ['Departure', bk.departure_date ? fmtDate(bk.departure_date) : '-'],
    ['Return', bk.return_date ? fmtDate(bk.return_date) : '-'],
    ['Travellers', filled + ' of ' + total + ' filled'],
    ['Booking Ref', bk.booking_number],
  ].map(function (row) {
    return '<div class="g2f"><div class="l">' + _esc(row[0]) + '</div>' +
           '<div class="v">' + _esc(row[1] || '-') + '</div></div>';
  }).join('');

  // Cabins & assignments (read-only ringkasan)
  const cabins = data.cabins || [];
  const cabinsEl = document.getElementById('info-cabins');
  if (!cabins.length) {
    cabinsEl.innerHTML = '<div style="font-size:13px;color:#7D7A70;">Cabin assignments will appear here once confirmed by our team.</div>';
  } else {
    cabinsEl.innerHTML = cabins.map(function (c) {
      const stateroom = c.stateroom_no ? ' · Stateroom ' + _esc(c.stateroom_no) : '';
      const slotList = (c.slots || []).map(function (s) {
        const flight = s.flight_pnr ? ' · Flight PNR ' + _esc(s.flight_pnr) : '';
        return '<div style="padding:6px 0;border-bottom:1px solid #F0EDE7;font-size:12px;color:#5C5850;">' +
          _esc(s.slot_label) + ' — ' + _esc(s.full_name || 'Not filled yet') +
          (s.pax_type ? ' (' + _esc(s.pax_type) + ')' : '') + flight + '</div>';
      }).join('');
      return (
        '<div style="border:1px solid #EAE7E0;border-radius:12px;margin-bottom:10px;overflow:hidden;">' +
          '<div style="background:#F5F3EE;padding:10px 14px;display:flex;align-items:center;gap:10px;">' +
            '<span style="width:26px;height:26px;border-radius:8px;background:#C9A84C;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">' + _esc(c.cabin_no) + '</span>' +
            '<span style="font-size:13px;font-weight:600;color:#1E1C18;">Cabin ' + _esc(c.cabin_no) + stateroom + '</span>' +
            '<span style="flex:1;"></span>' +
            '<span style="font-size:11px;color:#7D7A70;text-transform:uppercase;letter-spacing:.04em;">' + _esc(c.room_name || '') + '</span>' +
          '</div>' +
          '<div style="padding:6px 14px 10px;">' + (slotList || '') + '</div>' +
        '</div>'
      );
    }).join('');
  }

  // Payment summary
  const so = (data.payment && data.payment.so) || {};
  const billed = parseFloat(so.grand_total || 0);
  const paid = parseFloat(so.advance_paid || 0);
  const balance = Math.max(0, billed - paid);
  document.getElementById('info-payment').innerHTML =
    '<div class="dr"><span class="dr-n">Total Billed</span><strong>' + _esc(sym) + ' ' + fmt(billed) + '</strong></div>' +
    '<div class="dr"><span class="dr-n">Total Paid</span><strong style="color:#0F6E56;">' + _esc(sym) + ' ' + fmt(paid) + '</strong></div>' +
    '<div class="dr"><span class="dr-n">Balance Due</span><strong style="color:' + (balance > 0 ? '#92400E' : '#0F6E56') + ';">' + _esc(sym) + ' ' + fmt(balance) + '</strong></div>';
}

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();

  const ref = _pageData.booking_ref || '';
  if (!ref) return;

  try {
    const data = await API_BK('get_booking_data', { booking_number: ref });
    INFO_DATA = data;
    renderInfoPage(data);
  } catch (e) {
    document.getElementById('info-trip-name').textContent = 'Could not load booking';
    document.getElementById('booking-info-grid').innerHTML =
      '<div style="font-size:13px;color:#991B1B;">' + _esc(e.message || 'Failed to load booking.') + '</div>' +
      '<a href="/traveller_portal/bookings" class="btn btn-g" style="text-decoration:none;display:inline-block;margin-top:12px;font-size:12px;">← Back to My Bookings</a>';
  }
});
