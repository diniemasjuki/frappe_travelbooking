/* ============================================================
   travel_booking/public/js/portal_booking.js
   Booking list, Trip details, Traveller slots
   ============================================================ */

/* ── Booking List ── */
function renderBookingList() {
  const container = document.getElementById('booking-list');
  if (!container || !SESSION) return;

  if (!SESSION.bookings || SESSION.bookings.length === 0) {
    container.innerHTML = `<div class="card"><div style="font-size:13px;color:#B0AC9F">No active bookings found.</div></div>`;
    return;
  }

  container.innerHTML = SESSION.bookings.map(bk => {
    const bref        = bk.booking_number || bk.name;
    const isCancelled = bk.booking_status === 'Cancelled';
    const locked      = isCancelled;
    const allVerified = bk.all_verified;
    const allFilled   = bk.pax_assigned;
    const filled      = bk.filled_count || 0;
    const total       = bk.total_slots  || 0;

    // Kad terkunci untuk Cancelled sahaja — tak boleh klik. Accepted kini
    // BOLEH diklik (status booking kekal "Accepted" walaupun dah bayar
    // penuh, sehingga admin assign stateroom/flight untuk trigger
    // "Processing" — customer tetap perlu akses portal untuk isi traveller
    // details dan lihat status pembayaran semasa tempoh ni).
    if (locked) {
      const label = 'Cancelled';
      const bg    = '#FEE2E2';
      const fg    = '#991B1B';
      const bar   = '#EF4444';
      const lockIcon = `<span title="${label}" style="display:inline-flex;align-items:center;color:${fg}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg></span>`;
      return `
      <div style="
        background:#fff;border:1px solid #EAE7E0;border-radius:16px;
        padding:20px 22px;margin-bottom:12px;cursor:default;
        border-left:3px solid ${bar};box-shadow:0 1px 3px rgba(0,0,0,.06);
        position:relative;overflow:hidden;opacity:.92">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div style="font-size:16px;font-weight:600;color:#1E1C18;line-height:1.3;flex:1;padding-right:12px">
            ${bk.trip_name || bref}
          </div>
          <span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;background:${bg};color:${fg};white-space:nowrap">${lockIcon}${label}</span>
        </div>
        <div style="font-size:12px;color:#7D7A70;margin-bottom:16px;display:flex;align-items:center;gap:6px">
          <span>${bk.departure_date}</span>
          <span style="color:#D4D0C8">→</span>
          <span>${bk.return_date}</span>
          ${bk.group_name ? `<span style="color:#D4D0C8">·</span><span>${bk.group_name}</span>` : ''}
        </div>
        <div style="border-top:1px solid #F0EDE7;padding-top:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#B0AC9F;margin-bottom:4px">Booking ref</div>
          <div style="font-size:13px;font-weight:600;font-family:monospace;color:#1E1C18">${bref}</div>
        </div>
      </div>`;
    }

    const statusBadgeMap = {
      "Pending":    { bg: "#F0EDE7", fg: "#5C5850", label: "Pending" },
      "Accepted":   { bg: "#FEF3C7", fg: "#92400E", label: "Accepted" },
      "Processing": { bg: "#FEF3C7", fg: "#92400E", label: "Processing" },
      "Confirmed":  { bg: "#DBEAFE", fg: "#1E40AF", label: "Confirmed" },
      "Completed":  { bg: "#DCFCE7", fg: "#166534", label: "Completed" },
    };
    const sb = statusBadgeMap[bk.booking_status] || { bg: "#F0EDE7", fg: "#5C5850", label: bk.booking_status || "-" };
    const statusHtml = `<span style="font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;background:${sb.bg};color:${sb.fg};white-space:nowrap">${sb.label}</span>`;

    return `
      <div onclick="openPortal('${bref}')" style="
        background:#fff;border:1px solid #EAE7E0;border-radius:16px;
        padding:20px 22px;margin-bottom:12px;cursor:pointer;
        border-left:3px solid #F5C518;
        box-shadow:0 1px 3px rgba(0,0,0,.06);
        transition:all .2s cubic-bezier(.4,0,.2,1);
        position:relative;overflow:hidden;
      "
      onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.1)';this.style.transform='translateY(-2px)'"
      onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,.06)';this.style.transform=''">

        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div style="font-size:16px;font-weight:600;color:#1E1C18;line-height:1.3;flex:1;padding-right:12px">
            ${bk.trip_name || bref}
          </div>
          ${statusHtml}
        </div>

        <div style="font-size:12px;color:#7D7A70;margin-bottom:16px;display:flex;align-items:center;gap:6px">
          <span>${bk.departure_date}</span>
          <span style="color:#D4D0C8">→</span>
          <span>${bk.return_date}</span>
          ${bk.group_name ? `<span style="color:#D4D0C8">·</span><span>${bk.group_name}</span>` : ''}
        </div>

        <div style="display:flex;gap:0;border-top:1px solid #F0EDE7;padding-top:14px">
          <div style="flex:1;border-right:1px solid #F0EDE7;padding-right:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#B0AC9F;margin-bottom:4px">Booking ref</div>
            <div style="font-size:12px;font-weight:600;font-family:monospace;color:#1E1C18">${bref}</div>
          </div>
          <div style="flex:1;border-right:1px solid #F0EDE7;padding:0 10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#B0AC9F;margin-bottom:4px">Travellers</div>
            <div style="font-size:12px;font-weight:600;color:#1E1C18">${filled}${total ? ' / ' + total : ''}</div>
          </div>
          <div style="flex:1;padding-left:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#B0AC9F;margin-bottom:4px">Documents</div>
            <div style="font-size:12px;font-weight:600;color:${allVerified ? '#166534' : allFilled ? '#1E1C18' : '#92400E'}">${allVerified ? 'Ready' : allFilled ? 'Pending Verification' : 'Incomplete'}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function openPortal(bookingName) {
  BOOKING = bookingName;
  const bk = SESSION.bookings.find(b => (b.booking_number || b.name) === bookingName);
  if (!bk) return;

  renderNav();
  const bref = bk.booking_number || bk.name;
  document.getElementById('portal-bk-ref').textContent      = bref;
  document.getElementById('portal-bk-ref-hero').textContent = `${bref}${bk.group_name ? ' · ' + bk.group_name : ''}`;
  document.getElementById('portal-trip-name').textContent   = bk.trip_name || bref;
  document.getElementById('portal-trip-dates').textContent  = `${bk.departure_date} – ${bk.return_date}`;
  const headerSub = document.getElementById('portal-header-sub');
  if (headerSub) headerSub.textContent = `${bk.trip_name || bref} · ${bref}`;
  document.getElementById('booking-info-grid').innerHTML = '';
  document.getElementById('traveller-slots-container').innerHTML =
    '<div style="font-size:13px;color:#B0AC9F;padding:8px 0">Loading travellers...</div>';

  sw('S-portal');

  const cached = _CACHE.get('booking_' + bookingName);
  if (cached) {
    PORTAL_DATA = cached;
    renderPortalBookingInfo(cached);
    renderTravellerSlots(cached);
    API_BK('get_booking_data', { booking_number: bookingName })
      .then(fresh => { PORTAL_DATA = fresh; _CACHE.set('booking_' + bookingName, fresh, _CACHE.TTL.booking); })
      .catch(() => {});
    return;
  }

  try {
    const data = await API_BK('get_booking_data', { booking_number: bookingName });
    PORTAL_DATA = data;
    _CACHE.set('booking_' + bookingName, data, _CACHE.TTL.booking);
    renderPortalBookingInfo(data);
    renderTravellerSlots(data);
  } catch (e) {
    document.getElementById('traveller-slots-container').innerHTML =
      `<div style="font-size:13px;color:#991B1B;padding:8px 0">Failed to load data: ${e.message}</div>`;
  }
}

function renderPortalBookingInfo(data) {
  const bk   = data.booking;
  const grid = document.getElementById('booking-info-grid');
  if (!grid) return;

  const filled = bk.filled_count || 0;
  const total  = bk.total_slots  || 0;

  grid.innerHTML = [
    ['Booking ref', bk.booking_number || bk.name],
    ['Trip',        bk.trip_name],
    ['Group',       bk.group_name || '-'],
    ['Departure',   bk.departure_date],
    ['Return',      bk.return_date],
    ['Travellers',  `${filled} / ${total} filled`],
  ].map(([l, v]) => `
    <div class="g2f">
      <div class="l">${l}</div>
      <div class="v">${v || '-'}</div>
    </div>`).join('');
}

/* ── Traveller Slots ── */
function renderTravellerSlots(data) {
  const container = document.getElementById('traveller-slots-container');
  if (!container) return;

  const slots  = data.slots  || [];
  const cabins = data.cabins || [];

  if (slots.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0">No traveller slots found. Please contact admin.</div>';
    return;
  }

  const filled = slots.filter(function(s){ return s.filled; }).length;
  const total  = slots.length;
  const pct    = total > 0 ? Math.round((filled / total) * 100) : 0;

  const progressHtml =
    '<div style="margin-bottom:20px">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted,#B0AC9F);margin-bottom:6px">' +
        '<span>' + filled + ' of ' + total + ' travellers filled</span>' +
        '<span>' + pct + '%</span>' +
      '</div>' +
      '<div style="height:3px;background:var(--border-secondary,#EAE7E0);border-radius:2px">' +
        '<div style="height:3px;background:var(--c-accent-dark,#D4A312);border-radius:2px;width:' + pct + '%;transition:width 0.4s ease"></div>' +
      '</div>' +
    '</div>';

  var slotsHtml = '';

  if (cabins.length > 0) {
    // Grouped by cabin — admin has assigned cabins
    cabins.forEach(function(cabin, ci) {
      var cabinNo    = cabin.cabin_no || (ci + 1);
      var roomName   = cabin.room_name || '';
      var cabinSlots = cabin.slots || [];
      var cabinFilled = cabinSlots.filter(function(s){ return s.filled; }).length;
      var allFilled  = cabinFilled === cabinSlots.length;

      slotsHtml += _cabinGroupHtml(cabinNo, roomName, cabinFilled, cabinSlots, allFilled);
    });

    // data.cabins dari server SUDAH mengandungi semua slot (grouping lengkap
    // dibuat di backend get_booking_data). Tiada slot "ungrouped" tertinggal —
    // blok lama di sini menyebabkan slot yang SAMA di-render dua kali sebagai
    // cabin tambahan (bug: cabin_assignment tak wujud pada objek slot).
  } else {
    // No cabin assignment yet — group by room_type from slots
    var roomBuckets2 = {};
    var roomOrder2   = [];
    slots.forEach(function(s) {
      var r = s.room_category || s.room_type || s.room_name || 'Room';
      if (!roomBuckets2[r]) { roomBuckets2[r] = []; roomOrder2.push(r); }
      roomBuckets2[r].push(s);
    });
    var cabinIdx = 1;
    roomOrder2.forEach(function(room) {
      var bSlots  = roomBuckets2[room];
      var bFilled = bSlots.filter(function(s){ return s.filled; }).length;
      slotsHtml += _cabinGroupHtml(cabinIdx, room, bFilled, bSlots, bFilled === bSlots.length);
      cabinIdx++;
    });
  }

  container.innerHTML = progressHtml + slotsHtml;

  container.querySelectorAll('[data-slot]').forEach(function(el) {
    el.addEventListener('click', function(){ openTravellerForm(el.dataset.slot); });
  });
}

/* ── Cabin group wrapper ── */
function _cabinGroupHtml(cabinNo, roomName, cabinFilled, cabinSlots, allFilled) {
  var badgeBg  = allFilled ? '#DCFCE7' : '#FEF3C7';
  var badgeClr = allFilled ? '#166534' : '#92400E';
  var badgeTxt = cabinFilled + '/' + cabinSlots.length + ' filled';

  return (
    '<div style="margin-bottom:14px;border:1px solid var(--border-secondary,#EAE7E0);border-radius:var(--radius-md,12px);overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.05)">' +
      /* header */
      '<div style="background:var(--bg-secondary,#F5F3EE);padding:11px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border-secondary,#EAE7E0)">' +
        '<div style="width:28px;height:28px;border-radius:8px;background:var(--c-accent,#F5C518);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--c-accent-text,#7A5C08);flex-shrink:0">' +
          cabinNo +
        '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#1E1C18);line-height:1.2">Cabin ' + cabinNo + '</div>' +
          (roomName ? '<div style="font-size:11px;color:var(--text-muted,#B0AC9F);margin-top:1px;text-transform:uppercase;letter-spacing:.04em">' + roomName + '</div>' : '') +
        '</div>' +
        '<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;background:' + badgeBg + ';color:' + badgeClr + ';white-space:nowrap">' +
          badgeTxt +
        '</span>' +
      '</div>' +
      /* slots */
      '<div>' +
        cabinSlots.map(function(slot, idx) {
          var divider = (idx < cabinSlots.length - 1)
            ? '<div style="height:1px;background:var(--border-tertiary,#F0EDE7);margin:0 16px"></div>'
            : '';
          return slotCardHtml(slot) + divider;
        }).join('') +
      '</div>' +
    '</div>'
  );
}

/* ── Individual traveller card ── */
function slotCardHtml(slot) {
  var isFilled     = slot.filled;
  var isVerified   = slot.is_verified || slot.document_status === 'Verified';
  var isOpenForUpd = slot.document_status === 'Open for Update';

  if (isFilled) {
    var name     = slot.full_name || '';
    var parts    = name.trim().split(' ');
    var initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();

    var avatarBg  = isVerified ? '#EBF7F1' : '#FEF9D3';
    var avatarClr = isVerified ? '#0F6E56' : '#92400E';
    var badgeBg   = isVerified   ? '#EBF7F1'
                  : isOpenForUpd ? '#EDE9FE'
                  : '#FEF3C7';
    var badgeClr  = isVerified   ? '#0F6E56'
                  : isOpenForUpd ? '#5B21B6'
                  : '#92400E';
    var badgeTxt  = isVerified   ? 'Verified'
                  : isOpenForUpd ? 'Edit Requested'
                  : 'Pending';

    /* Right column: badge + optional request link below */
    var rightCol =
      '<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:4px">' +
        '<span style="font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;background:' + badgeBg + ';color:' + badgeClr + ';white-space:nowrap">' +
          badgeTxt +
        '</span>' +
        (isVerified
          ? '<span onclick="event.stopPropagation();requestDocumentUpdate(\'' + slot.slot_name + '\')"' +
                 ' style="font-size:11px;color:var(--text-muted,#B0AC9F);text-decoration:underline;cursor:pointer;white-space:nowrap">' +
              'Request to edit' +
            '</span>'
          : '') +
      '</div>';

    return (
      '<div class="slot-card slot-filled' + (isVerified ? ' slot-verified' : '') + '"' +
           ' data-slot="' + slot.slot_name + '"' +
           ' style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;background:var(--bg-primary,#fff);transition:background 0.15s"' +
           ' onmouseover="this.style.background=\'var(--bg-secondary,#F5F3EE)\'"' +
           ' onmouseout="this.style.background=\'var(--bg-primary,#fff)\'">' +
        '<div style="width:38px;height:38px;border-radius:50%;background:' + avatarBg + ';' +
             'display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
             'font-size:13px;font-weight:700;color:' + avatarClr + ';letter-spacing:.02em">' +
          initials +
        '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:10px;font-weight:700;color:var(--text-muted,#B0AC9F);letter-spacing:.07em;text-transform:uppercase;margin-bottom:2px">' + slot.slot_label + '</div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--text-primary,#1E1C18);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</div>' +
          (slot.ic_number ? '<div style="font-size:11px;color:var(--text-secondary,#7D7A70);margin-top:1px">' + slot.ic_number + '</div>' : '') +
        '</div>' +
        rightCol +
        '<div style="color:var(--text-muted,#B0AC9F);font-size:16px;flex-shrink:0;margin-left:4px">&#x203A;</div>' +
      '</div>'
    );
  } else {
    return (
      '<div class="slot-card slot-empty"' +
           ' data-slot="' + slot.slot_name + '"' +
           ' style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;background:var(--bg-primary,#fff);transition:background 0.15s"' +
           ' onmouseover="this.style.background=\'var(--bg-secondary,#F5F3EE)\'"' +
           ' onmouseout="this.style.background=\'var(--bg-primary,#fff)\'">' +
        '<div style="width:38px;height:38px;border-radius:50%;border:1.5px dashed var(--border-primary,#D4D1CC);' +
             'display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
             'font-size:18px;font-weight:300;color:var(--text-muted,#B0AC9F)">' +
          '+' +
        '</div>' +
        '<div style="flex:1">' +
          '<div style="font-size:10px;font-weight:700;color:var(--text-muted,#B0AC9F);letter-spacing:.07em;text-transform:uppercase;margin-bottom:2px">' + slot.slot_label + '</div>' +
          '<div style="font-size:13px;color:var(--text-secondary,#7D7A70)">Not filled yet</div>' +
          '<div style="font-size:11px;color:var(--text-muted,#B0AC9F);margin-top:1px">Tap to fill in traveller details</div>' +
        '</div>' +
        '<div style="color:var(--text-muted,#B0AC9F);font-size:16px;flex-shrink:0">&#x203A;</div>' +
      '</div>'
    );
  }
}

function openTravellerForm(slotName) {
  if (!PORTAL_DATA) return;
  const slot = (PORTAL_DATA.slots || []).find(s => s.slot_name === slotName);
  if (!slot) return;

  // Traveller Details di-lock sehingga bayaran disahkan. Kad booking sudah
  // locked di renderBookingList() untuk status Accepted/Cancelled (customer
  // tak akan sampai ke sini pun) — ini cuma safety net senyap, bukan UX utama.
  const bkInfo = (PORTAL_DATA.booking || {});
  if (bkInfo.can_edit_traveller_details === false) return;

  ACTIVE_SLOT   = slot;
  _passportFile = null;

  const isVerified    = slot.is_verified || slot.document_status === 'Verified';
  const isOpenForUpd  = slot.document_status === 'Open for Update';

  // Block: Verified & Open for Update — tak boleh masuk form
  if (isVerified || isOpenForUpd) return;

  if (!slot.filled) {
    _resetWizard();
    sw('S-wizard');
    return;
  }

  _loadTravellerForm(slot);
}

function goBackToBookings() {
  sw('S-select');
  showMainTab('bk', document.getElementById('main-tab-bk'));
}

async function goBackToPortal() {
  if (!BOOKING) { sw('S-select'); return; }
  sw('S-portal');
  try {
    const fresh = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = fresh;
    _CACHE.set('booking_' + BOOKING, fresh, _CACHE.TTL.booking);
    renderPortalBookingInfo(fresh);
    renderTravellerSlots(fresh);
    if (SESSION && SESSION.bookings) {
      const idx = SESSION.bookings.findIndex(b => (b.booking_number || b.name) === BOOKING);
      if (idx >= 0) {
        SESSION.bookings[idx].filled_count = (fresh.slots || []).filter(s => s.filled).length;
        SESSION.bookings[idx].pax_assigned = fresh.booking.pax_assigned;
      }
    }
  } catch (e) {
    console.error('Failed to refresh portal data:', e);
    if (PORTAL_DATA) {
      renderPortalBookingInfo(PORTAL_DATA);
      renderTravellerSlots(PORTAL_DATA);
    }
  }
}

async function requestDocumentUpdate(slotName) {
  const ok = confirm('Request an update for this traveller slot?\n\nAdmin will review and unlock it for editing.');
  if (!ok) return;
  try {
    await API_TV('request_document_update', { slot_name: slotName });
    _CACHE.del('booking_' + BOOKING);
    const fresh = await API_BK('get_booking_data', { booking_number: BOOKING });
    PORTAL_DATA = fresh;
    _CACHE.set('booking_' + BOOKING, fresh, _CACHE.TTL.booking);
    renderTravellerSlots(fresh);
  } catch(e) {
    alert('Failed to submit request. Please try again.');
  }
}

function showMainTab(id, el) {
  document.getElementById('main-p-bk').style.display = id === 'bk' ? '' : 'none';
  document.getElementById('main-p-pi').style.display = id === 'pi' ? '' : 'none';
  document.querySelectorAll('#S-select .tab').forEach(t => t.classList.remove('on'));
  el.classList.add('on');

  const bc = document.getElementById('select-breadcrumb');
  if (bc) bc.innerHTML = id === 'pi'
    ? `<span class="bc-link" onclick="showMainTab('bk', document.getElementById('main-tab-bk'))">My Bookings</span>
       <span class="bc-sep">›</span>
       <span class="bc-current">Transactions</span>`
    : `<span class="bc-current">My Bookings</span>`;

  if (id === 'pi') loadAllPayments();
}

function showTab(id, el) {
  document.querySelectorAll('#S-portal .page').forEach(p => p.classList.remove('on'));
  document.getElementById('p-' + id).classList.add('on');
  document.querySelectorAll('#S-portal .tab').forEach(t => t.classList.remove('on'));
  el.classList.add('on');

  if (id === 'pi' && typeof loadBookingPayments === 'function') {
    loadBookingPayments();
  }
}