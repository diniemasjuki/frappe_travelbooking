	/* ══════════════════════════════════════════════════════════════════
	   SUB-PACKAGE: SENARAI TRAVELLER (traveller_list.js)
	   ══════════════════════════════════════════════════════════════════
	   Satu set komponen UI senarai traveller yang boleh DIGUNA SEMULA
	   oleh section lain pada masa depan. Fail ini di-include ke dalam
	   scope IIFE page manage_booking_app melalui directive
	   directive include (frappe.model.utils.render_include — concatenation
	   server-side), jadi semua fungsi/const di sini HIDUP dalam scope
	   page yang sama dan boleh merujuk helper page (S, api, $d, badge,
	   esc, fmtDate, dsb.) secara terus.

	   API AWAM (untuk section lain):
	   • render_traveller_list(opts) — renderer utama; opts:
	       {target, rows, state, context, summary_html, empty_message,
	        show_filters, show_downloads, toolbar_extras, footer_html,
	        on_rerender}
	     Render: jalur ringkasan + toolbar (carian/toggle view/bulk/
	     download/Order By) + panel penapis dinamik + grid kad + jadual
	     (checkbox bulk, kolum Traveller/Document/Booking/Reservation).
	   • render_travellers_tab(key)  — binding L2 (group/batch).
	   • render_bkg_travellers(key)  — binding L3 (booking).
	   • load_bkg_travellers(key)    — loader L3 (lazy).
	   • show_traveller_dialog(t, ctx) — modal detail traveller.
	 • open_traveller_edit_form / open_traveller_bulk_dialog /
	     open_traveller_status_dialog / open_booking_status_dialog /
	     open_booking_contact_dialog / open_reservation_status_dialog /
	     open_rooming_edit_dialog / open_flight_edit_dialog /
	     show_guest_link_dialog / show_crop_dialog — dialog & borang.
	   • tv_summary_html(s) / tv_cf_* — penapis dinamik & ringkasan.
	   • patch_traveller_caches / patch_reservation_caches /
	     patch_booking_caches — sinkron cache selepas mutasi.

	   KONFIG DI PAGE (dikongsi melalui scope): TV_SORTS, ROW_LIMITS,
	   peta warna status (RES_STATUS_COLORS, DOC_STATUS_COLORS, dsb.).
	   ══════════════════════════════════════════════════════════════════ */

	// Ringkasan kecil tab traveller — 3 kolum:
	//   col1 Booked for / Reserved for — col2 Pending Verification /
	//   Verified Document — col3 Readiness (kanan). Readiness diberi warna
	//   ikut tahap (merah <30%, oren 30–69%, hijau ≥70%) supaya paparan
	//   nampak berbeza ikut keselesaan dokumentasi. Sumber: meta `summary`
	//   get_group_travellers (skop PENUH, bukan dipengaruhi carian/penapis).
	const tv_summary_html = (s) => {
		if (!s) return '';
		const r = Number(s.readiness) || 0;
		const level = r >= 70 ? 'good' : r >= 30 ? 'warn' : 'bad';
		return `<div class="mba-tv-summary">
			<div class="mba-tv-sum-col">
				<span class="mba-tv-sum-item">${__('Booked for')}: <b>${Number(s.booked_pax) || 0}</b> ${__('traveller')}</span>
				<span class="mba-tv-sum-item">${__('Reserved for')}: <b>${Number(s.ready_for) || 0}</b> ${__('traveller')}</span>
			</div>
			<div class="mba-tv-sum-col">
				<span class="mba-tv-sum-item">${__('Pending Verification')}: <b>${Number(s.pending_verification) || 0}</b> ${__('traveller')}</span>
				<span class="mba-tv-sum-item">${__('Verified Document')}: <b>${Number(s.verified) || 0}</b> ${__('traveller')}</span>
			</div>
			<div class="mba-tv-sum-col mba-tv-sum-col--end">
				<span class="mba-tv-sum-item mba-tv-sum-ready mba-tv-sum-ready--${level}">
					${__('Readiness')}: <b>${r}%</b></span>
			</div>
		</div>`;
	};

	function render_travellers_tab(key) {
		const tv = S.cache[key]?.travellers;
		const it = find_item(key);
		const st = S.state[key];
		if (!tv || !it || !st) return;
		const rows = tv.travellers || [];		const pane = pane_el(key, 'traveller');
		// NOTE: rows kosong TIDAK lagi overwrite pane — render_traveller_list
		// papar mesej kosong DALAM .mba-tv-grid supaya toolbar & panel
		// penapis kekal boleh diubah/dibuang.

		// Julat tarikh trip group (batch → mula terawal / tamat terakhir)
		// untuk tanda merah DOB dalam tempoh perjalanan.
		const starts = it.members
			.map((m) => String(m.sailing_start || m.departure_date || '').slice(0, 10))
			.filter(Boolean).sort();
		const ends = it.members
			.map((m) => String(m.sailing_end || m.return_date || '').slice(0, 10))
			.filter(Boolean).sort();

		render_traveller_list({
			target: pane,
			rows,
			summary_html: tv_summary_html(tv.summary),
			state: st.tv,
			context: {
				show_booking_col: true,
				trip_start: starts[0] || '',
				trip_end: ends[ends.length - 1] || '',
				// Skop muat turun ikut tapisan group aktif — manifest
				// penuh batch, atau group tunggal bila ditapis.
				trip_groups: st.tv.group ? [st.tv.group] : item_groups(it),
			},
			toolbar_extras: `<span class="mba-tv-extras">
				${tv_cf_toggle_html(st.tv)}
			</span>`,
			server_search: true,
			search_placeholder: __('Search traveller / passport / contact / booking...'),
			custom_filter_html: tv_cf_panel_html(st.tv),
			footer_html: showing_footer(tv, __('travellers'), 'tv'),
			show_search: false,
		});
		tv_cf_hydrate(key);
	}

	const tv_hay = (t) => [
		t.traveller_name, t.passport_no, t.nationality, t.email, t.phone,
		t.room_id, t.room_category, t.stateroom_no, t.pax_type, t.room_privacy,
		t.cabin_no, t.delegate_no, t.aroya_guest_no, t.reservation, t.traveller,
		t.ic_number, t.dob, t.age_category, t.guest_label,
	].map((x) => String(x || '').toLowerCase()).join(' \u0001 ');

	/* ---------- Penapis dinamik tab Travellers (L2 & L3) ----------
	   Baris [{doctype, fieldname, value}] disimpan dalam state tv.custom.
	   Medan pilihan datang daripada get_traveller_filter_fields (meta 4
	   doctype sumber); cadangan nilai (datalist) daripada
	   get_traveller_filter_values ikut skop item semasa. Tapisan dijalankan
	   server-side bersama carian/doc status/limit. */

	async function ensure_tv_filter_fields() {
		if (S.tvFields) return S.tvFields;
		if (!S.tvFieldsPromise) {
			S.tvFieldsPromise = api('get_traveller_filter_fields')
				.then((f) => { S.tvFields = f || []; return S.tvFields; })
				.catch(() => null);
		}
		return S.tvFieldsPromise;
	}

	// Baris aktif = ada nilai tunggal ATAU julat (min/max) — dikira dalam
	// pill butang Filter dan dihantar ke server sebagai custom_filters.
	const tv_cf_active = (rows) => (rows || []).filter((r) => r.doctype && r.fieldname
		&& ((r.value != null && r.value !== '')
			|| (r.min != null && r.min !== '')
			|| (r.max != null && r.max !== '')));

	// Jenis medan yang guna input NILAI berupa julat Min–Max (bukan teks
	// tunggal): nombor DAN tarikh (tarikh: dua input type=date, padanan
	// inklusif). Fieldtype datang dari meta cache S.tvFields.
	const TV_CF_NUMERIC_TYPES = ['Int', 'Float', 'Currency', 'Percent', 'Date'];
	const tv_cf_field_meta = (r) => {
		const g = (S.tvFields || []).find((x) => x.doctype === r?.doctype);
		return g?.fields.find((f) => f.fieldname === r?.fieldname) || null;
	};
	const tv_cf_fieldtype = (r) => tv_cf_field_meta(r)?.fieldtype || '';
	const tv_cf_is_range = (r) => TV_CF_NUMERIC_TYPES.includes(tv_cf_fieldtype(r));
	// Medan Select — pilihan penuh dari meta (autocomplete nilai penapis).
	const tv_cf_select_options = (r) => tv_cf_field_meta(r)?.options || [];

	// Butang togol pada toolbar (kiri, selepas tapisan standard).
	// Ikon 'funnel' — set ikon Lucide Frappe tiada lagi 'filter'.
	function tv_cf_toggle_html(tvst) {
		const n = tv_cf_active(tvst.custom).length;
		return `<button type="button" class="btn btn-default btn-xs mba-cf-toggle"
			title="${esc(__('Filter by any field'))}">
			${frappe.utils.icon('funnel', 'sm')} ${__('Filter')}${n ? ` <span class="mba-count-pill">${n}</span>` : ''}</button>`;
	}

	// Panel baris penapis — terpapar bila tv.cf_open (kekal merentas render).
	// ≥2 baris → pilihan mod gabungan AND | OR (cf_match; lalai AND).
	// PEMILIH MEDAN: input AUTOCOMPLETE (datalist) — senarai medan panjang
	// (4 doctype) dicari terus dengan menaip; paparan "Doctype — Label",
	// nilai sebenar diselesaikan melalui tv_cf_field_choices().
	// Medan nombor/currency (Int/Float/Currency/Percent) → input julat
	// Min–Max; medan lain → input nilai tunggal + datalist cadangan.
	function tv_cf_field_choices() {
		// Flat [{display, doctype, fieldname}] — susun ikut doctype meta.
		const out = [];
		(S.tvFields || []).forEach((g) => (g.fields || []).forEach((f) => out.push({
			display: `${g.doctype} — ${f.label}`,
			doctype: g.doctype,
			fieldname: f.fieldname,
		})));
		return out;
	}
	const tv_cf_display = (r) => {
		if (!r?.doctype || !r?.fieldname) return '';
		const m = tv_cf_field_choices().find((x) =>
			x.doctype === r.doctype && x.fieldname === r.fieldname);
		return m ? m.display : '';
	};
	function tv_cf_panel_html(tvst) {
		if (!tvst.cf_open) return '';
		const rows = tvst.custom || [];
		const match = tvst.cf_match === 'OR' ? 'OR' : 'AND';
		const matchBtn = (v) => `<button type="button"
			class="btn btn-default btn-xs mba-cf-match-btn${match === v ? ' active' : ''}"
			data-match="${v}" title="${esc(v === 'AND'
				? __('Row must match ALL filters')
				: __('Row must match ANY filter'))}">${v}</button>`;
		const fieldChoices = tv_cf_field_choices();
		const fieldOpts = fieldChoices.map((x) =>
			`<option value="${esc(x.display)}"></option>`).join('');
		return `
		<div class="mba-cf">
			${rows.map((r, i) => `
			<div class="mba-cf-row" data-idx="${i}">
				<span class="mba-cf-pick">
					<input type="text" class="form-control mba-cf-field-input" data-idx="${i}"
						list="mba-cf-fdl-${i}" autocomplete="off"
						placeholder="${esc(__('— Select Field —'))}"
						value="${esc(tv_cf_display(r))}" />
					<datalist id="mba-cf-fdl-${i}">${fieldOpts}</datalist>
				</span>
				${tv_cf_is_range(r) ? `
				<span class="mba-cf-range">
					<input ${tv_cf_fieldtype(r) === 'Date' ? 'type="date"' : 'type="number" step="any"'}
						class="form-control mba-cf-min" data-idx="${i}"
						placeholder="${esc(__('Min'))}" value="${esc(r.min ?? '')}" />
					<span class="mba-cf-sep">–</span>
					<input ${tv_cf_fieldtype(r) === 'Date' ? 'type="date"' : 'type="number" step="any"'}
						class="form-control mba-cf-max" data-idx="${i}"
						placeholder="${esc(__('Max'))}" value="${esc(r.max ?? '')}" />
				</span>` : `
				<input type="text" class="form-control mba-cf-value" data-idx="${i}" list="mba-cf-dl-${i}"
					placeholder="${esc(__('Value'))}" value="${esc(r.value ?? '')}" />
				<datalist id="mba-cf-dl-${i}">${tv_cf_select_options(r).map((o) =>
					`<option value="${esc(o)}"></option>`).join('')}</datalist>`}
				<button type="button" class="btn btn-default btn-xs mba-cf-del" data-idx="${i}"
					title="${esc(__('Remove this filter'))}">✕</button>
			</div>`).join('')}
			<div class="mba-cf-actions">
				<button type="button" class="btn btn-default btn-xs mba-cf-add">+ ${__('Add Filter')}</button>
				${rows.length > 1 ? `<span class="mba-cf-match btn-group" role="group"
					aria-label="${esc(__('Match mode'))}">
					<span class="mba-cf-match-lbl">${__('Match')}:</span>${matchBtn('AND')}${matchBtn('OR')}
				</span>` : ''}
				${rows.length ? `<button type="button" class="btn btn-default btn-xs mba-cf-clear">${__('Clear All')}</button>
				<button type="button" class="btn btn-primary btn-xs mba-cf-apply">${__('Apply')}</button>` : ''}
			</div>
		</div>`;
	}

	// Isi datalist cadangan nilai untuk satu baris — skop ikut item
	// (group/batch L2 atau booking L3). Tidak re-render supaya fokus kekal.
	// Baris julat nombor tiada datalist (input Min–Max bukan teks); baris
	// Select guna pilihan meta (sudah diisi semasa render — tiada API).
	function tv_cf_fill_datalist(key, $row) {
		const idx = $row.data('idx');
		const st = S.state[key];
		const r = st?.tv?.custom?.[idx];
		if (!st || !r || !r.doctype || !r.fieldname || tv_cf_is_range(r)) return;
		if (tv_cf_fieldtype(r) === 'Select') {
			$row.find('datalist').html(tv_cf_select_options(r)
				.map((o) => `<option value="${esc(o)}"></option>`).join(''));
			return;
		}
		const args = { doctype: r.doctype, fieldname: r.fieldname, limit: 100 };
		if (key.startsWith('bkg:')) {
			args.booking = key.slice(4);
		} else {
			const it = find_item(key);
			if (!it) return;
			args.trip_groups = st.tv.group ? [st.tv.group] : item_groups(it);
		}
		api('get_traveller_filter_values', args).then((d) => {
			const cur = S.state[key]?.tv?.custom?.[idx];
			if (!cur || cur.doctype !== r.doctype || cur.fieldname !== r.fieldname) return;
			$row.find('datalist').html((d?.values || [])
				.map((v) => `<option value="${esc(v)}"></option>`).join(''));
		}).catch(() => { /* cadangan gagal — input teks masih berfungsi */ });
	}

	// Selepas render semula, isi semula datalist baris yang ada medan.
	function tv_cf_hydrate(key) {
		const $pane = key.startsWith('bkg:')
			? $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="tv"]`)
			: pane_el(key, 'traveller');
		$pane.find('.mba-cf-row').each(function () {
			if ($(this).find('.mba-cf-field-input').val()) tv_cf_fill_datalist(key, $(this));
		});
	}

	// Modal detail traveller — SEMUA maklumat traveller + reservation.
	// ctx (pilihan): {list, index} — senarai traveller paparan aktif &
	// posisi semasa, untuk navigasi Prev/Next antara traveller.
	function show_traveller_dialog(t, ctx) {
		const crow = (k, v) => (v !== '' && v != null
			? `<div class="mba-bkg-card-row"><span>${k}</span><span>${v}</span></div>` : '');
		// extra — kandungan kanan bar tajuk kad (butang status doctype dsb.)
		const card = (title, inner, extra) => (inner ? `
			<div class="mba-bkg-card">
				<div class="mba-bkg-card-title"><span>${title}</span>${extra
					? `<span class="mba-bkg-card-title-extra">${extra}</span>` : ''}</div>${inner}
			</div>` : '');
		const F = (v) => (v ? esc(v) : '');

		// Kolum kiri — imej passport ATAU preview dokumen (PDF), sticky
		// pada skrin biasa; tiada fail → kolum kekal, papar mesej. Preview
		// dibungkus .mba-tvmodal-photo-wrap (overflow auto); bar aksi bawah
		// menawarkan Replace (upload ganti dokumen) / Crop / Download /
		// Open in new tab.
		const is_img_url = (u) => /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)($|\?)/i.test(u || '');
		const is_img = is_img_url(t.passport_image);
		// Tiada passport_image — kolum kiri KEKAL (min 50% skrin biasa),
		// kandungan preview disembunyikan & diganti mesej.
		const preview = !t.passport_image
			? `<div class="mba-tvmodal-nopass">${__('No passport image attached')}</div>`
			: (is_img
				? `<img class="mba-tvmodal-photo" src="${esc(t.passport_image)}" alt="${esc(t.traveller_name || '')}">`
				: `<iframe class="mba-tvmodal-frame" src="${esc(t.passport_image)}"
					title="${esc(__('Passport preview'))}"></iframe>`);
		// Bar aksi bawah dokumen kiri — ⬆ Replace (muat naik ganti dokumen;
		// SENTIASA ada bila traveller berlink — traveller tanpa gambar pun
		// boleh set), ✂ Crop / ⬇ Download / Open in new tab (bila fail ada).
		// SEMUA btn-xs — saiz kecil seragam (bukan form submission).
		const sideActions = [];
		if (t.traveller) {
			sideActions.push(`<button type="button" class="btn btn-default btn-xs mba-replace-btn"
				title="${esc(__('Upload a new image to replace this document'))}">⬆ ${__('Replace')}</button>`);
		}
		if (t.passport_image) {
			if (is_img && t.traveller) {
				sideActions.push(`<button type="button" class="btn btn-default btn-xs mba-crop-btn"
					title="${esc(__('Crop this document'))}">✂ ${__('Crop')}</button>`);
			}
			sideActions.push(`<a class="btn btn-default btn-xs" href="${esc(t.passport_image)}"
				download>⬇ ${__('Download')}</a>`);
			sideActions.push(`<a class="btn btn-default btn-xs" href="${esc(t.passport_image)}"
				target="_blank" rel="noopener">${__('Open in new tab')}</a>`);
		}
		const side = `<div class="mba-tvmodal-side">
			<div class="mba-tvmodal-photo-wrap">${preview}</div>
			${sideActions.length ? `<div class="mba-file-actions">${sideActions.join('')}
				<input type="file" class="mba-replace-input" accept="image/*,application/pdf"
					style="display: none;"></div>` : ''}
		</div>`;

		// Baris kad SENTIASA dipapar ('-' bila kosong) — keperluan paparan
		// penuh panel Personal / Documents / Contact / Health.
		const crowS = (k, v) => `
			<div class="mba-bkg-card-row"><span>${k}</span><span>${(v !== '' && v != null) ? v : esc('-')}</span></div>`;
		// Butang call/WA di bawah no. telefon (baris baharu dalam kolum nilai
		// sama) — hanya bila no. telefon wujud.
		const phone_actions = (phone) => (phone
			? `<div class="mba-bkg-card-row-actions mba-bkg-card-row-actions--stack">${call_wa_btns(phone)}</div>`
			: '');
		// Baris fail dokumen — butang quick view (modal viewer); '-' tiada fail.
		const file_row = (label, url) => crowS(label, url ? `
			<button type="button" class="btn btn-default btn-xs mba-file-view-btn"
				data-name="${esc(label + ' — ' + (t.traveller_name || t.reservation))}"
				data-url="${esc(url)}" data-image="${is_img_url(url) ? 1 : 0}"
				title="${esc(__('Quick view'))}">👁 ${__('View')}</button>` : '');
		const catBadge = (() => {
			const cat = t.age_category
				|| (t.age_bucket && t.age_bucket !== 'Unknown' ? t.age_bucket : '');
			return cat ? badge(cat, AGE_BUCKET_COLORS[cat] || 'gray') : '';
		})();

		const personal = card('👤 ' + __('Personal'),
			crowS(__('Title'), F(t.title))
			+ crowS(__('Full Name'), F(t.traveller_name))
			+ crowS(__('First Name'), F(t.first_name))
			+ crowS(__('Last Name'), F(t.last_name))
			+ crowS(__('Gender'), t.gender ? esc(__(t.gender)) : '')
			+ crowS(__('Date of Birth'), t.dob ? esc(fmtDate(t.dob)) : '')
			+ crowS(__('Age'), (t.age != null ? esc(String(t.age)) : '')
				+ (catBadge ? (t.age != null ? ' ' : '') + catBadge : '')));
		const docs = card('🛂 ' + __('Documents'),
			crowS(__('Passport No'), F(t.passport_no))
			+ crowS(__('Passport Expiry'), t.passport_expiry ? esc(fmtDate(t.passport_expiry)) : '')
			+ crowS(__('IC Number'), F(t.ic_number))
			+ crowS(__('Nationality'), F(t.nationality))
			+ file_row(__('Visa Image'), t.visa_photo));
		// Alamat — format 3 baris: jalan / poskod bandar / negeri, negara.
		// Negeri disembunyikan bila sama dengan negara (nilai uppercase
		// dijamin oleh before_save doctype Traveller).
		const addrState = (t.state && (t.state || '').toUpperCase() !== (t.country || '').toUpperCase())
			? esc(t.state) : '';
		const addressHtml = [
			t.address_line1 ? esc(t.address_line1) : '',
			[t.postcode, t.city].filter(Boolean).map(esc).join(' '),
			[addrState, t.country ? esc(t.country) : ''].filter(Boolean).join(', '),
		].filter(Boolean).join('<br>');
		const emergencyVal = [
			t.emergency_contact_name ? esc(t.emergency_contact_name) : '',
			t.emergency_contact_relationship ? '(' + esc(t.emergency_contact_relationship) + ')' : '',
			t.emergency_contact_phone ? '<br>☎ ' + esc(t.emergency_contact_phone) : '',
		].filter(Boolean).join(' ');
		const contact = card('📞 ' + __('Contact Info'),
			crowS(__('Email'), t.email ? '✉ ' + esc(t.email) : '')
			+ crowS(__('Phone'), (t.phone ? '☎ ' + esc(t.phone) : '') + phone_actions(t.phone))
			+ crowS(__('Address'), addressHtml)
			+ crowS(__('Emergency Contact'), emergencyVal + phone_actions(t.emergency_contact_phone)));
		const health = card('🩺 ' + __('Health & Special Needs'),
			crowS(__('Wheelchair Assistant'), F(t.wheelchair_assistant))
			+ crowS(__('Dietary Requirements'), F(t.dietary_requirements))
			+ crowS(__('Medical Conditions'), F(t.medical_conditions))
			+ crowS(__('Medicine / Treatment'), F(t.medicine_treatment)));

		// Konteks booking — Rooming, Cruise Cabin (jika ada nilai) & Reservation.
		const yesNo = (b) => (b ? badge(__('Confirmed'), 'green') : badge(__('Pending'), 'orange'));
		// Butang ✎ — borang kemaskini Rooming/accommodation doctype
		// Booking Reservation (termasuk medan cruise cabin) — IKON KECIL
		// pada bar tajuk kad (tooltip).
		const roomingEditBtn = t.reservation
			? `<button type="button" class="btn btn-default btn-xs mba-rmedit-btn"
				title="${esc(__('Edit rooming / accommodation (Booking Reservation doctype)'))}">✎</button>`
			: '';
		const roomingRows = crow(__('Room ID'), F(t.room_id))
			+ crow(__('Room Category'), F(t.room_category))
			+ crow(__('Room Privacy'), F(t.room_privacy))
			+ crow(__('Guest Sequence'), t.guest_sequence ? esc(String(t.guest_sequence)) : '')
			+ crow(__('Guest Rooming Type'), F(t.pax_type))
			+ (t.cabin_confirmed != null ? crow(__('Room Arrangement'), yesNo(t.cabin_confirmed)) : '');
		// Kad Rooming SENTIASA dipapar — tiada nilai → baris '-' sahaja,
		// supaya butang Edit tetap ada pintu masuk (set rooming dari modal).
		const rooming = card('🛏 ' + __('Rooming'),
			roomingRows + (roomingRows ? '' : crowS(__('Room ID'), esc('-'))),
			roomingEditBtn);
		const cruise = (t.stateroom_no || t.delegate_no || (t.aroya_guest_no !== '' && t.aroya_guest_no != null)
			? card('🚢 ' + __('Cruise Cabin'),
				crow(__('Stateroom No'), F(t.stateroom_no))
				+ crow(__('Delegate No'), F(t.delegate_no))
				+ crow(__('Aroya Guest No'), t.aroya_guest_no !== '' && t.aroya_guest_no != null
					? esc(String(t.aroya_guest_no)) : ''))
			: '');
		// Butang status panel — bar tajuk kad, KANAN (justify). Klik buka
		// dialog tukar status doctype berkenaan (Booking / Booking
		// Reservation). Bila status kosong, papar '-' — butang kekal boleh
		// diklik utk SET status.
		// Butang status panel — status dipapar SEBAGAI BADGE, diikuti
		// butang kecil ✎ (update status) — corak sama dengan header
		// Document Status tab Traveller Info.
		const bookingStatusBtn = t.booking
			? `${badge(t.booking_status || '-', BOOK_STATUS_COLORS[t.booking_status] || 'gray')}
				<button type="button" class="btn btn-default btn-xs mba-bkstatus-btn mba-status-pen-btn"
					title="${esc(__('Change Booking status'))}">✎</button>`
			: '';
		const resStatusBtn = t.reservation
			? `${badge(t.reservation_status || '-', RES_STATUS_COLORS[t.reservation_status] || 'gray')}
				<button type="button" class="btn btn-default btn-xs mba-resstatus-btn mba-status-pen-btn"
					title="${esc(__('Change Booking Reservation status'))}">✎</button>`
			: '';
		const reservation = card('🧾 ' + __('Booking Reservation'),
			crow(__('Reservation Message'), F(t.reservation_message) || esc('-'))
			+ crow(__('Reservation'), `<a href="/app/booking-reservation/${esc(t.reservation)}"
				target="_blank" rel="noopener">${esc(t.reservation)} ↗</a>`)
			+ crow(__('Registered'), t.traveller_created ? esc(fmtDateTime(t.traveller_created)) : '')
			+ crow(__('Last Updated'), t.traveller_modified ? esc(fmtDateTime(t.traveller_modified)) : ''),
			resStatusBtn);

		// Panel booking (aras booking) — No/ID, contact customer + aksi
		// call/WA, dan mesej booking; tangga pertama seksyen Booking Info.
		const bkNo = t.booking_number || t.booking || '';
		// Booking No — booking_number doctype Booking, BESAR & bold, teks
		// SAHAJA (link dipisah daripada info). Butang ikon ↗ selepas info —
		// paparan booking halaman ini
		// (/app/manage-booking-app/booking/<name>), tab baharu + tooltip.
		const bkNoVal = bkNo
			? `<span class="mba-bkg-no-link">${esc(bkNo)}</span>
				<a class="btn btn-default btn-xs mba-bkg-open-btn"
					href="/app/manage-booking-app/booking/${encodeURIComponent(t.booking || bkNo)}"
					target="_blank" rel="noopener"
					title="${esc(__('Open booking page in a new tab'))}">↗</a>`
			: '';
		// Booking ID — nama doctype Booking (ID); butang ikon ↗ selepas
		// info — rekod doctype Booking (/app/booking/<name>), tab baharu +
		// tooltip (dipindah daripada baris Booking No).
		const bkIdVal = t.booking
			? `${esc(t.booking)}
				<a class="btn btn-default btn-xs mba-bkg-open-btn"
					href="/app/booking/${encodeURIComponent(t.booking)}"
					target="_blank" rel="noopener"
					title="${esc(__('Open Booking doctype record in a new tab'))}">↗</a>`
			: '';
		// Butang ✎ — borang kemaskini Booking Contact doctype Booking
		// (cust_email + get_cust_booking_phone; snapshot per booking) —
		// IKON KECIL pada baris Booking Contact, selepas info (tooltip).
		const bkContactEditBtn = t.booking
			? `<button type="button" class="btn btn-default btn-xs mba-bkedit-btn"
				title="${esc(__('Edit booking contact'))}">✎</button>`
			: '';
		// Booking Info Overview — Order Summary booking (virtual property
		// Booking, kiraan SO agak berat) — LAZY: '…' dahulu, teks diisi
		// api('get_booking_order_summary') selepas modal dibuka (bind di
		// bawah selepas msgprint). Nilai multi-baris (cabin/guest/diskaun).
		const bkOsumVal = t.order_summary != null
			? (t.order_summary
				? `<span class="mba-bkg-osum">${esc(t.order_summary)}</span>`
				: esc('-'))
			: `<span class="mba-bkg-osum mba-bkg-osum--load" data-booking="${esc(t.booking || '')}">…</span>`;
		const bkContactVal = [
			t.customer_name ? esc(t.customer_name) : '',
			t.cust_email ? '✉ ' + esc(t.cust_email) : '',
			t.cust_phone ? '☎ ' + esc(t.cust_phone) : '',
		].filter(Boolean).join('<br>');
		// Booking Contact — nilai & butang call/WA dalam kolum nilai yang
		// sama, butang diletak pada baris baharu di bawah nilai.
		const bkContactActions = t.cust_phone
			? `<div class="mba-bkg-card-row-actions mba-bkg-card-row-actions--stack">${call_wa_btns(t.cust_phone)}</div>`
			: '';
		const bookingCard = t.booking || t.booking_number
			? card('📋 ' + __('Booking'),
				crowS(__('Booking No'), bkNoVal)
				+ crowS(__('Booking ID'), bkIdVal)
				+ crowS(__('Booking Info Overview'), bkOsumVal)
				+ crowS(__('Booking Contact'), bkContactVal + bkContactEditBtn + bkContactActions)
				+ crowS(__('Booking Message'), t.booking_message ? esc(t.booking_message) : ''),
				bookingStatusBtn)
			: '';

		// Traveller BELUM berlinkung dengan doctype Traveller (slot guest
		// dalam booking reservation) — panel Booking menggantikan Personal
		// sebagai panel pertama modal & dikeluarkan dari section Booking Info.
		const noTvLink = !t.traveller;

		// Navigasi Prev/Next — senarai traveller paparan aktif dikumpul
		// saat modal dibuka (ctx). Butang dikunci pada hujung senarai;
		// posisi semasa dipapar di tengah. Butang Edit (✏) di kanan bar —
		// buka dialog edit maklumat peribadi (doctype Traveller sahaja).
		const navInner = (ctx?.list?.length > 1) ? (() => {
			const i = ctx.index ?? 0;
			const btn = (dir, label) => `<button type="button"
				class="btn btn-default btn-xs mba-tvmodal-nav-btn" data-dir="${dir}"
				${(dir < 0 && i <= 0) || (dir > 0 && i >= ctx.list.length - 1) ? ' disabled' : ''}>${label}</button>`;
			return `${btn(-1, '‹ ' + __('Prev'))}
				<span class="mba-tvmodal-navpos">${i + 1} / ${ctx.list.length}</span>
				${btn(1, __('Next') + ' ›')}`;
		})() : '';
		// Butang Edit (✏) — borang edit maklumat peribadi doctype Traveller
		// — IKON KECIL (tooltip), corak sama butang pen status.
		const editBtn = t.traveller
			? `<button type="button" class="btn btn-default btn-xs mba-tvmodal-edit-btn"
				title="${esc(__('Edit traveller info (Traveller doctype)'))}">✏</button>`
			: '';
		// Doctype — LINK (bukan butang) ke rekod doctype Traveller, TAB
		// BAHARU (modal kekal terbuka). Guest Link — modal link passport.
		const docBtn = t.traveller
			? `<a class="mba-tvdocstatus-link"
				href="/app/traveller/${encodeURIComponent(t.traveller)}" target="_blank" rel="noopener"
				title="${esc(__('Open Traveller doctype record in a new tab'))}">📄 Doctype ↗</a>`
			: '';
		const glinkBtn = t.reservation
			? `<button type="button" class="btn btn-default btn-xs mba-tvmodal-glink-btn"
				title="${esc(__('Guest passport link'))}">🔗 ${__('Guest Link')}</button>`
			: '';
		// Butang Status — ikon pen KECIL (✎) — corak sama pen status panel;
		// klik buka dialog quick status update (tooltip).
		const tvStatus = t.traveller_status || t.document_status || '';
		const statusBtn = t.traveller
			? `<button type="button" class="btn btn-default btn-xs mba-tvmodal-status-btn mba-status-pen-btn"
				title="${esc(__('Quick status update'))}">✎</button>`
			: '';
		// Header sticky tab Traveller Info — 2 KOLUM:
		// kiri  — label Document Status + badge status + ikon pen (quick
		//         update status doctype Traveller);
		// kanan — kanan-jajar: butang Edit + link Doctype (tab baharu).
		const docStatusHeader = t.traveller ? `
			<div class="mba-tvdocstatus">
				<div class="mba-tvdocstatus-title">${__('Document Status')}:
					${badge(tvStatus, DOC_STATUS_COLORS[tvStatus])}
					${statusBtn}</div>
				<div class="mba-tvdocstatus-actions">${docBtn}${editBtn}</div>
			</div>`
			: '';
		// Bar top — justify: kiri NAVIGASI Prev/Next, kanan Guest Link.
		// Slot guest tanpa link traveller tetap boleh papar Guest Link
		// (reservation wujud); bar hanya bila ada kandungan.
		const topbar = (navInner || glinkBtn)
			? `<div class="mba-tvmodal-top">
				<div class="mba-tvmodal-nav">${navInner}</div>
				<div class="mba-tvmodal-actions">${glinkBtn}</div>
			</div>`
			: '';

		// Semua panel (kad) BERDIRI SENDIRI — tiada lagi struktur collapsible
		// (mba-tvsec-head/body); tab hanya menumpukkan kad mengikut topik.
		// Tab Rooming & Flight — rooming/cruise + maklumat penerbangan
		// reservation (flight link pada Booking Reservation → doctype Flight).
		// Butang ✎ — borang kemaskini link Flight + Airline doctype
		// Booking Reservation — IKON KECIL pada bar tajuk kad (tooltip).
		const flightEditBtn = t.reservation
			? `<button type="button" class="btn btn-default btn-xs mba-fltedit-btn"
				title="${esc(__('Edit flight (Booking Reservation doctype)'))}">✎</button>`
			: '';
		const flightRows = crow(__('Flight'), F(t.flight_title) || F(t.flight))
			+ crow(__('PNR'), F(t.flight_pnr))
			+ crow(__('Departure'), t.flight_departure ? esc(fmtDate(t.flight_departure)) : '')
			+ crow(__('Arrival'), t.flight_arrival ? esc(fmtDate(t.flight_arrival)) : '')
			+ crow(__('Class'), F(t.flight_class))
			+ crow(__('Airline'), F(t.airline));
		// Kad Flight SENTIASA dipapar — corak sama kad Rooming (pintu masuk
		// Edit wujud walaupun belum ada penerbangan).
		const flightCard = card('✈ ' + __('Flight'),
			flightRows + (flightRows ? '' : crowS(__('Flight'), esc('-'))),
			flightEditBtn);

		// ── TAB kolum info — Traveller / Booking / Addon / Rooming & Flight.
		// Kandungan tab dirender dahulu, disembunyikan melalui CSS; klik
		// tab menukar kelas aktif (delegasi di bawah).
		const addonCount = t.addons_count || 0;
		const tabsDef = [
			{ id: 'tv', label: __('Traveller Info'),
				body: [docStatusHeader, personal, docs, contact, health].filter(Boolean).join('') },
			{ id: 'bkg', label: __('Booking Info'),
				body: [bookingCard, reservation].filter(Boolean).join('') },
			{ id: 'adn', label: __('Booking Addon Info'),
				body: addonCount
					? `<div class="mba-bkg-card"><div class="mba-bkg-card-title">${__('Addons')} (${addonCount})</div>${(t.addons_summary || '')
						.split('; ').filter(Boolean).map((a) => {
							const m = a.match(/^(.*) \((.*)\)$/);
							return crowS(m ? m[1] : a, m ? esc(m[2]) : '');
						}).join('')}</div>`
					: `<div class="mba-empty">${__('No addons for this reservation.')}</div>` },
			{ id: 'rmf', label: __('Rooming & Flight Info'),
				body: [rooming, cruise, flightCard].filter(Boolean).join('') },
		];
		const tvTabsHtml = `
			<div class="mba-tvtabs">
				${tabsDef.map((tb, i) => `<button type="button"
					class="mba-tvtab${i === 0 ? ' active' : ''}" data-tvtab="${tb.id}">${esc(tb.label)}</button>`).join('')}
			</div>
			${tabsDef.map((tb, i) => `<div class="mba-tvtab-pane${i === 0 ? ' active' : ''}" data-tvtabpane="${tb.id}">${tb.body}</div>`).join('')}`;

		// PC (skrin biasa) — modal maksimum, 2 kolum 50/50: preview dokumen
		// (kiri, sticky) + kad info (kanan, scroll). Telefon — bertindan.
		// Bar top (navigasi Prev/Next + Guest Link) berada DI ATAS grid
		// .mba-tvmodal — kekal kelihatan walaupun kolum info menatal. Tab
		// Traveller Info bermula dengan header sticky status dokumen
		// (Update Traveller / Doctype / Edit); semua kad berdiri sendiri.
		frappe.msgprint({
			title: '👤 ' + (t.traveller_name || t.guest_label || t.reservation),
			indicator: t.reservation_status === 'Cancelled' ? 'red' : 'blue',
			wide: true,
			message: `${topbar}
			<div class="mba-tvmodal">
				${side}
				<div class="mba-tvmodal-info">
					${tvTabsHtml}
				</div>
			</div>`,
		});

		// Z-index modal diuruskan oleh CSS page (.modal { z-index: 2000 }) —
		// tiada inline override di sini.

		// Butang dalam msgprint modal berada di luar container page — ikat
		// terus pada wrapper dialog (bukan delegasi $d).
		if (frappe.msg_dialog?.$wrapper) {
			frappe.msg_dialog.$wrapper.find('.mba-tvmodal-edit-btn').on('click', () => {
				open_traveller_edit_form(t, ctx);
			});
			// Butang Status — dialog pilih status doctype Traveller.
			frappe.msg_dialog.$wrapper.find('.mba-tvmodal-status-btn').on('click', () => {
				open_traveller_status_dialog(t, ctx);
			});
			// Butang status panel Booking / Booking Reservation — dialog
			// tukar status doctype berkenaan.
			frappe.msg_dialog.$wrapper.find('.mba-bkstatus-btn').on('click', () => {
				open_booking_status_dialog(t, ctx);
			});
			// Butang ✎ Edit panel Booking — borang kemaskini Booking Contact
			// doctype Booking (cust_email + get_cust_booking_phone).
			frappe.msg_dialog.$wrapper.find('.mba-bkedit-btn').on('click', () => {
				open_booking_contact_dialog(t, ctx);
			});
			// Butang ✎ Edit kad Rooming & kad Flight (tab Rooming & Flight
			// Info) — borang kemaskini medan doctype Booking Reservation.
			frappe.msg_dialog.$wrapper.find('.mba-rmedit-btn').on('click', () => {
				open_rooming_edit_dialog(t, ctx);
			});
			frappe.msg_dialog.$wrapper.find('.mba-fltedit-btn').on('click', () => {
				open_flight_edit_dialog(t, ctx);
			});
			frappe.msg_dialog.$wrapper.find('.mba-resstatus-btn').on('click', () => {
				open_reservation_status_dialog(t, ctx);
			});
			// Tab kolum info modal (Traveller/Booking/Addon/Rooming) —
			// modal msgprint di LUAR container page, ikat terus wrapper.
			frappe.msg_dialog.$wrapper.find('.mba-tvtab').on('click', function () {
				const $btn = $(this);
				const $wrap = $btn.closest('.mba-tvmodal-info');
				$wrap.find('.mba-tvtab').removeClass('active');
				$btn.addClass('active');
				$wrap.find('.mba-tvtab-pane').removeClass('active');
				$wrap.find(`.mba-tvtab-pane[data-tvtabpane="${$btn.data('tvtab')}"]`).addClass('active');
			});
			// Butang :doctype — target="_blank": pelayar buka tab baharu,
			// modal kekal terbuka (tiada handler diperlukan).
			// Butang Guest Link — papar modal link passport guest di atas
			// modal traveller (dialog berasingan, z-index sama, DOM kemudian).
			frappe.msg_dialog.$wrapper.find('.mba-tvmodal-glink-btn').on('click', () => {
				show_guest_link_dialog(t);
			});
			frappe.msg_dialog.$wrapper.find('.mba-tvmodal-nav-btn').on('click', function () {
				const dir = parseInt($(this).data('dir'), 10) || 0;
				const ni = (ctx?.index ?? 0) + dir;
				const nt = ctx?.list?.[ni];
				if (!nt) return;
				// msgprint APPEND bila msg_area sudah berisi — kosongkan
				// dahulu supaya kandungan modal DIGANTI, bukan bertindan.
				frappe.msg_dialog.clear?.();
				show_traveller_dialog(nt, { ...ctx, index: ni });
			});
			frappe.msg_dialog.$wrapper.find('.mba-crop-btn').on('click', () => {
				frappe.msg_dialog.hide();
				show_crop_dialog({
					traveller: t.traveller,
					field: 'passport_image',
					url: t.passport_image,
					name: t.traveller_name || '',
				});
			});
			// Butang ⬆ Replace — buka file picker; fail dipilih → muat naik
			// PRIVATE terus ke doctype Traveller (corak sama save_crop),
			// kemudian api('replace_traveller_file') — REPLACE dokumen
			// lama: alih snapshot reservation + padam File lama. Berjaya →
			// patch cache + render semula modal.
			frappe.msg_dialog.$wrapper.find('.mba-replace-btn').on('click', () => {
				frappe.msg_dialog.$wrapper.find('.mba-replace-input').get(0).click();
			});
			frappe.msg_dialog.$wrapper.find('.mba-replace-input').on('change', async function () {
				const file = this.files && this.files[0];
				this.value = '';
				if (!file) return;
				if (file.size > 15 * 1024 * 1024) {
					frappe.msgprint({
						title: __('File too large'),
						indicator: 'red',
						message: __('Maximum file size is 15 MB'),
					});
					return;
				}
				const $btn = frappe.msg_dialog.$wrapper.find('.mba-replace-btn')
					.prop('disabled', true);
				try {
					// Imej passport ialah PII — sentiasa PRIVATE (selari
					// crop & upload portal).
					const fd = new FormData();
					fd.append('file', file, file.name);
					fd.append('doctype', 'Traveller');
					fd.append('docname', t.traveller);
					fd.append('fieldname', 'passport_image');
					fd.append('is_private', '1');
					const resp = await fetch('/api/method/upload_file', {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'X-Frappe-CSRF-Token': (frappe.csrf_token || ''),
						},
						body: fd,
					});
					const out = await resp.json().catch(() => ({}));
					const newUrl = out.message && out.message.file_url;
					if (!resp.ok || !newUrl) {
						let msg = out.exc_type || out.exception || '';
						if (!msg && out._server_messages) {
							try { msg = JSON.parse(out._server_messages).join(' '); } catch (e) { /* abaikan */ }
						}
						throw new Error(msg || __('Upload failed'));
					}
					// REPLACE, bukan duplikasi — corak sama save_crop.
					await api('replace_traveller_file', {
						traveller: t.traveller,
						fieldname: 'passport_image',
						old_url: t.passport_image || '',
						new_url: newUrl,
					});
					refresh_traveller_caches(t.traveller, newUrl, 'passport_image');
					if (ctx?.list && ctx.list[ctx.index]) ctx.list[ctx.index].passport_image = newUrl;
					frappe.msg_dialog.clear();
					show_traveller_dialog({ ...t, passport_image: newUrl }, ctx);
					frappe.show_alert({ message: __('Document replaced'), indicator: 'green' });
				} catch (err) {
					console.error('replace upload failed:', err);
					frappe.msgprint({
						title: __('Upload failed'),
						indicator: 'red',
						message: esc(String(err.message || err)),
					});
				} finally {
					$btn.prop('disabled', false);
				}
			});
			frappe.msg_dialog.$wrapper.find('.mba-file-view-btn').on('click', function () {
				const $b = $(this);
				show_file_viewer($b.data('name'), $b.data('url'), !!$b.data('image'));
			});

			// Booking Info Overview — Order Summary LAZY (virtual property
			// Booking; kiraan SO agak berat untuk setiap baris senarai).
			// Berjaya → row '…' diisi & cache baris dipatch supaya navigasi
			// Prev/Next tidak mengira semula. Modal mungkin sudah bertukar
			// ke traveller lain — hanya isi bila row '…' booking yang sama
			// masih dipapar (data-booking).
			if (t.booking && t.order_summary == null) {
				api('get_booking_order_summary', { booking: t.booking }).then((out) => {
					const val = out?.order_summary ?? '';
					const patch = { order_summary: val };
					Object.assign(t, patch);
					if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], patch);
					patch_booking_caches(t.booking, patch);
					frappe.msg_dialog?.$wrapper?.find('.mba-bkg-osum--load')
						.filter((_, el) => el.dataset.booking === t.booking)
						.text(val || '-')
						.removeClass('mba-bkg-osum--load');
				}).catch(() => {}); // api() sudah papar alert ralat
			}

			 // Header sticky tab Traveller Info — laraskan offset tepat di
			// BAWAH bar tab. Ukuran selepas layout stabil (rAF) + sekali
			// lagi selepas 300ms (font/render lewat); dilangkau bila tinggi
			// 0. Skrin kecil: header tidak sticky (CSS fallback 41px only
			// ≥992px).
			if (window.matchMedia('(min-width: 992px)').matches) {
				const applyHdrTop = () => {
					const tabEl = frappe.msg_dialog?.$wrapper?.find(
						'.mba-tvmodal-info .mba-tvtabs').get(0);
					if (!tabEl) return;
					const h = Math.ceil(tabEl.getBoundingClientRect().height);
					if (h > 0) frappe.msg_dialog.$wrapper.find('.mba-tvdocstatus')
						.css('top', h + 'px');
				};
				requestAnimationFrame(applyHdrTop);
				setTimeout(applyHdrTop, 300);
			}
		}
	}

	// Kemaskini cache dalaman + paparan tab selepas tukar imej passport.
	// Kemaskini cache dalaman (L3 profile.reservations & L2 travellers)
	// + paparan tab aktif selepas tukar imej passport.
	function refresh_traveller_caches(traveller, url, field) {
		Object.entries(S.cache).forEach(([k, c]) => {
			let hit = false;
			(c?.profile?.reservations || []).forEach((r) => {
				if (r.traveller === traveller) { r[field || 'passport_image'] = url; hit = true; }
			});
			(c?.travellers?.travellers || []).forEach((r) => {
				if (r.traveller === traveller) { r[field || 'passport_image'] = url; hit = true; }
			});
			(c?.tvAll?.travellers || []).forEach((r) => {
				if (r.traveller === traveller) { r[field || 'passport_image'] = url; hit = true; }
			});
			if (!hit) return;
			const $g = $(`#mba-detail .mba-group[data-item="${k}"]`);
			const tvPane = $g.find('.mba-tab-pane[data-pane="tv"]');
			if (tvPane.length && tvPane.hasClass('active')) render_bkg_travellers(k);
			const trPane = $g.find('.mba-tab-pane[data-pane="traveller"]');
			if (trPane.length && trPane.hasClass('active')) render_travellers_tab(k);
		});
	}

	// Padam beberapa medan sekaligus pada cache baris traveller (edit modal)
	// + render semula tab aktif — kelainan pelbagai medan refresh_traveller_
	// caches (satu medan, imej).
	function patch_traveller_caches(traveller, patch) {
		Object.entries(S.cache).forEach(([k, c]) => {
			let hit = false;
			(c?.profile?.reservations || []).forEach((r) => {
				if (r.traveller === traveller) { Object.assign(r, patch); hit = true; }
			});
			(c?.travellers?.travellers || []).forEach((r) => {
				if (r.traveller === traveller) { Object.assign(r, patch); hit = true; }
			});
			(c?.tvAll?.travellers || []).forEach((r) => {
				if (r.traveller === traveller) { Object.assign(r, patch); hit = true; }
			});
			if (!hit) return;
			const $g = $(`#mba-detail .mba-group[data-item="${k}"]`);
			const tvPane = $g.find('.mba-tab-pane[data-pane="tv"]');
			if (tvPane.length && tvPane.hasClass('active')) render_bkg_travellers(k);
			const trPane = $g.find('.mba-tab-pane[data-pane="traveller"]');
			if (trPane.length && trPane.hasClass('active')) render_travellers_tab(k);
		});
	}

	// Kembar patch_traveller_caches — padan BARIS mengikut nama Booking
	// Reservation (bulk edit medan group reservation: pax_type, room_privacy,
	// room_category, reservation_status).
	function patch_reservation_caches(reservation, patch) {
		Object.entries(S.cache).forEach(([k, c]) => {
			let hit = false;
			(c?.profile?.reservations || []).forEach((r) => {
				if (r.reservation === reservation) { Object.assign(r, patch); hit = true; }
			});
			(c?.travellers?.travellers || []).forEach((r) => {
				if (r.reservation === reservation) { Object.assign(r, patch); hit = true; }
			});
			(c?.tvAll?.travellers || []).forEach((r) => {
				if (r.reservation === reservation) { Object.assign(r, patch); hit = true; }
			});
			if (!hit) return;
			const $g = $(`#mba-detail .mba-group[data-item="${k}"]`);
			const tvPane = $g.find('.mba-tab-pane[data-pane="tv"]');
			if (tvPane.length && tvPane.hasClass('active')) render_bkg_travellers(k);
			const trPane = $g.find('.mba-tab-pane[data-pane="traveller"]');
			if (trPane.length && trPane.hasClass('active')) render_travellers_tab(k);
		});
	}

	// Kembar patch — padan SEMUA baris dalam Booking yang sama (status
	// doctype Booking dikongsi merentas reservation anak-anaknya).
	function patch_booking_caches(booking, patch) {
		Object.entries(S.cache).forEach(([k, c]) => {
			let hit = false;
			(c?.profile?.reservations || []).forEach((r) => {
				if (r.booking === booking) { Object.assign(r, patch); hit = true; }
			});
			(c?.travellers?.travellers || []).forEach((r) => {
				if (r.booking === booking) { Object.assign(r, patch); hit = true; }
			});
			(c?.tvAll?.travellers || []).forEach((r) => {
				if (r.booking === booking) { Object.assign(r, patch); hit = true; }
			});
			if (!hit) return;
			const $g = $(`#mba-detail .mba-group[data-item="${k}"]`);
			const tvPane = $g.find('.mba-tab-pane[data-pane="tv"]');
			if (tvPane.length && tvPane.hasClass('active')) render_bkg_travellers(k);
			const trPane = $g.find('.mba-tab-pane[data-pane="traveller"]');
			if (trPane.length && trPane.hasClass('active')) render_travellers_tab(k);
		});
	}

	// ── Katalog medan BULK edit (cermin BULK_EDIT_FIELDS server) — key unik
	// → widget nilai (FieldGroup). Group = doctype sasaran submission: kunci
	// "Traveller" dihantar dgn senarai traveller, "Booking Reservation" dgn
	// senarai reservation. BULK_PATCH_KEYS memetakan key → kunci baris cache
	// klien supaya senarai render semula tanpa reload. ──
	const BULK_EDIT_FIELDS = [
		{ key: 'status', group: 'Traveller', label: 'Document Status',
			fieldtype: 'Select', options: TRAVELLER_STATUS_OPTIONS },
		{ key: 'gender', group: 'Traveller', label: 'Gender',
			fieldtype: 'Select', options: ['Male', 'Female'] },
		{ key: 'passport_no', group: 'Traveller', label: 'Passport No', fieldtype: 'Data' },
		{ key: 'passport_expiry', group: 'Traveller', label: 'Passport Expiry', fieldtype: 'Date' },
		{ key: 'ic_number', group: 'Traveller', label: 'IC Number', fieldtype: 'Data' },
		{ key: 'nationality', group: 'Traveller', label: 'Nationality',
			fieldtype: 'Link', options: 'Country' },
		{ key: 'email', group: 'Traveller', label: 'Email', fieldtype: 'Data' },
		{ key: 'phone', group: 'Traveller', label: 'Phone', fieldtype: 'Phone' },
		{ key: 'address_line1', group: 'Traveller', label: 'Address Line 1', fieldtype: 'Small Text' },
		{ key: 'city', group: 'Traveller', label: 'City', fieldtype: 'Data' },
		{ key: 'state', group: 'Traveller', label: 'State', fieldtype: 'Data' },
		{ key: 'postcode', group: 'Traveller', label: 'Postcode', fieldtype: 'Data' },
		{ key: 'country', group: 'Traveller', label: 'Country',
			fieldtype: 'Link', options: 'Country' },
		{ key: 'emergency_contact_name', group: 'Traveller',
			label: 'Emergency Contact Name', fieldtype: 'Data' },
		{ key: 'emergency_contact_phone', group: 'Traveller',
			label: 'Emergency Contact Phone', fieldtype: 'Phone' },
		{ key: 'emergency_contact_relationship', group: 'Traveller',
			label: 'Relationship', fieldtype: 'Data' },
		{ key: 'pax_type', group: 'Booking Reservation', label: 'Passenger Type', fieldtype: 'Data' },
		{ key: 'room_privacy', group: 'Booking Reservation', label: 'Room Privacy',
			fieldtype: 'Select', options: ['Private', 'Open Sharing'] },
		{ key: 'room_category', group: 'Booking Reservation', label: 'Room Category',
			fieldtype: 'Link', options: 'Trip Price Category' },
		{ key: 'reservation_status', group: 'Booking Reservation',
			label: 'Reservation Status', fieldtype: 'Select',
			options: ['Waiting Document', 'Document Completed', 'Document Expired',
				'Preparation Completed', 'Trip On Progress', 'Completed', 'Cancelled'] },
	];
	const BULK_PATCH_KEYS = {
		status: ['status', 'traveller_status', 'document_status'],
		gender: ['gender'], passport_no: ['passport_no'],
		passport_expiry: ['passport_expiry'], ic_number: ['ic_number'],
		nationality: ['nationality'], email: ['tv_email'], phone: ['tv_phone'],
		address_line1: ['address_line1'], city: ['city'], state: ['state'],
		postcode: ['postcode'], country: ['country'],
		emergency_contact_name: ['emergency_contact_name'],
		emergency_contact_phone: ['emergency_contact_phone'],
		emergency_contact_relationship: ['emergency_contact_relationship'],
		pax_type: ['pax_type'], room_privacy: ['room_privacy'],
		room_category: ['room_category'], reservation_status: ['reservation_status'],
	};

	// ── Dialog BULK edit pelbagai medan — dibuka dari butang Bulk Edit
	// (table view). User PILIH medan (katalog di atas) → widget nilai dirender
	// mengikut fieldtype medan (Select/Date/Link/Data/Phone — FieldGroup
	// Frappe, sama seperti borang edit modal). Apply → api('bulk_update_
	// travellers', {travellers, reservations, field, value}); server menentukan
	// DOCTYPE sasaran daripada katalog (Traveller / Booking Reservation) dan
	// memproses setiap rekod berasingan. Ringkasan updated/skipped/failed
	// dipapar sebagai alert; berjaya → patch cache baris + render semula. ──
	function open_traveller_bulk_dialog($pane, rows) {
		const travellers = [...new Set(rows.map((r) => r.traveller).filter(Boolean))];
		const reservations = [...new Set(rows.map((r) => r.reservation).filter(Boolean))];
		const groups = ['Traveller', 'Booking Reservation'];
		const d = new frappe.ui.Dialog({
			title: '⚙ ' + __('Bulk Edit') + ' — ' + __('{0} travellers', [rows.length]),
		});
		d.$body.html(`
			<div class="mba-tvbulk">
				<div class="mba-glink-meta">${__('Choose the field to update for all selected rows')}:</div>
				<select class="form-control mba-tvbulk-field">
					<option value="">— ${__('Select Field')} —</option>
					${groups.map((g) => `
						<optgroup label="${esc(__(g))}">
							${BULK_EDIT_FIELDS.filter((f) => f.group === g).map((f) =>
								`<option value="${f.key}">${esc(__(f.label))}</option>`).join('')}
						</optgroup>`).join('')}
				</select>
				<div class="mba-tvbulk-value" style="margin-top:10px;"></div>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-tvbulk-apply" disabled>
						${__('Apply to All')}</button>
				</div>
				<div class="mba-glink-meta mba-muted">${__(
					'Each field is saved through its own doctype form — Traveller fields via Traveller, reservation fields via Booking Reservation. Rows without the target record are skipped.')}</div>
			</div>`);

		let fg = null;
		const $val = d.$body.find('.mba-tvbulk-value');
		const $apply = d.$body.find('.mba-tvbulk-apply');
		const getSel = () => BULK_EDIT_FIELDS.find(
			(x) => x.key === d.$body.find('.mba-tvbulk-field').val());
		// Widget nilai ikut fieldtype medan dipilih — FieldGroup lama
		// dibuang dahulu (badan dikosongkan; instance diganti).
		const renderValue = () => {
			$val.empty();
			fg = null;
			$apply.prop('disabled', true);
			const f = getSel();
			if (!f) return;
			fg = new frappe.ui.FieldGroup({
				fields: [{
					fieldtype: f.fieldtype, fieldname: 'bulk_value',
					label: __(f.label), options: f.options, reqd: 1,
				}],
				body: $val.get(0),
				// Enter TIDAK memicu aksi global Desk (trigger_primary_action).
				no_submit_on_enter: true,
			});
			fg.make();
			$apply.prop('disabled', false);
		};
		d.$body.find('.mba-tvbulk-field').on('change', renderValue);

		$apply.on('click', async function () {
			const f = getSel();
			if (!f) return;
			let v = '';
			try {
				v = fg ? (fg.get_values(true)?.bulk_value ?? '') : '';
			} catch (e) {
				console.error('bulk edit get_values:', e);
				return;
			}
			if (v === '' || v == null) {
				frappe.show_alert({ message: __('Please enter a value'), indicator: 'orange' });
				return;
			}
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('bulk_update_travellers', {
					travellers, reservations, field: f.key, value: String(v),
				});
				d.hide();
				// Nilai EFEKTIF daripada server (Phone disanitize dsb.) —
				// patch cache baris ikut kunci cache medan berkenaan.
				const vOut = out.value != null ? String(out.value) : String(v);
				const patch = {};
				(BULK_PATCH_KEYS[f.key] || []).forEach((k) => { patch[k] = vOut; });
				(out.updated || []).forEach((name) => {
					if (f.group === 'Traveller') patch_traveller_caches(name, patch);
					else patch_reservation_caches(name, patch);
				});
				frappe.show_alert({
					message: __('{0}: {1} updated, {2} skipped, {3} failed', [
						__(f.label), (out.updated || []).length,
						(out.skipped || []).length, (out.failed || []).length]),
					indicator: (out.failed || []).length ? 'orange' : 'green',
				});
				$pane.find('.mba-tv-checkall').prop('checked', false);
				$pane.find('.mba-tv-bulk-btn').prop('disabled', true).text(__('Bulk Edit'));
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
		d.show();
	}

	// ── Dialog kemaskini status doctype Traveller — dibuka dari butang
	// Status (paling kanan bar top modal). api('update_traveller_status')
	// (admin-only) → doc.save() penuh (before_save/on_update doctype urus
	// auto-flow & sebar ke Booking Reservation). Berjaya → patch cache +
	// render semula modal supaya label butang & badge ikut status baharu. ──
	function open_traveller_status_dialog(t, ctx) {
		if (!t.traveller) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;
		const cur = t.traveller_status || t.document_status || '';
		const name = (t.traveller_name && t.traveller_name !== '-')
			? t.traveller_name : (t.guest_label || t.reservation);
		const d = new frappe.ui.Dialog({
			title: '⚑ ' + __('Update Traveller Status') + ' — ' + name,
		});
		d.$body.html(`
			<div class="mba-tvstatus">
				<div class="mba-glink-meta">${__('Traveller')}: <b>${esc(t.traveller)}</b></div>
				<select class="form-control mba-tvstatus-sel">${TRAVELLER_STATUS_OPTIONS.map((s) =>
					`<option value="${s}" ${s === cur ? 'selected' : ''}>${__(s)}</option>`).join('')}</select>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-tvstatus-save">${__('Update Status')}</button>
				</div>
			</div>`);
		d.show();
		d.$body.find('.mba-tvstatus-save').on('click', async function () {
			const status = d.$body.find('.mba-tvstatus-sel').val();
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('update_traveller_status', { traveller: t.traveller, status });
				const patch = {
					status: out.status,
					traveller_status: out.status,
					document_status: out.document_status || out.status,
				};
				patch_traveller_caches(t.traveller, patch);
				if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], patch);
				const t2 = { ...t, ...patch };
				d.hide();
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({ message: __('Traveller status updated'), indicator: 'green' });
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
	}

	// ── Dialog tukar status doctype Booking — dibuka dari butang status
	// pada bar tajuk panel Booking (modal traveller). api('update_booking_
	// status') → doc.save() penuh (hook doctype Booking kekal berjalan).
	// Berjaya → patch cache SEMUA baris booking + render semula modal. ──
	function open_booking_status_dialog(t, ctx) {
		if (!t.booking) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;
		const d = new frappe.ui.Dialog({
			title: '📋 ' + __('Update Booking Status') + ' — ' + (t.booking_number || t.booking),
		});
		d.$body.html(`
			<div class="mba-tvstatus">
				<div class="mba-glink-meta">${__('Booking')}: <b>${esc(t.booking)}</b></div>
				<select class="form-control mba-bkstatus-sel">${BOOKING_STATUS_OPTIONS.filter(Boolean).map((s) =>
					`<option value="${s}" ${s === (t.booking_status || '') ? 'selected' : ''}>${__(s)}</option>`).join('')}</select>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-bkstatus-save">${__('Update Status')}</button>
				</div>
			</div>`);
		d.show();
		d.$body.find('.mba-bkstatus-save').on('click', async function () {
			const status = d.$body.find('.mba-bkstatus-sel').val();
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('update_booking_status', { booking: t.booking, status });
				const patch = { booking_status: out.booking_status || status };
				patch_booking_caches(t.booking, patch);
				if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], patch);
				const t2 = { ...t, ...patch };
				d.hide();
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({ message: __('Booking status updated'), indicator: 'green' });
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
	}

	// ── Dialog EDIT Booking Contact — dibuka dari butang ✎ Edit pada bar
	// tajuk panel Booking (modal traveller). FieldGroup: Customer Email +
	// Customer Phone — snapshot per booking pada doctype Booking
	// (cust_email + get_cust_booking_phone); nama customer dipapar sahaja
	// (master data doctype Customer, TIDAK diubah dari sini).
	// api('update_booking_contact') → doc.save() penuh (hook doctype
	// Booking kekal berjalan). Berjaya → patch cache SEMUA baris booking +
	// render semula modal. ──
	function open_booking_contact_dialog(t, ctx) {
		if (!t.booking) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;
		const d = new frappe.ui.Dialog({
			title: '📋 ' + __('Edit Booking Contact') + ' — ' + (t.booking_number || t.booking),
		});
		d.$body.html(`
			<div class="mba-tvstatus">
				<div class="mba-glink-meta">${__('Customer')}: <b>${esc(t.customer_name || '-')}</b>
					<span class="mba-muted">${esc(__('Booking doctype snapshot — Customer master data is not changed'))}</span></div>
				<div class="mba-bkcontact-fields"></div>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-bkcontact-save">${__('Save')}</button>
				</div>
			</div>`);
		const fg = new frappe.ui.FieldGroup({
			// SALINAN senarai — FieldGroup.make() memutasikan array yang
			// dihantar (corak borang edit traveller).
			fields: [
				{ fieldtype: 'Data', fieldname: 'cust_email', label: __('Customer Email') },
				{ fieldtype: 'Phone', fieldname: 'cust_phone', label: __('Customer Phone') },
			],
			body: d.$body.find('.mba-bkcontact-fields').get(0),
			// Enter TIDAK memicu aksi global Desk (luar dialog framework).
			no_submit_on_enter: true,
		});
		fg.make();
		fg.set_values({ cust_email: t.cust_email || '', cust_phone: t.cust_phone || '' });
		// Kawalan Phone — setup negara (bendera/ISD) ASYNC dalam frappe;
		// paksa negara lalai (Malaysia) bila nilai tiada awalan kod negara
		// (corak sama borang edit traveller).
		const applyPhoneCountry = (tries = 0) => {
			const ctl = fg.get_field('cust_phone');
			if (!ctl) return;
			const val = String(ctl.get_value() || '');
			if (ctl.country_code_picker && ctl.country_codes) {
				if (val && !val.includes('-')) {
					const info = ctl.country_codes['Malaysia'];
					if (info) {
						ctl.set_flag?.(info.code);
						if (ctl.$isd?.length) ctl.$isd.text(info.isd);
						ctl.set_value(info.isd + '-' + val.replace(/^-+/, ''));
					}
				}
			} else if (tries < 20) {
				setTimeout(() => applyPhoneCountry(tries + 1), 250);
			}
		};
		applyPhoneCountry();
		d.show();
		d.$body.find('.mba-bkcontact-save').on('click', async function () {
			const vals = fg.get_values(true) || {};
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('update_booking_contact', {
					booking: t.booking,
					cust_email: String(vals.cust_email || '').trim(),
					cust_phone: String(vals.cust_phone || '').trim(),
				});
				const patch = {
					cust_email: out?.cust_email || '',
					cust_phone: out?.cust_phone || '',
				};
				patch_booking_caches(t.booking, patch);
				if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], patch);
				const t2 = { ...t, ...patch };
				d.hide();
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({ message: __('Booking contact updated'), indicator: 'green' });
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
	}

	// ── Dialog tukar status doctype Booking Reservation — dibuka dari
	// butang status pada bar tajuk panel Booking Reservation. api('update_
	// reservation_status') → doc.save() penuh (before_save/on_update doctype
	// kekal berjalan). Berjaya → patch cache baris + render semula modal. ──
	function open_reservation_status_dialog(t, ctx) {
		if (!t.reservation) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;
		const d = new frappe.ui.Dialog({
			title: '🧾 ' + __('Update Reservation Status') + ' — ' + t.reservation,
		});
		d.$body.html(`
			<div class="mba-tvstatus">
				<div class="mba-glink-meta">${__('Reservation')}: <b>${esc(t.reservation)}</b></div>
				<select class="form-control mba-resstatus-sel">${RESERVATION_STATUS_OPTIONS.map((s) =>
					`<option value="${s}" ${s === (t.reservation_status || '') ? 'selected' : ''}>${__(s)}</option>`).join('')}</select>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-resstatus-save">${__('Update Status')}</button>
				</div>
			</div>`);
		d.show();
		d.$body.find('.mba-resstatus-save').on('click', async function () {
			const status = d.$body.find('.mba-resstatus-sel').val();
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('update_reservation_status', { reservation: t.reservation, status });
				const patch = { reservation_status: out.reservation_status || status };
				patch_reservation_caches(t.reservation, patch);
				if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], patch);
				const t2 = { ...t, ...patch };
				d.hide();
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({ message: __('Reservation status updated'), indicator: 'green' });
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
	}

	// ── Dialog EDIT Rooming (accommodation) — dibuka dari butang ✎ Edit
	// kad Rooming (tab Rooming & Flight Info, modal traveller). FieldGroup
	// merangkumi medan cruise (Stateroom/Delegate/Aroya) — kad Cruise Cabin
	// dipapar berasingan bila ada nilai. api('update_reservation_info') →
	// doc.save() penuh (hook doctype Booking Reservation kekal berjalan).
	// Berjaya → patch cache SEMUA baris reservation + render semula modal. ──
	function open_rooming_edit_dialog(t, ctx) {
		if (!t.reservation) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;
		const d = new frappe.ui.Dialog({
			title: '🛏 ' + __('Edit Rooming / Accommodation') + ' — '
				+ ((t.traveller_name && t.traveller_name !== '-')
					? t.traveller_name : t.reservation),
		});
		d.$body.html(`
			<div class="mba-tvstatus">
				<div class="mba-glink-meta">${__('Reservation')}: <b>${esc(t.reservation)}</b>
					<span class="mba-muted">${esc(__('Booking Reservation doctype'))}</span></div>
				<div class="mba-rmedit-fields"></div>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-rmedit-save">${__('Save')}</button>
				</div>
			</div>`);
		const fg = new frappe.ui.FieldGroup({
			// SALINAN senarai — FieldGroup.make() memutasikan array yang
			// dihantar (corak borang edit traveller).
			fields: [
				{ fieldtype: 'Data', fieldname: 'room_id', label: __('Room ID') },
				{ fieldtype: 'Link', fieldname: 'room_category',
					label: __('Room Category'), options: 'Trip Price Category' },
				{ fieldtype: 'Select', fieldname: 'room_privacy',
					label: __('Room Privacy'), options: ['', 'Private', 'Open Sharing'] },
				{ fieldtype: 'Int', fieldname: 'guest_sequence', label: __('Guest Sequence') },
				{ fieldtype: 'Data', fieldname: 'pax_type', label: __('Guest Rooming Type') },
				{ fieldtype: 'Check', fieldname: 'cabin_is_confirmed',
					label: __('Room Arrangement Confirmed') },
				{ fieldtype: 'Section Break', fieldname: 'cruise_sb',
					label: __('Cruise Cabin') },
				{ fieldtype: 'Data', fieldname: 'stateroom_no', label: __('Stateroom No') },
				{ fieldtype: 'Data', fieldname: 'delegate_no', label: __('Delegate No') },
				{ fieldtype: 'Int', fieldname: 'aroya_guest_no', label: __('Aroya Guest No') },
			],
			body: d.$body.find('.mba-rmedit-fields').get(0),
			// Enter TIDAK memicu aksi global Desk (luar dialog framework).
			no_submit_on_enter: true,
		});
		fg.make();
		fg.set_values({
			room_id: t.room_id || '',
			room_category: t.room_category || '',
			room_privacy: t.room_privacy || '',
			guest_sequence: parseInt(t.guest_sequence, 10) || 0,
			pax_type: t.pax_type || '',
			cabin_is_confirmed: t.cabin_confirmed ? 1 : 0,
			stateroom_no: t.stateroom_no || '',
			delegate_no: t.delegate_no || '',
			aroya_guest_no: parseInt(t.aroya_guest_no, 10) || 0,
		});
		// Segar label Link (Room Category) selepas nilai diisi — corak
		// borang edit traveller.
		['room_category'].forEach((f) => {
			d.$body.find(`.frappe-control[data-fieldname="${f}"] input`).trigger('change');
		});
		d.show();
		d.$body.find('.mba-rmedit-save').on('click', async function () {
			const vals = fg.get_values(true) || {};
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('update_reservation_info', {
					reservation: t.reservation, values: vals,
				});
				patch_reservation_caches(t.reservation, out);
				if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], out);
				const t2 = { ...t, ...out };
				d.hide();
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({ message: __('Rooming info updated'), indicator: 'green' });
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
	}

	// ── Dialog EDIT Flight — dibuka dari butang ✎ Edit kad Flight (tab
	// Rooming & Flight Info). Link doctype: Flight + Flight Airline —
	// PNR/jadual/kelas dipapar daripada doctype Flight (diurus di sana).
	// api('update_reservation_info') → doc.save() penuh. Berjaya → patch
	// cache SEMUA baris reservation + render semula modal. ──
	function open_flight_edit_dialog(t, ctx) {
		if (!t.reservation) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;
		const d = new frappe.ui.Dialog({
			title: '✈ ' + __('Edit Flight') + ' — '
				+ ((t.traveller_name && t.traveller_name !== '-')
					? t.traveller_name : t.reservation),
		});
		d.$body.html(`
			<div class="mba-tvstatus">
				<div class="mba-glink-meta">${__('Reservation')}: <b>${esc(t.reservation)}</b>
					<span class="mba-muted">${esc(__('Booking Reservation doctype'))}</span></div>
				<div class="mba-fltedit-fields"></div>
				<div class="mba-file-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm mba-fltedit-save">${__('Save')}</button>
				</div>
			</div>`);
		const fg = new frappe.ui.FieldGroup({
			fields: [
				{ fieldtype: 'Link', fieldname: 'flight',
					label: __('Flight'), options: 'Flight' },
				{ fieldtype: 'Link', fieldname: 'airline',
					label: __('Flight Airline'), options: 'Flight Airline' },
			],
			body: d.$body.find('.mba-fltedit-fields').get(0),
			no_submit_on_enter: true,
		});
		fg.make();
		fg.set_values({ flight: t.flight || '', airline: t.airline || '' });
		// Segar label Link selepas nilai diisi — corak borang edit traveller.
		['flight', 'airline'].forEach((f) => {
			d.$body.find(`.frappe-control[data-fieldname="${f}"] input`).trigger('change');
		});
		d.show();
		d.$body.find('.mba-fltedit-save').on('click', async function () {
			const vals = fg.get_values(true) || {};
			const $btn = $(this).prop('disabled', true);
			try {
				const out = await api('update_reservation_info', {
					reservation: t.reservation, values: vals,
				});
				patch_reservation_caches(t.reservation, out);
				if (ctx?.list && ctx.list[ctx.index]) Object.assign(ctx.list[ctx.index], out);
				const t2 = { ...t, ...out };
				d.hide();
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({ message: __('Flight info updated'), indicator: 'green' });
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		});
	}

	// ── Borang EDIT maklumat peribadi Traveller — DIRENDER DI DALAM modal
	// view sedia ada, MENGGANTIKAN kandungan kolum kedua (.mba-tvmodal-info).
	// Bar top navigasi/Edit berada di luar grid — kekal dipapar di atas
	// borang. Kolum kiri preview passport tidak disentuh; tiada modal
	// bertindan. FieldGroup Frappe memberi kontrol penuh (Link Country,
	// Date picker, Attach upload). Semua disimpan MELALUI DOCTYPE TRAVELLER
	// sahaja (endpoint update_traveller_info: get_doc → set medan whitelist
	// → save). Snapshot Booking Reservation tidak disentuh; before_save
	// doctype urus uppercase nama/alamat, full_name, umur & title↔gender. ──
	function open_traveller_edit_form(t, ctx) {
		if (!t.traveller) return;
		const $dlg = frappe.msg_dialog?.$wrapper;
		if (!$dlg || !$dlg.find('.mba-tvmodal').length) return;

		// Setiap seksyen borang = PANEL KAD bersempadan (border), berkepala
		// (summary) & boleh collapse (details). Satu FieldGroup PER PANEL —
		// nilai dikumpul daripada semua panel semasa save. Panel Identity
		// dirender INLINE (medan sebaris, label kekal).
		const panelsDef = [
			{ key: 'identity', title: __('Identity'), inline: true, fields: [
				{ fieldtype: 'Select', fieldname: 'title', label: __('Title'),
					options: ['', 'Mr', 'Mrs'] },
				{ fieldtype: 'Select', fieldname: 'gender', label: __('Gender'),
					options: ['', 'Male', 'Female'] },
			] },
			{ key: 'name', title: __('Name'), fields: [
				{ fieldtype: 'Data', fieldname: 'first_name', label: __('First Name'), reqd: 1 },
				{ fieldtype: 'Data', fieldname: 'last_name', label: __('Last Name'), reqd: 1 },
			] },
			{ key: 'docs', title: __('Documents'), inline: true, fields: [
				{ fieldtype: 'Data', fieldname: 'passport_no', label: __('Passport No') },
				{ fieldtype: 'Date', fieldname: 'passport_expiry', label: __('Passport Expiry') },
				{ fieldtype: 'Data', fieldname: 'ic_number', label: __('IC Number') },
				{ fieldtype: 'Date', fieldname: 'date_of_birth', label: __('Date of Birth') },
				{ fieldtype: 'Link', fieldname: 'nationality', label: __('Nationality'),
					options: 'Country' },
				{ fieldtype: 'Attach', fieldname: 'visa_photo', label: __('Visa Image') },
			] },
			{ key: 'contact', title: __('Contact'), fields: [
				{ fieldtype: 'Data', fieldname: 'email', label: __('Email') },
				{ fieldtype: 'Phone', fieldname: 'phone', label: __('Phone') },
			] },
			{ key: 'health', title: __('Health & Special Needs'), fields: [
				{ fieldtype: 'Select', fieldname: 'wheelchair_assistant',
					label: __('Wheelchair Assistant'),
					options: ['', 'Not Required', 'Long Walk Only', 'All Time'] },
				{ fieldtype: 'Small Text', fieldname: 'dietary_requirements',
					label: __('Dietary Requirements') },
				{ fieldtype: 'Small Text', fieldname: 'medical_conditions',
					label: __('Medical Conditions') },
				{ fieldtype: 'Small Text', fieldname: 'medicine_treatment',
					label: __('Medicine / Treatment') },
			] },
			{ key: 'address', title: __('Address'), fields: [
				{ fieldtype: 'Small Text', fieldname: 'address_line1',
					label: __('Address Line 1') },
				{ fieldtype: 'Data', fieldname: 'postcode', label: __('Postcode') },
				{ fieldtype: 'Data', fieldname: 'city', label: __('City') },
				{ fieldtype: 'Data', fieldname: 'state', label: __('State') },
				{ fieldtype: 'Link', fieldname: 'country', label: __('Country'),
					options: 'Country' },
			] },
			{ key: 'emergency', title: __('Emergency Contact'), fields: [
				{ fieldtype: 'Data', fieldname: 'emergency_contact_name', label: __('Name') },
				{ fieldtype: 'Phone', fieldname: 'emergency_contact_phone', label: __('Phone') },
				{ fieldtype: 'Data', fieldname: 'emergency_contact_relationship',
					label: __('Relationship') },
			] },
		];

		// Panel pengganti kandungan kolum kanan — kosongkan .mba-tvmodal-info
		// dan lampirkan borang. Bar top (.mba-tvmodal-top) berada DI LUAR
		// grid .mba-tvmodal (atas modal) — tak terjejas; navigasi Prev/Next &
		// butang Edit kekal kelihatan semasa borang terbuka. Kolum kiri
		// (preview passport) tidak disentuh. Boleh dipanggil semula (klik
		// Edit berulang) — borang lama dibuang dahulu.
		const $info = $dlg.find('.mba-tvmodal-info');
		$info.children().remove();
		$info.append(`
			<div class="mba-tvedit">
				<div class="mba-tvedit-head">
					<div class="mba-tvedit-head-title">
						<b>${__('Edit Traveller Info')}</b>
						<span class="mba-muted">${esc(t.traveller_name || t.traveller)}</span>
					</div>
					<div class="mba-tvedit-head-actions">
						<button type="button" class="btn btn-primary btn-sm mba-tvedit-save">
							${__('Save')}</button>
						<button type="button" class="btn btn-default btn-sm mba-tvedit-cancel">
							${__('Cancel')}</button>
					</div>
				</div>
				<div class="mba-tvedit-body">
					<div class="mba-tvedit-panels">
						${panelsDef.map((p) => `
							<details class="mba-tvedit-panel" data-panel="${p.key}">
								<summary>${esc(p.title)}</summary>
								<div class="mba-tvedit-panel-body${p.inline ? ' mba-tvedit-panel-body--inline' : ''}"></div>
							</details>`).join('')}
					</div>
				</div>
			</div>`);

		// Satu FieldGroup per panel — nilai awal daripada baris traveller.
		const panelFgs = panelsDef.map((p) => {
			const body = $info.find(`.mba-tvedit-panel[data-panel="${p.key}"] .mba-tvedit-panel-body`).get(0);
			const fg = new frappe.ui.FieldGroup({
				// SALINAN senarai — FieldGroup.make() MEMUTASIKAN array yang
				// dihantar (Layout.render unshift Section Break pembuka,
				// diberi fieldname __section_N). Tanpa salinan, p.fields
				// dicemari → vals bawah menyertakan kunci section → objek
				// Section tiada set_value → ralat console berulang
				// "s.set_value is not a function" setiap kali borang dibuka.
				fields: [...p.fields],
				body,
				// Enter TIDAK memicu aksi global Desk (trigger_primary_action)
				// — FieldGroup ini luar dialog framework.
				no_submit_on_enter: true,
				no_focus: false,
			});
			fg.make();
			const vals = {};
			p.fields.forEach((f) => {
				vals[f.fieldname] = f.fieldname === 'date_of_birth'
					? (t.dob || '') : (t[f.fieldname] || '');
			});
			fg.set_values(vals);
			return { key: p.key, fg };
		});
		const getField = (fieldname) => {
			for (const { fg } of panelFgs) {
				const fld = fg.get_field(fieldname);
				if (fld) return fld;
			}
			return null;
		};
		// Nama sahaja — paparan uppercase semasa menaip (nilai sebenar
		// di-uppercase oleh before_save doctype Traveller). Alamat bebas
		// taip — doctype TIDAK memaksa uppercase lagi.
		['first_name', 'last_name'].forEach((f) => {
			getField(f)?.$input?.addClass('mba-input-upper');
		});
		// Panel Address — baris INLINE utk postcode → city → state →
		// country (ikut urutan ini); Address Line 1 kekal penuh (textarea
		// mini di atasnya). Butang ⧉ Copy — salin maklumat ALAMAT BIL
		// customer (doctype Booking → Customer → Address 'Billing') ke
		// medan borang; user Save untuk simpan.
		{
			const $addrPanel = $info.find('.mba-tvedit-panel[data-panel="address"]');
			const $addrBody = $addrPanel.find('.mba-tvedit-panel-body');
			const $row = $('<div class="mba-tvedit-inline-row"></div>');
			['postcode', 'city', 'state', 'country'].forEach((f) => {
				const $c = $addrBody.find(`.frappe-control[data-fieldname="${f}"]`);
				if ($c.length) $row.append($c);
			});
			$addrBody.find('form, .form-column').first().append($row);
			const $copy = $(`<div class="mba-addr-copy-wrap">
				<button type="button" class="btn btn-default btn-xs mba-addr-copy-btn">⧉ ${__('Copy from billing address')}</button>
				<span class="mba-muted mba-addr-copy-note">${esc(t.booking || '')}</span>
			</div>`);
			$addrBody.find('form, .form-column').first().prepend($copy);
			$copy.find('.mba-addr-copy-btn').on('click', async function () {
				const $b = $(this).prop('disabled', true);
				try {
					const out = await api('get_booking_billing_address', { booking: t.booking });
					if (!out?.found) {
						frappe.show_alert({
							message: __('No billing address found for this booking customer'),
							indicator: 'orange',
						});
						return;
					}
					const setF = (f, v) => {
						getField(f)?.set_value?.(v == null ? '' : String(v));
					};
					setF('address_line1', out.address_line1);
					setF('postcode', out.postcode);
					setF('city', out.city);
					setF('state', out.state);
					setF('country', out.country);
					setTimeout(() => {
						$info.find('.frappe-control[data-fieldname="country"] input')
							.trigger('change'); // segar label Link Country
					}, 150);
					frappe.show_alert({
						message: __('Billing address copied — click Save to apply'),
						indicator: 'blue',
					});
				} catch (e) {
					// api() sudah papar alert ralat
				} finally {
					$b.prop('disabled', false);
				}
			});
			$info.find('.mba-tvedit-body .frappe-control[data-fieldname="country"] input')
				.trigger('change'); // segar label Link Country
		}
		$info.find('.mba-tvedit-body .frappe-control[data-fieldname="nationality"] input')
			.trigger('change'); // segar label Link

		// Kawalan Phone — setup negara (bendera/ISD) ASYNC dalam frappe;
		// ia boleh selesai SETELAH set_values mengisi nilai → bendera/kod
		// "+60" tak dipapar & user tak nampak picker negara. Paksa pilihan
		// negara lalai (Malaysia) bila nilai tiada awalan kod negara.
		const applyPhoneCountry = (fieldname, tries = 0) => {
			const ctl = getField(fieldname);
			if (!ctl) return;
			const val = String(ctl.get_value() || '');
			if (ctl.country_code_picker && ctl.country_codes) {
				if (val && !val.includes('-')) {
					const info = ctl.country_codes['Malaysia'];
					if (info) {
						// Bendera + ISD "+60" SAHAJA — input tidak disentuh;
						// nilai penuh (isd + nombor) set melalui set_value
						// kawalan supaya tersimpan dalam format Phone betul.
						ctl.set_flag?.(info.code);
						if (ctl.$isd?.length) ctl.$isd.text(info.isd);
						ctl.set_value(info.isd + '-' + val.replace(/^-+/, ''));
					}
				}
			} else if (tries < 20) {
				setTimeout(() => applyPhoneCountry(fieldname, tries + 1), 250);
			}
		};
		applyPhoneCountry('phone');
		applyPhoneCountry('emergency_contact_phone');

		const restore = () => {
			// Kembali ke paparan view — render semula modal (msgprint
			// append bila area tak kosong; kosongkan dahulu).
			frappe.msg_dialog.clear();
			show_traveller_dialog(t, ctx);
		};
		$info.find('.mba-tvedit-cancel').on('click', restore);

		const save = async () => {
			// get_values(true) — TANPA enforcement required FieldGroup yang
			// memanggil frappe.msgprint global (akan APPEND ke modal view
			// yang sama). Required disemak manual dengan alert. Nilai
			// dikumpul daripada FieldGroup SETIAP panel kad.
			let v = {};
			try {
				for (const { fg } of panelFgs) {
					Object.assign(v, fg.get_values(true) || {});
				}
			} catch (e) {
				// Ralat luar jangka semasa membaca nilai — papar, jangan senyap.
				console.error('traveller edit get_values:', e);
				frappe.show_alert({ message: __('Failed to read form values'), indicator: 'red' });
				return;
			}
			if (!String(v?.first_name || '').trim() || !String(v?.last_name || '').trim()) {
				frappe.show_alert({
					message: __('First Name and Last Name are required'),
					indicator: 'orange',
				});
				return;
			}
			const $btn = $info.find('.mba-tvedit-save').prop('disabled', true);
			try {
				const out = await api('update_traveller_info', {
					traveller: t.traveller, values: v,
				});
				const { traveller, renamed, ...patch } = out || {};
				if (!traveller) throw new Error(__('No response'));
				// IC Number = nama dokumen Traveller (autoname) — bila
				// berubah, server RENAME rekod; patch bermula dari nama
				// LAMA supaya baris cache dijumpai, nilai `traveller`
				// BAHARU ditulis ke dalam baris melalui patch.
				patch_traveller_caches(t.traveller, { ...patch, traveller });
				if (ctx?.list && ctx.list[ctx.index]) {
					Object.assign(ctx.list[ctx.index], { ...patch, traveller });
				}
				const t2 = { ...t, ...patch, traveller };
				// Render semula modal view — panel info kembali
				// menggantikan borang.
				frappe.msg_dialog.clear();
				show_traveller_dialog(t2, ctx);
				frappe.show_alert({
					message: renamed
						? __('Traveller info updated — record renamed to {0} (all links updated)', [traveller])
						: __('Traveller info updated'),
					indicator: 'green',
				});
			} catch (e) {
				// api() sudah papar alert ralat — benarkan cuba semula
				$btn.prop('disabled', false);
			}
		};
		$info.find('.mba-tvedit-save').on('click', save);
	}

	// Dialog crop & rotate dokumen passport — seret untuk pan, slider untuk
	// zum, butang ⟲/⟳ untuk putar 90°. Simpan → potong di kanvas (resolusi
	// asal) → muat naik → gantikan passport_image traveller.
	//
	// EXIF-SAFE: gambar telefon biasanya bawa orientasi EXIF — <img> papar
	// sudah dirotak browser, tetapi lukisan kanvas lama tidak tentu sama.
	// Sumber potongan ialah 'working canvas' (createImageBitmap
	// imageOrientation from-image) yang dijana sekali daripada imej
	// dipaparkan — display dan output SENTIASA sama orientasi. Putar
	// dibakar terus ke working canvas (tiada math transform semasa pan/
	// zum), jadi kiraan crop kekal ringkas dan tepat.
	function show_crop_dialog(opts) {
		const dlg = new frappe.ui.Dialog({
			title: __('Crop / Rotate') + ' — ' + (opts.name || __('Passport')),
			// Large (800px) — bingkai crop ikut LEBAR PENUH modal (rasio
			// 5:3); modal standard (~500px) menjadikan bingkai terlalu kecil.
			size: 'large',
			primary_action_label: __('Save'),
			primary_action: () => save_crop(),
		});
		dlg.$body.html(`
			<div class="mba-crop">
				<div class="mba-crop-view">
					<img class="mba-crop-img" src="${esc(opts.url)}" alt="" draggable="false">
					<div class="mba-crop-handle" title="${esc(__('Drag corner to resize — free ratio'))}"></div>
				</div>
				<div class="mba-crop-tools">
					<button type="button" class="btn btn-default btn-xs mba-rot" data-dir="-1"
						title="${esc(__('Rotate left'))}" aria-label="${esc(__('Rotate left'))}">
						${frappe.utils.icon('rotate-ccw', 'sm')}</button>
					<div class="mba-crop-zoom">
						<span>−</span>
						<input type="range" class="mba-crop-range" min="0" max="100" value="0" />
						<span>+</span>
					</div>
					<button type="button" class="btn btn-default btn-xs mba-rot" data-dir="1"
						title="${esc(__('Rotate right'))}" aria-label="${esc(__('Rotate right'))}">
						${frappe.utils.icon('rotate-cw', 'sm')}</button>
				</div>
				<div class="mba-crop-hint">${__('Drag the corner grip ⤡ to resize the frame — free ratio')}</div>
			</div>`);

		const view = dlg.$body.find('.mba-crop-view').get(0);
		const img = dlg.$body.find('.mba-crop-img').get(0);
		const range = dlg.$body.find('.mba-crop-range').get(0);
		let src = null;            // working canvas — display == output
		let srcUrl = null;         // object URL preview semasa (di-revoke semasa putar)
		let natW = 0, natH = 0, minScale = 1, scale = 1, tx = 0, ty = 0;

		const apply = () => {
			const vw = view.clientWidth || 600, vh = view.clientHeight || 360;
			const w = natW * scale, h = natH * scale;
			tx = Math.min(0, Math.max(vw - w, tx));
			ty = Math.min(0, Math.max(vh - h, ty));
			img.style.width = w + 'px';
			img.style.left = tx + 'px';
			img.style.top = ty + 'px';
		};
		const fit = () => {
			// Dimensi viewport crop — fallback 600×360 (rasio 5:3, anggaran
			// .mba-crop-view; lebar sebenar ikut modal). Tanpa fallback, init
			// yang berjalan sebelum modal selesai di-layout mendapat
			// clientWidth 0 → scale 0 → img 'width: 0px'.
			const vw = view.clientWidth || 600;
			const vh = view.clientHeight || 360;
			minScale = Math.max(vw / natW, vh / natH);
			scale = minScale;
			tx = (vw - natW * scale) / 2;
			ty = (vh - natH * scale) / 2;
			range.value = 0;
			apply();
		};
		const set_scale = (s) => {
			const cx = tx + (natW * scale) / 2, cy = ty + (natH * scale) / 2;
			scale = s;
			tx = cx - (natW * scale) / 2;
			ty = cy - (natH * scale) / 2;
			apply();
		};
		const init = () => {
			natW = src ? src.width : img.naturalWidth;
			natH = src ? src.height : img.naturalHeight;
			if (!natW || !natH) return;
			fit();
		};
		range.addEventListener('input', () => set_scale(minScale * (1 + (+range.value / 100) * 4)));

		let px = null, py = null;
		view.addEventListener('pointerdown', (e) => {
			px = e.clientX - tx;
			py = e.clientY - ty;
			view.setPointerCapture(e.pointerId);
		});
		view.addEventListener('pointermove', (e) => {
			if (px === null) return;
			tx = e.clientX - px;
			ty = e.clientY - py;
			apply();
		});
		const end_pan = () => { px = null; py = null; };
		view.addEventListener('pointerup', end_pan);
		view.addEventListener('pointercancel', end_pan);

		// RASIO BEBAS — seret pemegang penjuru kanan-bawah untuk ubah saiz
		// bingkai crop (lebar & tinggi bebas, bukan lagi 3:4 tetap).
		// Bila bingkai membesar, zum minimum dikira semula supaya imej
		// sentiasa menutup bingkai (invariant cover-fit dikekalkan —
		// clamping pan dalam apply() bergantung padanya).
		const handle = dlg.$body.find('.mba-crop-handle').get(0);
		let rx = null, ry = null, rw0 = 0, rh0 = 0;
		handle.addEventListener('pointerdown', (e) => {
			e.stopPropagation();
			e.preventDefault();
			rx = e.clientX;
			ry = e.clientY;
			rw0 = view.clientWidth;
			rh0 = view.clientHeight;
			handle.setPointerCapture(e.pointerId);
		});
		handle.addEventListener('pointermove', (e) => {
			if (rx === null) return;
			const maxW = (view.parentElement?.clientWidth || 600) - 8;
			const maxH = Math.min(640, Math.round(window.innerHeight * 0.6));
			const w = Math.max(120, Math.min(maxW, rw0 + e.clientX - rx));
			const h = Math.max(120, Math.min(maxH, rh0 + e.clientY - ry));
			view.style.width = w + 'px';
			view.style.height = h + 'px';
			const vw = view.clientWidth, vh = view.clientHeight;
			minScale = Math.max(vw / natW, vh / natH);
			if (scale < minScale) set_scale(minScale);
			else apply();
		});
		const end_resize = () => { rx = null; ry = null; };
		handle.addEventListener('pointerup', end_resize);
		handle.addEventListener('pointercancel', end_resize);

		// Jana working canvas (orientasi EXIF diterapkan) daripada imej
		// yang dipaparkan — fallback: lukis elemen img terus.
		const make_src = async () => {
			try {
				const bmp = await createImageBitmap(img, { imageOrientation: 'from-image' });
				const c = document.createElement('canvas');
				c.width = bmp.width;
				c.height = bmp.height;
				c.getContext('2d').drawImage(bmp, 0, 0);
				bmp.close?.();
				return c;
			} catch (e) {
				const c = document.createElement('canvas');
				c.width = img.naturalWidth;
				c.height = img.naturalHeight;
				c.getContext('2d').drawImage(img, 0, 0);
				return c;
			}
		};

		// Putar 90° — bakar ke working canvas, ganti preview, fit semula.
		dlg.$body.find('.mba-rot').on('click', async function () {
			const dir = parseInt($(this).data('dir'), 10) || 1;
			if (!src) src = await make_src();
			const c = document.createElement('canvas');
			c.width = src.height;
			c.height = src.width;
			const ctx = c.getContext('2d');
			ctx.translate(c.width / 2, c.height / 2);
			ctx.rotate((dir * Math.PI) / 2);
			ctx.drawImage(src, -src.width / 2, -src.height / 2);
			src = c;
			natW = src.width;
			natH = src.height;
			if (srcUrl) URL.revokeObjectURL(srcUrl);
			srcUrl = URL.createObjectURL(await new Promise((res) => src.toBlob(res, 'image/png')));
			img.src = srcUrl;
			fit();
		});

		const save_crop = async () => {
			dlg.disable_primary_action && dlg.disable_primary_action();
			try {
				// Sumber potongan: working canvas (EXIF + putaran terkini
				// termasuk) — jatuh balik ke elemen img jika janaan gagal.
				let source = src || (src = await make_src());
				const vw = view.clientWidth || 600, vh = view.clientHeight || 360;
				const sx = -tx / scale, sy = -ty / scale;
				const sw = vw / scale, sh = vh / scale;
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(sw));
				canvas.height = Math.max(1, Math.round(sh));
				canvas.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
				const is_png = /\.png($|\?)/i.test(opts.url || '');
				const blob = await new Promise((res) =>
					canvas.toBlob(res, is_png ? 'image/png' : 'image/jpeg', 0.92));
				const fname = `passport-${opts.traveller}-${Date.now()}.${is_png ? 'png' : 'jpg'}`;
				const fd = new FormData();
				fd.append('file', blob, fname);
				fd.append('doctype', 'Traveller');
				fd.append('docname', opts.traveller);
				fd.append('fieldname', opts.field || 'passport_image');
				// Imej passport ialah PII — sentiasa PRIVATE (selari upload
				// portal), jangan tinggal salinan public di /files.
				fd.append('is_private', '1');
				const resp = await fetch('/api/method/upload_file', {
					method: 'POST',
					headers: {
						'Accept': 'application/json',
						'X-Frappe-CSRF-Token': (frappe.csrf_token || ''),
					},
					body: fd,
				});
				const out = await resp.json().catch(() => ({}));
				const url2 = out.message && out.message.file_url;
				if (!resp.ok || !url2) {
					let msg = out.exc_type || out.exception || '';
					if (!msg && out._server_messages) {
						try { msg = JSON.parse(out._server_messages).join(' '); } catch (e) { /* ignore */ }
					}
					throw new Error(msg || __('Upload failed'));
				}
				// REPLACE, bukan duplikasi: set nilai baharu pada Traveller,
				// alih snapshot Booking Reservation yang masih merujuk URL
				// lama, kemudian padam dokumen File lama (fizikal disenta
				// oleh Frappe bila tiada duplikasi lain).
				await api('replace_traveller_file', {
					traveller: opts.traveller,
					fieldname: opts.field || 'passport_image',
					old_url: opts.url || '',
					new_url: url2,
				});
				refresh_traveller_caches(opts.traveller, url2, opts.field || 'passport_image');
				if (srcUrl) URL.revokeObjectURL(srcUrl);
				dlg.hide();
				frappe.show_alert({ message: __('Passport image updated'), indicator: 'green' });
			} catch (err) {
				console.error('crop upload failed:', err);
				frappe.msgprint({
					title: __('Crop failed'),
					indicator: 'red',
					message: esc(String(err.message || err)),
				});
			} finally {
				dlg.enable_primary_action && dlg.enable_primary_action();
			}
		};

		// Init DUA lapis: (1) segera jika imej sudah cache — fit guna
		// fallback dimensi CSS; (2) semula pada 'shown.bs.modal'
		// (on_page_show) bila modal selesai di-layout — di situlah
		// clientWidth sebenar tersedia. Lapis (2) yang menentukan ukuran
		// muktamad; tanpanya init awal berjalan atas modal belum siap
		// (clientWidth 0) dan imej jadi 'width: 0px'.
		dlg.on_page_show = () => init();
		dlg.show();
		if (img.complete && img.naturalWidth) init();
		else img.onload = init;
	}

	// ── Guest passport link — jana link selamat utk slot reservation
	// (endpoint portal request_guest_passport_link; token disimpan pada
	// Booking Reservation), papar link + QR + butang WhatsApp (no. telefon
	// traveller, fallback no. telefon customer booking). ──
	function show_guest_link_dialog(t) {
		if (!t.reservation) return;
		// No. WhatsApp — telefon traveller, fallback telefon customer
		// booking (cust_phone); normalisasi sama seperti call_wa_btns.
		const waPhone = String(t.phone || t.cust_phone || '').replace(/\D/g, '');
		const waDigits = waPhone.startsWith('0') ? '6' + waPhone : waPhone;
		// Mesej WhatsApp — ikut no. telefon yang digunakan: traveller ada
		// no. sendiri → pelawaan terus; tiada → guna no. customer booking,
		// minta customer lengkapkan dokumen ATAS NAMA traveller/guest
		// (nama traveller, fallback guest_label bila tiada nama).
		const displayName = (t.traveller_name && t.traveller_name !== '-')
			? t.traveller_name : (t.guest_label || '');
		const onBehalfOf = displayName || 'the guest';

		const dlg = new frappe.ui.Dialog({
			title: '🔗 ' + __('Guest Passport Link') + ' — ' + (displayName || t.reservation),
		});

		// Fasa 1 — paparan jana (link tiada / telah tamat). Butang Generate
		// menjana token (tempoh ikut Travel Settings, minimum 48 jam);
		// Refresh Token menjana token baharu (token lama invalidated).
		const bindPhase1 = (note) => {
			dlg.$body.html(`
				<div class="mba-glink">
					<div class="mba-glink-meta">
						${__('Generate a secure link for this guest to submit passport & travel details.')}
						${note ? `<br>${esc(note)}` : ''}
						${waDigits ? '' : `<br>${__('No phone number on traveller or booking — share the link manually.')}`}
					</div>
					<div class="mba-file-actions">
						<button type="button" class="btn btn-primary btn-sm mba-glink-gen">${__('Generate Link')}</button>
					</div>
					<div class="mba-glink-meta mba-muted">${__('Link access duration follows Travel Settings — minimum 48 hours.')}</div>
				</div>`);
			dlg.$body.find('.mba-glink-gen').on('click', () => generate(false));
		};

		const generate = (isRefresh) => {
			frappe.call({
				method: 'travel_booking.api.portal_traveller.request_guest_passport_link',
				// Tempoh akses ikut Travel Settings (guest_link_expiry_hours,
				// minimum 48 jam dipaksa server) — tiada nilai hardcoded di sini.
				args: { slot_name: t.reservation },
				freeze: true,
				freeze_message: isRefresh ? __('Refreshing secure link…') : __('Generating secure link…'),
			}).then((r) => {
				const d = r?.message;
				if (!d?.link) return;
				renderLink(d);
			});
		};

		// Fasa 2 — link aktif: QR + URL + meta + aksi kongsi + Refresh.
		const renderLink = (d) => {
			const expires = String(d.expires_on || '').slice(0, 16).replace('T', ' ');
			const waMsg = t.phone
				? 'Hello ' + (t.traveller_name || '')
					+ ', please complete your submission of your passport & travel details for your trip via this secure link: '
					+ d.link + ' (valid until ' + expires + ')'
				: 'Hello ' + (t.customer_name || '')
					+ ', please complete your travel document on behalf of ' + onBehalfOf
					+ ' via this secure link: ' + d.link + ' (valid until ' + expires + ')';

			dlg.$body.html(`
				<div class="mba-glink">
					<div class="mba-glink-qr"><img src="${esc(d.qr_data_uri)}" alt="${esc(__('Guest passport link QR code'))}"></div>
					<div class="mba-glink-url">${esc(d.link)}</div>
					<div class="mba-glink-meta mba-glink-expiry">
						${__('Valid until')} <b>${esc(expires)}</b>
						<button type="button" class="btn btn-default btn-xs mba-glink-refresh"
							title="${esc(__('Generate a new token — the previous link becomes invalid'))}">↻ ${__('Refresh')}</button>
					</div>
					<div class="mba-file-actions">
						${waDigits ? `<a class="btn btn-default btn-xs mba-quickbtn mba-quickbtn--wa"
							href="https://wa.me/${esc(waDigits)}?text=${encodeURIComponent(waMsg)}"
							target="_blank" rel="noopener"
							title="${esc(__('Open WhatsApp message in a new tab'))}">💬 ${__('WhatsApp')}</a>` : ''}
						<button type="button" class="btn btn-default btn-xs mba-glink-copy">${__('Copy Link')}</button>
						<a class="btn btn-default btn-xs" href="${esc(d.link)}" target="_blank" rel="noopener">${__('Open')}</a>
					</div>
					${waDigits ? '' : `<div class="mba-glink-meta mba-muted">${__('No phone number on traveller or booking — share the link manually.')}</div>`}
					<div class="mba-glink-meta mba-muted">${__('Refreshing generates a new token — the previous link becomes invalid.')}</div>
				</div>`);
			dlg.$body.find('.mba-glink-copy').on('click', function () {
				const $btn = $(this);
				const done = () => {
					$btn.text(__('Copied!'));
					setTimeout(() => $btn.text(__('Copy Link')), 1500);
				};
				if (navigator.clipboard?.writeText) {
					navigator.clipboard.writeText(d.link).then(done).catch(() => {
						frappe.utils.copy_to_clipboard(d.link); done();
					});
				} else {
					frappe.utils.copy_to_clipboard(d.link); done();
				}
			});
			dlg.$body.find('.mba-glink-refresh').on('click', () => generate(true));
		};

		// Modal PAPAR DAHULU dengan status semakan; panggilan bacaan
		// (tanpa jana token) tentukan paparan: link aktif → terus papar
		// link sedia ada; tiada/tamat → fasa Generate.
		dlg.$body.html(`
			<div class="mba-glink">
				<div class="mba-glink-meta mba-muted">${__('Checking for an existing link…')}</div>
			</div>`);
		dlg.show();
		frappe.call({
			method: 'travel_booking.api.portal_traveller.get_guest_passport_link',
			args: { slot_name: t.reservation },
		}).then((r) => {
			const st = r?.message || {};
			if (st.status === 'active' && st.link) {
				renderLink(st);
			} else if (st.status === 'expired') {
				bindPhase1(__('The previous link has expired — generate a new one.'));
			} else {
				bindPhase1('');
			}
		}).catch(() => {
			// Semakan gagal — tetap tawarkan penjanaan.
			bindPhase1('');
		});
	}

	// ── PAKET SENARAI TRAVELLER — komponen boleh guna semula: toolbar
	// (togol paparan ikon, carian client, muat turun pukal, Order By) +
	// kad grid menegak + jadual 5 kolum boleh sort + aksi per-baris (view
	// passport, guest link, edit). Dipanggil dari mana-mana senarai
	// traveller — kini: L3 tab Travellers (satu booking) & L2 tab
	// Travellers (group/batch, pelbagai booking).
	//
	// opts:
	//   target          jQuery element pane tujuan
	//   rows            senarai baris traveller/reservation
	//   state           { sort, sort_dir, view, __q } — kekal antara render
	//   context         { booking, trip_start, trip_end, show_booking_col }
	//   toolbar_extras  HTML tambahan dalam toolbar (tapisan server L2)
	//   footer_html     HTML bawah senarai (load more L2)
	//   show_search     false → sembunyi carian client (L2 guna carian server)
	//   show_downloads  false → sembunyi Files/XLSX/CSV (L2 pelbagai booking)
	//   empty_message   mesej bila rows kosong (lalai 'No travellers found
	//                   for this filter.') — dipapar DALAM .mba-tv-grid
	//                   supaya toolbar/panel penapis kekal (bukan overwrite
	//                   seluruh pane).
	function render_traveller_list(opts) {
		const target = opts.target;
		const rows = opts.rows || [];
		if (!target?.length) return;
		const ctx = opts.context || {};
		const tvst = opts.state || {};
		const tvSort = TV_SORTS[tvst.sort] ? tvst.sort : '';
		const tvDir = tvst.sort_dir === -1 ? -1 : 1;
		const tvView = tvst.view === 'table' ? 'table' : 'grid';
		const showBk = !!ctx.show_booking_col;
		const res = tvSort ? rows.slice().sort((a, b) => {
			const va = TV_SORTS[tvSort].val(a);
			const vb = TV_SORTS[tvSort].val(b);
			const c = typeof va === 'number' && typeof vb === 'number'
				? va - vb : String(va).localeCompare(String(vb));
			return c * tvDir;
		}) : rows;
		// Tapisan client-side (show_filters — L3): doc status & bilangan
		// baris. L2 guna tapisan server (extras toolbar).
		const useFilters = opts.show_filters === true;
		const filterDoc = useFilters ? String(tvst.doc_status || '') : '';
		const docMatch = (t) => !filterDoc ? true
			: (filterDoc === 'No Traveller' ? !t.traveller
				: (filterDoc === 'Incomplete'
					? ['', 'Incomplete'].includes(t.document_status || '')
					: t.document_status === filterDoc));
		const limitN = useFilters ? (parseInt(tvst.limit, 10) || 0) : 0;
		const list0 = filterDoc ? res.filter(docMatch) : res;
		const list = limitN > 0 ? list0.slice(0, limitN) : list0;
		const hay = tv_hay;
		// Julat tarikh perjalanan — DOB dalam julat ini ditanda merah.
		const tripStart = String(ctx.trip_start || '').slice(0, 10);
		const tripEnd = String(ctx.trip_end || '').slice(0, 10);

		// Butang kolum Docs / kad — HANYA jana link passport guest (perlu
		// konteks reservation), ikon telanjang tanpa border/padding. Butang
		// preview passport (eye) & edit doctype (pencil) dibuang — preview
		// tetap ada melalui modal traveller (klik kad/baris), edit melalui
		// butang Edit dalam modal.
		const status_btns = (t) => t.reservation
			? `<button type="button" class="mba-tv-link-btn"
				title="${esc(__('Create guest passport link'))}"
				aria-label="${esc(__('Create guest passport link'))}">${frappe.utils.icon('share-2', 'sm')}</button>`
			: '';

		const cards = list.map((t) => {
			const cancelled = t.reservation_status === 'Cancelled';
			// Tanpa rekod Traveller — nama papar guest_label; modal tetap
			// dibuka dengan panel Booking menggantikan Personal.
			const noTrav = !t.traveller;
			const displayName = noTrav ? (t.guest_label || t.traveller_name) : t.traveller_name;
			const photo = t.passport_image
				? `<img class="mba-tv-photo" src="${esc(t.passport_image)}" alt="${esc(displayName || '')}" loading="lazy">`
				: `<div class="mba-tv-photo mba-tv-photo--empty">👤</div>`;
			// Checkbox bulk edit/download — TERAPUNG atas foto, kanan-atas
			// (kelas sama dengan table view → handler & skop download sama).
			const cardCheck = t.traveller
				? `<input type="checkbox" class="mba-tv-checkrow"
					data-traveller="${esc(t.traveller)}" data-reservation="${esc(t.reservation)}"
					title="${esc(__('Select for bulk edit / download'))}">`
				: '';
			const sub = [
				[
					t.gender ? esc(__(t.gender)) : '',
					t.age != null ? esc(String(t.age))
						+ (t.birthday_trip ? ' ' + badge(__('BIRTHDAY TRIP'), 'red') : '') : '',
				].filter(Boolean).join(' · '),
				t.email ? `✉ ${esc(t.email)}` : '',
				t.phone ? `<span class="mba-contact-line"><span>☎ ${esc(t.phone)}</span>${contact_icons(t.phone)}</span>` : '',
			].filter(Boolean).join('<br>') || '<span class="mba-muted">—</span>';
			return `
			<div class="mba-tvcard${cancelled ? ' mba-tvcard--cancelled' : ''}"
				data-res="${esc(t.reservation)}" data-hay="${esc(hay(t))}"
				data-trav="${esc(JSON.stringify(t))}">
				<div class="mba-tv-photo-wrap">${photo}${cardCheck}</div>
				<div class="mba-tvcard-body">
					<div class="mba-tvcard-name">${esc(displayName)}</div>
					<div class="mba-tvcard-badges">
						<span class="mba-tvcard-badge-l">
							${badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status])}
							${badge(t.document_status, DOC_STATUS_COLORS[t.document_status])}
						</span>
						${status_btns(t)}
					</div>
					<div class="mba-tvcard-sub">${sub}</div>
					${showBk ? `<div class="mba-tvcard-sub">${esc(t.booking_number || t.booking || '')}${t.customer_name ? ' · ' + esc(t.customer_name) : ''}</div>` : ''}
				</div>
			</div>`;
		}).join('');

		const dob_badge = (dob) => {
			const dd = String(dob || '').slice(0, 10);
			if (!dd) return '';
			const label = esc(fmtDate(dd));
			return (tripStart && tripEnd && dd >= tripStart && dd <= tripEnd)
				? `<span title="${esc(__('Date of birth falls within the trip dates — please verify'))}">${badge(label, 'red')}</span>`
				: label;
		};

		const tRows = list.map((t) => {
			const cancelled = t.reservation_status === 'Cancelled';
			const displayName = t.traveller
				? t.traveller_name : (t.guest_label || t.traveller_name);
			return `
			<tr class="mba-tv-trow${cancelled ? ' mba-row-cancelled' : ''}"
				data-hay="${esc(hay(t))}" data-trav="${esc(JSON.stringify(t))}">
				<td class="mba-tv-check">${t.traveller
					? `<input type="checkbox" class="mba-tv-checkrow" data-traveller="${esc(t.traveller)}" data-reservation="${esc(t.reservation)}">`
					: ''}</td>
				<td>
					<div class="mba-cell-main">${esc(displayName)}${cancelled ? ' ' + badge(__('Cancelled'), 'red') : ''}</div>
					${(() => {
						const parts = [
							t.gender ? esc(__(t.gender)) : '',
							t.age != null ? esc(String(t.age)) : '',
						].filter(Boolean);
						return parts.length ? `<div class="mba-cell-sub">${parts.join(' · ')}</div>` : '';
					})()}
					${t.dob ? `<div class="mba-cell-sub">${dob_badge(t.dob)}${t.birthday_trip ? ' ' + badge(__('BIRTHDAY TRIP'), 'red') : ''}</div>` : ''}
					${t.tv_email ? `<div class="mba-cell-sub">✉ ${esc(t.tv_email)}</div>` : ''}
					${t.tv_phone ? `<div class="mba-cell-sub mba-contact-line"><span>☎ ${esc(t.tv_phone)}</span>${contact_icons(t.tv_phone)}</div>` : ''}
				</td>
				<td>
					<div class="mba-cell-main">${t.nationality ? esc(t.nationality) : '—'}</div>
					${t.passport_no ? `<div class="mba-cell-sub">PP: ${esc(t.passport_no)}</div>` : ''}
					${t.ic_number ? `<div class="mba-cell-sub">IC: ${esc(t.ic_number)}</div>` : ''}
					${t.passport_expiry ? `<div class="mba-cell-sub">Exp: ${esc(fmtDate(t.passport_expiry))}</div>` : ''}
					${(() => {
						// Status doctype Traveller + aksi share guest passport
						// link — baris terakhir kolum Document.
						const docsExtra = [
							badge(t.document_status, DOC_STATUS_COLORS[t.document_status]),
							status_btns(t),
						].filter(Boolean).join(' ');
						return docsExtra ? `<div class="mba-cell-sub">${docsExtra}</div>` : '';
					})()}
				</td>
				${showBk ? `<td>
					<div class="mba-cell-main">${t.booking
						? `<a href="/app/manage-booking-app/booking/${encodeURIComponent(t.booking)}">${esc(t.booking_number || t.booking)}</a>${(t.booking && t.booking !== t.booking_number) ? ` <span class="mba-muted mba-bkg-id">/ ${esc(t.booking)}</span>` : ''}`
						: esc(t.booking_number || '—')}</div>
					${t.customer_name ? `<div class="mba-cell-sub">${esc(t.customer_name)}</div>` : ''}
					${t.cust_email ? `<div class="mba-cell-sub">✉ ${esc(t.cust_email)}</div>` : ''}
					${t.cust_phone ? `<div class="mba-cell-sub mba-contact-line"><span>☎ ${esc(t.cust_phone)}</span>${contact_icons(t.cust_phone)}</div>` : ''}
					${t.booking_status ? `<div class="mba-cell-sub">${badge(t.booking_status, BOOKING_STATUS_COLORS[t.booking_status])}</div>` : ''}
				</td>` : ''}
				<td>
					<div class="mba-cell-main">${esc(t.room_category || '—')}</div>
					${t.pax_type ? `<div class="mba-cell-sub">${esc(t.pax_type)}</div>` : ''}
					${(() => {
						// room: ID bilik ATAU maklumat kabin cruise
						// (delegate / stateroom / aroya) — yang wujud sahaja.
						const rv = t.delegate_no ? esc(t.delegate_no)
							: t.stateroom_no ? esc(t.stateroom_no)
							: (t.aroya_guest_no !== '' && t.aroya_guest_no != null)
								? esc(String(t.aroya_guest_no))
								: t.room_id ? esc(t.room_id) : '';
						return rv ? `<div class="mba-cell-sub">${__('Room')}: ${rv}</div>` : '';
					})()}
					${t.room_privacy ? `<div class="mba-cell-sub">${esc(t.room_privacy)}</div>` : ''}
					${t.reservation_status ? `<div class="mba-cell-sub">${badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status])}</div>` : ''}
				</td>
			</tr>`;
		}).join('');
		// Header jadual boleh sort — anak panah arah aktif pada kolum terpilih.
		const sort_th = (col, label) => {
			const on = tvSort === col;
			const arrow = !on ? '↕' : (tvDir === 1 ? '↑' : '↓');
			return `<th class="mba-tv-sort${on ? ' is-sorted' : ''}" data-tvsort="${col}"
				title="${esc(__('Sort by') + ' ' + __(label))}">${esc(__(label))}
				<span class="mba-tv-sort-ico">${arrow}</span></th>`;
		};
		const table = `
			<div class="mba-table-wrap mba-tv-tablewrap"${tvView === 'table' && rows.length ? '' : ' style="display:none;"'}">
				<table class="mba-table">
					<thead><tr>
						<th class="mba-tv-check"><input type="checkbox" class="mba-tv-checkall"
							title="${esc(__('Select all rows'))}" aria-label="${esc(__('Select all rows'))}"></th>
						${sort_th('name', 'Traveller')}
						${sort_th('nationality', 'Document')}
						${showBk ? sort_th('booking', 'Booking') : ''}
						${sort_th('roomcat', 'Reservation')}
					</tr></thead>
					<tbody>${tRows}</tbody>
				</table>
			</div>`;

		const dlBase = '/api/method/travel_booking.api.manage_trip_booking.';
		// Skop muat turun — booking (L3) ATAU group/batch (L2). Kedua-duanya
		// menggunakan enjin download server yang sama; skop dihantar sebagai
		// query string (booking=... atau trip_groups=[...]).
		const dlQuery = ctx.booking
			? 'booking=' + encodeURIComponent(ctx.booking)
			: ((ctx.trip_groups || []).length
				? 'trip_groups=' + encodeURIComponent(JSON.stringify(ctx.trip_groups))
				: '');
		const showDl = opts.show_downloads !== false && !!dlQuery;
		const dlTitle = ctx.booking
			? __('Download all attached traveller files for this booking as a single ZIP')
			: __('Download all attached traveller files for this group as a single ZIP');
		// Toolbar 2 baris — Baris 1: kotak carian di tengah; Baris 2 kiri:
		// toggol paparan + section tapisan, kanan: butang download + Order
		// By. Dua mod carian: server_search (L2/L3 — input data-search,
		// reload via loader) atau carian client-side (.mba-tv-search, tapis
		// DOM sedia ada).
		// Kotak carian — PAKEJ STANDARD TravelBookingSearchBox (markup
		// .mba-searchwrap + butang ✕ mba-search-clear; auto-bind document
		// menguruskan keterlihatan & tindakan kosongkan). Butang tampak
		// bila input berisi — keterlihatan awal ikut nilai tersimpan (mod
		// server-search re-render toolbar selepas carian).
		const searchWrap = (o) => TravelBookingSearchBox.html(o);
		const midSearch = opts.server_search
			? searchWrap({
				cls: 'form-control', attrs: { 'data-search': 'tv' },
				placeholder: opts.search_placeholder || __('Search traveller / passport / contact…'),
				value: tvst.search || '',
			})
			: (opts.show_search !== false
				? searchWrap({
					cls: 'form-control mba-tv-search',
					placeholder: __('Search name / passport / room / contact…'),
				})
				: '');
		// Checkbox "Unlinked Traveller Only" — bila dicentang, senarai
		// HANYA reservation tanpa link doctype Traveller (slot guest).
		// Kedudukan: selepas butang Bulk Edit (susunan toolbar-left:
		// view toggle → bulk edit → checkbox). State disimpan pada
		// tvst.doc_status = 'No Traveller' (L2: server-side; L3: docMatch).
		const unlinkedChk = `<label class="mba-tv-unlinked"
				title="${esc(__('Show only booking reservations without a linked Traveller document'))}">
				<input type="checkbox" class="mba-tv-unlinked-chk"
					${tvst.doc_status === 'No Traveller' ? 'checked' : ''}>
				<span>${esc(__('Unlinked Traveller Only'))}</span>
			</label>`;
		target.html(`
			${opts.summary_html || ''}
			<div class="mba-tv-toolbar">
				${(midSearch || opts.toolbar_extras) ? `<div class="mba-tv-toolbar-top">${midSearch}${opts.toolbar_extras || ''}</div>` : ''}
				${opts.custom_filter_html || ''}
				<div class="mba-tv-toolbar-row">
					<div class="mba-tv-toolbar-left">
						<div class="btn-group mba-tv-views" role="group" aria-label="${esc(__('Traveller view'))}">
							<button type="button" class="btn btn-default btn-xs mba-tv-view${tvView === 'grid' ? ' active' : ''}"
								data-view="grid" title="${esc(__('Card view'))}"
								aria-label="${esc(__('Card view'))}">${frappe.utils.icon('layout-grid', 'sm')}</button>
							<button type="button" class="btn btn-default btn-xs mba-tv-view${tvView === 'table' ? ' active' : ''}"
								data-view="table" title="${esc(__('Table view'))}"
								aria-label="${esc(__('Table view'))}">${frappe.utils.icon('table', 'sm')}</button>
						</div>
						<button type="button" class="btn btn-default btn-xs mba-tv-bulk-btn"
							disabled title="${esc(__('Bulk edit the selected travellers'))}">${__('Bulk Edit')}</button>
						${unlinkedChk}
					</div>
					<div class="mba-tv-toolbar-right">
						${useFilters
							? `<select class="mba-tv-limitsel" title="${esc(__('Rows to show'))}">${ROW_LIMITS.map((n) => `<option value="${n}" ${n === limitN ? 'selected' : ''}>${n === 0 ? __('All rows') : __('{0} rows', [n])}</option>`).join('')}</select>`
							: limit_options('tv', tvst.limit)}
						${showDl ? `<div class="mba-tv-dl">
							<button type="button" class="btn btn-default btn-xs mba-tv-dl-btn"
								title="${esc(dlTitle)}" aria-haspopup="menu">
								<span class="mba-tv-dl-label">${__('Download')}</span> ${frappe.utils.icon('chevron-down', 'sm')}
							</button>
						</div>` : ''}
						<div class="mba-tv-sortby"></div>
					</div>
				</div>
			</div>
			${(filterDoc || (limitN > 0 && list0.length > list.length))
				? `<div class="mba-tv-count">${__('Showing')} ${list.length} / ${rows.length} ${__('travellers')}</div>` : ''}
			<div class="mba-tv-grid"${tvView === 'table' && rows.length ? ' style="display:none;"' : ''}>${cards
				|| `<div class="mba-empty">${esc(opts.empty_message || __('No travellers found for this filter.'))}</div>`}</div>
			${table}
			${opts.footer_html || ''}`);

		// Order By — komponen standard Frappe (ikon arah asc/desc + dropdown
		// medan), state yang sama dengan klik header jadual (objek state
		// dilalui melalui opts.state — rujukan sama ke S.state[key].tv).
		// frappe v17: SortSelector hanya set internal sort_by/sort_order
		// dalam setup_from_doctype() — bila dibina TANPA doctype ia return
		// awal & internal kekal undefined → klik butang arah memanggil
		// onchange(undefined, ...) → senarai reset ke Guest order. Set
		// semula internal itu secara eksplisit daripada args.
		const sortBy = new frappe.ui.SortSelector({
			parent: target.find('.mba-tv-sortby'),
			args: {
				options: [{ fieldname: 'guest', label: __('Guest order') }]
					.concat(Object.entries(TV_SORTS)
						.map(([k, v]) => ({ fieldname: k, label: __(v.label) }))),
				sort_by: tvSort || 'guest',
				sort_by_label: tvSort ? __(TV_SORTS[tvSort].label) : __('Guest order'),
				sort_order: tvDir === -1 ? 'desc' : 'asc',
			},
			onchange: (sort_by, sort_order) => {
				if (!opts.state) return;
				opts.state.sort = TV_SORTS[sort_by] ? sort_by : '';
				opts.state.sort_dir = sort_order === 'desc' ? -1 : 1;
				render_traveller_list(opts);
			},
		});
		sortBy.sort_by = sortBy.args.sort_by;
		sortBy.sort_order = (sortBy.args.sort_order || 'asc').toLowerCase();
		// Guest order tiada arah — nyahaktifkan butang asc/desc supaya
		// keadaan itu jelas (bukan "tak berfungsi").
		sortBy.wrapper.find('.btn-order')
			.prop('disabled', !tvSort)
			.attr('title', tvSort ? sortBy.wrapper.find('.btn-order').attr('title') : __('Guest order has no direction'));

		// Butang Download → dropdown espresso framework (frappe.ui.Dropdown).
		// Item ialah pautan href native — pelayar memproses muat turun
		// terus (Content-Disposition), tiada fetch/fail sementara diperlukan.
		// dlTitle (tooltip lama butang Files) jadi description item pertama.
		//
		// SKOP PILIHAN — bila checkbox bulk edit aktif (≥1 baris dipilih),
		// ketiga-tiga item download hanya eksport baris TERPILIH (param
		// reservations=…). href dikemas kini setiap kali pilihan berubah &
		// sebelum menu dibuka; label butang menunjukkan bilangan dipilih.
		if (showDl) {
			const $dlBtn = target.find('.mba-tv-dl-btn');
			new frappe.ui.Dropdown({
				trigger: $dlBtn,
				align: 'end',
				options: [
					{
						label: __('Files (ZIP)'),
						icon: 'download',
						href: dlBase + 'download_traveller_images?' + dlQuery,
					},
					{
						label: __('Excel (XLSX)'),
						icon: 'download',
						href: dlBase + 'download_travellers_excel?' + dlQuery,
					},
					{
						label: __('CSV'),
						icon: 'download',
						href: dlBase + 'download_travellers_csv?' + dlQuery,
					},
				],
			});
			const updateDlScope = () => {
				const checked = [];
				target.find('.mba-tv-checkrow:checked').each(function () {
					const res = String($(this).data('reservation') || '');
					if (res) checked.push(res);
				});
				const suffix = checked.length
					? '&reservations=' + encodeURIComponent(JSON.stringify(checked))
					: '';
				// Menu espresso DIRENDER DI LUAR .mba-tv-dl (es-menu di badan
				// dokumen) — cari pautan ikut endpoint + dlQuery pane ini
				// (dlQuery unik per skop: booking=… / trip_groups=…).
				const endpoints = ['download_traveller_images?',
					'download_travellers_excel?', 'download_travellers_csv?'];
				document.querySelectorAll('a[href*="download_traveller"]').forEach((a) => {
					const href = a.getAttribute('href') || '';
					if (!dlQuery || !href.includes(dlQuery)) return;
					const ep = endpoints.find((e) => href.includes(e));
					if (ep) a.setAttribute('href', dlBase + ep + dlQuery + suffix);
				});
				$dlBtn.find('.mba-tv-dl-label').text(checked.length
					? `${__('Download')} (${checked.length})` : __('Download'));
			};
			updateDlScope();
			// tablewrap & grid elemen segar setiap render — pengikat terus
			// selamat. Checkbox kad (grid view) turut mengemas kini skop.
			target.find('.mba-tv-tablewrap')
				.on('change', '.mba-tv-checkrow, .mba-tv-checkall', updateDlScope);
			target.find('.mba-tv-grid')
				.on('change', '.mba-tv-checkrow', updateDlScope);
			$dlBtn.on('click', updateDlScope);
		}

		// Kekalkan carian aktif merentas re-render (sort / tukar paparan).
		const prevQuery = (tvst.__q || '').trim();
		if (prevQuery && opts.show_search !== false) {
			target.find('.mba-tv-search').val(prevQuery).trigger('input');
		}

		// Callback re-render untuk handler delegated (klik header sort) —
		// disimpan pada pane supaya handler generik tahu cara render semula
		// senarai ini (L3 mahupun L2).
		target.data('mba-tv-rerender', () => render_traveller_list(opts));
	}

	// ── L3 Tab Travellers — sumber DISATUKAN dengan L2: get_group_travellers
	// mode booking (with_versions untuk timeline modal). Tapisan server
	// (carian / doc status / limit) + muat turun pukal per booking; julat
	// tarikh trip ikut profile. Dimuatkan lazily oleh load_bkg_travellers
	// bila tab dibuka. ──
	function render_bkg_travellers(key) {
		const d = S.cache[key]?.profile;
		const tv = S.cache[key]?.travellers;
		const st = S.state[key];
		if (!d || !tv || !st) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="tv"]`);
		const rows = tv.travellers || [];
		// Mesej kosong: tapisan aktif (carian / doc status / penapis dinamik)
		// → tiada padanan; selain itu booking memang tiada reservation.
		const hasFilters = !!(st.tv.search || st.tv.doc_status
			|| tv_cf_active(st.tv.custom).length);
		const emptyMsg = hasFilters
			? __('No travellers found for this filter.')
			: __('No booking reservations for this booking.');
		const p0 = d.profile || {};
		const tripStart = String((p0.is_a_cruise_trip
			? (p0.cruise_start || p0.departure_date) : p0.departure_date) || '').slice(0, 10);
		const tripEnd = String((p0.is_a_cruise_trip
			? (p0.cruise_end || p0.return_date) : p0.return_date) || '').slice(0, 10);
		render_traveller_list({
			target: pane,
			rows,
			summary_html: tv_summary_html(tv.summary),
			empty_message: emptyMsg,
			state: st.tv,
			context: {
				booking: d.booking,
				trip_start: tripStart,
				trip_end: tripEnd,
			},
			toolbar_extras: `<span class="mba-tv-extras">
				${tv_cf_toggle_html(st.tv)}
			</span>`,
			server_search: true,
			search_placeholder: __('Search traveller / passport / contact...'),
			custom_filter_html: tv_cf_panel_html(st.tv),
			footer_html: showing_footer(tv, __('travellers'), 'tv'),
			show_search: false,
		});
		tv_cf_hydrate(key);
	}

	// Muat tab Travellers L3 (lazy) — get_group_travellers mode booking;
	// cache S.cache[key].travellers (bentuk sama seperti L2 supaya semua
	// handler generik — sort, view, load-more, refresh cache — seragam).
	async function load_bkg_travellers(key, force = false) {
		if (!key || !key.startsWith('bkg:')) return;
		const st = S.state[key] || (S.state[key] = default_state());
		await ensure_tv_filter_fields();       // medan penapis dinamik (cache)
		if (!force && S.cache[key]?.travellers) {
			render_bkg_travellers(key);
			return;
		}
		const $pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="tv"]`);
		if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading travellers...')}</div>`);
		try {
			const tv = await api('get_group_travellers', {
				booking: key.slice(4),
				search: st.tv.search || null,
				doc_status: st.tv.doc_status || null,
				custom_filters: tv_cf_active(st.tv.custom),
				custom_match: st.tv.cf_match === 'OR' ? 'OR' : 'AND',
				limit: st.tv.limit,
				with_versions: true,
			});
			S.cache[key] = { ...(S.cache[key] || {}), travellers: tv };
		} catch (e) {
			return; // api() sudah papar alert ralat
		}
		// Render hanya bila tab masih dibuka pada item yang sama.
		const $tab = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="tv"]`);
		if ($tab.hasClass('active')) render_bkg_travellers(key);
	}
