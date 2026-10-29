/* travel_booking/public/js/booking_list.js
   Paket generik SENARAI BOOKING — window.TravelBookingBookingList.

   Satu komponen drop-in untuk papar senarai booking (data daripada
   travel_booking.api.manage_trip_booking.get_group_bookings) yang boleh
   diguna semula di mana-mana section desk app travel_booking:
   - Manage Booking App  — tab Booking (kolum compact, kad responsif)
   - Manage Booking Group — tab Booking (kolum penuh + message + diskaun)
   - section lain kelak  — cukup panggil create() pada container anda.

   Komponen memilik kitaran penuh sendiri: muat data (frappe.call) +
   toolbar 3 baris — (1) carian + butang Filter, (2) panel penapis
   dinamik (ditogol oleh butang Filter), (3) kiri: Bulk Edit + pilih
   group date (batch sahaja) · kanan: Download + bilangan baris +
   Order By — + render (kad telefon / jadual desktop dengan checkbox
   bulk edit, header boleh sort + footer totals) + event (klik baris,
   butang mesej, load more, bulk edit dialog).

   Elemen selari pakej senarai traveller (traveller_list.js page Manage
   Booking App): short summary, panel penapis dinamik, download, bulk
   edit, carian dengan butang ✕, header sort.

   Guna:
     const list = TravelBookingBookingList.create($('#pane-saya'), {
         trip_groups: ['TGD-001', 'TGD-002'],   // wajib — skop group date
         state: myStateObj,        // optional — objek state dikongsi dgn page
                                   // {search, status, payment, currency, group,
                                   //  limit, custom[], cf_open, cf_match,
                                   //  sort, sort_dir}
         group_options: [{name, trip_name}],  // optional — dropdown tapisan
                                   // group dalam batch (auto bila diberi)
         currency: 'MYR',          // default display currency (fallback MYR)
         currency_filter: true,    // papar dropdown tapisan currency
                                   // (hanya bila >1 currency dalam hasil)
         columns: 'compact',       // 'full' | 'compact' | [kolum keys]
         show_title: true,         // tajuk seksyen "Booking Reservations"
         show_cards: true,         // kad responsif telefon (jadual desktop)
         show_summary: true,       // jalur ringkasan (meta summary backend)
         on_loaded: (data) => {},  // setiap kali data berhasil dimuat
         on_open_booking: (name) => {},  // klik kolum Booking No / kad
                                   // (default: Form Booking)
         on_row_click: (name) => {},      // klik baris jadual
                                   // (default: sama seperti on_open_booking)
     });
     list.load();        // muat + render (skip fetch bila data dah ada)
     list.load(true);    // paksa fetch semula
     list.is_attached(); // root masih dalam DOM?

   Kolum tersedia (columns / preset):
     full    = booking_no, customer, message, group*, status, payment, pax,
               rooms, gross, paid, balance, discount, pending, created
     compact = booking_no, customer, pax_info, bills, more
   (*group hanya bila skop >1 group date)

   Kiraan dokumen (semantik backend manage_trip_booking):
   - docs_submitted — booking reservation berpaut dengan Traveller
   - docs_verified  — Traveller berpaut berstatus dokumen Verified/Valid
   - pending_docs   — semua pax yang belum verified
   Kolum Pax (compact) memaparkannya sebagai "{verified}/{submitted} docs".

   Bulk edit: checkbox baris/kad → butang Bulk Edit → dialog pilih medan
   (katalog BOOKING_BULK_EDIT_FIELDS) → api bulk_update_bookings; nilai
   disimpan MELALUI doctype Booking (doc.save penuh, hook kekal berjalan).

   Download: dropdown Excel (XLSX) / CSV — skop group/batch aktif; bila
   ≥1 baris dipilih (checkbox), eksport terhad kepada baris terpilih.

   CSS: public/css/booking_list.css (kelas .tblk-*).
*/

