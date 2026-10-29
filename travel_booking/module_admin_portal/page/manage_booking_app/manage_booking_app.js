// travel_booking/module_admin_portal/page/manage_booking_app/manage_booking_app.js
// Booking Manager — /app/manage-booking-app
//
// Page ganti "manage-booking-group" (page lama TIDAK diubah — berjalan
// selari sehingga tempoh peralihan tamat). Reka bentuk mobile-first,
// progressive disclosure, visual tenang (tanpa emoji, 1 badge utama per
// baris, tiada scroll mendatar pada telefon):
//
// 0. Toolbar senarai — carian tunggal (group/batch/trip/ship, no booking,
//    customer, traveller, stateroom) + chip paparan (All/Upcoming/Past)
//    + panel penapis boleh lipat (status, tahun/bulan, jenis trip,
//    hide passive) + strip jumlah.
// 1. L1 SENARAI Trip Group Date — kad menegak pada telefon, jadual 8
//    kolum pada desktop (≥992px). Klik → L2. Checkbox → Assign Group
//    Batch pukal (kekal).
// 2. L2 DETAIL group/batch — /app/manage-booking-app/group/<name> atau
//    /batch/<batch>. Header padat + baris stat (skrol-x) + 5 TAB:
//      Tab Overview  — KPI 2×2 (Bookings, Revenue, Unpaid, Pending Docs)
//        + baris sekunder (rooms, occupancy, addon) + carta garis masa
//        revenue (penuh lebar) + section "Analytics" boleh lipat
//        (bar mendatar berlabel — menggantikan 8 pie chart lama —
//        + donut chart departure point).
//      Tab Bookings  — kad (telefon) / jadual 8 kolum (desktop); klik → L3.
//      Tab Travellers — kad / jadual + carian + tapisan dokumen.
//      Tab Rooms     — senarai lipat per bilik (details/summary).
//      Tab Flights   — flight rujukan group (dimuatkan lazily).
//      Tab Addons    — Booking Addon (dimuatkan lazily).
// 3. L3 BOOKING INFO — /app/manage-booking-app/booking/<name>. Topbar
//    breadcrumb; telefon = satu lajur (kad identiti + strip wang + tab);
//    desktop = rail sticky kiri. Tab: Overview (Order Summary + timeline
//    dipendekkan), Travellers (kad/jadual + ZIP/XLSX/CSV), Rooms (pakej
//    rooming list get_group_rooming skop booking), Documents (SO/SI/PI +
//    Payment Entries + resit), Add-ons & Flights, Others (diskaun,
//    affiliate, komisen, audit).
//
// CURRENCY-SENSITIVE: disiplin sama dengan page lama — semua nilai wang
// dipapar PER CURRENCY (pecahan *_by_currency daripada backend); nilai
// currency berbeza TIDAK PERNAH dijumlah. Jumlah '≈' default currency
// (kadar Currency Exchange semasa) dipapar bila bercampur currency;
// '+' bila ada currency tanpa kadar.
//
// Backend (guna semula 100%): travel_booking/api/manage_trip_booking.py

frappe.pages['manage-booking-app'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Booking Manager'),
		single_column: true,
	});

	// Lebar page patuh tetapan layout Frappe (User Settings → Layout:
	// Compact / Full Width). Item menu ini shortcut kepada toggle global
	// framework — ia bertindak serta-merta (class body.full-width) dan
	// kekal segerak dengan dialog User Settings; view lain (form,
	// workspace) turut mengikut tetapan yang sama, konsisten satu desk.
	page.add_menu_item(__('Toggle Full Width'), () => {
		frappe.ui.toolbar.toggle_full_width();
	});

	window.ManageBookingApp.init(page, wrapper);
};

frappe.pages['manage-booking-app'].on_page_show = function () {
	if (window.ManageBookingApp) window.ManageBookingApp.on_show();
};

/* ============================================================
   ManageBookingApp — controller (IIFE)
   ============================================================ */
window.ManageBookingApp = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	// Skala carta Revenue Timeline — kekal sepanjang sesi.
	const TL_DEFAULTS = { gran: 'day' };

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

	// Pecahan per-currency [{currency, revenue|gross|...}] →
	// "RM 1,000.00 · S$ 200.00". JANGAN jumlah merentas currency.
	const fmtCurRows = (rows, field) => {
		const list = rows || [];
		if (!list.length) return fmtMoney(0, S.currency);
		return list.map((r) => fmtMoney(r[field], r.currency)).join(' · ');
	};
	const hasBalance = (rows) => (rows || []).some((r) => (r.balance || 0) > 0.009);
	const hasAltCur = (rows) => (rows || []).some((r) => r.currency && r.currency !== S.currency);

// "≈ RM 82,010.00" — jumlah bersamaan default currency; '+' bila ada
// currency tanpa kadar tukaran (jumlah tidak lengkap).
const fmtDefaultTotal = (tot, field) => {
	if (!tot || tot[field] == null) return '';
	return '≈ ' + fmtMoney(tot[field], tot.currency || S.currency)
		+ (tot.rates_complete === false ? '+' : '');
};

