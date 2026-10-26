/* ══════════════════════════════════════════════════════════════════
   PAKEJ SENARAI BILIK (Rooms List) — rooms_list.js
   Grid kad bilik read-only + baris tetamu boleh klik. Komponen
   mandiri — boleh diguna semula oleh tab/page lain (di-include dalam
   scope IIFE page; rujukan esc/__/badge/api/show_traveller_dialog
   daripada page & pakej traveller_list).
   ══════════════════════════════════════════════════════════════════

   API
   ───
   • rooms_list_html(rm)              → string HTML grid kad bilik
       rm = payload get_group_rooming ({rooms: [...], ...})

   • mount_rooms_list($el, rm, opts)  → render + bind interaksi
       $el  = elemen sasaran (jQuery)
       rm   = payload get_group_rooming
       opts = {
         empty_message: teks keadaan kosong (default "No rooms found…"),
         on_guest: (guest, room, rm) => callback klik baris tetamu —
                   override lalai (modal maklumat traveller penuh),
       }

   Contoh penggunaan di tempat lain:
       mount_rooms_list($('.slot-bilik'), rm, {
           on_guest: (g, room) => buka_detail(g.reservation),
       });

   Struktur kad (spesifikasi rooming list):
   (1) top — Room ID + badge privacy (Private merah / Open Sharing biru /
       lain kelabu); (2) baris Cruise Cabin — Delegate No + Stateroom No
       (bila ada); (3) senarai tetamu — nombor tetamu (Guest Sequence,
       ATAU Aroya Guest No bila ada) + nama + badge jantina + badge umur;
       slot tanpa link Traveller dipapar "No Document". Tetamu kongsi
       merentas booking (booking ≠ booking host bilik) di-highlight
       amber (is-cross), selari papan Rooming Board.
   ══════════════════════════════════════════════════════════════════ */

// Badge privacy bilik — Private merah / Open Sharing biru / lain kelabu.
function rooms_list_privacy_badge(p) {
	return (p === 'Private' ? badge(__('Private'), 'red')
		: p === 'Open Sharing' ? badge(__('Open Sharing'), 'blue')
		: badge(__('Unspecified'), 'grey'));
}

// Badge jantina singkatan — Male = M (biru), Female = F (merah).
function rooms_list_gender_badge(g) {
	if (!g) return '';
	const f = g.toLowerCase() === 'female';
	return badge(f ? 'F' : 'M', f ? 'red' : 'blue');
}

// Nama paparan tetamu — slot tanpa data traveller memapar Guest Label;
// nama snapshot disertakan HANYA bila bermakna (bukan '-'/kosong).
function rooms_list_guest_name(g) {
	const hasName = g.name && g.name !== '-';
	return g.traveller ? g.name
		: (g.guest_label ? (hasName ? `${g.guest_label} · ${g.name}` : g.guest_label) : g.name);
}

// HTML grid kad bilik — PURE (tiada mutasi / binding).
function rooms_list_html(rm) {
	const rows = (rm && rm.rooms) || [];
	if (!rows.length) return '';

	return rows.map((r) => {
		const cabinBits = [
			r.delegate_no ? `${__('Delegate No')}: <b>${esc(r.delegate_no)}</b>` : '',
			r.stateroom_no ? `${__('Stateroom No')}: <b>${esc(r.stateroom_no)}</b>` : '',
		].filter(Boolean).join(' · ');
		const guests = (r.guests || []).map((gst) => {
			const no = gst.aroya_guest_no ? String(gst.aroya_guest_no) : String(gst.guest_sequence || '·');
			const linked = !!gst.traveller;
			// Tetamu kongsi merentas booking — highlight amber.
			const cross = !!(gst.booking && r.booking && gst.booking !== r.booking);
			return `
			<div class="mba-rmc-guest ${cross ? 'is-cross' : ''}" data-reservation="${esc(gst.reservation)}"
				title="${esc(rooms_list_guest_name(gst))}${cross ? ' · ' + esc(__('Sharing from another booking')) : ''}">
				<span class="mba-rmc-no">${esc(no)}.</span>
				<span class="mba-rmc-name">${esc(rooms_list_guest_name(gst))}</span>
				${linked
					? `${rooms_list_gender_badge(gst.gender)}${gst.age != null && gst.age !== '' ? badge(String(gst.age), 'grey') : ''}`
					: `<span class="mba-rmc-nodoc">${__('No Document')}</span>`}
			</div>`;
		}).join('');
		return `
		<div class="mba-rmcard">
			<div class="mba-rmc-top">
				<div class="mba-rmc-top-main">
					<span class="mba-rmc-id">${esc(r.room_id)}</span>
					<span class="mba-rmc-priv">${rooms_list_privacy_badge(r.room_privacy)}</span>
				</div>
				<div class="mba-rmc-sub" title="${esc(r.customer_name || '')} · ${esc((r.booking_names || []).join(', '))}">
					${esc(r.customer_name || '—')}${(r.booking_names || r.bookings || []).length
						? ` <span class="mba-rmc-sub-book">· ${esc((r.booking_names || r.bookings).join(', '))}</span>` : ''}
				</div>
			</div>
			${cabinBits ? `<div class="mba-rmc-cabin">${cabinBits}</div>` : ''}
			<div class="mba-rmc-guests">${guests || `<span class="mba-muted">—</span>`}</div>
		</div>`;
	}).join('');
}

