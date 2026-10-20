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
//      Tab More      — Booking Addon + Flight (dimuatkan lazily).
// 3. L3 BOOKING INFO — /app/manage-booking-app/booking/<name>. Topbar
//    breadcrumb; telefon = satu lajur (kad identiti + strip wang + 4 tab);
//    desktop = rail sticky kiri. Tab: Overview (Order Summary + timeline
//    dipendekkan), Travellers (kad/jadual + ZIP/XLSX/CSV), Documents
//    (SO/SI/PI + Payment Entries + resit), Others (diskaun, affiliate,
//    komisen, audit).
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
		'Incomplete': 'orange', 'Pending': 'orange', 'Verified': 'green', 'Valid': 'green',
		'Open for Update': 'yellow', 'Rejected': 'red',
	};
	const RES_STATUS_COLORS = { 'Pending Review': 'yellow', 'Confirmed': 'green', 'Cancelled': 'red' };
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
	const DOC_STATUS_OK = ['Verified', 'Valid'];

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

	// Butang Call & WhatsApp (wa.me) untuk satu nombor telefon.
	const call_wa_btns = (phone) => {
		const telRaw = String(phone || '').replace(/[^\d+]/g, '');
		const digits = telRaw.replace(/\D/g, '');
		const callLink = telRaw
			? `<a class="mba-quickbtn" href="tel:${esc(telRaw)}" title="${esc(__('Call customer'))}">${__('Call')}</a>` : '';
		const waLink = digits
			? `<a class="mba-quickbtn mba-quickbtn--wa" href="https://wa.me/${esc(digits.startsWith('0') ? '6' + digits : digits)}"
					target="_blank" rel="noopener" title="${esc(__('Open WhatsApp message in a new tab'))}">WhatsApp</a>` : '';
		return callLink + waLink;
	};

	// Ikon padat sebelah no. telefon (jadual) — panggilan (tel:) & chat
	// WhatsApp (wa.me, tab baharu). Same normalisasi nombor dengan di atas.
	const contact_icons = (phone) => {
		const telRaw = String(phone || '').replace(/[^\d+]/g, '');
		const digits = telRaw.replace(/\D/g, '');
		if (!digits) return '';
		return `
			<a class="mba-contact-icon" href="tel:${esc(telRaw)}" target="_blank" rel="noopener"
				title="${esc(__('Phone call'))}" aria-label="${esc(__('Phone call'))}">${frappe.utils.icon('phone', 'sm')}</a><a
				class="mba-contact-icon mba-contact-icon--wa" href="https://wa.me/${esc(digits.startsWith('0') ? '6' + digits : digits)}"
				target="_blank" rel="noopener" title="${esc(__('WhatsApp chat'))}" aria-label="${esc(__('WhatsApp chat'))}">${frappe.utils.icon('message-circle', 'sm')}</a>`;
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
	const DOC_STATUS_OPTIONS = ['', 'Incomplete', 'Verified', 'Open for Update', 'Rejected', 'Valid'];

	// Susunan logik Doc Status untuk sort (bukan abjad).
	const DOC_STATUS_RANK = { 'Incomplete': 0, 'Pending': 0, 'Open for Update': 1, 'Rejected': 2, 'Verified': 3, 'Valid': 4 };

	// Pilihan sort tab Travellers (L2 & L3) — kunci header jadual & dropdown.
	const TV_SORTS = {
		name: { label: 'Traveller Name', val: (t) => (t.traveller_name || '').toLowerCase() },
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

	const ROW_LIMITS = [10, 25, 50, 100, 0];
	const DEFAULT_LIMIT = 10;

	// Tab L2 (detail group/batch)
	const TABS = [
		{ id: 'overview', label: __('Overview') },
		{ id: 'booking', label: __('Bookings') },
		{ id: 'traveller', label: __('Travellers') },
		{ id: 'rooming', label: __('Rooms') },
		{ id: 'more', label: __('More') },
	];
	// Tab L3 (booking info)
	const BKG_TABS = [
		{ id: 'ov', label: __('Overview') },
		{ id: 'tv', label: __('Travellers') },
		{ id: 'doc', label: __('Documents') },
		{ id: 'other', label: __('Others') },
	];

	// Peta tab → kekunci state (bk/ad/tv/rm/fl)
	const TAB_STATE_KEY = { booking: 'bk', more: 'ad', traveller: 'tv', rooming: 'rm' };
	const SCOPE_TAB = { bk: 'booking', ad: 'more', tv: 'traveller', rm: 'rooming', fl: 'more' };

	const S = {
		page: null,
		wrapper: null,
		filters: { search: '', view: 'all', status: '', year: '', month: '', gtype: 'all', hidePassive: false, panelOpen: false },
		groups: [],
		items: [],
		currency: 'MYR',
		mode: 'list',          // 'list' | 'detail' | 'booking'
		detail: null,
		cache: {},             // { itemKey: { dashboard, bookings, addons, travellers, rooming, flights, profile } }
		state: {},             // { itemKey: { tab, bk{}, ad{}, tv{}, rm{}, fl{} } }
		tvFields: null,        // medan penapis dinamik tab Travellers (cache sekali)
		tvFieldsPromise: null,
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
		} else {
			show_list();
		}
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
			const data = await api('get_trip_groups', { search: id });
			S.currency = data?.currency || S.currency;
			let groups = pick(data?.groups || []);
			if (!groups.length) {
				const all = await api('get_trip_groups', {});
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
								<input type="text" id="mba-search" class="mba-search-input"
									placeholder="${__('Search group / trip / booking / customer / traveller...')}" />
							</div>
							<button type="button" class="btn btn-default btn-sm mba-filter-btn" id="mba-filter-btn">
								${__('Filters')} <span class="mba-filter-count" id="mba-filter-count"></span>
							</button>
						</div>
						<div class="mba-chip-row" id="mba-view-chips">
							<button type="button" class="mba-chip active" data-view="all">${__('All')}</button>
							<button type="button" class="mba-chip" data-view="upcoming">${__('Upcoming')}</button>
							<button type="button" class="mba-chip" data-view="past">${__('Past')}</button>
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
							<label class="mba-field"><span>${__('Time')}</span>
								<select id="mba-year" title="${__('Filter by departure / sailing time')}">
									<option value="">${__('All Time')}</option>
								</select></label>
							<label class="mba-field"><span>${__('Month')}</span>
								<select id="mba-month" title="${__('Filter by month of departure / sailing')}" disabled>
									<option value="">${__('All Months')}</option>
									${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}
								</select></label>
							<label class="mba-field mba-field--check">
								<input type="checkbox" id="mba-hide-passive"/>
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

		$w.find('#mba-year').on('change', function () {
			S.filters.year = $(this).val();
			if (!S.filters.year) {
				S.filters.month = '';
				$w.find('#mba-month').val('');
			}
			$w.find('#mba-month').prop('disabled', !S.filters.year);
			refresh_client_filters();
		});

		$w.find('#mba-month').on('change', function () {
			S.filters.month = $(this).val();
			refresh_client_filters();
		});

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
			S.filters.year = '';
			S.filters.month = '';
			S.filters.gtype = 'all';
			S.filters.hidePassive = false;
			$w.find('#mba-status').val('');
			$w.find('#mba-year').val('');
			$w.find('#mba-month').val('').prop('disabled', true);
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
		if (S.filters.year) n++;
		if (S.filters.month) n++;
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
		$d.on('click', '.mba-open-booking', function () {
			const b = $(this).data('booking');
			if (b) frappe.set_route('Form', 'Booking', b);
		});
		$d.on('click', '.mba-open-form', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('Form', 'Trip Group Date', g);
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

		// Analytics — donut dilukis bila <details> dibuka (pada telefon ia
		// mula tertutup; clientWidth 0 → SVG lebar salah).
		$d.on('toggle', '.mba-analytics', function () {
			if (!this.open) return;
			const key = $(this).closest('.mba-group').data('item');
			render_donuts($(this), S.cache[key]?.dashboard || {});
		});

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

		// Tapisan client-side pakej traveller (doc status + bilangan baris)
		// — kemaskini state & re-render melalui callback pakej pada pane.
		$d.on('change', '.mba-tv-docsel, .mba-tv-limitsel', function () {
			const $sel = $(this);
			const $pane = $sel.closest('.mba-tab-pane');
			const key = $sel.closest('.mba-group').data('item');
			const tvst = S.state[key]?.tv;
			if (!tvst) return;
			if ($sel.hasClass('mba-tv-docsel')) tvst.doc_status = String($sel.val() || '');
			else tvst.limit = parseInt($sel.val(), 10) || 0;
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
			if (st.tv.cf_open) {
				const $p = key.startsWith('bkg:')
					? $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="tv"]`)
					: pane_el(key, 'traveller');
				$p.find('.mba-cf-field').last().trigger('focus');
			}
		});
		$d.on('click', '.mba-cf-add', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			if (!st) return;
			st.tv.custom = [...(st.tv.custom || []), { doctype: '', fieldname: '', value: '' }];
			tv_cf_rerender(key);
			const $p = key.startsWith('bkg:')
				? $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="tv"]`)
				: pane_el(key, 'traveller');
			$p.find('.mba-cf-field').last().trigger('focus');
		});
		$d.on('click', '.mba-cf-del', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			const idx = $(this).data('idx');
			if (!st || idx == null) return;
			st.tv.custom.splice(idx, 1);
			tv_cf_rerender(key);
		});
		$d.on('change', '.mba-cf-field', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			const idx = $(this).data('idx');
			if (!st || idx == null) return;
			const [dt, fn] = String($(this).val() || '').split('|');
			const r = st.tv.custom[idx] || (st.tv.custom[idx] = {});
			r.doctype = dt || '';
			r.fieldname = fn || '';
			r.value = '';
			const $row = $(this).closest('.mba-cf-row');
			$row.find('.mba-cf-value').val('').trigger('focus');
			if (dt && fn) tv_cf_fill_datalist(key, $row);
			else $row.find('datalist').empty();
		});
		$d.on('input', '.mba-cf-value', function () {
			const key = $(this).closest('.mba-group').data('item');
			const st = S.state[key];
			const idx = $(this).data('idx');
			if (!st || idx == null || !st.tv.custom[idx]) return;
			st.tv.custom[idx].value = $(this).val();
		});
		$d.on('keydown', '.mba-cf-value', function (ev) {
			if (ev.key !== 'Enter') return;
			ev.preventDefault();
			tv_cf_reload($(this).closest('.mba-group').data('item'));
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
		// Traveller tidak membuka modal (tiada maklumat doctype; nama papar
		// guest_label) — butang aksi dalam kad kekal berfungsi.
		$d.on('click', '.mba-tvcard, tr.mba-tv-trow', function (ev) {
			if ($(ev.target).closest('a, button').length) return;
			let t = null;
			try { t = JSON.parse($(this).attr('data-trav')); } catch (e) { /* ignore */ }
			if (t && t.traveller) show_traveller_dialog(t);
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

		// Carian dalam tab (debounce) — toolbar tab biasa & toolbar pakej
		// traveller (.mba-tv-toolbar membawa tapisan server L2/L3 sebagai extras).
		$d.on('input', '.mba-tab-toolbar input[data-search], .mba-tv-toolbar input[data-search]', debounce(function () {
			const key = $(this).closest('.mba-group').data('item');
			const scope = $(this).data('search');       // bk | ad | tv | fl | rm
			const tab = SCOPE_TAB[scope];
			const st = S.state[key];
			if (!st || !tab || !st[scope]) return;
			st[scope].search = $(this).val();
			if (key.startsWith('bkg:') && scope === 'tv') load_bkg_travellers(key, true);
			else load_tab(key, tab, true);
		}, 350));

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
			else if (kind === 'doc' && st.tv) st.tv.doc_status = val;
			else if (kind === 'privacy' && st.rm) st.rm.privacy = val;
			else if (kind === 'limit' && scope && st[scope]) st[scope].limit = parseInt(val, 10) || 0;
			if (key.startsWith('bkg:') && scope === 'tv') load_bkg_travellers(key, true);
			else load_tab(key, tab, true);
		});

		// Link dalaman → navigasi SPA (bukan full reload)
		$d.on('click', 'a[href^="/app/"], .mba-card-click a[href^="/app/"]', function (ev) {
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

	// Pilihan tahun — derived daripada tarikh group yang dimuatkan.
	function sync_year_options() {
		const $y = $('#mba-year');
		if (!$y.length) return;
		const years = new Set([String(new Date().getFullYear())]);
		S.groups.forEach((g) => {
			const d = (g.departure_date || g.sailing_start || '');
			if (d) years.add(d.slice(0, 4));
		});
		const opts = [`<option value="">${__('All Time')}</option>`]
			.concat([...years].sort().reverse()
				.map((y) => `<option value="${y}">${y}</option>`));
		$y.html(opts.join(''));
		if (S.filters.year && years.has(S.filters.year)) {
			$y.val(S.filters.year);
		} else {
			S.filters.year = '';
			S.filters.month = '';
			$y.val('');
			$('#mba-month').val('').prop('disabled', true);
		}
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
			});
			S.groups = data?.groups || [];
			S.currency = data?.currency || 'MYR';
			sync_year_options();
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

		if (S.filters.year) {
			const y = String(S.filters.year);
			const m = S.filters.month ? parseInt(S.filters.month, 10) : 0;
			list = list.filter((g) => {
				const d = (g.departure_date || g.sailing_start || '').slice(0, 7);
				if (!d) return false;
				return d.slice(0, 4) === y && (!m || parseInt(d.slice(5, 7), 10) === m);
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
			const isActive = (g) => (g.booking_count || 0) > 0
				&& g.status !== 'Completed' && g.status !== 'Cancelled';
			return items.filter((it) => it.members.some(isActive));
		}
		return items;
	}

	function item_agg(it) {
		const a = {
			booking_count: 0, cancelled_count: 0, pax: 0, rooms: 0,
			docs_submitted: 0, docs_verified: 0, pending_docs: 0,
		};
		const byCur = {};
		const effDepart = (g) => g.departure_date || g.sailing_start || '';
		const effReturn = (g) => g.return_date || g.sailing_end || '';
		let depart = '', ret = '';
		it.members.forEach((g) => {
			a.booking_count += g.booking_count || 0;
			a.cancelled_count += g.cancelled_count || 0;
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
		const balCell = useDefault
			? fmtDefaultTotal(dt, 'balance')
			: fmtMoney((dt && dt.balance) || 0, S.currency);
		const curTitle = (field) => (a.by_cur.length
			? a.by_cur.map((r) => fmtMoney(r[field], r.currency)).join(' · ')
			: '');
		const collPct = dt && dt.revenue
			? Math.round(dt.collected / dt.revenue * 100) + '%'
				+ (dt.rates_complete === false ? '+' : '')
			: '—';
		return { revCell, revTitle: curTitle('revenue'), balCell, balTitle: curTitle('balance'), collPct };
	};

	// Jumlah ke atas item yang DIPAPARKAN (default currency — selamat
	// dijumlah kerana semuanya sudah ditukar).
	function footer_agg(items) {
		const f = {
			count: items.length,
			booking_count: 0, rooms: 0, pax: 0,
			docs_verified: 0, docs_submitted: 0, pending_docs: 0,
			dt: null,
		};
		items.forEach((it) => {
			const a = it.agg;
			f.booking_count += a.booking_count || 0;
			f.rooms += a.rooms || 0;
			f.pax += a.pax || 0;
			f.docs_verified += a.docs_verified || 0;
			f.docs_submitted += a.docs_submitted || 0;
			f.pending_docs += a.pending_docs || 0;
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
		return f;
	}

	function render_items() {
		const $list = $('#mba-list');

		if (!S.items.length) {
			$list.html(`<div class="mba-empty">${__('No Trip Group Date found for this filter.')}</div>`);
			$('#mba-summary').empty();
			return;
		}

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
						<th>${__('Trip Group / Batch')}</th>
						<th>${__('Trip')}</th>
						<th class="num">${__('Departure')}</th>
						<th class="num" title="${__('Active bookings only (excludes Cancelled & Abandoned)')}">${__('Bookings')}</th>
						<th class="num" title="${__('In default display currency')}">${__('Revenue')}</th>
						<th class="num" title="${__('Outstanding amount (revenue minus collected), in default currency')}">${__('Balance')}</th>
					</tr></thead>
					${S.items.map(render_group_row).join('')}
					${render_groups_footer(S.items)}
				</table>
			</div>`);
		sync_row_checks();
		update_batch_button();
		bind_sel_all();
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

	// Kad group (telefon) — 4 baris: nama+badge, trip, tarikh, stat mini.
	function render_group_card(it) {
		const a = it.agg;
		const titleLine = it.batch ? esc(it.batch) : esc(it.members[0].name);
		const batchBadge = it.batch ? badge(it.members.length + ' ' + __('groups'), 'violet') : '';
		const status = it.members.length === 1 ? it.members[0].status : null;
		const tripNames = [...new Set(it.members
			.map((g) => g.trip_name || g.trip_group_name || g.name)
			.filter(Boolean))];
		const dateLabel = a.depart
			? fmtDate(a.depart) + (a.ret && a.ret !== a.depart ? ' → ' + fmtDate(a.ret) : '')
			: (it.members.length === 1 ? group_dates_label(it.members[0]) : '');
		const dt = a.default_totals;
		const balCell = hasAltCur(a.by_cur) && dt
			? fmtDefaultTotal(dt, 'balance')
			: fmtMoney((dt && dt.balance) || 0, S.currency);
		const balTitle = a.by_cur.length
			? a.by_cur.map((r) => fmtMoney(r.balance, r.currency)).join(' · ') : '';

		return `
			<div class="mba-card mba-group ${it.batch ? 'mba-group--batch' : ''}" data-item="${esc(it.key)}">
				<input type="checkbox" class="mba-sel-group" title="${__('Select for Assign Group Batch')}"/>
				<div class="mba-card-click">
					<div class="mba-card-top">
						<span class="mba-card-title">${titleLine}</span>
						<span class="mba-card-badges">${batchBadge}${status ? badge(status, GROUP_STATUS_COLORS[status]) : ''}</span>
					</div>
					${tripNames.length ? `<div class="mba-card-sub" title="${esc(tripNames.join(', '))}">${esc(tripNames.join(', '))}</div>` : ''}
					${dateLabel ? `<div class="mba-card-date">${esc(dateLabel)}</div>` : ''}
					<div class="mba-card-stats">
						<span><b>${a.booking_count}</b> ${__('bookings')}</span>
						<span><b>${a.pax}</b> ${__('pax')}</span>
						<span class="${dt && dt.balance > 0.009 ? 'is-danger' : ''}" title="${esc(balTitle)}"><b>${balCell}</b> ${__('due')}</span>
					</div>
				</div>
			</div>`;
	}

	// Baris jadual group (desktop) — 8 kolum; butiran sekunder sebagai
	// sub-line dalam sel supaya jadual kekal padat.
	function render_group_row(it) {
		const a = it.agg;
		const titleLine = it.batch ? esc(it.batch) : esc(it.members[0].name);
		const batchBadge = it.batch ? badge(it.members.length + ' ' + __('groups'), 'violet') : '';
		const subLine = it.batch
			? esc(it.members.map((m) => m.name).join(', '))
			: (it.members[0].trip_group_name && it.members[0].trip_group_name !== it.members[0].name
				? esc(it.members[0].trip_group_name) : '');

		const tripNames = [...new Set(it.members
			.map((g) => g.trip_name || g.trip_group_name || g.name)
			.filter(Boolean))];
		const tripCell = tripNames.length
			? `<div class="mba-trip-cell" title="${esc(tripNames.join(', '))}">${esc(tripNames.join(', '))}</div>`
			: '—';

		const statuses = [...new Set(it.members.map((m) => m.status))];
		const statusCell = statuses.length === 1
			? badge(statuses[0], GROUP_STATUS_COLORS[statuses[0]])
			: statuses.map((s) => badge(s, GROUP_STATUS_COLORS[s])).join(' ');

		const { revCell, revTitle, balCell, balTitle, collPct } = item_money(a);
		const dtt = a.default_totals;
		const balCls = dtt && dtt.balance > 0.009 ? 'is-danger' : '';

		return `
			<tbody class="mba-group ${it.batch ? 'mba-group--batch' : ''}" data-item="${esc(it.key)}">
				<tr class="mba-group-row">
					<td class="mba-col-sel"><input type="checkbox" class="mba-sel-group" title="${__('Select for Assign Group Batch')}"/></td>
					<td>
						<div class="mba-cell-main ${it.batch ? 'is-batch' : ''}">${titleLine} ${batchBadge} ${statusCell}</div>
						${subLine ? `<div class="mba-cell-sub">${subLine}</div>` : ''}
					</td>
					<td>${tripCell}</td>
					<td class="num">
						${a.depart ? fmtDate(a.depart) : '—'}
						${a.ret && a.ret !== a.depart ? `<div class="mba-cell-sub">→ ${esc(fmtDate(a.ret))}</div>` : ''}
					</td>
					<td class="num">
						${a.booking_count}
						<div class="mba-cell-sub">${a.pax} ${__('pax')} · ${a.rooms} ${__('rooms')}</div>
					</td>
					<td class="num" title="${revTitle ? esc(__('Revenue per currency') + ': ' + revTitle) : ''}">
						${revCell}
						<div class="mba-cell-sub">${collPct} ${__('collected')}</div>
					</td>
					<td class="num ${balCls}" title="${balTitle ? esc(__('Balance per currency') + ': ' + balTitle) : ''}">
						${balCell}
						<div class="mba-cell-sub ${a.pending_docs > 0 ? 'is-danger' : ''}">${__('Docs')} ${a.docs_verified || 0}/${a.docs_submitted || 0}</div>
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
		const collCls = dt && dt.revenue && dt.collected >= dt.revenue ? 'is-success' : '';

		return `
			<tfoot>
				<tr>
					<td class="mba-tfoot-label" colspan="4">${__('Total')} (${f.count} ${__('rows')})</td>
					<td class="num">${f.booking_count}<div class="mba-cell-sub">${f.pax} ${__('pax')} · ${f.rooms} ${__('rooms')}</div></td>
					<td class="num">${dt ? fmtMoney(dt.revenue, dt.currency) + incomplete : fmtMoney(0, S.currency)}
						<div class="mba-cell-sub">${collPct} ${__('collected')}</div></td>
					<td class="num ${dt && dt.balance > 0.009 ? 'is-danger' : ''}">${dt ? fmtMoney(dt.balance, dt.currency) + incomplete : fmtMoney(0, S.currency)}
						<div class="mba-cell-sub ${f.pending_docs > 0 ? 'is-danger' : ''}">${__('Docs')} ${f.docs_verified}/${f.docs_submitted}</div></td>
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
				// Penapis dinamik — baris {doctype, fieldname, value} + togol panel.
				custom: [], cf_open: false },
			rm: { search: '', privacy: '', limit: DEFAULT_LIMIT },
			fl: { search: '', limit: DEFAULT_LIMIT },
		};
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

		const infoBits = [
			tripNames.length ? `<span title="${esc(tripNames.join(', '))}">${esc(tripNames.join(', '))}</span>` : '',
			dateLabel ? `<span>${esc(dateLabel)}</span>` : '',
			ships.length ? `<span>${esc(__('Ship'))}: ${esc(ships.join(', '))}</span>` : '',
			single && (g0.total_days || g0.total_nights)
				? `<span>${esc((g0.total_days || '—') + ' ' + __('days') + ' / ' + (g0.total_nights || '—') + ' ' + __('nights'))}</span>` : '',
		].filter(Boolean).join('');

		const dt = a.default_totals;
		const revCell = hasAltCur(a.by_cur) && dt
			? fmtDefaultTotal(dt, 'revenue')
			: fmtMoney((dt && dt.revenue) || 0, S.currency);
		const balCell = hasAltCur(a.by_cur) && dt
			? fmtDefaultTotal(dt, 'balance')
			: fmtMoney((dt && dt.balance) || 0, S.currency);

		return `
			<div class="mba-detail-head">
				<div class="mba-detail-actions">
					<button type="button" class="btn btn-default btn-sm mba-back-btn">${__('← All Groups')}</button>
					${single ? `<button type="button" class="btn btn-default btn-sm mba-open-form" data-group="${esc(g0.name)}">${__('Open Trip Group Date')}</button>` : ''}
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
				<div class="mba-stat-row">
					<span><b>${a.booking_count}</b> ${__('Bookings')}</span>
					<span><b>${a.pax}</b> ${__('Pax')}</span>
					<span><b>${a.rooms}</b> ${__('Rooms')}</span>
					<span><b>${revCell}</b> ${__('Revenue')}</span>
					<span class="${dt && dt.balance > 0.009 ? 'is-danger' : ''}"><b>${balCell}</b> ${__('Due')}</span>
					<span class="${a.pending_docs > 0 ? 'is-danger' : ''}"><b>${a.docs_verified || 0}/${a.docs_submitted || 0}</b> ${__('Docs')}</span>
				</div>
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
			more: (c.addons?.count ?? null) != null || (c.flights?.count ?? null) != null
				? (c.addons?.count ?? 0) + (c.flights?.count ?? 0)
				: null,
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
			// L3 — tab paparan sahaja, KECUALI Travellers yang dimuatkan
			// lazily daripada API disatukan (get_group_travellers).
			const $g = $('#mba-detail').find('.mba-group').filter(function () { return $(this).data('item') === key; });
			$g.find('.mba-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
			$g.find('.mba-tab-pane').removeClass('active').filter(`[data-pane="${tab}"]`).addClass('active');
			if (tab === 'tv') load_bkg_travellers(key);
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

		if (tab === 'more') {
			// Tab More — Addon + Flight dimuatkan serentak (lazily).
			const needAd = force || !S.cache[key]?.addons;
			const needFl = force || !S.cache[key]?.flights;
			if ($pane.length && (needAd || needFl)) $pane.html(`<div class="mba-loading">${__('Loading...')}</div>`);
			const jobs = [];
			if (needAd) jobs.push(
				api('get_group_addons', {
					trip_groups: st.ad.group ? [st.ad.group] : groups,
					status: st.ad.status || null,
					payment_status: st.ad.payment || null,
					search: st.ad.search || null,
					limit: st.ad.limit,
				}).then((ad) => { S.cache[key] = { ...(S.cache[key] || {}), addons: ad }; }));
			if (needFl) jobs.push(
				api('get_group_flights', {
					trip_groups: groups,
					search: st.fl.search || null,
					limit: st.fl.limit,
				}).then((fl) => { S.cache[key] = { ...(S.cache[key] || {}), flights: fl }; }));
			await Promise.all(jobs);
			if (is_active()) { render_more_tab(key); update_tab_counts(key); }
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
				cls: 'is-success', label: __('Revenue'), value: defaultTotalValue('revenue'),
				sub: revRows.map((r) => fmtMoney(r.revenue, r.currency)).join('<br>') || fmtMoney(0, S.currency),
				title: __('Per currency — amounts in different currencies are never summed'),
			},
			{
				cls: 'is-warn', label: __('Unpaid Balance'), value: defaultTotalValue('balance'),
				sub: revRows.map((r) => fmtMoney(r.balance, r.currency)).join('<br>') || fmtMoney(0, S.currency),
				title: __('Per currency — amounts in different currencies are never summed'),
			},
			{
				cls: 'is-danger', label: __('Pending Docs'), value: trv.pending_docs ?? 0,
				sub: `${__('Submitted')} ${trv.docs_submitted ?? 0}/${trv.pax || 0} · ${trv.docs_ok ?? 0} ${__('verified')}`,
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

		// Analytics — dipecah 3 section; setiap section = kumpulan panel
		// donut (Bookings / Travellers) atau senarai pecahan (Breakdowns).
		// Panel kosong dilangkau; section tanpa panel tak dipaparkan.
		const anSection = (title, bodyHtml) => (bodyHtml
			? `<div class="mba-an-sec"><div class="mba-an-sec-title">${esc(title)}</div>
				<div class="mba-an-grid">${bodyHtml}</div></div>` : '');

		const analytics = `
			<details class="mba-analytics" ${isDesktop() ? 'open' : ''}>
				<summary>${__('Analytics')}</summary>
				${anSection(__('Bookings'), [
					anDonut(__('Booking Status'), statusPairs(d.booking_status, 'status', 'count'), 'bkstatus'),
					anDonut(__('Payment Status'), statusPairs(d.payment_status, 'status', 'count'), 'paystatus'),
					anDonut(__('Booking Channel'), statusPairs(d.booking_channel, 'channel', 'count'), 'channel'),
					anDonut(__('Checkout Method'), statusPairs(d.checkout_method, 'method', 'count'), 'checkout'),
				].join(''))}
				${anSection(__('Travellers'), [
					anDonut(__('Departure Point'), dep_pairs(d), 'dep'),
					anDonut(__('Document Status'), doc_pairs(d), 'docstat'),
					anDonut(__('Traveller Age'), age_pairs(d), 'age'),
					anDonut(__('Gender'), gender_pairs(d), 'gender'),
					anDonut(__('Company'), company_pairs(d), 'company'),
					anDonut(__('Package Type'), package_pairs(d), 'pkgtype'),
					anDonut(__('Rooms by Category'), room_pairs(d), 'roomcat'),
					anDonut(__('Room Privacy'), privacy_pairs(d), 'privacy'),
				].join(''))}
				${anSection(__('Breakdowns'), [
					anBlock(__('Discount by Type'), dscHtml),
					anBlock(__('Affiliate'), affHtml),
				].join(''))}
			</details>`;

		pane_el(key, 'overview').html(`
			<div class="mba-kpi-grid">${kpiHtml}</div>
			${secLine ? `<div class="mba-sec-line">${secLine}</div>` : ''}
			<div class="mba-panel">
				<div class="mba-panel-head">${__('Revenue Timeline')}
					<span class="mba-panel-tools">
						<span class="mba-panel-sub">${__('Bar = sales · Line = cumulative, current rates')} · ≈ ${esc(tl.currency || S.currency)}${tl.rates_complete === false ? ' +' : ''}</span>
						<select class="mba-tl-select" name="tl_gran" title="${__('Time scale of the chart — full range from first to last booking order')}">
							<option value="day" ${S.tl.gran === 'day' ? 'selected' : ''}>${__('Daily')}</option>
							<option value="week" ${S.tl.gran === 'week' ? 'selected' : ''}>${__('Weekly')}</option>
							<option value="month" ${S.tl.gran === 'month' ? 'selected' : ''}>${__('Monthly')}</option>
						</select>
					</span>
				</div>
				<div class="mba-panel-body mba-chart" data-chart="rev-tl"></div>
			</div>
			${analytics}`);

		render_tl_chart(pane_el(key, 'overview').find('[data-chart="rev-tl"]'), tl);
		render_donuts(pane_el(key, 'overview'), d);
	}

	// Lukis semua donut Analytics dalam pane yang diberi. Placeholder
	// [data-donut] tanpa SVG sahaja yang dilukis — dipanggil semula oleh
	// handler toggle <details> bila panel dibuka pada telefon (lebar 0).
	function render_donuts($pane, d) {
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
			if ($el.find('svg').length) return;   // sudah dilukis
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
			height: 180,
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

	function render_travellers_tab(key) {
		const tv = S.cache[key]?.travellers;
		const it = find_item(key);
		const st = S.state[key];
		if (!tv || !it || !st) return;
		const rows = tv.travellers || [];
		const pane = pane_el(key, 'traveller');
		if (!rows.length) {
			pane.html(`<div class="mba-empty">${__('No travellers found for this filter.')}</div>`
				+ showing_footer(tv, __('travellers'), 'tv'));
			return;
		}

		const docOpts = DOC_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.tv.doc_status === o ? 'selected' : ''}>${esc(o || 'All Docs')}</option>`).join('');
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
				${group_filter_options(it.members, st.tv.group, 'tv')}
				<select data-kind="doc" data-scope="tv">${docOpts}</select>
				${limit_options('tv', st.tv.limit)}
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

	const tv_cf_active = (rows) => (rows || [])
		.filter((r) => r.doctype && r.fieldname && r.value != null && r.value !== '');

	// Butang togol pada toolbar (kiri, selepas tapisan standard).
	function tv_cf_toggle_html(tvst) {
		const n = tv_cf_active(tvst.custom).length;
		return `<button type="button" class="btn btn-default btn-xs mba-cf-toggle"
			title="${esc(__('Filter by any field'))}">
			${frappe.utils.icon('filter', 'sm')} ${__('Filter')}${n ? ` <span class="mba-count-pill">${n}</span>` : ''}</button>`;
	}

	// Panel baris penapis — terpapar bila tv.cf_open (kekal merentas render).
	function tv_cf_panel_html(tvst) {
		if (!tvst.cf_open) return '';
		const groups = S.tvFields || [];
		const rows = tvst.custom || [];
		const fieldOpts = (sel) => groups.map((g) => `<optgroup label="${esc(__(g.doctype))}">`
			+ g.fields.map((f) => `<option value="${esc(g.doctype + '|' + f.fieldname)}"
				${sel === g.doctype + '|' + f.fieldname ? 'selected' : ''}>${esc(f.label)}</option>`).join('')
			+ '</optgroup>').join('');
		return `
		<div class="mba-cf">
			${rows.map((r, i) => `
			<div class="mba-cf-row" data-idx="${i}">
				<select class="mba-cf-field" data-idx="${i}">
					<option value="">${__('— Select Field —')}</option>
					${fieldOpts(r.doctype ? r.doctype + '|' + r.fieldname : '')}
				</select>
				<input type="text" class="form-control mba-cf-value" data-idx="${i}" list="mba-cf-dl-${i}"
					placeholder="${esc(__('Value'))}" value="${esc(r.value ?? '')}" />
				<datalist id="mba-cf-dl-${i}"></datalist>
				<button type="button" class="btn btn-default btn-xs mba-cf-del" data-idx="${i}"
					title="${esc(__('Remove this filter'))}">✕</button>
			</div>`).join('')}
			<div class="mba-cf-actions">
				<button type="button" class="btn btn-default btn-xs mba-cf-add">+ ${__('Add Filter')}</button>
				${rows.length ? `<button type="button" class="btn btn-default btn-xs mba-cf-clear">${__('Clear All')}</button>
				<button type="button" class="btn btn-primary btn-xs mba-cf-apply">${__('Apply')}</button>` : ''}
			</div>
		</div>`;
	}

	// Isi datalist cadangan nilai untuk satu baris — skop ikut item
	// (group/batch L2 atau booking L3). Tidak re-render supaya fokus kekal.
	function tv_cf_fill_datalist(key, $row) {
		const idx = $row.data('idx');
		const st = S.state[key];
		const r = st?.tv?.custom?.[idx];
		if (!st || !r || !r.doctype || !r.fieldname) return;
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
			if ($(this).find('.mba-cf-field').val()) tv_cf_fill_datalist(key, $(this));
		});
	}

	/* ---------- L2 Tab Rooms (rooming) ---------- */

	function render_rooming_tab(key) {
		const rm = S.cache[key]?.rooming;
		const it = find_item(key);
		const st = S.state[key];
		if (!rm || !it || !st) return;

		const multi = it.members.length > 1;
		const rows = rm.rooms || [];

		// Senarai lipat per bilik — kepala 1 baris; kandungan senarai tetamu.
		const roomsHtml = rows.map((r) => {
			const guests = (r.guests || []).map((gst) => `
				<div class="mba-guest">
					<span class="mba-muted">${gst.guest_sequence || '·'}.</span>
					<span class="mba-cell-main">${esc(gst.name)}</span>
					${gst.gender ? `<span class="mba-guest-gender">${esc(__(gst.gender)).slice(0, 1)}</span>` : ''}
					${badge(gst.document_status, DOC_STATUS_COLORS[gst.document_status])}
				</div>`).join('');
			return `
			<details class="mba-room">
				<summary>
					<span class="mba-room-id">${esc(r.room_id)}</span>
					<span class="mba-room-cat">${esc(r.room_category)}${multi && r.trip_group ? ' · ' + esc(r.trip_group) : ''}</span>
					<span class="mba-room-right">
						<span class="${r.pending_docs > 0 ? 'is-danger' : 'is-success'}">${r.docs_ok}/${r.pax}</span>
						${r.cabin_confirmed ? badge(__('Confirmed'), 'green') : badge(__('Pending'), 'orange')}
					</span>
				</summary>
				<div class="mba-room-body">
					${r.stateroom_no || r.room_privacy
						? `<div class="mba-cell-sub">${r.stateroom_no ? __('Stateroom') + ': ' + esc(r.stateroom_no) : ''}${r.stateroom_no && r.room_privacy ? ' · ' : ''}${r.room_privacy ? esc(r.room_privacy) : ''}</div>` : ''}
					${(r.bookings || []).length ? `<div class="mba-room-bookings">${(r.bookings || []).map((b) => `<a href="/app/booking/${esc(b)}">${esc(b)}</a>`).join(' · ')}</div>` : ''}
					<div class="mba-guests">${guests || `<span class="mba-muted">—</span>`}</div>
				</div>
			</details>`;
		}).join('');

		const privacyOpts = [
			['', __('All Privacy')],
			['Private', __('Private')],
			['Open Sharing', __('Open Sharing')],
			['__blank__', __('Unspecified')],
		].map(([v, l]) => `<option value="${esc(v)}" ${st.rm.privacy === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

		pane_el(key, 'rooming').html(`
			<div class="mba-tab-toolbar">
				<input type="text" data-search="rm" placeholder="${__('Search room / category / traveller...')}"
					value="${esc(st.rm.search)}" />
				<select data-kind="privacy" data-scope="rm">${privacyOpts}</select>
				${limit_options('rm', st.rm.limit)}
			</div>
			${rows.length ? `<div class="mba-rooms">${roomsHtml}</div>`
				: `<div class="mba-empty">${__('No rooms found for this filter.')}</div>`}
			${showing_footer(rm, __('rooms'), 'rm')}`);
	}

	/* ---------- L2 Tab More (Addon + Flight) ---------- */

	function render_more_tab(key) {
		const ad = S.cache[key]?.addons;
		const fl = S.cache[key]?.flights;
		const it = find_item(key);
		const st = S.state[key];
		if (!ad || !fl || !it || !st) return;

		const multi = it.members.length > 1;

		// ----- Addons -----
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

		// ----- Flights -----
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

		const adStatusOpts = ADDON_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.ad.status === o ? 'selected' : ''}>${esc(o || 'All Status')}</option>`).join('');
		const adPayOpts = ADDON_PAYMENT_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.ad.payment === o ? 'selected' : ''}>${esc(o || 'All Payments')}</option>`).join('');

		pane_el(key, 'more').html(`
			<div class="mba-section-title">${__('Booking Addons')}
				<span class="mba-count-pill">${ad.count ?? 0}</span></div>
			<div class="mba-tab-toolbar">
				<input type="text" data-search="ad" placeholder="${__('Search addon / booking / customer...')}"
					value="${esc(st.ad.search)}" />
				${multi ? group_filter_options(it.members, st.ad.group, 'ad') : ''}
				<select data-kind="status" data-scope="ad">${adStatusOpts}</select>
				<select data-kind="payment" data-scope="ad">${adPayOpts}</select>
				${limit_options('ad', st.ad.limit)}
			</div>
			${adRows.length ? `<div class="mba-cards">${adCards}</div>${adTable}`
				: `<div class="mba-empty">${__('No addon orders found for this filter.')}</div>`}
			${showing_footer(ad, __('addon orders'), 'ad')}

			<div class="mba-section-title">${__('Flights')}
				<span class="mba-count-pill">${fl.count ?? 0}</span></div>
			<div class="mba-tab-toolbar">
				<input type="text" data-search="fl" placeholder="${__('Search PNR / title / airline / airport...')}"
					value="${esc(st.fl.search)}" />
				${limit_options('fl', st.fl.limit)}
			</div>
			${flRows.length ? `<div class="mba-cards">${flCards}</div>${flTable}`
				: `<div class="mba-empty">${__('No flights referenced by this group yet.')}</div>`}
			${showing_footer(fl, __('flights'), 'fl')}`);
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
						<button type="button" class="btn btn-primary btn-xs mba-open-booking"
							data-booking="${esc(p.name)}">${__('Open Booking Form')}</button>
					</div>
				</div>
				<div class="mba-bkg-shell">
					<aside class="mba-bkg-rail">${bkg_rail(p, d)}</aside>
					<div class="mba-bkg-main">
						${bkg_money_strip(p)}
						<div class="mba-tabs">
							${BKG_TABS.map((t) => `
								<button class="mba-tab ${st.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}
									${t.id === 'tv' && resCount ? `<span class="mba-count-pill">${resCount}</span>` : ''}
									${t.id === 'doc' && (docCount + peCount) ? `<span class="mba-count-pill">${docCount + peCount}</span>` : ''}
								</button>`).join('')}
						</div>
						<div class="mba-tab-panes">
							<div class="mba-tab-pane ${st.tab === 'ov' ? 'active' : ''}" data-pane="ov"></div>
							<div class="mba-tab-pane ${st.tab === 'tv' ? 'active' : ''}" data-pane="tv"></div>
							<div class="mba-tab-pane ${st.tab === 'doc' ? 'active' : ''}" data-pane="doc"></div>
							<div class="mba-tab-pane ${st.tab === 'other' ? 'active' : ''}" data-pane="other"></div>
						</div>
					</div>
				</div>
			</div>`);

		S.cache[key] = { ...(S.cache[key] || {}), profile: d };
		render_bkg_overview(key);
		// Tab Travellers L3 — sumber disatukan, dimuatkan lazily (bukan
		// lagi daripada profile.reservations).
		if (st.tab === 'tv') load_bkg_travellers(key);
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
	// default currency; sub = pecahan native per currency.
	function bkg_money_strip(p) {
		const rows = p.money_by_currency || [];
		const dt = p.default_totals;
		const alt = hasAltCur(rows) && dt;
		const val = (f) => (alt ? fmtDefaultTotal(dt, f) : fmtMoney((dt && dt[f]) || 0, S.currency));
		const sub = (f) => rows.map((r) => fmtMoney(r[f], r.currency)).join('<br>') || fmtMoney(0, S.currency);
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const title = esc(__('Per currency — amounts in different currencies are never summed'));

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
					<div class="mba-mitem-l">${__('Balance')}</div>
					<div class="mba-mitem-v">${val('balance')}</div>
					<div class="mba-mitem-s">${sub('balance')}</div>
				</div>
				<div class="mba-bkg-paystat">
					<div class="mba-mitem-l">${__('Payment Status')}</div>
					${badge(p.payment_status, PAYMENT_STATUS_COLORS[p.payment_status]) || '<span class="mba-muted">—</span>'}
				</div>
			</div>`;
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
		return bkg_section(__('Booking Timeline'), ev.length + tail.length,
			`${moreBtn}<div class="mba-bkg-tl">${items}${tail.join('')}</div>`);
	}

	function render_bkg_overview(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		$('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="ov"]`)
			.html(`${bkg_order_summary(d)}${bkg_timeline(d)}`);
	}

	// Modal detail traveller — SEMUA maklumat traveller + reservation.
	function show_traveller_dialog(t) {
		const crow = (k, v) => (v !== '' && v != null
			? `<div class="mba-bkg-card-row"><span>${k}</span><span>${v}</span></div>` : '');
		const card = (title, inner) => (inner ? `
			<div class="mba-bkg-card">
				<div class="mba-bkg-card-title">${title}</div>${inner}
			</div>` : '');
		const F = (v) => (v ? esc(v) : '');

		// Kolum kiri — imej passport ATAU preview dokumen (PDF), sticky
		// pada skrin biasa; tiada fail → modal satu kolum sahaja.
		const is_img_url = (u) => /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)($|\?)/i.test(u || '');
		const is_img = is_img_url(t.passport_image);
		const preview = !t.passport_image ? ''
			: (is_img
				? `<img class="mba-tvmodal-photo" src="${esc(t.passport_image)}" alt="${esc(t.traveller_name || '')}">`
				: `<iframe class="mba-tvmodal-frame" src="${esc(t.passport_image)}"
					title="${esc(__('Passport preview'))}"></iframe>`);
		const side = preview ? `<div class="mba-tvmodal-side">${preview}
			<div class="mba-file-actions">
				${is_img && t.traveller ? `<button type="button" class="btn btn-default btn-sm mba-crop-btn"
					title="${esc(__('Crop this document'))}">✂ ${__('Crop')}</button>` : ''}
				<a class="btn btn-default btn-sm" href="${esc(t.passport_image)}" download>⬇ ${__('Download')}</a>
				<a class="btn btn-default btn-sm" href="${esc(t.passport_image)}" target="_blank" rel="noopener">${__('Open in new tab')}</a>
			</div>
		</div>` : '';

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
		const addressParts = [t.address_line1, t.postcode, t.city, t.state, t.country].filter(Boolean);
		const emergencyVal = [
			t.emergency_contact_name ? esc(t.emergency_contact_name) : '',
			t.emergency_contact_relationship ? '(' + esc(t.emergency_contact_relationship) + ')' : '',
			t.emergency_contact_phone ? '<br>☎ ' + esc(t.emergency_contact_phone) : '',
		].filter(Boolean).join(' ');
		const contact = card('📞 ' + __('Contact Info'),
			crowS(__('Email'), t.email ? '✉ ' + esc(t.email) : '')
			+ crowS(__('Phone'), (t.phone ? '☎ ' + esc(t.phone) : '') + phone_actions(t.phone))
			+ crowS(__('Address'), addressParts.map(esc).join('<br>'))
			+ crowS(__('Emergency Contact'), emergencyVal + phone_actions(t.emergency_contact_phone)));
		const health = card('🩺 ' + __('Health & Special Needs'),
			crowS(__('Wheelchair Assistant'), F(t.wheelchair_assistant))
			+ crowS(__('Dietary Requirements'), F(t.dietary_requirements))
			+ crowS(__('Medical Conditions'), F(t.medical_conditions))
			+ crowS(__('Medicine / Treatment'), F(t.medicine_treatment)));

		// Konteks booking — Rooming, Cruise Cabin (jika ada nilai) & Reservation.
		const yesNo = (b) => (b ? badge(__('Confirmed'), 'green') : badge(__('Pending'), 'orange'));
		const rooming = card('🛏 ' + __('Rooming'),
			crow(__('Room ID'), F(t.room_id))
			+ crow(__('Room Category'), F(t.room_category))
			+ crow(__('Room Privacy'), F(t.room_privacy))
			+ crow(__('Guest Sequence'), t.guest_sequence ? esc(String(t.guest_sequence)) : '')
			+ crow(__('Guest Rooming Type'), F(t.pax_type))
			+ (t.cabin_confirmed != null ? crow(__('Room Arrangement'), yesNo(t.cabin_confirmed)) : ''));
		const cruise = (t.stateroom_no || t.delegate_no || (t.aroya_guest_no !== '' && t.aroya_guest_no != null)
			? card('🚢 ' + __('Cruise Cabin'),
				crow(__('Stateroom No'), F(t.stateroom_no))
				+ crow(__('Delegate No'), F(t.delegate_no))
				+ crow(__('Aroya Guest No'), t.aroya_guest_no !== '' && t.aroya_guest_no != null
					? esc(String(t.aroya_guest_no)) : ''))
			: '');
		const reservation = card('🧾 ' + __('Booking Reservation'),
			crow(__('Customer Message'), F(t.reservation_note) || esc('-'))
			+ crow(__('Reservation'), `<a href="/app/booking-reservation/${esc(t.reservation)}"
				target="_blank" rel="noopener">${esc(t.reservation)} ↗</a>`)
			+ crow(__('Status'), badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status]))
			+ crow(__('Registered'), t.traveller_created ? esc(fmtDateTime(t.traveller_created)) : '')
			+ crow(__('Last Updated'), t.traveller_modified ? esc(fmtDateTime(t.traveller_modified)) : ''));

		// Panel booking (aras booking) — No/ID, contact customer + aksi
		// call/WA, dan mesej booking; tangga pertama seksyen Booking Info.
		const bkNo = t.booking_number || t.booking || '';
		const bkIdDiffers = t.booking && t.booking !== t.booking_number;
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
				crowS(__('Booking No'), esc(bkNo)
					+ (bkIdDiffers ? ` <span class="mba-muted">(${esc(t.booking)})</span>` : ''))
				+ crowS(__('Booking Contact'), bkContactVal + bkContactActions)
				+ crowS(__('Booking Message'), t.booking_message ? esc(t.booking_message) : ''))
			: '';

		// Sub-heading pengasing seksyen dalam kolum info — Traveller's Info
		// (maklumat doctype Traveller) & Booking Info (konteks reservation).
		const sub_head = (label) => `<div class="mba-tvmodal-subhead">${label}</div>`;
		const bookingInfo = t.reservation
			? sub_head(__('Booking Info')) + bookingCard + rooming + cruise + reservation
			: '';

		// PC (skrin biasa) — modal maksimum, 2 kolum 50/50: preview dokumen
		// (kiri, sticky) + kad info (kanan, scroll). Telefon & modal tanpa
		// imej — satu kolum bertindan.
		frappe.msgprint({
			title: '👤 ' + (t.traveller_name || t.reservation),
			indicator: t.reservation_status === 'Cancelled' ? 'red' : 'blue',
			wide: true,
			message: `<div class="mba-tvmodal">
				${side}
				<div class="mba-tvmodal-info">
					${sub_head(__("Traveller's Info"))}
					${personal}${docs}${contact}${health}
					${bookingInfo}
				</div>
			</div>`,
		});

		// Butang dalam msgprint modal berada di luar container page — ikat
		// terus pada wrapper dialog (bukan delegasi $d).
		if (frappe.msg_dialog?.$wrapper) {
			frappe.msg_dialog.$wrapper.find('.mba-crop-btn').on('click', () => {
				frappe.msg_dialog.hide();
				show_crop_dialog({
					traveller: t.traveller,
					field: 'passport_image',
					url: t.passport_image,
					name: t.traveller_name || '',
				});
			});
			frappe.msg_dialog.$wrapper.find('.mba-file-view-btn').on('click', function () {
				const $b = $(this);
				show_file_viewer($b.data('name'), $b.data('url'), !!$b.data('image'));
			});
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
			if (!hit) return;
			const $g = $(`#mba-detail .mba-group[data-item="${k}"]`);
			const tvPane = $g.find('.mba-tab-pane[data-pane="tv"]');
			if (tvPane.length && tvPane.hasClass('active')) render_bkg_travellers(k);
			const trPane = $g.find('.mba-tab-pane[data-pane="traveller"]');
			if (trPane.length && trPane.hasClass('active')) render_travellers_tab(k);
		});
	}

	// Dialog crop dokumen passport — seret untuk pan, slider untuk zum,
	// bingkai tetap 3:4 (potret). Simpan → potong di kanvas (pilih resolution
	// asal) → muat naik → gantikan passport_image traveller.
	function show_crop_dialog(opts) {
		const dlg = new frappe.ui.Dialog({
			title: '✂ ' + __('Crop') + ' — ' + (opts.name || __('Passport')),
			primary_action_label: __('Save'),
			primary_action: () => save_crop(),
		});
		dlg.$body.html(`
			<div class="mba-crop">
				<div class="mba-crop-view">
					<img class="mba-crop-img" src="${esc(opts.url)}" alt="" draggable="false">
				</div>
				<div class="mba-crop-zoom">
					<span>−</span>
					<input type="range" class="mba-crop-range" min="0" max="100" value="0" />
					<span>+</span>
				</div>
			</div>`);

		const view = dlg.$body.find('.mba-crop-view').get(0);
		const img = dlg.$body.find('.mba-crop-img').get(0);
		const range = dlg.$body.find('.mba-crop-range').get(0);
		let natW = 0, natH = 0, minScale = 1, scale = 1, tx = 0, ty = 0;

		const apply = () => {
			const vw = view.clientWidth, vh = view.clientHeight;
			const w = natW * scale, h = natH * scale;
			tx = Math.min(0, Math.max(vw - w, tx));
			ty = Math.min(0, Math.max(vh - h, ty));
			img.style.width = w + 'px';
			img.style.left = tx + 'px';
			img.style.top = ty + 'px';
		};
		const set_scale = (s) => {
			const cx = tx + (natW * scale) / 2, cy = ty + (natH * scale) / 2;
			scale = s;
			tx = cx - (natW * scale) / 2;
			ty = cy - (natH * scale) / 2;
			apply();
		};
		const init = () => {
			natW = img.naturalWidth;
			natH = img.naturalHeight;
			if (!natW || !natH) return;
			const vw = view.clientWidth, vh = view.clientHeight;
			minScale = Math.max(vw / natW, vh / natH);
			scale = minScale;
			tx = (vw - natW * scale) / 2;
			ty = (vh - natH * scale) / 2;
			range.value = 0;
			apply();
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

		const save_crop = async () => {
			dlg.disable_primary_action && dlg.disable_primary_action();
			try {
				const vw = view.clientWidth, vh = view.clientHeight;
				const sx = -tx / scale, sy = -ty / scale;
				const sw = vw / scale, sh = vh / scale;
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(sw));
				canvas.height = Math.max(1, Math.round(sh));
				canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
				const is_png = /\.png($|\?)/i.test(opts.url || '');
				const blob = await new Promise((res) =>
					canvas.toBlob(res, is_png ? 'image/png' : 'image/jpeg', 0.92));
				const fname = `passport-${opts.traveller}-${Date.now()}.${is_png ? 'png' : 'jpg'}`;
				const fd = new FormData();
				fd.append('file', blob, fname);
				fd.append('doctype', 'Traveller');
				fd.append('docname', opts.traveller);
				fd.append('fieldname', opts.field || 'passport_image');
				fd.append('is_private', '0');
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
				await frappe.call({
					method: 'frappe.client.set_value',
					args: {
						doctype: 'Traveller',
						name: opts.traveller,
						fieldname: opts.field || 'passport_image',
						value: url2,
					},
				});
				refresh_traveller_caches(opts.traveller, url2, opts.field || 'passport_image');
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
		frappe.call({
			method: 'travel_booking.api.portal_traveller.request_guest_passport_link',
			args: { slot_name: t.reservation },
			freeze: true,
			freeze_message: __('Generating secure link…'),
		}).then((r) => {
			const d = r?.message;
			if (!d?.link) return;
			// No. WhatsApp — telefon traveller, fallback telefon customer
			// booking (cust_phone); normalisasi sama seperti call_wa_btns.
			const waPhone = String(t.phone || t.cust_phone || '').replace(/\D/g, '');
			const waDigits = waPhone.startsWith('0') ? '6' + waPhone : waPhone;
			const expires = String(d.expires_on || '').slice(0, 16).replace('T', ' ');
			// Mesej WhatsApp — ikut no. telefon yang digunakan: traveller ada
			// no. sendiri → pelawaan terus; tiada → guna no. customer booking,
			// minta customer lengkapkan dokumen ATAS NAMA traveller/guest
			// (nama traveller, fallback guest_label bila tiada nama).
			const onBehalfOf = (t.traveller_name && t.traveller_name !== '-')
				? t.traveller_name : (t.guest_label || 'the guest');
			const waMsg = t.phone
				? 'Hello ' + (t.traveller_name || '')
					+ ', please complete your submission of your passport & travel details for your trip via this secure link: '
					+ d.link + ' (valid until ' + expires + ')'
				: 'Hello ' + (t.customer_name || '')
					+ ', please complete your travel document on behalf of ' + onBehalfOf
					+ ' via this secure link: ' + d.link + ' (valid until ' + expires + ')';

			const dlg = new frappe.ui.Dialog({
				title: '🔗 ' + __('Guest Passport Link') + ' — ' + (t.traveller_name || t.reservation),
			});
			dlg.$body.html(`
				<div class="mba-glink">
					<div class="mba-glink-qr"><img src="${esc(d.qr_data_uri)}" alt="${esc(__('Guest passport link QR code'))}"></div>
					<div class="mba-glink-url">${esc(d.link)}</div>
					<div class="mba-glink-meta">${__('Valid until')} <b>${esc(expires)}</b></div>
					<div class="mba-file-actions">
						${waDigits ? `<a class="btn btn-default btn-sm mba-quickbtn mba-quickbtn--wa"
							href="https://wa.me/${esc(waDigits)}?text=${encodeURIComponent(waMsg)}"
							target="_blank" rel="noopener"
							title="${esc(__('Open WhatsApp message in a new tab'))}">💬 ${__('WhatsApp')}</a>` : ''}
						<button type="button" class="btn btn-default btn-sm mba-glink-copy">${__('Copy Link')}</button>
						<a class="btn btn-default btn-sm" href="${esc(d.link)}" target="_blank" rel="noopener">${__('Open')}</a>
					</div>
					${waDigits ? '' : `<div class="mba-glink-meta mba-muted">${__('No phone number on traveller or booking — share the link manually.')}</div>`}
				</div>`);
			dlg.show();
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
	function render_traveller_list(opts) {
		const target = opts.target;
		const rows = opts.rows || [];
		if (!target?.length || !rows.length) return;
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
			: (filterDoc === 'Incomplete'
				? ['', 'Incomplete'].includes(t.document_status || '')
				: t.document_status === filterDoc);
		const limitN = useFilters ? (parseInt(tvst.limit, 10) || 0) : 0;
		const list0 = filterDoc ? res.filter(docMatch) : res;
		const list = limitN > 0 ? list0.slice(0, limitN) : list0;
		const hay = tv_hay;
		// Julat tarikh perjalanan — DOB dalam julat ini ditanda merah.
		const tripStart = String(ctx.trip_start || '').slice(0, 10);
		const tripEnd = String(ctx.trip_end || '').slice(0, 10);

		// Kumpulan butang kecil kolum Status — lihat fail passport (jika
		// ada), jana link passport guest (perlu konteks reservation), edit
		// maklumat traveller (ikon); dikongsi kad & jadual.
		const is_img_url = (u) => /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)($|\?)/i.test(u || '');
		const status_btns = (t) => {
			const inner = [
				t.passport_image
					? `<button type="button" class="btn btn-default btn-xs mba-file-view-btn"
						data-name="${esc(__('Passport') + ' — ' + (t.traveller_name || t.reservation))}"
						data-url="${esc(t.passport_image)}" data-image="${is_img_url(t.passport_image) ? 1 : 0}"
						title="${esc(__('View passport file'))}">${frappe.utils.icon('eye', 'sm')}</button>`
					: '',
				t.reservation
					? `<button type="button" class="btn btn-default btn-xs mba-tv-link-btn"
						title="${esc(__('Create guest passport link'))}">${frappe.utils.icon('share-2', 'sm')}</button>`
					: '',
				t.traveller
					? `<a class="btn btn-default btn-xs" href="/app/traveller/${encodeURIComponent(t.traveller)}"
						title="${esc(__('Edit Traveller Info'))}">${frappe.utils.icon('pencil', 'sm')}</a>`
					: '',
			].filter(Boolean).join('');
			return inner ? `<div class="btn-group" role="group"
				aria-label="${esc(__('Traveller file actions'))}">${inner}</div>` : '';
		};

		const cards = list.map((t) => {
			const cancelled = t.reservation_status === 'Cancelled';
			// Tanpa rekod Traveller — nama papar guest_label & modal detail
			// dimatikan (tiada maklumat doctype untuk dipapar).
			const noTrav = !t.traveller;
			const displayName = noTrav ? (t.guest_label || t.traveller_name) : t.traveller_name;
			const photo = t.passport_image
				? `<img class="mba-tv-photo" src="${esc(t.passport_image)}" alt="${esc(displayName || '')}" loading="lazy">`
				: `<div class="mba-tv-photo mba-tv-photo--empty">👤</div>`;
			const sub = [
				[t.gender ? esc(__(t.gender)) : '', t.age != null ? esc(String(t.age)) : ''].filter(Boolean).join(' · '),
				t.email ? `✉ ${esc(t.email)}` : '',
				t.phone ? `☎ ${esc(t.phone)} ${contact_icons(t.phone)}` : '',
			].filter(Boolean).join('<br>') || '<span class="mba-muted">—</span>';
			return `
			<div class="mba-tvcard${cancelled ? ' mba-tvcard--cancelled' : ''}${noTrav ? ' mba-tv-nodialog' : ''}"
				data-res="${esc(t.reservation)}" data-hay="${esc(hay(t))}"
				data-trav="${esc(JSON.stringify(t))}">
				${photo}
				<div class="mba-tvcard-body">
					<div class="mba-tvcard-name">${esc(displayName)}</div>
					<div class="mba-tvcard-badges">
						${badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status])}
						${badge(t.document_status, DOC_STATUS_COLORS[t.document_status])}
					</div>
					<div class="mba-tvcard-sub">${sub}</div>
					${showBk ? `<div class="mba-tvcard-sub">${esc(t.booking_number || t.booking || '')}${t.customer_name ? ' · ' + esc(t.customer_name) : ''}</div>` : ''}
					<div class="mba-tv-status-actions">${status_btns(t)}</div>
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
			<tr class="mba-tv-trow${cancelled ? ' mba-row-cancelled' : ''}${t.traveller ? '' : ' mba-tv-nodialog'}"
				data-hay="${esc(hay(t))}" data-trav="${esc(JSON.stringify(t))}">
				<td>
					<div class="mba-cell-main">${esc(displayName)}${cancelled ? ' ' + badge(__('Cancelled'), 'red') : ''}</div>
					${t.email ? `<div class="mba-cell-sub">✉ ${esc(t.email)}</div>` : ''}
					${t.phone ? `<div class="mba-cell-sub">☎ ${esc(t.phone)} ${contact_icons(t.phone)}</div>` : ''}
				</td>
				${showBk ? `<td>
					<div class="mba-cell-main">${t.booking
						? `<a href="/app/manage-booking-app/booking/${encodeURIComponent(t.booking)}">${esc(t.booking_number || t.booking)}</a>`
						: esc(t.booking_number || '—')}</div>
					${t.customer_name ? `<div class="mba-cell-sub">${esc(t.customer_name)}</div>` : ''}
					${t.booking_status ? `<div class="mba-cell-sub">${badge(t.booking_status, BOOKING_STATUS_COLORS[t.booking_status])}</div>` : ''}
				</td>` : ''}
				<td>
					<div class="mba-cell-main">${t.gender ? esc(__(t.gender)) : '—'}</div>
					${(() => {
						const parts = [
							t.age != null ? esc(String(t.age)) : '',
							t.age_category ? esc(t.age_category)
								: (t.age_bucket && t.age_bucket !== 'Unknown'
									? badge(t.age_bucket, AGE_BUCKET_COLORS[t.age_bucket]) : ''),
						].filter(Boolean);
						return parts.length ? `<div class="mba-cell-sub">${parts.join(' · ')}</div>` : '';
					})()}
					${t.dob ? `<div class="mba-cell-sub">${dob_badge(t.dob)}</div>` : ''}
				</td>
				<td>
					<div class="mba-cell-main">${t.nationality ? esc(t.nationality) : '—'}</div>
					${t.passport_no ? `<div class="mba-cell-sub">PP: ${esc(t.passport_no)}</div>` : ''}
					${t.ic_number ? `<div class="mba-cell-sub">IC: ${esc(t.ic_number)}</div>` : ''}
				</td>
				<td>
					<div class="mba-cell-main">${[
						t.cabin_no ? '#' + esc(String(t.cabin_no)) : '',
						t.room_category && t.room_category !== 'Unassigned' ? esc(t.room_category) : '',
					].filter(Boolean).join(' ') || '—'}</div>
					${(() => {
						const p1 = [t.pax_type, t.room_privacy].filter(Boolean).map(esc).join(' · ');
						return p1 ? `<div class="mba-cell-sub">${p1}</div>` : '';
					})()}
					${(() => {
						// Maklumat kabin cruise (Delegate/Aroya/Stateroom)
						// diutamakan — bila wujud, rooming_ID disembunyikan;
						// tiada maklumat cruise → rooming_ID.
						const cruise = [
							t.delegate_no ? 'Del: ' + esc(t.delegate_no) : '',
							(t.aroya_guest_no !== '' && t.aroya_guest_no != null)
								? 'Aroya: ' + esc(String(t.aroya_guest_no)) : '',
							t.stateroom_no ? 'Stateroom: ' + esc(t.stateroom_no) : '',
						].filter(Boolean).join(' / ');
						if (cruise) return `<div class="mba-cell-sub">${cruise}</div>`;
						return t.room_id
							? `<div class="mba-cell-sub">ID: ${esc(t.room_id)}</div>` : '';
					})()}
				</td>
				<td>
					${status_btns(t)
						? `<div class="mba-tv-status-actions">${status_btns(t)}</div>`
						: '<span class="mba-muted">—</span>'}
					${badge(t.document_status, DOC_STATUS_COLORS[t.document_status])}
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
			<div class="mba-table-wrap mba-tv-tablewrap"${tvView === 'table' ? '' : ' style="display:none;"'}>
				<table class="mba-table">
					<thead><tr>
						${sort_th('name', 'Traveller')}
						${showBk ? sort_th('booking', 'Booking') : ''}
						${sort_th('age', 'Age')}
						${sort_th('nationality', 'Docs')}
						${sort_th('roomcat', 'Accommodation')}
						${sort_th('doc', 'Status')}
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
		// Carian di TENGAH toolbar — selepas section tapisan (kiri) dan
		// sebelum butang download (kanan). Dua mod: server_search (L2/L3 —
		// input data-search, reload via loader) atau carian client-side
		// (.mba-tv-search, tapis DOM sedia ada).
		const midSearch = opts.server_search
			? `<input type="text" class="form-control" data-search="tv"
				placeholder="${esc(opts.search_placeholder || __('Search traveller / passport / contact…'))}"
				value="${esc(tvst.search || '')}" />`
			: (opts.show_search !== false
				? `<input type="text" class="form-control mba-tv-search"
					placeholder="${esc(__('Search name / passport / room / contact…'))}" />`
				: '');
		target.html(`
			<div class="mba-tv-toolbar">
				<div class="mba-tv-toolbar-left">
					<div class="btn-group mba-tv-views" role="group" aria-label="${esc(__('Traveller view'))}">
						<button type="button" class="btn btn-default btn-xs mba-tv-view${tvView === 'grid' ? ' active' : ''}"
							data-view="grid" title="${esc(__('Card view'))}"
							aria-label="${esc(__('Card view'))}">${frappe.utils.icon('layout-grid', 'sm')}</button>
						<button type="button" class="btn btn-default btn-xs mba-tv-view${tvView === 'table' ? ' active' : ''}"
							data-view="table" title="${esc(__('Table view'))}"
							aria-label="${esc(__('Table view'))}">${frappe.utils.icon('table', 'sm')}</button>
					</div>
					${useFilters ? `<select class="mba-tv-docsel" title="${esc(__('Filter by document status'))}">${DOC_STATUS_OPTIONS.map((o) => `<option value="${esc(o)}" ${filterDoc === o ? 'selected' : ''}>${esc(o || 'All Docs')}</option>`).join('')}</select>
					<select class="mba-tv-limitsel" title="${esc(__('Rows to show'))}">${ROW_LIMITS.map((n) => `<option value="${n}" ${n === limitN ? 'selected' : ''}>${n === 0 ? __('All rows') : __('{0} rows', [n])}</option>`).join('')}</select>` : ''}
					${opts.toolbar_extras || ''}
				</div>
				<div class="mba-tv-toolbar-mid">${midSearch}</div>
				<div class="mba-tv-toolbar-right">
					${showDl ? `<span class="mba-tv-dl-label">${__('Download')}</span>
					<div class="btn-group" role="group" aria-label="${esc(__('Download travellers'))}">
						<a class="btn btn-default btn-xs" href="${dlBase}download_traveller_images?${dlQuery}"
							title="${esc(dlTitle)}">${__('Files')}</a>
						<a class="btn btn-default btn-xs" href="${dlBase}download_travellers_excel?${dlQuery}"
							title="${esc(__('Download all traveller & reservation details as Excel (XLSX)'))}">${__('XLSX')}</a>
						<a class="btn btn-default btn-xs" href="${dlBase}download_travellers_csv?${dlQuery}"
							title="${esc(__('Download all traveller & reservation details as CSV'))}">${__('CSV')}</a>
					</div>` : ''}
					<div class="mba-tv-sortby"></div>
				</div>
			</div>
			${opts.custom_filter_html || ''}
			${(filterDoc || (limitN > 0 && list0.length > list.length))
				? `<div class="mba-tv-count">${__('Showing')} ${list.length} / ${rows.length} ${__('travellers')}</div>` : ''}
			<div class="mba-tv-grid"${tvView === 'table' ? ' style="display:none;"' : ''}>${cards}</div>
			${table}
			${opts.footer_html || ''}`);

		// Order By — komponen standard Frappe (ikon arah asc/desc + dropdown
		// medan), state yang sama dengan klik header jadual (objek state
		// dilalui melalui opts.state — rujukan sama ke S.state[key].tv).
		new frappe.ui.SortSelector({
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
		if (!rows.length) {
			pane.html(`<div class="mba-empty">${__('No booking reservations for this booking.')}</div>`);
			return;
		}
		const p0 = d.profile || {};
		const tripStart = String((p0.is_a_cruise_trip
			? (p0.cruise_start || p0.departure_date) : p0.departure_date) || '').slice(0, 10);
		const tripEnd = String((p0.is_a_cruise_trip
			? (p0.cruise_end || p0.return_date) : p0.return_date) || '').slice(0, 10);
		const docOpts = DOC_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.tv.doc_status === o ? 'selected' : ''}>${esc(o || 'All Docs')}</option>`).join('');
		render_traveller_list({
			target: pane,
			rows,
			state: st.tv,
			context: {
				booking: d.booking,
				trip_start: tripStart,
				trip_end: tripEnd,
			},
			toolbar_extras: `<span class="mba-tv-extras">
				<select data-kind="doc" data-scope="tv">${docOpts}</select>
				${limit_options('tv', st.tv.limit)}
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