// Sub-line berlabel "MYR: RM 1,000.00" — pecahan native satu currency
// (kolum Revenue/Collection). TIDAK dipapar bila baris itu TUNGGAL dan
// sama dengan default currency (nilai utama sel sudah memaparkannya)
// atau nilainya sifar.
const cur_sub_line = (a, cur, field) => {
	const rows = a.by_cur || [];
	const row = rows.find((r) => r.currency === cur);
	if (!row) return '';
	if (rows.length === 1 && cur === S.currency) return '';
	const v = row[field] || 0;
	if (v <= 0.009) return '';
	return cur + ': ' + fmtMoney(v, cur);
};

	// Warna badge mengikut states doctype
	const GROUP_STATUS_COLORS = {
		'Active': 'blue', 'Pending Review': 'yellow', 'Running': 'orange',
		'Sailing': 'cyan', 'Fulled': 'cyan', 'Full': 'cyan', 'Closed': 'gray',
		'Completed': 'green', 'Cancelled': 'red',
	};
	const BOOKING_STATUS_COLORS = {
		'Pending': 'yellow', 'Accepted': 'blue', 'Processing': 'orange',
		'Confirmed': 'green', 'Completed': 'green', 'Abandoned': 'gray',
		'Cancelled': 'red',
	};
	const PAYMENT_STATUS_COLORS = {
		'Pending': 'orange', 'Partially Paid': 'blue', 'Paid': 'green',
		'Request Refund': 'yellow', 'Pending Refund': 'yellow', 'Refunded': 'gray',
	};
	const ADDON_STATUS_COLORS = { 'Pending': 'yellow', 'Confirmed': 'green', 'Cancelled': 'red' };
	const FLIGHT_STATUS_COLORS = { 'Open': 'blue', 'Full': 'orange', 'Closed': 'gray', 'Completed': 'green' };
	const DOC_STATUS_COLORS = {
		'Incomplete': 'orange', 'Pending': 'orange', 'Open for Update': 'yellow', 'Expired': 'red',
		'Pending Verification': 'blue', 'Verified': 'green', 'Expired': 'red',
	};
	const RES_STATUS_COLORS = {
		'Waiting Document': 'yellow', 'Document Completed': 'green',
		'Document Expired': 'red', 'Preparation Complete': 'blue',
		'Trip OnProgress': 'orange', 'Completed': 'gray', 'Cancelled': 'red',
	};
	// Status doctype Booking (panel Booking modal) — cermin DF.Literal
	// booking.json; warna badge paparan butang status.
	const BOOK_STATUS_COLORS = {
		'Pending': 'yellow', 'Accepted': 'green', 'Processing': 'blue',
		'Confirmed': 'cyan', 'Completed': 'gray', 'Abandoned': 'orange',
		'Cancelled': 'red',
	};
	// Opsyen status butang tukar status panel — cermin doctype Booking &
	// Booking Reservation (senarai endpoint server). BOOKING_STATUS_OPTIONS
	// sedia ada (atas, filter) — dialog status langkau opsyen kosong.
	const RESERVATION_STATUS_OPTIONS = ['Waiting Document', 'Document Completed',
		'Document Expired', 'Preparation Completed', 'Trip On Progress',
		'Completed', 'Cancelled'];
	const AGE_BUCKET_COLORS = { 'Infant': 'violet', 'Child': 'cyan', 'Adult': 'blue', 'Unknown': 'gray' };
	const COMMISSION_STATUS_COLORS = {
		'Pending': 'yellow', 'Invoiced': 'blue', 'Approved': 'cyan',
		'Paid': 'green', 'Denied': 'red',
	};
	const SO_STATUS_COLORS = {
		'To Deliver and Bill': 'blue', 'To Deliver': 'blue', 'To Bill': 'blue',
		'To Pay': 'orange', 'Completed': 'green', 'Closed': 'gray',
		'Cancelled': 'red', 'On Hold': 'yellow', 'Draft': 'orange',
	};
	const DOCSTATUS_META = { 0: { label: 'Draft', color: 'orange' }, 2: { label: 'Cancelled', color: 'red' } };
	const PE_STATUS_META = { 0: { label: 'Pending', color: 'orange' }, 1: { label: 'Verified', color: 'green' }, 2: { label: 'Cancelled', color: 'red' } };
	const DOC_STATUS_OK = ['Verified'];

	const badge = (label, color) =>
		label ? `<span class="mba-badge mba-badge--${color || 'gray'}">${esc(label)}</span>` : '';

	const docstatus_badge = (docstatus) => {
		const m = DOCSTATUS_META[docstatus];
		return m ? badge(__(m.label), m.color) : '';
	};

	// Pesanan khas customer — icon bila ada mesej; klik buka modal penuh.
	const msg_btn = (message, title) => {
		if (!message) return '';
		return `<button type="button" class="btn btn-link mba-msg-btn"
			title="${esc(message)}" data-message="${esc(message)}"
			data-title="${esc(title || __('Customer Message'))}"
			aria-label="${__('View customer message')}">
			${frappe.utils.icon('message-square', 'sm')}</button>`;
	};

	const show_message_dialog = (title, message) => {
		frappe.msgprint({
			title: title,
			indicator: 'blue',
			message: `<div class="mba-msg-body">${esc(message || '')}</div>`,
		});
	};

	// Penonton fail pantas — modal img / iframe + muat turun.
	const show_file_viewer = (file_name, url, is_image) => {
		const body = is_image
			? `<img class="mba-file-media" src="${esc(url)}" alt="${esc(file_name)}"/>`
			: `<iframe class="mba-file-frame" src="${esc(url)}" title="${esc(file_name)}"></iframe>`;
		const d = new frappe.ui.Dialog({ title: file_name || __('Attachment'), size: 'extra-large' });
		d.$body.html(`
			<div class="mba-file-viewer">
				${body}
				<div class="mba-file-actions">
					<a class="btn btn-default btn-sm" href="${esc(url)}" download>⬇ ${__('Download')}</a>
					<a class="btn btn-default btn-sm" href="${esc(url)}" target="_blank" rel="noopener">${__('Open in new tab')}</a>
				</div>
			</div>`);
		d.show();
	};

	// Butang Call & WhatsApp (wa.me) untuk satu nombor telefon — piawai
	// seluruh page: ikon + teks kecil (11px), jajar kanan pada kontena
	// aksi (.mba-bkg-cust-actions / .mba-bkg-card-*-actions).
	const call_wa_btns = (phone) => {
		const telRaw = String(phone || '').replace(/[^\d+]/g, '');
		const digits = telRaw.replace(/\D/g, '');
		const callLink = telRaw
			? `<a class="mba-quickbtn" href="tel:${esc(telRaw)}" title="${esc(__('Call customer'))}">${frappe.utils.icon('phone', 'xs')}<span>${__('Call')}</span></a>` : '';
		const waLink = digits
			? `<a class="mba-quickbtn mba-quickbtn--wa" href="https://wa.me/${esc(digits.startsWith('0') ? '6' + digits : digits)}"
					target="_blank" rel="noopener" title="${esc(__('Open WhatsApp message in a new tab'))}">${frappe.utils.icon('message-circle', 'xs')}<span>${__('WhatsApp')}</span></a>` : '';
		return callLink + waLink;
	};

	// Ikon padat sebelah no. telefon (jadual) — panggilan (tel:) & chat
	// WhatsApp (wa.me, tab baharu). Normalisasi nombor sama dengan di atas.
	// Wrapper .mba-contact-acts mendorong ikon ke kanan baris telefon
	// (.mba-contact-line) — piawai di semua jadual page ini.
	const contact_icons = (phone) => {
		const telRaw = String(phone || '').replace(/[^\d+]/g, '');
		const digits = telRaw.replace(/\D/g, '');
		if (!digits) return '';
		return `<span class="mba-contact-acts"><a class="mba-contact-icon" href="tel:${esc(telRaw)}" target="_blank" rel="noopener"
				title="${esc(__('Phone call'))}" aria-label="${esc(__('Phone call'))}">${frappe.utils.icon('phone', 'xs')}</a><a
				class="mba-contact-icon mba-contact-icon--wa" href="https://wa.me/${esc(digits.startsWith('0') ? '6' + digits : digits)}"
				target="_blank" rel="noopener" title="${esc(__('WhatsApp chat'))}" aria-label="${esc(__('WhatsApp chat'))}">${frappe.utils.icon('message-circle', 'xs')}</a></span>`;
	};

	const GROUP_STATUS_OPTIONS = [
		'', 'Pending Review', 'Active', 'Running', 'Sailing', 'Fulled', 'Closed',
		'Completed', 'Cancelled',
	];
	const BOOKING_STATUS_OPTIONS = [
		'', 'Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed',
		'Abandoned', 'Cancelled',
	];
	const PAYMENT_STATUS_OPTIONS = [
		'', 'Pending', 'Partially Paid', 'Paid', 'Request Refund',
		'Pending Refund', 'Refunded',
	];
	const ADDON_STATUS_OPTIONS = ['', 'Pending', 'Confirmed', 'Cancelled'];
	const ADDON_PAYMENT_OPTIONS = ['', 'Pending', 'Partially Paid', 'Paid'];

	// Susunan logik Doc Status untuk sort (bukan abjad).
	const DOC_STATUS_RANK = { 'Incomplete': 0, 'Pending': 0, 'Pending Verification': 1, 'Open for Update': 2, 'Expired': 3, 'Verified': 4 };

	// Pilihan sort tab Travellers (L2 & L3) — kunci header jadual & dropdown.
	const TV_SORTS = {
		// name — slot TANPA rekod Traveller dipapar guna guest_label
		// ("Traveller 1") & traveller_name "-" (placeholder) — nilai "-"
		// DINORMALISASI kosong, kalau tidak semua slot guest mendapat nilai
		// sort sama & kekal kedudukan asal (nampak macam sort tak berfungsi).
		name: {
			label: 'Traveller Name',
			val: (t) => {
				const n = t.traveller ? t.traveller_name
					: (t.guest_label || t.traveller_name);
				return (n && n !== '-' ? n : '').toLowerCase();
			},
		},
		booking: { label: 'Booking', val: (t) => (t.booking_number || t.booking || '').toLowerCase() },
		age: { label: 'Age', val: (t) => (t.age == null ? -1 : t.age) },
		dob: { label: 'Date of Birth', val: (t) => (t.dob || '') },
		agecat: { label: 'Age Category', val: (t) => (t.age_category || t.age_bucket || '').toLowerCase() },
		gender: { label: 'Gender', val: (t) => (t.gender || '').toLowerCase() },
		nationality: { label: 'Nationality', val: (t) => (t.nationality || '').toLowerCase() },
		passport: { label: 'Passport No.', val: (t) => (t.passport_no || '').toLowerCase() },
		ic: { label: 'IC No.', val: (t) => (t.ic_number || '').toLowerCase() },
		email: { label: 'Email', val: (t) => (t.email || '').toLowerCase() },
		phone: { label: 'Phone', val: (t) => (t.phone || '').toLowerCase() },
		doc: { label: 'Doc Status', val: (t) => DOC_STATUS_RANK[t.document_status] ?? 9 },
		room: { label: 'Room', val: (t) => (t.room_id || '').toLowerCase() },
		roomcat: { label: 'Room Category', val: (t) => (t.room_category || '').toLowerCase() },
	};

	const TRAVELLER_STATUS_OPTIONS = ['Incomplete', 'Pending Verification',
		'Verified', 'Open for Update', 'Expired'];

	const ROW_LIMITS = [10, 25, 50, 100, 0];
	const DEFAULT_LIMIT = 10;

	// Tab L2 (detail group/batch)
	const TABS = [
		{ id: 'overview', label: __('Overview') },
		{ id: 'booking', label: __('Bookings') },
		{ id: 'traveller', label: __('Travellers') },
		{ id: 'rooming', label: __('Rooms') },
		{ id: 'flights', label: __('Flights') },
		{ id: 'addons', label: __('Addons') },
	];
	// Tab L3 (booking info)
	const BKG_TABS = [
		{ id: 'ov', label: __('Overview') },
		{ id: 'tv', label: __('Travellers') },
		{ id: 'rm', label: __('Rooms') },
		{ id: 'doc', label: __('Documents') },
		{ id: 'af', label: __('Add-ons & Flights') },
		{ id: 'other', label: __('Others') },
	];

	// Peta tab → kekunci state (bk/ad/tv/rm/fl)
	const TAB_STATE_KEY = { booking: 'bk', addons: 'ad', traveller: 'tv', rooming: 'rm', flights: 'fl' };
	const SCOPE_TAB = { bk: 'booking', ad: 'addons', tv: 'traveller', rm: 'rooming', fl: 'flights' };

	const S = {
		page: null,
		wrapper: null,
		filters: { search: '', view: 'all', status: '', mFrom: '', mTo: '', collMin: 0, collMax: 100, gtype: 'all', hidePassive: true, panelOpen: false },
		archived: false,       // paparan arkib penuh (permintaan user)
		monthDomain: [],       // bulan (YYYY-MM) unik group termuat — domain slider
		sort: { key: '', dir: 1 },  // susunan jadual L1 ('' = susunan server)
		groups: [],
		items: [],
		currency: 'MYR',
		mode: 'list',          // 'list' | 'detail' | 'booking'
		detail: null,
		cache: {},             // { itemKey: { dashboard, bookings, addons, travellers, rooming, flights, profile } }
		state: {},             // { itemKey: { tab, bk{}, ad{}, tv{}, rm{}, fl{} } }
		tvFields: null,        // medan penapis dinamik tab Travellers (cache sekali)
		tvFieldsPromise: null,
		tvAllJobs: {},         // { itemKey: Promise } — muat traveller penuh pecahan DOB
		batchSel: new Set(),
		loading: false,
		tl: { ...TL_DEFAULTS },
		tlAll: false,          // L3 timeline — tunjuk semua peristiwa
	};

	/* ---------- API helper ---------- */
	const api = (method, args = {}) =>
		new Promise((resolve, reject) => {
			frappe.call({
				method: 'travel_booking.api.manage_trip_booking.' + method,
				args,
				freeze: false,
			})
				.then((r) => resolve(r?.message ?? null))
				.catch((err) => {
					console.error('ManageBookingApp API Error:', method, err);
					frappe.show_alert({ message: __('Error loading data'), indicator: 'red' }, 5);
					reject(err);
				});
		});

	const debounce = (fn, ms) => {
		let t;
		return function (...a) {
			const ctx = this;
			clearTimeout(t);
			t = setTimeout(() => fn.apply(ctx, a), ms);
		};
	};

	const round2 = (n) => Math.round((n || 0) * 100) / 100;
	const isDesktop = () => window.innerWidth >= 992;

	/* ========== INITIALIZATION ========== */

	function init(page, wrapper) {
		S.page = page;
		S.wrapper = wrapper;
		build_layout();
		bind_toolbar();
		bind_events();
		// Desktop — panel penapis terbuka secara default.
		if (isDesktop()) {
			S.filters.panelOpen = true;
			$(S.wrapper).find('#mba-filter-panel').addClass('open');
		}
		route_apply();
	}

	function on_show() {
		route_apply();
	}

	/* ========== ROUTE: senarai ↔ detail group/batch ↔ booking ========== */

	function route_apply() {
		const r = frappe.get_route() || [];
		if (r[1] === 'booking' && r[2]) {
			show_booking(r[2]);
		} else if ((r[1] === 'group' || r[1] === 'batch') && r[2]) {
			show_detail(r[1], r[2]);
		} else if (r[1] === 'rooming' && r[2] && r[3]) {
			show_rooming(r[2], r[3]);   // /rooming/<group|batch>/<id>
		} else {
			show_list();
		}
	}

	// Rooming Board sebagai VIEW PENUH (bukan modal) — route
	// /app/manage-booking-app/rooming/<kind>/<id>. Corak sama show_detail:
	// resolve item (deep-link disokong), muat data rooming, render board.
	async function show_rooming(kind, id) {
		const key = (kind === 'batch' ? 'batch:' : 'grp:') + id;
		S.mode = 'rooming';
		S.detail = { kind, id, key, loading: true, rendered: false };
		$('#mba-list-wrap').hide();
		$('#mba-detail').show().html(`<div class="mba-loading">${__('Loading...')}</div>`);

		const it = await resolve_item(kind, id, key);
		if (!S.detail || S.detail.key !== key || S.mode !== 'rooming') return;
		if (!it) {
			$('#mba-detail').html(`
				<div class="mba-empty">
					<p>${__('Trip Group Date {0} not found.', [esc(id)])}</p>
					<button class="btn btn-default btn-sm mba-back-btn">${__('← All Groups')}</button>
				</div>`);
			return;
		}
		S.detail.loading = false;
		S.detail.rendered = true;
		S.detail.item = it;
		open_rooming_board(key);
	}

	function show_list() {
		S.mode = 'list';
		S.detail = null;
		$('#mba-detail').hide().empty();
		$('#mba-list-wrap').show();
		if (S.items.length) load(true);   // balik semula ke senarai — refresh
		else load();
	}

	function show_detail(kind, id) {
		const key = (kind === 'batch' ? 'batch:' : 'grp:') + id;
		if (S.mode === 'detail' && S.detail && S.detail.key === key
			&& (S.detail.loading || S.detail.rendered)) return;

		S.mode = 'detail';
		S.detail = { kind, id, key, loading: true, rendered: false };
		$('#mba-list-wrap').hide();
		$('#mba-detail').show().html(`<div class="mba-loading">${__('Loading...')}</div>`);

		resolve_item(kind, id, key).then((it) => {
			if (!S.detail || S.detail.key !== key || S.mode !== 'detail') return;
			S.detail.loading = false;
			S.detail.rendered = true;
			S.detail.item = it;
			if (!it) {
				$('#mba-detail').html(`
					<div class="mba-empty">
						<p>${__('Trip Group Date {0} not found.', [esc(id)])}</p>
						<button class="btn btn-default btn-sm mba-back-btn">${__('← All Groups')}</button>
					</div>`);
				return;
			}
			render_detail(it);
			ensure_tab_loaded(key);
		});
	}

	// Cari item (group/batch) — daripada senarai; kalau tak ada (deep-link
	// atau di luar filter semasa), fetch carian server.
	async function resolve_item(kind, id, key) {
		const found = find_item(key);
		if (found) return found;

		const pick = (groups) => (kind === 'batch'
			? groups.filter((g) => (g.group_batch || '').trim() === id)
			: groups.filter((g) => g.name === id));
		try {
			// Deep-link — muat TANPA pengecualian arkib supaya group
			// terarkib lama pun boleh dibuka terus dari URL.
			const data = await api('get_trip_groups', { search: id, archived: 1 });
			S.currency = data?.currency || S.currency;
			let groups = pick(data?.groups || []);
			if (!groups.length) {
				const all = await api('get_trip_groups', { archived: 1 });
				S.currency = all?.currency || S.currency;
				groups = pick(all?.groups || []);
			}
			if (!groups.length) return null;
			const it = { key, batch: kind === 'batch' ? id : '', members: groups, agg: null };
			it.agg = item_agg(it);
			return it;
		} catch (e) {
			return null;
		}
	}

	// Route /booking/<name> — sentiasa fetch semula (tiada cache): status
	// payment/invois berubah cepat; payload ringan (satu booking).
	function show_booking(name) {
		const key = 'bkg:' + name;
		if (S.mode === 'booking' && S.detail && S.detail.key === key
			&& (S.detail.loading || S.detail.rendered)) return;

		S.mode = 'booking';
		S.tlAll = false;
		S.detail = { kind: 'booking', id: name, key, loading: true, rendered: false };
		$('#mba-list-wrap').hide();
		$('#mba-detail').show().html(`<div class="mba-loading">${__('Loading...')}</div>`);

		api('get_booking_profile', { booking: name }).then((d) => {
			if (!S.detail || S.detail.key !== key || S.mode !== 'booking') return;
			S.detail.loading = false;
			S.detail.rendered = true;
			if (!d || !d.profile) {
				$('#mba-detail').html(`
					<div class="mba-empty">
						<p>${__('Booking {0} not found.', [esc(name)])}</p>
						<button class="btn btn-default btn-sm mba-back-btn">${__('← All Groups')}</button>
					</div>`);
				return;
			}
			render_booking(key, d);
		}).catch(() => {
			if (!S.detail || S.detail.key !== key || S.mode !== 'booking') return;
			S.detail.loading = false;
			$('#mba-detail').html(`
				<div class="mba-empty">
					<p>${__('Error loading booking info.')}</p>
					<button class="btn btn-default btn-sm mba-back-btn">${__('← All Groups')}</button>
				</div>`);
		});
	}

	/* ========== LAYOUT ========== */

	function build_layout() {
		const statusOpts = GROUP_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}">${esc(o || 'All Status')}</option>`).join('');

		$(S.wrapper).find('.layout-main-section').html(`
			<div class="mba-app">
				<div id="mba-list-wrap">
					<div class="mba-toolbar">
						<div class="mba-search-row">
							<div class="mba-search-box">
								${TravelBookingSearchBox.html({
									cls: 'mba-search-input',
									attrs: { id: 'mba-search' },
									placeholder: __('Search group / trip / booking / customer / traveller...'),
								})}
							</div>
							<button type="button" class="btn btn-default btn-sm mba-filter-btn" id="mba-filter-btn">
								${__('Filters')} <span class="mba-filter-count" id="mba-filter-count"></span>
							</button>
						</div>
						<div class="mba-chip-row" id="mba-view-chips">
							<button type="button" class="mba-chip active" data-view="all">${__('All')}</button>
							<button type="button" class="mba-chip" data-view="upcoming">${__('Upcoming')}</button>
							<button type="button" class="mba-chip" data-view="past">${__('Past')}</button>
							<button type="button" class="mba-arch-link" id="mba-arch-link"
								title="${__('Archived = Completed & Cancelled trips')}">${__('View Archived')}</button>
						</div>
						<div class="mba-filter-panel" id="mba-filter-panel">
						<div class="mba-filter-grid">
							<label class="mba-field"><span>${__('Trip Type')}</span>
								<select id="mba-gtype" title="${__('Filter by trip type')}">
									<option value="all">${__('All Groups')}</option>
									<option value="cruise">${__('Cruise')}</option>
									<option value="non-cruise">${__('Non-Cruise')}</option>
								</select></label>
							<label class="mba-field"><span>${__('Status')}</span>
								<select id="mba-status">${statusOpts}</select></label>
							<div class="mba-field mba-field--range">
								<span>${__('Time Range')}</span>
								<div class="mba-range" id="mba-range">
									<div class="mba-range-track"><div class="mba-range-fill" id="mba-range-fill"></div></div>
									<input type="range" class="mba-range-input" id="mba-range-start" min="0" max="0" value="0" step="1"
										aria-label="${__('From month')}" title="${__('Departure / sailing month — from')}"/>
									<input type="range" class="mba-range-input" id="mba-range-end" min="0" max="0" value="0" step="1"
										aria-label="${__('To month')}" title="${__('Departure / sailing month — to')}"/>
								</div>
								<div class="mba-range-labels">
									<span id="mba-range-from">${__('All Time')}</span>
									<span id="mba-range-to"></span>
								</div>
							</div>
							<div class="mba-field mba-field--range">
								<span>${__('Collection Progress')}</span>
								<div class="mba-range" id="mba-coll-range">
									<div class="mba-range-track"><div class="mba-range-fill" id="mba-coll-fill"></div></div>
									<input type="range" class="mba-range-input" id="mba-coll-start" min="0" max="100" value="0" step="1"
										aria-label="${__('Minimum collected')}" title="${__('% of revenue collected — from')}"/>
									<input type="range" class="mba-range-input" id="mba-coll-end" min="0" max="100" value="100" step="1"
										aria-label="${__('Maximum collected')}" title="${__('% of revenue collected — to')}"/>
								</div>
								<div class="mba-range-labels">
									<span id="mba-coll-from">${__('All')}</span>
									<span id="mba-coll-to"></span>
								</div>
							</div>
							<label class="mba-field mba-field--check">
								<input type="checkbox" id="mba-hide-passive" ${S.filters.hidePassive ? 'checked' : ''}/>
								<span>${__('Hide Passive Group')}</span></label>
							<button type="button" class="btn btn-default btn-sm" id="mba-filter-reset">${__('Reset')}</button>
						</div>
						</div>
					</div>
					<div class="mba-summary-row">
						<div id="mba-summary" class="mba-summary"></div>
						<button class="btn btn-primary btn-xs" id="mba-assign-batch" disabled>${__('Assign Group Batch')}</button>
					</div>
					<div id="mba-list"></div>
				</div>
				<div id="mba-detail" style="display:none"></div>
			</div>`);
	}

	function bind_toolbar() {
		const $w = $(S.wrapper);

		$w.find('#mba-search').on('input', debounce(function () {
			S.filters.search = $(this).val();
			load();
		}, 350));

		$w.find('#mba-view-chips').on('click', '.mba-chip', function () {
			const v = $(this).data('view');
			if (S.filters.view === v) return;
			S.filters.view = v;
			$w.find('#mba-view-chips .mba-chip').removeClass('active').filter(`[data-view="${v}"]`).addClass('active');
			load();
		});

		// Paparan arkib — atas permintaan user sahaja; senarai default
		// tidak memuatkan group Completed/Cancelled (kecuali arkib baru
		// tahun semasa) demi mengurangkan beban DB.
		$w.find('#mba-arch-link').on('click', () => {
			S.archived = !S.archived;
			update_arch_link();
			load(true);
		});

		// Panel penapis — buka/tutup; bilangan penapis aktif pada butang.
		$w.find('#mba-filter-btn').on('click', () => {
			S.filters.panelOpen = !S.filters.panelOpen;
			$w.find('#mba-filter-panel').toggleClass('open', S.filters.panelOpen);
		});

		// Penapis server-side — refetch. Sisanya client-side render semula.
		$w.find('#mba-status').on('change', function () {
			S.filters.status = $(this).val();
			load();
		});

		// Slider julat masa (bulan pergi) — 'input' kemaskini fill/label
		// serta-merta; penapisan & render semula pada 'change' (handle
		// dilepaskan), supaya drag tak memecat render berulang kali.
		$w.find('#mba-range-start')
			.on('input', function () {
				const $e = $w.find('#mba-range-end');
				if (parseInt(this.value, 10) > parseInt($e.val(), 10)) this.value = $e.val();
				sync_range_ui();
			})
			.on('change', function () {
				const dom = S.monthDomain;
				const v = parseInt(this.value, 10) || 0;
				S.filters.mFrom = (dom.length && v > 0) ? dom[v] : '';
				refresh_client_filters();
			});
		$w.find('#mba-range-end')
			.on('input', function () {
				const $s = $w.find('#mba-range-start');
				if (parseInt(this.value, 10) < parseInt($s.val(), 10)) this.value = $s.val();
				sync_range_ui();
			})
			.on('change', function () {
				const dom = S.monthDomain;
				const v = parseInt(this.value, 10) || 0;
				S.filters.mTo = (dom.length && v < dom.length - 1) ? dom[v] : '';
				refresh_client_filters();
			});

		// Slider Collection Progress — % terkutuk (0–100). 'input' live,
		// penapisan pada 'change'. Baca KEDUA-dua handle pada setiap change
		// (satu tarikan mengemas kini satu input sahaja).
		const coll_apply = () => {
			let a = parseInt($w.find('#mba-coll-start').val(), 10) || 0;
			let b = parseInt($w.find('#mba-coll-end').val(), 10);
			if (Number.isNaN(b)) b = 100;
			if (b < a) b = a;
			S.filters.collMin = a;
			S.filters.collMax = b;
			refresh_client_filters();
		};
		$w.find('#mba-coll-start')
			.on('input', function () {
				const $e = $w.find('#mba-coll-end');
				if (parseInt(this.value, 10) > parseInt($e.val(), 10)) this.value = $e.val();
				sync_coll_ui();
			})
			.on('change', coll_apply);
		$w.find('#mba-coll-end')
			.on('input', function () {
				const $s = $w.find('#mba-coll-start');
				if (parseInt(this.value, 10) < parseInt($s.val(), 10)) this.value = $s.val();
				sync_coll_ui();
			})
			.on('change', coll_apply);

		$w.find('#mba-gtype').on('change', function () {
			S.filters.gtype = $(this).val();
			refresh_client_filters();
		});

		$w.find('#mba-hide-passive').on('change', function () {
			S.filters.hidePassive = this.checked;
			refresh_client_filters();
		});

		$w.find('#mba-filter-reset').on('click', () => {
			S.filters.status = '';
			S.filters.mFrom = '';
			S.filters.mTo = '';
			S.filters.collMin = 0;
			S.filters.collMax = 100;
			S.filters.gtype = 'all';
			S.filters.hidePassive = false;
			$w.find('#mba-status').val('');
			$w.find('#mba-range-start').val(0);
			$w.find('#mba-range-end').val(String(Math.max(0, S.monthDomain.length - 1)));
			sync_range_ui();
			$w.find('#mba-coll-start').val(0);
			$w.find('#mba-coll-end').val(100);
			sync_coll_ui();
			$w.find('#mba-gtype').val('all');
			$w.find('#mba-hide-passive').prop('checked', false);
			sync_filter_count();
			load();
		});

		$w.find('#mba-assign-batch').on('click', () => open_batch_dialog());
	}

	// Penapis client-side (tahun/bulan/jenis/hide passive) — render semula
	// terus daripada senarai sedia ada (tiada refetch).
	function refresh_client_filters() {
		sync_filter_count();
		S.items = build_items(S.groups);
		render_items();
	}

	function sync_filter_count() {
		let n = 0;
		if (S.filters.status) n++;
		if (S.filters.mFrom || S.filters.mTo) n++;
		if (S.filters.collMin > 0 || S.filters.collMax < 100) n++;
		if (S.filters.gtype !== 'all') n++;
		if (S.filters.hidePassive) n++;
		$('#mba-filter-count').text(n ? '(' + n + ')' : '');
	}

	/* Event delegation atas root — element selalu di-render semula. */
	function bind_events() {
		const $w = $(S.wrapper);

		// Paparan senarai (L1)
		$w.find('#mba-list').on('click', '.mba-card-click, tr.mba-group-row', function (ev) {
			if ($(ev.target).closest('a, button, input, select, .mba-msg-btn').length) return;
			open_item($(this).closest('.mba-group').data('item'));
		});

		// Sort jadual L1 — klik header tukar kunci/arah (asc dulu, klik
		// lagi turun); render semula terus daripada S.items sedia ada.
		$w.find('#mba-list').on('click', '.mba-groups-table thead th.mba-sortable', function () {
			const key = $(this).data('sort');
			if (!key) return;
			if (S.sort.key === key) S.sort.dir = -S.sort.dir;
			else { S.sort.key = key; S.sort.dir = 1; }
			render_items();
		});

		$w.find('#mba-list').on('change', '.mba-sel-group', function () {
			const it = find_item($(this).closest('.mba-group').data('item'));
			if (!it) return;
			const names = it.members.map((m) => m.name);
			if ($(this).is(':checked')) names.forEach((n) => S.batchSel.add(n));
			else names.forEach((n) => S.batchSel.delete(n));
			sync_row_checks();
			update_batch_button();
		});

		// Paparan detail (L2 + L3) — delegation
		const $d = $w.find('#mba-detail');

		$d.on('click', '.mba-back-btn', () => frappe.set_route('manage-booking-app'));
		$d.on('click', '.mba-back-group-btn', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('manage-booking-app', 'group', g);
			else frappe.set_route('manage-booking-app');
		});
		$d.on('click', '.mba-back-batch-btn', function () {
			const b = $(this).data('batch');
			if (b) frappe.set_route('manage-booking-app', 'batch', b);
			else frappe.set_route('manage-booking-app');
		});
		$d.on('click', '.mba-paylink-btn', function (ev) {
			ev.preventDefault();
			const b = $(this).data('booking');
			if (b) open_payment_link_dialog(b);
		});
		$d.on('click', '.mba-open-form', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('Form', 'Trip Group Date', g);
		});
		// Pintasan Rooming Board dari tab Rooms L3 (booking) — route
		// penuh papan susun atur group/batch booking itu.
		$d.on('click', '.mba-rb-open-bkg', function () {
			const kind = $(this).data('kind') === 'batch' ? 'batch' : 'group';
			const id = $(this).data('group');
			if (id) frappe.set_route('manage-booking-app', 'rooming', kind, id);
		});
		// Prev/Next — ke group sebelum/sesudah; sentiasa peringkat group
		// (detail group), bukan batch.
		$d.on('click', '.mba-nav-prev, .mba-nav-next', function () {
			const g = $(this).data('group');
			if (!g || this.disabled) return;
			window.scrollTo(0, 0);
			frappe.set_route('manage-booking-app', 'group', g);
		});
		$d.on('click', '.mba-rename-batch', function () {
			rename_batch_dialog($(this).closest('.mba-group').data('item'));
		});
		$d.on('click', '.mba-member-chip', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('manage-booking-app', 'group', g);
		});
		$d.on('click', '.mba-trip-preview', function (ev) {
			ev.preventDefault();
			show_trip_preview(this.getAttribute('href'), this.textContent.trim());
		});

		// Tab — L2 (fetch) & L3 (paparan sahaja)
		$d.on('click', '.mba-tab', function () {
			const key = $(this).closest('.mba-group').data('item');
			switch_tab(key, $(this).data('tab'));
		});

		// Carta timeline — tukar skala, lukis semula dari cache.
		$d.on('change', '.mba-tl-select', function () {
			S.tl.gran = this.value;
			const key = $(this).closest('.mba-group').data('item');
			const d = S.cache[key]?.dashboard;
			const $chart = $(this).closest('.mba-panel').find('[data-chart="rev-tl"]');
			if (d && $chart.length) render_tl_chart($chart, d.revenue_timeline || {});
		});

		// Analytics/Timeline — redraw bila <details> dibuka dikendalikan
		// listener native dalam render_overview() (toggle tak bubble, jadi
		// delegation jQuery tak dipakai).
		// L3 timeline — tunjuk semua / ringkas.
		$d.on('click', '.mba-tl-toggle', function () {
			S.tlAll = !S.tlAll;
			const key = $(this).closest('.mba-group').data('item');
			if (S.cache[key]) render_bkg_overview(key);
		});

		// Tapisan jenis dokumen (L3 Documents) — chip menapis pane sama.
		$d.on('click', '.mba-doc-filter', function () {
			const $chip = $(this);
			const $pane = $chip.closest('.mba-tab-pane');
			$pane.find('.mba-doc-filter').removeClass('active');
			$chip.addClass('active');
			const f = $chip.data('filter');
			$pane.find('.mba-docrow').each(function () {
				$(this).toggle(f === 'all' || $(this).data('type') === f);
			});
		});

		// Carian traveller (L3 + L2) — tapis kad & baris di pihak klien.
		$d.on('input', '.mba-tv-search', debounce(function () {
			const q = String($(this).val() || '').toLowerCase().trim();
			const tvst = S.state[$(this).closest('.mba-group').data('item')]?.tv;
			if (tvst) tvst.__q = q;
			$(this).closest('.mba-tab-pane').find('[data-hay]').each(function () {
				$(this).toggle(!q || String($(this).data('hay') || '').includes(q));
			});
		}, 200));

		// Butang ✕ kotak carian — DIURUSKAN oleh pakej standard
		// TravelBookingSearchBox (auto-bind document): taip → tampak,
		// klik ✕ → kosongkan + trigger 'input' + fokus. Kotak carian
		// client-side (.mba-tv-search) & server (data-search) sama-sama
		// menerima 'input' melalui mekanisme yang sama.

		// Grid ⇄ Table (L3 Travellers) — pilihan paparan dikekalkan.
		$d.on('click', '.mba-tv-view', function () {
			const $btn = $(this);
			const v = $btn.data('view');
			const $pane = $btn.closest('.mba-tab-pane');
			const tvst = S.state[$btn.closest('.mba-group').data('item')]?.tv;
			if (tvst) tvst.view = v;
			$pane.find('.mba-tv-view').removeClass('active');
			$btn.addClass('active');
			$pane.find('.mba-tv-grid').toggle(v === 'grid');
			$pane.find('.mba-tv-tablewrap').toggle(v === 'table');
		});

		// Sort Travellers — klik header jadual (klik lagi tukar arah) ATAU
		// komponen Order By di toolbar; kedua-dua set state yang sama.
		// Re-render melalui callback pakej pada pane (guna di L3 & L2).
		$d.on('click', 'th.mba-tv-sort', function () {
			const $th = $(this);
			const $pane = $th.closest('.mba-tab-pane');
			const key = $th.closest('.mba-group').data('item');
			const tvst = S.state[key]?.tv;
			if (!tvst) return;
			const col = String($th.data('tvsort') || '');
			if (tvst.sort === col) tvst.sort_dir = tvst.sort_dir === -1 ? 1 : -1;
			else { tvst.sort = col; tvst.sort_dir = 1; }
			$pane.data('mba-tv-rerender')?.();
		});

		// Tapisan client-side pakej traveller (bilangan baris) — kemaskini
		// state & re-render melalui callback pakej pada pane. (Select doc
		// status telah dibuang — tapisan dokumen kini hanya melalui panel
		// penapis dinamik / server.)
		// Bulk edit (table view) — checkbox baris + select-all; butang
		// Bulk Edit aktif bila ≥1 baris dipilih.
		$d.on('change', '.mba-tv-checkrow, .mba-tv-checkall', function () {
			const $pane = $(this).closest('.mba-tab-pane');
			const $checkall = $pane.find('.mba-tv-checkall');
			const $rows = $pane.find('.mba-tv-checkrow');
			if ($(this).is($checkall)) {
				$rows.prop('checked', $checkall.prop('checked'));
			}
			const checked = $rows.filter(':checked').length;
			$checkall.prop('checked', checked > 0 && checked === $rows.length)
				.prop('indeterminate', checked > 0 && checked < $rows.length);
			$pane.find('.mba-tv-bulk-btn').prop('disabled', checked === 0)
				.text(checked ? `${__('Bulk Edit')} (${checked})` : __('Bulk Edit'));
		});
		$d.on('click', '.mba-tv-bulk-btn', function () {
			const $pane = $(this).closest('.mba-tab-pane');
			const rows = [];
			$pane.find('.mba-tv-checkrow:checked').each(function () {
				rows.push({
					traveller: String($(this).data('traveller') || ''),
					reservation: String($(this).data('reservation') || ''),
				});
			});
			if (!rows.length) return;
			open_traveller_bulk_dialog($pane, rows);
		});

		$d.on('change', '.mba-tv-limitsel', function () {
			const $sel = $(this);
			const $pane = $sel.closest('.mba-tab-pane');
			const key = $sel.closest('.mba-group').data('item');
			const tvst = S.state[key]?.tv;
			if (!tvst) return;
			tvst.limit = parseInt($sel.val(), 10) || 0;
			$pane.data('mba-tv-rerender')?.();
		});

		// ── Penapis dinamik tab Travellers (L2 & L3) — pilih mana-mana medan
		// doctype sumber kemudian tapis nilainya; dilaksanakan server-side
		// melalui loader masing-masing (group → load_tab, booking →
		// load_bkg_travellers). ──
		const tv_cf_reload = (key) => (key.startsWith('bkg:')
			? load_bkg_travellers(key, true) : load_tab(key, 'traveller', true));
		const tv_cf_rerender = (key) => (key.startsWith('bkg:')
			? render_bkg_travellers(key) : render_travellers_tab(key));
		// Pane penapis aktif — L3 (bkg:) guna pane 'tv', L2 pane 'traveller'.
		const tv_cf_pane = (key) => (key.startsWith('bkg:')
			? $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="tv"]`)
			: pane_el(key, 'traveller'));

		$d.on('click', '.mba-cf-toggle', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st) return;
			st.tv.cf_open = !st.tv.cf_open;
			if (st.tv.cf_open && !(st.tv.custom || []).length) {
				st.tv.custom = [{ doctype: '', fieldname: '', value: '' }];
			}
			tv_cf_rerender(key);
			tv_cf_hydrate(key);
			if (st.tv.cf_open) tv_cf_pane(key).find('.mba-cf-field-input').last().trigger('focus');
		});
		$d.on('click', '.mba-cf-add', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st) return;
			st.tv.custom = [...(st.tv.custom || []), { doctype: '', fieldname: '', value: '' }];
			tv_cf_rerender(key);
			tv_cf_pane(key).find('.mba-cf-field-input').last().trigger('focus');
		});
		$d.on('click', '.mba-cf-del', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			const idx = $(this).data('idx');
			if (!st || idx == null) return;
			st.tv.custom.splice(idx, 1);
			tv_cf_rerender(key);
		});
		$d.on('change', '.mba-cf-field-input', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			const idx = $(this).data('idx');
			if (!st || idx == null) return;
			const display = String($(this).val() || '').trim();
			const m = tv_cf_field_choices().find((x) => x.display === display);
			const r = st.tv.custom[idx] || (st.tv.custom[idx] = {});
			if (!m) {
				// Taapan tak sepadan mana-mana medan — pulih paparan pilihan
				// semasa (bila ada); kosong bila baris belum dipilih.
				$(this).val(tv_cf_display(r));
				return;
			}
			if (m.doctype === r.doctype && m.fieldname === r.fieldname) return;
			r.doctype = m.doctype;
			r.fieldname = m.fieldname;
			r.value = ''; r.min = ''; r.max = '';
			// Re-render — baris tukar bentuk input ikut jenis medan (nilai
			// tunggal vs julat Min–Max nombor vs pilihan Select). Nilai
			// baris lain kekal (disimpan dalam state pada setiap keystroke).
			tv_cf_rerender(key);
			const $row = tv_cf_pane(key).find(`.mba-cf-row[data-idx="${idx}"]`);
			if (tv_cf_is_range(r)) $row.find('.mba-cf-min').trigger('focus');
			else {
				$row.find('.mba-cf-value').trigger('focus');
				tv_cf_fill_datalist(key, $row);
			}
		});
		$d.on('input', '.mba-cf-value', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			const idx = $(this).data('idx');
			if (!st || idx == null || !st.tv.custom[idx]) return;
			st.tv.custom[idx].value = $(this).val();
		});
		// Input julat Min–Max (medan nombor/currency) — simpan ikut kelas.
		$d.on('input', '.mba-cf-min, .mba-cf-max', function () {
			const $in = $(this);
			const st = S.state[$in.closest('.mba-group').data('item')];
			const idx = $in.data('idx');
			if (!st || idx == null || !st.tv.custom[idx]) return;
			st.tv.custom[idx][$in.hasClass('mba-cf-min') ? 'min' : 'max'] = $in.val();
		});
		$d.on('keydown', '.mba-cf-value, .mba-cf-min, .mba-cf-max', function (ev) {
			if (ev.key !== 'Enter') return;
			ev.preventDefault();
			tv_cf_reload($(this).closest('.mba-group').data('item'));
		});
		// Mod gabungan baris AND | OR — kemaskini state + kelas butang terus
		// (tiada re-render supaya nilai yang sedang ditaip kekal).
		$d.on('click', '.mba-cf-match-btn', function () {
			const $b = $(this);
			const key = $b.closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st) return;
			st.tv.cf_match = $b.data('match') === 'OR' ? 'OR' : 'AND';
			$b.closest('.mba-cf-match').find('.mba-cf-match-btn').removeClass('active');
			$b.addClass('active');
		});
		$d.on('click', '.mba-cf-apply', function () {
			tv_cf_reload($(this).closest('.mba-group').data('item'));
		});
		$d.on('click', '.mba-cf-clear', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st) return;
			st.tv.custom = [];
			tv_cf_reload(key);
		});

		// Klik kad/baris traveller → modal maklumat penuh. Slot TANPA rekod
		// Traveller JUGA membuka modal — panel Booking menggantikan Personal
		// (info traveller belum berlinkung). Butang aksi dalam kad kekal
		// berfungsi. Baris VISIBLE dalam pane semasa dihantar sebagai konteks
		// navigasi Prev/Next modal (grid ATAU jadual — hanya satu paparan).
		$d.on('click', '.mba-tvcard, tr.mba-tv-trow', function (ev) {
			if ($(ev.target).closest('a, button, input').length) return;
			let t = null;
			try { t = JSON.parse($(this).attr('data-trav')); } catch (e) { /* ignore */ }
			if (!t) return;
			// Reservation TANPA link traveller — modal detail dinyahaktif;
			// papar popup amaran sebagai ganti.
			if (!t.traveller) {
				frappe.msgprint({
					title: __('No Traveller Document'),
					indicator: 'orange',
					message: __("No Traveller's Document Registered To This Reservation"),
				});
				return;
			}
			const list = [];
			$(this).closest('.mba-tab-pane').find('.mba-tvcard, tr.mba-tv-trow').each(function () {
				if (!$(this).is(':visible')) return;
				let r = null;
				try { r = JSON.parse($(this).attr('data-trav') || ''); } catch (e) { /* ignore */ }
				if (r && r.traveller) list.push(r);
			});
			const idx = list.findIndex((r) => r.reservation === t.reservation);
			show_traveller_dialog(t, { list, index: idx < 0 ? 0 : idx });
		});

		// Klik nama dalam pecahan DOB (tab Overview — Breakdowns) → modal
		// maklumat traveller penuh. Prev/Next modal terhad kepada senarai
		// DOB dalam blok yang sama.
		$d.on('click', '.mba-dob-link', function (ev) {
			ev.preventDefault();
			let t = null;
			try { t = JSON.parse($(this).attr('data-trav')); } catch (e) { /* ignore */ }
			if (!t) return;
			if (!t.traveller) {
				frappe.msgprint({
					title: __('No Traveller Document'),
					indicator: 'orange',
					message: __("No Traveller's Document Registered To This Reservation"),
				});
				return;
			}
			const list = [];
			$(this).closest('[data-dob-block]').find('.mba-dob-link').each(function () {
				let r = null;
				try { r = JSON.parse($(this).attr('data-trav') || ''); } catch (e) { /* ignore */ }
				if (r && r.traveller) list.push(r);
			});
			const idx = list.findIndex((r) => r.reservation === t.reservation);
			show_traveller_dialog(t, { list, index: idx < 0 ? 0 : idx });
		});

		// Load more — tingkatkan limit, fetch semula.
		$d.on('click', '.mba-load-more', function () {
			const $pane = $(this).closest('.mba-tab-pane');
			const key = $(this).closest('.mba-group').data('item');
			const tab = $pane.data('pane');
			const st = S.state[key];
			if (!st || !tab) return;
			const scope = $(this).data('scope');
			// Pane L3 guna id tab sendiri ('tv') — bukan kunci TAB_STATE_KEY L2.
			const limitKey = scope || TAB_STATE_KEY[tab] || tab;
			if (!limitKey || !st[limitKey]) return;
			const cur = st[limitKey].limit;
			let next = 0;
			if (cur > 0) {
				const idx = ROW_LIMITS.indexOf(cur);
				next = idx >= 0 && idx < ROW_LIMITS.length - 1 ? ROW_LIMITS[idx + 1] : cur + 25;
			}
			st[limitKey].limit = next;
			$pane.find(`select[data-kind="limit"][data-scope="${limitKey}"]`).val(String(next));
			if (key.startsWith('bkg:') && limitKey === 'tv') load_bkg_travellers(key, true);
			else load_tab(key, tab, true);
		});

		// Carian dalam tab — ENTER sahaja. Bukan debounce-on-input: fetch +
		// re-render menjana semula toolbar (kotak carian diganti), fokus
		// hilang tengah menaip & user terpaksa klik semula medan untuk
		// sambung. Kosong sahaja (✕ pakej carian / padam ke kosong) reload
		// serta-merta tanpa Enter. Toolbar tab biasa & toolbar pakej
		// traveller (.mba-tv-toolbar membawa tapisan server L2/L3 sebagai extras).
		const tab_search_sel = '.mba-tab-toolbar input[data-search], .mba-tv-toolbar input[data-search]';
		const run_tab_search = function () {
			const key = $(this).closest('.mba-group').data('item');
			const scope = $(this).data('search');       // bk | ad | tv | fl | rm
			const tab = SCOPE_TAB[scope];
			const st = S.state[key];
			if (!st || !tab || !st[scope]) return;
			st[scope].search = $(this).val();
			if (key.startsWith('bkg:') && scope === 'tv') load_bkg_travellers(key, true);
			else load_tab(key, tab, true);
		};
		$d.on('keydown', tab_search_sel, function (ev) {
			if (ev.key === 'Escape') {
				// ESC — kosongkan carian (sama seperti ✕). Reload hanya bila
				// carian LAGI aktif; teks yang belum di-Enter tidak perlu fetch.
				if (this.value === '') return;
				ev.preventDefault();
				const key0 = $(this).closest('.mba-group').data('item');
				const scope0 = $(this).data('search');
				const applied = S.state[key0]?.[scope0]?.search || '';
				this.value = '';
				$(this).closest('.mba-searchwrap').find('.mba-search-clear').prop('hidden', true);
				if (applied !== '') run_tab_search.call(this);
				return;
			}
			if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
			ev.preventDefault();
			run_tab_search.call(this);
		})
			.on('input', tab_search_sel, function () {
				if (this.value === '') run_tab_search.call(this);
			});

		// Select filter / row limit dalam tab (termasuk extras toolbar pakej
		// traveller — SortSelector tiada <select> jadi tidak terkesan).
		$d.on('change', '.mba-tab-toolbar select, .mba-tv-toolbar select', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st) return;
			const kind = $(this).data('kind');
			const scope = $(this).data('scope');
			const val = $(this).val();
			const tab = SCOPE_TAB[scope];
			if (!tab) return;
			if (kind === 'status' && st[scope]) st[scope].status = val;
			else if (kind === 'payment' && st[scope]) st[scope].payment = val;
			else if (kind === 'currency' && st[scope]) st[scope].currency = val;
			else if (kind === 'group' && st[scope]) st[scope].group = val;
			else if (kind === 'privacy' && st.rm) st.rm.privacy = val;
			else if (kind === 'doc' && st.tv) st.tv.doc_status = val;
			else if (kind === 'limit' && scope && st[scope]) st[scope].limit = parseInt(val, 10) || 0;
			if (key.startsWith('bkg:') && scope === 'tv') load_bkg_travellers(key, true);
			else load_tab(key, tab, true);
		});

		// Checkbox "Unlinked Traveller Only" (toolbar-left pakej senarai
		// traveller) — tapis HANYA reservation tanpa link doctype
		// Traveller. State dikongsi dengan tv.doc_status ('No Traveller').
		$d.on('change', '.mba-tv-unlinked-chk', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st || !st.tv) return;
			st.tv.doc_status = $(this).is(':checked') ? 'No Traveller' : '';
			if (key.startsWith('bkg:')) load_bkg_travellers(key, true);
			else load_tab(key, 'traveller', true);
		});

		// Link dalaman → navigasi SPA (bukan full reload)
		$d.on('click', 'a[href^="/app/"], .mba-card-click a[href^="/app/"]', function (ev) {
			// Pautan tab baharu (cth. Open Booking Form) — biar browser yang
			// buka; jangan cegah default / navigasi SPA tab semasa.
			if (this.target === '_blank') return;
			ev.preventDefault();
			const href = $(this).attr('href');
			const parts = href.split('?')[0].replace(/^\/app\//, '').split('/').filter(Boolean);
			const qs = {};
			(href.split('?')[1] || '').split('&').forEach((kv) => {
				const [k, v] = kv.split('=');
				if (k) qs[k] = decodeURIComponent((v || '').replace(/\+/g, ' '));
			});
			if (parts[0] === 'manage-booking-app' || parts[0] === 'manage-booking-group') {
				// Sub-path page ni — pautan legacy page lama dialih ke sini.
				frappe.set_route('manage-booking-app', ...parts.slice(1));
				return;
			}
			if (parts.length === 1) {
				frappe.set_route('List', parts[0]);
			} else if (parts[1] === 'view') {
				if (Object.keys(qs).length) frappe.route_options = qs;
				frappe.set_route('List', parts[0]);
			} else {
				frappe.set_route('Form', parts[0], decodeURIComponent(parts[1]));
			}
		});

		// Kad booking (L2, telefon) / baris jadual booking (desktop) → L3;
		// kad addon/flight (tab More) → form dokumen masing-masing.
		$d.on('click', '.mba-bkcard, tr.mba-bk-row', function (ev) {
			if ($(ev.target).closest('a, button, .mba-msg-btn').length) return;
			const $el = $(this);
			const route = $el.data('route');
			if (route) {
				const [dt, dn] = String(route).split('/');
				if (dt && dn) frappe.set_route('Form', dt, dn);
				return;
			}
			const b = $el.data('booking');
			if (b) frappe.set_route('manage-booking-app', 'booking', b);
		});

		// Baris table / item dokumen → buka dokumen.
		$d.on('click', 'tr[data-route], .mba-docitem[data-route]', function (ev) {
			if ($(ev.target).closest('a, .mba-msg-btn').length) return;
			const [doctype, docname] = ($(this).data('route') || '').split('/');
			if (doctype && docname) frappe.set_route('Form', doctype, docname);
		});

		// Icon Message → modal pesanan penuh.
		$d.on('click', '.mba-msg-btn', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			show_message_dialog($(this).data('title'), $(this).data('message'));
		});

		// Mesej customer (rail L3).
		$d.on('click', '.mba-bkg-msg-btn', function () {
			show_message_dialog($(this).data('title') || __('Customer Message'), $(this).data('message'));
		});

		// Quick view lampiran Payment Entry.
		$d.on('click', '.mba-file-view-btn', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			show_file_viewer($(this).data('name'), $(this).data('url'), !!$(this).data('image'));
		});

		// Guest passport link — jana & papar modal link + QR (kad/baris
		// traveller berkaitan booking reservation).
		$d.on('click', '.mba-tv-link-btn', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			let t = null;
			try { t = JSON.parse($(this).closest('[data-trav]').attr('data-trav')); } catch (e) { /* ignore */ }
			if (t) show_guest_link_dialog(t);
		});
	}

	/* ========== LOAD GROUP LIST ========== */

	// Domain slider julat masa — bulan-bulan (YYYY-MM) unik daripada tarikh
	// pergi group yang dimuatkan, terisih. Julat terpilih dikekalkan bila
	// masih sah dalam domain baharu; selain itu reset ke julat penuh.
	function sync_month_range() {
		const set = new Set();
		S.groups.forEach((g) => {
			const d = group_depart_date(g);
			if (d) set.add(d.slice(0, 7));
		});
		S.monthDomain = [...set].sort();
		const n = S.monthDomain.length;
		const $s = $('#mba-range-start');
		const $e = $('#mba-range-end');
		if (!$s.length) return;
		[$s, $e].forEach(($i) => {
			$i.attr({ min: 0, max: Math.max(0, n - 1) }).prop('disabled', n < 2);
		});
		if (!n || !S.monthDomain.includes(S.filters.mFrom)
			|| !S.monthDomain.includes(S.filters.mTo)
			|| S.filters.mFrom > S.filters.mTo) {
			S.filters.mFrom = '';
			S.filters.mTo = '';
		}
		$s.val(String(S.filters.mFrom ? S.monthDomain.indexOf(S.filters.mFrom) : 0));
		$e.val(String(S.filters.mTo ? S.monthDomain.indexOf(S.filters.mTo) : Math.max(0, n - 1)));
		sync_range_ui();
	}

	// Isi fill track + label paparan slider daripada nilai input semasa.
	function sync_range_ui() {
		const dom = S.monthDomain;
		const n = dom.length;
		const $s = $('#mba-range-start');
		const $e = $('#mba-range-end');
		if (!$s.length || !n) {
			$('#mba-range-fill').css({ left: '0%', width: '100%' });
			return;
		}
		let a = parseInt($s.val(), 10) || 0;
		let b = parseInt($e.val(), 10) || 0;
		if (b < a) b = a;
		if ($e.val() !== String(b)) $e.val(String(b));
		const full = a === 0 && b >= n - 1;
		const fmt = (i) => {
			const [y, m] = dom[i].split('-');
			return MONTHS[parseInt(m, 10) - 1] + ' ' + y;
		};
		$('#mba-range-from').text(full ? __('All Time') : fmt(a));
		$('#mba-range-to').text(full ? '' : fmt(b));
		const pctA = n > 1 ? (a / (n - 1)) * 100 : 0;
		const pctB = n > 1 ? (b / (n - 1)) * 100 : 100;
		$('#mba-range-fill').css({ left: pctA + '%', width: (pctB - pctA) + '%' });
		// Handle mula ke atas bila kedua-duanya terletak di hujung kanan —
		// kalau tidak handle akhir melitupi dan mula tak boleh digarak.
		$s.css('z-index', a >= n - 1 ? 5 : 3);
		$e.css('z-index', 4);
	}

	// Isi fill + label slider Collection Progress (0–100%, domain statik).
	function sync_coll_ui() {
		const $s = $('#mba-coll-start');
		const $e = $('#mba-coll-end');
		if (!$s.length) return;
		let a = parseInt($s.val(), 10) || 0;
		let b = parseInt($e.val(), 10);
		if (Number.isNaN(b)) b = 100;
		if (b < a) b = a;
		if ($e.val() !== String(b)) $e.val(String(b));
		const full = a === 0 && b >= 100;
		$('#mba-coll-from').text(full ? __('All') : a + '%');
		$('#mba-coll-to').text(full ? '' : b + '%');
		$('#mba-coll-fill').css({ left: a + '%', width: (b - a) + '%' });
		$s.css('z-index', a >= 100 ? 5 : 3);
		$e.css('z-index', 4);
	}

	// Label link arkib ikut mod semasa — View Archived ⇄ Back to Active.
	function update_arch_link() {
		$('#mba-arch-link')
			.toggleClass('active', S.archived)
			.text(S.archived ? __('← Back to Active') : __('View Archived'));
	}

	async function load(force = false) {
		if (S.loading) return;
		S.loading = true;
		$('#mba-list').html(`<div class="mba-loading">${__('Loading trip groups...')}</div>`);

		if (force) {
			S.cache = {};
			S.batchSel.clear();
		}

		try {
			const data = await api('get_trip_groups', {
				search: S.filters.search || null,
				status: S.filters.status || null,
				view: S.filters.view,
				archived: S.archived ? 1 : 0,
			});
			S.groups = data?.groups || [];
			S.currency = data?.currency || 'MYR';
			sync_month_range();
			S.items = build_items(S.groups);
		} finally {
			S.loading = false;
		}

		sync_filter_count();
		render_items();
	}

	/* ----- Umpukan batch: group yang share group_batch jadi satu item ----- */

	function build_items(groups) {
		let list = groups;
		if (S.filters.gtype === 'cruise') {
			list = list.filter((g) => g.is_a_cruise_trip);
		} else if (S.filters.gtype === 'non-cruise') {
			list = list.filter((g) => !g.is_a_cruise_trip);
		}

		if (S.filters.mFrom || S.filters.mTo) {
			list = list.filter((g) => {
				const d = (group_depart_date(g) || '').slice(0, 7);
				if (!d) return false;
				return (!S.filters.mFrom || d >= S.filters.mFrom)
					&& (!S.filters.mTo || d <= S.filters.mTo);
			});
		}

		// Collection Progress — % terkutuk dalam julat slider. Diikut
		// nilai yang DIPAPAR (bulat); group tanpa revenue tiada progress
		// dan terkeluar bila julat dikecilkan.
		if (S.filters.collMin > 0 || S.filters.collMax < 100) {
			list = list.filter((g) => {
				const dt = g.default_totals;
				if (!dt || !(dt.revenue > 0.009)) return false;
				const pct = Math.round(dt.collected / dt.revenue * 100);
				return pct >= S.filters.collMin && pct <= S.filters.collMax;
			});
		}

		const items = [];
		const byBatch = {};
		list.forEach((g) => {
			const batch = (g.group_batch || '').trim();
			if (batch) {
				if (!byBatch[batch]) {
					byBatch[batch] = { key: 'batch:' + batch, batch: batch, members: [], agg: null };
					items.push(byBatch[batch]);
				}
				byBatch[batch].members.push(g);
			} else {
				items.push({ key: 'grp:' + g.name, batch: '', members: [g], agg: null });
			}
		});

		items.forEach((it) => { it.agg = item_agg(it); });

		if (S.filters.hidePassive) {
			// Mod arkib — "passive" bermakna tiada booking sahaja; status
			// Completed/Cancelled memang peri paparan arkib, jangan ditapis.
			const isActive = (g) => (g.booking_count || 0) > 0
				&& (S.archived || (g.status !== 'Completed' && g.status !== 'Cancelled'));
			return items.filter((it) => it.members.some(isActive));
		}
		return items;
	}

	function item_agg(it) {
		const a = {
			booking_count: 0, cancelled_count: 0, addon_count: 0, pax: 0, rooms: 0,
			docs_submitted: 0, docs_verified: 0, pending_docs: 0,
		};
		const byCur = {};
		const effDepart = (g) => g.departure_date || g.sailing_start || '';
		const effReturn = (g) => g.return_date || g.sailing_end || '';
		let depart = '', ret = '';
		it.members.forEach((g) => {
			a.booking_count += g.booking_count || 0;
			a.cancelled_count += g.cancelled_count || 0;
			a.addon_count += g.addon_count || 0;
			a.pax += g.pax || 0;
			a.rooms += g.rooms || 0;
			a.docs_submitted += g.docs_submitted || 0;
			a.docs_verified += g.docs_verified || 0;
			a.pending_docs += g.pending_docs || 0;

			const d = effDepart(g);
			if (d && (!depart || d < depart)) depart = d;
			const r = effReturn(g);
			if (r && (!ret || r > ret)) ret = r;

			const rows = (Array.isArray(g.revenue_by_currency) && g.revenue_by_currency.length)
				? g.revenue_by_currency
				: (g.revenue != null
					? [{ currency: g.currency || S.currency, revenue: g.revenue, collected: g.collected }]
					: []);
			rows.forEach((r) => {
				const k = r.currency || S.currency;
				const e = byCur[k] || (byCur[k] = { currency: k, revenue: 0, collected: 0 });
				e.revenue += r.revenue || 0;
				e.collected += r.collected || 0;
			});
		});
		a.by_cur = Object.values(byCur)
			.map((e) => ({ ...e, balance: round2(e.revenue - e.collected) }))
			.sort((x, y) => (x.currency === S.currency ? -1 : y.currency === S.currency ? 1 : 0));
		a.default_totals = mergeDefaultTotals(it.members);
		a.depart = depart;
		a.ret = ret;
		a.docs_pct = a.pax ? Math.round(a.docs_verified / a.pax * 100) : 0;
		return a;
	}

	function mergeDefaultTotals(members) {
		let dt = null;
		members.forEach((g) => {
			const m = g.default_totals;
			if (!m) return;
			if (!dt) dt = { currency: m.currency || S.currency, revenue: 0, collected: 0, rates_complete: true };
			dt.revenue += m.revenue || 0;
			dt.collected += m.collected || 0;
			if (m.rates_complete === false) dt.rates_complete = false;
		});
		if (!dt) return null;
		dt.revenue = round2(dt.revenue);
		dt.collected = round2(dt.collected);
		dt.balance = round2(dt.revenue - dt.collected);
		return dt;
	}

	function find_item(key) {
		return S.items.find((it) => it.key === key)
			|| (S.detail && S.detail.key === key ? S.detail.item : null);
	}

	function item_groups(it) {
		return it.members.map((m) => m.name);
	}

	/* ========== RENDER L1: SENARAI ========== */

	// Tarikh mula julat paparan — cermin keutamaan group_dates_label:
	// cruise → sailing_start, lain → departure_date (fallback sailing_start).
	function group_depart_date(g) {
		if (g.is_a_cruise_trip && g.sailing_start) return g.sailing_start;
		return g.departure_date || g.sailing_start || '';
	}

	// "X days left" — kiraan hari ke tarikh pergi; kosong bila tarikh
	// telah lepas atau tiada.
	function days_left_label(iso) {
		if (!iso) return '';
		const diff = frappe.datetime.get_diff(iso, frappe.datetime.get_today());
		if (diff > 1) return diff + ' ' + __('days left');
		if (diff === 1) return __('1 day left');
		if (diff === 0) return __('Departs today');
		return '';
	}

	// Tarikh paparan ikut jenis trip: cruise → sailing date, lain → departure
	function group_dates_label(g) {
		if (g.is_a_cruise_trip) {
			if (g.sailing_start) {
				return 'Sail: ' + fmtDate(g.sailing_start)
					+ (g.sailing_end && g.sailing_end !== g.sailing_start ? ' → ' + fmtDate(g.sailing_end) : '');
			}
		}
		if (g.departure_date) {
			return fmtDate(g.departure_date)
				+ (g.return_date && g.return_date !== g.departure_date ? ' → ' + fmtDate(g.return_date) : '');
		}
		if (g.sailing_start) {
			return 'Sail: ' + fmtDate(g.sailing_start)
				+ (g.sailing_end ? ' → ' + fmtDate(g.sailing_end) : '');
		}
		return '';
	}

// Angka ringkasan item — revenue/balance default currency bila
// bercampur currency; sub = pecahan native per currency.
const item_money = (a) => {
	const dt = a.default_totals;
	const useDefault = hasAltCur(a.by_cur) && dt;
	const revCell = useDefault
		? fmtDefaultTotal(dt, 'revenue')
		: fmtMoney((dt && dt.revenue) || 0, S.currency);
	const curTitle = (field) => (a.by_cur.length
		? a.by_cur.map((r) => fmtMoney(r[field], r.currency)).join(' · ')
		: '');
	const incomplete = dt && dt.rates_complete === false ? '+' : '';
	const collPct = dt && dt.revenue
		? Math.round(dt.collected / dt.revenue * 100) + '%' + incomplete
		: '—';
	return {
		revCell, revTitle: curTitle('revenue'),
		myrRev: cur_sub_line(a, 'MYR', 'revenue'),
		sgdRev: cur_sub_line(a, 'SGD', 'revenue'),
		collPct,
		collDefault: dt ? fmtMoney(dt.collected, dt.currency || S.currency) + incomplete
			: fmtMoney(0, S.currency),
		sgdColl: cur_sub_line(a, 'SGD', 'collected'),
	};
};

// Tarikh mula/julat akhir item (single ATAU batch) — ikut semantik
// group_depart_date: cruise → sailing_start, lain → departure_date;
// pulangan = return_date / sailing_end yang terakhir.
function item_depart(it) {
	if (it.members.length === 1) return group_depart_date(it.members[0]);
	return it.members.reduce((min, m) => {
		const d = group_depart_date(m);
		return d && (!min || d < min) ? d : min;
	}, '');
}

function item_return(it) {
	const eff = (m) => m.return_date || m.sailing_end || '';
	if (it.members.length === 1) return eff(it.members[0]);
	return it.members.reduce((max, m) => {
		const d = eff(m);
		return d && (!max || d > max) ? d : max;
	}, '');
}

// Badge kiraan hari ke tarikh pergi — kosong bila tarikh lepas/tiada.
const days_left_badge = (iso) => {
	const label = days_left_label(iso);
	return label ? `<span class="mba-days-left">${esc(label)}</span>` : '';
};

// col1 sub-line dikongsi kad & baris jadual — nama group (bukan ID)
// untuk group tunggal; senarai ID group anggota untuk batch.
const group_names_sub = (it) => {
	if (it.batch) return it.members.map((m) => m.name).join(', ');
	const g0 = it.members[0];
	return (g0.trip_group_name && g0.trip_group_name !== g0.name)
		? g0.trip_group_name : '';
};

// col1 sub-line nama trip — unik merentas anggota batch.
const trip_names_sub = (it) => [...new Set(it.members
	.map((m) => m.trip_name || m.trip_group_name || m.name)
	.filter(Boolean))].join(', ');

// Jumlah ke atas item yang DIPAPARKAN (default currency — selamat
// dijumlah kerana semuanya sudah ditukar). by_cur = pecahan native
// per-currency (jumlah DALAM currency yang sama — selamat dijumlah)
// untuk sub-line MYR/SGD footer.
function footer_agg(items) {
	const f = {
		count: items.length,
		booking_count: 0, addon_count: 0, rooms: 0, pax: 0,
		docs_verified: 0, docs_submitted: 0, pending_docs: 0,
		dt: null,
	};
	const byCur = {};
	items.forEach((it) => {
		const a = it.agg;
		f.booking_count += a.booking_count || 0;
		f.addon_count += a.addon_count || 0;
		f.rooms += a.rooms || 0;
		f.pax += a.pax || 0;
		f.docs_verified += a.docs_verified || 0;
		f.docs_submitted += a.docs_submitted || 0;
		f.pending_docs += a.pending_docs || 0;
		(a.by_cur || []).forEach((r) => {
			const e = byCur[r.currency] || (byCur[r.currency] = { currency: r.currency, revenue: 0, collected: 0 });
			e.revenue += r.revenue || 0;
			e.collected += r.collected || 0;
		});
		const m = a.default_totals;
		if (m) {
			f.dt = f.dt
				|| { currency: m.currency || S.currency, revenue: 0, collected: 0, balance: 0, rates_complete: true };
			f.dt.revenue += m.revenue || 0;
			f.dt.collected += m.collected || 0;
			f.dt.balance += m.balance || 0;
			if (m.rates_complete === false) f.dt.rates_complete = false;
		}
	});
	f.by_cur = Object.values(byCur)
		.sort((x, y) => (x.currency === S.currency ? -1 : y.currency === S.currency ? 1 : 0));
	return f;
}

	function render_items() {
		const $list = $('#mba-list');

		if (!S.items.length) {
			$list.html(`<div class="mba-empty">${S.archived
				? __('No archived trips found for this filter.')
				: __('No Trip Group Date found for this filter.')}</div>`);
			$('#mba-summary').empty();
			return;
		}

		sort_items();

		// Strip jumlah — menggantikan tfoot jadual pada telefon.
		const f = footer_agg(S.items);
		const dt = f.dt;
		const incomplete = dt && dt.rates_complete === false ? '+' : '';
		$('#mba-summary').html(`
			<span><b>${f.count}</b> ${__('groups')}</span>
			<span><b>${f.booking_count}</b> ${__('bookings')}</span>
			<span><b>${f.pax}</b> ${__('pax')}</span>
			<span><b>${dt ? fmtMoney(dt.revenue, dt.currency) + incomplete : fmtMoney(0, S.currency)}</b> ${__('revenue')}</span>
			<span class="${dt && dt.balance > 0.009 ? 'is-danger' : ''}"><b>${dt ? fmtMoney(dt.balance, dt.currency) + incomplete : fmtMoney(0, S.currency)}</b> ${__('due')}</span>`);

		$list.html(`
			<div class="mba-cards">${S.items.map(render_group_card).join('')}</div>
			<div class="mba-table-wrap">
				<table class="mba-table mba-groups-table">
					<thead><tr>
						<th class="mba-col-sel"><input type="checkbox" id="mba-sel-all" title="${__('Select all groups')}"/></th>
						<th class="mba-sortable" data-sort="group" title="${__('Sort by group / batch name')}">${__('Trip Group / Batch')}<span class="mba-sort-ind"></span></th>
						<th class="num mba-sortable" data-sort="depart" title="${__('Sort by departure date')}">${__('Departure')}<span class="mba-sort-ind"></span></th>
						<th class="num mba-sortable" data-sort="pax" title="${__('Pax of active bookings (excludes Cancelled & Abandoned)')}">${__('Reservations')}<span class="mba-sort-ind"></span></th>
						<th class="num mba-sortable" data-sort="revenue" title="${__('In default display currency')}">${__('Revenue')}<span class="mba-sort-ind"></span></th>
						<th class="num mba-sortable" data-sort="collection" title="${__('% of revenue collected; SGD line = collection in SG company')}">${__('Collection')}<span class="mba-sort-ind"></span></th>
					</tr></thead>
					${S.items.map(render_group_row).join('')}
					${render_groups_footer(S.items)}
				</table>
			</div>`);

		// Penanda arah susunan pada header aktif.
		const $th = $list.find(`.mba-groups-table thead th[data-sort="${S.sort.key}"]`);
		if ($th.length) {
			$th.addClass('is-sorted').find('.mba-sort-ind').text(S.sort.dir === 1 ? '▲' : '▼');
		}

		sync_row_checks();
		update_batch_button();
		bind_sel_all();
	}

	// Susunan jadual L1 — klik header (.mba-sortable) set S.sort; tiada
	// sort aktif = susunan server (upcoming terhampir dulu). Batch disusun
	// atas nama batch; collection tanpa revenue dihujung (-1).
	const SORT_KEYS = {
		group: (it) => (it.batch || it.members[0].name || '').toLowerCase(),
		depart: (it) => item_depart(it) || '9999-99-99',
		pax: (it) => it.agg.pax || 0,
		revenue: (it) => (it.agg.default_totals ? it.agg.default_totals.revenue : 0),
		collection: (it) => {
			const dt = it.agg.default_totals;
			return dt && dt.revenue ? dt.collected / dt.revenue : -1;
		},
	};

	function sort_items() {
		const fn = SORT_KEYS[S.sort.key];
		if (!fn) return;
		S.items.sort((x, y) => {
			const a = fn(x);
			const b = fn(y);
			return (a < b ? -1 : a > b ? 1 : 0) * S.sort.dir;
		});
	}

	function bind_sel_all() {
		$('#mba-sel-all').off('change').on('change', function () {
			const names = sel_all_names();
			if (this.checked) names.forEach((n) => S.batchSel.add(n));
			else S.batchSel.clear();
			sync_row_checks();
			update_batch_button();
		});
	}

	function sel_all_names() {
		const names = [];
		S.items.forEach((it) => it.members.forEach((m) => names.push(m.name)));
		return names;
	}

	function sync_row_checks() {
		$('#mba-list .mba-sel-group').each(function () {
			const it = find_item($(this).closest('.mba-group').data('item'));
			if (!it) return;
			this.checked = it.members.every((m) => S.batchSel.has(m.name));
		});
		const $all = $('#mba-sel-all');
		if ($all.length) {
			const names = sel_all_names();
			$all[0].checked = names.length > 0 && names.every((n) => S.batchSel.has(n));
		}
	}

	function update_batch_button() {
		const $b = $('#mba-assign-batch');
		if (!$b.length) return;
		$b.prop('disabled', !S.batchSel.size);
		$b.text(S.batchSel.size
			? `${__('Assign Group Batch')} (${S.batchSel.size})`
			: __('Assign Group Batch'));
	}

	function open_batch_dialog() {
		if (!S.batchSel.size) return;
		const existing = [...new Set(S.groups
			.map((g) => (g.group_batch || '').trim())
			.filter(Boolean))];
		const suggested = 'BATCH-' + frappe.datetime.get_today().replaceAll('-', '');

		const apply = async (batch) => {
			try {
				await api('assign_group_batch', {
					trip_groups: [...S.batchSel],
					group_batch: batch,
				});
				frappe.show_alert({
					message: batch
						? __('{0} trip group(s) assigned to batch {1}', [S.batchSel.size, batch])
						: __('{0} trip group(s) removed from their batch', [S.batchSel.size]),
					indicator: 'green',
				}, 5);
				d.hide();
				S.batchSel.clear();
				update_batch_button();
				load(true);
			} catch (e) {
				// api() sudah papar alert error
			}
		};

		const d = new frappe.ui.Dialog({
			title: __('Assign Group Batch'),
			fields: [
				{
					fieldname: 'group_batch', fieldtype: 'Data',
					label: __('Group Batch Name'), default: suggested,
					description: existing.length
						? __('Existing batches (reusing a name merges into that batch)') + ': ' + frappe.utils.escape_html(existing.join(', '))
						: __('A new batch name will group the selected trip group dates into one row.'),
				},
			],
			primary_action_label: __('Assign'),
			primary_action: (values) => {
				const name = (values.group_batch || '').trim().toUpperCase();
				if (!name) {
					frappe.show_alert({
						message: __('Batch name is blank — clear the selection or enter a batch name.'),
						indicator: 'orange',
					}, 6);
					return;
				}
				return apply(name);
			},
			secondary_action_label: __('Unset Batch Name'),
			secondary_action: () => apply(''),
		});
		d.show();
		d.get_field('group_batch').$input.on('change', function () {
			this.value = (this.value || '').toUpperCase();
		});
	}

	// Rename batch — kemas kini group_batch SEMUA group anggota ke nama
	// baharu melalui assign_group_batch (nama yang bertembung dengan batch
	// sedia ada bermakna gabung ke batch itu). Berjaya → cache dikosongkan
	// dan route melompat ke URL batch baharu.
	function rename_batch_dialog(key) {
		const it = find_item(key);
		if (!it || !it.batch || !it.members.length) return;
		const members = it.members.map((m) => m.name);
		const existing = [...new Set(S.groups
			.map((g) => (g.group_batch || '').trim())
			.filter(Boolean))].filter((b) => b !== it.batch);

		const apply = async (name) => {
			d.get_primary_btn().prop('disabled', true);
			try {
				await api('assign_group_batch', { trip_groups: members, group_batch: name });
				frappe.show_alert({
					message: __('Batch renamed to {0} ({1} group(s))', [name, members.length]),
					indicator: 'green',
				}, 5);
				d.hide();
				S.cache = {};
				S.batchSel.clear();
				update_batch_button();
				frappe.set_route('manage-booking-app', 'batch', name);
			} catch (e) {
				// api() sudah papar alert error — benarkan cuba semula
				d.get_primary_btn().prop('disabled', false);
			}
		};

		const d = new frappe.ui.Dialog({
			title: __('Rename Group Batch'),
			fields: [
				{
					fieldname: 'group_batch', fieldtype: 'Data',
					label: __('New Group Batch Name'), default: it.batch,
					description: existing.length
						? __('Reusing an existing batch name merges these groups into that batch') + ': ' + frappe.utils.escape_html(existing.join(', '))
						: __('All {0} member group(s) will carry this batch name.', [members.length]),
				},
			],
			primary_action_label: __('Rename'),
			primary_action: (values) => {
				const name = (values.group_batch || '').trim().toUpperCase();
				if (!name) {
					frappe.show_alert({
						message: __('Batch name cannot be blank — use "Unset Batch Name" on the list page to dissolve a batch.'),
						indicator: 'orange',
					}, 6);
					return;
				}
				if (name === it.batch) { d.hide(); return; }
				return apply(name);
			},
		});
		d.show();
		d.get_field('group_batch').$input.on('change', function () {
			this.value = (this.value || '').toUpperCase();
		});
	}

	// Kad group (telefon) — main nama+badge, sub1 nama group, sub2 trip,
	// tarikh (+badge kiraan hari), stat mini (bookings+addon, pax·rooms,
	// docs, collection %).
	function render_group_card(it) {
		const a = it.agg;
		const titleLine = it.batch ? esc(it.batch) : esc(it.members[0].name);
		const batchBadge = it.batch ? badge(it.members.length + ' ' + __('groups'), 'violet') : '';
		const status = it.members.length === 1 ? it.members[0].status : null;
		const sub1 = group_names_sub(it);
		const sub2 = trip_names_sub(it);

		const depart = item_depart(it);
		const ret = item_return(it);
		const dateLabel = depart
			? fmtDate(depart) + (ret && ret !== depart ? ' → ' + fmtDate(ret) : '')
			: (it.members.length === 1 ? group_dates_label(it.members[0]) : '');
		const daysBadge = days_left_badge(depart);

		const dt = a.default_totals;
		const incomplete = dt && dt.rates_complete === false ? '+' : '';
		const collPct = dt && dt.revenue
			? Math.round(dt.collected / dt.revenue * 100) + '%' + incomplete : '—';
		const collTitle = a.by_cur.length
			? a.by_cur.map((r) => fmtMoney(r.collected, r.currency)).join(' · ') : '';

		return `
			<div class="mba-card mba-group ${it.batch ? 'mba-group--batch' : ''}" data-item="${esc(it.key)}">
				<input type="checkbox" class="mba-sel-group" title="${__('Select for Assign Group Batch')}"/>
				<div class="mba-card-click">
					<div class="mba-card-top">
						<span class="mba-card-title">${titleLine}</span>
						<span class="mba-card-badges">${batchBadge}${status ? badge(status, GROUP_STATUS_COLORS[status]) : ''}</span>
					</div>
					${sub1 ? `<div class="mba-card-sub" title="${esc(sub1)}">${esc(sub1)}</div>` : ''}
					${sub2 ? `<div class="mba-card-sub" title="${esc(sub2)}">${esc(sub2)}</div>` : ''}
					${dateLabel ? `<div class="mba-card-date">${esc(dateLabel)}${daysBadge ? ' ' + daysBadge : ''}</div>` : ''}
					<div class="mba-card-stats">
						<span><b>${a.booking_count}</b> ${__('bookings')}${a.addon_count > 0 ? ` <span class="mba-card-addon">+${a.addon_count} ${__('add-ons')}</span>` : ''}</span>
						<span><b>${a.pax}</b> ${__('pax')} · ${a.rooms} ${__('rooms')}</span>
						<span title="${esc(__('Verified / submitted traveller documents'))}"><b>${a.docs_verified || 0}/${a.docs_submitted || 0}</b> ${__('docs')}</span>
						<span title="${esc(collTitle ? __('Collected per currency') + ': ' + collTitle : '')}"><b>${collPct}</b> ${__('collected')}</span>
					</div>
				</div>
			</div>`;
	}

	// Baris jadual group (desktop) — 5 kolum data (+ kolum pilihan):
	//   1. Trip Group / Batch — main ID/batch + badge status, sub1 nama
	//      group, sub2 nama trip.
	//   2. Departure — main tarikh pergi, sub1 tarikh pulang, sub2 badge
	//      kiraan hari ke tarikh pergi.
	//   3. Reservations — main pax, sub1 order / rooms, sub2 verified /
	//      submit (dokumen traveller berpaut).
	//   4. Revenue — main jumlah default currency, sub1 MYR, sub2 SGD.
	//   5. Collection — main % terkutip, sub1 jumlah default currency,
	//      sub2 kutipan company SG (currency SGD).
	function render_group_row(it) {
		const a = it.agg;
		const titleLine = it.batch ? esc(it.batch) : esc(it.members[0].name);
		const batchBadge = it.batch ? badge(it.members.length + ' ' + __('groups'), 'violet') : '';

		const sub1 = group_names_sub(it);
		const sub2 = trip_names_sub(it);

		const statuses = [...new Set(it.members.map((m) => m.status))];
		const statusCell = statuses.length === 1
			? badge(statuses[0], GROUP_STATUS_COLORS[statuses[0]])
			: statuses.map((s) => badge(s, GROUP_STATUS_COLORS[s])).join(' ');

		const depart = item_depart(it);
		const ret = item_return(it);
		const daysBadge = days_left_badge(depart);

		const { revCell, revTitle, myrRev, sgdRev, collPct, collDefault, sgdColl } = item_money(a);

		return `
			<tbody class="mba-group ${it.batch ? 'mba-group--batch' : ''}" data-item="${esc(it.key)}">
				<tr class="mba-group-row">
					<td class="mba-col-sel"><input type="checkbox" class="mba-sel-group" title="${__('Select for Assign Group Batch')}"/></td>
					<td>
						<div class="mba-cell-main ${it.batch ? 'is-batch' : ''}">${titleLine} ${batchBadge} ${statusCell}</div>
						${sub1 ? `<div class="mba-cell-sub" title="${esc(sub1)}">${esc(sub1)}</div>` : ''}
						${sub2 ? `<div class="mba-cell-sub" title="${esc(sub2)}">${esc(sub2)}</div>` : ''}
					</td>
					<td class="num">
						<div class="mba-cell-main">${depart ? fmtDate(depart) : '—'}</div>
						${ret && ret !== depart ? `<div class="mba-cell-sub">→ ${esc(fmtDate(ret))}</div>` : ''}
						${daysBadge ? `<div>${daysBadge}</div>` : ''}
					</td>
					<td class="num">
						<div class="mba-cell-main">${a.pax} ${__('pax')}</div>
						<div class="mba-cell-sub">${a.booking_count} ${__('order')} / ${a.rooms} ${__('rooms')}</div>
						<div class="mba-cell-sub" title="${esc(__('Verified / submitted traveller documents'))}">${a.docs_verified || 0} ${__('verified')} / ${a.docs_submitted || 0} ${__('submit')}</div>
					</td>
					<td class="num" title="${revTitle ? esc(__('Revenue per currency') + ': ' + revTitle) : ''}">
						<div class="mba-cell-main">${revCell}</div>
						${myrRev ? `<div class="mba-cell-sub">${esc(myrRev)}</div>` : ''}
						${sgdRev ? `<div class="mba-cell-sub">${esc(sgdRev)}</div>` : ''}
					</td>
					<td class="num" title="${sgdColl ? esc(__('Collection in SG company') + ': ' + sgdColl) : ''}">
						<div class="mba-cell-main">${collPct}</div>
						<div class="mba-cell-sub">${esc(collDefault)}</div>
						${sgdColl ? `<div class="mba-cell-sub">${esc(sgdColl)}</div>` : ''}
					</td>
				</tr>
			</tbody>`;
	}

	function render_groups_footer(items) {
		if (!items.length) return '';
		const f = footer_agg(items);
		const dt = f.dt;
		const incomplete = dt && dt.rates_complete === false ? '+' : '';
		const collPct = dt && dt.revenue
			? Math.round(dt.collected / dt.revenue * 100) + '%' + incomplete
			: '—';
		// Sub-line MYR/SGD — nilai footer dalam currency sama dijumlah
		// dahulu; baris tunggal default currency tidak diulang.
		const curLines = (field, curs) => f.by_cur
			.filter((r) => curs.includes(r.currency)
				&& (r[field] || 0) > 0.009
				&& (r.currency !== S.currency || f.by_cur.length > 1))
			.map((r) => r.currency + ': ' + fmtMoney(r[field], r.currency))
			.join(' · ');
		const revSub = curLines('revenue', ['MYR', 'SGD']);
		const sgdCollSub = curLines('collected', ['SGD']);

		return `
			<tfoot>
				<tr>
					<td class="mba-tfoot-label" colspan="3">${__('Total')} (${f.count} ${__('rows')})</td>
					<td class="num">${f.pax} ${__('pax')}
						<div class="mba-cell-sub">${f.booking_count} ${__('order')} · ${f.rooms} ${__('rooms')}</div></td>
					<td class="num">${dt ? fmtMoney(dt.revenue, dt.currency) + incomplete : fmtMoney(0, S.currency)}
						${revSub ? `<div class="mba-cell-sub">${esc(revSub)}</div>` : ''}</td>
					<td class="num">${collPct}
						<div class="mba-cell-sub">${dt ? fmtMoney(dt.collected, dt.currency) + incomplete : fmtMoney(0, S.currency)}</div>
						${sgdCollSub ? `<div class="mba-cell-sub">${esc(sgdCollSub)}</div>` : ''}</td>
				</tr>
			</tfoot>`;
	}

	function open_item(key) {
		const it = find_item(key);
		if (!it) return;
		if (it.batch) frappe.set_route('manage-booking-app', 'batch', it.batch);
		else frappe.set_route('manage-booking-app', 'group', it.members[0].name);
	}

	/* ========== L2: DETAIL GROUP/BATCH ========== */

	function view_root() {
		return S.mode === 'list' ? $('#mba-list') : $('#mba-detail');
	}

	function item_el(key) {
		return view_root().find('.mba-group').filter(function () { return $(this).data('item') === key; });
	}

	function pane_el(key, tab) {
		return item_el(key).find(`.mba-tab-pane[data-pane="${tab}"]`);
	}

	function default_state() {
		return {
			tab: 'overview',
			bk: { status: '', payment: '', search: '', group: '', currency: '', limit: DEFAULT_LIMIT },
			ad: { status: '', payment: '', search: '', group: '', limit: DEFAULT_LIMIT },
			tv: { search: '', doc_status: '', group: '', limit: DEFAULT_LIMIT,
				sort: '', sort_dir: 1, view: 'grid',
				// Penapis dinamik — baris {doctype, fieldname, value} + togol
				// panel + mod gabungan baris ('AND' lalai / 'OR').
				custom: [], cf_open: false, cf_match: 'AND' },
			rm: { search: '', privacy: '', limit: DEFAULT_LIMIT },
			fl: { search: '', limit: DEFAULT_LIMIT },
		};
	}

	// Konteks navigasi detail — turutan GROUP (bukan item senarai L1).
	// Ahli batch dipecah mengikut kedudukan batch dalam senarai, jadi
	// Prev/Next sentiasa bergerak group-ke-group dan laluan kekal
	// /group/<name> — tidak pernah /batch/. first < 0 bila deep-link /
	// di luar senarai — butang tidak dipapar.
	function detail_nav(it) {
		const flat = [];
		S.items.forEach((x) => x.members.forEach((m) => flat.push(m)));
		const names = it.members.map((m) => m.name);
		const first = flat.findIndex((m) => m.name === names[0]);
		const last = it.batch
			? flat.findIndex((m) => m.name === names[names.length - 1])
			: first;
		return {
			first,
			total: flat.length,
			pos: it.batch && last > first ? (first + 1) + '–' + (last + 1) : String(first + 1),
			prev: first > 0 ? flat[first - 1] : null,
			next: last >= 0 && last < flat.length - 1 ? flat[last + 1] : null,
		};
	}

	// Tooltip butang Prev/Next — nama group + trip.
	function nav_label(m) {
		if (!m) return '';
		const trip = m.trip_name || m.trip_group_name || '';
		return (m.name || '') + (trip ? ' — ' + trip : '');
	}

	function render_detail(it) {
		S.state[it.key] = S.state[it.key] || default_state();
		$('#mba-detail').html(`
			<div class="mba-group mba-detail ${it.batch ? 'mba-group--batch' : ''}" data-item="${esc(it.key)}">
				${render_detail_header(it)}
				${render_tab_bar(it)}
				<div class="mba-tab-panes">${TABS.map((t) => `
					<div class="mba-tab-pane ${S.state[it.key].tab === t.id ? 'active' : ''}" data-pane="${t.id}">
						${S.state[it.key].tab === t.id ? `<div class="mba-loading">${__('Loading...')}</div>` : ''}
					</div>`).join('')}
				</div>
			</div>`);
	}

	function render_detail_header(it) {
		const a = it.agg;
		const single = !it.batch && it.members.length === 1;
		const g0 = it.members[0];

		const titleLine = it.batch ? it.batch : g0.name;
		const subLine = single && g0.trip_group_name && g0.trip_group_name !== g0.name
			? esc(g0.trip_group_name) : '';

		const statuses = [...new Set(it.members.map((m) => m.status))];
		const statusBadges = statuses.map((s) => badge(s, GROUP_STATUS_COLORS[s])).join(' ');
		const batchBadge = it.batch ? badge(it.members.length + ' ' + __('groups'), 'violet') : '';

		// Batch — senarai group anggota; klik → detail group itu.
		const memberChips = (!single && it.members.length)
			? `<div class="mba-member-chips">${it.members.map((m) => `
				<button type="button" class="mba-chip mba-member-chip" data-group="${esc(m.name)}"
					title="${esc(__('Open group detail'))}">
					<b>${esc(m.name)}</b>
					${[m.trip_name || '', group_dates_label(m)].filter(Boolean)
						.map((line) => `<span class="mba-chip-sub">${esc(line)}</span>`).join('')}
				</button>`).join('')}</div>`
			: '';

		const tripNames = [...new Set(it.members
			.map((m) => m.trip_name || m.trip_group_name || '').filter(Boolean))];
		const ships = [...new Set(it.members.map((m) => m.ship_name || '').filter(Boolean))];
		const dateLabel = single ? group_dates_label(g0)
			: (a.depart ? fmtDate(a.depart) + (a.ret && a.ret !== a.depart ? ' → ' + fmtDate(a.ret) : '') : '');

		// Kiraan hari ke tarikh pergi — hanya bila status item Active
		// (semua group anggota Active) dan tarikh masih akan datang.
		// Sasaran = tarikh mula julat yang dipaparkan (single → tarikh
		// group itu, batch → tarikh pergi terawal anggota).
		const isActive = statuses.length === 1 && statuses[0] === 'Active';
		const daysLeft = isActive
			? days_left_label(single ? group_depart_date(g0) : a.depart) : '';

		const infoBits = [
			tripNames.length ? `<span title="${esc(tripNames.join(', '))}">${esc(tripNames.join(', '))}</span>` : '',
			dateLabel ? `<span>${esc(dateLabel)}${daysLeft
				? ` <span class="mba-days-left">${esc(daysLeft)}</span>` : ''}</span>` : '',
			ships.length ? `<span>${esc(__('Ship'))}: ${esc(ships.join(', '))}</span>` : '',
			single && (g0.total_days || g0.total_nights)
				? `<span>${esc((g0.total_days || '—') + ' ' + __('days') + ' / ' + (g0.total_nights || '—') + ' ' + __('nights'))}</span>` : '',
		].filter(Boolean).join('');

		// Prev/Next — group sebelum/sesudah dalam turutan senarai L1 yang
		// sama (filter semasa). Sentiasa ke /group/<name>. Tertungging bila
		// item tiada dalam senarai (deep-link) atau senarai hanya satu group.
		const nav = detail_nav(it);
		const navBtns = (nav.first >= 0 && nav.total > 1) ? `
			<div class="mba-nav-btns">
				<button type="button" class="btn btn-default btn-sm mba-nav-prev"
					data-group="${esc(nav.prev ? nav.prev.name : '')}"
					title="${esc(nav_label(nav.prev))}"
					${nav.prev ? '' : 'disabled'}>‹ ${__('Prev')}</button>
				<span class="mba-nav-pos">${esc(nav.pos)}/${nav.total}</span>
				<button type="button" class="btn btn-default btn-sm mba-nav-next"
					data-group="${esc(nav.next ? nav.next.name : '')}"
					title="${esc(nav_label(nav.next))}"
					${nav.next ? '' : 'disabled'}>${__('Next')} ›</button>
			</div>` : '';

		return `
			<div class="mba-detail-head">
				<div class="mba-detail-actions">
					<button type="button" class="btn btn-default btn-sm mba-back-btn">${__('← All Groups')}</button>
					${single ? `<button type="button" class="btn btn-default btn-sm mba-open-form" data-group="${esc(g0.name)}">${__('Open Trip Group Date')}</button>` : ''}
					${navBtns}
				</div>
				<div class="mba-detail-title">
					<span class="mba-detail-name">${esc(titleLine)}</span>
					${it.batch ? `
					<button type="button" class="btn btn-default btn-xs mba-rename-batch"
						title="${esc(__('Rename batch'))}" aria-label="${esc(__('Rename batch'))}">
						${frappe.utils.icon('pencil', 'sm')}</button>` : ''}
					${subLine ? `<span class="mba-cell-sub">${subLine}</span>` : ''}
					${statusBadges} ${batchBadge}
				</div>
				${infoBits ? `<div class="mba-detail-sub">${infoBits}</div>` : ''}
				${memberChips}
			</div>`;
	}

	function render_tab_bar(it) {
		const st = S.state[it.key];
		const counts = tab_counts(it.key, it);
		return `<div class="mba-tabs">${TABS.map((t) => `
			<button class="mba-tab ${st.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}
				${counts[t.id] != null ? `<span class="mba-count-pill">${counts[t.id]}</span>` : ''}
			</button>`).join('')}</div>`;
	}

	function tab_counts(key, it) {
		const c = S.cache[key] || {};
		return {
			overview: null,
			booking: c.bookings?.count ?? it.agg.booking_count,
			traveller: c.travellers?.count ?? it.agg.pax,
			rooming: c.rooming?.count ?? it.agg.rooms,
			flights: c.flights?.count ?? null,
			addons: c.addons?.count ?? null,
		};
	}

	function update_tab_counts(key) {
		const it = find_item(key);
		if (!it) return;
		const counts = tab_counts(key, it);
		const $g = item_el(key);
		TABS.forEach((t) => {
			if (counts[t.id] == null) return;
			$g.find(`.mba-tab[data-tab="${t.id}"] .mba-count-pill`).text(counts[t.id]);
		});
	}

	function ensure_tab_loaded(key) {
		const st = S.state[key] || (S.state[key] = default_state());
		load_tab(key, st.tab);
	}

	function switch_tab(key, tab) {
		if (!key || key.startsWith('bkg:')) {
			// L3 — tab paparan sahaja, KECUALI Travellers, Rooms dan
			// Add-ons & Flights yang dimuatkan lazily daripada API.
			const $g = $('#mba-detail').find('.mba-group').filter(function () { return $(this).data('item') === key; });
			$g.find('.mba-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
			$g.find('.mba-tab-pane').removeClass('active').filter(`[data-pane="${tab}"]`).addClass('active');
			if (tab === 'tv') load_bkg_travellers(key);
			if (tab === 'rm') load_bkg_rooms(key);
			if (tab === 'af') load_bkg_af(key);
			return;
		}
		const st = S.state[key] || (S.state[key] = default_state());
		if (st.tab === tab) return;
		st.tab = tab;
		const $g = item_el(key);
		$g.find('.mba-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
		$g.find('.mba-tab-pane').removeClass('active').filter(`[data-pane="${tab}"]`).addClass('active');
		load_tab(key, tab);
	}

	async function load_tab(key, tab, force = false) {
		const it = find_item(key);
		const st = S.state[key] || (S.state[key] = default_state());
		if (!it) return;

		const groups = item_groups(it);
		const $pane = pane_el(key, tab);
		const is_active = () => st.tab === tab && S.mode === 'detail'
			&& S.detail && S.detail.key === key;

		if (tab === 'overview') {
			if (!force && S.cache[key]?.dashboard) {
				if (is_active()) render_overview(key);
				return;
			}
			if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading dashboard...')}</div>`);
			const d = await api('get_group_dashboard', { trip_groups: groups });
			S.cache[key] = { ...(S.cache[key] || {}), dashboard: d };
			if (is_active()) render_overview(key);
			return;
		}

		if (tab === 'booking') {
			// Tab Booking — paket generik TravelBookingBookingList
			// (public/js/booking_list.js): komponen milik kitaran penuh
			// sendiri (fetch + toolbar + render + event). Instance disimpan
			// dalam cache; dibina semula bila pane sudah dijana semula
			// (render_detail) — state kekal hidup dalam S.state[key].bk.
			let comp = S.cache[key]?.bklist;
			if (!comp || !comp.is_attached()) {
				const st = S.state[key] || (S.state[key] = default_state());
				comp = window.TravelBookingBookingList.create($pane, {
					state: st.bk,
					trip_groups: groups,
					group_options: it.members.length > 1
						? it.members.map((m) => ({ name: m.name, trip_name: m.trip_name })) : null,
					currency: S.currency,
					currency_filter: true,
					columns: 'compact',
					on_loaded: (bk) => {
						S.cache[key] = { ...(S.cache[key] || {}), bookings: bk };
						update_tab_counts(key);
					},
					// Klik baris/kad/kolum Booking No → page Booking Info (L3).
					on_open_booking: (name) => frappe.set_route('manage-booking-app', 'booking', name),
				});
				S.cache[key] = { ...(S.cache[key] || {}), bklist: comp };
			}
			if (comp) comp.load(force);
			return;
		}

		if (tab === 'traveller') {
			await ensure_tv_filter_fields();   // medan penapis dinamik (cache)
			if (!force && S.cache[key]?.travellers) {
				if (is_active()) render_travellers_tab(key);
				return;
			}
			if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading travellers...')}</div>`);
			const tv = await api('get_group_travellers', {
				trip_groups: st.tv.group ? [st.tv.group] : groups,
				search: st.tv.search || null,
				doc_status: st.tv.doc_status || null,
				custom_filters: tv_cf_active(st.tv.custom),
				custom_match: st.tv.cf_match === 'OR' ? 'OR' : 'AND',
				limit: st.tv.limit,
			});
			S.cache[key] = { ...(S.cache[key] || {}), travellers: tv };
			if (is_active()) { render_travellers_tab(key); update_tab_counts(key); }
			return;
		}

		if (tab === 'rooming') {
			if (!force && S.cache[key]?.rooming) {
				if (is_active()) render_rooming_tab(key);
				return;
			}
			if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading rooming...')}</div>`);
			const rm = await api('get_group_rooming', {
				trip_groups: groups,
				search: st.rm.search || null,
				privacy: st.rm.privacy || null,
				limit: st.rm.limit,
			});
			S.cache[key] = { ...(S.cache[key] || {}), rooming: rm };
			if (is_active()) { render_rooming_tab(key); update_tab_counts(key); }
			return;
		}

		if (tab === 'flights') {
			// Tab Flights — flight rujukan group (dimuatkan lazily).
			const needFl = force || !S.cache[key]?.flights;
			if ($pane.length && needFl) $pane.html(`<div class="mba-loading">${__('Loading...')}</div>`);
			if (needFl) {
				const fl = await api('get_group_flights', {
					trip_groups: groups,
					search: st.fl.search || null,
					limit: st.fl.limit,
				});
				S.cache[key] = { ...(S.cache[key] || {}), flights: fl };
			}
			if (is_active()) { render_flights_tab(key); update_tab_counts(key); }
			return;
		}

		if (tab === 'addons') {
			// Tab Addons — Booking Addon (dimuatkan lazily).
			const needAd = force || !S.cache[key]?.addons;
			if ($pane.length && needAd) $pane.html(`<div class="mba-loading">${__('Loading...')}</div>`);
			if (needAd) {
				const ad = await api('get_group_addons', {
					trip_groups: st.ad.group ? [st.ad.group] : groups,
					status: st.ad.status || null,
					payment_status: st.ad.payment || null,
					search: st.ad.search || null,
					limit: st.ad.limit,
				});
				S.cache[key] = { ...(S.cache[key] || {}), addons: ad };
			}
			if (is_active()) { render_addons_tab(key); update_tab_counts(key); }
			return;
		}
	}

	/* ---------- helper render kecil ---------- */

	const limit_options = (scope, cur) =>
		`<select data-kind="limit" data-scope="${scope}">${ROW_LIMITS.map((n) =>
			`<option value="${n}" ${n === cur ? 'selected' : ''}>${n === 0 ? __('All rows') : __('{0} rows', [n])}</option>`).join('')}</select>`;

	const group_filter_options = (members, cur, scope) =>
		`<select data-kind="group" data-scope="${scope}">${['',
			...members.map((m) => m.name)].map((v) => {
				const label = v
					? `${v} · ${(members.find((m) => m.name === v) || {}).trip_name || ''}`
					: __('All Group Dates');
				return `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label).trim()}</option>`;
			}).join('')}</select>`;

	const showing_footer = (data, label, scope) => {
		if (!data) return '';
		const more = data.count > data.shown;
		return `
			<div class="mba-showing">
				<span>${__('Showing {0} of {1} {2}', [data.shown, data.count, label])}</span>
				${more ? `<button class="btn btn-default btn-xs mba-load-more" data-scope="${scope || ''}">${__('Load more')}</button>` : ''}
			</div>`;
	};

	// Senarai pecahan — label + nombor sahaja (tiada bar) untuk panel
	// wang/jumlah (diskaun, bilik, affiliate).
	const breakdown_rows = (rows, fmtVal) => rows.map((r) => `
		<div class="mba-bd-row">
			<span class="mba-bd-label" title="${esc(r.label)}">${r.label}</span>
			<span class="mba-bd-value">${fmtVal ? fmtVal(r) : r.value}</span>
		</div>`).join('');

	// Pasangan label/kiraan daripada baris breakdown backend (cth.
	// booking_status / payment_status) untuk donut — buang kiraan 0.
	const pairs_from = (rows, labelKey, countKey) => (rows || [])
		.filter((r) => (r[countKey] || 0) > 0)
		.map((r) => ({ label: r[labelKey] || '-', value: r[countKey] || 0 }));

	// Pasangan label/kiraan departure point untuk donut — label kosong
	// = pakej tanpa airport (ground/cruise only) → 'Not set'.
	const dep_pairs = (d) => (d?.departure_point || [])
		.map((r) => ({ label: r.departure_point || __('Not set'), value: r.count || 0 }))
		.filter((p) => p.value > 0);

	// Pasangan company & package type (kiraan Booking Reservation).
	const company_pairs = (d) => (d?.company_breakdown || [])
		.map((r) => ({ label: r.company || __('Not set'), value: r.count || 0 }))
		.filter((p) => p.value > 0);
	const package_pairs = (d) => (d?.package_type || [])
		.map((r) => ({ label: r.package_type || __('Not set'), value: r.count || 0 }))
		.filter((p) => p.value > 0);

	// Pasangan status dokumen traveller (pax) untuk donut.
	const doc_pairs = (d) => (d?.doc_status || [])
		.map((r) => ({ label: r.doc_status || __('Not set'), value: r.count || 0 }))
		.filter((p) => p.value > 0);

	// Pasangan kategori bilik (jumlah bilik) untuk donut.
	const room_pairs = (d) => (d?.rooms?.by_category || [])
		.map((r) => ({ label: r.category || __('Not set'), value: r.rooms || 0 }))
		.filter((p) => p.value > 0);

	// Pasangan room privacy (pax) untuk donut — kosong = bilik belum
	// dikonfirmasi → 'Not set'.
	const privacy_pairs = (d) => (d?.room_privacy || [])
		.map((r) => ({ label: r.room_privacy || __('Not set'), value: r.count || 0 }))
		.filter((p) => p.value > 0);

	// Pasangan umur & jantina traveller untuk donut.
	const age_pairs = (d) => {
		const age = d?.travellers?.age_breakdown || {};
		return [
			[__('Infant'), age.infant], [__('Child'), age.child],
			[__('Adult'), age.adult], [__('Unknown'), age.unknown],
		].filter(([, v]) => v > 0).map(([label, value]) => ({ label, value }));
	};
	const gender_pairs = (d) => Object.keys(d?.travellers?.gender_breakdown || {})
		.map((k) => ({ label: k, value: d.travellers.gender_breakdown[k] }))
		.filter((p) => p.value > 0);

	/* ---------- L2 Tab Overview ---------- */

	function render_overview(key) {
		const d = S.cache[key]?.dashboard;
		const it = find_item(key);
		if (!d || !it) return;

		const rooms = d.rooms || {};
		const fin = d.finance || {};
		const dsc = d.discount || {};
		const trv = d.travellers || {};
		const occ = d.occupancy || {};
		const bkg = d.bookings || {};
		const tl = d.revenue_timeline || {};
		const aff = d.affiliate_breakdown || [];

		// Pecahan per currency — sumber kebenaran semua angka wang.
		const fbCur = fin.currency || S.currency;
		const revRows = (fin.revenue_by_currency && fin.revenue_by_currency.length)
			? fin.revenue_by_currency
				.map((r) => ({ ...r, balance: r.balance ?? round2((r.revenue || 0) - (r.collected || 0)) }))
			: (fin.revenue != null
				? [{
					currency: fbCur, revenue: fin.revenue, collected: fin.collected,
					balance: fin.balance ?? round2(fin.revenue - (fin.collected || 0)),
				}]
				: []);
		const addonRows = (fin.addon_revenue_by_currency && fin.addon_revenue_by_currency.length)
			? fin.addon_revenue_by_currency
			: (fin.addon_revenue != null ? [{ currency: fbCur, revenue: fin.addon_revenue }] : []);

		const dt = fin.default_totals;
		const revAlt = hasAltCur(revRows) && dt;
		const defaultTotalValue = (field) => (revAlt
			? fmtDefaultTotal(dt, field)
			: fmtMoney((dt && dt[field]) || 0, S.currency));

		const kpis = [
			{
				label: __('Bookings'), value: bkg.active ?? 0,
				sub: (bkg.addon_orders ?? 0) + ' ' + __('addon orders'),
			},
			{
				cls: 'is-danger', label: __('Pending Docs'), value: trv.pending_docs ?? 0,
				sub: `${__('Submitted')} ${trv.docs_submitted ?? 0}/${trv.pax || 0} · ${trv.docs_ok ?? 0} ${__('verified')}`,
			},
			{
				cls: 'is-success', label: __('Revenue'), value: defaultTotalValue('revenue'),
				sub: revRows.map((r) => fmtMoney(r.revenue, r.currency)).join('<br>') || fmtMoney(0, S.currency),
				title: __('Per currency — amounts in different currencies are never summed'),
			},
			{
				cls: 'is-warn', label: __('Unpaid Balance'), value: defaultTotalValue('balance'),
				sub: revRows.map((r) => fmtMoney(r.balance, r.currency)).join('<br>') || fmtMoney(0, S.currency),
				title: __('Per currency — amounts in different currencies are never summed'),
			},
		];
		const kpiHtml = kpis.map((k) => `
			<div class="mba-kpi ${k.cls || ''}" ${k.title ? `title="${esc(k.title)}"` : ''}>
				<div class="mba-kpi-label">${esc(k.label)}</div>
				<div class="mba-kpi-value">${k.value}</div>
				<div class="mba-kpi-sub">${k.sub}</div>
			</div>`).join('');

		const secLine = [
			`<span><b>${rooms.total ?? 0}</b> ${__('Rooms')}</span>`,
			occ.pct != null
				? `<span><b>${occ.pax}/${occ.capacity}</b> ${__('Occupancy')} (${occ.pct}%)</span>`
				: `<span><b>${occ.pax || 0}</b> ${__('pax')}</span>`,
			addonRows.length
				? `<span><b>${addonRows.map((r) => fmtMoney(r.revenue, r.currency)).join(' · ')}</b> ${__('Addons')}</span>`
				: '',
		].filter(Boolean).join('');

		// Analytics — panel donut chart + senarai pecahan; blok kosong
		// dilangkau. Donut dilukis selepas html dipasang (render_donuts).
		const anBlock = (title, rowsHtml) => (rowsHtml
			? `<div class="mba-an-block"><div class="mba-an-title">${esc(title)}</div>${rowsHtml}</div>` : '');

		// Panel donut — placeholder sahaja; SVG + legend dibina
		// render_donuts() bila panel sudah di-DOM (dan selepas <details>
		// dibuka pada telefon, bila clientWidth sah).
		const anDonut = (title, pairs, name) => (pairs.length
			? anBlock(title, `<div class="mba-donut-block" data-donut="${esc(name)}"></div>`) : '');

		const statusPairs = (rows, labelKey, countKey) => pairs_from(rows, labelKey, countKey);

		const dscDt = dsc.default_totals
			|| { currency: S.currency, voucher: 0, price_rule: 0, referral: 0, total: 0 };
		const dscList = [
			{ label: __('Voucher'), value: dscDt.voucher || 0 },
			{ label: __('Price Rule'), value: dscDt.price_rule || 0 },
			{ label: __('Referral'), value: dscDt.referral || 0 },
		].filter((r) => r.value > 0);
		const dscHtml = dscList.length
			? breakdown_rows(dscList, (r) => fmtMoney(r.value, dscDt.currency))
				+ `<div class="mba-bd-row"><span class="mba-bd-label">${__('Voucher redemptions')}</span><b>${dsc.voucher_usage_count ?? 0}</b></div>`
			: '';

		const affHtml = aff.length
			? breakdown_rows(aff.map((r) => ({ label: r.affiliate, value: r.count })))
			: '';

		// Pecahan DOB dalam julat tarikh trip — senarai traveller dimuat
		// lazy, jadi blok dipasang dengan placeholder dahulu dan dikemaskini
		// load_dob_breakdown() bila senarai tiba.
		const dobRows = dob_breakdown_rows(key);
		const dobInner = dob_block_html(dobRows, !!S.cache[key]?.tvAll);
		const dobBlockHtml = dobInner ? `<div data-dob-block>${dobInner}</div>` : '';

		// Analytics — tiga panel berasingan, setiap satu <details> boleh
		// lipat. Panel kosong tak dipaparkan.
		const anPanel = (title, bodyHtml) => (bodyHtml
			? `<details class="mba-analytics" ${isDesktop() ? 'open' : ''}>
				<summary>${esc(title)}</summary>
				<div class="mba-an-grid">${bodyHtml}</div></details>` : '');

		const analytics = [
			anPanel(__('Booking Analytics'), [
				anDonut(__('Booking Status'), statusPairs(d.booking_status, 'status', 'count'), 'bkstatus'),
				anDonut(__('Payment Status'), statusPairs(d.payment_status, 'status', 'count'), 'paystatus'),
				anDonut(__('Booking Channel'), statusPairs(d.booking_channel, 'channel', 'count'), 'channel'),
				anDonut(__('Checkout Method'), statusPairs(d.checkout_method, 'method', 'count'), 'checkout'),
			].join('')),
			anPanel(__('Travellers Analytics'), [
				anDonut(__('Package Type'), package_pairs(d), 'pkgtype'),
				anDonut(__('Departure Point'), dep_pairs(d), 'dep'),
				anDonut(__('Rooms by Category'), room_pairs(d), 'roomcat'),
				anDonut(__('Room Privacy'), privacy_pairs(d), 'privacy'),
				anDonut(__('Document Status'), doc_pairs(d), 'docstat'),
				anDonut(__('Traveller Age'), age_pairs(d), 'age'),
				anDonut(__('Gender'), gender_pairs(d), 'gender'),
				anDonut(__('Company'), company_pairs(d), 'company'),
			].join('')),
			anPanel(__('Breakdown Analytics'), [
				dobBlockHtml,
				anBlock(__('Discount by Type'), dscHtml),
				anBlock(__('Affiliate'), affHtml),
			].join('')),
		].join('');

		const $pane = pane_el(key, 'overview');
		$pane.html(`
			<div class="mba-kpi-grid">${kpiHtml}</div>
			${secLine ? `<div class="mba-sec-line">${secLine}</div>` : ''}
			<details class="mba-panel mba-tl-sec" ${isDesktop() ? 'open' : ''}>
				<summary class="mba-panel-head">${__('Revenue Timeline')}
					<span class="mba-panel-tools">
						<span class="mba-panel-sub">${__('Bar = sales · Line = cumulative, current rates')} · ≈ ${esc(tl.currency || S.currency)}${tl.rates_complete === false ? ' +' : ''}</span>
						<select class="mba-tl-select" name="tl_gran" title="${__('Time scale of the chart — full range from first to last booking order')}">
							<option value="day" ${S.tl.gran === 'day' ? 'selected' : ''}>${__('Daily')}</option>
							<option value="week" ${S.tl.gran === 'week' ? 'selected' : ''}>${__('Weekly')}</option>
							<option value="month" ${S.tl.gran === 'month' ? 'selected' : ''}>${__('Monthly')}</option>
						</select>
					</span>
				</summary>
				<div class="mba-panel-body mba-chart" data-chart="rev-tl"></div>
			</details>
			${analytics}`);

		// Carta dilukis hanya bila bekas kelihatan — details tertutup bermakna
		// clientWidth 0 (SVG lebar salah). Bila mana-mana details dibuka,
		// listener toggle di bawah lukis semula kandungan scope tersebut.
		const $tlChart = $pane.find('[data-chart="rev-tl"]');
		if (!$tlChart.parents('details:not([open])').length) render_tl_chart($tlChart, tl);
		render_donuts($pane, d);
		load_dob_breakdown(key);

		// Native listener (toggle tak bubble — delegation jQuery tak boleh
		// dipakai). Buka semula → lukis semula donut/chart dalam panel itu;
		// paksa redraw supaya SVG lapuk berlebar salah turut dibaiki.
		$pane.find('.mba-tl-sec, .mba-analytics').each(function () {
			this.addEventListener('toggle', () => {
				if (!this.open) return;
				if (this.classList.contains('mba-tl-sec')) {
					render_tl_chart($(this).find('[data-chart="rev-tl"]'), tl);
				} else {
					render_donuts($(this), d, true);
				}
			});
		});
	}

	/* ---------- Pecahan DOB dalam julat trip (tab Overview) ---------- */

	// Traveller yang tarikh lahir penuhnya jatuh dalam julat tarikh trip —
	// semantik sama dengan badge DOB merah tab Travellers (semakan
	// kemasukan data). Batch = mula terawal / tamat terakhir ahli.
	// Susunan ikut DOB menaik. [] bila senarai traveller belum dimuatkan.
	function dob_breakdown_rows(key) {
		const it = find_item(key);
		const tvAll = S.cache[key]?.tvAll;
		if (!it || !tvAll) return [];
		const starts = it.members
			.map((m) => String(m.sailing_start || m.departure_date || '').slice(0, 10))
			.filter(Boolean).sort();
		const ends = it.members
			.map((m) => String(m.sailing_end || m.return_date || '').slice(0, 10))
			.filter(Boolean).sort();
		const tripStart = starts[0] || '';
		const tripEnd = ends[ends.length - 1] || '';
		if (!tripStart || !tripEnd) return [];
		return (tvAll.travellers || [])
			.filter((t) => {
				const dd = String(t.dob || '').slice(0, 10);
				return dd >= tripStart && dd <= tripEnd;
			})
			.sort((a, b) => String(a.dob || '').localeCompare(String(b.dob || '')));
	}

	// Baris pecahan — nama boleh klik (data-trav JSON penuh, corak kad tab
	// Travellers supaya modal maklumat penuh terus boleh dibuka) + DOB.
	const dob_breakdown_html = (rows) => rows.map((t) => `
		<div class="mba-bd-row">
			<a class="mba-bd-label mba-dob-link" role="button"
				data-trav="${esc(JSON.stringify(t))}"
				title="${esc(__('Open traveller details'))}">${esc(t.traveller_name || t.guest_label || '-')}</a>
			<span class="mba-bd-value">${esc(fmtDate(String(t.dob || '').slice(0, 10)))}</span>
		</div>`).join('');

	// Kandungan blok pecahan — baris nama+DOB. Tiada padanan → '' (blok
	// dilangkau, sama macam blok pecahan lain); 'Loading...' hanya
	// dipapar sebelum senarai traveller selesai dimuat.
	const dob_block_html = (rows, loaded) => (loaded && !rows.length
		? ''
		: `<div class="mba-an-block"><div class="mba-an-title">${esc(__('DOB on Trip'))}</div>
		${loaded ? dob_breakdown_html(rows)
			: `<div class="mba-bd-row"><span class="mba-muted">${__('Loading...')}</span></div>`}</div>`);

	// Muat senarai traveller penuh (tanpa tapisan/limit tab) untuk pecahan
	// DOB — cache tvAll berasingan daripada cache tab Travellers yang
	// dipandu state tab. Selesai → kemaskini blok pane Overview terbuka.
	function load_dob_breakdown(key) {
		const it = find_item(key);
		if (!it || S.cache[key]?.tvAll || S.tvAllJobs[key]) return;
		S.tvAllJobs[key] = api('get_group_travellers', { trip_groups: item_groups(it), limit: 0 })
			.then((tv) => {
				S.cache[key] = { ...(S.cache[key] || {}), tvAll: tv || { travellers: [], count: 0 } };
				update_dob_block(key);
			})
			.catch(() => { /* placeholder kekal — render overview semula mencuba lagi */ })
			.finally(() => { delete S.tvAllJobs[key]; });
	}

	// Kemaskini blok pecahan DOB dalam pane Overview sedia ada. Pane sudah
	// tiada (user pindah tab/detail) → biarkan; render berikutnya baca cache.
	function update_dob_block(key) {
		const $blk = pane_el(key, 'overview').find('[data-dob-block]');
		if (!$blk.length) return;
		const html = dob_block_html(dob_breakdown_rows(key), true);
		if (html) $blk.html(html);
		else $blk.remove();   // senarai kosong — buang blok terus
	}

	// Lukis semua donut Analytics dalam pane yang diberi. Placeholder
	// [data-donut] tanpa SVG sahaja yang dilukis — dipanggil semula oleh
	// handler toggle <details> bila panel dibuka pada telefon (lebar 0).
	function render_donuts($pane, d, force) {
		if (!$pane || !$pane.length) return;
		const defs = [
			{ name: 'bkstatus', pairs: pairs_from(d.booking_status, 'status', 'count'), ds: __('Bookings'), center: __('Bookings') },
			{ name: 'paystatus', pairs: pairs_from(d.payment_status, 'status', 'count'), ds: __('Payments'), center: __('Bookings') },
			{ name: 'channel', pairs: pairs_from(d.booking_channel, 'channel', 'count'), ds: __('Bookings'), center: __('Bookings') },
			{ name: 'checkout', pairs: pairs_from(d.checkout_method, 'method', 'count'), ds: __('Bookings'), center: __('Bookings') },
			{ name: 'dep', pairs: dep_pairs(d), ds: __('Travellers'), center: __('pax') },
			{ name: 'company', pairs: company_pairs(d), ds: __('Travellers'), center: __('pax') },
			{ name: 'pkgtype', pairs: package_pairs(d), ds: __('Travellers'), center: __('pax') },
			{ name: 'docstat', pairs: doc_pairs(d), ds: __('Travellers'), center: __('pax') },
			{ name: 'roomcat', pairs: room_pairs(d), ds: __('Rooms'), center: __('Rooms') },
			{ name: 'privacy', pairs: privacy_pairs(d), ds: __('Travellers'), center: __('pax') },
			{ name: 'age', pairs: age_pairs(d), ds: __('Travellers'), center: __('pax') },
			{ name: 'gender', pairs: gender_pairs(d), ds: __('Travellers'), center: __('pax') },
		];
		$pane.find('[data-donut]').each(function () {
			const $el = $(this);
			if ($el.parents('details:not([open])').length) return;  // tersembunyi — lukis bila dibuka
			if (!force && $el.find('svg').length) return;   // sudah dilukis
			const def = defs.find((x) => x.name === $el.data('donut'));
			if (def) render_donut($el, def.pairs, def.ds, def.center);
		});
	}

	// Combo chart — bar = jualan tempoh, garis = kumulatif (frappe-charts).
	function render_tl_chart($el, tl) {
		const points = tl_aggregate(tl.points || [], S.tl.gran);
		if (!points.length || points.every((p) => !p.cumulative)) {
			$el.html(`<div class="mba-empty" style="padding:14px">${__('No bookings yet.')}</div>`);
			return;
		}
		const pts = points.length === 1
			? [{ key: '', revenue: 0, cumulative: 0 }, ...points]
			: points;

		frappe.utils.make_chart($el[0], {
			type: 'axis-mixed',
			data: {
				labels: pts.map((p) => {
					if (!p.key) return '';
					if (S.tl.gran === 'week') return 'W' + p.key.slice(-2) + ' ' + p.key.slice(0, 4);
					if (S.tl.gran === 'day') {
						const [y, m, d] = p.key.split('-');
						return (+d) + ' ' + (MONTHS[(+m) - 1] || m) + ' ' + y;
					}
					const [y, m] = p.key.split('-');
					return (MONTHS[(+m) - 1] || m) + ' ' + y;
				}),
				datasets: [
					{ name: __('Total Sales'), chartType: 'bar', values: pts.map((p) => p.revenue) },
					{ name: __('Cumulative'), chartType: 'line', values: pts.map((p) => p.cumulative) },
				],
			},
			height: 270,   // +50% dari 180 — panel timeline kini boleh lipat
			lineOptions: { regionFill: 1, heatline: false },
			colors: [frappe.utils.get_chart_palette()[0], frappe.utils.get_chart_palette()[3]],
			showLegend: true,
			tooltipOptions: {
				formatTooltipY: (v) => '≈ ' + fmtMoney(v, tl.currency || S.currency),
			},
		});
	}

	// Donut chart panel Analytics — pusat = jumlah kiraan; legend HTML
	// mendatar (titik warna + label + kiraan + %) — pola legend pie chart
	// page lama (legend SVG frappe-charts tidak digunakan).
	function render_donut($el, pairs, name, centerLabel) {
		if (!$el || !$el.length || !pairs || !pairs.length) return;
		const palette = frappe.utils.get_chart_palette();
		const colors = pairs.map((_, i) => palette[i % palette.length]);
		const total = pairs.reduce((s, p) => s + p.value, 0);
		$el.html(`
			<div class="mba-chart mba-donut-svg"></div>
			<div class="mba-donut-legend">${pairs.map((p, i) => `
				<span class="mba-donut-legend-item" title="${esc(p.label)}">
					<span class="mba-donut-legend-dot" style="background:${esc(colors[i])}"></span>
					<span class="mba-donut-legend-label">${esc(p.label)}</span>
					<b>${p.value}</b>
					<span class="mba-donut-legend-pct">${total ? Math.round(p.value / total * 100) : 0}%</span>
				</span>`).join('')}</div>`);
		frappe.utils.make_chart($el.find('.mba-donut-svg')[0], {
			type: 'donut',
			data: {
				labels: pairs.map((p) => p.label),
				datasets: [{ name: name || __('Bookings'), values: pairs.map((p) => p.value) }],
			},
			height: 180,
			maxSlices: 8,
			colors,
			showLegend: false,
			center: { value: String(total), label: centerLabel || '' },
			tooltipOptions: { formatTooltipY: (v) => String(v) },
		});
	}

	// Titik harian ('YYYY-MM-DD') → bucket ikut skala (day/week/month);
	// minggu = minggu ISO. Cumulative dikira semula dalam paparan terpilih.
	const tl_bucket = (dateStr, gran) => {
		if (gran === 'day') return dateStr;
		if (gran === 'month') return dateStr.slice(0, 7);
		const t = new Date(dateStr + 'T00:00:00Z');
		const dayNum = t.getUTCDay() || 7;
		t.setUTCDate(t.getUTCDate() + 4 - dayNum);
		const iy = t.getUTCFullYear();
		const w = Math.ceil((((t - Date.UTC(iy, 0, 1)) / 864e5) + 1) / 7);
		return iy + '-W' + String(w).padStart(2, '0');
	};

	const tl_aggregate = (points, gran) => {
		const out = [];
		const idx = new Map();
		for (const p of points) {
			const key = tl_bucket(p.ym, gran);
			if (!idx.has(key)) {
				const b = { key, revenue: 0, cumulative: 0 };
				idx.set(key, b);
				out.push(b);
			}
			idx.get(key).revenue = round2(idx.get(key).revenue + p.revenue);
		}
		let run = 0;
		for (const b of out) {
			run = round2(run + b.revenue);
			b.cumulative = run;
		}
		return out;
	};

	/* ---------- L2 Tab Travellers — guna paket generik render_traveller_list
	   (kad + jadual + aksi + Order By) dengan tapisan SERVER sebagai extras
	   toolbar: carian, tapisan group, doc status & limit (reload via
	   load_tab). Kolum Booking aktif — baris merentas pelbagai booking. ---------- */

	// ══ SUB-PACKAGE SENARAI TRAVELLER ══
	// Keseluruhan komponen senarai traveller (penapis, ringkasan, grid/
	// jadual, modal, dialog, cache) dipindahkan ke traveller_list.js dan
	// di-include di sini — concatenation server-side oleh render_include,
	// scope IIFE page kekal sama (semua rujukan silang berfungsi).
	{% include "travel_booking/module_admin_portal/page/manage_booking_app/traveller_list.js" %}
	/* ---------- PAKEJ SENARAI BILIK ----------
	   Grid kad bilik read-only (rooms_list.js) — komponen mandiri dengan
	   API rooms_list_html(rm) / mount_rooms_list($el, rm, opts); boleh
	   digunakan oleh mana-mana tab/page yang ada payload
	   get_group_rooming. Di-include di sini — concatenation server-side
	   oleh render_include, scope IIFE page kekal sama. ---------- */
	{% include "travel_booking/module_admin_portal/page/manage_booking_app/rooms_list.js" %}

	/* ---------- L2 Tab Rooms (rooming) ----------
	   Senarai bilik (pakej rooms_list.js di atas) + papan susun atur
	   Kanban Rooming Board (rooming_board.js) — di-include di sini,
	   concatenation server-side oleh render_include, scope IIFE page
	   kekal sama (corak traveller_list.js). ---------- */

	{% include "travel_booking/module_admin_portal/page/manage_booking_app/rooming_board.js" %}

	/* ---------- L2 Tab Flights (dipisah dari bekas Tab More) ---------- */

	function render_flights_tab(key) {
		const fl = S.cache[key]?.flights;
		const st = S.state[key];
		if (!fl || !st) return;

		const flRows = fl.flights || [];
		const route = (f) => [f.home_airport, f.destination_airport].filter(Boolean).join(' → ');

		const flCards = flRows.map((f) => `
			<div class="mba-bkcard" data-route="Flight/${esc(f.name)}">
				<div class="mba-bkcard-top">
					<span class="mba-bkcard-no">${esc(f.pnr)}</span>
					${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}
				</div>
				<div class="mba-bkcard-cust">${f.airline ? esc(f.airline_name || f.airline) : '—'}</div>
				<div class="mba-bkcard-meta">${route(f) ? esc(route(f)) : ''}${f.departure_date ? ' · ' + fmtDate(f.departure_date) : ''}</div>
				<div class="mba-bkcard-foot">
					<span>${f.seats_occupied}/${f.max_seat || '—'} ${__('seats')} · ${f.booking_count} ${__('bookings')} · ${f.pax} ${__('pax')}</span>
				</div>
			</div>`).join('');

		const flTable = `
			<div class="mba-table-wrap">
				<table class="mba-table">
					<thead><tr>
						<th>${__('PNR')}</th>
						<th>${__('Airline')}</th>
						<th>${__('Route')}</th>
						<th class="num">${__('Departure')}</th>
						<th class="num">${__('Arrival')}</th>
						<th class="num" title="${__('Seats occupied / max seats')}">${__('Seats')}</th>
						<th class="num">${__('Bookings')}</th>
						<th class="num">${__('Pax')}</th>
						<th>${__('Status')}</th>
					</tr></thead>
					<tbody>${flRows.map((f) => `
						<tr data-route="Flight/${esc(f.name)}">
							<td><div class="mba-cell-main">${esc(f.pnr)}</div></td>
							<td>${f.airline ? esc(f.airline_name || f.airline) : '—'}</td>
							<td>${route(f) ? esc(route(f)) : '—'}</td>
							<td class="num">${f.departure_date ? fmtDate(f.departure_date) : '—'}</td>
							<td class="num">${f.arrival_date ? fmtDate(f.arrival_date) : '—'}</td>
							<td class="num">${f.seats_occupied}/${f.max_seat || '—'}</td>
							<td class="num">${f.booking_count}</td>
							<td class="num">${f.pax}</td>
							<td>${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}</td>
						</tr>`).join('')}
					</tbody>
				</table>
			</div>`;

		pane_el(key, 'flights').html(`
			<div class="mba-section-title">${__('Flights')}
				<span class="mba-count-pill">${fl.count ?? 0}</span></div>
			<div class="mba-tab-toolbar">
				${TravelBookingSearchBox.html({
					attrs: { 'data-search': 'fl' },
					placeholder: __('Search PNR / title / airline / airport...'),
					value: st.fl.search,
				})}
				${limit_options('fl', st.fl.limit)}
			</div>
			${flRows.length ? `<div class="mba-cards">${flCards}</div>${flTable}`
				: `<div class="mba-empty">${__('No flights referenced by this group yet.')}</div>`}
			${showing_footer(fl, __('flights'), 'fl')}`);
	}

	/* ---------- L2 Tab Addons (dipisah dari bekas Tab More) ---------- */

	function render_addons_tab(key) {
		const ad = S.cache[key]?.addons;
		const it = find_item(key);
		const st = S.state[key];
		if (!ad || !it || !st) return;

		const multi = it.members.length > 1;

		const adRows = ad.addons || [];
		const adTot = ad.totals || {};
		const adDt = adTot.default_totals || { currency: S.currency, amount: 0, rates_complete: true };
		const adIncomplete = adDt.rates_complete === false ? '+' : '';

		const adCards = adRows.map((a) => `
			<div class="mba-bkcard" data-route="Booking Addon/${esc(a.name)}">
				<div class="mba-bkcard-top">
					<span class="mba-bkcard-no">${esc(a.name)}</span>
					${badge(a.status, ADDON_STATUS_COLORS[a.status])}
				</div>
				<div class="mba-bkcard-cust">${a.booking
					? `<a href="/app/booking/${esc(a.booking)}">${esc(a.booking_number)}</a>` : esc(a.booking_number) || '—'}
					${a.customer_name ? ' · ' + esc(a.customer_name) : ''}</div>
				<div class="mba-bkcard-foot">
					${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}
					<span><b>${fmtMoney(a.total_amount, a.currency || S.currency)}</b> · ${a.item_count} ${__('items')}</span>
				</div>
			</div>`).join('');

		const adTable = `
			<div class="mba-table-wrap">
				<table class="mba-table">
					<thead><tr>
						<th>${__('Addon No')}</th>
						<th>${__('Booking')}</th>
						<th>${__('Status')}</th>
						<th>${__('Payment')}</th>
						<th class="num">${__('Items')}</th>
						<th class="num">${__('Amount')}</th>
						<th class="num">${__('Order Date')}</th>
					</tr></thead>
					<tbody>${adRows.map((a) => `
						<tr data-route="Booking Addon/${esc(a.name)}">
							<td><div class="mba-cell-main">${esc(a.name)}</div></td>
							<td>${a.booking
								? `<a href="/app/booking/${esc(a.booking)}">${esc(a.booking_number)}</a>` : esc(a.booking_number) || '—'}</td>
							<td>${badge(a.status, ADDON_STATUS_COLORS[a.status])}</td>
							<td>${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}</td>
							<td class="num">${a.item_count}</td>
							<td class="num">${fmtMoney(a.total_amount, a.currency || S.currency)}</td>
							<td class="num mba-muted">${fmtDateTime(a.order_date)}</td>
						</tr>`).join('')}
					</tbody>
					${ad.count ? `<tfoot><tr>
						<td colspan="5">${__('Total')} (${ad.count} ${__('addon orders')})
							<span class="mba-muted">· ${esc(adDt.currency || S.currency)}${adIncomplete}</span></td>
						<td class="num" title="${(adTot.by_currency || []).length ? esc(__('Per currency') + ': ' + adTot.by_currency.map((r) => fmtMoney(r.amount, r.currency)).join(' · ')) : ''}">${fmtMoney(adDt.amount, adDt.currency)}</td>
						<td></td>
					</tr></tfoot>` : ''}
				</table>
			</div>`;

		const adStatusOpts = ADDON_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.ad.status === o ? 'selected' : ''}>${esc(o || 'All Status')}</option>`).join('');
		const adPayOpts = ADDON_PAYMENT_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.ad.payment === o ? 'selected' : ''}>${esc(o || 'All Payments')}</option>`).join('');

		pane_el(key, 'addons').html(`
			<div class="mba-section-title">${__('Booking Addons')}
				<span class="mba-count-pill">${ad.count ?? 0}</span></div>
			<div class="mba-tab-toolbar">
				${TravelBookingSearchBox.html({
					attrs: { 'data-search': 'ad' },
					placeholder: __('Search addon / booking / customer...'),
					value: st.ad.search,
				})}
				${multi ? group_filter_options(it.members, st.ad.group, 'ad') : ''}
				<select data-kind="status" data-scope="ad">${adStatusOpts}</select>
				<select data-kind="payment" data-scope="ad">${adPayOpts}</select>
				${limit_options('ad', st.ad.limit)}
			</div>
			${adRows.length ? `<div class="mba-cards">${adCards}</div>${adTable}`
				: `<div class="mba-empty">${__('No addon orders found for this filter.')}</div>`}
			${showing_footer(ad, __('addon orders'), 'ad')}`);
	}

	/* ========== L3: BOOKING INFO (route /booking/<name>) ========== */

	const bkg_pe_rows = (d) => {
		const map = {};
		(d.transactions?.payments || []).forEach((pe) => {
			const e = map[pe.name] || (map[pe.name] = {
				name: pe.name,
				date: pe.reference_date || (pe.creation || '').slice(0, 10),
				docstatus: pe.docstatus,
				amounts: {},
			});
			e.amounts[pe.currency] = round2((e.amounts[pe.currency] || 0) + pe.allocated_amount);
		});
		return Object.values(map).sort((a, b) => String(b.date).localeCompare(String(a.date)));
	};

	const bkg_discount = (p) => {
		const cur = p.discount_currency || S.currency;
		const total = round2((p.voucher_discount || 0) + (p.price_rule_discount || 0) + (p.referral_discount || 0));
		const parts = [];
		if (p.voucher_discount) parts.push('V: ' + fmtMoney(p.voucher_discount, cur));
		if (p.price_rule_discount) parts.push('PR: ' + fmtMoney(p.price_rule_discount, cur));
		if (p.referral_discount) parts.push('RF: ' + fmtMoney(p.referral_discount, cur));
		return { cur, total, parts };
	};

	function render_booking(key, d) {
		const st = S.state[key] || (S.state[key] = default_state());
		st.tab = BKG_TABS.some((t) => t.id === st.tab) ? st.tab : 'ov';
		const p = d.profile || {};
		const resCount = (d.reservations || []).length;
		const peCount = bkg_pe_rows(d).length;
		const docCount = (d.documents?.sales_orders || []).length
			+ (d.documents?.sales_invoices || []).length
			+ (d.documents?.proforma_invoices || []).length;

		// Notifikasi onload — mesej customer terus dipaparkan sebagai modal.
		if (p.customer_message) {
			frappe.msgprint({
				title: '💬 ' + __('Customer Message') + ' — ' + (p.booking_number || p.name),
				indicator: 'yellow',
				message: `<div class="mba-msg-body">${esc(p.customer_message)}</div>`,
			});
		}

		$('#mba-detail').html(`
			<div class="mba-group mba-bkg" data-item="${esc(key)}">
				<div class="mba-bkg-topbar">
					<nav class="mba-crumbs" aria-label="${__('Breadcrumb')}">
						<button type="button" class="mba-crumb mba-back-btn">${__('All Groups')}</button>
						${p.group_batch ? `
						<span class="mba-crumb-sep">›</span>
						<button type="button" class="mba-crumb mba-back-batch-btn" data-batch="${esc(p.group_batch)}"
							title="${esc(__('Open batch detail'))}">${esc(p.group_batch)}</button>` : ''}
						${p.trip_date ? `
						<span class="mba-crumb-sep">›</span>
						<button type="button" class="mba-crumb mba-back-group-btn" data-group="${esc(p.trip_date)}"
							title="${esc(__('Open group detail'))}">${esc(p.trip_date)}</button>` : ''}
						<span class="mba-crumb-sep">›</span>
						<span class="mba-crumb mba-crumb--cur">${esc(p.booking_number || p.name)}</span>
					</nav>
					<div class="mba-bkg-actions">
						<a class="mba-bkg-form-link" href="/app/booking/${esc(p.name)}"
							target="_blank" rel="noopener"
							title="${esc(__('Open the Booking form in a new tab'))}">
							${__('Open Booking Form')} ${frappe.utils.icon('external-link', 'xs')}</a>
					</div>
				</div>
				<div class="mba-bkg-shell">
					<aside class="mba-bkg-rail">${bkg_rail(p, d)}</aside>
					<div class="mba-bkg-main">
						<div class="mba-tabs">
							${BKG_TABS.map((t) => `
								<button class="mba-tab ${st.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}
									${t.id === 'tv' && resCount ? `<span class="mba-count-pill">${resCount}</span>` : ''}
									${t.id === 'rm' ? `<span class="mba-count-pill" data-rm-pill style="display:none"></span>` : ''}
									${t.id === 'doc' && (docCount + peCount) ? `<span class="mba-count-pill">${docCount + peCount}</span>` : ''}
									${t.id === 'af' ? `<span class="mba-count-pill" data-af-pill style="display:none"></span>` : ''}
								</button>`).join('')}
						</div>
						<div class="mba-tab-panes">
							<div class="mba-tab-pane ${st.tab === 'ov' ? 'active' : ''}" data-pane="ov"></div>
							<div class="mba-tab-pane ${st.tab === 'tv' ? 'active' : ''}" data-pane="tv"></div>
							<div class="mba-tab-pane ${st.tab === 'rm' ? 'active' : ''}" data-pane="rm"></div>
							<div class="mba-tab-pane ${st.tab === 'doc' ? 'active' : ''}" data-pane="doc"></div>
							<div class="mba-tab-pane ${st.tab === 'af' ? 'active' : ''}" data-pane="af"></div>
							<div class="mba-tab-pane ${st.tab === 'other' ? 'active' : ''}" data-pane="other"></div>
						</div>
					</div>
				</div>
			</div>`);

		// Profail di-fetch semula setiap lawatan — kosongkan cache bilik
		// supaya tab Rooms L3 tidak kekal lapuk (cth. selepas susun atur
		// di Rooming Board dalam sesi SPA yang sama).
		delete (S.cache[key] || {}).bkgrooms;
		S.cache[key] = { ...(S.cache[key] || {}), profile: d };
		render_bkg_overview(key);
		// Tab Travellers L3 — sumber disatukan, dimuatkan lazily (bukan
		// lagi daripada profile.reservations).
		if (st.tab === 'tv') load_bkg_travellers(key);
		// Tab Rooms L3 — pakej rooming list (get_group_rooming skop
		// booking), dimuatkan lazily.
		if (st.tab === 'rm') load_bkg_rooms(key);
		// Tab Add-ons & Flights L3 — dimuatkan lazily (get_booking_addons_
		// flights), pill kiraan diisi selepas muat.
		if (st.tab === 'af') load_bkg_af(key);
		render_bkg_documents(key);
		render_bkg_others(key);
	}

	// Rail konteks (desktop sticky; telefon di atas kandungan) — identiti
	// + progres, customer, trip & stay, sales & channel. Audit → tab Others.
	function bkg_rail(p, d) {
		const row = (k, v) => (v ? `<div class="mba-bkg-rrow"><span class="k">${k}</span><span class="v">${v}</span></div>` : '');
		const sec = (lab, inner) => (inner && inner.trim()
			? `<div class="mba-bkg-rsec"><div class="mba-bkg-rlab">${lab}</div>${inner}</div>` : '');

		const dt = p.default_totals;
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const progSub = dt
			? `${fmtMoney(dt.paid, dt.currency || S.currency)} / ${fmtMoney(dt.gross, dt.currency || S.currency)}`
			: '';
		const idBadges = badge(p.status, BOOKING_STATUS_COLORS[p.status]);
		const idSec = `
			<div class="mba-bkg-rsec mba-bkg-rsec--id">
				<div class="mba-bkg-idhead">
					<div class="mba-bkg-rid">${esc(p.booking_number || p.name)}</div>
					${idBadges ? `<div class="mba-bkg-rbadges">${idBadges}</div>` : ''}
				</div>
				${p.name && p.name !== p.booking_number ? `<div class="mba-cell-sub">${esc(p.name)}</div>` : ''}
				<div class="mba-bkg-pbar"><span style="width:${prog}%"></span></div>
				<div class="mba-cell-sub">${prog}% ${__('paid')}${progSub ? ' · ' + progSub : ''}</div>
			</div>`;

		const customer = p.customer
			? `<a href="/app/customer/${esc(p.customer)}">${esc(p.customer_name)}</a>`
			: esc(p.customer_name);
		const contacts = [
			p.cust_email ? `✉ ${esc(p.cust_email)}` : '',
			p.cust_phone ? `☎ ${esc(p.cust_phone)}` : '',
		].filter(Boolean).join('<br>');
		const custSec = sec(__('Customer'),
			customer + (contacts ? `<div class="mba-cell-sub">${contacts}</div>` : '')
			+ (p.customer_message ? `
			<button type="button" class="mba-bkg-msg-btn"
				data-message="${esc(p.customer_message)}"
				data-title="${esc(__('Customer Message') + ' — ' + (p.booking_number || p.name))}">
				${__('Customer Message')}
			</button>` : '')
			+ (call_wa_btns(p.cust_phone)
				? `<div class="mba-bkg-cust-actions">${call_wa_btns(p.cust_phone)}</div>` : ''));

		const tripPreview = p.trip && p.trip_published;
		const tripLabel = tripPreview
			? `<a href="/${esc((p.trip_route || 'route/' + p.trip).replace(/^\/+/, ''))}"
					class="mba-trip-preview" title="${esc(__('Trip preview from website'))}">${esc(p.trip_title || p.trip)}</a>`
			: (p.trip
				? `<a href="/app/trip/${esc(p.trip)}">${esc(p.trip_title || p.trip)}</a>`
				: esc(p.trip_title || ''));
		const groupCell = p.trip_date
			? `<a href="/app/manage-booking-app/group/${esc(p.trip_date)}"
					title="${esc(__('Open group detail'))}">${p.group_batch
						? esc(p.group_batch) + ' / ' + esc(p.trip_date)
						: esc(p.trip_date)}</a>`
			: '';
		const sailLabel = (p.cruise_start || p.cruise_end)
			? fmtDate(p.cruise_start) + (p.cruise_end && p.cruise_end !== p.cruise_start ? ' → ' + fmtDate(p.cruise_end) : '')
			: '';
		const depLabel = p.departure_date
			? fmtDate(p.departure_date) + (p.return_date && p.return_date !== p.departure_date ? ' → ' + fmtDate(p.return_date) : '')
			: '';
		const datesDiffer = p.departure_date && p.cruise_start
			&& String(p.cruise_start).slice(0, 10) !== String(p.departure_date).slice(0, 10);
		const dateRows = datesDiffer
			? row(__('Departure'), esc(depLabel)) + row(__('Sail'), esc(sailLabel))
			: (p.is_a_cruise_trip && sailLabel
				? row(__('Sail'), esc(sailLabel))
				: row(__('Date'), esc(depLabel)));
		const duration = (p.total_days || p.total_night)
			? (p.total_days || '—') + ' ' + __('days') + ' / ' + (p.total_night || '—') + ' ' + __('nights')
			: '';
		const tripInner = tripLabel
			+ (p.is_a_cruise_trip || p.package_type
				? `<div class="mba-bkg-rbadges">${p.is_a_cruise_trip ? badge(__('Cruise'), 'cyan') : ''}${p.package_type ? badge(p.package_type, 'violet') : ''}</div>` : '')
			+ (groupCell ? row(__('Group'), groupCell) : '')
			+ dateRows
			+ row(__('Duration'), esc(duration))
			+ (p.booked_pax ? row(__('Booked Pax'), esc(p.booked_pax)) : '')
			+ row(__('Total Rooms'), esc(d.rooming_count ?? 0))
			+ row(__('Ship'), esc(p.ship_name));
		const tripSec = sec(__('Trip & Stay'), tripInner);

		const salesBadges = badge(p.booking_channel, 'violet') + badge(p.checkout_method, 'cyan');
		const dsc = bkg_discount(p);
		const dscRow = dsc.total > 0
			? row(__('Discount'), esc(fmtMoney(dsc.total, dsc.cur)))
				+ (dsc.parts.length ? `<div class="mba-cell-sub">${esc(dsc.parts.join(' · '))}</div>` : '')
			: '';
		const salesInner = (salesBadges ? `<div class="mba-bkg-rbadges">${salesBadges}</div>` : '')
			+ row(__('Affiliate'), esc(p.affiliate))
			+ row('B2B', esc(p.b2b_partner))
			+ row(__('End Customer'), esc(p.end_customer))
			+ row(__('Referral'), esc(p.referral_code_used))
			+ row(__('Voucher'), esc(p.voucher))
			+ dscRow;

		return idSec + custSec + tripSec + sec(__('Sales & Channel'), salesInner);
	}

	// Strip wang — Order → Paid(%) → Balance + Payment Status. Nilai utama
	// default currency; sub = pecahan native per currency. Baki tertunggak
	// memaparkan butang ikon kecil Payment Link selepas label BALANCE
	// (modal urus pautan bayaran — boleh gabungkan beberapa Sales Order
	// dalam satu pembayaran).
	function bkg_money_strip(p) {
		const rows = p.money_by_currency || [];
		const dt = p.default_totals;
		const alt = hasAltCur(rows) && dt;
		const val = (f) => (alt ? fmtDefaultTotal(dt, f) : fmtMoney((dt && dt[f]) || 0, S.currency));
		const sub = (f) => rows.map((r) => fmtMoney(r[f], r.currency)).join('<br>') || fmtMoney(0, S.currency);
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const title = esc(__('Per currency — amounts in different currencies are never summed'));
		const payBtn = hasBalance(rows)
			? `<button type="button" class="mba-paylink-btn" data-booking="${esc(p.name)}"
					title="${esc(__('Generate and share a payment link for the outstanding balance'))}"
					aria-label="${esc(__('Payment Link'))}">${frappe.utils.icon('credit-card', 'xs')}<span>${__('Pay')}</span></button>`
			: '';

		return `
			<div class="mba-bkg-money">
				<div class="mba-mitem" title="${title}">
					<div class="mba-mitem-l">${__('Order Value')}</div>
					<div class="mba-mitem-v">${val('gross')}</div>
					<div class="mba-mitem-s">${sub('gross')}</div>
				</div>
				<span class="mba-bkg-msep">→</span>
				<div class="mba-mitem" title="${title}">
					<div class="mba-mitem-l">${__('Paid')}${prog ? ' · ' + prog + '%' : ''}</div>
					<div class="mba-mitem-v">${val('paid')}</div>
					<div class="mba-mitem-s">${sub('paid')}</div>
				</div>
				<span class="mba-bkg-msep">→</span>
				<div class="mba-mitem mba-mitem--warn" title="${title}">
					<div class="mba-mitem-l mba-mitem-l--pay">${__('Balance')}${payBtn}</div>
					<div class="mba-mitem-v">${val('balance')}</div>
					<div class="mba-mitem-s">${sub('balance')}</div>
				</div>
				<div class="mba-bkg-paystat">
					<div class="mba-mitem-l">${__('Payment Status')}</div>
					${badge(p.payment_status, PAYMENT_STATUS_COLORS[p.payment_status]) || '<span class="mba-muted">—</span>'}
				</div>
			</div>`;
	}

	// ── Modal Payment Link — butang ikon kecil selepas label BALANCE (strip
	// wang). Urus pautan bayaran baki tertunggak: pilih SATU atau LEBIH
	// Sales Order (digabungkan dalam SATU pembayaran Stripe), jana pautan
	// + QR, kemudian hantar ke customer melalui WhatsApp (wa.me) / emel. ──
	const paylink_totals = (rows, amtKey, curKey) => {
		// Jumlah per currency — JANGAN jumlah merentas currency (disiplin
		// sama dengan strip wang).
		const totals = {};
		(rows || []).forEach((r) => {
			const c = r[curKey];
			totals[c] = round2((totals[c] || 0) + r[amtKey]);
		});
		return totals;
	};

	const paylink_wa_message = (d, links) => {
		const prof = ((S.cache[d.booking] || {}).profile || {}).profile || {};
		const trip = prof.trip_title || '';
		const totals = paylink_totals(links, 'amount', 'currency');
		const totalStr = Object.keys(totals).map((c) => fmtMoney(totals[c], c)).join(' + ');
		const linksBlock = links.length === 1
			? links[0].checkout_url
			: links.map((l) => l.sales_order + ' — ' + l.checkout_url).join('\n');
		return 'Hello ' + (d.customer_name || '') + ', here is the payment link for booking '
			+ (d.booking_number || d.booking) + (trip ? ' (' + trip + ')' : '') + ':\n\n'
			+ linksBlock + '\n\n'
			+ 'Amount due: ' + totalStr + '\n'
			+ links.map((l) => '- ' + l.sales_order + ': ' + fmtMoney(l.amount, l.currency)).join('\n')
			+ '\n\nYou can pay securely by card using the link above, or scan the QR code. Thank you.';
	};

	const paylink_result_html = (d) => {
		const links = d.links || [];
		if (!links.length) {
			return `<div class="mba-paylink-empty">${__('No active payment link — generate one above.')}</div>`;
		}
		const primary = links[0];
		const totals = paylink_totals(links, 'amount', 'currency');
		const totalStr = Object.keys(totals).map((c) => fmtMoney(totals[c], c)).join(' + ');
		const digits = String(d.cust_phone || '').replace(/\D/g, '');
		const waHref = digits
			? 'https://wa.me/' + (digits.startsWith('0') ? '6' + digits : digits)
				+ '?text=' + encodeURIComponent(paylink_wa_message(d, links))
			: '';
		return `
			<div class="mba-paylink-card">
				${primary.qr ? `<div class="mba-paylink-qr"><img src="${primary.qr}" alt="QR"/></div>` : ''}
				<div class="mba-paylink-info">
					<div class="mba-paylink-amt">${totalStr}</div>
					<div class="mba-mitem-s">${links.length} ${__('order(s) in this link')}</div>
					<div class="mba-paylink-urlrow">
						<input class="form-control input-sm" readonly
							value="${esc(primary.checkout_url)}"/>
						<button type="button" class="btn btn-default btn-sm mba-paylink-copy">${__('Copy')}</button>
					</div>
					<div class="mba-paylink-rows">
						${links.map((l) => `
						<div class="mba-paylink-row">
							<a href="/app/sales-order/${esc(l.sales_order)}">${esc(l.sales_order)}</a>
							<span>${fmtMoney(l.amount, l.currency)}</span>
						</div>`).join('')}
					</div>
					<div class="mba-bkg-cust-actions">
						${waHref ? `<a class="mba-quickbtn mba-quickbtn--wa" href="${esc(waHref)}"
								target="_blank" rel="noopener">${__('WhatsApp')}</a>` : ''}
						<button type="button" class="mba-quickbtn mba-paylink-email"
							${d.cust_email ? '' : 'disabled title="' + esc(__('This booking has no customer email address')) + '"'}>${__('Email')}</button>
						<a class="mba-quickbtn" href="${esc(primary.checkout_url)}"
							target="_blank" rel="noopener">${__('Open')}</a>
					</div>
					${d.cust_email ? `<div class="mba-mitem-s">${__('Email will be sent to')} ${esc(d.cust_email)}</div>` : ''}
				</div>
			</div>`;
	};

	function open_payment_link_dialog(booking) {
		api('get_booking_payment_links', { booking }).then((payload) => {
			if (!payload) return;
			let data = payload;   // diganti semula selepas generate (re-fetch)

			const dlg = new frappe.ui.Dialog({
				title: __('Payment Link') + ' — ' + (payload.booking_number || booking),
				size: 'large',
			});
			const sel = new Set((payload.sos || []).map((s) => s.name));
			// Baris dokumen — pilihan (label boleh klik) + input JUMLAH
			// ALOKASI boleh sunting (lalai = baki penuh; 0 < jumlah ≤ baki
			// SO itu — validasi ERPNext Payment Request).
			const soRows = (payload.sos || []).map((so) => `
				<div class="mba-paylink-so">
					<label class="mba-paylink-sel">
						<input type="checkbox" class="mba-paylink-check" data-so="${esc(so.name)}"
							${sel.has(so.name) ? 'checked' : ''}/>
						<span class="mba-paylink-soname">${esc(so.name)}
							${so.is_addon ? badge(__('Addon Order'), 'gray') : badge(__('Sales Order'), 'blue')}</span>
					</label>
					<span class="mba-paylink-amtwrap"
						title="${esc(__('Amount to charge for this order — edit for a partial payment'))}">
						<input type="number" class="mba-paylink-amt" inputmode="decimal"
							min="0.01" max="${so.balance}" step="0.01" value="${so.balance}"
							${sel.has(so.name) ? '' : 'disabled'}/>
						<span class="mba-paylink-cur">${esc(so.currency)}</span>
					</span>
				</div>`).join('');

			dlg.$body.html(`
				<div class="mba-paylink">
					<div class="mba-paylink-sec">
						<div class="mba-paylink-head">${__('Outstanding Orders')}</div>
						${soRows || `<div class="mba-paylink-empty">${__('No outstanding balance on this booking.')}</div>`}
						<div class="mba-paylink-total">
							<span>${__('Selected Total')}</span>
							<b data-pl-total>—</b>
							<span class="mba-mitem-s" data-pl-count></span>
						</div>
						<div class="mba-paylink-warn" data-pl-warn style="display:none">
							${__('Mixed currencies cannot share one payment — generate a separate link per currency.')}
						</div>
						<div class="mba-paylink-genrow">
							<button type="button" class="btn btn-primary btn-sm mba-paylink-gen">${__('Generate Payment Link')}</button>
							<span class="mba-mitem-s">${__('Amounts are editable for partial payment. Generating a new link cancels previous unpaid links for the same orders.')}</span>
						</div>
					</div>
					<div class="mba-paylink-sec" data-pl-result>
						${paylink_result_html(data)}
					</div>
				</div>`);

			const $body = dlg.$body;
			const $gen = $body.find('.mba-paylink-gen');

			// Jumlah ikut pilihan + nilai input alokasi semasa (bukan baki
			// penuh). Input tak sah (kosong / ≤0 / melebihi baki SO) → baris
			// ditanda merah & butang jana dikunci. Currency bercampur turut
			// dikunci — satu pembayaran gabungan wajib satu currency.
			const recompute = () => {
				const chosen = [];
				let invalid = false;
				$body.find('.mba-paylink-so').each(function () {
					const $row = $(this);
					const $chk = $row.find('.mba-paylink-check');
					const so = (data.sos || []).find((x) => x.name === $chk.data('so'));
					const $amt = $row.find('.mba-paylink-amt');
					const on = $chk.prop('checked');
					$amt.prop('disabled', !on);
					if (!so || !on) { $row.removeClass('is-invalid'); return; }
					const v = parseFloat($amt.val());
					const bad = !(v > 0) || v > so.balance + 0.009;
					$row.toggleClass('is-invalid', bad);
					if (bad) { invalid = true; return; }
					chosen.push({ amount: round2(v), currency: so.currency });
				});
				const totals = paylink_totals(chosen, 'amount', 'currency');
				$body.find('[data-pl-total]').text(
					Object.keys(totals).map((c) => fmtMoney(totals[c], c)).join(' + ') || '—');
				$body.find('[data-pl-count]').text(
					chosen.length ? chosen.length + ' ' + __('selected') : '');
				const mixed = Object.keys(totals).length > 1;
				$body.find('[data-pl-warn]').toggle(mixed);
				$gen.prop('disabled', !chosen.length || mixed || invalid);
			};

			const refresh_result = () => $body.find('[data-pl-result]').html(paylink_result_html(data));

			const do_generate = () => {
				const sales_orders = [];
				const amounts = {};
				let valid = true;
				$body.find('.mba-paylink-so').each(function () {
					const $row = $(this);
					const $chk = $row.find('.mba-paylink-check');
					if (!$chk.prop('checked')) return;
					const so = (data.sos || []).find((x) => x.name === $chk.data('so'));
					const name = String($chk.data('so'));
					const v = parseFloat($row.find('.mba-paylink-amt').val());
					if (!so || !(v > 0) || v > so.balance + 0.009) { valid = false; return; }
					sales_orders.push(name);
					amounts[name] = round2(v);
				});
				if (!valid || !sales_orders.length) return;
				$gen.prop('disabled', true).text(__('Generating…'));
				api('create_booking_payment_link', { booking, sales_orders, amounts })
					.then(() => api('get_booking_payment_links', { booking }))
					.then((fresh) => {
						if (fresh) data = fresh;
						refresh_result();
						frappe.show_alert({ message: __('Payment link generated'), indicator: 'green' }, 5);
					})
					.finally(() => {
						$gen.prop('disabled', false).text(__('Generate Payment Link'));
						recompute();
					});
			};

			const do_copy = () => {
				const url = ((data.links || [])[0] || {}).checkout_url || '';
				if (url) frappe.utils.copy_to_clipboard(url);
			};

			const do_email = () => {
				const prs = (data.links || []).map((l) => l.payment_request);
				if (!prs.length) return;
				const $btn = $body.find('.mba-paylink-email').prop('disabled', true);
				api('send_booking_payment_email', { booking, payment_requests: prs })
					.then((r) => {
						frappe.show_alert({
							message: __('Email sent to {0}', [r?.sent_to || 'customer']),
							indicator: 'green',
						}, 5);
					})
					.finally(() => $btn.prop('disabled', false));
			};

			$body
				.on('change', '.mba-paylink-check', recompute)
				.on('input change', '.mba-paylink-amt', recompute)
				.on('focus', '.mba-paylink-urlrow input', function () { this.select(); })
				.on('click', '.mba-paylink-gen', do_generate)
				.on('click', '.mba-paylink-copy', do_copy)
				.on('click', '.mba-paylink-email', do_email);

			recompute();
			dlg.show();
		});
	}

	const bkg_section = (title, count, inner) => `
		<div class="mba-section-title">${title}
			${count !== '' && count != null ? `<span class="mba-count-pill">${count}</span>` : ''}
		</div>${inner}`;

	// Kiraan operasi + chips (Discount / Travellers / Rooms / Pending Docs)
	const bkg_ops_counts = (d) => {
		const res = d.reservations || [];
		const active = res.filter((t) => t.reservation_status !== 'Cancelled');
		const pendingDocs = res.filter((t) => !DOC_STATUS_OK.includes(t.document_status)).length;
		return { total: res.length, active: active.length, cancelled: res.length - active.length, pendingDocs };
	};

	function bkg_ops_chips(d) {
		const o = bkg_ops_counts(d);
		const dsc = bkg_discount(d.profile || {});
		const chips = [
			dsc.total > 0 ? `<span class="mba-bkg-chip">${__('Discount')} <b>${fmtMoney(dsc.total, dsc.cur)}</b></span>` : '',
			`<span class="mba-bkg-chip">${__('Travellers')} <b>${o.active}</b></span>`,
			`<span class="mba-bkg-chip">${__('Rooms')} <b>${d.rooming_count ?? 0}</b></span>`,
			o.pendingDocs ? `<span class="mba-bkg-chip mba-bkg-chip--danger">${__('Pending Docs')} <b>${o.pendingDocs}</b></span>` : '',
		].filter(Boolean).join('');
		return chips ? `<div class="mba-bkg-mchips">${chips}</div>` : '';
	}

	// ── Order Summary — parse field virtual Booking 'order_summary' (server
	// kira live daripada SO utama; pecahan ikut kabin + baris diskaun). ──
	function mba_parse_order_summary(txt) {
		const splitMoney = (t) => {
			const m = t.match(/^(.*?)\s*([^\s\d.,]+)\s*(-?[\d,]+\.\d{2})$/);
			if (!m) return null;
			return {
				label: m[1].replace(/[—–-]\s*$/, '').replace(/:\s*$/, '').trim(),
				cur: m[2], amt: m[3],
			};
		};
		const cabins = [], dscs = [];
		let cur = null;
		(txt || '').split('\n').forEach((raw) => {
			const t = raw.trim();
			if (!t) return;
			if (/^[ \t]/.test(raw)) {
				if (!cur) return;
				const mm = splitMoney(t);
				if (!mm) return;
				if (/^cabin fare/i.test(t)) { cur.fare = mm; return; }
				const g = mm.label.match(/^(Guest\s*\d+)\s*:?\s*(.*)$/i);
				cur.guests.push({
					who: g ? [g[1], g[2]].filter(Boolean).join(' · ') : mm.label,
					cur: mm.cur, amt: mm.amt,
				});
				return;
			}
			const mm = splitMoney(t);
			if (mm) { dscs.push(mm); return; }
			cur = { name: t, fare: null, guests: [] };
			cabins.push(cur);
		});
		return { cabins, dscs };
	}

	function bkg_order_summary(d) {
		const os = mba_parse_order_summary((d.profile || {}).order_summary);
		if (!os.cabins.length) return '';
		const amt = (x) => (x.amt.startsWith('-')
			? `− ${esc(x.cur)} ${esc(x.amt.slice(1))}`
			: `${esc(x.cur)} ${esc(x.amt)}`);
		const cards = os.cabins.map((c) => `
			<div class="mba-bkg-osum-cabin">
				<div class="mba-bkg-osum-name">${esc(c.name)}</div>
				${c.fare ? `<div class="mba-bkg-osum-row is-fare"><span>${__('Cabin Fare')}</span><b>${amt(c.fare)}</b></div>` : ''}
				${c.guests.map((g) => `
				<div class="mba-bkg-osum-row"><span>${esc(g.who)}</span><span>${amt(g)}</span></div>`).join('')}
			</div>`).join('');
		const dscs = os.dscs.map((x) => `
			<div class="mba-bkg-osum-row is-dsc"><span>${esc(x.label)}</span><span>${amt(x)}</span></div>`).join('');
		return bkg_section(__('Order Summary'), os.cabins.length,
			`${bkg_ops_chips(d)}<div class="mba-bkg-osum">${cards}${dscs}</div>`);
	}

	// ── Timeline booking — created → PI/SO → payments → T&C, disusun ikut
	// tarikh + item semasa/hadapan. Default: 5 peristiwa terkini sahaja
	// (butang "Show earlier"); S.tlAll memaparkan penuh. ────────────────
	function bkg_timeline(d) {
		const p = d.profile || {};
		const ev = [];
		if (p.creation) ev.push({
			date: p.creation.slice(0, 10), cls: '',
			html: __('Booking created')
				+ (p.booking_channel ? ' — ' + esc(p.booking_channel) : '')
				+ (p.checkout_method ? ' · ' + esc(p.checkout_method) : ''),
		});
		(d.documents?.proforma_invoices || []).filter((x) => x.docstatus !== 2).forEach((pf) => ev.push({
			date: pf.proforma_date, cls: 'doc',
			html: `${badge(__('Proforma'), 'violet')} <a href="/app/proforma-invoice/${esc(pf.name)}">${esc(pf.name)}</a> · ${fmtMoney(pf.grand_total, pf.currency)}`,
		}));
		(d.documents?.sales_orders || []).filter((x) => x.docstatus === 1).forEach((so) => ev.push({
			date: so.transaction_date || (so.creation || '').slice(0, 10), cls: 'doc',
			html: `${badge(so.is_addon ? __('Addon Order') : __('Sales Order'), 'blue')} <a href="/app/sales-order/${esc(so.name)}">${esc(so.name)}</a> · ${fmtMoney(so.grand_total, so.currency)}`,
		}));
		(d.reservations || []).forEach((t) => {
			if (t.reservation_status === 'Cancelled') return;
			const reg = (t.traveller_created || '').slice(0, 10);
			if (reg) ev.push({
				date: reg, cls: '',
				html: `${badge(__('Traveller'), 'cyan')} ${__('Registered')} — <b>${esc(t.traveller_name)}</b>`,
			});
			const upd = {};
			(t.traveller_versions || []).forEach((v) => {
				const d0 = String(v).slice(0, 10);
				if (d0 && d0 !== reg) upd[d0] = (upd[d0] || 0) + 1;
			});
			if (!Object.keys(upd).length) {
				const mod = (t.traveller_modified || '').slice(0, 10);
				if (mod && mod !== reg) upd[mod] = 1;
			}
			Object.keys(upd).sort().forEach((d0) => ev.push({
				date: d0, cls: '',
				html: `${__('Traveller updated')} — <b>${esc(t.traveller_name)}</b>`
					+ (upd[d0] > 1 ? ` ×${upd[d0]}` : ''),
			}));
		});
		bkg_pe_rows(d).filter((pe) => pe.docstatus !== 2).forEach((pe) => {
			const amt = Object.entries(pe.amounts).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
			ev.push({
				date: pe.date, cls: 'pay',
				html: `${__('Payment')} <a href="/app/payment-entry/${esc(pe.name)}">${esc(pe.name)}</a> · ${amt}`,
			});
		});
		if (p.terms_accepted && p.terms_accepted_at) ev.push({
			date: p.terms_accepted_at.slice(0, 10), cls: 'ok',
			html: __('T&C accepted by customer'),
		});
		if (!ev.length) return '';
		ev.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

		// Item semasa / hadapan.
		const tail = [];
		const money = p.money_by_currency || [];
		if (hasBalance(money)) tail.push(`
			<div class="mba-bkg-tli mba-bkg-tli--future">
				<div class="mba-bkg-tld">${__('Now')}</div>
				<div>${__('Outstanding balance')} <b>${fmtCurRows(money, 'balance')}</b></div>
			</div>`);
		const sail = p.is_a_cruise_trip ? (p.cruise_start || p.departure_date) : p.departure_date;
		if (sail) tail.push(`
			<div class="mba-bkg-tli mba-bkg-tli--future">
				<div class="mba-bkg-tld">${fmtDate(sail)}</div>
				<div>${__('Sail')} — ${esc(p.ship_name || p.trip_title || '')}</div>
			</div>`);

		// Ringkaskan — 5 peristiwa terkini sahaja secara default.
		let visible = ev;
		let moreBtn = '';
		if (!S.tlAll && ev.length > 5) {
			visible = ev.slice(-5);
			moreBtn = `<button type="button" class="btn btn-default btn-xs mba-tl-toggle">${__('Show earlier events')} (${ev.length - 5})</button>`;
		}

		const items = visible.map((e) => `
			<div class="mba-bkg-tli ${e.cls ? 'mba-bkg-tli--' + e.cls : ''}">
				<div class="mba-bkg-tld">${e.date ? fmtDate(e.date) : ''}</div>
				<div>${e.html}</div>
			</div>`).join('');
		// Wrapper .mba-bkg-tlwrap — skop gaya "sangat kecil & muted" pada
		// seksyen timeline sahaja (tajuk + kandungan), tanpa sentuh gaya
		// section lain (Order Summary dsb.).
		return `<div class="mba-bkg-tlwrap">${bkg_section(__('Booking Timeline'), ev.length + tail.length,
			`${moreBtn}<div class="mba-bkg-tl">${items}${tail.join('')}</div>`)}</div>`;
	}

	function render_bkg_overview(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		// Strip wang (Order → Paid → Balance + Payment Status) berada dalam
		// kandungan tab Overview — bahagian atas, sebelum Order Summary.
		$('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="ov"]`)
			.html(`${bkg_money_strip(d.profile)}${bkg_order_summary(d)}${bkg_timeline(d)}`);
	}

	// ── Tab Rooms L3 — PAKEJ ROOMING LIST (rooms_list.js) diguna semula
	// untuk skop SATU booking: get_group_rooming(booking=<name>) memulangkan
	// bilik yang mengandungi reservation booking ini, LENGKAP dengan
	// penghuni kongsi merentas booking (highlight 'is-cross' oleh pakej).
	// Klik tetamu → modal maklumat traveller penuh (lalai pakej); pintasan
	// Rooming Board menuju route group/batch booking ini. ──
	async function load_bkg_rooms(key, force = false) {
		if (!key || !key.startsWith('bkg:')) return;
		if (!force && S.cache[key]?.bkgrooms) {
			render_bkg_rooms(key);
			return;
		}
		const $pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="rm"]`);
		if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading rooms...')}</div>`);
		try {
			// Skop satu booking — biliknya sedikit; muat semua (limit 0).
			const rm = await api('get_group_rooming', { booking: key.slice(4), limit: 0 });
			S.cache[key] = { ...(S.cache[key] || {}), bkgrooms: rm };
		} catch (e) {
			return; // api() sudah papar alert ralat
		}
		// Pill kiraan bilik pada tab.
		const n = S.cache[key]?.bkgrooms?.count || 0;
		const $pill = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="rm"] [data-rm-pill]`);
		if ($pill.length) $pill.text(n).toggle(n > 0);
		// Render hanya bila tab masih dibuka pada item yang sama.
		const $tab = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="rm"]`);
		if ($tab.hasClass('active')) render_bkg_rooms(key);
	}

	function render_bkg_rooms(key) {
		const rm = S.cache[key]?.bkgrooms;
		if (!rm) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="rm"]`);
		if (!pane.length) return;

		const rooms = rm.rooms || [];
		const pax = rooms.reduce((n, r) => n + (r.guests || []).length, 0);

		// Pintasan Rooming Board — route penuh group/batch booking ini
		// (susun atur bilik diurus di papan, bukan di sini).
		const p = S.cache[key]?.profile?.profile || {};
		const boardBtn = p.trip_date
			? `<button type="button" class="btn btn-secondary btn-sm mba-rb-open-bkg mba-toolbar-push"
					data-group="${esc(p.group_batch ? p.group_batch : p.trip_date)}"
					data-kind="${p.group_batch ? 'batch' : 'group'}">
					${__('Rooming Board')}</button>` : '';

		pane.html(bkg_section(__('Rooms'), rm.count ?? 0, `
			<div class="mba-tab-toolbar">
				<span class="mba-muted">${rooms.length} ${__('rooms')} · ${pax} ${__('guests')}</span>
				${boardBtn}
			</div>
			<div class="mba-rooms-slot"></div>`));

		// Grid kad bilik — pakej rooms_list.js (klik tetamu → modal
		// maklumat traveller, lalai pakej).
		mount_rooms_list(pane.find('.mba-rooms-slot'), rm, {
			empty_message: __('No rooms arranged for this booking yet.'),
		});
	}

	// ── Tab Add-ons & Flights L3 — dimuatkan lazily daripada
	// get_booking_addons_flights (addon order booking ni + Flight yang
	// dirujuk Booking.flight). Selari bentuk row L2 supaya kad/jadual
	// konsisten; klik kad/baris → form dokumen (handler .mba-bkcard). ──
	async function load_bkg_af(key, force = false) {
		if (!key || !key.startsWith('bkg:')) return;
		if (!force && S.cache[key]?.afdata) {
			render_bkg_af(key);
			return;
		}
		const $pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="af"]`);
		if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading add-ons & flights...')}</div>`);
		try {
			const d = await api('get_booking_addons_flights', { booking: key.slice(4) });
			S.cache[key] = { ...(S.cache[key] || {}), afdata: d };
		} catch (e) {
			return; // api() sudah papar alert ralat
		}
		// Pill kiraan pada tab — add-on + flight booking ni.
		const n = (S.cache[key]?.afdata?.addons?.length || 0)
			+ (S.cache[key]?.afdata?.flights?.length || 0);
		const $pill = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="af"] [data-af-pill]`);
		if ($pill.length) $pill.text(n).toggle(n > 0);
		// Render hanya bila tab masih dibuka pada item yang sama.
		const $tab = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="af"]`);
		if ($tab.hasClass('active')) render_bkg_af(key);
	}

	function render_bkg_af(key) {
		const d = S.cache[key]?.afdata;
		if (!d) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="af"]`);
		if (!pane.length) return;

		// ── Add-on order booking ni (tiada kolum Booking — semua milik
		// booking ini). ──
		const adRows = d.addons || [];
		const adTot = d.totals || {};
		const adDt = adTot.default_totals || { currency: S.currency, amount: 0, rates_complete: true };
		const adIncomplete = adDt.rates_complete === false ? '+' : '';

		const adCards = adRows.map((a) => `
			<div class="mba-bkcard" data-route="Booking Addon/${esc(a.name)}">
				<div class="mba-bkcard-top">
					<span class="mba-bkcard-no">${esc(a.name)}</span>
					${badge(a.status, ADDON_STATUS_COLORS[a.status])}
				</div>
				<div class="mba-bkcard-cust">${esc(a.trip_package || a.booking_number || '—')}</div>
				<div class="mba-bkcard-foot">
					${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}
					<span><b>${fmtMoney(a.total_amount, a.currency || S.currency)}</b> · ${a.item_count} ${__('items')}</span>
				</div>
			</div>`).join('');

		const adTable = `
			<div class="mba-table-wrap">
				<table class="mba-table">
					<thead><tr>
						<th>${__('Addon No')}</th>
						<th>${__('Package')}</th>
						<th>${__('Status')}</th>
						<th>${__('Payment')}</th>
						<th class="num">${__('Items')}</th>
						<th class="num">${__('Amount')}</th>
						<th class="num">${__('Order Date')}</th>
					</tr></thead>
					<tbody>${adRows.map((a) => `
						<tr data-route="Booking Addon/${esc(a.name)}">
							<td><div class="mba-cell-main">${esc(a.name)}</div></td>
							<td>${esc(a.trip_package || '—')}</td>
							<td>${badge(a.status, ADDON_STATUS_COLORS[a.status])}</td>
							<td>${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}</td>
							<td class="num">${a.item_count}</td>
							<td class="num">${fmtMoney(a.total_amount, a.currency || S.currency)}</td>
							<td class="num mba-muted">${fmtDateTime(a.order_date)}</td>
						</tr>`).join('')}
					</tbody>
					${adRows.length ? `<tfoot><tr>
						<td colspan="5">${__('Total')} (${adRows.length} ${__('addon orders')})
							<span class="mba-muted">· ${esc(adDt.currency || S.currency)}${adIncomplete}</span></td>
						<td class="num" title="${(adTot.by_currency || []).length ? esc(__('Per currency') + ': ' + adTot.by_currency.map((r) => fmtMoney(r.amount, r.currency)).join(' · ')) : ''}">${fmtMoney(adDt.amount, adDt.currency)}</td>
						<td></td>
					</tr></tfoot>` : ''}
				</table>
			</div>`;

		const addonsSec = bkg_section(__('Booking Addons'), adRows.length,
			adRows.length
				? `<div class="mba-cards">${adCards}</div>${adTable}`
				: `<div class="mba-empty">${__('No addon orders for this booking.')}</div>`);

		// ── Flight booking ni (Booking.flight) — statistik flight-wide
		// (bookings/pax) + pax booking ini sendiri. ──
		const flRows = d.flights || [];
		const route = (f) => [f.home_airport, f.destination_airport].filter(Boolean).join(' → ');

		const flCards = flRows.map((f) => `
			<div class="mba-bkcard" data-route="Flight/${esc(f.name)}">
				<div class="mba-bkcard-top">
					<span class="mba-bkcard-no">${esc(f.pnr)}</span>
					${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}
				</div>
				<div class="mba-bkcard-cust">${f.airline ? esc(f.airline_name || f.airline) : '—'}</div>
				<div class="mba-bkcard-meta">${route(f) ? esc(route(f)) : ''}${f.departure_date ? ' · ' + fmtDate(f.departure_date) : ''}</div>
				<div class="mba-bkcard-foot">
					<span>${f.seats_occupied}/${f.max_seat || '—'} ${__('seats')} · ${f.booking_count} ${__('bookings')} · ${f.pax} ${__('pax')}</span>
					<span>${f.pax_booking} ${__('pax')} — ${__('this booking')}</span>
				</div>
			</div>`).join('');

		const flTable = `
			<div class="mba-table-wrap">
				<table class="mba-table">
					<thead><tr>
						<th>${__('PNR')}</th>
						<th>${__('Airline')}</th>
						<th>${__('Route')}</th>
						<th class="num">${__('Departure')}</th>
						<th class="num">${__('Arrival')}</th>
						<th class="num" title="${__('Seats occupied / max seats')}">${__('Seats')}</th>
						<th class="num">${__('Bookings')}</th>
						<th class="num">${__('Pax')}</th>
						<th class="num" title="${__('Pax from this booking on this flight')}">${__('Booking Pax')}</th>
						<th>${__('Status')}</th>
					</tr></thead>
					<tbody>${flRows.map((f) => `
						<tr data-route="Flight/${esc(f.name)}">
							<td><div class="mba-cell-main">${esc(f.pnr)}</div></td>
							<td>${f.airline ? esc(f.airline_name || f.airline) : '—'}</td>
							<td>${route(f) ? esc(route(f)) : '—'}</td>
							<td class="num">${f.departure_date ? fmtDate(f.departure_date) : '—'}</td>
							<td class="num">${f.arrival_date ? fmtDate(f.arrival_date) : '—'}</td>
							<td class="num">${f.seats_occupied}/${f.max_seat || '—'}</td>
							<td class="num">${f.booking_count}</td>
							<td class="num">${f.pax}</td>
							<td class="num">${f.pax_booking}</td>
							<td>${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}</td>
						</tr>`).join('')}
					</tbody>
				</table>
			</div>`;

		const flightsSec = bkg_section(__('Flights'), flRows.length,
			flRows.length
				? `<div class="mba-cards">${flCards}</div>${flTable}`
				: `<div class="mba-empty">${__('No flight linked to this booking.')}</div>`);

		pane.html(addonsSec + flightsSec);
	}

	// (Modal, dialog & renderer senarai traveller — lihat sub-package
	//  traveller_list.js, di-include di atas.)
	// Resit rasmi Payment Entry — print format resit app.
	const pe_receipt_url = (name) =>
		'/api/method/frappe.utils.print_format.download_pdf?doctype='
		+ encodeURIComponent('Payment Entry') + '&name=' + encodeURIComponent(name)
		+ '&format=' + encodeURIComponent('Rarecation Receipt')
		+ '&no_letterhead=0';

	// PDF dokumen ERPNext — endpoint print standard frappe.
	const DOC_PRINT_FORMAT = {
		'Sales Order': 'Standard',
		'Sales Invoice': 'Standard',
		'Proforma Invoice': 'Proforma Invoice',
	};
	const doc_pdf_url = (doctype, name) =>
		'/api/method/frappe.utils.print_format.download_pdf?doctype='
		+ encodeURIComponent(doctype) + '&name=' + encodeURIComponent(name)
		+ '&format=' + encodeURIComponent(DOC_PRINT_FORMAT[doctype] || 'Standard')
		+ '&no_letterhead=0';

	// ── L3 Tab Documents — senarai SO/SI/PI + kad Payments. ──
	function render_bkg_documents(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="doc"]`);

		const docs = [
			...(d.documents?.sales_orders || []).map((so) => ({
				type: 'Sales Order', doctype: 'Sales Order', name: so.name, key: 'so',
				is_addon: so.is_addon,
				date: so.transaction_date || (so.creation || '').slice(0, 10),
				currency: so.currency, amount: so.grand_total,
				status: so.status, docstatus: so.docstatus,
			})),
			...(d.documents?.sales_invoices || []).map((si) => ({
				type: 'Sales Invoice', doctype: 'Sales Invoice', name: si.name, key: 'si',
				date: si.posting_date, currency: si.currency,
				amount: si.grand_total, status: si.status, docstatus: si.docstatus,
			})),
			...(d.documents?.proforma_invoices || []).map((pf) => ({
				type: 'Proforma Invoice', doctype: 'Proforma Invoice', name: pf.name, key: 'pi',
				date: pf.proforma_date, currency: pf.currency,
				amount: pf.grand_total, status: pf.status, docstatus: pf.docstatus,
				pdf: pf.proforma_pdf,
			})),
		].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

		const slug = (t) => t.toLowerCase().replace(/ /g, '-');
		const items = docs.map((doc) => `
			<div class="mba-docrow mba-docitem" data-type="${doc.key}" data-route="${esc(doc.doctype)}/${esc(doc.name)}">
				<span class="mba-docitem-chip mba-docitem-chip--${doc.key}">${doc.key.toUpperCase()}</span>
				<div class="mba-docitem-main">
					<a href="/app/${slug(doc.doctype)}/${esc(doc.name)}">${esc(doc.name)}</a>
					${doc.is_addon ? badge(__('Addon'), 'gray') : ''}
					<div class="mba-docitem-sub">${__(doc.type)}${doc.date ? ' · ' + fmtDate(doc.date) : ''}</div>
				</div>
				<div class="mba-docitem-side">
					<div class="mba-docitem-amt">${fmtMoney(doc.amount, doc.currency)}</div>
					<div class="mba-docitem-badges">
						${docstatus_badge(doc.docstatus)}
						${doc.docstatus !== 2 ? badge(doc.status, SO_STATUS_COLORS[doc.status] || 'gray') : ''}
					</div>
				</div>
				<div class="mba-docitem-files">
					<a class="mba-doc-file-btn" href="${doc.pdf || doc_pdf_url(doc.doctype, doc.name)}" download
						title="${esc(__('Download document PDF'))}">⬇ PDF</a>
				</div>
			</div>`).join('');

		const typeCounts = { so: 0, si: 0, pi: 0 };
		docs.forEach((x) => { typeCounts[x.key] += 1; });
		const chips = docs.length ? `
			<div class="mba-bkg-chips">
				<button type="button" class="mba-doc-filter active" data-filter="all">${__('All')} · ${docs.length}</button>
				<button type="button" class="mba-doc-filter" data-filter="so">${__('Sales Order')} · ${typeCounts.so}</button>
				<button type="button" class="mba-doc-filter" data-filter="si">${__('Sales Invoice')} · ${typeCounts.si}</button>
				<button type="button" class="mba-doc-filter" data-filter="pi">${__('Proforma Invoice')} · ${typeCounts.pi}</button>
			</div>` : '';

		const docsCard = `
			<div class="mba-doc-card">
				<div class="mba-doc-card-head">
					<div class="mba-section-title">${__('Documents')}
						${docs.length ? `<span class="mba-count-pill">${docs.length}</span>` : ''}</div>
					${chips}
				</div>
				${docs.length ? `<div class="mba-doc-list">${items}</div>`
					: `<div class="mba-doc-empty">${__('No related documents (Sales Order / Invoice / Proforma) yet.')}</div>`}
			</div>`;

		// ----- Payments -----
		const tr = d.transactions || {};
		const pes = {};
		(tr.payments || []).forEach((pe) => {
			const e = pes[pe.name] || (pes[pe.name] = {
				name: pe.name, reference_date: pe.reference_date,
				creation: pe.creation, mode_of_payment: pe.mode_of_payment,
				reference_no: pe.reference_no, docstatus: pe.docstatus,
				paid_to: pe.paid_to, refs: [], amounts: {},
			});
			e.amounts[pe.currency] = round2((e.amounts[pe.currency] || 0) + pe.allocated_amount);
			const refLabel = (pe.reference_doctype === 'Sales Invoice' ? 'SI ' : 'SO ')
				+ pe.reference_name;
			if (!e.refs.includes(refLabel)) e.refs.push(refLabel);
		});
		const peRows = Object.values(pes);
		const fileMap = tr.payment_files || {};
		const fileBtns = (peName) => {
			const receipt = `
				<a class="mba-doc-file-btn" href="${pe_receipt_url(peName)}" download
					title="${esc(__('Download receipt PDF'))}">${__('Receipt')}</a>`;
			const files = fileMap[peName] || [];
			if (!files.length) return receipt;
			return receipt + files.map((f) => `
				<span class="mba-doc-file-actions">
					<button type="button" class="mba-doc-file-btn mba-file-view-btn"
						data-url="${esc(f.file_url)}" data-name="${esc(f.file_name)}"
						data-image="${f.is_image ? 1 : 0}"
						title="${esc(f.file_name)} · ${esc(__('Quick view'))}">👁</button>
					<a class="mba-doc-file-btn" href="${esc(f.file_url)}" download
						title="${esc(f.file_name)} · ${esc(__('Download attachment'))}">⬇</a>
				</span>`).join(' ');
		};
		const peItems = peRows.map((pe) => {
			const amt = Object.entries(pe.amounts)
				.map(([cur, v]) => fmtMoney(v, cur)).join('<br>');
			const statusMeta = PE_STATUS_META[pe.docstatus] || {};
			const meta = [
				pe.reference_date ? fmtDate(pe.reference_date) : fmtDate(pe.creation),
				pe.reference_no ? __('Ref') + ': ' + esc(pe.reference_no) : '',
				pe.paid_to ? esc(pe.paid_to) : '',
				pe.refs.length ? '→ ' + pe.refs.map(esc).join(' / ') : '',
			].filter(Boolean).join(' · ');
			return `
			<div class="mba-docitem" data-route="Payment Entry/${esc(pe.name)}">
				<span class="mba-docitem-chip mba-docitem-chip--pe">PE</span>
				<div class="mba-docitem-main">
					<a href="/app/payment-entry/${esc(pe.name)}">${esc(pe.name)}</a>
					<div class="mba-docitem-sub">${meta}</div>
				</div>
				<div class="mba-docitem-side">
					<div class="mba-docitem-amt">${amt}</div>
					${statusMeta.label ? `<div class="mba-docitem-badges">${badge(__(statusMeta.label), statusMeta.color)}</div>` : ''}
				</div>
				<div class="mba-docitem-files">${fileBtns(pe.name)}</div>
			</div>`;
		}).join('');

		// Ringkasan bayaran — kepala kad Payments.
		const pesOk = peRows.filter((pe) => pe.docstatus !== 2);
		let paysum = '';
		if (pesOk.length) {
			const totals = {};
			pesOk.forEach((pe) => Object.entries(pe.amounts).forEach(([cur, v]) => {
				totals[cur] = round2((totals[cur] || 0) + v);
			}));
			const total = Object.entries(totals).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
			const verified = pesOk.filter((pe) => pe.docstatus === 1).length;
			paysum = `<div class="mba-doc-paysum">
				<span>${__('Total Paid')} <b>${total}</b></span>
				<span>${__('Last payment')} <b>${fmtDate(pesOk[0].date)}</b></span>
				${badge(verified + '/' + pesOk.length + ' ' + __('Verified'), verified === pesOk.length ? 'green' : 'yellow')}
			</div>`;
		}
		const payCard = `
			<div class="mba-doc-card">
				<div class="mba-doc-card-head">
					<div class="mba-section-title">${__('Payments')}
						${peRows.length ? `<span class="mba-count-pill">${peRows.length}</span>` : ''}</div>
					${paysum}
				</div>
				${peRows.length ? `<div class="mba-doc-list">${peItems}</div>`
					: `<div class="mba-doc-empty">${__('No payment entry linked to this booking.')}</div>`}
			</div>`;

		pane.html(docsCard + payCard);
	}

	// ── L3 Tab Others — diskaun, affiliate, komisen, audit. ──
	function render_bkg_others(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		const p = d.profile || {};
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="other"]`);
		const row = (k, v, cls) => `
			<div class="mba-bkg-card-row${cls ? ' ' + cls : ''}"><span>${k}</span><span>${v}</span></div>`;

		// Diskaun penuh — satu currency (discount_currency = SO utama).
		let dscCard = '';
		{
			const cur = p.discount_currency || S.currency;
			const total = round2((p.voucher_discount || 0) + (p.price_rule_discount || 0) + (p.referral_discount || 0));
			if ((total > 0) || (p.pre_discount_total > 0)) {
				const money = (v) => fmtMoney(v || 0, cur);
				dscCard = bkg_section(__('Discount Information'), '',
					`<div class="mba-bkg-card">
						${row(__('Pre-Discount Total'), money(p.pre_discount_total), 'is-strong')}
						${row(__('Voucher Discount'), money(p.voucher_discount))}
						${row(__('Price Rule Discount'), money(p.price_rule_discount))}
						${row(__('Referral Discount'), money(p.referral_discount))}
						<div class="mba-bkg-card-row is-dsc"><span>${__('Total Discount')}</span><span>${total > 0 ? '− ' + money(total) : money(0)}</span></div>
					</div>`);
			}
		}

		// Profil affiliate ringkas + butang Call/WhatsApp.
		let affCard = '';
		{
			const a = d.affiliate_info;
			if (a) {
				affCard = bkg_section(__('Affiliate Profile'), '',
					`<div class="mba-bkg-card">
						<div class="mba-bkg-card-title">
							<a href="/app/affiliate-profile/${esc(a.name)}">${esc(a.full_name || a.name)}</a>
						</div>
						${a.referral_code ? row(__('Referral Code'), esc(a.referral_code)) : ''}
						${a.email ? row(__('Email'), '✉ ' + esc(a.email)) : ''}
						${a.phone ? row(__('Phone'), '☎ ' + esc(a.phone)) : ''}
						${a.phone ? `<div class="mba-bkg-card-actions">${call_wa_btns(a.phone)}</div>` : ''}
					</div>`);
			}
		}

		// Komisen affiliate — Affiliate Commission berpaut ke SO booking.
		let commissionCard = '';
		{
			const rows = d.commissions || [];
			if (rows.length) {
				const received = {};
				rows.forEach((c) => {
					if (c.status === 'Paid' && !c.is_reversal) {
						received[c.currency] = round2((received[c.currency] || 0) + c.amount);
					}
				});
				const receivedHtml = Object.entries(received).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
				const body = rows.map((c) => `
					<tr data-route="Affiliate Commission/${esc(c.name)}">
						<td><a href="/app/affiliate-commission/${esc(c.name)}">${esc(c.name)}</a>
							<div class="mba-cell-sub">${__('From')} <a href="/app/sales-order/${esc(c.sales_order)}">${esc(c.sales_order)}</a></div></td>
						<td class="num">${c.rate ? c.rate + '%' : '—'}${c.base ? ' · ' + esc(c.base) : ''}</td>
						<td class="num">${c.is_reversal ? '− ' + fmtMoney(c.amount, c.currency) : fmtMoney(c.amount, c.currency)}</td>
						<td>${c.is_reversal ? badge(__('Reversal'), 'red') : badge(__(c.status), COMMISSION_STATUS_COLORS[c.status] || 'gray')}</td>
					</tr>`).join('');
				commissionCard = bkg_section(__('Commission Received'), rows.length,
					`<div class="mba-table-wrap">
						<table class="mba-table">
							<thead><tr>
								<th>${__('Commission')}</th>
								<th class="num">${__('Rate')}</th>
								<th class="num">${__('Amount')}</th>
								<th>${__('Status')}</th>
							</tr></thead>
							<tbody>${body}</tbody>
						</table>
					</div>${receivedHtml ? `<div class="mba-bkg-dsc-note">${__('Received (Paid)')}: <b>${receivedHtml}</b></div>` : ''}`);
			}
		}

		const auditCard = bkg_section(__('Audit'), '',
			`<div class="mba-bkg-card">
				${row(__('Booked By'), esc(p.booked_by || '—'))}
				${row(__('Created'), esc(fmtDateTime(p.creation)))}
				${row(__('Modified'), esc(fmtDateTime(p.modified)))}
				${p.company ? row(__('Company'), esc(p.company)) : ''}
			</div>`);

		const duo = (dscCard && affCard)
			? `<div class="mba-bkg-others-grid">
				<div>${dscCard}</div><div>${affCard}</div></div>`
			: (dscCard + affCard);

		pane.html(duo + commissionCard + auditCard);
	}

	// Modal preview Trip — iframe laman web trip.
	const show_trip_preview = (url, title) => {
		const d = new frappe.ui.Dialog({ title: title || __('Trip Preview'), size: 'extra-large' });
		d.$body.html(`
			<div class="mba-file-viewer">
				<iframe class="mba-file-frame" src="${esc(url)}" title="${esc(title || '')}"></iframe>
				<div class="mba-file-actions">
					<a class="btn btn-default btn-sm" href="${esc(url)}" target="_blank" rel="noopener">${__('Open in new tab')}</a>
				</div>
			</div>`);
		d.show();
	};

	/* ========== public API ========== */
	return { init, on_show };
})();