// Gabungkan tetamu + konteks bilik — objek penuh untuk modal maklumat
// traveller (show_traveller_dialog).
function rooms_list_merge_guest(g, r) {
	return {
		...g,
		booking_number: (r.bookings || [])[0] || g.booking,
		room_id: r.room_id, cabin_no: r.cabin_no,
		stateroom_no: r.stateroom_no, room_category: r.room_category,
		room_privacy: r.room_privacy, cabin_is_confirmed: r.cabin_confirmed,
		delegate_no: r.delegate_no, trip_group: r.trip_group,
	};
}

// Render + bind. Klik baris tetamu → opts.on_guest bila diberikan, else
// LALAI: modal maklumat traveller penuh — fetch baris lengkap melalui
// get_group_travellers MODE BOOKING, padankan reservation; navigasi
// prev/next modal kekal dalam TETAMU BILIK SAMA (padanan room_id).
// Fallback bila fetch gagal: baris subset + housemates — modal tetap
// terbuka (beberapa medan kosong).
function mount_rooms_list($el, rm, opts) {
	opts = opts || {};
	if (!$el || !$el.length) return;

	const rooms = (rm && rm.rooms) || [];
	$el.html(rooms.length
		? `<div class="mba-rmgrid">${rooms_list_html(rm)}</div>`
		: `<div class="mba-empty">${esc(opts.empty_message || __('No rooms found for this filter.'))}</div>`);

	// Binding scoped pada $el — re-render menggantikan DOM lama bersama
	// bindingnya (tiada double-bind).
	$el.find('.mba-rmc-guest').on('click', async function () {
		const resv = String($(this).data('reservation') || '');
		if (!resv) return;
		let guest = null, room = null;
		for (const r of rooms) {
			const g = (r.guests || []).find((x) => String(x.reservation) === resv);
			if (g) { guest = g; room = r; break; }
		}
		if (!guest) return;

		if (opts.on_guest) { opts.on_guest(guest, room, rm); return; }

		try {
			const out = await api('get_group_travellers', {
				booking: guest.booking, limit: 0,
			});
			const all = (out && out.travellers) || [];
			const found = all.find((x) => String(x.reservation) === resv);
			if (found) {
				const roomKey = (room && room.room_id) || '';
				const list = all.filter((x) =>
					!roomKey || (x.room_id || '') === roomKey);
				const index = Math.max(0, list.findIndex((x) =>
					String(x.reservation) === resv));
				show_traveller_dialog(found, { list, index });
				return;
			}
		} catch (e) {
			// api() sudah papar alert — teruskan dengan baris subset.
		}
		// Fallback: housemates bilik sama (data subset).
		const list = (room.guests || []).map((g) => rooms_list_merge_guest(g, room));
		const index = (room.guests || []).findIndex((g) =>
			String(g.reservation) === resv);
		show_traveller_dialog(rooms_list_merge_guest(guest, room),
			{ list, index: Math.max(0, index) });
	});
}
