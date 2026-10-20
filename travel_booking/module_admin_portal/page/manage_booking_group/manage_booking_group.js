// travel_booking/module_travel_booking/page/manage_booking_group/manage_booking_group.js
// Desk Page /desk/manage-booking-group — Manage Booking Group
//
// Struktur:
// 0. Carian toolbar — identiti group (nama / kod / batch / trip / ship)
//    + skop booking (nombor / customer), traveller (nama / passport) dan
//    stateroom (no / room_id); group yang memiliki padanan tersenarai.
// 1. DATATABLE senarai Trip Group Date — satu tbody per item (single
//    group atau diumpuk mengikut Group Batch Name tgd.group_batch).
//    Kolum: Trip Group/Batch · Trip Name · Group Status · Departure
//    (terawal) · Return (terkini) · Bookings (aktif, tiada
//    cancelled/abandoned) · Rooms · Pax · Docs (verified/submitted) ·
//    Revenue (jumlah dalam default currency; tooltip = pecahan native) ·
//    Balance (tertunggak) · Collection %.
//    Klik baris → buka page detail group/batch (laman berasingan).
// 2. Page detail — route /desk/manage-booking-group/group/<name>
//    (single group) atau /desk/manage-booking-group/batch/<batch>
//    (umpukan batch). Header ringkasan + maklumat lanjutan dalam TAB
//    (bukan edit doctype secara langsung):
//    Tab Dashboard — number card (Total Room, Bookings, Total Revenue,
//      Unpaid, Occupancy, Pending Docs) + garis masa revenue (penuh
//      lebar) + pie chart (status booking,
//      status payment, umur, jantina) + pecahan bilik, diskaun & affiliate
//    Tab Booking — senarai booking + carian/filter + row limit
//    Tab Booking Addon — senarai addon order ikut Booking Addon.trip_date
//      (status/payment filter, carian, row limit; footer amount dalam
//      default currency)
//    Tab Flight — charter flight (Booking.flight → Flight) yang dirujuk
//      booking group; kiraan booking & pax aktif ikut flight
//    Tab Traveller — senarai traveller ikut Booking Reservation (sudah
//      terfilter ikut trip group date) + row limit
//    Tab Rooming — senarai bilik ikut Room ID + maklumat traveller
// 3. Page Booking Info — route /desk/manage-booking-group/booking/<name>
//    (diklik dari seluruh sel kolum Booking No dalam tab Booking): satu
//    halaman SATU booking — susun atur RAIL KONTEKS:
//      breadcrumb (All Groups › Trip Group › booking) + butang Open
//      Booking Form; rail kiri sticky = identiti + progres payment,
//      customer, sales/channel, trip & stay, mesej customer;
//      strip wang sticky (Order → Paid % → Balance + Payment Status,
//      per currency); 3 TAB —
//      Tab Overview           — Order Summary (field virtual Booking,
//                               pecahan ikut kabin) + chip operasi +
//                               timeline booking (created → PI/SO →
//                               payments → T&C → balance → sail)
//      Tab Travellers         — contact card semua traveller +
//                               booking reservation (search box,
//                               klik kad → modal gambar dokumen)
//      Tab Documents          — dokumen berkaitan (SO / Sales Invoice /
//                               Proforma Invoice) + tapisan jenis + PDF
//                               + Payment Entries (lampiran quick-view /
//                               muat turun resit) + ringkasan bayaran
//      Tab Others             — audit (dipindah dari rail) + pecahan
//                               diskaun penuh + komisen affiliate
//                               (Affiliate Commission ikut SO)
//
// CURRENCY-SENSITIVE: semua nilai wang dipapar PER CURRENCY (pecahan
// `*_by_currency` dari backend) — SO booking utama/addon boleh dalam
// currency berbeza (paksi multi-company, tiada conversion), jadi angka
// currency berbeza TIDAK PERNAH dijumlah atau dicampur terus.
// Breakdown currency lain daripada default (Travel Settings > Default
// Display Currency) turut dijumlahkan sebagai nilai semasa ('≈') dalam
// default currency — kadar dari Currency Exchange, '+' bila tak lengkap.
//
// Backend: travel_booking/api/manage_trip_booking.py

frappe.pages['manage-booking-group'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Manage Booking Group'),
		single_column: true,
	});
	window.ManageTripBooking.init(page, wrapper);
};

frappe.pages['manage-booking-group'].on_page_show = function () {
	if (window.ManageTripBooking) window.ManageTripBooking.on_show();
};

/* ============================================================
   ManageTripBooking — controller (IIFE)
   ============================================================ */