window.TravelBookingBookingList = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const fmtDate = (iso) => {
		if (!iso) return '';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return String(iso);
		return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
	};
	const fmtDateTime = (iso) => {
		if (!iso) return '';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
		if (!m) return fmtDate(iso);
		return fmtDate(iso) + ' ' + m[4] + ':' + m[5];
	};

	const CUR_SYMBOLS = { MYR: 'RM', USD: '$', SGD: 'S$', IDR: 'Rp', EUR: '€', GBP: '£', AUD: 'A$' };
	const fmtMoney = (n, cur) => {
		const sym = CUR_SYMBOLS[cur] || (cur ? cur + ' ' : 'RM ');
		return sym + parseFloat(n || 0).toLocaleString('en-MY', {
			minimumFractionDigits: 2, maximumFractionDigits: 2,
		});
	};

	// Pecahan per-currency [{currency, gross|paid|balance...}] →
	// "RM 1,000.00 · S$ 200.00" — JANGAN jumlah merentas currency
	// (SO booking/addon boleh dalam currency berbeza; paksi multi-company).
	const fmtCurRows = (rows, field) => {
		const list = rows || [];
		if (!list.length) return fmtMoney(0, state_currency());
		return list.map((r) => fmtMoney(r[field], r.currency)).join(' · ');
	};
	const hasBalance = (rows) => (rows || []).some((r) => (r.balance || 0) > 0.009);
	const round2 = (n) => Math.round((n || 0) * 100) / 100;

	const BOOKING_STATUS_COLORS = {
		'Pending': 'yellow', 'Accepted': 'blue', 'Processing': 'orange',
		'Confirmed': 'green', 'Completed': 'green', 'Abandoned': 'gray',
		'Cancelled': 'red',
	};
	const PAYMENT_STATUS_COLORS = {
		'Incomplete': 'orange', 'Pending': 'orange', 'Partially Paid': 'blue', 'Paid': 'green',
		'Request Refund': 'yellow', 'Pending Refund': 'yellow', 'Refunded': 'gray',
	};
	const badge = (label, color) =>
		label ? `<span class="tblk-badge tblk-badge--${color || 'gray'}">${esc(label)}</span>` : '';

	// Butang call / WhatsApp kecil sebelah no. telefon — konsep sama dengan
	// pakej traveller (contact_icons page Manage Booking App); kelas tblk-*
	// supaya komponen kekal berdikari (CSS sendiri dalam booking_list.css).
	// Ikon xs + wrapper .tblk-contact-acts → jajar kanan baris telefon
	// (.tblk-contact-line) — piawai sama dengan page Manage Booking App.
	const contact_icons = (phone) => {
		const telRaw = String(phone || '').replace(/[^\d+]/g, '');
		const digits = telRaw.replace(/\D/g, '');
		if (!digits) return '';
		return `<span class="tblk-contact-acts"><a class="tblk-contact-icon" href="tel:${esc(telRaw)}" target="_blank" rel="noopener"
				title="${esc(__('Phone call'))}" aria-label="${esc(__('Phone call'))}">${frappe.utils.icon('phone', 'xs')}</a><a
				class="tblk-contact-icon tblk-contact-icon--wa" href="https://wa.me/${esc(digits.startsWith('0') ? '6' + digits : digits)}"
				target="_blank" rel="noopener" title="${esc(__('WhatsApp chat'))}" aria-label="${esc(__('WhatsApp chat'))}">${frappe.utils.icon('message-circle', 'xs')}</a></span>`;
	};

	const BOOKING_STATUS_OPTIONS = [
		'', 'Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed',
		'Abandoned', 'Cancelled',
	];
	const PAYMENT_STATUS_OPTIONS = [
		'', 'Pending', 'Partially Paid', 'Paid', 'Request Refund',
		'Pending Refund', 'Refunded',
	];
	// Row limit quick preview (0 = semua) — tangga yang sama dengan page
	// Manage Booking App/Group supaya "Load more" konsisten.
	const ROW_LIMITS = [10, 25, 50, 100, 0];

	const debounce = (fn, ms) => {
		let t;
		return function (...a) {
			const ctx = this;
			clearTimeout(t);
			t = setTimeout(() => fn.apply(ctx, a), ms);
		};
	};

	// Default display currency aktif — diisi daripada opts.currency
	// semasa create(); fallback MYR (selari backend DEFAULT_CURRENCY).
	let _currency = 'MYR';
	const state_currency = () => _currency;

	// ── Medan penapis dinamik (meta Booking + Customer) — cache module ──
	// Mirror ensure_tv_filter_fields page Manage Booking App.
	let _cfFields = null;
	let _cfFieldsPromise = null;
	const ensure_cf_fields = () => {
		if (_cfFields) return Promise.resolve(_cfFields);
		if (!_cfFieldsPromise) {
			_cfFieldsPromise = frappe.call({
				method: 'travel_booking.api.manage_trip_booking.get_booking_filter_fields',
			}).then((r) => {
				_cfFields = r?.message || [];
				return _cfFields;
			}).catch(() => null);
		}
		return _cfFieldsPromise;
	};

	// Baris aktif = ada nilai tunggal ATAU julat (min/max) — dikira dalam
	// pill butang Filter dan dihantar ke server sebagai custom_filters.
	const cf_active = (rows) => (rows || []).filter((r) => r.doctype && r.fieldname
		&& ((r.value != null && r.value !== '')
			|| (r.min != null && r.min !== '')
			|| (r.max != null && r.max !== '')));

	// Jenis medan yang guna input NILAI berupa julat Min–Max (bukan teks
	// tunggal): nombor DAN tarikh (tarikh: dua input type=date, padanan
	// inklusif). Fieldtype datang dari meta cache _cfFields.
	const CF_NUMERIC_TYPES = ['Int', 'Float', 'Currency', 'Percent', 'Date'];
	const cf_field_meta = (r) => {
		const g = (_cfFields || []).find((x) => x.doctype === r?.doctype);
		return g?.fields.find((f) => f.fieldname === r?.fieldname) || null;
	};
	const cf_fieldtype = (r) => cf_field_meta(r)?.fieldtype || '';
	const cf_is_range = (r) => CF_NUMERIC_TYPES.includes(cf_fieldtype(r));
	// Medan Select — pilihan penuh dari meta (autocomplete nilai penapis).
	const cf_select_options = (r) => cf_field_meta(r)?.options || [];

	// Butang togol pada toolbar (kiri, selepas carian) — selari
	// tv_cf_toggle_html pakej traveller. Ikon 'funnel'.
	const cf_toggle_html = (st) => {
		const n = cf_active(st.custom).length;
		return `<button type="button" class="btn btn-default btn-xs tblk-cf-toggle"
			title="${esc(__('Filter by any field'))}">
			${frappe.utils.icon('funnel', 'sm')} ${__('Filter')}${n ? ` <span class="tblk-count-pill">${n}</span>` : ''}</button>`;
	};

	// Panel baris penapis — terpapar bila cf_open (kekal merentas render).
	// ≥2 baris → pilihan mod gabungan AND | OR (cf_match; lalai AND).
	// PEMILIH MEDAN: input AUTOCOMPLETE (datalist) — senarai medan
	// (Booking + Customer) dicari terus dengan menaip; paparan
	// "Doctype — Label", nilai sebenar diselesaikan melalui
	// cf_field_choices(). Medan nombor/currency/tarikh → input julat
	// Min–Max; medan lain → input nilai tunggal + datalist cadangan.
	const cf_field_choices = () => {
		const out = [];
		(_cfFields || []).forEach((g) => (g.fields || []).forEach((f) => out.push({
			display: `${g.doctype} — ${f.label}`,
			doctype: g.doctype,
			fieldname: f.fieldname,
		})));
		return out;
	};
	const cf_display = (r) => {
		if (!r?.doctype || !r?.fieldname) return '';
		const m = cf_field_choices().find((x) =>
			x.doctype === r.doctype && x.fieldname === r.fieldname);
		return m ? m.display : '';
	};
	const cf_panel_html = (st) => {
		if (!st.cf_open) return '';
		const rows = st.custom || [];
		const match = st.cf_match === 'OR' ? 'OR' : 'AND';
		const matchBtn = (v) => `<button type="button"
			class="btn btn-default btn-xs tblk-cf-match-btn${match === v ? ' active' : ''}"
			data-match="${v}" title="${esc(v === 'AND'
				? __('Row must match ALL filters')
				: __('Row must match ANY filter'))}">${v}</button>`;
		const fieldChoices = cf_field_choices();
		const fieldOpts = fieldChoices.map((x) =>
			`<option value="${esc(x.display)}"></option>`).join('');
		return `
		<div class="tblk-cf">
			${rows.map((r, i) => `
			<div class="tblk-cf-row" data-idx="${i}">
				<span class="tblk-cf-pick">
					<input type="text" class="form-control tblk-cf-field-input" data-idx="${i}"
						list="tblk-cf-fdl-${i}" autocomplete="off"
						placeholder="${esc(__('— Select Field —'))}"
						value="${esc(cf_display(r))}" />
					<datalist id="tblk-cf-fdl-${i}">${fieldOpts}</datalist>
				</span>
				${cf_is_range(r) ? `
				<span class="tblk-cf-range">
					<input ${cf_fieldtype(r) === 'Date' ? 'type="date"' : 'type="number" step="any"'}
						class="form-control tblk-cf-min" data-idx="${i}"
						placeholder="${esc(__('Min'))}" value="${esc(r.min ?? '')}" />
					<span class="tblk-cf-sep">–</span>
					<input ${cf_fieldtype(r) === 'Date' ? 'type="date"' : 'type="number" step="any"'}
						class="form-control tblk-cf-max" data-idx="${i}"
						placeholder="${esc(__('Max'))}" value="${esc(r.max ?? '')}" />
				</span>` : `
				<input type="text" class="form-control tblk-cf-value" data-idx="${i}" list="tblk-cf-dl-${i}"
					placeholder="${esc(__('Value'))}" value="${esc(r.value ?? '')}" />
				<datalist id="tblk-cf-dl-${i}">${cf_select_options(r).map((o) =>
					`<option value="${esc(o)}"></option>`).join('')}</datalist>`}
				<button type="button" class="btn btn-default btn-xs tblk-cf-del" data-idx="${i}"
					title="${esc(__('Remove this filter'))}">✕</button>
			</div>`).join('')}
			<div class="tblk-cf-actions">
				<button type="button" class="btn btn-default btn-xs tblk-cf-add">+ ${__('Add Filter')}</button>
				${rows.length > 1 ? `<span class="tblk-cf-match btn-group" role="group"
					aria-label="${esc(__('Match mode'))}">
					<span class="tblk-cf-match-lbl">${__('Match')}:</span>${matchBtn('AND')}${matchBtn('OR')}
				</span>` : ''}
				${rows.length ? `<button type="button" class="btn btn-default btn-xs tblk-cf-clear">${__('Clear All')}</button>
				<button type="button" class="btn btn-primary btn-xs tblk-cf-apply">${__('Apply')}</button>` : ''}
			</div>
		</div>`;
	};

	// Isi datalist cadangan nilai untuk satu baris — skop ikut tapisan
	// group aktif. Tidak re-render supaya fokus kekal. Baris julang nombor
	// tiada datalist; baris Select guna pilihan meta (sudah diisi semasa
	// render — tiada API).
	function cf_fill_datalist(inst, $row) {
		const idx = $row.data('idx');
		const r = inst.st.custom?.[idx];
		if (!r || !r.doctype || !r.fieldname || cf_is_range(r)) return;
		if (cf_fieldtype(r) === 'Select') {
			$row.find('datalist').html(cf_select_options(r)
				.map((o) => `<option value="${esc(o)}"></option>`).join(''));
			return;
		}
		frappe.call({
			method: 'travel_booking.api.manage_trip_booking.get_booking_filter_values',
			args: {
				doctype: r.doctype,
				fieldname: r.fieldname,
				trip_groups: inst.st.group ? [inst.st.group] : inst.trip_groups,
				limit: 100,
			},
		}).then((res) => {
			const cur = inst.st.custom?.[idx];
			if (!cur || cur.doctype !== r.doctype || cur.fieldname !== r.fieldname) return;
			$row.find('datalist').html((res?.message?.values || [])
				.map((v) => `<option value="${esc(v)}"></option>`).join(''));
		}).catch(() => { /* cadangan gagal — input teks masih berfungsi */ });
	}

	// Selepas render semula, isi semula datalist baris yang ada medan.
	function cf_hydrate(inst) {
		inst.$root.find('.tblk-cf-row').each(function () {
			if ($(this).find('.tblk-cf-field-input').val()) cf_fill_datalist(inst, $(this));
		});
	}

	// ── Katalog medan BULK edit — cermin BOOKING_BULK_EDIT_FIELDS server.
	// Group tunggal Booking — semua disimpan MELALUI doctype Booking
	// (doc.save penuh, hook & validasi doctype kekal berjalan). ──
	const BULK_EDIT_FIELDS = [
		{ key: 'status', label: 'Booking Status', fieldtype: 'Select', options: BOOKING_STATUS_OPTIONS },
		{ key: 'booking_channel', label: 'Booking Channel', fieldtype: 'Select',
			options: ['Direct', 'Staff', 'Affiliate', 'B2B'] },
		{ key: 'checkout_method', label: 'Checkout Method', fieldtype: 'Select',
			options: ['Online Payment Gateway', 'Manual Transfer', 'Held Booking'] },
		{ key: 'booked_by', label: 'Booked By', fieldtype: 'Link', options: 'User' },
		{ key: 'affiliate', label: 'Affiliate', fieldtype: 'Link', options: 'Sales Partner' },
		{ key: 'b2b_partner', label: 'B2B Partner', fieldtype: 'Link', options: 'Travel B2B Partner' },
	];

	// ── Jalur ringkasan — kumpulan dipisah pemisah menegak, susunan:
	// (1) Bookings · Rooms ─ (2) Pax · Verified Doc ─ (3) senarai revenue
	// per currency ─ (4) Total Revenue · Total Collection (default
	// currency) ─ kanan: Collected %. Sumber: meta `summary`
	// get_group_bookings — skop PENUH group/batch, TIDAK dipengaruhi
	// carian/penapis (backend mirror _tv_summary). Jumlah default currency
	// dipapar '≈' bila campur currency; '+' bila ada currency tanpa kadar. ──
	const summary_html = (s) => {
		if (!s) return '';
		const pct = Number(s.collected_pct) || 0;
		const level = pct >= 70 ? 'good' : pct >= 30 ? 'warn' : 'bad';
		const revRows = s.balance_by_currency || [];
		const cur = s.default_currency;
		const incomplete = s.rates_complete === false ? '+' : '';
		// Jumlah default currency — '≈' hanya bila campur currency.
		const dTotal = (v) => (revRows.length > 1 ? '≈ ' : '')
			+ fmtMoney(v, cur) + incomplete;
		const revList = revRows.length
			? revRows.map((r) => `<span class="tblk-sum-item">${fmtMoney(r.gross, r.currency)}</span>`).join('')
			: `<span class="tblk-sum-item">${fmtMoney(0, cur)}</span>`;
		const sep = '<span class="tblk-sum-sep"></span>';
		return `<div class="tblk-summary">
			<div class="tblk-sum-col">
				<span class="tblk-sum-item">${__('Bookings')}: <b>${Number(s.bookings) || 0}</b></span>
				<span class="tblk-sum-item">${__('Rooms')}: <b>${Number(s.rooms) || 0}</b></span>
			</div>
			${sep}
			<div class="tblk-sum-col">
				<span class="tblk-sum-item">${__('Pax')}: <b>${Number(s.pax) || 0}</b></span>
				<span class="tblk-sum-item"
					title="${esc(__('Verified vs submitted traveller documents'))}">${__('Verified Doc')}: <b>${Number(s.docs_verified) || 0}</b></span>
			</div>
			${sep}
			<div class="tblk-sum-col" title="${esc(__('Revenue breakdown by currency'))}">
				${revList}
			</div>
			${sep}
			<div class="tblk-sum-col">
				<span class="tblk-sum-item">${__('Total Revenue')}: <b>${dTotal(s.default_gross)}</b></span>
				<span class="tblk-sum-item">${__('Total Collection')}: <b>${dTotal(s.default_paid)}</b></span>
			</div>
			<div class="tblk-sum-col tblk-sum-col--end">
				<span class="tblk-sum-item tblk-sum-ready tblk-sum-ready--${level}"
					title="${esc(__('Paid vs gross in default currency'))}">${__('Collected')}: <b>${pct}%</b></span>
			</div>
		</div>`;
	};

	/* ── Registry kolum ───────────────────────────────────────────
	   Setiap kolum: th() → label header; cls — kelas <td>/<th>;
	   td(b) → HTML cell; total(tot, m) → HTML cell footer (tiada =
	   kolum tanpa kiraan — kolum tanpa kiraan di hadapan diumpuk
	   jadi satu cell label colspan); val(b) → nilai sort client-side
	   (kolum dengan val sahaja diberi header boleh sort).           */

	const COLUMNS = {
		booking_no: {
			th: () => __('Booking No'),
			cls: 'tblk-col-bkopen',
			val: (b) => b.booking_number || b.name || '',
			td: (b, m) => `
				<div class="tblk-cell-main">${esc(b.booking_number || b.name)}</div>
				<div class="tblk-cell-sub">${esc(b.name)}</div>
				${m.compact && b.status ? `<div class="tblk-cell-sub">${badge(b.status, BOOKING_STATUS_COLORS[b.status])}</div>` : ''}`,
		},
		customer: {
			th: () => __('Customer'),
			val: (b) => b.customer_name || '',
			td: (b) => `
				<div class="tblk-cell-main">${esc(b.customer_name)}</div>
				${b.cust_email ? `<div class="tblk-cell-sub">${esc(b.cust_email)}</div>` : ''}
				${b.cust_phone ? `<div class="tblk-cell-sub tblk-contact-line"><span>☎ ${esc(b.cust_phone)}</span>${contact_icons(b.cust_phone)}</div>` : ''}`,
		},
		message: {
			th: () => __('Message'),
			cls: 'tblk-col-msg',
			td: (b) => {
				if (!b.customer_message) return '<span class="tblk-muted">—</span>';
				return `<button type="button" class="btn btn-link tblk-msg-btn"
					title="${esc(b.customer_message)}" data-message="${esc(b.customer_message)}"
					data-title="${esc(__('Customer Message') + ' · ' + (b.booking_number || b.name))}"
					aria-label="${esc(__('View customer message'))}">
					${frappe.utils.icon('message-square', 'sm')}</button>`;
			},
		},
		group: {
			th: () => __('Group'),
			val: (b) => b.trip_date || '',
			td: (b) => `<span class="tblk-muted">${esc(b.trip_date || '')}</span>`,
		},
		status: {
			th: () => __('Status'),
			val: (b) => b.status || '',
			td: (b) => `
				${badge(b.status, BOOKING_STATUS_COLORS[b.status])}
				${b.booking_channel ? `<div class="tblk-cell-sub">${esc(b.booking_channel)}</div>` : ''}`,
		},
		payment: {
			th: () => __('Payment'),
			val: (b) => b.payment_status || '',
			td: (b) => badge(b.payment_status, PAYMENT_STATUS_COLORS[b.payment_status]),
		},
		pax: {
			th: () => __('Pax'), num: true,
			val: (b) => b.pax ?? 0,
			td: (b) => String(b.pax ?? 0),
			total: (tot) => `<td class="num">${tot.pax ?? 0}</td>`,
		},
		// Pax (compact) — pax + bilik + dokumen verified/submitted.
		// Semantik: submitted = reservation berpaut Traveller;
		// verified = Traveller berstatus dokumen Verified/Valid.
		pax_info: {
			th: () => __('Pax'), num: true,
			val: (b) => b.pax ?? 0,
			td: (b) => `
				${b.pax}
				<div class="tblk-cell-sub">${b.rooms ?? 0} ${__('rooms')}</div>
				<div class="tblk-cell-sub ${(b.pending_docs || 0) > 0 ? 'tblk-danger' : ''}"
					title="${esc(__('Verified vs submitted traveller documents'))}">${b.docs_verified || 0}/${b.docs_submitted || 0} ${__('docs')}</div>`,
			total: (tot) => `<td class="num">${tot.pax ?? 0}</td>`,
		},
		rooms: {
			th: () => __('Rooms'), num: true,
			val: (b) => b.rooms ?? 0,
			td: (b) => String(b.rooms ?? 0),
			total: (tot) => `<td class="num">${tot.rooms ?? 0}</td>`,
		},
		gross: {
			th: () => __('Gross'), num: true,
			val: (b) => (b.default_totals ? b.default_totals.gross : 0) || 0,
			td: (b, m) => fmtCurRows(m.bcur(b), 'gross'),
			total: (tot, m) => m.money_total(tot, 'gross'),
		},
		paid: {
			th: () => __('Paid'), num: true,
			val: (b) => (b.default_totals ? b.default_totals.paid : 0) || 0,
			td: (b, m) => fmtCurRows(m.bcur(b), 'paid'),
			total: (tot, m) => m.money_total(tot, 'paid'),
		},
		balance: {
			th: () => __('Balance'), num: true,
			val: (b) => (b.default_totals ? b.default_totals.balance : 0) || 0,
			td: (b, m) => `<span class="${hasBalance(m.bcur(b)) ? 'tblk-danger' : 'tblk-success'}">${fmtCurRows(m.bcur(b), 'balance')}</span>`,
			total: (tot, m) => m.money_total(tot, 'balance', (m.dt(tot).balance || 0) > 0.009 ? 'tblk-danger' : ''),
		},
		discount: {
			th: () => __('Discount'), num: true,
			val: (b) => round2((b.voucher_discount || 0) + (b.price_rule_discount || 0)
				+ (b.referral_discount || 0)),
			td: (b) => {
				const dscCur = b.discount_currency || b.currency || _currency;
				const parts = [];
				if (b.voucher_discount) parts.push('V: ' + fmtMoney(b.voucher_discount, dscCur));
				if (b.price_rule_discount) parts.push('PR: ' + fmtMoney(b.price_rule_discount, dscCur));
				if (b.referral_discount) parts.push('RF: ' + fmtMoney(b.referral_discount, dscCur));
				return parts.length ? parts.join('<br>') : '<span class="tblk-muted">—</span>';
			},
			total: (tot, m) => m.money_total(tot, 'discount'),
		},
		pending: {
			th: () => __('Docs'), num: true,
			val: (b) => b.pending_docs ?? 0,
			td: (b) => `<span class="${(b.pending_docs || 0) > 0 ? 'tblk-danger' : ''}"
				title="${esc(__('Traveller documents pending verification'))}">${b.pending_docs ?? 0}</span>`,
			total: (tot) => `<td class="num ${(tot.pending_docs || 0) > 0 ? 'tblk-danger' : ''}">${tot.pending_docs ?? 0}</td>`,
		},
		created: {
			th: () => __('Created'), num: true,
			val: (b) => b.creation || '',
			td: (b) => `<span class="tblk-muted">${fmtDateTime(b.creation)}</span>`,
		},
		// Bills (compact) — nilai bil per currency + % paid + badge payment.
		bills: {
			th: () => __('Bills'), num: true,
			val: (b) => (b.default_totals ? b.default_totals.gross : 0) || 0,
			td: (b, m) => {
				const bdt = b.default_totals;
				const pctPaid = (bdt && bdt.gross)
					? Math.round((bdt.paid || 0) / bdt.gross * 100) + '% ' + __('paid')
					: '';
				const payBadge = badge(b.payment_status, PAYMENT_STATUS_COLORS[b.payment_status]);
				return `
					<div class="tblk-cell-main">${fmtCurRows(m.bcur(b), 'gross')}</div>
					${pctPaid ? `<div class="tblk-cell-sub">${pctPaid}</div>` : ''}
					${payBadge ? `<div class="tblk-cell-sub">${payBadge}</div>` : ''}`;
			},
			total: (tot, m) => m.money_total(tot, 'gross'),
		},
		// More (compact) — tarikh + checkout + baki tertunggak.
		more: {
			th: () => __('More'), num: true,
			val: (b) => b.creation || '',
			td: (b, m) => `
				<div class="tblk-cell-main">${fmtDate(b.creation)}</div>
				${b.checkout_method ? `<div class="tblk-cell-sub">${esc(b.checkout_method)}</div>` : ''}
				<div class="tblk-cell-sub ${hasBalance(m.bcur(b)) ? 'tblk-danger' : ''}"
					title="${esc(__('Balance amount to pay'))}">${fmtCurRows(m.bcur(b), 'balance')}</div>`,
		},
	};

	const PRESETS = {
		full: ['booking_no', 'customer', 'message', 'group', 'status', 'payment',
			'pax', 'rooms', 'gross', 'paid', 'balance', 'discount', 'pending', 'created'],
		compact: ['booking_no', 'customer', 'pax_info', 'bills', 'more'],
	};

	// ── Dialog BULK edit pelbagai medan — mirror open_traveller_bulk_dialog
	// pakej traveller. User PILIH medan (katalog di atas) → widget nilai
	// dirender mengikut fieldtype (Select/Link — FieldGroup Frappe). Apply →
	// api bulk_update_bookings; server menyimpan setiap rekod melalui
	// doctype Booking berasingan. Ringkasan updated/skipped/failed dipapar
	// sebagai alert; berjaya → muat semula senarai. ──
	function open_bulk_dialog(inst, names) {
		const d = new frappe.ui.Dialog({
			title: '⚙ ' + __('Bulk Edit') + ' — ' + __('{0} bookings', [names.length]),
		});
		d.$body.html(`
			<div class="tblk-bulk">
				<div class="tblk-bulk-meta">${__('Choose the field to update for all selected bookings')}:</div>
				<select class="form-control tblk-bulk-field">
					<option value="">— ${__('Select Field')} —</option>
					${BULK_EDIT_FIELDS.map((f) =>
						`<option value="${f.key}">${esc(__(f.label))}</option>`).join('')}
				</select>
				<div class="tblk-bulk-value" style="margin-top:10px;"></div>
				<div class="tblk-bulk-actions" style="margin-top:10px;">
					<button type="button" class="btn btn-primary btn-sm tblk-bulk-apply" disabled>
						${__('Apply to All')}</button>
				</div>
				<div class="tblk-bulk-meta tblk-muted">${__(
					'Each field is saved through its own Booking doctype form — validation and hooks run as usual. Bookings without the target record are skipped.')}</div>
			</div>`);

		let fg = null;
		const $val = d.$body.find('.tblk-bulk-value');
		const $apply = d.$body.find('.tblk-bulk-apply');
		const getSel = () => BULK_EDIT_FIELDS.find(
			(x) => x.key === d.$body.find('.tblk-bulk-field').val());
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
		d.$body.find('.tblk-bulk-field').on('change', renderValue);

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
				const r = await frappe.call({
					method: 'travel_booking.api.manage_trip_booking.bulk_update_bookings',
					args: { bookings: names, field: f.key, value: String(v) },
				});
				const out = r?.message || {};
				d.hide();
				frappe.show_alert({
					message: __('{0}: {1} updated, {2} skipped, {3} failed', [
						__(f.label), (out.updated || []).length,
						(out.skipped || []).length, (out.failed || []).length]),
					indicator: (out.failed || []).length ? 'orange' : 'green',
				});
				// Muat semula senarai — status/nilai baharu + kiraan tab page.
				inst.load(true);
			} catch (e) {
				// frappe.call papar ralat server sebagai msgprint — benarkan
				// cuba semula.
				$btn.prop('disabled', false);
			}
		});
		d.show();
	}

	/* ── Bina komponen pada container ─────────────────────────── */

	function create(pane, opts) {
		const $pane = $(pane);
		if (!$pane.length) return null;

		opts = opts || {};
		_currency = opts.currency || 'MYR';

		// Root stabil — event diikat SEKALI di sini; render hanya mengganti
		// innerHTML, jadi handler delegated kekal hidup merentas render.
		// Root baru sentiasa di atas pane yang bersih — placeholder
		// "Loading..." skeleton pane dibuang dahulu.
		let $root = $pane.children('.tblk-root').first();
		if (!$root.length) {
			$pane.empty();
			$root = $('<div class="tblk-root"></div>').appendTo($pane);
		}

		// State dikongsi dengan page (corak render_traveller_list) —
		// page boleh semai nilai awal / baca semula selepas pane dijana
		// semula (render_detail).
		const st = opts.state || {};
		st.search = st.search || '';
		st.status = st.status || '';
		st.payment = st.payment || '';
		st.currency = st.currency || '';
		st.group = st.group || '';
		st.limit = st.limit != null ? st.limit : 10;
		// Penapis dinamik + togol panel + mod gabungan (corak tv.custom).
		st.custom = Array.isArray(st.custom) ? st.custom : [];
		st.cf_open = !!st.cf_open;
		st.cf_match = st.cf_match === 'OR' ? 'OR' : 'AND';
		// Sort client-side — '' = turutan server (creation DESC).
		st.sort = st.sort || '';
		st.sort_dir = st.sort_dir === -1 ? -1 : 1;

		const trip_groups = opts.trip_groups || [];
		const multi = trip_groups.length > 1;
		const compact = opts.columns === 'compact'
			|| (Array.isArray(opts.columns) && opts.columns.includes('pax_info'));

		const inst = {
			opts, st, $root, trip_groups,
			data: null,
			is_attached: () => $root.closest('body').length > 0,
			load,
			render,
		};

		function resolve_columns() {
			let cols = opts.columns || 'full';
			if (typeof cols === 'string') cols = PRESETS[cols] || PRESETS.full;
			return cols
				.map((k) => ({ key: k, col: COLUMNS[k] }))
				.filter((x) => !!x.col)
				.filter((x) => x.col !== COLUMNS.group || multi);
		}

		// Pecahan per-currency booking — fallback scalar lama bila
		// payload tiada pecahan (cache lama).
		const bcur = (b) => (b.gross_by_currency && b.gross_by_currency.length)
			? b.gross_by_currency
			: (b.gross != null
				? [{
					currency: b.currency || _currency, gross: b.gross, paid: b.paid,
					balance: b.balance ?? round2(b.gross - (b.paid || 0)),
				}]
				: []);

		// Footer money — default_totals (jumlah bersamaan default currency,
		// kadar semasa; '+' bila ada currency tanpa kadar) + tooltip pecahan
		// native per currency. '≈' bila senarai bercampur currency.
		const dt = (tot) => tot.default_totals
			|| { currency: _currency, gross: tot.gross || 0, paid: tot.paid || 0,
				balance: tot.balance ?? round2((tot.gross || 0) - (tot.paid || 0)),
				discount: tot.discount || 0, rates_complete: true };
		const tot_cur = (tot) => (tot.by_currency && tot.by_currency.length)
			? tot.by_currency
			: (tot.gross != null
				? [{
					currency: _currency, gross: tot.gross || 0, paid: tot.paid || 0,
					balance: tot.balance ?? round2((tot.gross || 0) - (tot.paid || 0)),
					discount: tot.discount || 0,
				}]
				: []);
		const money_total = (tot, field, extraCls) => {
			const d = dt(tot);
			const incomplete = d.rates_complete === false ? '+' : '';
			const mixed = tot_cur(tot).length > 1;
			const title = tot_cur(tot).length
				? esc(__('Per currency') + ': '
					+ tot_cur(tot).map((r) => fmtMoney(r[field], r.currency)).join(' · '))
				: '';
			return `<td class="num ${extraCls || ''}" title="${title}">${mixed ? '≈ ' : ''}${fmtMoney(d[field], d.currency)}${incomplete}</td>`;
		};

		async function load(force) {
			if (inst.data && !force) {
				render();
				return;
			}
			$root.html(`<div class="tblk-loading">${__('Loading bookings...')}</div>`);
			try {
				const r = await frappe.call({
					method: 'travel_booking.api.manage_trip_booking.get_group_bookings',
					args: {
						trip_groups: st.group ? [st.group] : trip_groups,
						status: st.status || null,
						payment_status: st.payment || null,
						search: st.search || null,
						currency: (opts.currency_filter && st.currency) ? st.currency : null,
						custom_filters: cf_active(st.custom),
						custom_match: st.cf_match === 'OR' ? 'OR' : 'AND',
						limit: st.limit,
					},
					freeze: false,
				});
				inst.data = r?.message ?? null;
				render();
				if (typeof opts.on_loaded === 'function') opts.on_loaded(inst.data);
			} catch (err) {
				console.error('TravelBookingBookingList: get_group_bookings failed', err);
				$root.html(`<div class="tblk-empty">${__('Error loading bookings.')}</div>`);
				frappe.show_alert({ message: __('Error loading data'), indicator: 'red' }, 5);
			}
		}

		function render() {
			// Currency display instance ni — dikemas kini setiap render
			// supaya fallback fmtCurRows(fmtMoney 0) ikut instance aktif.
			_currency = opts.currency || 'MYR';
			const data = inst.data || {};
			// Sort client-side (baris yang dimuat sahaja — turutan server
			// kekal bila st.sort kosong). Corak sama dengan TV_SORTS pakej
			// traveller: klik header tukar kolum, klik lagi tukar arah.
			let rows = data.bookings || [];
			if (st.sort && COLUMNS[st.sort]?.val) {
				const val = COLUMNS[st.sort].val;
				const dir = st.sort_dir;
				rows = rows.slice().sort((a, b) => {
					const va = val(a), vb = val(b);
					const c = (typeof va === 'number' && typeof vb === 'number')
						? va - vb : String(va).localeCompare(String(vb));
					return c * dir;
				});
			}
			const tot = data.totals || {};
			const cols = resolve_columns();
			const m = { compact, bcur, dt, money_total };

			// ── Toolbar — konsep layout sama dengan pakej senarai traveller:
			// (1) carian + [group date bila batch] + butang Filter,
			// (2) panel penapis dinamik (ditogol oleh butang Filter),
			// (3) kiri: togol paparan + Bulk Edit · kanan: bilangan baris +
			// Download + Order By.
			const groupOpts = (opts.group_options || [])
				.map((g) => `<option value="${esc(g.name)}" ${st.group === g.name ? 'selected' : ''}>${esc(g.name)} · ${esc(g.trip_name || '')}</option>`)
				.join('');
			const limitSel = `<select data-tblk-kind="limit" title="${esc(__('Rows to show'))}">${ROW_LIMITS.map((n) =>
				`<option value="${n}" ${n === st.limit ? 'selected' : ''}>${n === 0 ? __('All rows') : __('{0} rows', [n])}</option>`).join('')}</select>`;

			// Baris atas — carian (dengan butang ✕ kosongkan) + togol panel
			// penapis dinamik.
			const showCards = opts.show_cards !== false;
			// Skop muat turun — ikut tapisan group aktif (group tunggal bila
			// ditapis, selain itu seluruh skop batch).
			const dlBase = '/api/method/travel_booking.api.manage_trip_booking.';
			const dlGroups = st.group ? [st.group] : trip_groups;
			const dlQuery = dlGroups.length
				? 'trip_groups=' + encodeURIComponent(JSON.stringify(dlGroups)) : '';
			const showDl = !!dlQuery;
			// Kotak carian — PAKEJ STANDARD TravelBookingSearchBox (markup
			// .mba-searchwrap + butang ✕ .mba-search-clear; auto-bind
			// document menguruskan keterlihatan & tindakan kosongkan).
			// Fallback markup sama bila pakej tiada (page lama tanpa hooks
			// baharu) — handler ✕ sendiri di bawah kekal berfungsi.
			const searchBox = window.TravelBookingSearchBox
				? window.TravelBookingSearchBox.html({
					cls: 'tblk-search',
					placeholder: opts.search_placeholder || __('Search booking / customer / traveller...'),
					value: st.search,
				})
				: `<span class="mba-searchwrap">
					<input type="text" class="tblk-search" placeholder="${esc(opts.search_placeholder || __('Search booking / customer / traveller...'))}"
						value="${esc(st.search)}" />
					<button type="button" class="mba-search-clear" ${st.search ? '' : 'hidden'}
						title="${esc(__('Clear search'))}" aria-label="${esc(__('Clear search'))}">✕</button>
				</span>`;
			const toolbar = `
				<div class="tblk-toolbar">
					<div class="tblk-toolbar-top">
						${searchBox}
						${opts.group_options && opts.group_options.length ? `
						<select data-tblk-kind="group" title="${esc(__('Filter by trip group date'))}">
							<option value="">${__('All Group Dates')}</option>${groupOpts}
						</select>` : ''}
						${cf_toggle_html(st)}
					</div>
					${cf_panel_html(st)}
					<div class="tblk-toolbar-row">
						<div class="tblk-toolbar-left">
							<div class="btn-group tblk-bulk-group" role="group"
								aria-label="${esc(__('Bulk actions'))}">
								<button type="button" class="btn btn-default btn-xs tblk-bulk-btn"
									disabled title="${esc(__('Bulk edit the selected bookings'))}">${__('Bulk Edit')}</button>
								<button type="button" class="btn btn-default btn-xs tblk-bulk-del-btn"
									disabled title="${esc(__('Delete the selected bookings — Cancelled more than 24 hours ago only'))}"
									aria-label="${esc(__('Delete the selected bookings — Cancelled more than 24 hours ago only'))}">${frappe.utils.icon('trash', 'sm')}</button>
							</div>
						</div>
						<div class="tblk-toolbar-right">
							${limitSel}
							${showDl ? `
							<div class="tblk-dl">
								<button type="button" class="btn btn-default btn-xs tblk-dl-btn"
									title="${esc(__('Download this booking list'))}" aria-haspopup="menu">
									<span class="tblk-dl-label">${__('Download')}</span> ${frappe.utils.icon('chevron-down', 'sm')}
								</button>
							</div>` : ''}
							<div class="tblk-sortby"></div>
						</div>
					</div>
				</div>`;

			const title = opts.show_title
				? `
				<div class="tblk-section-title">🧾 ${__('Booking Reservations')}
					<span class="tblk-count-pill">${data.count ?? 0}</span>
				</div>` : '';

			// ── Kad (telefon / togol paparan) ──
			const cards = showCards ? rows.map((b) => {
				const c = bcur(b);
				return `
				<div class="tblk-bkcard" data-booking="${esc(b.name)}" title="${esc(__('Open booking info page'))}">
					<div class="tblk-bkcard-top">
						<span class="tblk-bkcard-no">${esc(b.booking_number || b.name)}</span>
						<span class="tblk-bkcard-badges">
							<input type="checkbox" class="tblk-checkrow" data-booking="${esc(b.name)}"
								title="${esc(__('Select for bulk edit / download'))}"
								aria-label="${esc(__('Select for bulk edit / download'))}" />
							${b.customer_message ? `<button type="button" class="btn btn-link tblk-msg-btn"
								title="${esc(b.customer_message)}" data-message="${esc(b.customer_message)}"
								data-title="${esc(__('Customer Message') + ' · ' + (b.booking_number || b.name))}">${frappe.utils.icon('message-square', 'sm')}</button>` : ''}
							${badge(b.status, BOOKING_STATUS_COLORS[b.status])}
						</span>
					</div>
					<div class="tblk-bkcard-cust">${esc(b.customer_name)}</div>
					<div class="tblk-bkcard-meta">
						${b.pax} ${__('pax')} · ${b.rooms} ${__('rooms')}${multi && b.trip_date ? ' · ' + esc(b.trip_date) : ''}
					</div>
					<div class="tblk-bkcard-meta ${(b.pending_docs || 0) > 0 ? 'tblk-danger' : ''}">
						${__('Docs')} ${b.docs_verified || 0}/${b.docs_submitted || 0}
					</div>
					<div class="tblk-bkcard-foot">
						${badge(b.payment_status, PAYMENT_STATUS_COLORS[b.payment_status])}
						<span class="${hasBalance(c) ? 'tblk-danger' : 'tblk-success'}">${fmtCurRows(c, 'balance')} ${__('due')}</span>
					</div>
				</div>`;
			}).join('') : '';

			// ── Jadual (desktop / togol paparan) ──
			// Header boleh sort (kolum dengan val) — anak panah arah aktif
			// pada kolum terpilih; kolum lain statik.
			const sort_th = (x) => {
				if (!x.col.val) {
					return `<th class="${x.col.num ? 'num ' : ''}${x.col.cls || ''}">${x.col.th()}</th>`;
				}
				const on = st.sort === x.key;
				const arrow = !on ? '↕' : (st.sort_dir === 1 ? '↑' : '↓');
				return `<th class="tblk-sort${on ? ' is-sorted' : ''} ${x.col.num ? 'num ' : ''}${x.col.cls || ''}"
					data-tblksort="${x.key}" title="${esc(__('Sort by') + ' ' + x.col.th())}">${x.col.th()}
					<span class="tblk-sort-ico">${arrow}</span></th>`;
			};
			const headCells = `<th class="tblk-check"><input type="checkbox" class="tblk-checkall"
				title="${esc(__('Select all rows'))}" aria-label="${esc(__('Select all rows'))}"></th>`
				+ cols.map(sort_th).join('');
			const bodyRows = rows.map((b) => `
				<tr class="tblk-row" data-booking="${esc(b.name)}">
					<td class="tblk-check"><input type="checkbox" class="tblk-checkrow"
						data-booking="${esc(b.name)}"
						title="${esc(__('Select for bulk edit / download'))}"
						aria-label="${esc(__('Select for bulk edit / download'))}"></td>
					${cols.map((x) => `<td class="${x.col.num ? 'num ' : ''}${x.col.cls || ''}">${x.col.td(b, m)}</td>`).join('')}
				</tr>`).join('');

			// Footer totals — kolum tanpa kiraan di hadapan diumpuk jadi
			// satu cell label colspan; kiraan wang dalam default currency
			// (kadar semasa) dengan tooltip pecahan native per currency.
			// Cell pertama (checkbox) kekal kosong.
			const leading = [];
			for (const x of cols) {
				if (x.col.total) break;
				leading.push(x);
			}
			const d = dt(tot);
			const incomplete = d.rates_complete === false ? '+' : '';
			const label = data.count ? `
				${__('Total')} (${data.count} ${__('bookings')})
				<span class="tblk-muted">· ${esc(d.currency || _currency)}${incomplete}</span>` : '';
			const footCells = cols.slice(leading.length)
				.map((x) => (x.col.total ? x.col.total(tot, m) : '') || '<td></td>').join('');
			const footer = data.count ? `
				<tfoot><tr>
					<td class="tblk-check"></td>
					<td class="tblk-tfoot-label" colspan="${Math.max(leading.length, 1)}">${label}</td>
					${footCells}
				</tr></tfoot>` : '';

			// Baris ringkas bawah jadual (compact / telefon) — jumlah pax
			// + baki tertunggak dalam default currency.
			const summaryLine = compact && data.count ? `
				<div class="tblk-tab-total">${__('Total')} (${data.count} ${__('bookings')}) · ${tot.pax ?? 0} ${__('pax')}
					· <span class="${(d.balance || 0) > 0.009 ? 'tblk-danger' : ''}">${fmtMoney(d.balance, d.currency)} ${__('due')}</span></div>` : '';

			// Mesej kosong — bezakan "tiada padanan penapis" vs "tiada
			// booking langsung" (corak render_bkg_travellers).
			const hasFilters = !!(st.search || st.status || st.payment
				|| (opts.currency_filter && st.currency) || cf_active(st.custom).length);
			const emptyMsg = hasFilters
				? __('No bookings found for this filter.')
				: __('No bookings found for this group.');

			const showing = `
				<div class="tblk-showing">
					<span>${__('Showing {0} of {1} {2}', [data.shown ?? 0, data.count ?? 0, __('bookings')])}</span>
					${(data.count || 0) > (data.shown || 0) ? `<button class="btn btn-default btn-xs tblk-load-more">${__('Load more')}</button>` : ''}
				</div>`;

			// Paparan kad/jadual — media query CSS (kad telefon, jadual
			// desktop); page tanpa kad memaksa jadual sentiasa.
			$root.toggleClass('tblk-view-table', !showCards);
			$root.html(`
				${title}
				${opts.show_summary !== false ? summary_html(data.summary) : ''}
				${toolbar}
				${rows.length ? `
				${showCards ? `<div class="tblk-cards">${cards}</div>` : ''}
				<div class="tblk-table-wrap">
					<table class="tblk-table">
						<thead><tr>${headCells}</tr></thead>
						<tbody>${bodyRows}</tbody>
						${footer}
					</table>
				</div>
				${summaryLine}` : `<div class="tblk-empty">${emptyMsg}</div>`}
				${showing}`);

			// ── Wiring pasca-render (elemen segar setiap render) ──

			// Order By — komponen standard Frappe (ikon arah asc/desc +
			// dropdown medan), state yang sama dengan klik header jadual.
			// frappe v17: SortSelector hanya set internal sort_by/sort_order
			// dalam setup_from_doctype() — bila dibina TANPA doctype ia
			// return awal & internal kekal undefined → klik butang arah
			// memanggil onchange(undefined, ...). Set semula internal itu
			// secara eksplisit daripada args (corak pakej traveller).
			const sortableCols = cols.filter((x) => x.col.val);
			if (sortableCols.length) {
				const sortBy = new frappe.ui.SortSelector({
					parent: $root.find('.tblk-sortby'),
					args: {
						options: [{ fieldname: 'created', label: __('Newest first') }]
							.concat(sortableCols.map((x) => ({ fieldname: x.key, label: x.col.th() }))),
						sort_by: st.sort || 'created',
						sort_by_label: st.sort ? COLUMNS[st.sort].th() : __('Newest first'),
						sort_order: st.sort_dir === -1 ? 'desc' : 'asc',
					},
					onchange: (sort_by, sort_order) => {
						st.sort = sort_by && sort_by !== 'created' ? sort_by : '';
						st.sort_dir = sort_order === 'desc' ? -1 : 1;
						render();
					},
				});
				sortBy.sort_by = sortBy.args.sort_by;
				sortBy.sort_order = (sortBy.args.sort_order || 'asc').toLowerCase();
				// Turutan lalai (server — creation DESC) tiada arah pilihan;
				// nyahaktifkan butang arah supaya keadaan itu jelas.
				sortBy.wrapper.find('.btn-order')
					.prop('disabled', !st.sort)
					.attr('title', st.sort
						? sortBy.wrapper.find('.btn-order').attr('title')
						: __('Newest first (default order)'));
			}

			// Butang Download → dropdown espresso framework (frappe.ui.
			// Dropdown). Item ialah pautan href native — pelayar memproses
			// muat turun terus (Content-Disposition). SKOP PILIHAN — bila
			// checkbox bulk aktif (≥1 baris dipilih), kedua-dua item hanya
			// eksport baris TERPILIH (param bookings=…); href dikemas kini
			// setiap kali pilihan berubah & sebelum menu dibuka; label
			// butang menunjukkan bilangan dipilih (corak pakej traveller).
			if (showDl) {
				const $dlBtn = $root.find('.tblk-dl-btn');
				new frappe.ui.Dropdown({
					trigger: $dlBtn,
					align: 'end',
					options: [
						{
							label: __('Excel (XLSX)'),
							icon: 'download',
							href: dlBase + 'download_bookings_excel?' + dlQuery,
						},
						{
							label: __('CSV'),
							icon: 'download',
							href: dlBase + 'download_bookings_csv?' + dlQuery,
						},
					],
				});
				const updateDlScope = () => {
					const checked = [];
					// Checkbox yang KELIHATAN sahaja — kad & jadual wujud
					// serentak dalam DOM (satu tersembunyi); tanpa penapis
					// ini pilihan akan berganda.
					$root.find('.tblk-checkrow:checked').filter(':visible').each(function () {
						checked.push(String($(this).data('booking') || ''));
					});
					const suffix = checked.length
						? '&bookings=' + encodeURIComponent(JSON.stringify(checked))
						: '';
					// Menu espresso DIRENDER DI LUAR .tblk-dl (es-menu di
					// badan dokumen) — cari pautan ikut endpoint + dlQuery
					// instance ini (dlQuery unik per skop trip_groups).
					const endpoints = ['download_bookings_excel?', 'download_bookings_csv?'];
					document.querySelectorAll('a[href*="download_bookings_"]').forEach((a) => {
						const href = a.getAttribute('href') || '';
						if (!href.includes(dlQuery)) return;
						const ep = endpoints.find((e) => href.includes(e));
						if (ep) a.setAttribute('href', dlBase + ep + dlQuery + suffix);
					});
					$dlBtn.find('.tblk-dl-label').text(checked.length
						? `${__('Download')} (${checked.length})` : __('Download'));
				};
				updateDlScope();
				// Ikat pada $root (bukan table-wrap) selepas handler bulk
				// bind_events — susunan handler menjamin select-all sudah
				// menanda baris kelihatan SEBELUM skop download dikira.
				// Nama ruang .tblkdl dibuang dahulu supaya tidak terikat
				// berganda merentas render (elemen $root kekal).
				$root.off('change.tblkdl').on('change.tblkdl',
					'.tblk-checkrow, .tblk-checkall', updateDlScope);
				$dlBtn.on('click', updateDlScope);
			}

			// Datalist cadangan nilai penapis — isi semula selepas render.
			cf_hydrate(inst);
		}

		// ── Event (diikat SEKALI pada root) ──
		bind_events($root);

		// Handler membaca instance SEMASA melalui data — create() pada
		// pane yang sama (selepas render_detail menjana semula DOM)
		// mengemas kini rujukan tanpa mengikat handler pendua.
		$root.data('tblk-inst', inst);

		return inst;
	}

	function bind_events($root) {
		if ($root.data('tblk-bound')) return;
		$root.data('tblk-bound', 1);

		const inst = () => $root.data('tblk-inst');
		const default_open = (name) => frappe.set_route('Form', 'Booking', name);

		// Carian — ENTER sahaja (bukan debounce-on-input: load() menjana
		// semula seluruh root termasuk kotak carian, fokus hilang tengah
		// menaip & user terpaksa klik semula medan untuk sambung).
		// Kosong sahaja (✕ / padam ke kosong) reload serta-merta tanpa
		// Enter — guard st.search kosong elak fetch pendua selepas ✕.
		$root.on('keydown', '.tblk-search', function (ev) {
			if (ev.key === 'Escape') {
				// ESC — kosongkan carian (sama seperti ✕). Reload hanya bila
				// carian LAGI aktif; teks yang belum di-Enter tidak perlu fetch.
				if (this.value === '') return;
				ev.preventDefault();
				const i0 = inst();
				if (!i0) return;
				const applied0 = i0.st.search || '';
				this.value = '';
				$(this).closest('.mba-searchwrap').find('.mba-search-clear').prop('hidden', true);
				if (applied0 !== '') { i0.st.search = ''; i0.load(true); }
				return;
			}
			if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
			ev.preventDefault();
			const i = inst();
			if (!i) return;
			i.st.search = this.value;
			$root.find('.mba-search-clear').prop('hidden', !this.value);
			i.load(true);
		});
		$root.on('input', '.tblk-search', function () {
			const i = inst();
			if (!i || this.value !== '' || i.st.search === '') return;
			i.st.search = '';
			$root.find('.mba-search-clear').prop('hidden', true);
			i.load(true);
		});
		$root.on('click', '.mba-search-clear', function () {
			const i = inst();
			if (!i) return;
			i.st.search = '';
			$(this).prop('hidden', true).closest('.mba-searchwrap').find('.tblk-search').val('');
			i.load(true);
		});

		// Tapisan dropdown (status / payment / currency / group / limit).
		$root.on('change', 'select[data-tblk-kind]', function () {
			const i = inst();
			if (!i) return;
			const kind = $(this).data('tblk-kind');
			const val = $(this).val();
			if (kind === 'limit') i.st.limit = parseInt(val, 10) || 0;
			else i.st[kind] = val;
			i.load(true);
		});

		// ── Panel penapis dinamik (corak mba-cf-* pakej traveller) ──
		// Dilaksanakan server-side melalui get_group_bookings
		// (custom_filters + custom_match).
		const cf_focus_last = (i) => {
			const $rows = i.$root.find('.tblk-cf-row');
			$rows.last().find('.tblk-cf-field-input').trigger('focus');
		};
		$root.on('click', '.tblk-cf-toggle', async function () {
			const i = inst();
			if (!i) return;
			await ensure_cf_fields();
			i.st.cf_open = !i.st.cf_open;
			if (i.st.cf_open && !(i.st.custom || []).length) {
				i.st.custom = [{ doctype: '', fieldname: '', value: '' }];
			}
			i.render();
			if (i.st.cf_open) cf_focus_last(i);
		});
		$root.on('click', '.tblk-cf-add', function () {
			const i = inst();
			if (!i) return;
			i.st.custom = [...(i.st.custom || []), { doctype: '', fieldname: '', value: '' }];
			i.render();
			cf_focus_last(i);
		});
		$root.on('click', '.tblk-cf-del', function () {
			const i = inst();
			const idx = $(this).data('idx');
			if (!i || idx == null) return;
			i.st.custom.splice(idx, 1);
			i.render();
		});
		$root.on('change', '.tblk-cf-field-input', function () {
			const i = inst();
			const idx = $(this).data('idx');
			if (!i || idx == null) return;
			const display = String($(this).val() || '').trim();
			const mChoice = cf_field_choices().find((x) => x.display === display);
			const r = i.st.custom[idx] || (i.st.custom[idx] = {});
			if (!mChoice) {
				// Taapan tak sepadan mana-mana medan — pulih paparan pilihan
				// semasa (bila ada); kosong bila baris belum dipilih.
				$(this).val(cf_display(r));
				return;
			}
			if (mChoice.doctype === r.doctype && mChoice.fieldname === r.fieldname) return;
			r.doctype = mChoice.doctype;
			r.fieldname = mChoice.fieldname;
			r.value = ''; r.min = ''; r.max = '';
			// Re-render — baris tukar bentuk input ikut jenis medan (nilai
			// tunggal vs julat Min–Max nombor vs pilihan Select). Nilai
			// baris lain kekal (disimpan dalam state pada setiap keystroke).
			i.render();
			const $row = i.$root.find(`.tblk-cf-row[data-idx="${idx}"]`);
			if (cf_is_range(r)) $row.find('.tblk-cf-min').trigger('focus');
			else {
				$row.find('.tblk-cf-value').trigger('focus');
				cf_fill_datalist(i, $row);
			}
		});
		$root.on('input', '.tblk-cf-value', function () {
			const i = inst();
			const idx = $(this).data('idx');
			if (!i || idx == null || !i.st.custom[idx]) return;
			i.st.custom[idx].value = $(this).val();
		});
		// Input julat Min–Max (medan nombor/currency/tarikh) — simpan ikut kelas.
		$root.on('input', '.tblk-cf-min, .tblk-cf-max', function () {
			const $in = $(this);
			const i = inst();
			const idx = $in.data('idx');
			if (!i || idx == null || !i.st.custom[idx]) return;
			i.st.custom[idx][$in.hasClass('tblk-cf-min') ? 'min' : 'max'] = $in.val();
		});
		$root.on('keydown', '.tblk-cf-value, .tblk-cf-min, .tblk-cf-max', function (ev) {
			if (ev.key !== 'Enter') return;
			ev.preventDefault();
			const i = inst();
			if (i) i.load(true);
		});
		// Mod gabungan baris AND | OR — kemaskini state + kelas butang terus
		// (tiada re-render supaya nilai yang sedang ditaip kekal).
		$root.on('click', '.tblk-cf-match-btn', function () {
			const $b = $(this);
			const i = inst();
			if (!i) return;
			i.st.cf_match = $b.data('match') === 'OR' ? 'OR' : 'AND';
			$b.closest('.tblk-cf-match').find('.tblk-cf-match-btn').removeClass('active');
			$b.addClass('active');
		});
		$root.on('click', '.tblk-cf-apply', function () {
			const i = inst();
			if (i) i.load(true);
		});
		$root.on('click', '.tblk-cf-clear', function () {
			const i = inst();
			if (!i) return;
			i.st.custom = [];
			i.load(true);
		});

		// ── Sort header jadual — klik tukar kolum, klik lagi tukar arah ──
		$root.on('click', 'th.tblk-sort', function () {
			const i = inst();
			if (!i) return;
			const col = String($(this).data('tblksort') || '');
			if (!col) return;
			if (i.st.sort === col) i.st.sort_dir = i.st.sort_dir === -1 ? 1 : -1;
			else { i.st.sort = col; i.st.sort_dir = 1; }
			i.render();
		});

		// ── Checkbox bulk edit/delete — baris + select-all; butang Bulk Edit
		// & Bulk Delete aktif bila ≥1 baris dipilih (corak pakej traveller).
		// Kad & jadual KEDUA-DUANYA wujud dalam DOM (satu tersembunyi oleh
		// media query) — kiraan/tanda/himpunan NAMA hanya atas checkbox yang
		// KELIHATAN (:visible) supaya 3 baris tidak dikira 6. ──
		const checked_names = () => {
			const i = inst();
			const names = [];
			if (!i) return names;
			i.$root.find('.tblk-checkrow:checked').filter(':visible').each(function () {
				names.push(String($(this).data('booking') || ''));
			});
			return names;
		};
		const update_bulk_state = () => {
			const $checkall = $root.find('.tblk-checkall');
			const $rows = $root.find('.tblk-checkrow').filter(':visible');
			const checked = $rows.filter(':checked').length;
			$checkall.prop('checked', checked > 0 && checked === $rows.length)
				.prop('indeterminate', checked > 0 && checked < $rows.length);
			$root.find('.tblk-bulk-btn').prop('disabled', checked === 0)
				.text(checked ? `${__('Bulk Edit')} (${checked})` : __('Bulk Edit'));
			$root.find('.tblk-bulk-del-btn').prop('disabled', checked === 0);
		};
		$root.on('change', '.tblk-checkrow, .tblk-checkall', function () {
			const $checkall = $root.find('.tblk-checkall');
			if ($(this).is($checkall)) {
				$root.find('.tblk-checkrow').filter(':visible')
					.prop('checked', $checkall.prop('checked'));
			}
			update_bulk_state();
		});

		// ── Bulk Edit — dialog medan (katalog Booking) ──
		$root.on('click', '.tblk-bulk-btn', function () {
			const i = inst();
			if (!i) return;
			const names = checked_names();
			if (!names.length) return;
			open_bulk_dialog(i, names);
		});

		// ── Bulk Delete (icon trash) — sahkan dahulu (destuktif) dengan
		// syarat padam, kemudian api bulk_delete_bookings; server menolak
		// booking bukan Cancelled / belum 24 jam dan memadam dokumen
		// berpaut dahulu; ringkasan deleted/skipped/failed dipapar sebagai
		// alert; senarai dimuat semula. ──
		$root.on('click', '.tblk-bulk-del-btn', function () {
			const i = inst();
			if (!i) return;
			const names = checked_names();
			if (!names.length) return;
			frappe.confirm(
				__('Only bookings with status Cancelled — cancelled more than 24 hours ago — can be deleted. Linked reservations, sales orders and related records will also be removed. Permanently delete {0} selected booking(s)?', [names.length]),
				async () => {
					try {
						const r = await frappe.call({
							method: 'travel_booking.api.manage_trip_booking.bulk_delete_bookings',
							args: { bookings: names },
						});
						const out = r?.message || {};
						frappe.show_alert({
							message: __('{0} deleted, {1} skipped, {2} failed', [
								(out.deleted || []).length, (out.skipped || []).length,
								(out.failed || []).length]),
							indicator: (out.failed || []).length ? 'orange' : 'green',
						});
						i.load(true);
					} catch (e) {
						// frappe.call papar ralat server — keadaan kekal.
					}
				}
			);
		});

		// Load more — tangga limit 10→25→50→100→All.
		$root.on('click', '.tblk-load-more', function () {
			const i = inst();
			if (!i) return;
			const cur = i.st.limit;
			let next = 0;
			if (cur > 0) {
				const idx = ROW_LIMITS.indexOf(cur);
				next = idx >= 0 && idx < ROW_LIMITS.length - 1 ? ROW_LIMITS[idx + 1] : cur + 25;
			}
			i.st.limit = next;
			i.load(true);
		});

		// Icon Message → modal pesanan penuh.
		$root.on('click', '.tblk-msg-btn', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			frappe.msgprint({
				title: $(this).data('title') || __('Customer Message'),
				indicator: 'blue',
				message: `<div class="tblk-msg-body">${esc($(this).data('message') || '')}</div>`,
			});
		});

		// Kolum Booking No / kad (telefon) → buka booking (hook page).
		$root.on('click', 'td.tblk-col-bkopen, .tblk-bkcard', function (ev) {
			if ($(ev.target).closest('a, button, input').length) return;
			const i = inst();
			const b = $(this).data('booking') || $(this).closest('[data-booking]').data('booking');
			if (!i || !b) return;
			ev.stopPropagation();
			(i.opts.on_open_booking || default_open)(b);
		});

		// Baris jadual → hook on_row_click (default = on_open_booking).
		$root.on('click', 'tr.tblk-row', function (ev) {
			if ($(ev.target).closest('a, button, input, .tblk-msg-btn, td.tblk-col-bkopen').length) return;
			const i = inst();
			const b = $(this).data('booking');
			if (!i || !b) return;
			(i.opts.on_row_click || i.opts.on_open_booking || default_open)(b);
		});
	}

	return { create, COLUMNS, PRESETS };
})();
