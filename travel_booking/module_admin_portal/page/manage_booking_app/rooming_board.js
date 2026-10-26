	/* ══════════════════════════════════════════════════════════════════
	   SUB-PACKAGE: ROOMING BOARD (rooming_board.js)
	   ══════════════════════════════════════════════════════════════════
	   Satu set komponen UI rooming yang boleh DIGUNA SEMULA oleh
	   section/page lain (senarai read-only + papan susun atur Kanban).
	   Fail ini di-include ke dalam scope IIFE page manage_booking_app
	   melalui directive include (frappe.model.utils.render_include —
	   concatenation server-side), jadi semua fungsi/const di sini HIDUP
	   dalam scope page yang sama dan boleh merujuk helper page (S, api,
	   $d, badge, esc, fmtDate, DOC_STATUS_COLORS, dsb.) secara terus —
	   corak yang sama dengan traveller_list.js.

	   API AWAM (untuk section lain):
	   • render_rooming_tab(key)   — renderer tab Rooms L2 (senarai lipat
	     read-only + butang buka papan susun atur).
	   • open_rooming_board(key)   — papan Kanban susun atur rooming:
	     kolum = satu bilik (per booking), kad = tetamu. Desktop:
	     drag-and-drop HTML5 (tanpa dependency) + NOTIS pengesahan
	     (rb_drop_move). Mobile/klik: dialog "Pindah Tetamu".
	   • move_guest_to_room(guest, col) — mutasi draf papan (digunakan
	     oleh kedua-dua laluan DnD & dialog).
	   • rb_save(key)              — kumpul placement penuh → endpoint
	     arrange_group_rooming (batch atomik, doc.save() penuh di
	     server supaya validasi kapasiti doctype kekal berjalan).

	   MODAL MOVE GUEST (rb_move_dialog) — TABS + dua form berasingan:
	   • TAB [Update Info] — form kemaskini tetamu: Room Arrangement
	     (kolum kiri, vertical: room_id FORMAT AUTO BOOKING_NO-Room_<cabin>,
	     cabin_no, guest_sequence EDITABLE — kosong = reset auto) + Cruise
	     Arrangement (kolum kanan, vertical: stateroom_no, delegate_no,
	     aroya_guest_no EDITABLE) + butang
	     Save Details + Reset Rooming Number (semua dalam form sama).
	   • TAB [Move] — form pindah: Current Room ID (format auto betul) +
	     New Room AUTOCOMPLETE BOLEH CARI yang MULA KOSONG; senarai = bilik
	     layak PRA-TAPIS rb_move_reject + "No Arrangement (Unassigned)";
	     PILIHAN KOSONG = TIADA PENEMPATAN (Unassigned, cabin 0) dan butang
	     bertukar "Remove Arrangement".
	   • Reset Rooming Number — DRAF TETAMU INI SAJA: pratonton susunan
	     asal (SO utama, get_booking_rooming_source_order) → rb_move draf
	     ke cabin asal; DB ditulis oleh "Save Arrangement" (rb_save)
	     sepenuhnya — draf lain KEKAL, tiada reload papan.

	   NOTIS DRAG & DROP (rb_drop_move) — popup selepas drop: "you are
	   moving this traveller from [old] into [new]" + checkbox
	   pengesahan WAJIB (kiri) + butang Move (kanan; aktif selepas tick).
	   Label bilik kedua-dua modal guna FORMAT ROOM ID BETUL
	   (rb_room_label: BOOKING_NO-Room_<cabin> + alias) — BUKAN docname.

	   MODEL DRAF:
	   • RB.cols — kolum bilik draf [{booking, booking_number, cabin_no,
	     room_category, room_privacy, stateroom_no, confirmed, capacity,
	     max_capacity, isNew, guests[]}]; kolum cabin_no 0 per booking =
	     "Unassigned". Bilik baharu (isNew) diberi cabin_no = max+1;
	     Room ID sebenar dijana server (assign_room_id).
	   • Save hanta PLACEMENT PENUH (bukan diff) — server banding &
	     hanya save yang berubah (rujuk arrange_group_rooming); setiap
	     move turut membawa from_cabin_no (cabin asal dilihat klien)
	     sebagai save-guard stale board: admin lain dah pindah tetamu →
	     save DITOLAK, bukan overwrite senyap. Papan turut melanggan
	     siaran realtime travel_booking_rooming_updated — kemaskini oleh
	     admin lain dimuat semula secara automatik bila tiada draf
	     tertangguh (rujuk rb_watch_realtime). ECHO siaran save sendiri
	     diabaikan (medan 'by' server + RB._echoGuard semasa save→reload)
	     supaya save sendiri tidak salah cetak amaran "another user".
	   • Validasi draf sebelum save: kolum melebihi max_capacity
	     DISEKAT (merah); bilik campur jantina dibenarkan dengan chip
	     amaran sahaja (cabin keluarga cruise — bukan ralat).
	   ══════════════════════════════════════════════════════════════════ */

	// State papan — satu dialog pada satu masa. q/fcat/fpriv/fconf/fbook
	// = penapis saringan bilik. mode = paparan papan ('grid' kanban |
	// 'table' senarai reservation).
	const RB = { key: null, cols: [], categories: {}, $view: null, seq: 0,
	q: '', fcat: '', fpriv: '', fconf: '', fbook: '', mode: 'grid',
	_rtHandler: null, _echoGuard: false };

	/* ---------- L2 Tab Rooms (senarai read-only + pintasan papan) ---------- */

	// Renderer tab — toolbar (carian/penapis/limit) + pakej senarai bilik
	// (rooms_list.js: mount_rooms_list) + butang pintasan Rooming Board.
	function render_rooming_tab(key) {
		const rm = S.cache[key]?.rooming;
		const it = find_item(key);
		const st = S.state[key];
		if (!rm || !it || !st) return;

		const rows = rm.rooms || [];
		const privacyOpts = [
			['', __('All Privacy')],
			['Private', __('Private')],
			['Open Sharing', __('Open Sharing')],
			['__blank__', __('Unspecified')],
		].map(([v, l]) => `<option value="${esc(v)}" ${st.rm.privacy === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

		pane_el(key, 'rooming').html(`
			<div class="mba-tab-toolbar">
				${TravelBookingSearchBox.html({
					attrs: { 'data-search': 'rm' },
					placeholder: __('Search room / category / traveller...'),
					value: st.rm.search,
				})}
				<select data-kind="privacy" data-scope="rm">${privacyOpts}</select>
				${limit_options('rm', st.rm.limit)}
				<button type="button" class="btn btn-secondary btn-sm mba-rb-open" data-arrange-rooming="1">
					${__('Rooming Board')}</button>
			</div>
			<div class="mba-rooms-slot"></div>
			${showing_footer(rm, __('rooms'), 'rm')}`);

		// Grid kad bilik — PAKEJ rooms_list.js (klik tetamu → modal
		// maklumat traveller, lalai pakej).
		mount_rooms_list(pane_el(key, 'rooming').find('.mba-rooms-slot'), rm);
	}

	// Butang "Rooming Board" — navigasi SPA ke route view penuh
	// /rooming/<kind>/<id> (URL shareable; back/forward tanpa reload).
	$(document).on('click', '[data-arrange-rooming]', function () {
		const key = $(this).closest('.mba-group').data('item');
		const it = key && find_item(key);
		if (!it) return;
		frappe.set_route('manage-booking-app', 'rooming',
			it.batch ? 'batch' : 'group', it.batch || it.members[0].name);
	});

	/* ---------- Papan Kanban Rooming Board ---------- */

	// Bina kolum draf dari payload get_group_rooming. Bilik cabin_no 0
	// dibubarkan kepada kolum "Unassigned" per booking; bilik sebenar
	// kekal satu kolum. Kolum disusun ikut booking kemudian cabin_no.
	function rb_build_cols(rm) {
		const cols = [];
		const unassigned = {};   // booking → col
		const by_booking = {};   // booking → [cols]
		const order = [];        // urutan kemunculan booking

		for (const r of (rm.rooms || [])) {
			const booking = r.booking || (r.guests || [])[0]?.booking || '';
			const booking_number = (r.bookings || [])[0] || booking;
			// Bilik ad-hoc CustomRoom_<reservation> (modal Move Guest) —
			// cabin 0 TETAPI bukan Unassigned: kekal sebagai kolum bilik
			// tersendiri dengan room_id CustomRoom_.
			const isCustom = !r.cabin_no
				&& String(r.room_id || '').startsWith('CustomRoom_');
			let list = by_booking[booking];
			if (!list) { list = by_booking[booking] = []; order.push({ booking, booking_number }); }

			if (!r.cabin_no && !isCustom) {
				// Tetamu tanpa bilik → kolum Unassigned booking itu.
				let col = unassigned[booking];
				if (!col) {
					col = unassigned[booking] = rb_new_col(booking, booking_number, 0, '', r);
					col.customer_name = r.customer_name || '';
					col.custom_name = r.custom_name || '';
					list.push(col);
				}
				col.guests.push(...(r.guests || []));
				continue;
			}

			list.push(Object.assign(rb_new_col(booking, booking_number, r.cabin_no, r.room_category, r), {
				customer_name: r.customer_name || '',
				custom_name: isCustom ? String(r.room_id) : (r.custom_name || ''),
				room_privacy: r.room_privacy || '',
				stateroom_no: r.stateroom_no || '',
				delegate_no: r.delegate_no || '',
				confirmed: !!r.cabin_confirmed,
				isCustom,
				// Room ID sebenar bilik (payload get_group_rooming) —
				// diperlukan untuk penempatan merentas booking (Open
				// Sharing): reservation tetamu booking lain perlu membawa
				// room_id eksplisit bilik ini supaya assign_room_id()
				// tidak menjana semula ID ikut booking sendiri.
				room_id: r.room_id || '',
				guests: [...(r.guests || [])],
			}));
		}

		for (const { booking } of order) {
			// Bilik CustomRoom_ (cabin 0) diisih di HUJUNG — selepas bilik
			// bernombor dan kolum Unassigned.
			by_booking[booking].sort((a, b) =>
				((a.cabin_no || (a.isCustom ? 9e9 : 0)) - (b.cabin_no || (b.isCustom ? 9e9 : 0))));
			cols.push(...by_booking[booking]);
		}
		return cols;
	}

	function rb_new_col(booking, booking_number, cabin_no, room_category, src) {
		const meta = (src && (src.max_capacity || src.capacity))
			? { capacity: src.capacity || 0, max_capacity: src.max_capacity || 0 }
			: (RB.categories[room_category] || { capacity: 0, max_capacity: 0 });
		return {
			id: 'c' + (++RB.seq),
			booking, booking_number, cabin_no, customer_name: '',
			// Nama paparan tersuai bilik (Booking Room Alias) — berasingan
			// daripada room_id mekanikal (Opsyen A).
			custom_name: '',
			room_category: room_category === 'Unassigned' ? '' : (room_category || ''),
			room_privacy: '', stateroom_no: '', delegate_no: '', confirmed: false,
			capacity: meta.capacity || 0, max_capacity: meta.max_capacity || 0,
			isNew: false, guests: [],
		};
	}

	// Kapasiti teks "2/3" atau "2/—" (0 = tanpa had struktur) + badge
	// komposisi jantina kecil di dalam kapsul occ yang sama.
	function rb_occ_html(col) {
		const over = col.max_capacity > 0 && col.guests.length > col.max_capacity;
		return `<span class="mba-rb-occ ${over ? 'is-over' : ''}">${col.guests.length}/${col.max_capacity > 0 ? col.max_capacity : '—'}${rb_gender_warn_html(col)}</span>`;
	}

	// Chip komposisi jantina per kolum — dipapar sebagai badge kecil di
	// dalam .mba-rb-occ (varian: Mixed amber / Male biru / Female merah /
	// Unknown kelabu — tetamu tanpa data jantina); bilik kosong tiada chip.
	function rb_gender_warn_html(col) {
		if (!col.guests.length) return '';
		// Jantina tak diketahui ('') dikira SATU kategori berasingan —
		// campuran dengannya = Mixed (komposisi tidak seragam).
		const genders = new Set(col.guests.map((g) => (g.gender || '').toLowerCase()));
		if (genders.size > 1) return `<span class="mba-rb-warn">${__('Mixed')}</span>`;
		if (genders.has('male')) return `<span class="mba-rb-warn is-male">${__('Male')}</span>`;
		if (genders.has('female')) return `<span class="mba-rb-warn is-female">${__('Female')}</span>`;
		if (genders.has('')) return `<span class="mba-rb-warn is-unknown">${__('Unknown')}</span>`;
		return '';
	}

	// Amaran baris warns kolum — hanya Over capacity (ralat); chip jantina
	// berpindah ke kapsul .mba-rb-occ (lihat rb_gender_warn_html).
	function rb_col_warnings(col) {
		if (col.max_capacity > 0 && col.guests.length > col.max_capacity)
			return `<span class="mba-rb-warn is-bad">${__('Over capacity')}</span>`;
		return '';
	}

	// Kad penghuni — nama + jantina (bulatan M biru / F merah) + badge
	// umur (bila ada). Badge status dokumen DIBUANG mengikut spesifikasi
	// papan (maklumat status kekal dalam modal maklumat traveller).
	// Kad tetamu — bermula NO. TETAMU (urutan draf dalam bilik, 1,2,3…;
	// contoh rooming list kapal), diikuti nama, jantina & umur.
	function rb_card_html(g, i, col) {
		const gclass = (g.gender || '').toLowerCase() === 'female' ? 'is-f' : (g.gender ? 'is-m' : '');
		// Tetamu merentas booking (kongsi bilik Open Sharing) — kad
		// diwarnakan amber (is-cross) supaya ketara pada kanban.
		const cross = !!(col && g.booking && col.booking && g.booking !== col.booking);
		// Reservation tanpa data traveller — papar Guest Label slot;
		// nama snapshot disertakan HANYA bila bermakna.
		const hasName = g.name && g.name !== '-';
		const dispName = g.traveller ? g.name
			: (g.guest_label ? (hasName ? `${g.guest_label} · ${g.name}` : g.guest_label) : g.name);
		// NO. TETAMU daripada medan GUEST SEQUENCE DB (urutan tetamu dalam
		// cabin, mirror rooming list kapal); fallback index paparan bila
		// medan kosong.
		const no = g.guest_sequence || (i + 1);
		return `
			<div class="mba-rb-card ${gclass} ${cross ? 'is-cross' : ''}" draggable="true" data-reservation="${esc(g.reservation)}" title="${esc(dispName)} · ${esc(g.pax_type || '')}${cross ? ' · ' + esc(__('Booking: {0}', [bnum_of(g.booking)])) : ''}">
				<span class="mba-rb-card-no">${no}.</span>
				<span class="mba-rb-card-name">${esc(dispName)}</span>
				${g.gender ? `<span class="mba-rb-card-gender">${esc(__(g.gender)).slice(0, 1)}</span>` : ''}
				${g.age != null && g.age !== '' ? badge(String(g.age), 'grey') : ''}
			</div>`;
	}

	function rb_col_html(col) {
		const isUnassigned = !col.cabin_no && !col.isCustom;
		const warns = rb_col_warnings(col);
		return `
		<div class="mba-rb-col ${isUnassigned ? 'is-unassigned' : ''} ${col.isNew ? 'is-new' : ''} ${col.confirmed ? 'is-confirmed' : ''} ${col.isCustom ? 'is-custom' : ''}" data-col="${col.id}">
			<div class="mba-rb-col-head">
				<div class="mba-rb-col-title">
					<div class="mba-rb-col-title-main">
						${isUnassigned
							? `<span class="mba-rb-col-id">${__('Unassigned')}</span>`
							: `<span class="mba-rb-col-id" title="${esc(col.isCustom ? col.room_id : rb_auto_room_id(col))}">${esc(rb_room_display(col))}${col.isNew ? ' ' + __('(new)') : ''}</span>
						${col.isCustom ? '' : `<button type="button" class="mba-rb-rename" data-col="${col.id}" ${col.confirmed ? 'disabled' : ''}
							title="${esc(__('Rename room display name'))}">✎</button>`}`}
						${rb_occ_html(col)}
					</div>
					${col.customer_name ? `<div class="mba-rb-col-cust" title="${esc(__('Customer'))}: ${esc(col.customer_name)}">${esc(col.customer_name)}</div>` : ''}
				</div>
				${warns ? `<div class="mba-rb-col-warns">${warns}</div>` : ''}
				${!isUnassigned ? `
				<div class="mba-rb-col-props">
					<div class="mba-rb-cat-wrap" title="${__('Room Category — searchable')}"></div>
					<div class="mba-rb-props-row">
						<input type="text" class="mba-rb-stateroom" placeholder="${__('Stateroom No')}" value="${esc(col.stateroom_no)}" title="${__('Stateroom No')}" ${col.confirmed ? 'disabled' : ''} />
						<input type="text" class="mba-rb-delegate" placeholder="${__('Delegate No')}" value="${esc(col.delegate_no)}" title="${__('Delegate No')}" ${col.confirmed ? 'disabled' : ''} />
						<select class="mba-rb-privacy" title="${__('Room Privacy')}" ${col.confirmed ? 'disabled' : ''}>
							<option value="" ${!col.room_privacy ? 'selected' : ''}>${__('Unspecified')}</option>
							<option value="Private" ${col.room_privacy === 'Private' ? 'selected' : ''}>${__('Private')}</option>
							<option value="Open Sharing" ${col.room_privacy === 'Open Sharing' ? 'selected' : ''}>${__('Open Sharing')}</option>
						</select>
						<label class="mba-rb-conf" title="${__('Room Arrangement Confirmed')}">
							<input type="checkbox" class="mba-rb-confirmed" ${col.confirmed ? 'checked' : ''} /> ${__('Confirmed')}</label>
					</div>
				</div>` : ''}
			</div>
			<div class="mba-rb-col-body" data-col="${col.id}">
				${col.guests.map((g, i) => rb_card_html(g, i, col)).join('') || `<div class="mba-rb-empty">${__('Drop guest here')}</div>`}
			</div>
		</div>`;
	}

	// ── TABLE VIEW — senarai reservation + maklumat penginapan, boleh
	//    dilipat (collapsible) ikut Booking → Room ID (details/summary).
	//    Baris tetamu yang booking-nya BERBEZA daripada booking tuan
	//    rumah bilik (host) di-highlight .is-cross — tanda kongsi bilik
	//    merentas booking (Open Sharing). Data dari kolum KANBAN yang
	//    sama (termasuk penapis carian/saringan). ──
	function rb_table_html(visible) {
		// docname booking → booking_number (untuk paparan booking tetamu;
		// objek guest hanya bawa docname).
		const bnumMap = new Map(RB.cols.map((c) => [c.booking, c.booking_number || c.booking]));
		// Kumpul kolum ikut booking HOST (col.booking) — susunan kekal
		// (papan sudah diisih ikut booking kemudian cabin_no).
		const byBooking = new Map();
		for (const col of visible) {
			if (!byBooking.has(col.booking)) byBooking.set(col.booking, []);
			byBooking.get(col.booking).push(col);
		}
		return [...byBooking.entries()].map(([booking, cols]) => {
			const nGuests = cols.reduce((n, c) => n + c.guests.length, 0);
			const cust = (cols.find((c) => c.customer_name) || {}).customer_name || '';
			const label = bnumMap.get(booking) || booking;
			const cross = cols.some((c) =>
				c.guests.some((g) => g.booking && g.booking !== c.booking));
			return `<details class="mba-rb-tb-book" open>
				<summary>
					<b>${esc(label)}</b>
					${cust ? `<span class="mba-rb-tb-cust" title="${esc(cust)}">${esc(cust)}</span>` : ''}
					${cross ? badge(__('Sharing'), 'orange') : ''}
					<span class="mba-rb-tb-meta">${cols.length} ${__('rooms')} · ${nGuests} ${__('guests')}</span>
				</summary>
				${cols.map((c) => rb_table_room_html(c, bnumMap)).join('')}
			</details>`;
		}).join('');
	}

	function rb_table_room_html(col, bnumMap) {
		const cross = col.guests.some((g) => g.booking && g.booking !== col.booking);
		const occ = `${col.guests.length}/${col.max_capacity > 0 ? col.max_capacity : '—'}`;
		return `<details class="mba-rb-tb-room ${cross ? 'has-cross' : ''}" open data-col="${col.id}">
			<summary>
				<span class="mba-rb-tb-roomid">${(col.cabin_no || col.isCustom) ? esc(rb_room_display(col)) : esc(__('Unassigned'))}</span>
				${col.room_category ? `<span class="mba-rb-tb-cat">${esc(col.room_category)}</span>` : ''}
				${col.room_privacy ? badge(__(col.room_privacy), col.room_privacy === 'Private' ? 'red' : 'blue') : ''}
				${col.confirmed ? badge(__('Confirmed'), 'green') : ''}
				${cross ? badge(__('Sharing'), 'orange') : ''}
				<span class="mba-rb-tb-meta">${occ}</span>
			</summary>
			<div class="mba-rb-tb-scroll">
			<table class="table table-sm mba-rb-tb-table">
				<thead><tr>
					<th>#</th><th>${__('Guest')}</th><th>${__('Pax Type')}</th><th>${__('Gender')}</th>
					<th>${__('Age')}</th><th>${__('Reservation')}</th><th>${__('Booking')}</th>
					<th>${__('Stateroom')}</th><th>${__('Delegate')}</th><th>${__('Aroya')}</th>
				</tr></thead>
				<tbody>
					${col.guests.length
						? col.guests.map((g, i) => rb_table_guest_row(col, g, i, bnumMap)).join('')
						: `<tr><td colspan="10" class="mba-rb-tb-empty">${__('Empty room')}</td></tr>`}
				</tbody>
			</table>
			</div>
		</details>`;
	}

	// Baris reservation — nama (logik sama dengan kad kanban), pax-type,
	// jantina (huruf pertama), umur, reservation, booking sendiri tetamu,
	// dan maklumat penginapan bilik host (stateroom / delegate / aroya).
	function rb_table_guest_row(col, g, i, bnumMap) {
		const cross = !!(g.booking && col.booking && g.booking !== col.booking);
		const no = g.guest_sequence || (i + 1);
		const hasName = g.name && g.name !== '-';
		const dispName = g.traveller ? g.name
			: (g.guest_label ? (hasName ? `${g.guest_label} · ${g.name}` : g.guest_label) : g.name);
		const gbook = bnumMap.get(g.booking) || g.booking || '—';
		return `<tr class="mba-rb-tb-row ${cross ? 'is-cross' : ''}" data-reservation="${esc(g.reservation)}" data-col="${col.id}"
				title="${esc(dispName)} · ${esc(g.pax_type || '')}">
			<td class="mba-rb-tb-no">${esc(String(no))}</td>
			<td class="mba-rb-tb-name">${esc(dispName)}</td>
			<td>${esc(g.pax_type || '—')}</td>
			<td>${g.gender ? esc(__(g.gender)).slice(0, 1) : '—'}</td>
			<td>${(g.age != null && g.age !== '') ? esc(String(g.age)) : '—'}</td>
			<td>${esc(String(g.reservation || '—'))}</td>
			<td>${cross ? `<b>${esc(gbook)}</b>` : esc(gbook)}</td>
			<td>${esc(col.stateroom_no || '—')}</td>
			<td>${esc(col.delegate_no || '—')}</td>
			<td>${(g.aroya_guest_no != null && g.aroya_guest_no !== '') ? esc(String(g.aroya_guest_no)) : '—'}</td>
		</tr>`;
	}

	// Padanan kolum dengan penapis semasa (carian + kategori + privacy +
	// confirmed + booking).
	function rb_col_matches(col) {
		if (RB.fcat && col.room_category !== RB.fcat) return false;
		if (RB.fbook && col.booking !== RB.fbook) return false;
		if (RB.fpriv) {
			// '__none__' = bilik tanpa nilai privacy (Unspecified).
			const priv = RB.fpriv === '__none__' ? '' : RB.fpriv;
			if ((col.room_privacy || '') !== priv) return false;
		}
		if (RB.fconf !== '' && (!!col.confirmed) !== (RB.fconf === '1')) return false;
		if (RB.q) {
			const q = RB.q.toLowerCase();
			const roomLabel = col.cabin_no
				? col.booking_number + '-Room_' + col.cabin_no : 'unassigned';
			// Hay carian — bilik (ID auto + ALIAS nama tersuai + CustomRoom_),
			// booking, kategori, stateroom, customer dan nama semua penghuni.
			const hay = [col.booking_number, roomLabel, col.room_id,
				col.custom_name, col.room_category,
				col.stateroom_no, col.customer_name, ...col.guests.map((g) => g.name)]
				.join(' \u0001 ').toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	}

	function rb_board_html() {
		const bookings = [...new Set(RB.cols.map((c) => c.booking))];
		const multi = bookings.length > 1;
		// Kolum FLAT (ungroup) — semua bilik semua booking dalam SATU
		// baris; identiti booking kekal pada tajuk kolum. Pindahan
		// merentas booking dibenarkan untuk bilik Open Sharing sahaja
		// (rujuk rb_move).
		// Senarai penapis booking — HANYA booking dengan lebih daripada 1
		// bilik (single-room booking tidak berfaedah difilter). Dimuat
		// sebagai AUTOCOMPLETE (rujuk rb_bind) supaya boleh dicari.
		// Label: booking no + nama traveller pertama yang sah (fallback
		// nama customer bila traveller tiada) — nama traveller turut boleh
		// dicari dalam penapis.
		RB.fbookOptions = [{ label: __('All Bookings'), value: '' },
			...bookings
				.filter((b) => RB.cols.filter((c) => c.booking === b && c.cabin_no).length > 1)
				.map((b) => {
					const ref = RB.cols.find((c) => c.booking === b);
					const bnum = ref ? ref.booking_number : b;
					const bcols = RB.cols.filter((c) => c.booking === b);
					const trav = (bcols.flatMap((c) => c.guests)
						.map((g) => (g.name && g.name !== '-') ? g.name : '')
						.find(Boolean))
						|| (bcols.find((c) => c.customer_name) || {}).customer_name || '';
					return { label: trav ? `${bnum} - ${trav}` : bnum, value: b };
				})];
		const privOpts = [
			['', __('All Privacy')],
			['Private', __('Private')],
			['Open Sharing', __('Open Sharing')],
			['__none__', __('Unspecified')],
		].map(([v, l]) => `<option value="${esc(v)}" ${v === RB.fpriv ? 'selected' : ''}>${esc(l)}</option>`).join('');
		const confOpts = [
			['', __('All: Confirmed / Not')],
			['1', __('Confirmed')],
			['0', __('Not Confirmed')],
		].map(([v, l]) => `<option value="${esc(v)}" ${v === RB.fconf ? 'selected' : ''}>${esc(l)}</option>`).join('');
		const nVisible = RB.cols.filter(rb_col_matches).length;

	return `<div class="mba-rb ${RB.mode === 'table' ? 'mode-table' : ''}">
		<div class="mba-rb-toolbar">
				<div class="btn-group mba-rb-mode" role="group" title="${esc(__('View mode'))}">
					<button type="button" class="btn btn-default btn-sm ${RB.mode !== 'table' ? 'btn-primary' : ''}" data-mode="grid"
						title="${esc(__('Grid view — kanban rooms'))}">▦</button>
					<button type="button" class="btn btn-default btn-sm ${RB.mode === 'table' ? 'btn-primary' : ''}" data-mode="table"
						title="${esc(__('Table view — reservations by booking / room'))}">☰</button>
				</div>
				${TravelBookingSearchBox.html({
					cls: 'mba-rb-q',
					placeholder: __('Search room / booking / customer / traveller / stateroom...'),
					value: RB.q,
				})}
				<div class="mba-rb-fcat-wrap" title="${__('Filter room category — searchable')}"></div>
				<select class="mba-rb-fpriv" title="${__('Filter room privacy')}">${privOpts}</select>
				<select class="mba-rb-fconf" title="${__('Filter room arrangement confirmation')}">${confOpts}</select>
				${multi ? `<div class="mba-rb-fbook-wrap" title="${__('Filter booking — bookings with more than 1 room')}"></div>` : ''}
				<span class="mba-rb-count">${nVisible}/${RB.cols.length} ${__('rooms')}</span>
			</div>
			<div class="mba-rb-cols"></div>
			<div class="mba-rb-tablewrap"></div>
		</div>`;
	}

	// Cari kolum ikut id draf.
	function rb_col(id) { return RB.cols.find((c) => c.id === id); }

	// docname booking → booking_number (tooltip/paparan; objek guest
	// hanya bawa docname booking).
	function bnum_of(booking) {
		const col = RB.cols.find((c) => c.booking === booking);
		return (col && col.booking_number) || booking || '';
	}

	// Label Room ID AUTO untuk bilik — '[booking_number]-Room_[cabin_no]'
	// (mirror assign_room_id() doctype).
	function rb_auto_room_id(col) {
		return col.cabin_no ? `${col.booking_number}-Room_${col.cabin_no}` : '';
	}

	// Label Room ID untuk MODAL (Current Room ID / notis drag) — FORMAT
	// BETUL 'BOOKING_NO-Room_<cabin>' (rujuk spesifikasi room_id), TANPA
	// tambahan. booking_number (cth 'R3FEPM42609'), BUKAN docname Booking
	// (kolum `name` DB) — itulah punca format salah pada modal sebelum ni.
	// Nama alias (Booking Room Alias) sengaja TIDAK dilampirkan di sini:
	// ia nama paparan mesra untuk TAJUK KOLUM sahaja, dan alias lama
	// pernah mengandungi ID mekanikal bilik lain (patch v33 salah tafsir
	// penempatan Open Sharing merentas booking) — campurannya menghasilkan
	// label berpanjangan seperti 'X-Room_1 (Y-Room_1)' yang mengelirukan.
	function rb_room_label(col) {
		if (!col.cabin_no) return __('Unassigned');
		return rb_auto_room_id(col);
	}

	// Paparan utama kolum/kad — nama tersuai jika ada, else label auto.
	function rb_room_display(col) {
		// Bilik CustomRoom_ (cabin 0) — papar nama CustomRoom_ sendiri.
		if (col.custom_name && (col.cabin_no || col.isCustom)) return col.custom_name;
		return (col.cabin_no
			? `${col.booking_number} · ${__('Room')} ${col.cabin_no}`
			: __('Unassigned'));
	}

	// Label ringkas kolum untuk mesej — 'BKxxx · Room N' / nama CustomRoom_
	// / 'Unassigned'.
	const roomLabel = (c) => (c.cabin_no
		? c.booking_number + ' · Room ' + c.cabin_no
		: (c.isCustom ? (c.room_id || c.custom_name || 'CustomRoom_') : 'Unassigned'));

	// RENAME NAMA PAPARAN bilik — klik ikon ✎ pada tajuk kolum → input
	// inline. Enter/blur = komit (endpoint rename_booking_room — alias
	// Booking Room Alias, BERASINGAN daripada room_id mekanikal);
	// Escape = batal. Kosong = padam alias (kembali label auto).
	async function rb_start_rename($col) {
		const col = rb_col(String($col.data('col')));
		if (!col || !col.cabin_no || $col.find('.mba-rb-rename-input').length) return;
		const $span = $col.find('.mba-rb-col-id');
		const $input = $(`<input type="text" class="form-control mba-rb-rename-input" />`)
			.val(col.custom_name || '');
		$span.replaceWith($input);
		$input.trigger('focus').trigger('select');

		let committed = false;
		const commit = async () => {
			if (committed) return;
			committed = true;
			const v = String($input.val() || '').trim();
			try {
				const out = await api('rename_booking_room', {
					booking: col.booking, cabin_no: col.cabin_no, custom_name: v,
				});
				col.custom_name = (out && out.custom_name) || '';
			} catch (e) {
				// api() dah papar alert — nilai kolum tak berubah
			}
			rb_render();
		};
		$input.on('keydown', function (ev) {
			if (ev.key === 'Enter') { ev.preventDefault(); $input.trigger('blur'); }
			else if (ev.key === 'Escape') { committed = true; rb_render(); }
		});
		$input.on('blur', commit);
	}

	// Kriteria pax-type bilik sasaran SELEPAS mutasi — mirror
	// validate_cabin_capacity doctype: Extra Bed hanya bila Main Guest
	// penuhi kapasiti asas; Infant perlu ≥1 Main Guest.
	function rb_target_pax_ok(col) {
		const mains = col.guests.filter((g) => (g.pax_type || '') === 'Main Guest').length;
		if (col.guests.some((g) => (g.pax_type || '') === 'Extra Bed')
			&& col.capacity > 0 && mains < col.capacity) return false;
		if (col.guests.some((g) => (g.pax_type || '') === 'Infant') && mains < 1) return false;
		return true;
	}

	// Validasi perpindahan TANPA mutasi — dikongsi oleh rb_move (draf
	// sebenar), rb_move_dialog (pra-tapis senarai bilik sasaran) dan
	// rb_move_notice (pemeriksaan pra-papar notis drag). Kriteria tetamu:
	// room_category sama, peraturan kapasiti & pax-type sasaran+sumber,
	// dan pindahan merentas booking hanya ke bilik Open Sharing.
	// Pulangkan senarai masalah (array kosong = layak; null = bukan
	// perpindahan).
	function rb_move_reject(guest, src, target) {
		if (!src || !target || src.id === target.id) return null;   // bukan perpindahan
		const problems = [];
		// UNASSIGNED (cabin 0, bukan CustomRoom_) = "tiada penempatan" —
		// sentiasa sah, tiada kriteria bilik untuk dipadankan; hanya
		// peraturan pax-type BILIK SUMBER selepas pemergian tetap berjalan
		// (bawah). Bilik CustomRoom_ (cabin 0 + isCustom) pula bilik
		// SEBENAR ad-hoc — penghuni baharu mesti lulus validasi penuh
		// (kategori / kapasiti / pax-type / Open Sharing).
		if (!target.cabin_no && !target.isCustom) {
			const srcGuestsAfter = src.guests.filter((g) => g.reservation !== guest.reservation);
			const mainsS = srcGuestsAfter.filter((g) => (g.pax_type || '') === 'Main Guest').length;
			if (srcGuestsAfter.some((g) => (g.pax_type || '') === 'Extra Bed')
				&& src.capacity > 0 && mainsS < src.capacity)
				problems.push(__('Leaving would keep Extra Bed without full Main Guest capacity'));
			if (srcGuestsAfter.some((g) => (g.pax_type || '') === 'Infant') && mainsS < 1)
				problems.push(__('Leaving would keep Infant without any Main Guest'));
			return problems;
		}
		// kategori mesti sepadan
		if (target.room_category && guest.room_category
				&& target.room_category !== guest.room_category) {
			problems.push(__('Category mismatch — guest is in "{0}", target room is "{1}"',
				[guest.room_category, target.room_category]));
			return problems;
		}
		// kapasiti sasaran
		if (target.max_capacity > 0 && target.guests.length + 1 > target.max_capacity) {
			problems.push(__('Over capacity ({0}/{1})', [target.guests.length, target.max_capacity]));
			return problems;
		}
		// simulasi peraturan pax-type (sasaran selepas ketibaan + sumber
		// selepas pemergian) — mirror validate_cabin_capacity doctype
		const srcGuestsAfter = src.guests.filter((g) => g.reservation !== guest.reservation);
		const mainsT = target.guests.filter((g) => (g.pax_type || '') === 'Main Guest').length + 1;
		const withGuest = target.guests.concat([guest]);
		if (target.capacity > 0 && mainsT > target.capacity)
			problems.push(__('Main Guest exceeds base capacity ({0})', [target.capacity]));
		if (withGuest.some((g) => (g.pax_type || '') === 'Extra Bed')
			&& target.capacity > 0 && mainsT < target.capacity)
			problems.push(__('Extra Bed requires full Main Guest capacity'));
		if (withGuest.some((g) => (g.pax_type || '') === 'Infant') && mainsT < 1)
			problems.push(__('Infant needs at least 1 Main Guest'));
		const mainsS = srcGuestsAfter.filter((g) => (g.pax_type || '') === 'Main Guest').length;
		if (srcGuestsAfter.some((g) => (g.pax_type || '') === 'Extra Bed')
			&& src.capacity > 0 && mainsS < src.capacity)
			problems.push(__('Leaving would keep Extra Bed without full Main Guest capacity'));
		if (srcGuestsAfter.some((g) => (g.pax_type || '') === 'Infant') && mainsS < 1)
			problems.push(__('Leaving would keep Infant without any Main Guest'));
		// merentas booking → Open Sharing sahaja
		if (target.booking !== guest.booking && target.room_privacy !== 'Open Sharing')
			problems.push(__('Not Open Sharing — cross-booking moves need Open Sharing'));
		return problems;
	}

	// Mutasi draf TERUS — tiada pengesahan per langkah; perpindahan
	// terkumpul dalam papan dan DB hanya ditulis SEKALI hujung melalui
	// butang "Save Arrangement" (rb_save). Peraturan:
	// 1. KRITERIA — room_category tetamu MESTI sama dengan bilik sasaran
	//    (satu cabin satu kategori; TIDAK lagi diadaptasi senyap); had
	//    max_capacity; peraturan pax-type (Extra Bed/Infant) bilik
	//    sasaran selepas ketibaan tetamu. Melanggar → DISEKAT + alert.
	// 2. MERENTAS BOOKING — hanya ke bilik Open Sharing (reservation
	//    kekal milik booking asal; membawa room_id bilik sasaran).
	// 3. SIMPAN TERTUNDA: perpindahan sah terus masuk draf (guest
	//    sequence ikut penghuni sasaran; Room ID dijana semula server
	//    semasa save).
	// 4. CUSTOM ARRANGEMENT — tetamu ber-declaration custom (lock 🔒)
	//    TIDAK boleh dipindah; unchecked declaration pada modal Move
	//    Guest dahulu (server meng-enforce sama di arrange_group_rooming).
	function rb_move(resv, target) {
		const src = RB.cols.find((c) => c.guests.some((g) => g.reservation === resv));
		if (!src || !target || src.id === target.id) return;
		const gi = src.guests.findIndex((g) => g.reservation === resv);
		if (gi < 0) return;
		const guest = src.guests[gi];
		const dispName = (guest.name && guest.name !== '-') ? guest.name
			: (guest.guest_label || resv);

		// ── LOCK: bilik disahkan — panel Confirmed tidak boleh berubah ──
		if (src.confirmed || target.confirmed) {
			frappe.msgprint({
				title: __('Cannot move — room confirmed'),
				message: __('Room arrangement is confirmed. Uncheck "Confirmed" on the room panel first.'),
				indicator: 'red',
			});
			return;
		}

		const problems = rb_move_reject(guest, src, target);
		if (problems && problems.length) {
			frappe.msgprint({
				title: __('Cannot move — room criteria'),
				message: problems.map((p) => '<div>• ' + esc(p) + '</div>').join(''),
				indicator: 'red',
			});
			return;
		}

		// ── TERAP perpindahan ke draf terus (tiada bar pengesahan) —
		//    semua perubahan terkumpul; simpan muktamad melalui butang
		//    "Save Arrangement" sahaja. Guest sequence ikut penghuni
		//    sasaran (kecuali admin dah set nilai/reset pada modal —
		//    nilai modal menang); Room ID (regenerasi / penempatan
		//    merentas booking) dijana server semasa save. ──
		const cross = target.booking !== guest.booking;
		src.guests.splice(gi, 1);
		if (target.room_category) guest.room_category = target.room_category;
		guest._crossRoomId = (cross && target.room_privacy === 'Open Sharing')
			? (target.room_id || `${target.booking_number}-Room_${target.cabin_no}`) : '';
		// Guest sequence — ikut penghuni sasaran pada SETIAP perpindahan
		// (drag berturut-turut menimpa nombor drag sebelumnya); nilai yang
		// admin set secara EKSPLISIT pada modal (_seqByModal) dikecualikan —
		// niat admin menang.
		if (!guest._seqByModal) guest._newSeq = target.guests.length + 1;
		target.guests.push(guest);
		rb_render();
	}

	function rb_render() {
		if (!RB.$view) return;
		// Render semula KOLUM + TABLE — toolbar (carian/penapis) kekal
		// dalam DOM supaya fokus input & pilihan select tidak terganggu.
		// Kedua-dua view kongsi senarai `visible` yang sama (penapis
		// carian/kategori/privacy/confirmed/booking mempengaruhi keduanya).
		const visible = RB.cols.filter(rb_col_matches);
		const $cols = RB.$view.find('.mba-rb-cols');
		if ($cols.length) {
			$cols.html(visible.length
				? visible.map((c) => rb_col_html(c)).join('')
				: `<div class="mba-rb-empty">${__('No rooms match this filter.')}</div>`);
			// Select kategori kolum kini AUTOCOMPLETE — control perlu
			// dijana semula selepas setiap render DOM kolum.
			rb_mount_cat_autocomplete($cols);
		}
		const $tbl = RB.$view.find('.mba-rb-tablewrap');
		if ($tbl.length) {
			$tbl.html(visible.length
				? rb_table_html(visible)
				: `<div class="mba-rb-empty">${__('No rooms match this filter.')}</div>`);
		}
		const $cnt = RB.$view.find('.mba-rb-count');
		if ($cnt.length) {
			const n = RB.cols.filter(rb_col_matches).length;
			$cnt.text(`${n}/${RB.cols.length} ${__('rooms')}`);
		}
		// Butang footer es-button — tukar label span sahaja supaya
		// struktur spinner kekal (rujuk Dialog.set_btn_label).
		const $btn = RB.$view ? RB.$view.find('.mba-rb-save') : null;
		if ($btn && $btn.length) {
			const n = rb_changes();
			$btn.text(n
				? __('Save Arrangement') + ' (' + n + ')' : __('Save Arrangement'));
		}
	}

	// Mount control Autocomplete untuk select kategori bilik KOLUM —
	// dipanggil selepas setiap render DOM kolum (rb_render) kerana HTML
	// kolum dibina semula. Senarai opsyen = kategori penuh doctype Trip
	// Price Category (match jenis trip) + "No Category"; state disimpan
	// pada kolum (bukan control) supaya render semula kekal nilai terkini.
	function rb_mount_cat_autocomplete($scope) {
		$scope.find('.mba-rb-cat-wrap').each(function () {
			const colId = String($(this).closest('.mba-rb-col').data('col'));
			const col = rb_col(colId);
			if (!col || $(this).children().length) return;
			const catAc = frappe.ui.form.make_control({
				df: {
					fieldtype: 'Autocomplete',
					fieldname: 'rb_col_cat',
					placeholder: __('No category'),
					max_items: Infinity,
					options: [{ label: __('No category'), value: '' },
						...Object.keys(RB.categories).map((c) => ({ label: c, value: c }))],
					change: () => {
						const val = (catAc.get_value() || '').trim();
						if (col.confirmed || val === col.room_category) return;
						col.room_category = val;
						const meta = RB.categories[val] || {};
						col.capacity = meta.capacity || 0;
						col.max_capacity = meta.max_capacity || 0;
						col.guests.forEach((g) => { g.room_category = val; });
						rb_render();
					},
				},
				parent: this,
				render_input: true,
				only_input: true,
			});
			catAc.set_value(col.room_category || '');
			// Bilik disahkan — kategori turut dikunci bersama panel.
			// (Control Frappe TIADA set_disabled() — read_only + refresh +
			// disabled pada input; guard change handler lapis kedua.)
			if (col.confirmed) {
				catAc.df.read_only = 1;
				catAc.refresh();
				if (catAc.$input) catAc.$input.prop('disabled', true);
			}
		});
	}

	// Bilangan langkah berubah (tetamu pindah kolum / penempatan merentas
	// booking / kolum baharu / edit modal Move Guest / edit panel sifat
	// bilik) — untuk label butang & pengesahan buang perubahan sahaja;
	// payload save kekal PLACEMENT PENUH.
	function rb_changes() {
		let n = 0;
		for (const col of RB.cols) {
			if (col.isNew) {
				n += col.guests.length;
				continue;
			}
			n += col.guests.filter((g) =>
				(g._origCabin !== undefined && g._origCabin !== (col.cabin_no || 0))
				|| (g._crossRoomId || '') !== (g._origCross || '')
				// Edit modal Move Guest — sequence (0=reset) / aroya.
				|| (g._newSeq === 0 || !!g._newSeq)
				|| (g._aroya != null && g._aroya !== String(g.aroya_guest_no || ''))).length;
			// Edit PANEL sifat bilik (kategori/privacy/stateroom/delegate/
			// confirmed) — dibandingkan dengan snapshot _origProps.
			const o = col._origProps;
			if (o && ((col.room_category || '') !== o.category
				|| (col.room_privacy || '') !== o.privacy
				|| (col.stateroom_no || '') !== o.stateroom
				|| (col.delegate_no || '') !== o.delegate
				|| !!col.confirmed !== o.confirmed)) n += 1;
		}
		return n;
	}

	// Render Rooming Board sebagai VIEW PENUH dalam #mba-detail (route
	// /app/manage-booking-app/rooming/<kind>/<id>) — BUKAN modal lagi:
	// modal bertindih menyebabkan backdrop tersekat & perlu refresh page.
	// View route menyokong SPA navigation (back/forward tanpa reload).
	async function open_rooming_board(key) {
		const it = find_item(key);
		if (!it) return;
		let rm = S.cache[key]?.rooming;

		// Board perlu senarai PENUH — deep-link (cache kosong) ATAU tab
		// terhad limit carian/penapis → muat semula tanpa penapis.
		if (!rm || (rm.count || 0) > (rm.shown || 0)
			|| S.state[key]?.rm?.search || S.state[key]?.rm?.privacy) {
			const groups = it.members.map((m) => m.name);
			rm = await api('get_group_rooming', { trip_groups: groups, limit: 0 });
		}

		RB.key = key;
		RB.fcatAc = null; RB.fbookAc = null;   // instance lama dibuang bersama DOM
		rb_reset_cols(rm);

		const title = it.batch ? it.batch : (it.members[0].trip_group_name || it.members[0].name);
		const backRoute = ['manage-booking-app',
			it.batch ? 'batch' : 'group', it.batch || it.members[0].name];
		$('#mba-detail').html(`
			<div class="mba-rbview" data-item="${esc(key)}">
				<div class="mba-rbview-head">
					<button type="button" class="btn btn-default btn-sm mba-rbview-back"
						title="${esc(__('Back to group detail'))}">← ${__('Back')}</button>
					<div class="mba-rbview-title">
						<b>${__('Rooming Board')}</b>
						<span class="mba-muted">— ${esc(title)}</span>
					</div>
					<button type="button" class="btn btn-primary btn-sm mba-rb-save">${__('Save Arrangement')}</button>
				</div>
				<div class="mba-rbview-body">
					${rb_board_html()}
				</div>
			</div>`);
		RB.$view = $('#mba-detail .mba-rbview');
		RB.$view.find('.mba-rbview-back').on('click', () => {
			rb_unwatch_realtime();
			frappe.set_route(...backRoute);
		});
		RB.$view.find('.mba-rb-save').on('click', () => rb_save(key));

		rb_bind();
		rb_watch_realtime(key);
		rb_render();   // isi kolum (toolbar statik, kolum dirender berasingan)
	}

	// Reset kolum draf dari payload get_group_rooming — dikongsi oleh
	// open_rooming_board (muat pertama) dan rb_reload (segar semula
	// selepas save sendiri ATAU siaran realtime admin lain).
	function rb_reset_cols(rm) {
		RB.categories = rm.categories || {};
		RB.seq = 0;
		RB.cols = rb_build_cols(rm);
		RB.q = ''; RB.fcat = ''; RB.fpriv = ''; RB.fconf = ''; RB.fbook = '';
	for (const col of RB.cols) {
		// Snapshot sifat bilik ASAL (payload server) — pembanding
		// rb_changes untuk edit panel (kategori/privacy/stateroom/
		// delegate/confirmed); tanpa ni edit panel tidak dikira dan
		// siaran realtime admin lain boleh buang draf secara senyap.
		col._origProps = {
			category: col.room_category || '',
			privacy: col.room_privacy || '',
			stateroom: col.stateroom_no || '',
			delegate: col.delegate_no || '',
			confirmed: !!col.confirmed,
		};
		col.guests.forEach((g) => {
			g._origCabin = col.cabin_no || 0;   // asal save-guard from_cabin_no
			g._origCross = '';   // room_id eksplisit asal (tiada bila mulai)
			g.room_category = g.room_category || col.room_category;
		});
	}
	}

	// Tarik payload SEGAR dari server & bina semula papan (senarai PENUH
	// limit 0) — nombor, Room ID & susunan mencerminkan DB terkini.
	async function rb_reload(key) {
		const it = find_item(key);
		if (!it) return;
		const groups = it.members.map((m) => m.name);
		const rm = await api('get_group_rooming', { trip_groups: groups, limit: 0 });
		if (S.cache[key]) S.cache[key].rooming = rm;
		rb_reset_cols(rm);
		if (RB.fcatAc && RB.fcatAc.set_value) RB.fcatAc.set_value('');
		if (RB.fbookAc && RB.fbookAc.set_value) RB.fbookAc.set_value('');
		// Selaraskan kotak carian papan — RB.q sudah direset; kosongkan
		// input & semula butang ✕ (trigger 'input' → handler RB.q). ✓
		if (RB.$view) RB.$view.find('.mba-rb-q').val('').trigger('input');
		rb_render();
	}

	// ── Realtime: papan berbilang admin ──
	// arrange_group_rooming menerbitkan 'travel_booking_rooming_updated'
	// (selepas commit, medan 'by' = pengguna penyimpan). Bila admin LAIN
	// menyimpan rooming group yang sama: tiada perubahan tertangguh → muat
	// semula SENYAP dari server; ada draf belum disimpan → amaran (jangan
	// buang kerja admin tanpa kebenaran) — gabungan ini + save-guard
	// from_cabin_no menutup jurang last-write-wins antara dua papan yang
	// dibuka serentak.
	//
	// ECHO SENDIRI DIABAIKAN: siaran server sampai ke SEMUA pengguna,
	// termasuk penyimpan — echo tu tiba sebelum rb_save sempat reload
	// papan (draf masih nampak "pending"), jadi tanpa guard ni SETIAP
	// save sendiri akan salah cetak amaran "another user updated".
	// Dua lapis: (a) medan 'by' sepadan session semasa; (b) RB._echoGuard
	// aktif sepanjang tetingkap save→reload (lapisan untuk server lama
	// tanpa medan 'by').
	const RB_RT_EVENT = 'travel_booking_rooming_updated';

	function rb_unwatch_realtime() {
		if (RB._rtHandler && frappe.realtime) {
			frappe.realtime.off(RB_RT_EVENT, RB._rtHandler);
		}
		RB._rtHandler = null;
	}

	function rb_watch_realtime(key) {
		rb_unwatch_realtime();
		if (!frappe.realtime || typeof frappe.realtime.on !== 'function') return;
		const it = find_item(key);
		const myGroups = new Set((it ? it.members : []).map((m) => m.name));
		RB._rtHandler = (data) => {
			// Abaikan bila papan ini dah ditutup / diganti papan lain.
			if (RB.key !== key || !RB.$view || !RB.$view.length) return;
			// Abaikan ECHO save sendiri — papan ini reload sendiri selepas
			// save (rb_save); tiada keperluan notis/amran.
			if (RB._echoGuard || (data && data.by && data.by === frappe.session.user)) return;
			const changedGroups = (data && data.trip_groups) || [];
			if (!myGroups.size || !changedGroups.some((g) => myGroups.has(g))) return;
			if (!rb_changes()) { rb_reload(key); return; }
			frappe.show_alert({
				message: __('Another user just updated this rooming board — your view may be stale. Save soon or reload to see their changes.'),
				indicator: 'orange',
			});
		};
		frappe.realtime.on(RB_RT_EVENT, RB._rtHandler);
	}

	function rb_bind() {
		const $b = RB.$view;

		// ── Penapis KATEGORI — AUTOCOMPLETE boleh cari (senarai penuh
		//    Trip Price Category, match jenis trip). "All Categories" =
		//    nilai kosong. ──
		const $fcatWrap = $b.find('.mba-rb-fcat-wrap');
		if ($fcatWrap.length) {
			RB.fcatAc = frappe.ui.form.make_control({
				df: {
					fieldtype: 'Autocomplete',
					fieldname: 'rb_fcat',
					placeholder: __('All Categories'),
					max_items: Infinity,
					options: [{ label: __('All Categories'), value: '' },
						...Object.keys(RB.categories).map((c) => ({ label: c, value: c }))],
					change: () => {
						RB.fcat = (RB.fcatAc && RB.fcatAc.get_value()) || '';
						rb_render();
					},
				},
				parent: $fcatWrap.get(0),
				render_input: true,
				only_input: true,
			});
			// Butang ✕ standard (TravelBookingSearchBox.attach) — set_value('')
			// ialah lalai canonical control (kosongkan nilai dalaman + teks +
			// trigger change → RB.fcat reset + rb_render). get_value → nilai
			// EFEKTIF control untuk keterlihatan ✕ (teks input Autocomplete
			// kekal label opsyen kosong "All Categories" walaupun nilai '').
			TravelBookingSearchBox.attach(RB.fcatAc.$wrapper, {
				on_clear: () => RB.fcatAc.set_value(''),
				get_value: () => (RB.fcatAc && RB.fcatAc.get_value()) || '',
			});
		}

		// ── Penapis booking — AUTOCOMPLETE (boleh dicari; senarai hanya
		//    booking dengan lebih daripada 1 bilik, rujuk rb_board_html).
		//    Corak make_control + Autocomplete seperti Data Import. ──
		const $fwrap = $b.find('.mba-rb-fbook-wrap');
		if ($fwrap.length && RB.fbookOptions && RB.fbookOptions.length > 1) {
			RB.fbookAc = frappe.ui.form.make_control({
				df: {
					fieldtype: 'Autocomplete',
					fieldname: 'rb_fbook',
					placeholder: __('All Bookings'),
					options: RB.fbookOptions,
					change: () => {
						RB.fbook = (RB.fbookAc && RB.fbookAc.get_value()) || '';
						rb_render();
					},
				},
				parent: $fwrap.get(0),
				render_input: true,
				only_input: true,
			});
			// Butang ✕ standard (TravelBookingSearchBox.attach) — rujuk
			// komen attach fcat di atas (set_value + get_value).
			TravelBookingSearchBox.attach(RB.fbookAc.$wrapper, {
				on_clear: () => RB.fbookAc.set_value(''),
				get_value: () => (RB.fbookAc && RB.fbookAc.get_value()) || '',
			});
		}

		// ── Drag & drop (desktop; HTML5 native, tanpa dependency) ──
		// Kolum is-confirmed (panel Confirmed) — kad tak boleh ditarik
		// keluar dan bilik tak menerima drop.
		$b.on('dragstart', '.mba-rb-card', function (ev) {
			if ($(this).closest('.mba-rb-col.is-confirmed').length) {
				ev.preventDefault();
				return;
			}
			ev.originalEvent.dataTransfer.setData('text/plain', $(this).data('reservation'));
			ev.originalEvent.dataTransfer.effectAllowed = 'move';
			$(this).addClass('is-dragging');
		});
		$b.on('dragend', '.mba-rb-card', function () { $(this).removeClass('is-dragging'); });
		$b.on('dragover', '.mba-rb-col-body', function (ev) {
			// Tanpa preventDefault — drop ke bilik disahkan tidak dibenarkan.
			if ($(this).closest('.mba-rb-col.is-confirmed').length) return;
			ev.preventDefault();
			ev.originalEvent.dataTransfer.dropEffect = 'move';
			$(this).closest('.mba-rb-col').addClass('is-drop');
		});
		$b.on('dragleave', '.mba-rb-col-body', function () {
			$(this).closest('.mba-rb-col').removeClass('is-drop');
		});
		$b.on('drop', '.mba-rb-col-body', function (ev) {
			if ($(this).closest('.mba-rb-col.is-confirmed').length) return;
			ev.preventDefault();
			$(this).closest('.mba-rb-col').removeClass('is-drop');
			const resv = ev.originalEvent.dataTransfer.getData('text/plain');
			const col = rb_col(String($(this).data('col')));
			if (resv && col) rb_drop_move(String(resv), col);
		});

		// ── Rename Room ID — ikon ✎ pada tajuk kolum ──
		$b.on('click', '.mba-rb-rename', function (ev) {
			ev.stopPropagation();
			const $col = $(this).closest('.mba-rb-col');
			// Panel disahkan — rename turut dikunci (butang pun disabled).
			if ($col.hasClass('is-confirmed')) return;
			rb_start_rename($col);
		});

		// ── Klik kad (semua saiz) → dialog pindah — laluan mobile ──
		$b.on('click', '.mba-rb-card', function () {
			const resv = String($(this).data('reservation'));
			const src = RB.cols.find((c) => c.guests.some((g) => g.reservation === resv));
			const guest = src && src.guests.find((g) => g.reservation === resv);
			if (guest) rb_move_dialog(guest, src);
		});

		// ── Kolum: sifat bilik (kategori / stateroom / privacy / confirmed) ──
		// Guard col.confirmed — panel disahkan dikunci penuh (semua control
		// disabled; guard ini lapis kedua).
		$b.on('change', '.mba-rb-cat', function () {
			const col = rb_col(String($(this).closest('.mba-rb-col').data('col')));
			if (!col || col.confirmed) return;
			col.room_category = $(this).val();
			const meta = RB.categories[col.room_category] || {};
			col.capacity = meta.capacity || 0;
			col.max_capacity = meta.max_capacity || 0;
			col.guests.forEach((g) => { g.room_category = col.room_category; });
			rb_render();
		});
		// Stateroom & Delegate No — terkunci bersama panel bila disahkan
		// (control disabled; guard ini lapis kedua).
		$b.on('change input', '.mba-rb-stateroom', function () {
			const col = rb_col(String($(this).closest('.mba-rb-col').data('col')));
			if (!col || col.confirmed) return;
			col.stateroom_no = $(this).val();
		});
		$b.on('change input', '.mba-rb-delegate', function () {
			const col = rb_col(String($(this).closest('.mba-rb-col').data('col')));
			if (!col || col.confirmed) return;
			col.delegate_no = $(this).val();
		});
		$b.on('change', '.mba-rb-privacy', function () {
			const col = rb_col(String($(this).closest('.mba-rb-col').data('col')));
			if (!col || col.confirmed) return;
			col.room_privacy = $(this).val();
		});
		// Checkbox Confirmed kekal BOLEH diklik — ia kunci/buka kunci
		// panel; render semula untuk pakai class is-confirmed + disabled.
		$b.on('change', '.mba-rb-confirmed', function () {
			const col = rb_col(String($(this).closest('.mba-rb-col').data('col')));
			if (!col) return;
			col.confirmed = $(this).is(':checked');
			rb_render();
		});

		// ── Mod paparan: Grid (kanban) | Table (senarai reservation) ──
		// Toggle class pada root .mba-rb — CSS yang sorang view; kandungan
		// kedua-dua view dirender serentak oleh rb_render.
		$b.on('click', '.mba-rb-mode button', function () {
			const mode = String($(this).data('mode') || 'grid');
			if (mode === RB.mode) return;
			RB.mode = mode;
			$b.find('.mba-rb-mode button').removeClass('btn-primary')
				.filter(`[data-mode="${mode}"]`).addClass('btn-primary');
			$b.find('.mba-rb').toggleClass('mode-table', mode === 'table');
		});

		// ── Table view — klik baris reservation → dialog Move Guest
		//    (pariti interaksi dengan kad kanban; bilik disahkan kekal
		//    baca sahaja melalui guard rb_move_dialog). ──
		$b.on('click', '.mba-rb-tb-row', function () {
			const resv = String($(this).data('reservation') || '');
			const col = rb_col(String($(this).data('col') || ''));
			const guest = col && col.guests.find((g) => String(g.reservation) === resv);
			if (guest) rb_move_dialog(guest, col);
		});

		// ── Saringan bilik: carian (debounce) + penapis kategori/privacy/
		//    confirmed/booking ──
		$b.on('input', '.mba-rb-q', debounce(function () {
			RB.q = $(this).val();
			rb_render();
		}, 250));
		$b.on('change', '.mba-rb-fpriv', function () {
			RB.fpriv = $(this).val();
			rb_render();
		});
		$b.on('change', '.mba-rb-fconf', function () {
			RB.fconf = $(this).val();
			rb_render();
		});
	}

	// Dialog pindah tetamu — TABS + dua form berasingan:
	// • TAB [Update Info] — form kemaskini maklumat tetamu (satu form):
	//     Room Arrangement (kolum KIRI, vertical): room_id (ro, format auto
	//     BOOKING_NO-Room_N), cabin_no (ro), guest_sequence (EDITABLE —
	//     kosong utk auto) · Cruise Arrangement (kolum KANAN, vertical):
	//     stateroom_no (ro), delegate_no (ro), aroya_guest_no (EDITABLE)
	//     + butang Save Details + butang
	//     Reset Rooming Number — semua dalam form yang sama.
	// • TAB [Move] — form pindah: bilik semasa (room id format betul) +
	//     New Room AUTOCOMPLETE BOLEH CARI yang MULA KOSONG: senarai =
	//     bilik layak PRA-TAPIS rb_move_reject (room_category sama,
	//     kapasiti & pax-type sah, merentas booking hanya Open Sharing) +
	//     "No Arrangement (Unassigned)". PILIHAN KOSONG = TIADA
	//     PENEMPATAN — tetamu dikeluarkan dari bilik (cabin 0, kolum
	//     Unassigned booking sendiri); butang bertukar label "Remove
	//     Arrangement". Laluan utama mobile (drag tak berfungsi pada
	//     touch).
	// Reset Rooming Number — DRAF TETAMU INI SAHAJA: pratonton susunan
	// asal (SO utama booking) melalui get_booking_rooming_source_order,
	// kemudian tetamu dipindahkan dalam DRAF ke cabin asalnya (sequence
	// ikut penghuni sasaran — papan kekal menunjukkan draf lain). DB
	// ditulis SEKALI hujung oleh "Save Arrangement" (rb_save), sama
	// seperti perpindahan biasa — TIADA reload papan / tiada buang draf.
	function rb_move_dialog(guest, srcCol) {
		// Bilik sumber disahkan — dialog jadi BACA SAHAJA (lihat blok
		// confLock di bawah).
		const confLock = !!srcCol.confirmed;
		// Senarai sasaran HANYA bilik yang LAYAK (kriteria dipadankan);
		// bilik semasa & bilik disahkan dikecualikan.
		const cols = RB.cols.filter((c) => c.id !== srcCol.id && !c.confirmed
			&& !(rb_move_reject(guest, srcCol, c) || []).length);
		// Room ID semasa — sentiasa FORMAT AUTO BOOKING_NO-Room_<cabin>
		// (rujuk rb_room_label; BUKAN docname booking).
		const curRoomId = rb_room_label(srcCol);
		const dispName = (guest.name && guest.name !== '-') ? guest.name
			: (guest.guest_label || guest.reservation);
		const d = new frappe.ui.Dialog({
			title: __('Move Guest') + ' — ' + dispName,
		});
		// Label opsyen sasaran — FORMAT: Room_ID - Room Type - Privacy
		// Type - Traveller (atau customer name bila traveller tiada).
		const optLabel = (c) => {
			if (!c.cabin_no && !c.isCustom)
				return __('No Arrangement (Unassigned)') + ' — ' + c.guests.length;
			const rid = c.isCustom ? (c.room_id || c.custom_name) : rb_room_label(c);
			// Nama traveller penghuni pertama yang sah; fallback customer.
			const trav = (c.guests.map((g) =>
				(g.name && g.name !== '-') ? g.name : '').find(Boolean))
				|| c.customer_name || '—';
			return [rid, c.room_category || '—', c.room_privacy || '—', trav].join(' - ');
		};
		d.$body.html(`
			<div class="mba-rb-move">
				<div class="mba-rb-mv-tabs" role="tablist">
					<button type="button" class="mba-rb-mv-tab active" data-tab="update">${__('Update Info')}</button>
					<button type="button" class="mba-rb-mv-tab" data-tab="move">${__('Move')}</button>
				</div>

				<div class="mba-rb-mv-pane active" data-pane="update">
					<div class="mba-rb-mv-cols">
						<div class="mba-rb-mv-col">
							<div class="mba-rb-mv-sub-title">${__('Room Arrangement')}</div>
							<label>${__('Room ID')}
								<input type="text" class="form-control mba-rb-mv-roomid" value="${esc(curRoomId)}" readonly /></label>
							<label>${__('Cabin No')}
								<input type="text" class="form-control mba-rb-mv-cabin" value="${esc(srcCol.cabin_no || '—')}" readonly /></label>
							<label>${__('Guest Sequence')}
								<input type="number" min="0" class="form-control mba-rb-mv-seq" value="${esc(guest.guest_sequence || '')}"
									placeholder="${esc(__('auto'))}" /></label>
						</div>
						<div class="mba-rb-mv-col">
							<div class="mba-rb-mv-sub-title">${__('Cruise Arrangement')}</div>
							<label>${__('Stateroom No')}
								<input type="text" class="form-control mba-rb-mv-stateroom" value="${esc(srcCol.stateroom_no || '')}" /></label>
							<label>${__('Delegate No')}
								<input type="text" class="form-control mba-rb-mv-delegate" value="${esc(srcCol.delegate_no || '')}" /></label>
							<label>${__('Aroya Guest No')}
								<input type="number" min="0" class="form-control mba-rb-mv-aroya" value="${esc(guest.aroya_guest_no || '')}"
									placeholder="${esc(__('—'))}" /></label>
					</div>
				</div>
					<div class="mba-rb-mv-actions">
						<button type="button" class="btn btn-default btn-sm mba-rb-mv-reset"
							title="${esc(__('Reset this guest to the room order synced with the Booking (saved with Save Arrangement)'))}">
							${__('Reset Rooming Number')}</button>
						<button type="button" class="btn btn-secondary btn-sm mba-rb-mv-save">${__('Save Details')}</button>
					</div>
				</div>

				<div class="mba-rb-mv-pane" data-pane="move">
					<div class="mba-rb-move-target-wrap">
						<label class="mba-rb-mv-cur">${__('Current Room ID')}
							<input type="text" class="form-control" value="${esc(curRoomId)}" readonly /></label>
						<label>${__('New Room')} <span class="mba-muted">— ${__('type to search; leave empty for no arrangement')}</span>
							<div class="mba-rb-move-ac"></div></label>
					</div>
					<div class="mba-rb-mv-actions">
						<button type="button" class="btn btn-default btn-sm mba-rb-move-new"
							title="${esc(__('Create an ad-hoc room from this traveller reservation profile (CustomRoom_) and move them there'))}">
							${__('New Room')}</button>
						<button type="button" class="btn btn-primary btn-sm mba-rb-move-go">
							${__('Move')}</button>
					</div>
				</div>
			</div>`);
		d.show();

		// ── Tabs — satu pane pada satu masa ──
		d.$body.find('.mba-rb-mv-tab').on('click', function () {
			const tab = $(this).data('tab');
			d.$body.find('.mba-rb-mv-tab').removeClass('active');
			d.$body.find('.mba-rb-mv-pane').removeClass('active');
			$(this).addClass('active');
			d.$body.find(`.mba-rb-mv-pane[data-pane="${tab}"]`).addClass('active');
		});

		const $seq = d.$body.find('.mba-rb-mv-seq');
		const $aroya = d.$body.find('.mba-rb-mv-aroya');
		const $stat = d.$body.find('.mba-rb-mv-stateroom');
		const $delg = d.$body.find('.mba-rb-mv-delegate');
		const $go = d.$body.find('.mba-rb-move-go');

		// ── New Room — AUTOCOMPLETE BOLEH CARI, MULA KOSONG ──
		// Nilai kosong = TIADA PENEMPATAN (tetamu jadi Unassigned; cabin 0
		// pada save). Senarai opsyen = bilik layak (pra-tapis
		// rb_move_reject) sahaja; label memaparkan ID auto + kategori +
		// penghunan supaya mudah dicari (booking number / room / kategori
		// / stateroom).
		let targetCol = null;   // kolum sasaran terpilih (null = kosong)
		const moveAc = frappe.ui.form.make_control({
			df: {
				fieldtype: 'Autocomplete',
				fieldname: 'rb_move_target',
				placeholder: __('Type to search — empty for no arrangement'),
				max_items: Infinity,
				options: cols.map((c) => ({ label: optLabel(c), value: c.id })),
				change: () => {
					const v = (moveAc.get_value() || '').trim();
					targetCol = v ? rb_col(v) : null;
					$go.text(targetCol ? __('Move') : __('Remove Arrangement'));
				},
			},
			parent: d.$body.find('.mba-rb-move-ac').get(0),
			render_input: true,
			only_input: true,
		});
		moveAc.set_value('');   // mula NULL — tiada pra-pilihan
		// Pilihan kosong = buang penempatan — label butang menunjukkan
		// tindakan sebenar dari awal.
		$go.text(__('Remove Arrangement'));

		// Bilik disahkan (Confirmed) — dialog BACA SAHAJA: input & tindakan
		// dilumpuhkan; buka kunci dengan uncheck "Confirmed" pada panel.
		if (confLock) {
			d.$body.find('.mba-rb-move').prepend(
				`<div class="mba-rb-mv-note">${esc(__('This room arrangement is confirmed — read-only. Uncheck "Confirmed" on the room panel to make changes.'))}</div>`);
			$seq.add($aroya).add($stat).add($delg).prop('disabled', true);
			d.$body.find('.mba-rb-mv-save, .mba-rb-mv-reset, .mba-rb-move-go, .mba-rb-move-new')
				.prop('disabled', true);
			// (Control Frappe tiada set_disabled() — read_only + refresh.)
			moveAc.df.read_only = 1;
			moveAc.refresh();
			if (moveAc.$input) moveAc.$input.prop('disabled', true);
		}

		// Dirty-flag per medan — HANYA nilai yang admin betul-betul edit
		// dihantar ke server (payload placement penuh tidak boleh
		// menganggap nilai pratampil medan sebagai niat perubahan).
		let seqDirty = false, aroyaDirty = false, stateroomDirty = false, delegateDirty = false;
		$seq.on('input', () => { seqDirty = true; });
		$aroya.on('input', () => { aroyaDirty = true; });
		$stat.on('input', () => { stateroomDirty = true; });
		$delg.on('input', () => { delegateDirty = true; });

		// Stateroom & Delegate — medan peringkat BILIK (bukan per-tetamu):
		// edit pada modal menulis balik ke kolum sumber, sama seperti
		// input panel; save papan fan-out nilai ke setiap reservation
		// penghuni bilik itu.
		const apply_room_field_edits = () => {
			if (stateroomDirty) srcCol.stateroom_no = String($stat.val() || '').trim();
			if (delegateDirty) srcCol.delegate_no = String($delg.val() || '').trim();
		};

		// ── Reset Rooming Number — DRAF TETAMU INI SAHAJA ──
		// Susunan asal dibaca daripada SO utama BOOKING TETAMU sendiri
		// (guest.booking) — BUKAN srcCol.booking: bagi bilik Open Sharing
		// merentas booking, kolum papan membawa booking PEMILIK bilik,
		// jadi rujukan itu akan salah tempat (punca ralat "No original
		// rooming order found"). Dialog pengesahan memaparkan MAKLUMAT
		// BILIK daripada order summary doctype Booking: room id auto
		// (booking_number-Room_cabin) + kategori + sequence asal.
		// Kemudian PINDAHKAN tetamu dalam draf papan ke kolum cabin asal
		// (rb_move — sequence dikira ikut penghuni sasaran). Kolum cabin
		// asal yang TIADA pada papan (bilik kosong selepas semua pindah)
		// dijana sebagai kolum draf baharu. DB hanya ditulis bila admin
		// tekan "Save Arrangement", SAMA seperti perpindahan biasa — draf
		// lain pada papan KEKAL, tiada reload.
		d.$body.find('.mba-rb-mv-reset').on('click', async function () {
			const $btn = $(this).prop('disabled', true);
			try {
				const prev = await api('get_booking_rooming_source_order',
					{ booking: guest.booking });
				const src = prev && prev.order
					? prev.order.find((s) => s.reservation === guest.reservation) : null;
				if (!src || !src.cabin_no) {
					frappe.msgprint({
						title: __('Cannot reset'),
						message: __('No original rooming order found for this guest (primary Sales Order layout).'),
						indicator: 'red',
					});
					return;
				}
				// Maklumat bilik asal — order summary doctype Booking
				// (booking_number + cabin_no susunan SO utama).
				const bnum = (prev.booking_number || guest.booking || '').toString();
				const origRoomId = `${bnum}-Room_${src.cabin_no}`;
				let dst = RB.cols.find((c) => c.booking === guest.booking
					&& c.cabin_no === src.cabin_no && c.id !== srcCol.id);
				if (dst) {
					// Kolum sedia ada tapi privacy kosong (cth draf baharu
					// / data lama) — bawa privacy asal dari susunan SO.
					if (!dst.room_privacy && src.room_privacy) {
						dst.room_privacy = src.room_privacy;
					}
				} else {
					// Kolum cabin asal tiada pada papan — jana kolum draf
					// bilik kosong (kategori + PRIVACY dari susunan SO;
					// kapasiti dari senarai kategori papan).
					const meta = RB.categories[src.room_category] || {};
					dst = rb_new_col(guest.booking, bnum, src.cabin_no,
						src.room_category, null);
					dst.capacity = meta.capacity || 0;
					dst.max_capacity = meta.max_capacity || 0;
					dst.room_privacy = src.room_privacy || '';
					dst.isNew = true;
					RB.cols.push(dst);
				}
				frappe.confirm(
					__('Reset this guest to the original room order synced with the Booking?')
					+ '<br><br>'
					+ '<table class="table table-bordered" style="margin:0;">'
					+ '<tr><td style="padding:4px 10px;">' + esc(__('Booking')) + '</td>'
						+ '<td style="padding:4px 10px;"><b>' + esc(bnum) + '</b></td></tr>'
					+ '<tr><td style="padding:4px 10px;">' + esc(__('Room ID')) + '</td>'
						+ '<td style="padding:4px 10px;"><b>' + esc(origRoomId) + '</b></td></tr>'
					+ '<tr><td style="padding:4px 10px;">' + esc(__('Room Category')) + '</td>'
						+ '<td style="padding:4px 10px;">' + esc(src.room_category || '—') + '</td></tr>'
					+ '<tr><td style="padding:4px 10px;">' + esc(__('Room Privacy')) + '</td>'
						+ '<td style="padding:4px 10px;">' + esc(src.room_privacy || '—') + '</td></tr>'
					+ '<tr><td style="padding:4px 10px;">' + esc(__('Cabin No')) + '</td>'
						+ '<td style="padding:4px 10px;"><b>' + esc(String(src.cabin_no)) + '</b>'
						+ ' <span class="text-muted">(' + esc(__('current')) + ': '
							+ esc(String(srcCol.cabin_no || '—')) + ')</span></td></tr>'
					+ '<tr><td style="padding:4px 10px;">' + esc(__('Guest Sequence')) + ' <span class="text-muted">(' + esc(__('original')) + ')</span></td>'
						+ '<td style="padding:4px 10px;">' + esc(String(src.guest_sequence)) + '</td></tr>'
					+ '</table>'
					+ '<br>' + esc(__('The move is applied to the board draft — save with {0} as usual.',
						[__('Save Arrangement')])),
					() => {
						$btn.prop('disabled', false);
						d.hide();
						setTimeout(() => { d.$wrapper.remove(); }, 350);
						// rb_move laksanakan validasi + mutasi draf + render.
						// Sequence ikut penghuni sasaran (bukan nilai SO
						// mentah) supaya draf kekal konsisten kapasiti.
						rb_move(guest.reservation, dst);
					},
					() => { $btn.prop('disabled', false); },
				);
			} catch (e) {
				$btn.prop('disabled', false);
			}
		});

		// TAB Update Info — Save Details: stamp medan dirty pada tetamu
		// sahaja (tiada perpindahan); kekal dalam draf sehingga butang
		// "Save Arrangement" papan.
		d.$body.find('.mba-rb-mv-save').on('click', function () {
			if (seqDirty) {
				const seqVal = String($seq.val() || '').trim();
				guest._newSeq = seqVal === '' ? 0 : (parseInt(seqVal, 10) || 0);
				guest._seqByModal = true;   // nilai eksplisit admin — drag tak menimpa
			}
			if (aroyaDirty) guest._aroya = String($aroya.val() || '').trim();
			apply_room_field_edits();
			d.hide();
			// Buang wrapper SELEPAS animasi hide — remove serta-merta
			// meninggalkan .modal-backdrop bootstrap TERGANTUNG (sekat
			// semua klik seluruh page; punca "terpaksa refresh").
			setTimeout(() => { d.$wrapper.remove(); }, 350);
			rb_render();
		});

		// TAB Move — butang Move: stamp medan dirty + laksanakan pilihan
		// autocomplete. Sasaran terpilih → rb_move (validasi
		// rb_move_reject berjalan semula di sana — senarai sudah
		// pra-tapis, jadi lulus). KOSONG (tiada pilihan) = TIADA
		// PENEMPATAN — tetamu dikeluarkan dari bilik ke kolum Unassigned
		// booking sendiri (cabin 0 dihantar server semasa save).
		$go.on('click', function () {
			if (seqDirty) {
				const seqVal = String($seq.val() || '').trim();
				guest._newSeq = seqVal === '' ? 0 : (parseInt(seqVal, 10) || 0);
				guest._seqByModal = true;   // nilai eksplisit admin — drag tak menimpa
			}
			if (aroyaDirty) guest._aroya = String($aroya.val() || '').trim();
			apply_room_field_edits();

			let target = targetCol;
			if (target && (target.id === srcCol.id)) target = null;
			// Tiada sasaran — cari / WUJUDKAN kolum Unassigned booking
			// tetamu sendiri (cabin_no 0) sebagai destinasi. Dahulu butang
			// "Remove Arrangement" senyap gagal bila kolum Unassigned
			// tiada pada papan (render semula sahaja, tiada perpindahan).
			if (!target) {
				target = RB.cols.find((c) => !c.cabin_no && !c.isCustom
					&& c.booking === guest.booking) || null;
				if (!target) {
					target = rb_new_col(guest.booking,
						bnum_of(guest.booking) || guest.booking, 0, '', null);
					target.isNew = true;
					RB.cols.push(target);
				}
			}
			d.hide();
			setTimeout(() => { d.$wrapper.remove(); }, 350);
			if (target) rb_move(guest.reservation, target);
			else rb_render();   // tiada kolum Unassigned pun — simpan medan sahaja
		});

		// ── BUTANG NEW ROOM — bilik ad-hoc 'CustomRoom_<reservation>' ──
		// Untuk situasi tiada bilik layak pada papan: profil penginapan
		// diambil daripada RESERVATION tetamu (room_category & room_privacy
		// reservation; pax_type mengikut tetamu sendiri), kapasiti ikut
		// meta kategori. Simpan: room_id eksplisit CustomRoom_ + cabin_no
		// 0 — assign_room_id() doctype TIDAK menimpa room_id yang sudah
		// diisi, dan payload _ROOM_KEY mengumpulkan reservation itu
		// sebagai bilik tersendiri semula selepas reload.
		d.$body.find('.mba-rb-move-new').on('click', function () {
			if (seqDirty) {
				const seqVal = String($seq.val() || '').trim();
				guest._newSeq = seqVal === '' ? 0 : (parseInt(seqVal, 10) || 0);
				guest._seqByModal = true;   // nilai eksplisit admin — drag tak menimpa
			}
			if (aroyaDirty) guest._aroya = String($aroya.val() || '').trim();
			apply_room_field_edits();

			// Rooming sequence — bilik baharu WAJIB ada nombor rooming;
			// default 1 (penghuni pertama). Nilai 0 (reset) tetap dihormati.
			if (!(guest._newSeq === 0 || guest._newSeq)) guest._newSeq = 1;

			const dst = rb_new_col(guest.booking,
				bnum_of(guest.booking) || guest.booking, 0,
				guest.room_category || '', null);
			dst.room_id = `CustomRoom_${guest.reservation}`;
			dst.custom_name = dst.room_id;
			dst.room_privacy = guest.room_privacy || '';
			dst.isNew = true;
			dst.isCustom = true;
			RB.cols.push(dst);
			d.hide();
			setTimeout(() => { d.$wrapper.remove(); }, 350);
			rb_move(guest.reservation, dst);
		});
	}

	// Notis DRAG & DROP — popup selepas tetamu dilepas ke kolum sasaran:
	// "you are moving this traveller from [old] into [new]" + checkbox
	// pengesahan WAJIB (kiri) + butang Move (kanan; disabled sehingga
	// di-tick). Batal / backdrop menutup tanpa perpindahan. Validasi
	// rb_move_reject + lock bilik disahkan berjalan SEBELUM popup
	// supaya notis tak pernah menawarkan perpindahan tak sah.
	function rb_drop_move(resv, target) {
		const src = RB.cols.find((c) => c.guests.some((g) => g.reservation === resv));
		if (!src || !target || src.id === target.id) return;
		const guest = src.guests.find((g) => g.reservation === resv);
		if (!guest) return;
		const dispName = (guest.name && guest.name !== '-') ? guest.name
			: (guest.guest_label || resv);

		// Lock bilik disahkan — sama seperti rb_move (pra-papar notis).
		if (src.confirmed || target.confirmed) {
			frappe.msgprint({
				title: __('Cannot move — room confirmed'),
				message: __('Room arrangement is confirmed. Uncheck "Confirmed" on the room panel first.'),
				indicator: 'red',
			});
			return;
		}

		const problems = rb_move_reject(guest, src, target);
		if (problems && problems.length) {
			frappe.msgprint({
				title: __('Cannot move — room criteria'),
				message: problems.map((p) => '<div>• ' + esc(p) + '</div>').join(''),
				indicator: 'red',
			});
			return;
		}

		// Label bilik — FORMAT AUTO BOOKING_NO-Room_<cabin> (rujuk
		// rb_room_label), bukan docname.
		const fromLabel = rb_room_label(src);
		const toLabel = rb_room_label(target);
		const d = new frappe.ui.Dialog({
			title: __('Move Traveller') + ' — ' + dispName,
		});
		d.$body.html(`
			<div class="mba-rb-move">
				<div class="mba-rb-notice">
					${__('You are moving this traveller')}
					<div class="mba-rb-notice-rooms">
						<div class="mba-rb-notice-room">
							<span class="mba-rb-notice-tag">${__('From')}</span>
							<b>${esc(fromLabel)}</b>
						</div>
						<span class="mba-rb-notice-arrow">→</span>
						<div class="mba-rb-notice-room">
							<span class="mba-rb-notice-tag">${__('Into')}</span>
							<b>${esc(toLabel)}</b>
						</div>
					</div>
				</div>
				<div class="mba-rb-notice-footer">
					<label class="mba-rb-notice-ack">
						<input type="checkbox" class="mba-rb-notice-chk" />
						<span>${__('I acknowledge this move')}</span>
					</label>
					<button type="button" class="btn btn-primary btn-sm mba-rb-notice-go" disabled>
						${__('Move')}</button>
				</div>
			</div>`);
		d.show();

		// Butang Move aktif HANYA bila pengesahan di-tick.
		d.$body.find('.mba-rb-notice-chk').on('change', function () {
			d.$body.find('.mba-rb-notice-go').prop('disabled', !$(this).is(':checked'));
		});
		d.$body.find('.mba-rb-notice-go').on('click', function () {
			d.hide();
			setTimeout(() => { d.$wrapper.remove(); }, 350);
			rb_move(resv, target);
		});
	}

	// Kumpul placement penuh & simpan. Pra-validasi draf sebelum save —
	// mirror peraturan doctype (validate_cabin_capacity) supaya susunan
	// tidak sah ditolak SEBELUM round-trip server: (a) melebihi
	// max_capacity, (b) Extra Bed tanpa Main Guest mencukupi capacity
	// asas, (c) Infant tanpa Main Guest. Server kekal penghad akhir.
	async function rb_save(key, opts = {}) {
		// Dalam view penuh, simpan sentiasa KEKAL di view (reload board
		// dari data segar) — butang Save dipulihkan setiap kali.
		opts.keepOpen = opts.keepOpen || !!RB.$view;
		const invalid = [], badExtra = [], badInfant = [];
		for (const col of RB.cols) {
			// Kolum Unassigned (cabin 0, bukan custom) tiada kapasiti —
			// langkau; bilik CustomRoom_ adalah bilik sebenar (meta daripada
			// kategori profil tetamu) — perlu divalidasi juga.
			if (!col.cabin_no && !col.isCustom) continue;
			if (col.max_capacity > 0 && col.guests.length > col.max_capacity) invalid.push(col);
			const mains = col.guests.filter((g) => (g.pax_type || '') === 'Main Guest').length;
			if (col.guests.some((g) => (g.pax_type || '') === 'Extra Bed')
				&& col.capacity > 0 && mains < col.capacity) badExtra.push(col);
			if (col.guests.some((g) => (g.pax_type || '') === 'Infant') && mains < 1) badInfant.push(col);
		}
		const problems = [];
		if (invalid.length) problems.push(__('Over capacity') + ': ' + invalid.map((c) => roomLabel(c) + ' (' + c.guests.length + '/' + c.max_capacity + ')').join(', '));
		if (badExtra.length) problems.push(__('Extra Bed is only valid when Main Guest is at full base capacity') + ': ' + badExtra.map(roomLabel).join(', '));
		if (badInfant.length) problems.push(__('Infant needs at least 1 Main Guest') + ': ' + badInfant.map(roomLabel).join(', '));
		if (problems.length) {
			frappe.msgprint({
				title: __('Cannot save — room arrangement invalid'),
				message: problems.map((p) => '<div>• ' + p + '</div>').join(''),
				indicator: 'red',
			});
			return;
		}

			const moves = [];
		for (const col of RB.cols) {
			for (const g of col.guests) {
				if (!g.reservation) continue;
				moves.push({
					reservation: g.reservation,
					// Cabin No: tetamu merentas booking dalam kolum bilik
					// PEMILIK (kolum mengumpul ikut room_id fizikal) yang
					// TIDAK berpindah hantar cabin ASAL reservation sendiri
					// (ruang penomboran booking sendiri) — cabin kolum
					// pemilik boleh kebetulan sama nombor dengan bilik
					// booking sendiri yang berbeza. Tetamu lain ikut
					// cabin kolum (biasa / baru dipindah).
					cabin_no: (col.booking !== g.booking && !g._crossRoomId
						&& g._origCabin != null) ? g._origCabin : (col.cabin_no || 0),
					// Cabin ASAL (dari payload masa papan dimuatkan) —
					// save-guard stale board di server: admin lain dah
					// pindahkan tetamu → keseluruhan save DITOLAK (bukan
					// overwrite senyap yang mengembalikan tetamu ke
					// posisi lapuk / last-write-wins).
					from_cabin_no: g._origCabin != null ? g._origCabin : undefined,
					room_category: col.room_category || '',
					// Room ID eksplisit untuk penempatan Open Sharing
					// merentas booking: tetamu yang BARU dipindah (g._
					// crossRoomId) ATAU penghuni sedia kolum bilik PEMILIK
					// (col.booking ≠ g.booking, kolum mengumpul ikut
					// room_id fizikal) — kedua-duanya mesti membawa room_id
					// bilik pemilik, kalau tidak server akan padam room_id
					// asing & jana semula ikut booking sendiri pada cabin
					// PEMILIK (nombor kabin bercanggah penomboran booking
					// sendiri → ralat kapasiti bilik sendiri). Bilik biasa /
					// tetamu booking sendiri: kosong — server jana semula
					// ikut booking+cabin.
					// Bilik CustomRoom_ (butang New Room modal Move Guest) —
					// room_id eksplisit dihantar WALAU cabin 0 supaya
					// reservation kekal room_id CustomRoom_<reservation>
					// (server: room_id yang sudah diisi tidak ditimpa oleh
					// assign_room_id; guard merentas booking hanya untuk
					// format '-Room_').
					room_id: (col.isCustom && col.room_id)
						? col.room_id
						: ((col.cabin_no && (g._crossRoomId
							|| (col.booking !== g.booking ? col.room_id : '')))
							|| ''),
					// Guest sequence baharu — tetamu yang dipindahkan
					// (mengikut penghuni bilik sasaran). Nilai 0 = RESET
					// kepada nombor auto (butang Reset modal Move Guest).
					// _newSeqKosong (undefined) = medan tak dihantar —
					// server kekalkan nilai sedia ada.
					guest_sequence: (g._newSeq === 0 || g._newSeq) ? g._newSeq : undefined,
					// Sifat bilik — bilik bernombor DAN CustomRoom_ (panel
					// kolum custom memaparkan control sama; nilai mesti
					// dihantar, jika tidak edit admin terbuang senyap).
					room_privacy: (col.cabin_no || col.isCustom) ? (col.room_privacy || '') : undefined,
					stateroom_no: (col.cabin_no || col.isCustom) ? (col.stateroom_no || '') : undefined,
					delegate_no: (col.cabin_no || col.isCustom) ? (col.delegate_no || '') : undefined,
					cabin_is_confirmed: (col.cabin_no || col.isCustom) ? !!col.confirmed : undefined,
					// Aroya Guest No (modal Move Guest, seksyen Cruise
					// Arrangement) — medan per-tetamu; hanya dihantar bila
					// admin edit melalui modal (string kosong sah = clear).
					aroya_guest_no: (g._aroya != null) ? g._aroya : undefined,
				});
			}
		}
		if (!moves.length) return;

		const $btn = RB.$view ? RB.$view.find('.mba-rb-save') : null;
		if ($btn && $btn.length) {
			$btn.prop('disabled', true).text(__('Saving...'));
		}
		// Echo guard AKTIF sepanjang save → reload — siaran realtime
		// server (travel_booking_rooming_updated) sampai ke penyimpan
		// JUGA, biasanya sebelum reload selesai; tanpa guard tu draf
		// "pending" akan salah tafsir sebagai kemaskini admin lain.
		RB._echoGuard = true;
		try {
			const out = await api('arrange_group_rooming', { moves });
			frappe.show_alert({
				message: out && out.count
					? __('Rooming updated') + ' — ' + out.count + ' ' + __('reservation(s)')
					: __('No changes — rooming already up to date'),
				indicator: 'green',
			});
			await load_tab(key, 'rooming', true);   // cache + tab refresh (SPA, tiada reload)
			if (opts.keepOpen && RB.$view) {
				// Muatkan semula papan dari payload SEGAR — nombor,
				// Room ID & susunan mencerminkan DB terkini.
				await rb_reload(key);
				if ($btn && $btn.length) {
					$btn.prop('disabled', false).text(__('Save Arrangement'));
				}
			}
			// (view penuh — kekal terbuka; tiada hide)
		} catch (e) {
			// api() dah papar alert ralat — benarkan cuba semula
			if ($btn && $btn.length) {
				$btn.prop('disabled', false).text(__('Save Arrangement'));
			}
		} finally {
			RB._echoGuard = false;
		}
	}