window.ManageTripBooking = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	// Pilihan skala chart Revenue Timeline — kekal sepanjang sesi
	// (merentas group). Chart sentiasa memaparkan rentang penuh data:
	// dari booking order pertama hingga yang terakhir; user hanya
	// menukar skala paparan (harian/mingguan/bulanan). Default: harian.
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

	// Pecahan per-currency [{currency, revenue|gross|paid|balance|...}] →
	// "RM 1,000.00 · S$ 200.00". JANGAN jumlah merentas currency — SO
	// booking/addon boleh dalam currency berbeza (paksi multi-company,
	// tiada conversion), jadi setiap nilai dipaparkan dengan currency-nya.
	const fmtCurRows = (rows, field) => {
		const list = rows || [];
		if (!list.length) return fmtMoney(0, S.currency);
		return list.map((r) => fmtMoney(r[field], r.currency)).join(' · ');
	};
	// TRUE bila pecahan ada baki > 0 dalam mana-mana currency.
	const hasBalance = (rows) => (rows || []).some((r) => (r.balance || 0) > 0.009);

	// TRUE bila pecahan ada currency lain daripada default — barulah
	// jumlah bersamaan default currency ('≈') dipaparkan.
	const hasAltCur = (rows) => (rows || []).some((r) => r.currency && r.currency !== S.currency);

	// "≈ RM 82,010.00" — jumlah keseluruhan dalam default currency
	// (kadar semasa dari Currency Exchange). '+' bila ada currency
	// tanpa kadar (jumlah hanya meliputi currency yang sempat ditukar).
	const fmtDefaultTotal = (tot, field) => {
		if (!tot || tot[field] == null) return '';
		return '≈ ' + fmtMoney(tot[field], tot.currency || S.currency)
			+ (tot.rates_complete === false ? '+' : '');
	};

	// Warna badge mengikut states doctype (Trip Group Date / Booking)
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
		'Incomplete': 'orange', 'Pending': 'orange', 'Partially Paid': 'blue', 'Paid': 'green',
		'Request Refund': 'yellow', 'Pending Refund': 'yellow', 'Refunded': 'gray',
	};
	const ADDON_STATUS_COLORS = {
		'Pending': 'yellow', 'Confirmed': 'green', 'Cancelled': 'red',
	};
	const FLIGHT_STATUS_COLORS = {
		'Open': 'blue', 'Full': 'orange', 'Closed': 'gray', 'Completed': 'green',
	};
	const DOC_STATUS_COLORS = {
		'Pending': 'orange', 'Verified': 'green', 'Valid': 'green',
		'Open for Update': 'yellow', 'Rejected': 'red',
	};
	const AGE_BUCKET_COLORS = {
		'Infant': 'violet', 'Child': 'cyan', 'Adult': 'blue', 'Unknown': 'gray',
	};

	const badge = (label, color) =>
		label ? `<span class="mtb-badge mtb-badge--${color || 'gray'}">${esc(label)}</span>` : '';

	// Cell Message (pesanan khas customer — Booking.customer_message):
	// icon mesej bila ada mesej, "—" bila tiada. Tooltip menunjukkan
	// mesej penuh semasa hover; klik icon buka modal mesej penuh.
	// `title` = tajuk modal (biasanya no. booking).
	const msg_cell = (message, title) => {
		if (!message) return '<span class="mtb-muted">—</span>';
		return `<button type="button" class="btn btn-link mtb-msg-btn"
			title="${esc(message)}" data-message="${esc(message)}"
			data-title="${esc(title || __('Customer Message'))}"
			aria-label="${__('View customer message')}">
			${frappe.utils.icon('message-square', 'sm')}</button>`;
	};

	// Modal papar mesej penuh (dipanggil dari klik icon Message).
	const show_message_dialog = (title, message) => {
		frappe.msgprint({
			title: title,
			indicator: 'blue',
			message: `<div class="mtb-msg-body">${esc(message || '')}</div>`,
		});
	};

	// Penonton fail pantas — modal img (lampiran imej) atau iframe
	// (PDF / lain-lain) + butang muat turun & buka tab baharu. Dipanggil
	// dari butang 👁 pada kolum Attachment jadual Payment Entries.
	const show_file_viewer = (file_name, url, is_image) => {
		const body = is_image
			? `<img class="mtb-file-viewer-media" src="${esc(url)}" alt="${esc(file_name)}"/>`
			: `<iframe class="mtb-file-viewer-frame" src="${esc(url)}" title="${esc(file_name)}"></iframe>`;
		const d = new frappe.ui.Dialog({
			title: file_name || __('Attachment'),
			size: 'extra-large',
		});
		d.$body.html(`
			<div class="mtb-file-viewer">
				${body}
				<div class="mtb-file-viewer-actions">
					<a class="btn btn-default btn-sm" href="${esc(url)}" download>⬇ ${__('Download')}</a>
					<a class="btn btn-default btn-sm" href="${esc(url)}" target="_blank" rel="noopener">${__('Open in new tab')}</a>
				</div>
			</div>`);
		d.show();
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

	// Row limit untuk quick preview (0 = semua)
	const ROW_LIMITS = [10, 25, 50, 100, 0];
	const DEFAULT_LIMIT = 10;

	const TABS = [
		{ id: 'dashboard', label: __('Dashboard'), icon: '📊' },
		{ id: 'booking', label: __('Booking'), icon: '🧾' },
		{ id: 'addon', label: __('Booking Addon'), icon: '➕' },
		{ id: 'flight', label: __('Flight'), icon: '✈️' },
		{ id: 'traveller', label: __('Traveller'), icon: '👥' },
		{ id: 'rooming', label: __('Rooming'), icon: '🛏' },
	];

	// Peta tab → kekunci state/cache limit (bk/ad/tv/fl/rm)
	const TAB_STATE_KEY = { booking: 'bk', addon: 'ad', traveller: 'tv', flight: 'fl', rooming: 'rm' };
	const SCOPE_TAB = { bk: 'booking', ad: 'addon', tv: 'traveller', fl: 'flight', rm: 'rooming' };

	const S = {
		page: null,
		wrapper: null,
		filters: { search: '', status: '', view: 'all', year: '', month: '', gtype: 'all', hidePassive: false },
		groups: [],                 // raw daripada server
		items: [],                  // item selepas umpukan batch
		currency: 'MYR',
		mode: 'list',               // 'list' | 'detail' | 'booking'
		detail: null,               // { kind, id, key, loading, rendered }
		cache: {},                  // { itemKey: { dashboard, bookings, travellers, rooming } }
		state: {},                  // { itemKey: { tab, bk{}, tv{}, rm{} } }
		batchSel: new Set(),        // nama Trip Group Date dipilih utk Assign Group Batch
		loading: false,
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
					console.error('ManageTripBooking API Error:', method, err);
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

	/* ========== INITIALIZATION ========== */

	function init(page, wrapper) {
		S.page = page;
		S.wrapper = wrapper;

		build_layout();
		bind_toolbar();
		bind_list_events();
		route_apply();
	}

	function on_show() {
		// route semasa menentukan paparan — SPA bertukar antara senarai
		// dan page detail group/batch tanpa reload page.
		route_apply();
	}

	/* ========== ROUTE: senarai ↔ detail group/batch ========== */

	// /desk/manage-booking-group → senarai; /desk/manage-booking-group/group/<name>
	// dan /desk/manage-booking-group/batch/<batch> → paparan detail penuh.
	// (Router desk kekal page ini terpasang untuk sub-path, jadi
	// peralihan berlaku SPA tanpa reload.)
	function route_apply() {
		const r = frappe.get_route() || [];
		// r[2] sudah di-decode oleh router (parse → decode_component)
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
		$('#mtb-detail').hide().empty();
		$('#mtb-list-wrap').show();
		if (S.items.length) load(true);   // balik semula ke senarai — refresh
		else load();
	}

	function show_detail(kind, id) {
		const key = (kind === 'batch' ? 'batch:' : 'grp:') + id;
		if (S.mode === 'detail' && S.detail && S.detail.key === key
			&& (S.detail.loading || S.detail.rendered)) return;

		S.mode = 'detail';
		S.detail = { kind, id, key, loading: true, rendered: false };
		$('#mtb-list-wrap').hide();
		$('#mtb-detail').show().html(`<div class="mtb-loading">${__('Loading...')}</div>`);

		resolve_item(kind, id, key).then((it) => {
			if (!S.detail || S.detail.key !== key || S.mode !== 'detail') return;
			S.detail.loading = false;
			S.detail.rendered = true;
			S.detail.item = it;
			if (!it) {
				$('#mtb-detail').html(`
					<div class="mtb-empty">
						<p>${__('Trip Group Date {0} not found.', [esc(id)])}</p>
						<button class="btn btn-default btn-sm mtb-back-btn">${__('← All Groups')}</button>
					</div>`);
				return;
			}
			render_detail(it);
			ensure_item_loaded(key);
		});
	}

	// Cari item (group/batch) — daripada senarai sedia ada; kalau tak ada
	// (contoh deep-link atau group di luar filter semasa), fetch carian
	// server dan tapis padanan tepat nama/batch.
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

	// Route /manage-booking-group/booking/<name> — page Booking Info.
	// Sentiasa fetch semula (tiada cache): data booking — payment status,
	// SO, invois — berubah cepat, dan payload ni ringan (satu booking).
	function show_booking(name) {
		const key = 'bkg:' + name;
		if (S.mode === 'booking' && S.detail && S.detail.key === key
			&& (S.detail.loading || S.detail.rendered)) return;

		S.mode = 'booking';
		S.detail = { kind: 'booking', id: name, key, loading: true, rendered: false };
		$('#mtb-list-wrap').hide();
		$('#mtb-detail').show().html(`<div class="mtb-loading">${__('Loading...')}</div>`);

		api('get_booking_profile', { booking: name }).then((d) => {
			if (!S.detail || S.detail.key !== key || S.mode !== 'booking') return;
			S.detail.loading = false;
			S.detail.rendered = true;
			if (!d || !d.profile) {
				$('#mtb-detail').html(`
					<div class="mtb-empty">
						<p>${__('Booking {0} not found.', [esc(name)])}</p>
						<button class="btn btn-default btn-sm mtb-back-btn">${__('← All Groups')}</button>
					</div>`);
				return;
			}
			render_booking(key, d);
		}).catch(() => {
			if (!S.detail || S.detail.key !== key || S.mode !== 'booking') return;
			S.detail.loading = false;
			$('#mtb-detail').html(`
				<div class="mtb-empty">
					<p>${__('Error loading booking info.')}</p>
					<button class="btn btn-default btn-sm mtb-back-btn">${__('← All Groups')}</button>
				</div>`);
		});
	}

	/* ========== LAYOUT ========== */

	function build_layout() {
		const statusOpts = GROUP_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}">${esc(o || 'All Status')}</option>`).join('');
		const viewOpts = `
			<option value="all">${__('All Dates')}</option>
			<option value="upcoming">${__('Upcoming')}</option>
			<option value="past">${__('Past')}</option>`;

		$(S.wrapper).find('.layout-main-section').html(`
			<div class="mtb-container">
				<div id="mtb-list-wrap">
					<div class="mtb-toolbar">
						<div class="mtb-toolbar-row">
							<div class="mtb-search-box">
								<input type="text" id="mtb-search" class="mtb-search-input"
									placeholder="${__('Search group / trip / ship / booking no / customer / traveller / stateroom...')}" />
								<span class="mtb-search-icon">⌕</span>
							</div>
						</div>
						<div class="mtb-toolbar-row">
							<select id="mtb-status">${statusOpts}</select>
							<select id="mtb-view">${viewOpts}</select>
							<select id="mtb-year" title="${__('Filter by departure / sailing time')}">
								<option value="">${__('All Time')}</option>
							</select>
							<select id="mtb-month" title="${__('Filter by month of departure / sailing')}" disabled>
								<option value="">${__('All Months')}</option>
								${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}
							</select>
							<select id="mtb-gtype" title="${__('Filter by trip type')}">
								<option value="all">${__('All Groups')}</option>
								<option value="cruise">${__('Cruise')}</option>
								<option value="non-cruise">${__('Non-Cruise')}</option>
							</select>
							<label class="mtb-check" title="${__('Hide groups with no active booking, or Completed / Cancelled')}">
								<input type="checkbox" id="mtb-hide-passive"/> ${__('Hide Passive Group')}
							</label>
						</div>
					</div>
					<div class="mtb-bulk-bar">
						<button class="btn btn-primary btn-xs" id="mtb-assign-batch" disabled>${__('Assign Group Batch')}</button>
					</div>
					<div id="mtb-list"></div>
				</div>
					</div>
					<div id="mtb-list"></div>
				</div>
				<div id="mtb-detail" style="display:none"></div>
			</div>`);
	}

	function bind_toolbar() {
		const $w = $(S.wrapper);

		$w.find('#mtb-search').on('input', debounce(function () {
			S.filters.search = $(this).val();
			load();
		}, 350));

		$w.find('#mtb-status').on('change', function () {
			S.filters.status = $(this).val();
			load();
		});

		$w.find('#mtb-view').on('change', function () {
			S.filters.view = $(this).val();
			load();
		});

		// Time range (year / month) — tapis di frontend daripada senarai
		// sedia ada; month hanya aktif bila tahun dipilih.
		$w.find('#mtb-year').on('change', function () {
			S.filters.year = $(this).val();
			if (!S.filters.year) {
				S.filters.month = '';
				$w.find('#mtb-month').val('');
			}
			$w.find('#mtb-month').prop('disabled', !S.filters.year);
			S.items = build_items(S.groups);
			render_items();
		});

		$w.find('#mtb-month').on('change', function () {
			S.filters.month = $(this).val();
			S.items = build_items(S.groups);
			render_items();
		});

		// Group Type — tapis di frontend daripada senarai sedia ada
		// (tiada refetch server); render semula terus.
		$w.find('#mtb-gtype').on('change', function () {
			S.filters.gtype = $(this).val();
			S.items = build_items(S.groups);
			render_items();
		});

		// Hide Passive Group — tapis di frontend daripada senarai sedia
		// ada (tiada refetch server); render semula terus.
		$w.find('#mtb-hide-passive').on('change', function () {
			S.filters.hidePassive = this.checked;
			S.items = build_items(S.groups);
			render_items();
		});

		// Paparan detail group/batch — delegation dalam #mtb-detail
		$w.find('#mtb-detail').on('click', '.mtb-back-btn', () => frappe.set_route('manage-booking-group'));
		// Page Booking Info — balik ke page detail group booking ni.
		$w.find('#mtb-detail').on('click', '.mtb-back-group-btn', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('manage-booking-group', 'group', g);
			else frappe.set_route('manage-booking-group');
		});
		// Page Booking Info — buka Form Booking.
		$w.find('#mtb-detail').on('click', '.mtb-open-booking', function () {
			const b = $(this).data('booking');
			if (b) frappe.set_route('Form', 'Booking', b);
		});
		$w.find('#mtb-detail').on('click', '.mtb-member-chip', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('manage-booking-group', 'group', g);
		});
		// Rail Trip — klik pautan buka modal preview website trip
		// (href bukan /app/, jadi tak terjejas interception SPA).
		$w.find('#mtb-detail').on('click', '.mtb-trip-preview', function (ev) {
			ev.preventDefault();
			show_trip_preview(this.getAttribute('href'), this.textContent.trim());
		});
		// Rail Customer — butang Customer Message buka mesej penuh.
		$w.find('#mtb-detail').on('click', '.mtb-bkg-msg-btn', function () {
			show_message_dialog($(this).data('title') || __('Customer Message'), $(this).data('message'));
		});
		$w.find('#mtb-detail').on('click', '.mtb-open-form', function () {
			const g = $(this).data('group');
			if (g) frappe.set_route('Form', 'Trip Group Date', g);
		});
		// Chart Revenue Timeline — tukar skala (harian/mingguan/bulanan)
		// → lukis semula terus dari cache dashboard (tiada panggilan API).
		$w.find('#mtb-detail').on('change', '.mtb-tl-select', function () {
			const st = S.tl || (S.tl = { ...TL_DEFAULTS });
			st.gran = this.value;
			const d = S.cache[$(this).closest('.mtb-group').data('item')]?.dashboard;
			const $chart = $(this).closest('.mtb-panel').find('[data-chart="rev-tl"]');
			if (d && $chart.length) render_tl_chart($chart, d.revenue_timeline || {});
		});

		$w.find('#mtb-assign-batch').on('click', () => open_batch_dialog());
	}

	/* Event delegation atas root paparan — element di-render semula selalu,
	   jadi delegation elak masalah re-bind. Tab & table row wujud dalam
	   #mtb-list (senarai) ATAU #mtb-detail (paparan detail group/batch),
	   jadi handler merangkumi kedua-dua. */
	function bind_list_events() {
		const $list = $(S.wrapper).find('#mtb-list, #mtb-detail');

		// 1. klik baris ringkasan → buka page detail group/batch
		$list.on('click', 'tr.mtb-group-row', function (ev) {
			if ($(ev.target).closest('a, button, input, select').length) return;
			open_item($(this).closest('.mtb-group').data('item'));
		});

		// 1b. pilihan group untuk Assign Group Batch — batch row mewakili
		// semua group dalam batch itu.
		$list.on('change', '.mtb-sel-group', function () {
			const it = find_item($(this).closest('.mtb-group').data('item'));
			if (!it) return;
			const names = it.members.map((m) => m.name);
			if ($(this).is(':checked')) names.forEach((n) => S.batchSel.add(n));
			else names.forEach((n) => S.batchSel.delete(n));
			sync_row_checks();
			update_batch_button();
		});

		$list.on('change', '#mtb-sel-all', function () {
			const names = sel_all_names();
			if (this.checked) names.forEach((n) => S.batchSel.add(n));
			else S.batchSel.clear();
			sync_row_checks();
			update_batch_button();
		});

		// 2. tukar tab
		$list.on('click', '.mtb-tab', function (ev) {
			const key = $(this).closest('.mtb-group').data('item');
			switch_tab(key, $(this).data('tab'));
		});

		// 2b. tapisan jenis dokumen (page Booking Info, tab Documents) —
		// chip menapis item dalam pane yang sama (tiada refetch).
		$list.on('click', '.mtb-doc-filter', function () {
			const $chip = $(this);
			const $pane = $chip.closest('.mtb-tab-pane');
			$pane.find('.mtb-doc-filter').removeClass('active');
			$chip.addClass('active');
			const f = $chip.data('filter');
			$pane.find('.mtb-docrow').each(function () {
				$(this).toggle(f === 'all' || $(this).data('type') === f);
			});
		});

		// 2c. carian traveller (tab Travellers) — tapis kad & baris jadual
		// di pihak klien ikut data-hay (tiada refetch).
		$list.on('input', '.mtb-tv-search', debounce(function () {
			const q = String($(this).val() || '').toLowerCase().trim();
			$(this).closest('.mtb-tab-pane').find('[data-hay]').each(function () {
				$(this).toggle(!q || String($(this).data('hay') || '').includes(q));
			});
		}, 200));

		// 2c-b. tukar paparan Grid ⇄ Table (tab Travellers).
		$list.on('click', '.mtb-tv-view', function () {
			const $btn = $(this);
			const v = $btn.data('view');
			const $pane = $btn.closest('.mtb-tab-pane');
			$pane.find('.mtb-tv-view').removeClass('active');
			$btn.addClass('active');
			$pane.find('.mtb-tv-grid').toggle(v === 'grid');
			$pane.find('.mtb-tv-tablewrap').toggle(v === 'table');
		});

		// 2d. klik kad / baris jadual traveller → modal maklumat penuh
		// (pautan dikecualikan).
		$list.on('click', '.mtb-tvcard, tr.mtb-tv-trow', function (ev) {
			if ($(ev.target).closest('a').length) return;
			let t = null;
			try { t = JSON.parse($(this).attr('data-trav')); } catch (e) { /* ignore */ }
			if (t) show_traveller_dialog(t);
		});

		// 3. load more (tingkatkan limit kemudian fetch semula)
		$list.on('click', '.mtb-load-more', function () {
			const $pane = $(this).closest('.mtb-tab-pane');
			const key = $(this).closest('.mtb-group').data('item');
			const tab = $pane.data('pane');
			const st = S.state[key];
			if (!st || !tab) return;
			const limitKey = TAB_STATE_KEY[tab];
			if (!limitKey) return;
			const cur = st[limitKey].limit;
			// next step ikut senarai limit: 10→25→50→100→All
			let next = 0;
			if (cur > 0) {
				const idx = ROW_LIMITS.indexOf(cur);
				next = idx >= 0 && idx < ROW_LIMITS.length - 1 ? ROW_LIMITS[idx + 1] : cur + 25;
			}
			st[limitKey].limit = next;
			$pane.find('select[data-kind="limit"]').val(String(next));
			load_tab(key, tab, true);
		});

		// 4. carian dalam tab (debounce)
		$list.on('input', '.mtb-tab-toolbar input[data-search]', debounce(function () {
			const key = $(this).closest('.mtb-group').data('item');
			const scope = $(this).data('search');       // bk | ad | tv | fl | rm
			const tab = SCOPE_TAB[scope];
			const st = S.state[key];
			if (!st || !tab) return;
			st[scope].search = $(this).val();
			load_tab(key, tab, true);
		}, 350));

		// 5. select filter / row limit dalam tab
		$list.on('change', '.mtb-tab-toolbar select', function () {
			const key = $(this).closest('.mtb-group').data('item');
			const st = S.state[key];
			if (!st) return;
			const kind = $(this).data('kind');          // bk-status | bk-payment | tv-doc | limit
			const val = $(this).val();
			// tab daripada pane terdekat (semua select dalam tab toolbar)
			const tab = $(this).closest('.mtb-tab-pane').data('pane') || $(this).data('tab');
			if (!tab) return;
			if (kind === 'bk-status') st.bk.status = val;
			else if (kind === 'bk-payment') st.bk.payment = val;
			else if (kind === 'bk-group') st.bk.group = val;
			else if (kind === 'ad-status') st.ad.status = val;
			else if (kind === 'ad-payment') st.ad.payment = val;
			else if (kind === 'ad-group') st.ad.group = val;
			else if (kind === 'tv-doc') st.tv.doc_status = val;
			else if (kind === 'tv-group') st.tv.group = val;
			else if (kind === 'rm-privacy') st.rm.privacy = val;
			else if (kind === 'limit') {
				const limitKey = TAB_STATE_KEY[tab];
				if (limitKey) st[limitKey].limit = parseInt(val, 10) || 0;
			}
			load_tab(key, tab, true);
		});

		// 6. link dalaman → navigasi SPA, bukan full page reload
		$list.on('click', 'a[href^="/app/"]', function (ev) {
			ev.preventDefault();
			const href = $(this).attr('href');
			const parts = href.split('?')[0].replace(/^\/app\//, '').split('/').filter(Boolean);
			const qs = {};
			(href.split('?')[1] || '').split('&').forEach((kv) => {
				const [k, v] = kv.split('=');
				if (k) qs[k] = decodeURIComponent((v || '').replace(/\+/g, ' '));
			});

			// Sub-path page ni sendiri (cth. booking info) — route SPA
			// terus, bukan Form dokumen.
			if (parts[0] === 'manage-booking-group') {
				frappe.set_route(...parts);
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

		// 6b. kolum pertama tab Booking (Booking No) → page Booking Info —
		// seluruh cell boleh diklik; stopPropagation supaya baris (Form
		// Booking) tidak turut terbuka.
		$list.on('click', 'td.mtb-col-bkopen', function (ev) {
			ev.stopPropagation();
			const b = $(this).data('booking');
			if (b) frappe.set_route('manage-booking-group', 'booking', b);
		});

		// 7. baris table / item dokumen → buka dokumen (klik pautan &
		// butang lampiran dikecualikan)
		$list.on('click', 'tr[data-route], .mtb-docitem[data-route]', function (ev) {
			if ($(ev.target).closest('a, .mtb-msg-btn').length) return;
			const [doctype, docname] = ($(this).data('route') || '').split('/');
			if (doctype && docname) frappe.set_route('Form', doctype, docname);
		});

		// 8. icon Message → modal pesanan penuh
		$list.on('click', '.mtb-msg-btn', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			show_message_dialog($(this).data('title'), $(this).data('message'));
		});

		// 9. quick view lampiran Payment Entry → penonton fail modal
		$list.on('click', '.mtb-file-view-btn', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			show_file_viewer($(this).data('name'), $(this).data('url'), !!$(this).data('image'));
		});

	}

	/* ========== LOAD GROUP LIST ========== */

	// Pilihan tahun dropdown time range — derived daripada tarikh
	// berangkat/sailing group yang dimuatkan + tahun semasa. Pilihan
	// pengguna dikekalkan bila masih wujud; kalau tak, reset ke All Time.
	function sync_year_options() {
		const $y = $('#mtb-year');
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
			$('#mtb-month').val('').prop('disabled', true);
		}
	}

	async function load(force = false) {
		if (S.loading) return;
		S.loading = true;
		$('#mtb-list').html(`<div class="mtb-loading">${__('Loading trip groups...')}</div>`);

		if (force) {
			S.cache = {};
			// data berubah — pilihan batch mungkin tak lagi sah
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

		render_items();
	}

	/* ----- Umpukan batch: group yang share group_batch jadi satu item ----- */

	function build_items(groups) {
		// Filter Group Type — sebelum umpukan batch, supaya agregat batch
		// merangkumi anggota yang menepati filter sahaja (batch bercampur
		// cruise/non-cruise kekal muncul dengan anggota yang tinggal).
		let list = groups;
		if (S.filters.gtype === 'cruise') {
			list = list.filter((g) => g.is_a_cruise_trip);
		} else if (S.filters.gtype === 'non-cruise') {
			list = list.filter((g) => !g.is_a_cruise_trip);
		}

		// Filter time range — ikut tarikh berangkat/sailing berkesan
		// (departure_date, fallback sailing_start). Group tanpa tarikh
		// disembunyikan bila filter masa aktif.
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

		// Filter "Hide Passive Group" — buang group yang tiada booking
		// aktif (Cancelled/Abandoned tak dikira), ATAU berstatus
		// Completed / Cancelled. Batch dipaparkan selagi ada SEPARANG
		// anggota aktif; batch yang seluruh anggotanya passive dibuang.
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
		// Revenue/collected dijumlah HANYA dalam currency yang sama —
		// batch boleh ada group dalam currency berbeza.
		const byCur = {};
		// Tarikh seragam ISO — perbandingan string memadai untuk min/max.
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
				// fallback data lama tanpa pecahan (scalar satu currency)
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

	// Gabung default_totals (jumlah bersamaan default currency) merentas
	// group dalam satu batch — SELAMAT dijumlah kerana semuanya sudah
	// dalam currency yang sama. Member tanpa default_totals (cache lama)
	// diabaikan.
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

	const round2 = (n) => Math.round((n || 0) * 100) / 100;

function find_item(key) {
	// Item detail (deep-link / luar filter senarai) disimpan dalam
	// S.detail.item — find_item kekal sumber tunggu pencarian item.
	return S.items.find((it) => it.key === key)
		|| (S.detail && S.detail.key === key ? S.detail.item : null);
}

function item_groups(it) {
	return it.members.map((m) => m.name);
}

	/* ========== RENDER GROUP LIST ========== */

	// Datatable senarai — satu tbody per item (single group / batch):
	// satu baris ringkasan; klik membuka page detail group/batch.
	function render_items() {
		const $list = $('#mtb-list');

		if (!S.items.length) {
			$list.html(`<div class="mtb-empty">${__('No Trip Group Date found for this filter.')}</div>`);
			return;
		}

		$list.html(`
			<div class="mtb-table-wrap">
				<table class="mtb-table mtb-groups-table">
					<thead><tr>
						<th class="mtb-col-sel"><input type="checkbox" id="mtb-sel-all" title="${__('Select all groups')}"/></th>
						<th class="mtb-col-name">${__('Trip Group / Batch')}</th>
						<th class="mtb-col-trip">${__('Trip Name')}</th>
						<th class="mtb-col-status">${__('Status')}</th>
						<th class="num mtb-col-depart">${__('Departure')}</th>
						<th class="num mtb-col-ret">${__('Return')}</th>
						<th class="num mtb-col-bookings" title="${__('Active bookings only (excludes Cancelled & Abandoned)')}">${__('Bookings')}</th>
						<th class="num mtb-col-rooms">${__('Rooms')}</th>
						<th class="num mtb-col-pax">${__('Pax')}</th>
						<th class="num mtb-col-docs" title="${__('Verified / submitted document')}">${__('Docs')}</th>
						<th class="num mtb-col-rev">${__('Revenue')}</th>
						<th class="num mtb-col-bal" title="${__('Outstanding amount (revenue minus collected), in default currency')}">${__('Balance')}</th>
						<th class="num mtb-col-collpct" title="${__('Collected vs revenue, in default currency')}">${__('Collection %')}</th>
					</tr></thead>
					${S.items.map(render_item_group).join('')}
					${render_groups_footer(S.items)}
				</table>
			</div>`);
		sync_row_checks();
		update_batch_button();
	}

	// Checkbox pilihan group (untuk Assign Group Batch) — batch row
	// mewakili SEMUA group dalam batch itu.
	function sel_all_names() {
		const names = [];
		S.items.forEach((it) => it.members.forEach((m) => names.push(m.name)));
		return names;
	}

	function sync_row_checks() {
		$('#mtb-list .mtb-sel-group').each(function () {
			const it = find_item($(this).closest('.mtb-group').data('item'));
			if (!it) return;
			this.checked = it.members.every((m) => S.batchSel.has(m.name));
		});
		const $all = $('#mtb-sel-all');
		if ($all.length) {
			const names = sel_all_names();
			$all[0].checked = names.length > 0 && names.every((n) => S.batchSel.has(n));
		}
	}

	function update_batch_button() {
		const $b = $('#mtb-assign-batch');
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

		// Hantar ke backend — batch kosong = keluarkan group daripada batch.
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
				// Nama batch dipaksa uppercase; input kosong → suruh guna
				// butang Unset (pengguna perlu niat jelas untuk unset).
				const name = (values.group_batch || '').trim().toUpperCase();
				if (!name) {
					frappe.show_alert({
						message: __('Batch name is blank — use "Unset Batch Name" to remove the selected groups from their batch.'),
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
		// Uppercase semasa input (blur/change) — pasti konsisten
		d.get_field('group_batch').$input.on('change', function () {
			this.value = (this.value || '').toUpperCase();
		});
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

	// Kolum wang ringkasan item — revenue & balance (default currency
	// bila bercampur currency) + % collection; tooltip = pecahan native
	// per currency.
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

	function render_item_group(it) {
		return `
			<tbody class="mtb-group ${it.batch ? 'mtb-group--batch' : ''}" data-item="${esc(it.key)}">
				${render_item_row(it)}
			</tbody>`;
	}

	// Agregat footer — jumlah ke atas item yang DIPAPARKAN (selepas
	// filter). Revenue/Collection dipaparkan dalam default currency sahaja
	// (jumlah default_totals — SELAMAT dijumlah merentas item kerana
	// semuanya sudah ditukar ke currency yang sama).
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

	function render_groups_footer(items) {
		if (!items.length) return '';
		const f = footer_agg(items);
		const dt = f.dt;
		// '+' bila ada currency tanpa kadar — jumlah bukan lengkap.
		const incomplete = dt && dt.rates_complete === false ? '+' : '';
		const collPct = dt && dt.revenue
			? Math.round(dt.collected / dt.revenue * 100) + '%' + incomplete
			: '—';
		const collCls = dt && dt.revenue && dt.collected >= dt.revenue ? 'mtb-success' : '';

		return `
			<tfoot>
				<tr>
					<td class="mtb-tfoot-label" colspan="6">${__('Total')} (${f.count} ${__('rows')})</td>
					<td class="num">${f.booking_count}</td>
					<td class="num">${f.rooms}</td>
					<td class="num">${f.pax}</td>
					<td class="num ${f.pending_docs > 0 ? 'mtb-danger' : ''}">${f.docs_verified}/${f.docs_submitted}</td>
					<td class="num">${dt ? fmtMoney(dt.revenue, dt.currency) + incomplete : fmtMoney(0, S.currency)}</td>
					<td class="num ${dt && dt.balance > 0.009 ? 'mtb-danger' : ''}">${dt ? fmtMoney(dt.balance, dt.currency) + incomplete : fmtMoney(0, S.currency)}</td>
					<td class="num ${collCls}">${collPct}</td>
				</tr>
			</tfoot>`;
	}

	function render_item_row(it) {
		const a = it.agg;

		// Kolum 1: Group Batch Name bila wujud, selain itu kod group.
		const titleLine = it.batch ? esc(it.batch) : esc(it.members[0].name);
		const batchBadge = it.batch ? badge(it.members.length + ' ' + __('groups'), 'violet') : '';

		// Kolum Trip Name — unique nama trip dalam group/batch.
		const tripNames = [...new Set(it.members
			.map((g) => g.trip_name || g.trip_group_name || g.name)
			.filter(Boolean))];
		const tripCell = tripNames.length
			? `<div class="mtb-trip-cell" title="${esc(tripNames.join(', '))}">${esc(tripNames.join(', '))}</div>`
			: '—';

		// Kolum Group Status — single group → status group; batch →
		// badge status bila SEMUA member sama, selain itu semua status
		// unik dipaparkan.
		const statuses = [...new Set(it.members.map((m) => m.status))];
		const statusCell = statuses.length === 1
			? badge(statuses[0], GROUP_STATUS_COLORS[statuses[0]])
			: statuses.map((s) => badge(s, GROUP_STATUS_COLORS[s])).join(' ');

		// Revenue & Balance dalam default currency (compiled); tooltip =
		// pecahan native per currency. % Collection = collected / revenue
		// (kedua-dua dalam default currency supaya nisbah sah merentas
		// campuran currency). '+' bila ada currency tanpa kadar.
		const { revCell, revTitle, balCell, balTitle, collPct } = item_money(a);
		const dtt = a.default_totals;
		const collCls = !dtt || !dtt.revenue ? '' : (dtt.collected >= dtt.revenue ? 'mtb-success' : '');
		const balCls = dtt && dtt.balance > 0.009 ? 'mtb-danger' : '';

		return `
			<tr class="mtb-group-row">
				<td class="mtb-col-sel"><input type="checkbox" class="mtb-sel-group" data-item="${esc(it.key)}" title="${__('Select for Assign Group Batch')}"/></td>
				<td class="mtb-col-name">
					<div class="mtb-cell-main">${titleLine} ${batchBadge}</div>
				</td>
				<td class="mtb-col-trip">${tripCell}</td>
				<td class="mtb-col-status">${statusCell}</td>
				<td class="num mtb-col-depart">${a.depart ? fmtDate(a.depart) : '—'}</td>
				<td class="num mtb-col-ret">${a.ret ? fmtDate(a.ret) : '—'}</td>
				<td class="num mtb-col-bookings">${a.booking_count}</td>
				<td class="num mtb-col-rooms">${a.rooms}</td>
				<td class="num mtb-col-pax">${a.pax}</td>
				<td class="num mtb-col-docs ${a.pending_docs > 0 ? 'mtb-danger' : ''}">${a.docs_verified || 0}/${a.docs_submitted || 0}</td>
				<td class="num mtb-col-rev" title="${revTitle ? esc(__('Revenue per currency') + ': ' + revTitle) : ''}">${revCell}</td>
				<td class="num mtb-col-bal ${balCls}" title="${balTitle ? esc(__('Balance per currency') + ': ' + balTitle) : ''}">${balCell}</td>
				<td class="num mtb-col-collpct ${collCls}">${collPct}</td>
			</tr>`;
	}

	/* ---------- Paparan detail group/batch (page berasingan) ---------- */

	function render_detail(it) {
		S.state[it.key] = S.state[it.key] || default_state();
		$('#mtb-detail').html(`
			<div class="mtb-group mtb-detail-card" data-item="${esc(it.key)}">
				${render_detail_header(it)}
				<div class="mtb-group-body">${render_item_body(it)}</div>
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

	// Batch — senarai group anggota; klik → page detail group itu.
	// Setiap maklumat (nama trip, tarikh) satu baris sendiri — chip
	// flex-column + nowrap, jadi gabungan '·' akan terpotong.
	const memberChips = (!single && it.members.length)
		? it.members.map((m) => `
			<button type="button" class="mtb-chip mtb-member-chip" data-group="${esc(m.name)}"
				title="${esc(__('Open group detail'))}">
				<b>${esc(m.name)}</b>
				${[m.trip_name || '', group_dates_label(m)].filter(Boolean)
					.map((line) => `<span class="mtb-chip-sub">${esc(line)}</span>`).join('')}
			</button>`).join('')
		: '';

		// Meta info — trip, tarikh, kapal & senarai group dalam satu table
		const tripNames = [...new Set(it.members
			.map((m) => m.trip_name || m.trip_group_name || '').filter(Boolean))];
		const ships = [...new Set(it.members.map((m) => m.ship_name || '').filter(Boolean))];
		const dateLabel = single ? group_dates_label(g0)
			: (a.depart ? fmtDate(a.depart) + (a.ret && a.ret !== a.depart ? ' → ' + fmtDate(a.ret) : '') : '');

		// Badge dalam cell — satu setiap baris bila lebih satu
		const badgeCol = (values, color) => `
			<div class="mtb-meta-badges">${values.map((v) => badge(v, color)).join('')}</div>`;

		const metaTable = `
			<table class="mtb-meta-table">
				${tripNames.length ? `<tr><td>${esc(__('Trip'))}</td><td>${badgeCol(tripNames, 'violet')}</td></tr>` : ''}
				${dateLabel ? `<tr><td>${esc(__('Date'))}</td><td>${badgeCol([dateLabel], 'blue')}</td></tr>` : ''}
				${ships.length ? `<tr><td>${esc(__('Ship'))}</td><td>${badgeCol(ships, 'cyan')}</td></tr>` : ''}
				${memberChips ? `<tr><td>${esc(__('Groups'))}</td><td><div class="mtb-meta-badges">${memberChips}</div></td></tr>` : ''}
			</table>`;

		// Hari/malam — teks biasa di bawah table
		const durHtml = (single && (g0.total_days || g0.total_nights))
			? `<div class="mtb-detail-meta">${esc((g0.total_days || '—') + ' ' + __('days') + ' / '
				+ (g0.total_nights || '—') + ' ' + __('nights'))}</div>`
			: '';

		return `
			<div class="mtb-detail-head">
				<div class="mtb-detail-actions">
					<button type="button" class="btn btn-default btn-sm mtb-back-btn">${__('← All Groups')}</button>
					${single ? `<button type="button" class="btn btn-default btn-sm mtb-open-form" data-group="${esc(g0.name)}">${__('Open Trip Group Date')}</button>` : ''}
				</div>
				<div class="mtb-detail-title">
					<span class="mtb-detail-name">${esc(titleLine)}</span>
					${subLine ? `<span class="mtb-cell-sub">${subLine}</span>` : ''}
					${statusBadges} ${batchBadge}
				</div>
				${metaTable}
				${durHtml}
			</div>`;
	}

	// Klik baris senarai → buka page detail group/batch (laman berasingan).
	function open_item(key) {
		const it = find_item(key);
		if (!it) return;
		if (it.batch) frappe.set_route('manage-booking-group', 'batch', it.batch);
		else frappe.set_route('manage-booking-group', 'group', it.members[0].name);
	}

	// Root aktif ikut mod — senarai ATAU paparan detail (group/batch dan
	// booking info kedua-duanya render dalam #mtb-detail).
	function view_root() {
		return S.mode === 'list' ? $('#mtb-list') : $('#mtb-detail');
	}

	function item_el(key) {
		return view_root().find('.mtb-group').filter(function () { return $(this).data('item') === key; });
	}

	function pane_el(key, tab) {
		return item_el(key).find(`.mtb-tab-pane[data-pane="${tab}"]`);
	}

	/* ========== ITEM DETAIL (TABS) ========== */

	function default_state() {
		return {
			tab: 'dashboard',
			bk: { status: '', payment: '', search: '', group: '', limit: DEFAULT_LIMIT },
			ad: { status: '', payment: '', search: '', group: '', limit: DEFAULT_LIMIT },
			tv: { search: '', doc_status: '', group: '', limit: DEFAULT_LIMIT },
			rm: { search: '', privacy: '', limit: DEFAULT_LIMIT },
			fl: { search: '', limit: DEFAULT_LIMIT },
		};
	}

	function render_item_body(it) {
		const st = S.state[it.key] || (S.state[it.key] = default_state());
		const counts = tab_counts(it.key, it);

		const tabBtns = TABS.map((t) => `
			<button class="mtb-tab ${st.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
				<span class="mtb-tab-icon">${t.icon}</span> ${t.label}
				${counts[t.id] != null ? `<span class="mtb-count-pill">${counts[t.id]}</span>` : ''}
			</button>`).join('');

		const panes = TABS.map((t) => `
			<div class="mtb-tab-pane ${st.tab === t.id ? 'active' : ''}" data-pane="${t.id}">
				${st.tab === t.id ? `<div class="mtb-loading">${__('Loading...')}</div>` : ''}
			</div>`).join('');

		return `<div class="mtb-tabs">${tabBtns}</div>${panes}`;
	}

	// Bilangan untuk label tab — guna data cache bila dah load,
	// kalau tak baru agregat header
	function tab_counts(key, it) {
		const c = S.cache[key] || {};
		return {
			dashboard: null,
			booking: c.bookings?.count ?? it.agg.booking_count,
			addon: c.addons?.count ?? null,
			flight: c.flights?.count ?? null,
			traveller: c.travellers?.count ?? it.agg.pax,
			rooming: c.rooming?.count ?? it.agg.rooms,
		};
	}

	function update_tab_counts(key) {
		const it = find_item(key);
		if (!it) return;
		const counts = tab_counts(key, it);
		const $g = item_el(key);
		TABS.forEach((t) => {
			if (counts[t.id] == null) return;
			$g.find(`.mtb-tab[data-tab="${t.id}"] .mtb-count-pill`).text(counts[t.id]);
		});
	}

	async function ensure_item_loaded(key, force = false) {
		const st = S.state[key] || (S.state[key] = default_state());
		await load_tab(key, st.tab, force);
	}

	function switch_tab(key, tab) {
		const st = S.state[key] || (S.state[key] = default_state());
		if (st.tab === tab) return;
		st.tab = tab;
		const $g = item_el(key);
		$g.find('.mtb-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
		$g.find('.mtb-tab-pane').removeClass('active').filter(`[data-pane="${tab}"]`).addClass('active');
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

		if (tab === 'dashboard') {
			if (!force && S.cache[key]?.dashboard) {
				if (is_active()) render_dashboard(key);
				return;
			}
			$pane.html(`<div class="mtb-loading">${__('Loading dashboard...')}</div>`);
			const d = await api('get_group_dashboard', { trip_groups: groups });
			S.cache[key] = { ...(S.cache[key] || {}), dashboard: d };
			if (is_active()) render_dashboard(key);
			return;
		}

		if (tab === 'booking') {
			// Tab Booking — paket generik TravelBookingBookingList
			// (public/js/booking_list.js; sama seperti tab Booking page
			// Manage Booking App): komponen milik kitaran penuh sendiri
			// (fetch + toolbar + render + event). Instance disimpan dalam
			// cache; dibina semula bila pane dijana semula (render_detail) —
			// state kekal dalam S.state[key].bk.
			let comp = S.cache[key]?.bklist;
			if (!comp || !comp.is_attached()) {
				const bst = S.state[key] || (S.state[key] = default_state());
				comp = window.TravelBookingBookingList.create($pane, {
					state: bst.bk,
					trip_groups: groups,
					group_options: it.members.length > 1
						? it.members.map((m) => ({ name: m.name, trip_name: m.trip_name })) : null,
					currency: S.currency,
					columns: 'full',
					show_title: true,
					show_cards: false,
					search_placeholder: __('Search booking / customer...'),
					on_loaded: (bk) => {
						S.cache[key] = { ...(S.cache[key] || {}), bookings: bk };
						update_tab_counts(key);
					},
					// Kolum Booking No → page Booking Info; baris → Form Booking
					// (selari tingkah laku lama: td.mtb-col-bkopen / tr[data-route]).
					on_open_booking: (name) => frappe.set_route('manage-booking-group', 'booking', name),
					on_row_click: (name) => frappe.set_route('Form', 'Booking', name),
				});
				S.cache[key] = { ...(S.cache[key] || {}), bklist: comp };
			}
			if (comp) comp.load(force);
			return;
		}

		if (tab === 'addon') {
			if (!force && S.cache[key]?.addons) {
				if (is_active()) render_addons_tab(key);
				return;
			}
			$pane.html(`<div class="mtb-loading">${__('Loading addons...')}</div>`);
			const ad = await api('get_group_addons', {
				trip_groups: st.ad.group ? [st.ad.group] : groups,
				status: st.ad.status || null,
				payment_status: st.ad.payment || null,
				search: st.ad.search || null,
				limit: st.ad.limit,
			});
			S.cache[key] = { ...(S.cache[key] || {}), addons: ad };
			if (is_active()) { render_addons_tab(key); update_tab_counts(key); }
			return;
		}

		if (tab === 'flight') {
			if (!force && S.cache[key]?.flights) {
				if (is_active()) render_flights_tab(key);
				return;
			}
			$pane.html(`<div class="mtb-loading">${__('Loading flights...')}</div>`);
			const fl = await api('get_group_flights', {
				trip_groups: groups,
				search: st.fl.search || null,
				limit: st.fl.limit,
			});
			S.cache[key] = { ...(S.cache[key] || {}), flights: fl };
			if (is_active()) { render_flights_tab(key); update_tab_counts(key); }
			return;
		}

		if (tab === 'traveller') {
			if (!force && S.cache[key]?.travellers) {
				if (is_active()) render_travellers_tab(key);
				return;
			}
			$pane.html(`<div class="mtb-loading">${__('Loading travellers...')}</div>`);
			const tv = await api('get_group_travellers', {
				trip_groups: st.tv.group ? [st.tv.group] : groups,
				search: st.tv.search || null,
				doc_status: st.tv.doc_status || null,
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
			$pane.html(`<div class="mtb-loading">${__('Loading rooming...')}</div>`);
			const rm = await api('get_group_rooming', {
				trip_groups: groups,
				search: st.rm.search || null,
				privacy: st.rm.privacy || null,
				limit: st.rm.limit,
			});
			S.cache[key] = { ...(S.cache[key] || {}), rooming: rm };
			if (is_active()) { render_rooming_tab(key); update_tab_counts(key); }
		}
	}

	/* ---------- helper render kecil ---------- */

	const limit_options = (tab, cur) =>
		`<select data-kind="limit" data-tab="${tab}">${ROW_LIMITS.map((n) =>
			`<option value="${n}" ${n === cur ? 'selected' : ''}>${n === 0 ? __('All rows') : __('{0} rows', [n])}</option>`).join('')}</select>`;

	// Dropdown filter Trip Group Date untuk tab dalam item batch
	// ('' = semua group dalam batch)
	const group_filter_options = (members, cur, kind) =>
		`<select data-kind="${kind}">${['',
			...members.map((m) => m.name)].map((v) => {
				const label = v
					? `${v} · ${(members.find((m) => m.name === v) || {}).trip_name || ''}`
					: __('All Group Dates');
				return `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label).trim()}</option>`;
			}).join('')}</select>`;

	const showing_footer = (data, label) => {
		if (!data) return '';
		const more = data.count > data.shown;
		return `
			<div class="mtb-showing">
				<span>${__('Showing {0} of {1} {2}', [data.shown, data.count, label])}</span>
				${more ? `<button class="btn btn-default btn-xs mtb-load-more">${__('Load more')}</button>` : ''}
			</div>`;
	};

	/* ---------- Garis masa revenue (panel penuh lebar, tab Dashboard) ---------- */

	// Titik harian dari API ('YYYY-MM-DD') → kunci bucket ikut skala
	// (day/week/month). Minggu = minggu ISO (Isnin hari pertama).
	const tl_bucket = (dateStr, gran) => {
		if (gran === 'day') return dateStr;
		if (gran === 'month') return dateStr.slice(0, 7);
		// week — kira nombor minggu ISO
		const t = new Date(dateStr + 'T00:00:00Z');
		const dayNum = t.getUTCDay() || 7;
		t.setUTCDate(t.getUTCDate() + 4 - dayNum);
		const iy = t.getUTCFullYear();
		const w = Math.ceil((((t - Date.UTC(iy, 0, 1)) / 864e5) + 1) / 7);
		return iy + '-W' + String(w).padStart(2, '0');
	};

	// Titik harian → bucket ikut skala; cumulative dikira semula
	// merentas bucket dalam paparan terpilih.
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

	function render_tl_chart($el, tl) {
		const st = S.tl || TL_DEFAULTS;
		// Rentang penuh data — dari SO pertama hingga terakhir.
		const points = tl_aggregate(tl.points || [], st.gran);

		// Semua nilai 0 → paksi tiada julat, SVG path jadi NaN.
		if (!points.length || points.every((p) => !p.cumulative)) {
			$el.html(`<div class="mtb-empty" style="padding:14px">${__('No bookings yet.')}</div>`);
			return;
		}
		// Satu bucket sahaja (semua SO dalam satu hari/minggu/bulan) →
		// tambah titik sifar di awal supaya paksi ada julat; garis
		// bermula dari 0.
		const pts = points.length === 1
			? [{ key: '', revenue: 0, cumulative: 0 }, ...points]
			: points;

		frappe.utils.make_chart($el[0], {
			// Combo chart — bar = jumlah jualan tempoh, garis = kumulatif
			// (increment terkumpul) atas paksi yang sama.
			type: 'axis-mixed',
			data: {
				labels: pts.map((p) => {
					if (!p.key) return '';
					if (st.gran === 'week') return 'W' + p.key.slice(-2) + ' ' + p.key.slice(0, 4);
					if (st.gran === 'day') {
						const [y, m, d] = p.key.split('-');
						return (+d) + ' ' + (MONTHS[(+m) - 1] || m) + ' ' + y;
					}
					const [y, m] = p.key.split('-');
					return (MONTHS[(+m) - 1] || m) + ' ' + y;
				}),
				datasets: [
					// frappe-charts 2.0: jenis renderer dataset = 'chartType'
					// (bukan 'type') — bar jualan + garis kumulatif.
					{ name: __('Total Sales'), chartType: 'bar', values: pts.map((p) => p.revenue) },
					{ name: __('Cumulative'), chartType: 'line', values: pts.map((p) => p.cumulative) },
				],
			},
			height: 220,
			lineOptions: { regionFill: 1, heatline: false },
			colors: [frappe.utils.get_chart_palette()[0], frappe.utils.get_chart_palette()[3]],
			showLegend: true,
			tooltipOptions: {
				formatTooltipY: (v) => '≈ ' + fmtMoney(v, tl.currency || S.currency),
			},
		});
	}

	/* ---------- Tab 1: Dashboard ---------- */

	function render_dashboard(key) {
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
		const tlSt = S.tl || TL_DEFAULTS;
		const aff = d.affiliate_breakdown || [];

		// Pecahan per currency — sumber kebenaran semua angka wang.
		// (fallback scalar lama sekadar penghadang bila cache lama)
		const fbCur = fin.currency || S.currency;
		const revRows = (fin.revenue_by_currency && fin.revenue_by_currency.length)
			? fin.revenue_by_currency
				.map((r) => ({ ...r, balance: r.balance ?? round2((r.revenue || 0) - (r.collected || 0)) }))
			: (fin.revenue != null
				? [{
					currency: fbCur, revenue: fin.revenue, collected: fin.collected,
					balance: fin.balance ?? round2(fin.revenue - (fin.collected || 0)),
					collection_rate: fin.collection_rate ?? 0,
				}]
				: []);
		const addonRows = (fin.addon_revenue_by_currency && fin.addon_revenue_by_currency.length)
			? fin.addon_revenue_by_currency
			: (fin.addon_revenue != null ? [{ currency: fbCur, revenue: fin.addon_revenue }] : []);

		const paxTotal = trv.pax || 0;
		const dt = fin.default_totals;
		const revAlt = hasAltCur(revRows) && dt;

		// Jumlah keseluruhan dalam default currency — tajuk card (nilai
		// '≈' bila melibatkan penukaran kadar semasa; '+' bila ada
		// currency tanpa kadar).
		const defaultTotalValue = (field) => {
			if (revAlt) return fmtDefaultTotal(dt, field);
			return fmtMoney((dt && dt[field]) || 0, S.currency);
		};

		// Number cards — kaedah kiraan/summary seperti spec
		const kpis = [
			{
				cls: 'mtb-kpi--info', label: __('Total Rooms'),
				value: rooms.total ?? 0,
				sub: '',
				title: __('Distinct room_id in booking reservations'),
			},
			{
				cls: 'mtb-kpi--info', label: __('Bookings'),
				value: bkg.active ?? 0,
				sub: '+ ' + (bkg.addon_orders ?? 0) + ' ' + __('addon bookings')
					+ (addonRows.length ? ' · ' + fmtCurRows(addonRows, 'revenue') : '')
					+ (hasAltCur(addonRows) && fin.addon_default_totals
						? ' (' + fmtDefaultTotal(fin.addon_default_totals, 'revenue') + ')' : ''),
			},
			{
				cls: 'mtb-kpi--success', label: __('Total Revenue'),
				// Tajuk = revenue keseluruhan dalam default currency.
				value: defaultTotalValue('revenue'),
				// Sub = senarai revenue dalam currency masing-masing.
				sub: revRows.map((r) => fmtMoney(r.revenue, r.currency)).join('<br>')
					|| fmtMoney(0, S.currency),
				title: __('Per currency — amounts in different currencies are never summed'),
			},
			{
				cls: 'mtb-kpi--warn', label: __('Unpaid Balance'),
				// Tajuk = baki keseluruhan dalam default currency.
				value: defaultTotalValue('balance'),
				// Sub = senarai baki dalam currency masing-masing.
				sub: revRows.map((r) => fmtMoney(r.balance, r.currency)).join('<br>')
					|| fmtMoney(0, S.currency),
			},
			{
				cls: 'mtb-kpi--info', label: __('Occupancy (Reservation)'),
				value: occ.pct != null ? occ.pax + ' / ' + occ.capacity + ' (' + occ.pct + '%)' : occ.pax + ' ' + __('pax'),
				sub: __('Capacity') + ': ' + (occ.capacity || '—'),
			},
			{
				cls: 'mtb-kpi--danger', label: __('Pending Documents'),
				value: trv.pending_docs ?? 0,
				sub: __('Submitted') + ' ' + (trv.docs_submitted ?? 0) + '/' + paxTotal
					+ ' · ' + (trv.docs_ok ?? 0) + ' ' + __('verified'),
			},
		];

		const kpiHtml = kpis.map((k) => `
			<div class="mtb-kpi ${k.cls}" ${k.title ? `title="${esc(k.title)}"` : ''}>
				<div class="mtb-kpi-label">${esc(k.label)}</div>
				<div class="mtb-kpi-value">${k.value}</div>
				<div class="mtb-kpi-sub">${k.sub}</div>
			</div>`).join('');

		// Panel bar generik
		const barRows = (rows, total, fmtVal) => rows.map((r) => {
			const pct = total ? Math.round(r.value / total * 100) : 0;
			return `
				<div class="mtb-row">
					<span class="mtb-row-label">${r.label}</span>
					<span class="mtb-bar"><span style="width:${pct}%"></span></span>
					<span class="mtb-row-value">${fmtVal ? fmtVal(r) : r.value}</span>
				</div>`;
		}).join('');

		// Pecahan bilik ikut kategori — nombor bilik sahaja (tiada bar,
		// pax atau imbuhan 'room') + baris jumlah bilik keseluruhan.
		const roomList = (rooms.by_category || []).map((r) => `
			<div class="mtb-row">
				<span class="mtb-row-label" title="${esc(r.category)}">${esc(r.category)}</span>
				<span class="mtb-row-value">${r.rooms}</span>
			</div>`).join('');
		const roomRows = roomList
			? roomList + `
			<div class="mtb-row">
				<span class="mtb-row-label mtb-muted">${__('Total Rooms')}</span>
				<span class="mtb-row-value">${rooms.total ?? 0}</span>
			</div>`
			: `<div class="mtb-empty" style="padding:14px">${__('No rooms booked yet.')}</div>`;

		// Pecahan affiliate — bilangan booking ikut Sales Partner sahaja
		// (backend dah filter booking tanpa affiliate). Kandungan panel
		// discroll bila melebihi max-height (kelas mtb-panel-body--scroll).
		const affRows = aff.length
			? aff.map((r) => `
				<div class="mtb-row">
					<span class="mtb-row-label" title="${esc(r.affiliate)}">${esc(r.affiliate)}</span>
					<span class="mtb-row-value">${r.count}</span>
				</div>`).join('')
			: `<div class="mtb-empty" style="padding:14px">${__('No affiliate bookings yet.')}</div>`;

		// Pecahan diskaun ikut jenis — nilai akhir dalam default currency
		// (jumlah nilai yang telah ditukar).
		const dscDt = dsc.default_totals
			|| { currency: S.currency, voucher: 0, price_rule: 0, referral: 0, total: 0 };
		const dscRows = barRows([
			{ label: esc(__('Voucher')), value: dscDt.voucher || 0 },
			{ label: esc(__('Price Rule')), value: dscDt.price_rule || 0 },
			{ label: esc(__('Referral')), value: dscDt.referral || 0 },
		], dscDt.total || 0, (r) => fmtMoney(r.value, dscDt.currency))
			+ `
			<div class="mtb-row">
				<span class="mtb-row-label mtb-muted">${__('Voucher redemptions')}</span>
				<span class="mtb-row-value">${dsc.voucher_usage_count ?? 0}</span>
			</div>`;

		// Pie chart helper — legend SVG library dimatikan; legend diganti
		// senarai HTML MENDATAR (titik warna + label + kiraan) di bawah
		// chart, warna sepadan dengan slice (palet tema frappe).
		const chartPalette = frappe.utils.get_chart_palette();
		const pieChart = ($el, name, labels, values) => {
			const pairs = labels
				.map((label, i) => ({ label, value: values[i] || 0 }))
				.filter((p) => p.value > 0);
			if (!pairs.length) {
				$el.html(`<div class="mtb-empty" style="padding:14px">${__('No bookings yet.')}</div>`);
				return;
			}
			const colors = pairs.map((_, i) => chartPalette[i % chartPalette.length]);
			frappe.utils.make_chart($el[0], {
				type: 'pie',
				data: {
					labels: pairs.map((p) => p.label),
					datasets: [{ name, values: pairs.map((p) => p.value) }],
				},
				height: 170,
				maxSlices: 8,
				colors,
				showLegend: false,
				tooltipOptions: { formatTooltipY: (v) => String(v) },
			});
			$el.append(`<div class="mtb-chart-legend">${pairs.map((p, i) => `
				<span class="mtb-chart-legend-item" title="${esc(p.label)}">
					<span class="mtb-chart-legend-dot" style="background:${esc(colors[i])}"></span>
					<span class="mtb-chart-legend-label">${esc(p.label)}</span>
					<b>${p.value}</b>
				</span>`).join('')}</div>`);
		};

		// Status booking & payment — pie chart (render selepas html set).
		const bkStatus = d.booking_status || [];
		const payStatus = d.payment_status || [];
		const bkChannel = d.booking_channel || [];
		const checkoutMethod = d.checkout_method || [];

		// Pecahan umur: <2 thn = Infant, <12 thn = Child, lain = Adult
		const age = trv.age_breakdown || {};
		const gb = trv.gender_breakdown || {};

			pane_el(key, 'dashboard').html(`
			<div class="mtb-dash">
				<div class="mtb-kpi-row">${kpiHtml}</div>
				<div class="mtb-panel mtb-panel--full">
					<div class="mtb-panel-head">📈 ${__('Revenue Timeline')}
						<span class="mtb-panel-head-tools">
							<span class="mtb-panel-head-sub">${__('Bar = sales · Line = cumulative, current rates')} · ≈ ${esc(tl.currency || S.currency)}${tl.rates_complete === false ? ' +' : ''}</span>
							<select class="mtb-tl-select" name="tl_gran" title="${__('Time scale of the chart — full range from first to last booking order')}">
								<option value="day" ${tlSt.gran === 'day' ? 'selected' : ''}>${__('Daily')}</option>
								<option value="week" ${tlSt.gran === 'week' ? 'selected' : ''}>${__('Weekly')}</option>
								<option value="month" ${tlSt.gran === 'month' ? 'selected' : ''}>${__('Monthly')}</option>
							</select>
						</span>
					</div>
					<div class="mtb-panel-body mtb-chart" data-chart="rev-tl"></div>
				</div>
				<div class="mtb-panel-grid">
					<div class="mtb-panel">
						<div class="mtb-panel-head">🛏 ${__('Rooms by Category')}</div>
						<div class="mtb-panel-body">${roomRows}</div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">🏷 ${__('Discount by Type')}</div>
						<div class="mtb-panel-body">${dscRows}</div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">🤝 ${__('Affiliate Breakdown')}</div>
						<div class="mtb-panel-body mtb-panel-body--scroll">${affRows}</div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">📋 ${__('Booking Status')}</div>
						<div class="mtb-panel-body mtb-chart" data-chart="bk"></div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">💳 ${__('Payment Status')}</div>
						<div class="mtb-panel-body mtb-chart" data-chart="pay"></div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">🧭 ${__('Booking Channel')}</div>
						<div class="mtb-panel-body mtb-chart" data-chart="channel"></div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">🛒 ${__('Checkout Method')}</div>
						<div class="mtb-panel-body mtb-chart" data-chart="checkout"></div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">🎂 ${__('Traveller Age Breakdown')}</div>
						<div class="mtb-panel-body mtb-chart" data-chart="age"></div>
					</div>
					<div class="mtb-panel">
						<div class="mtb-panel-head">🚻 ${__('Traveller Gender Breakdown')}</div>
						<div class="mtb-panel-body mtb-chart" data-chart="gender"></div>
					</div>
				</div>
			</div>`);

		// Pie charts — selepas html dipasang (frappe-charts lukis ke DOM).
		const $pane = pane_el(key, 'dashboard');
		render_tl_chart($pane.find('[data-chart="rev-tl"]'), tl);
		pieChart($pane.find('[data-chart="bk"]'), __('Bookings'),
			bkStatus.map((s) => s.status || '-'), bkStatus.map((s) => s.count));
		pieChart($pane.find('[data-chart="pay"]'), __('Payments'),
			payStatus.map((s) => s.status || '-'), payStatus.map((s) => s.count));
		pieChart($pane.find('[data-chart="channel"]'), __('Bookings'),
			bkChannel.map((c) => c.channel || '-'), bkChannel.map((c) => c.count));
		pieChart($pane.find('[data-chart="checkout"]'), __('Bookings'),
			checkoutMethod.map((c) => c.method || '-'), checkoutMethod.map((c) => c.count));
		pieChart($pane.find('[data-chart="age"]'), __('Travellers'), [
			__('Infant'), __('Child'), __('Adult'), __('Unknown'),
		], [age.infant || 0, age.child || 0, age.adult || 0, age.unknown || 0]);
		pieChart($pane.find('[data-chart="gender"]'), __('Travellers'),
			Object.keys(gb), Object.keys(gb).map((k) => gb[k]));
	}

	/* ---------- Tab 2b: Booking Addon ---------- */

	function render_addons_tab(key) {
		const ad = S.cache[key]?.addons;
		const it = find_item(key);
		const st = S.state[key];
		if (!ad || !it || !st) return;

		const multi = it.members.length > 1;
		const rows = ad.addons || [];
		const tot = ad.totals || {};

		const rowHtml = rows.map((a) => `
			<tr data-route="Booking Addon/${esc(a.name)}">
				<td>
					<div class="mtb-cell-main">${esc(a.name)}</div>
					${a.notes ? `<div class="mtb-cell-sub" title="${esc(a.notes)}">${esc(a.notes)}</div>` : ''}
				</td>
				<td>${a.booking
					? `<a href="/app/booking/${esc(a.booking)}">${esc(a.booking_number)}</a>`
					: esc(a.booking_number) || '<span class="mtb-muted">—</span>'}</td>
				<td>
					<div class="mtb-cell-main">${esc(a.customer_name)}</div>
					${a.trip_package ? `<div class="mtb-cell-sub">${esc(a.trip_package)}</div>` : ''}
				</td>
				${multi ? `<td class="mtb-muted">${esc(a.trip_date || '')}</td>` : ''}
				<td>${badge(a.status, ADDON_STATUS_COLORS[a.status])}</td>
				<td>${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}</td>
				<td class="num">${a.item_count}</td>
				<td class="num">${fmtMoney(a.total_amount, a.currency || S.currency)}</td>
				<td class="num mtb-muted">${fmtDateTime(a.order_date)}</td>
			</tr>`).join('');

		// Footer: jumlah SEMUA addon order yang padan filter — amount
		// dipaparkan dalam DEFAULT currency (kadar semasa; '+' bila ada
		// currency tanpa kadar). Tooltip = pecahan asal per currency.
		const dt = tot.default_totals || { currency: S.currency, amount: 0, rates_complete: true };
		const incomplete = dt.rates_complete === false ? '+' : '';
		const footTitle = (tot.by_currency || []).length
			? esc(__('Per currency') + ': '
				+ tot.by_currency.map((r) => fmtMoney(r.amount, r.currency)).join(' · '))
			: '';
		const footer = ad.count ? `
			<tfoot><tr>
				<td colspan="${multi ? 6 : 5}">${__('Total')} (${ad.count} ${__('addon orders')})
					<span class="mtb-muted">· ${esc(dt.currency || S.currency)}${incomplete}</span></td>
				<td></td>
				<td class="num" title="${footTitle}">${fmtMoney(dt.amount, dt.currency)}</td>
				<td></td>
			</tr></tfoot>` : '';

		const statusOpts = ADDON_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.ad.status === o ? 'selected' : ''}>${esc(o || 'All Status')}</option>`).join('');
		const payOpts = ADDON_PAYMENT_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.ad.payment === o ? 'selected' : ''}>${esc(o || 'All Payments')}</option>`).join('');
		const adGroupOpts = multi ? group_filter_options(it.members, st.ad.group, 'ad-group') : '';

		pane_el(key, 'addon').html(`
			<div class="mtb-section-title">➕ ${__('Booking Addons')}
				<span class="mtb-count-pill">${ad.count ?? 0}</span>
			</div>
			<div class="mtb-tab-toolbar">
				<input type="text" data-search="ad" placeholder="${__('Search addon / booking / customer...')}"
					value="${esc(st.ad.search)}" />
				${adGroupOpts}
				<select data-kind="ad-status">${statusOpts}</select>
				<select data-kind="ad-payment">${payOpts}</select>
				${limit_options('addon', st.ad.limit)}
			</div>
			${rows.length ? `
			<div class="mtb-table-wrap">
				<table class="mtb-table">
					<thead><tr>
						<th>${__('Addon No')}</th>
						<th>${__('Booking')}</th>
						<th>${__('Customer')}</th>
						${multi ? `<th>${__('Group')}</th>` : ''}
						<th>${__('Status')}</th>
						<th>${__('Payment')}</th>
						<th class="num">${__('Items')}</th>
						<th class="num">${__('Amount')}</th>
						<th class="num">${__('Order Date')}</th>
					</tr></thead>
					<tbody>${rowHtml}</tbody>
					${footer}
				</table>
			</div>` : `<div class="mtb-empty">${__('No addon orders found for this filter.')}</div>`}
			${showing_footer(ad, __('addon orders'))}`);
	}

	/* ---------- Tab 2c: Flight ---------- */

	function render_flights_tab(key) {
		const fl = S.cache[key]?.flights;
		const st = S.state[key];
		if (!fl || !st) return;

		const rows = fl.flights || [];
		const route = (f) => [f.home_airport, f.destination_airport].filter(Boolean).join(' → ');

		const rowHtml = rows.map((f) => `
			<tr data-route="Flight/${esc(f.name)}">
				<td>
					<div class="mtb-cell-main">${esc(f.pnr)}</div>
					${f.flight_title && f.flight_title !== f.pnr ? `<div class="mtb-cell-sub">${esc(f.flight_title)}</div>` : ''}
				</td>
				<td>${f.airline ? esc(f.airline_name || f.airline) : '<span class="mtb-muted">—</span>'}</td>
				<td>${route(f) ? esc(route(f)) : '<span class="mtb-muted">—</span>'}</td>
				<td class="num">${f.departure_date ? fmtDate(f.departure_date) : '—'}</td>
				<td class="num">${f.arrival_date ? fmtDate(f.arrival_date) : '—'}</td>
				<td>${f.flight_class ? esc(f.flight_class) : '<span class="mtb-muted">—</span>'}</td>
				<td>${f.ticket_type ? esc(f.ticket_type) : '<span class="mtb-muted">—</span>'}</td>
				<td class="num">${f.seats_occupied}/${f.max_seat || '—'}</td>
				<td class="num">${f.booking_count}</td>
				<td class="num">${f.pax}</td>
				<td>${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}</td>
			</tr>`).join('');

		const footer = fl.count ? `
			<tfoot><tr>
				<td colspan="11">${__('Total')} (${fl.count} ${__('flights')})</td>
			</tr></tfoot>` : '';

		pane_el(key, 'flight').html(`
			<div class="mtb-section-title">✈️ ${__('Flights')}
				<span class="mtb-count-pill">${fl.count ?? 0}</span>
				<span class="mtb-muted" style="font-weight:400;font-size:var(--text-sm)">${__('charter flights referenced by bookings of this group')}</span>
			</div>
			<div class="mtb-tab-toolbar">
				<input type="text" data-search="fl" placeholder="${__('Search PNR / title / airline / airport...')}"
					value="${esc(st.fl.search)}" />
				${limit_options('flight', st.fl.limit)}
			</div>
			${rows.length ? `
			<div class="mtb-table-wrap">
				<table class="mtb-table">
					<thead><tr>
						<th>${__('PNR')}</th>
						<th>${__('Airline')}</th>
						<th>${__('Route')}</th>
						<th class="num">${__('Departure')}</th>
						<th class="num">${__('Arrival')}</th>
						<th>${__('Class')}</th>
						<th>${__('Ticket Type')}</th>
						<th class="num" title="${__('Seats occupied / max seats')}">${__('Seats')}</th>
						<th class="num" title="${__('Active bookings (excludes Cancelled & Abandoned)')}">${__('Bookings')}</th>
						<th class="num">${__('Pax')}</th>
						<th>${__('Status')}</th>
					</tr></thead>
					<tbody>${rowHtml}</tbody>
					${footer}
				</table>
			</div>` : `<div class="mtb-empty">${__('No flights referenced by this group yet.')}</div>`}
			${showing_footer(fl, __('flights'))}`);
	}

	/* ---------- Tab 3: Traveller ---------- */

	function render_travellers_tab(key) {
		const tv = S.cache[key]?.travellers;
		const it = find_item(key);
		const st = S.state[key];
		if (!tv || !it || !st) return;

		const multi = it.members.length > 1;
		const rows = tv.travellers || [];

		const rowHtml = rows.map((t, i) => `
			<tr data-route="Booking Reservation/${esc(t.reservation)}">
				<td class="num mtb-muted">${i + 1}</td>
				<td>
					<div class="mtb-cell-main">${esc(t.traveller_name)}</div>
					${t.passport_no ? `<div class="mtb-cell-sub">PP: ${esc(t.passport_no)}${t.passport_expiry ? ' · exp ' + fmtDate(t.passport_expiry) : ''}</div>` : ''}
				</td>
				<td class="mtb-col-msg">${msg_cell(t.customer_message,
					__('Customer Message') + ' · ' + (t.booking_number || t.booking))}</td>
				<td>
					<div class="mtb-cell-main">${esc(t.booking_number)}</div>
					${t.customer_name ? `<div class="mtb-cell-sub">${esc(t.customer_name)}</div>` : ''}
				</td>
				<td>
					${t.email ? `<div class="mtb-cell-sub" title="${esc(t.email)}">✉ ${esc(t.email)}</div>` : ''}
					${t.phone ? `<div class="mtb-cell-sub">☎ ${esc(t.phone)}</div>` : ''}
					${!t.email && !t.phone ? '<span class="mtb-muted">—</span>' : ''}
				</td>
				${multi ? `<td class="mtb-muted">${esc(t.trip_group || '')}</td>` : ''}
				<td>
					<div>${esc(t.room_id || '—')}</div>
					<div class="mtb-cell-sub">${esc(t.room_category || '')}</div>
				</td>
				<td>
					<div>${esc(t.pax_type || '—')}</div>
					<div class="mtb-cell-sub">#${t.guest_sequence || '-'}</div>
				</td>
				<td>${t.gender ? esc(__(t.gender)) : '<span class="mtb-muted">—</span>'}</td>
				<td>
					${t.age != null ? t.age : '<span class="mtb-muted">—</span>'}
					${t.age_bucket && t.age_bucket !== 'Unknown' ? `<div class="mtb-cell-sub">${badge(t.age_bucket, AGE_BUCKET_COLORS[t.age_bucket])}</div>` : ''}
				</td>
				<td class="mtb-muted">${esc(t.nationality || '—')}</td>
				<td>${badge(t.document_status, DOC_STATUS_COLORS[t.document_status])}</td>
			</tr>`).join('');

		const docOpts = DOC_STATUS_OPTIONS
			.map((o) => `<option value="${esc(o)}" ${st.tv.doc_status === o ? 'selected' : ''}>${esc(o || 'All Docs')}</option>`).join('');

		pane_el(key, 'traveller').html(`
			<div class="mtb-section-title">👥 ${__('Travellers')}
				<span class="mtb-count-pill">${tv.count ?? 0}</span>
				<span class="mtb-muted" style="font-weight:400;font-size:var(--text-sm)">${__('from Booking Reservation of this trip group date')}</span>
			</div>
			<div class="mtb-tab-toolbar">
				<input type="text" data-search="tv" placeholder="${__('Search traveller / passport / contact / booking...')}"
					value="${esc(st.tv.search)}" />
				${multi ? group_filter_options(it.members, st.tv.group, 'tv-group') : ''}
				<select data-kind="tv-doc">${docOpts}</select>
				${limit_options('traveller', st.tv.limit)}
			</div>
			${rows.length ? `
			<div class="mtb-table-wrap">
				<table class="mtb-table">
					<thead><tr>
						<th class="num">#</th>
						<th>${__('Traveller')}</th>
						<th>${__('Message')}</th>
						<th>${__('Booking')}</th>
						<th>${__('Contact')}</th>
						${multi ? `<th>${__('Group')}</th>` : ''}
						<th>${__('Room')}</th>
						<th>${__('Type')}</th>
						<th>${__('Gender')}</th>
						<th class="num">${__('Age')}</th>
						<th>${__('Nationality')}</th>
						<th>${__('Doc Status')}</th>
					</tr></thead>
					<tbody>${rowHtml}</tbody>
				</table>
			</div>` : `<div class="mtb-empty">${__('No travellers found for this filter.')}</div>`}
			${showing_footer(tv, __('travellers'))}`);
	}

	/* ---------- Tab 4: Rooming ---------- */

	function render_rooming_tab(key) {
		const rm = S.cache[key]?.rooming;
		const it = find_item(key);
		const st = S.state[key];
		if (!rm || !it || !st) return;

		const multi = it.members.length > 1;
		const rows = rm.rooms || [];

		const rowHtml = rows.map((r) => {
			const guests = (r.guests || []).map((gst) => `
				<div class="mtb-guest">
					<span class="mtb-muted">${gst.guest_sequence || '·'}.</span>
					<span class="mtb-cell-main">${esc(gst.name)}</span>
					${gst.gender ? `<span class="mtb-guest-gender">${esc(__(gst.gender)).slice(0, 1)}</span>` : ''}
					${badge(gst.document_status, DOC_STATUS_COLORS[gst.document_status])}
				</div>`).join('');

			return `
				<tr>
					<td>
						<div class="mtb-cell-main">${esc(r.room_id)}</div>
						${r.stateroom_no ? `<div class="mtb-cell-sub">${__('Stateroom')}: ${esc(r.stateroom_no)}</div>` : ''}
						${r.room_privacy ? `<div class="mtb-cell-sub">${esc(r.room_privacy)}</div>` : ''}
					</td>
					<td>${esc(r.room_category)}</td>
					${multi ? `<td class="mtb-muted">${esc(r.trip_group || '')}</td>` : ''}
					<td>${(r.bookings || []).map((b) => `<a href="/app/booking/${esc(b)}">${esc(b)}</a>`).join('<br>') || '—'}</td>
					<td class="mtb-guests">${guests || '<span class="mtb-muted">—</span>'}</td>
					<td class="num">${r.pax}</td>
					<td class="num ${r.pending_docs > 0 ? 'mtb-danger' : 'mtb-success'}">${r.docs_ok}/${r.pax}</td>
					<td>${r.cabin_confirmed ? badge('Confirmed', 'green') : badge('Pending', 'orange')}</td>
				</tr>`;
		}).join('');

			const privacyOpts = [
				['', __('All Privacy')],
				['Private', __('Private')],
				['Open Sharing', __('Open Sharing')],
				['__blank__', __('Unspecified')],
			].map(([v, l]) => `<option value="${esc(v)}" ${st.rm.privacy === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

			pane_el(key, 'rooming').html(`
				<div class="mtb-section-title">🛏 ${__('Rooming')}
					<span class="mtb-count-pill">${rm.count ?? 0}</span>
					<span class="mtb-muted" style="font-weight:400;font-size:var(--text-sm)">${__('sorted by Room ID')}</span>
				</div>
				<div class="mtb-tab-toolbar">
					<input type="text" data-search="rm" placeholder="${__('Search room / category / traveller...')}"
						value="${esc(st.rm.search)}" />
					<select data-kind="rm-privacy">${privacyOpts}</select>
					${limit_options('rooming', st.rm.limit)}
				</div>
			${rows.length ? `
			<div class="mtb-table-wrap">
				<table class="mtb-table">
					<thead><tr>
						<th>${__('Room ID')}</th>
						<th>${__('Category')}</th>
						${multi ? `<th>${__('Group')}</th>` : ''}
						<th>${__('Booking(s)')}</th>
						<th>${__('Travellers')}</th>
						<th class="num">${__('Pax')}</th>
						<th class="num">${__('Docs')}</th>
						<th>${__('Arrangement')}</th>
					</tr></thead>
					<tbody>${rowHtml}</tbody>
				</table>
			</div>` : `<div class="mtb-empty">${__('No rooms found for this filter.')}</div>`}
			${showing_footer(rm, __('rooms'))}`);
	}

	/* ========== BOOKING INFO PAGE (route /booking/<name>) ========== */

	// Page khusus SATU booking — gabung semua maklumat berkaitan:
	// profil order, reservation + traveller, transaksi (SO + Payment
	// Entry), dokumen berkaitan (Sales Order / Sales Invoice / Proforma
	// Invoice) dan rooming. Backend: get_booking_profile().

	const RES_STATUS_COLORS = {
		'Pending Review': 'yellow', 'Confirmed': 'green', 'Cancelled': 'red',
	};
	// docstatus dokumen ERPNext — submitted (1) tiada badge tambahan
	// (status dokumen sendiri dipapar), Draft/Cancelled berbadge.
	const DOCSTATUS_META = {
		0: { label: 'Draft', color: 'orange' },
		2: { label: 'Cancelled', color: 'red' },
	};
	const PE_STATUS_META = {
		0: { label: 'Pending', color: 'orange' },
		1: { label: 'Verified', color: 'green' },
		2: { label: 'Cancelled', color: 'red' },
	};
	const SO_STATUS_COLORS = {
		'To Deliver and Bill': 'blue', 'To Deliver': 'blue', 'To Bill': 'blue',
		'To Pay': 'orange', 'Completed': 'green', 'Closed': 'gray',
		'Cancelled': 'red', 'On Hold': 'yellow', 'Draft': 'orange',
	};
	const DOC_STATUS_OK = ['Verified', 'Valid'];

	const docstatus_badge = (docstatus) => {
		const m = DOCSTATUS_META[docstatus];
		return m ? badge(__(m.label), m.color) : '';
	};

	// Tab halaman Booking Info — data dimuatkan sekali (satu panggilan
	// API), jadi tab di sini semata-mata paparan: pertukaran kelas
	// dikendalikan delegate .mtb-tab sedia ada (switch_tab — kunci bkg:
	// tiada item group, load_tab() no-op, tiada refetch).
	// ID tab lama (info/guest/docs) dipetakan ke tab baharu supaya pilihan
	// tab yang tersimpan dalam S.state kekal sah.
	const BKG_TABS = [
		{ id: 'ov', label: __('Overview'), icon: '📊' },
		{ id: 'tv', label: __('Travellers'), icon: '👥' },
		{ id: 'doc', label: __('Documents'), icon: '📄' },
		{ id: 'other', label: __('Others'), icon: '🗂️' },
	];
	// Tab Payments lama digabungkan ke dalam tab Documents — state 'pay'
	// yang tersimpan dipetakan ke situ juga.
	const BKG_TAB_LEGACY = { info: 'ov', guest: 'tv', docs: 'doc', pay: 'doc' };

	function render_booking(key, d) {
		// Pilihan tab diingati meratas paparan booking yang sama
		// (S.state dikongsi dengan tab page group — medan tab sahaja).
		const st = S.state[key] || (S.state[key] = default_state());
		const want = BKG_TABS.some((t) => t.id === st.tab)
			? st.tab : (BKG_TAB_LEGACY[st.tab] || 'ov');
		st.tab = want;
		const p = d.profile || {};
		const resCount = (d.reservations || []).length;
		const peCount = bkg_pe_rows(d).length;
		const docCount = (d.documents?.sales_orders || []).length
			+ (d.documents?.sales_invoices || []).length
			+ (d.documents?.proforma_invoices || []).length;

		$('#mtb-detail').html(`
			<div class="mtb-group mtb-bkg" data-item="${esc(key)}">
				${bkg_topbar(p)}
				<div class="mtb-bkg-shell">
					<aside class="mtb-bkg-rail">${bkg_rail(p, d)}</aside>
					<div class="mtb-bkg-main">
						${bkg_money_strip(d)}
						<div class="mtb-tabs">
							${BKG_TABS.map((t) => `
								<button class="mtb-tab ${want === t.id ? 'active' : ''}" data-tab="${t.id}">
									<span class="mtb-tab-icon">${t.icon}</span> ${t.label}
									${t.id === 'tv' && resCount ? `<span class="mtb-count-pill">${resCount}</span>` : ''}
									${t.id === 'doc' && (docCount + peCount) ? `<span class="mtb-count-pill">${docCount + peCount}</span>` : ''}
								</button>`).join('')}
						</div>
						<div class="mtb-bkg-body">
						<div class="mtb-tab-pane ${want === 'ov' ? 'active' : ''}" data-pane="ov">
							${bkg_order_summary(d)}
							${bkg_timeline(d)}
						</div>
							<div class="mtb-tab-pane ${want === 'tv' ? 'active' : ''}" data-pane="tv">
								${bkg_travellers(d)}
							</div>
							<div class="mtb-tab-pane ${want === 'doc' ? 'active' : ''}" data-pane="doc">
								${bkg_documents(d)}
								${bkg_payments(d)}
							</div>
							<div class="mtb-tab-pane ${want === 'other' ? 'active' : ''}" data-pane="other">
								${bkg_others(d)}
							</div>
						</div>
					</div>
				</div>
			</div>`);

		// Notifikasi onload — mesej customer dipaparkan terus sebagai
		// modal supaya disedari; boleh dibaca semula melalui butang di
		// section Customer.
		if (p.customer_message) bkg_notify_message(p);
	}

	// ── Topbar — breadcrumb hierarki (ganti 3 butang back searas) +
	// action utama. Klik crumb guna semula delegate .mtb-back-btn /
	// .mtb-back-group-btn / .mtb-open-booking sedia ada. ─────────────
	function bkg_topbar(p) {
		return `
			<div class="mtb-bkg-topbar">
				<nav class="mtb-bkg-crumbs" aria-label="${__('Breadcrumb')}">
					<button type="button" class="mtb-crumb mtb-back-btn">${__('All Groups')}</button>
					${p.trip_date ? `
					<span class="mtb-crumb-sep">›</span>
					<button type="button" class="mtb-crumb mtb-back-group-btn" data-group="${esc(p.trip_date)}"
						title="${esc(__('Open group detail'))}">${esc(p.trip_date)}</button>` : ''}
					<span class="mtb-crumb-sep">›</span>
					<span class="mtb-crumb mtb-crumb--cur">${esc(p.booking_number || p.name)}</span>
				</nav>
				<div class="mtb-bkg-actions">
					<button type="button" class="btn btn-primary btn-xs mtb-open-booking"
						data-booking="${esc(p.name)}">${__('Open Booking Form')}</button>
				</div>
			</div>`;
	}

	// ── Rail konteks (sticky) — semua konteks statik booking yang dahulunya
	// bertabur dalam header meta grid + section Trip Information: identiti
	// + progres payment, customer (+ butang Mesej, Call/WhatsApp), trip
	// & stay, sales & channel, audit (grid padat). Mesej customer pula
	// muncul sebagai notifikasi onload. Nilai wang rail ikut
	// default_totals sahaja — pecahan penuh per currency ada dalam strip
	// wang. ─────────────────────────────────────────────────────────────
	function bkg_rail(p, d) {
		const row = (k, v) => (v ? `<div class="mtb-bkg-rrow"><span class="k">${k}</span><span class="v">${v}</span></div>` : '');
		const sec = (lab, inner, extraCls) => (inner && inner.trim()
			? `<div class="mtb-bkg-rsec${extraCls ? ' ' + extraCls : ''}"><div class="mtb-bkg-rlab">${lab}</div>${inner}</div>` : '');

		// Identiti + progres pembayaran
		const dt = p.default_totals;
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const progSub = dt
			? `${fmtMoney(dt.paid, dt.currency || S.currency)} / ${fmtMoney(dt.gross, dt.currency || S.currency)}`
			: '';
		const idBadges = badge(p.status, BOOKING_STATUS_COLORS[p.status]);
		// Badge status sentiasa di hujung KANAN ATAS section — sebaris
		// dengan nombor booking (flex space-between, align atas).
		const idSec = `
			<div class="mtb-bkg-rsec mtb-bkg-rsec--id">
				<div class="mtb-bkg-idhead">
					<div class="mtb-bkg-rid">${esc(p.booking_number || p.name)}</div>
					${idBadges ? `<div class="mtb-bkg-rbadges">${idBadges}</div>` : ''}
				</div>
				${p.name && p.name !== p.booking_number ? `<div class="mtb-cell-sub">${esc(p.name)}</div>` : ''}
				<div class="mtb-bkg-pbar"><span style="width:${prog}%"></span></div>
				<div class="mtb-cell-sub">${prog}% ${__('paid')}${progSub ? ' · ' + progSub : ''}</div>
			</div>`;

		// Customer — identiti & hubungan sahaja (Company ialah atribut
		// rekod; dipaparkan kecil dalam section Audit) + butang Mesej
		// customer (baca semula) + butang Call & WhatsApp (tab baharu).
		const customer = p.customer
			? `<a href="/app/customer/${esc(p.customer)}">${esc(p.customer_name)}</a>`
			: esc(p.customer_name);
		const contacts = [
			p.cust_email ? `✉ ${esc(p.cust_email)}` : '',
			p.cust_phone ? `☎ ${esc(p.cust_phone)}` : '',
		].filter(Boolean).join('<br>');
		const custSec = sec(__('Customer'),
			customer + (contacts ? `<div class="mtb-cell-sub">${contacts}</div>` : '')
			+ (p.customer_message ? `
			<button type="button" class="mtb-bkg-msg-btn"
				data-message="${esc(p.customer_message)}"
				data-title="${esc(__('Customer Message') + ' — ' + (p.booking_number || p.name))}">
				💬 ${__('Customer Message')}
			</button>` : '')
			+ bkg_contact_actions(p));

		// Sales & channel + pecahan diskaun (Voucher / Price Rule /
		// Referral — field Booking, currency SO utama booking).
		const salesBadges = badge(p.booking_channel, 'violet') + badge(p.checkout_method, 'cyan');
		const dsc = bkg_discount(p);
		const dscRow = dsc.total > 0
			? row(__('Discount'), esc(fmtMoney(dsc.total, dsc.cur)))
				+ (dsc.parts.length ? `<div class="mtb-cell-sub">${esc(dsc.parts.join(' · '))}</div>` : '')
			: '';
		const salesInner = (salesBadges ? `<div class="mtb-bkg-rbadges">${salesBadges}</div>` : '')
			+ row(__('Affiliate'), esc(p.affiliate))
			+ row('B2B', esc(p.b2b_partner))
			+ row(__('End Customer'), esc(p.end_customer))
			+ row(__('Referral'), esc(p.referral_code_used))
			+ row(__('Voucher'), esc(p.voucher))
			+ dscRow;
		const salesSec = sec(__('Sales & Channel'), salesInner);

		// Trip & stay — Trip = pautan bold; bila trip dipublikasikan,
		// klik buka MODAL preview laman web trip (kandungan website:
		// description, itinerary, image) — bukan navigasi. Group
		// memaparkan awalan Batch Name ('batch / kod') bila wujud.
		// Bila tarikh berangkat ≠ tarikh mula layar — papar KEDUA-DUA
		// baris Departure & Sail. Package & Trip Type sebagai badge.
		const tripPreview = p.trip && p.trip_published;
		const tripLabel = tripPreview
			? `<a href="/${esc((p.trip_route || 'route/' + p.trip).replace(/^\/+/, ''))}"
					class="mtb-trip-preview" title="${esc(__('Trip preview from website'))}">${esc(p.trip_title || p.trip)}</a>`
			: (p.trip
				? `<a href="/app/trip/${esc(p.trip)}">${esc(p.trip_title || p.trip)}</a>`
				: esc(p.trip_title || ''));
		const groupCell = p.trip_date
			? `<a href="/app/manage-booking-group/group/${esc(p.trip_date)}"
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
		// Cruise + tarikh berangkat = mula layar → satu baris 'Sail'
		// dengan julat tarikh layar (bukan 'Date: Sail: …').
		const dateRows = datesDiffer
			? row(__('Departure'), esc(depLabel)) + row(__('Sail'), esc(sailLabel))
			: (p.is_a_cruise_trip && sailLabel
				? row(__('Sail'), esc(sailLabel))
				: row(__('Date'), esc(depLabel)));
		const duration = (p.total_days || p.total_night)
			? (p.total_days || '—') + ' ' + __('days') + ' / ' + (p.total_night || '—') + ' ' + __('nights')
			: '';
		// Package Type (field Booking, fetch dari Trip Package) di KANAN
		// baris; Trip Type di KIRI.
		const typeLeft = p.is_a_cruise_trip ? badge(__('Cruise'), 'cyan') : '';
		const typeRight = p.package_type ? badge(p.package_type, 'violet') : '';
		const typeRow = (typeLeft || typeRight)
			? `<div class="mtb-bkg-rbadges mtb-bkg-rbadges--split">${typeLeft}<span class="mtb-bkg-rbadges-right">${typeRight}</span></div>`
			: '';
		const tripInner = tripLabel
			+ typeRow
			+ (groupCell ? row(__('Group'), groupCell) : '')
			+ dateRows
			+ row(__('Duration'), esc(duration))
			+ (p.booked_pax ? row(__('Booked Pax'), esc(p.booked_pax)) : '')
			+ row(__('Total Rooms'), esc(d.rooming_count ?? 0))
			+ row(__('Ship'), esc(p.ship_name));
		const tripSec = sec(__('Trip & Stay'), tripInner);

		// Audit dipindah ke tab Others — rail kekal ringkas dengan
		// konteks operasi harian sahaja.
		return idSec + custSec + tripSec + salesSec;
	}

	// Notifikasi mesej customer — modal pop sekali setiap page booking
	// dibuka (onload); mesej penuh boleh dibaca semula melalui butang
	// di section Customer rail.
	const bkg_notify_message = (p) => {
		frappe.msgprint({
			title: '💬 ' + __('Customer Message') + ' — ' + (p.booking_number || p.name),
			indicator: 'yellow',
			message: `<div class="mtb-msg-body">${esc(p.customer_message)}</div>`,
		});
	};

	// Butang Call (tel:) & WhatsApp (wa.me, tab baharu) untuk SATU
	// nombor telefon — dipakai section Customer (rail) & kad Affiliate
	// (tab Others). Nombor tempatan bermula '0' diberi awalan '6'
	// (kod negara Malaysia) untuk wa.me.
	const bkg_call_wa_btns = (phone) => {
		const telRaw = String(phone || '').replace(/[^\d+]/g, '');
		const digits = telRaw.replace(/\D/g, '');
		const callLink = telRaw
			? `<a class="mtb-bkg-quickbtn" href="tel:${esc(telRaw)}"
					title="${esc(__('Call customer'))}">📞 ${__('Call')}</a>`
			: '';
		const waLink = digits
			? `<a class="mtb-bkg-quickbtn mtb-bkg-quickbtn--wa"
					href="https://wa.me/${esc(digits.startsWith('0') ? '6' + digits : digits)}"
					target="_blank" rel="noopener"
					title="${esc(__('Open WhatsApp message in a new tab'))}">💬 ${__('WhatsApp')}</a>`
			: '';
		return callLink + waLink;
	};

	const bkg_contact_actions = (p) => {
		const btns = bkg_call_wa_btns(p.cust_phone);
		return btns ? `<div class="mtb-bkg-cust-actions">${btns}</div>` : '';
	};

	// Modal preview Trip — iframe laman web trip (kandungan website:
	// description, itinerary, image) tanpa keluar dari page.
	const show_trip_preview = (url, title) => {
		const d = new frappe.ui.Dialog({
			title: title || __('Trip Preview'),
			size: 'extra-large',
		});
		d.$body.html(`
			<div class="mtb-file-viewer">
				<iframe class="mtb-file-viewer-frame" src="${esc(url)}"
					title="${esc(title || '')}"></iframe>
				<div class="mtb-file-viewer-actions">
					<a class="btn btn-default btn-sm" href="${esc(url)}"
						target="_blank" rel="noopener">${__('Open in new tab')}</a>
				</div>
			</div>`);
		d.show();
	};

	// PE unik booking — kumpulkan row per reference jadi satu entry per
// Payment Entry (amount dijaga per currency). Dipakai timeline, chip
	// ringkasan dan kiraan pill tab Documents.
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

	// ── Strip wang (sticky, atas kandungan) — menyatukan cerita wang yang
	// dahulunya berpecau antara header (progress %), KPI (Order/Paid/
	// Balance) dan tab Documents (Payment Entries). Disiplin per currency
	// dikekalkan: nilai utama = default currency ('≈' bila bercampur,
	// selari KPI lama), sub = pecahan native per currency. ────────────
	function bkg_money_strip(d) {
		const p = d.profile || {};
		const rows = p.money_by_currency || [];
		const dt = p.default_totals;
		const alt = hasAltCur(rows) && dt;
		const val = (f) => (alt ? fmtDefaultTotal(dt, f) : fmtMoney((dt && dt[f]) || 0, S.currency));
		const sub = (f) => rows.map((r) => fmtMoney(r[f], r.currency)).join('<br>') || fmtMoney(0, S.currency);
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const title = esc(__('Per currency — amounts in different currencies are never summed'));

		return `
			<div class="mtb-bkg-money">
				<div class="mtb-mitem" title="${title}">
					<div class="mtb-mitem-l">${__('Order Value')}</div>
					<div class="mtb-mitem-v">${val('gross')}</div>
					<div class="mtb-mitem-s">${sub('gross')}</div>
				</div>
				<span class="mtb-bkg-msep">→</span>
					<div class="mtb-mitem">
						<div class="mtb-mitem-l">${__('Paid')}${prog ? ' · ' + prog + '%' : ''}</div>
						<div class="mtb-mitem-v">${val('paid')}</div>
						<div class="mtb-mitem-s">${sub('paid')}</div>
					</div>
				<span class="mtb-bkg-msep">→</span>
				<div class="mtb-mitem mtb-mitem--warn" title="${title}">
					<div class="mtb-mitem-l">${__('Balance')}</div>
					<div class="mtb-mitem-v">${val('balance')}</div>
					<div class="mtb-mitem-s">${sub('balance')}</div>
				</div>
				<div class="mtb-bkg-paystat">
					<div class="mtb-mitem-l">${__('Payment Status')}</div>
					${badge(p.payment_status, PAYMENT_STATUS_COLORS[p.payment_status]) || '<span class="mtb-muted">—</span>'}
				</div>
			</div>`;
	}

	// Kiraan operasi (dipakai strip wang + KPI Overview).
	const bkg_ops_counts = (d) => {
		const res = d.reservations || [];
		const active = res.filter((t) => t.reservation_status !== 'Cancelled');
		const pendingDocs = res.filter((t) => !DOC_STATUS_OK.includes(t.document_status)).length;
		return {
			total: res.length,
			active: active.length,
			cancelled: res.length - active.length,
			pendingDocs,
		};
	};

	// Chip operasi (Discount / Travellers / Rooms / Pending Docs) —
	// dahulu dalam strip wang, kini baris bawah Order Summary (tab
	// Overview). Kosong jika tiada chip relevan.
	function bkg_ops_chips(d) {
		const o = bkg_ops_counts(d);
		const dsc = bkg_discount(d.profile || {});
		const chips = [
			dsc.total > 0 ? `<span class="mtb-bkg-chip">${__('Discount')} <b>${fmtMoney(dsc.total, dsc.cur)}</b></span>` : '',
			`<span class="mtb-bkg-chip">${__('Travellers')} <b>${o.active}</b></span>`,
			`<span class="mtb-bkg-chip">${__('Rooms')} <b>${d.rooming_count ?? 0}</b></span>`,
			o.pendingDocs ? `<span class="mtb-bkg-chip mtb-bkg-chip--danger">${__('Pending Docs')} <b>${o.pendingDocs}</b></span>` : '',
		].filter(Boolean).join('');
		return chips ? `<div class="mtb-bkg-mchips">${chips}</div>` : '';
	}

	// Diskaun — currency SO utama booking (field Booking), selari KPI lama.
	const bkg_discount = (p) => {
		const cur = p.discount_currency || S.currency;
		const total = round2((p.voucher_discount || 0) + (p.price_rule_discount || 0) + (p.referral_discount || 0));
		const parts = [];
		if (p.voucher_discount) parts.push('V: ' + fmtMoney(p.voucher_discount, cur));
		if (p.price_rule_discount) parts.push('PR: ' + fmtMoney(p.price_rule_discount, cur));
		if (p.referral_discount) parts.push('RF: ' + fmtMoney(p.referral_discount, cur));
		return { cur, total, parts };
	};

	// ── Ringkasan bayaran — subline kepala kad Payments (Total Paid per
	// currency · Last payment · Verified). Kosong bila tiada PE. ─────
	const bkg_paysum = (d) => {
		const pes = bkg_pe_rows(d).filter((pe) => pe.docstatus !== 2);
		if (!pes.length) return '';
		const totals = {};
		pes.forEach((pe) => Object.entries(pe.amounts).forEach(([cur, v]) => {
			totals[cur] = round2((totals[cur] || 0) + v);
		}));
		const total = Object.entries(totals).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
		const verified = pes.filter((pe) => pe.docstatus === 1).length;
		return `<div class="mtb-doc-paysum">
			<span>${__('Total Paid')} <b>${total}</b></span>
			<span>${__('Last payment')} <b>${fmtDate(pes[0].date)}</b></span>
			${badge(verified + '/' + pes.length + ' ' + __('Verified'), verified === pes.length ? 'green' : 'yellow')}
		</div>`;
	};

	// ── Tab Overview — Order Summary: papar field virtual Booking
	// 'order_summary' (server kira live daripada SO UTAMA — pecahan
	// ikut kabin "Cabin Fare" + "Guest N" per orang, plus baris
	// diskaun; sama format dengan Payment Summary wizard). Teks itu
	// di-parse jadi kad kabin di sini. TIADA dokumen SO dipaparkan —
	// senarai SO ada dalam tab Documents. Displin currency dikekalkan:
	// setiap baris bawa currency SO utama sendiri, tiada jumlah. ────
	function bkg_parse_order_summary(txt) {
		// splitMoney — pisah label / simbol currency / amaun dari satu
		// baris ringkasan, cth "Guest 1: Adult — RM 4,115.00".
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
			if (/^[ \t]/.test(raw)) {            // baris sub — dalam kabin semasa
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
			if (mm) { dscs.push(mm); return; }   // baris atas berjumlah = diskaun
			cur = { name: t, fare: null, guests: [] };
			cabins.push(cur);
		});
		return { cabins, dscs };
	}

	function bkg_order_summary(d) {
		const os = bkg_parse_order_summary((d.profile || {}).order_summary);
		if (!os.cabins.length) return '';
		const amt = (x) => (x.amt.startsWith('-')
			? `− ${esc(x.cur)} ${esc(x.amt.slice(1))}`
			: `${esc(x.cur)} ${esc(x.amt)}`);
		const cards = os.cabins.map((c) => `
			<div class="mtb-bkg-osum-cabin">
				<div class="mtb-bkg-osum-name">${esc(c.name)}</div>
				${c.fare ? `
				<div class="mtb-bkg-osum-row is-fare">
					<span>${__('Cabin Fare')}</span><b>${amt(c.fare)}</b>
				</div>` : ''}
				${c.guests.map((g) => `
				<div class="mtb-bkg-osum-row"><span>${esc(g.who)}</span><span>${amt(g)}</span></div>`).join('')}
			</div>`).join('');
		const dscs = os.dscs.map((x) => `
			<div class="mtb-bkg-osum-row is-dsc"><span>${esc(x.label)}</span><span>${amt(x)}</span></div>`).join('');
		// Chip operasi (Discount / Travellers / Rooms / Pending Docs)
		// diletak selepas tajuk section, sebelum kad pecahan kabin.
		return bkg_section('🧾', __('Order Summary'), os.cabins.length,
			`${bkg_ops_chips(d)}<div class="mtb-bkg-osum">${cards}${dscs}</div>`);
	}

	// ── Tab Overview — garis masa booking: created → PI/SO → payments →
	// T&C (isytarat semasa), disusun ikut tarikh, diakhiri item hadapan
	// (baki tertunggak, tarikh sail). Semua daripada payload
	// get_booking_profile sedia ada — tiada panggilan API tambahan. ────
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
		// Traveller — daftar (Traveller.creation) & kemaskini (log
		// aktiviti doctype = Version; fallback modified bila tiada log).
		// Satu baris per hari (×N bila lebih 1 simpanan). Reservation
		// Cancelled dilangkau — traveller bukan lagi sebahagian trip.
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

		// Item semasa / hadapan — selepas peristiwa bersejarah.
		const tail = [];
		const money = p.money_by_currency || [];
		if (hasBalance(money)) tail.push(`
			<div class="mtb-bkg-tli mtb-bkg-tli--future">
				<div class="mtb-bkg-tld">${__('Now')}</div>
				<div>${__('Outstanding balance')} <b>${fmtCurRows(money, 'balance')}</b></div>
			</div>`);
		const sail = p.is_a_cruise_trip ? (p.cruise_start || p.departure_date) : p.departure_date;
		if (sail) tail.push(`
			<div class="mtb-bkg-tli mtb-bkg-tli--future">
				<div class="mtb-bkg-tld">${fmtDate(sail)}</div>
				<div>🚢 ${__('Sail')} — ${esc(p.ship_name || p.trip_title || '')}</div>
			</div>`);

		const items = ev.map((e) => `
			<div class="mtb-bkg-tli ${e.cls ? 'mtb-bkg-tli--' + e.cls : ''}">
				<div class="mtb-bkg-tld">${e.date ? fmtDate(e.date) : ''}</div>
				<div>${e.html}</div>
			</div>`).join('');
		return bkg_section('🕒', __('Booking Timeline'), ev.length + tail.length,
			`<div class="mtb-bkg-tl">${items}${tail.join('')}</div>`);
	}

	const bkg_section = (icon, title, count, inner) => `
		<div class="mtb-section-title">${icon} ${title}
			${count !== '' && count != null ? `<span class="mtb-count-pill">${count}</span>` : ''}
		</div>${inner}`;

	// ── Tab Traveller & Rooming — senarai bilik COLLAPSIBLE (element
	// details/summary): kepala bilik memaparkan info wajib — Room ID,
	// Room Category, Room Privacy, Room Arrangement Confirmation +,
	// bila ada, Stateroom No / Delegate No / Aroya Guest No; kandungan
	// dibuka lipat = jadual traveller bilik itu. Kolum Delegate No /
	// Aroya Guest No dalam jadual hanya muncul bila ada guest membawa
	// nilai. Reservation Cancelled tiada bilik — blok berasingan. ──
	// ── Tab Travellers — contact card (grid) / jadual (table) untuk
	// SEMUA reservation + traveller (termasuk Cancelled, dimalapkan).
	// Gambar preview attachment di ATAS nama; sub detail = gender ·
	// age · contact. Search box menapis KEDUA paparan. Toolbar juga
	// bawa butang muat turun pukal: zip imej + excel maklumat. Klik
	// kad → modal maklumat penuh. ────────────────────────────────────
	function bkg_travellers(d) {
		const res = d.reservations || [];
		if (!res.length) {
			return `<div class="mtb-empty">${__('No booking reservations for this booking.')}</div>`;
		}
		const hay = (t) => [
			t.traveller_name, t.passport_no, t.nationality, t.email, t.phone,
			t.room_id, t.room_category, t.stateroom_no, t.pax_type,
			t.delegate_no, t.aroya_guest_no, t.reservation, t.traveller,
		].map((x) => String(x || '').toLowerCase()).join(' \u0001 ');

		// — Paparan GRID: contact card —
		const cards = res.map((t) => {
			const cancelled = t.reservation_status === 'Cancelled';
			const photo = t.passport_image
				? `<img class="mtb-tvcard-photo" src="${esc(t.passport_image)}"
						alt="${esc(t.traveller_name || '')}" loading="lazy">`
				: `<div class="mtb-tvcard-photo mtb-tvcard-photo--empty">👤</div>`;
			const who = [t.gender ? esc(__(t.gender)) : '', t.age != null ? esc(String(t.age)) : '']
				.filter(Boolean).join(' · ');
			const sub = [
				who || '',
				t.email ? `✉ ${esc(t.email)}` : '',
				t.phone ? `☎ ${esc(t.phone)}` : '',
			].filter(Boolean).join('<br>') || '<span class="mtb-muted">—</span>';
			return `
			<div class="mtb-tvcard${cancelled ? ' mtb-tvcard--cancelled' : ''}"
				data-res="${esc(t.reservation)}" data-hay="${esc(hay(t))}"
				data-trav="${esc(JSON.stringify(t))}">
				${photo}
				<div class="mtb-tvcard-body">
					<div class="mtb-tvcard-name">${esc(t.traveller_name)}</div>
					<div class="mtb-tvcard-badges">
						${badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status])}
						${badge(t.document_status, DOC_STATUS_COLORS[t.document_status])}
					</div>
					<div class="mtb-tvcard-sub">${sub}</div>
				</div>
			</div>`;
		}).join('');

		// — Paparan TABLE: satu baris setiap traveller —
		const tRows = res.map((t, i) => `
			<tr class="mtb-tv-trow${t.reservation_status === 'Cancelled' ? ' mtb-row-cancelled' : ''}"
				data-hay="${esc(hay(t))}" data-trav="${esc(JSON.stringify(t))}">
				<td class="num mtb-muted">${i + 1}</td>
				<td><div class="mtb-cell-main">${esc(t.traveller_name)}</div>
					${t.passport_no ? `<div class="mtb-cell-sub">🛂 ${esc(t.passport_no)}</div>` : ''}</td>
				<td><a href="/app/booking-reservation/${esc(t.reservation)}">${esc(t.reservation)}</a>
					<div class="mtb-cell-sub">${badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status])}</div></td>
				<td>${t.email ? `✉ ${esc(t.email)}<br>` : ''}${t.phone ? `☎ ${esc(t.phone)}` : ''}</td>
				<td>${t.gender ? esc(__(t.gender)) : '—'}</td>
				<td class="num">${t.age != null ? esc(String(t.age)) : '—'}</td>
				<td class="mtb-muted">${esc(t.nationality || '—')}</td>
				<td>${(t.room_id || t.cabin_no) ? esc(t.room_id || t.cabin_no) : '—'}
					${t.room_category ? `<div class="mtb-cell-sub">${esc(t.room_category)}</div>` : ''}</td>
				<td>${badge(t.document_status, DOC_STATUS_COLORS[t.document_status])}</td>
			</tr>`).join('');
		const table = `
			<div class="mtb-table-wrap mtb-tv-tablewrap" style="display:none;">
				<table class="mtb-table">
					<thead><tr>
						<th class="num">#</th>
						<th>${__('Traveller')}</th>
						<th>${__('Reservation')}</th>
						<th>${__('Contact')}</th>
						<th>${__('Gender')}</th>
						<th class="num">${__('Age')}</th>
						<th>${__('Nationality')}</th>
						<th>${__('Room')}</th>
						<th>${__('Doc Status')}</th>
					</tr></thead>
					<tbody>${tRows}</tbody>
				</table>
			</div>`;

		const dlBase = '/api/method/travel_booking.api.manage_trip_booking.';
		return `
			<div class="mtb-tv-toolbar">
				<div class="mtb-tv-views">
					<button type="button" class="mtb-tv-view active" data-view="grid" title="${esc(__('Card view'))}">▦ ${__('Grid')}</button>
					<button type="button" class="mtb-tv-view" data-view="table" title="${esc(__('Table view'))}">☰ ${__('Table')}</button>
				</div>
				<div class="mtb-tv-tools">
					<a class="btn btn-default btn-xs" href="${dlBase}download_traveller_images?booking=${esc(d.booking)}"
						title="${esc(__('Download all traveller images (passport + visa) as a single ZIP'))}">🖼 ${__('Images ZIP')}</a>
					<a class="btn btn-default btn-xs" href="${dlBase}download_travellers_excel?booking=${esc(d.booking)}"
						title="${esc(__('Download all traveller & reservation details as Excel'))}">⬇ ${__('Info Excel')}</a>
					<input type="text" class="form-control mtb-tv-search"
						placeholder="${esc(__('Search name / passport / room / contact…'))}" />
				</div>
			</div>
			<div class="mtb-tv-grid">${cards}</div>
			${table}`;
	}

	// Modal detail traveller — SEMUA maklumat traveller + booking
	// reservation: gambar daripada attachment (jika ada) diikuti kad
	// topik penuh. ─────────────────────────────────────────────────────
	function show_traveller_dialog(t) {
		const crow = (k, v) => (v !== '' && v != null
			? `<div class="mtb-bkg-card-row"><span>${k}</span><span>${v}</span></div>` : '');
		const card = (title, inner) => (inner ? `
			<div class="mtb-bkg-card">
				<div class="mtb-bkg-card-title">${title}</div>${inner}
			</div>` : '');
		const F = (v) => (v ? esc(v) : '');
		const yesNo = (b) => (b ? badge(__('Confirmed'), 'green') : badge(__('Pending'), 'orange'));
		const photo = t.passport_image
			? `<img class="mtb-tvmodal-photo" src="${esc(t.passport_image)}"
					alt="${esc(t.traveller_name || '')}">`
			: '';

		const personal = card('👤 ' + __('Personal'),
			crow(__('Full Name'), F(t.traveller_name) || esc('-'))
			+ crow(__('Title'), F(t.title))
			+ crow(__('Gender'), t.gender ? esc(__(t.gender)) : '')
			+ crow(__('Date of Birth'), t.dob ? esc(fmtDate(t.dob)) : '')
			+ crow(__('Age'), t.age != null ? esc(String(t.age)) + (t.age_bucket && t.age_bucket !== 'Unknown' ? ` · ${badge(t.age_bucket, AGE_BUCKET_COLORS[t.age_bucket])}` : '') : '')
			+ crow(__('Age Category'), F(t.age_category))
			+ crow(__('Nationality'), F(t.nationality))
			+ crow(__('Traveller Status'), t.traveller_status ? badge(t.traveller_status, t.traveller_status.toLowerCase() === 'active' ? 'green' : 'gray') : ''));
		const contact = card('📞 ' + __('Contact'),
			crow(__('Email'), t.email ? '✉ ' + esc(t.email) : '')
			+ crow(__('Phone'), t.phone ? '☎ ' + esc(t.phone) : '')
			+ (t.phone ? `<div class="mtb-bkg-card-actions">${bkg_call_wa_btns(t.phone)}</div>` : ''));
		const emergency = card('🆘 ' + __('Emergency Contact'),
			crow(__('Name'), F(t.emergency_contact_name))
			+ crow(__('Relationship'), F(t.emergency_contact_relationship))
			+ crow(__('Phone'), t.emergency_contact_phone ? '☎ ' + esc(t.emergency_contact_phone) : '')
			+ (t.emergency_contact_phone ? `<div class="mtb-bkg-card-actions">${bkg_call_wa_btns(t.emergency_contact_phone)}</div>` : ''));
		const addressParts = [t.address_line1, t.postcode, t.city, t.state, t.country].filter(Boolean);
		const address = card('🏠 ' + __('Address'),
			crow(__('Address'), addressParts.map(esc).join('<br>')));
		const docs = card('🛂 ' + __('Documents'),
			crow(__('Passport No'), F(t.passport_no))
			+ crow(__('Passport Expiry'), t.passport_expiry ? esc(fmtDate(t.passport_expiry)) : '')
			+ crow(__('IC Number'), F(t.ic_number))
			+ crow(__('Document Status'), badge(t.document_status, DOC_STATUS_COLORS[t.document_status]))
			+ crow(__('Verified Locked'), t.document_verified ? badge(__('Yes'), 'green') : '')
			+ (t.passport_image ? crow(__('Passport Image'), `<a href="${esc(t.passport_image)}" target="_blank" rel="noopener">${__('Open image')}</a>`) : '')
			+ (t.visa_photo ? crow(__('Visa Image'), `<a href="${esc(t.visa_photo)}" target="_blank" rel="noopener">${__('Open image')}</a>`) : ''));
		const health = card('🩺 ' + __('Health & Special Needs'),
			crow(__('Wheelchair Assistant'), F(t.wheelchair_assistant))
			+ crow(__('Dietary Requirements'), F(t.dietary_requirements))
			+ crow(__('Medical Conditions'), F(t.medical_conditions))
			+ crow(__('Medicine / Treatment'), F(t.medicine_treatment)));
		const rooming = card('🛏 ' + __('Rooming'),
			crow(__('Room ID'), F(t.room_id))
			+ crow(__('Room Category'), F(t.room_category))
			+ crow(__('Room Privacy'), F(t.room_privacy))
			+ crow(__('Room Arrangement'), yesNo(t.cabin_confirmed))
			+ crow(__('Stateroom No'), F(t.stateroom_no))
			+ crow(__('Cabin No'), t.cabin_no ? esc(String(t.cabin_no)) : '')
			+ crow(__('Delegate No'), F(t.delegate_no))
			+ crow(__('Aroya Guest No'), t.aroya_guest_no !== '' && t.aroya_guest_no != null ? esc(String(t.aroya_guest_no)) : ''));
		const flight = card('✈ ' + __('Flight'),
			crow(__('Flight'), F(t.flight))
			+ crow(__('Airline'), F(t.airline)));
		const reservation = card('🧾 ' + __('Booking Reservation'),
			crow(__('Reservation'), `<a href="/app/booking-reservation/${esc(t.reservation)}">${esc(t.reservation)}</a>`)
			+ crow(__('Status'), badge(t.reservation_status, RES_STATUS_COLORS[t.reservation_status]))
			+ crow(__('Pax Type'), F(t.pax_type))
			+ crow(__('Guest Sequence'), t.guest_sequence ? esc(String(t.guest_sequence)) : '')
			+ crow(__('Traveller Record'), t.traveller ? `<a href="/app/traveller/${esc(t.traveller)}">${esc(t.traveller)}</a>` : '')
			+ crow(__('Registered'), t.traveller_created ? esc(fmtDateTime(t.traveller_created)) : '')
			+ crow(__('Last Updated'), t.traveller_modified ? esc(fmtDateTime(t.traveller_modified)) : ''));

		frappe.msgprint({
			title: '👤 ' + (t.traveller_name || t.reservation),
			indicator: t.reservation_status === 'Cancelled' ? 'red' : 'blue',
			message: `<div class="mtb-tvmodal" style="display:flex;flex-direction:column;gap:12px;">
				${photo}${personal}${contact}${emergency}${address}${docs}${health}${rooming}${flight}${reservation}
			</div>`,
		});
	}

	// Resit rasmi Payment Entry — PDF jana melalui print format resit
	// app ("Rarecation Receipt", sama dipakai portal billing).
	const pe_receipt_url = (name) =>
		'/api/method/frappe.utils.print_format.download_pdf?doctype='
		+ encodeURIComponent('Payment Entry') + '&name=' + encodeURIComponent(name)
		+ '&format=' + encodeURIComponent('Rarecation Receipt')
		+ '&no_letterhead=0';

	// ── Tab Documents (bahagian Payments) — kad Payments: kepala kad
	// bawa kiraan + ringkasan (bkg_paysum); kandungan = senarai item PE
	// (chip PE + identiti + amaun per currency + status + lampiran).
	// Backend hantar satu row per reference; dikumpulkan per PE di sini
	// — amount dijaga per currency (rujukan SO/SI boleh bercampur). ──
	function bkg_payments(d) {
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
			// Butang muat turun resit — sentiasa dipaparkan.
			const receipt = `
				<a class="mtb-doc-file-btn" href="${pe_receipt_url(peName)}" download
					title="${esc(__('Download receipt PDF'))}">🧾</a>`;
			const files = fileMap[peName] || [];
			if (!files.length) return receipt;
			return receipt + files.map((f) => `
				<span class="mtb-doc-file-actions">
					<button type="button" class="mtb-doc-file-btn mtb-file-view-btn"
						data-url="${esc(f.file_url)}" data-name="${esc(f.file_name)}"
						data-image="${f.is_image ? 1 : 0}"
						title="${esc(f.file_name)} · ${esc(__('Quick view'))}">👁</button>
					<a class="mtb-doc-file-btn" href="${esc(f.file_url)}" download
						title="${esc(f.file_name)} · ${esc(__('Download attachment'))}">⬇</a>
				</span>`).join(' ');
		};
		const items = peRows.map((pe) => {
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
			<div class="mtb-docitem" data-route="Payment Entry/${esc(pe.name)}">
				<span class="mtb-docitem-chip mtb-docitem-chip--pe">PE</span>
				<div class="mtb-docitem-main">
					<a href="/app/payment-entry/${esc(pe.name)}">${esc(pe.name)}</a>
					<div class="mtb-docitem-sub">${meta}</div>
				</div>
				<div class="mtb-docitem-side">
					<div class="mtb-docitem-amt">${amt}</div>
					${statusMeta.label ? `<div class="mtb-docitem-badges">${badge(__(statusMeta.label), statusMeta.color)}</div>` : ''}
				</div>
				<div class="mtb-docitem-files">${fileBtns(pe.name)}</div>
			</div>`;
		}).join('');
		const inner = peRows.length
			? `<div class="mtb-doc-list">${items}</div>`
			: `<div class="mtb-doc-empty">${__('No payment entry linked to this booking.')}</div>`;
		return `
			<div class="mtb-doc-card">
				<div class="mtb-doc-card-head">
					<div class="mtb-section-title">💱 ${__('Payments')}
						${peRows.length ? `<span class="mtb-count-pill">${peRows.length}</span>` : ''}</div>
					${bkg_paysum(d)}
				</div>
				${inner}
			</div>`;
	}

	// ── Section: Related Documents — SATU jadual SO / Sales Invoice /
	// Proforma Invoice; kolum PDF = muat turun (fail tersimpan PI
	// diutamakan, else print format doctype), nama = buka form. ──

	// PDF dokumen ERPNext — endpoint print standard frappe (perlu role
	// dengan print permission; desk user page ini ada).
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

	function bkg_documents(d) {
		// key = kunci tapisan jenis dokumen (chip All / SO / SI / PI).
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
				// PDF rasmi terjana & tersimpan pada dokumen (dipakai
				// portal) — diutamakan daripada jana semasa.
				pdf: pf.proforma_pdf,
			})),
		].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

		const slug = (t) => t.toLowerCase().replace(/ /g, '-');
		const items = docs.map((doc) => `
			<div class="mtb-docrow mtb-docitem" data-type="${doc.key}" data-route="${esc(doc.doctype)}/${esc(doc.name)}">
				<span class="mtb-docitem-chip mtb-docitem-chip--${doc.key}">${doc.key.toUpperCase()}</span>
				<div class="mtb-docitem-main">
					<a href="/app/${slug(doc.doctype)}/${esc(doc.name)}">${esc(doc.name)}</a>
					${doc.is_addon ? badge(__('Addon'), 'gray') : ''}
					<div class="mtb-docitem-sub">${__(doc.type)}${doc.date ? ' · ' + fmtDate(doc.date) : ''}</div>
				</div>
				<div class="mtb-docitem-side">
					<div class="mtb-docitem-amt">${fmtMoney(doc.amount, doc.currency)}</div>
					<div class="mtb-docitem-badges">
						${docstatus_badge(doc.docstatus)}
						${doc.docstatus !== 2 ? badge(doc.status, SO_STATUS_COLORS[doc.status] || 'gray') : ''}
					</div>
				</div>
				<div class="mtb-docitem-files">
					<a class="mtb-doc-file-btn" href="${doc.pdf || doc_pdf_url(doc.doctype, doc.name)}" download
						title="${esc(__('Download document PDF'))}">⬇ PDF</a>
				</div>
			</div>`).join('');

		// Chip tapisan jenis — menapis item dalam pane ini sahaja
		// (delegate .mtb-doc-filter, tiada refetch).
		const typeCounts = { so: 0, si: 0, pi: 0 };
		docs.forEach((x) => { typeCounts[x.key] += 1; });
		const chips = docs.length ? `
			<div class="mtb-bkg-chips">
				<button type="button" class="mtb-doc-filter active" data-filter="all">${__('All')} · ${docs.length}</button>
				<button type="button" class="mtb-doc-filter" data-filter="so">${__('Sales Order')} · ${typeCounts.so}</button>
				<button type="button" class="mtb-doc-filter" data-filter="si">${__('Sales Invoice')} · ${typeCounts.si}</button>
				<button type="button" class="mtb-doc-filter" data-filter="pi">${__('Proforma Invoice')} · ${typeCounts.pi}</button>
			</div>` : '';

		const inner = docs.length
			? `<div class="mtb-doc-list">${items}</div>`
			: `<div class="mtb-doc-empty">${__('No related documents (Sales Order / Invoice / Proforma) yet.')}</div>`;
		return `
			<div class="mtb-doc-card">
				<div class="mtb-doc-card-head">
					<div class="mtb-section-title">📄 ${__('Documents')}
						${docs.length ? `<span class="mtb-count-pill">${docs.length}</span>` : ''}</div>
					${chips}
				</div>
				${inner}
			</div>`;
	}

	/* ========== Tab Others ========== */

	// Warna status komisen affiliate (do Affiliate Commission).
	const COMMISSION_STATUS_COLORS = {
		'Pending': 'yellow', 'Invoiced': 'blue', 'Approved': 'cyan',
		'Paid': 'green', 'Denied': 'red',
	};

	function bkg_others(d) {
		const p = d.profile || {};
		// Diskaun & profil affiliate sebaris (½ lebar setiap satu).
		// SETIAP kad dibalut dalam satu sel — output bkg_section ialah
		// dua elemen berasingan (tajuk + kad); tanpa pembalut, tajuk &
		// kad menjadi item grid berasingan (susunan zig-zag). Satu kad
		// sahaja = penuh lebar tanpa grid. Komisen selepas profil
		// affiliate, audit di hujung.
		const dsc = bkg_discount_card(p);
		const aff = bkg_affiliate_card(d);
		const duo = (dsc && aff)
			? `<div class="mtb-bkg-others-grid">
				<div class="mtb-bkg-others-cell">${dsc}</div>
				<div class="mtb-bkg-others-cell">${aff}</div>
			</div>`
			: (dsc + aff);
		return duo
			+ bkg_commissions(d)
			+ bkg_audit_card(p);
	}

	const bkg_card_row = (k, v, cls) => `
		<div class="mtb-bkg-card-row${cls ? ' ' + cls : ''}"><span>${k}</span><span>${v}</span></div>`;

	// ── Pecahan diskaun penuh — semua field diskaun Booking dalam SATU
	// currency (discount_currency = SO utama), jadi jumlahnya sah. ──
	function bkg_discount_card(p) {
		const cur = p.discount_currency || S.currency;
		const total = round2((p.voucher_discount || 0) + (p.price_rule_discount || 0) + (p.referral_discount || 0));
		if (!(total > 0) && !(p.pre_discount_total > 0)) return '';
		const money = (v) => fmtMoney(v || 0, cur);
		return bkg_section('🏷️', __('Discount Information'), '',
			`<div class="mtb-bkg-card">
				${bkg_card_row(__('Pre-Discount Total'), money(p.pre_discount_total), 'is-strong')}
				${bkg_card_row(__('Voucher Discount'), money(p.voucher_discount))}
				${bkg_card_row(__('Price Rule Discount'), money(p.price_rule_discount))}
				${bkg_card_row(__('Referral Discount'), money(p.referral_discount))}
				<div class="mtb-bkg-card-row is-dsc"><span>${__('Total Discount')}</span><span>${total > 0 ? '− ' + money(total) : money(0)}</span></div>
			</div>`);
	}

	// ── Komisen affiliate — Affiliate Commission berpaut ke SO booking
	// (utama + addon). Row reversal dilabel & ditolak. Ringkasan
	// "Received" = jumlah per currency row berstatus Paid sahaja —
	// currency TIDAK dijumlah merentas currency. ─────────────────────
	function bkg_commissions(d) {
		const rows = d.commissions || [];
		if (!rows.length) return '';
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
					<div class="mtb-cell-sub">${__('From')} <a href="/app/sales-order/${esc(c.sales_order)}">${esc(c.sales_order)}</a></div></td>
				<td class="num">${c.rate ? c.rate + '%' : '—'}${c.base ? ' · ' + esc(c.base) : ''}</td>
				<td class="num">${c.is_reversal ? '− ' + fmtMoney(c.amount, c.currency) : fmtMoney(c.amount, c.currency)}</td>
				<td>${c.is_reversal ? badge(__('Reversal'), 'red') : badge(__(c.status), COMMISSION_STATUS_COLORS[c.status] || 'gray')}</td>
			</tr>`).join('');
		const summary = receivedHtml
			? `<div class="mtb-bkg-dsc-note">${__('Received (Paid)')}: <b>${receivedHtml}</b></div>`
			: '';
		return bkg_section('💰', __('Commission Received'), rows.length,
			`<div class="mtb-table-wrap">
				<table class="mtb-table">
					<thead><tr>
						<th>${__('Commission')}</th>
						<th class="num">${__('Rate')}</th>
						<th class="num">${__('Amount')}</th>
						<th>${__('Status')}</th>
					</tr></thead>
					<tbody>${body}</tbody>
				</table>
			</div>${summary}`);
	}

	// ── Info affiliate — nama (tajuk kad, pautan ke profil) + ringkas:
	// referral code, email & telefon + butang Call/WhatsApp (kongsi
	// helper dengan section Customer). Butiran profil penuh (baki,
	// bank, dsb.) tiada di sini. ─────────────────────────────────────
	function bkg_affiliate_card(d) {
		const a = d.affiliate_info;
		if (!a) return '';
		return bkg_section('🤝', __('Affiliate Profile'), '',
			`<div class="mtb-bkg-card">
				<div class="mtb-bkg-card-title">
					<a href="/app/affiliate-profile/${esc(a.name)}">${esc(a.full_name || a.name)}</a>
				</div>
				${a.referral_code ? bkg_card_row(__('Referral Code'), esc(a.referral_code)) : ''}
				${a.email ? bkg_card_row(__('Email'), '✉ ' + esc(a.email)) : ''}
				${a.phone ? bkg_card_row(__('Phone'), '☎ ' + esc(a.phone)) : ''}
				${a.phone ? `<div class="mtb-bkg-card-actions">${bkg_call_wa_btns(a.phone)}</div>` : ''}
			</div>`);
	}

	// ── Audit — dipindah dari rail (Booked By / Created / Modified /
	// Company) ke kad dalam tab Others. ──────────────────────────────
	function bkg_audit_card(p) {
		return bkg_section('🗄️', __('Audit'), '',
			`<div class="mtb-bkg-card">
				${bkg_card_row(__('Booked By'), esc(p.booked_by || '—'))}
				${bkg_card_row(__('Created'), esc(fmtDateTime(p.creation)))}
				${bkg_card_row(__('Modified'), esc(fmtDateTime(p.modified)))}
				${p.company ? bkg_card_row(__('Company'), esc(p.company)) : ''}
			</div>`);
	}

	/* ========== public API ========== */
	return { init, on_show };
})();
