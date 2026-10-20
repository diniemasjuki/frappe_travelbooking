/* travel_booking/public/js/booking_list.js
   Paket generik SENARAI BOOKING — window.TravelBookingBookingList.

   Satu komponen drop-in untuk papar senarai booking (data daripada
   travel_booking.api.manage_trip_booking.get_group_bookings) yang boleh
   diguna semula di mana-mana section desk app travel_booking:
   - Manage Booking App  — tab Booking (kolum compact, kad responsif)
   - Manage Booking Group — tab Booking (kolum penuh + message + diskaun)
   - section lain kelak  — cukup panggil create() pada container anda.

   Komponen memilik kitaran penuh sendiri: muat data (frappe.call) +
   toolbar tapisan (carian debounce, status, payment, currency, group,
   row limit) + render (kad telefon / jadual desktop + footer totals) +
   event (klik baris, butang mesej, load more). Page hanya perlu
   menyediakan container + skop trip_groups + callback.

   Guna:
     const list = TravelBookingBookingList.create($('#pane-saya'), {
         trip_groups: ['TGD-001', 'TGD-002'],   // wajib — skop group date
         state: myStateObj,        // optional — objek state dikongsi dgn page
                                   // {search, status, payment, currency, group, limit}
         group_options: [{name, trip_name}],  // optional — dropdown tapisan
                                   // group dalam batch (auto bila diberi)
         currency: 'MYR',          // default display currency (fallback MYR)
         currency_filter: true,    // papar dropdown tapisan currency
                                   // (hanya bila >1 currency dalam hasil)
         columns: 'compact',       // 'full' | 'compact' | [kolum keys]
         show_title: true,         // tajuk seksyen "Booking Reservations"
         show_cards: true,         // kad responsif telefon
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

	/* ── Registry kolum ───────────────────────────────────────────
	   Setiap kolum: th() → label header; cls — kelas <td>/<th>;
	   td(b) → HTML cell; total(tot, m) → HTML cell footer (tiada =
	   kolum tanpa kiraan — kolum tanpa kiraan di hadapan diumpuk
	   jadi satu cell label colspan).                                   */

	const COLUMNS = {
		booking_no: {
			th: () => __('Booking No'),
			cls: 'tblk-col-bkopen',
			td: (b, m) => `
				<div class="tblk-cell-main">${esc(b.booking_number || b.name)}</div>
				<div class="tblk-cell-sub">${esc(b.name)}</div>
				${m.compact && b.status ? `<div class="tblk-cell-sub">${badge(b.status, BOOKING_STATUS_COLORS[b.status])}</div>` : ''}`,
		},
		customer: {
			th: () => __('Customer'),
			td: (b) => `
				<div class="tblk-cell-main">${esc(b.customer_name)}</div>
				${b.cust_email ? `<div class="tblk-cell-sub">${esc(b.cust_email)}</div>` : ''}
				${b.cust_phone ? `<div class="tblk-cell-sub">☎ ${esc(b.cust_phone)}</div>` : ''}`,
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
			td: (b) => `<span class="tblk-muted">${esc(b.trip_date || '')}</span>`,
		},
		status: {
			th: () => __('Status'),
			td: (b) => `
				${badge(b.status, BOOKING_STATUS_COLORS[b.status])}
				${b.booking_channel ? `<div class="tblk-cell-sub">${esc(b.booking_channel)}</div>` : ''}`,
		},
		payment: {
			th: () => __('Payment'),
			td: (b) => badge(b.payment_status, PAYMENT_STATUS_COLORS[b.payment_status]),
		},
		pax: {
			th: () => __('Pax'), num: true,
			td: (b) => String(b.pax ?? 0),
			total: (tot) => `<td class="num">${tot.pax ?? 0}</td>`,
		},
		// Pax (compact) — pax + bilik + dokumen verified/submitted.
		// Semantik: submitted = reservation berpaut Traveller;
		// verified = Traveller berstatus dokumen Verified/Valid.
		pax_info: {
			th: () => __('Pax'), num: true,
			td: (b) => `
				${b.pax}
				<div class="tblk-cell-sub">${b.rooms ?? 0} ${__('rooms')}</div>
				<div class="tblk-cell-sub ${(b.pending_docs || 0) > 0 ? 'tblk-danger' : ''}"
					title="${esc(__('Verified vs submitted traveller documents'))}">${b.docs_verified || 0}/${b.docs_submitted || 0} ${__('docs')}</div>`,
			total: (tot) => `<td class="num">${tot.pax ?? 0}</td>`,
		},
		rooms: {
			th: () => __('Rooms'), num: true,
			td: (b) => String(b.rooms ?? 0),
			total: (tot) => `<td class="num">${tot.rooms ?? 0}</td>`,
		},
		gross: {
			th: () => __('Gross'), num: true,
			td: (b, m) => fmtCurRows(m.bcur(b), 'gross'),
			total: (tot, m) => m.money_total(tot, 'gross'),
		},
		paid: {
			th: () => __('Paid'), num: true,
			td: (b, m) => fmtCurRows(m.bcur(b), 'paid'),
			total: (tot, m) => m.money_total(tot, 'paid'),
		},
		balance: {
			th: () => __('Balance'), num: true,
			td: (b, m) => `<span class="${hasBalance(m.bcur(b)) ? 'tblk-danger' : 'tblk-success'}">${fmtCurRows(m.bcur(b), 'balance')}</span>`,
			total: (tot, m) => m.money_total(tot, 'balance', (m.dt(tot).balance || 0) > 0.009 ? 'tblk-danger' : ''),
		},
		discount: {
			th: () => __('Discount'), num: true,
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
			td: (b) => `<span class="${(b.pending_docs || 0) > 0 ? 'tblk-danger' : ''}"
				title="${esc(__('Traveller documents pending verification'))}">${b.pending_docs ?? 0}</span>`,
			total: (tot) => `<td class="num ${(tot.pending_docs || 0) > 0 ? 'tblk-danger' : ''}">${tot.pending_docs ?? 0}</td>`,
		},
		created: {
			th: () => __('Created'), num: true,
			td: (b) => `<span class="tblk-muted">${fmtDateTime(b.creation)}</span>`,
		},
		// Bills (compact) — nilai bil per currency + % paid + badge payment.
		bills: {
			th: () => __('Bills'), num: true,
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

		const trip_groups = opts.trip_groups || [];
		const multi = trip_groups.length > 1;
		const compact = opts.columns === 'compact'
			|| (Array.isArray(opts.columns) && opts.columns.includes('pax_info'));

		const inst = {
			opts, st, $root,
			data: null,
			is_attached: () => $root.closest('body').length > 0,
			load,
			render,
		};

		function resolve_columns() {
			let cols = opts.columns || 'full';
			if (typeof cols === 'string') cols = PRESETS[cols] || PRESETS.full;
			return cols
				.map((k) => COLUMNS[k])
				.filter(Boolean)
				.filter((c) => c !== COLUMNS.group || multi);
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
			const rows = data.bookings || [];
			const tot = data.totals || {};
			const cols = resolve_columns();
			const m = { compact, bcur, dt, money_total };

			// ── Toolbar tapisan server ──
			const groupOpts = (opts.group_options || [])
				.map((g) => `<option value="${esc(g.name)}" ${st.group === g.name ? 'selected' : ''}>${esc(g.name)} · ${esc(g.trip_name || '')}</option>`)
				.join('');
			const currencies = data.currencies || [];
			const curSel = (opts.currency_filter && currencies.length > 1)
				? `<select data-tblk-kind="currency" title="${esc(__('Filter by billed currency'))}">
					<option value="">${__('All Currencies')}</option>
					${currencies.map((c) => `<option value="${esc(c)}" ${st.currency === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
				</select>` : '';
			const statusOpts = BOOKING_STATUS_OPTIONS
				.map((o) => `<option value="${esc(o)}" ${st.status === o ? 'selected' : ''}>${esc(o || 'All Status')}</option>`).join('');
			const payOpts = PAYMENT_STATUS_OPTIONS
				.map((o) => `<option value="${esc(o)}" ${st.payment === o ? 'selected' : ''}>${esc(o || 'All Payments')}</option>`).join('');
			const limitSel = `<select data-tblk-kind="limit" title="${esc(__('Rows to show'))}">${ROW_LIMITS.map((n) =>
				`<option value="${n}" ${n === st.limit ? 'selected' : ''}>${n === 0 ? __('All rows') : __('{0} rows', [n])}</option>`).join('')}</select>`;

			const toolbar = `
				<div class="tblk-toolbar">
					<input type="text" class="tblk-search" placeholder="${esc(opts.search_placeholder || __('Search booking / customer / traveller...'))}"
						value="${esc(st.search)}" />
					${opts.group_options && opts.group_options.length ? `
					<select data-tblk-kind="group" title="${esc(__('Filter by trip group date'))}">
						<option value="">${__('All Group Dates')}</option>${groupOpts}
					</select>` : ''}
					${curSel}
					<select data-tblk-kind="status">${statusOpts}</select>
					<select data-tblk-kind="payment">${payOpts}</select>
					${limitSel}
				</div>`;

			const title = opts.show_title
				? `
				<div class="tblk-section-title">🧾 ${__('Booking Reservations')}
					<span class="tblk-count-pill">${data.count ?? 0}</span>
				</div>` : '';

			// ── Kad (telefon) ──
			const cards = (opts.show_cards !== false) ? rows.map((b) => {
				const c = bcur(b);
				return `
				<div class="tblk-bkcard" data-booking="${esc(b.name)}" title="${esc(__('Open booking info page'))}">
					<div class="tblk-bkcard-top">
						<span class="tblk-bkcard-no">${esc(b.booking_number || b.name)}</span>
						<span class="tblk-bkcard-badges">
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

			// ── Jadual (desktop) ──
			const headCells = cols.map((c) =>
				`<th class="${c.num ? 'num ' : ''}${c.cls || ''}">${c.th()}</th>`).join('');
			const bodyRows = rows.map((b) => `
				<tr class="tblk-row" data-booking="${esc(b.name)}">
					${cols.map((c) => `<td class="${c.num ? 'num ' : ''}${c.cls || ''}">${c.td(b, m)}</td>`).join('')}
				</tr>`).join('');

			// Footer totals — kolum tanpa kiraan di hadapan diumpuk jadi
			// satu cell label colspan; kiraan wang dalam default currency
			// (kadar semasa) dengan tooltip pecahan native per currency.
			const leading = [];
			for (const c of cols) {
				if (c.total) break;
				leading.push(c);
			}
			const d = dt(tot);
			const incomplete = d.rates_complete === false ? '+' : '';
			const label = data.count ? `
				${__('Total')} (${data.count} ${__('bookings')})
				<span class="tblk-muted">· ${esc(d.currency || _currency)}${incomplete}</span>` : '';
			const footCells = cols.slice(leading.length)
				.map((c) => (c.total ? c.total(tot, m) : '') || '<td></td>').join('');
			const footer = data.count ? `
				<tfoot><tr>
					<td class="tblk-tfoot-label" colspan="${Math.max(leading.length, 1)}">${label}</td>
					${footCells}
				</tr></tfoot>` : '';

			// Baris ringkas bawah jadual (compact / telefon) — jumlah pax
			// + baki tertunggak dalam default currency.
			const summary = compact && data.count ? `
				<div class="tblk-tab-total">${__('Total')} (${data.count} ${__('bookings')}) · ${tot.pax ?? 0} ${__('pax')}
					· <span class="${(d.balance || 0) > 0.009 ? 'tblk-danger' : ''}">${fmtMoney(d.balance, d.currency)} ${__('due')}</span></div>` : '';

			const showing = `
				<div class="tblk-showing">
					<span>${__('Showing {0} of {1} {2}', [data.shown ?? 0, data.count ?? 0, __('bookings')])}</span>
					${(data.count || 0) > (data.shown || 0) ? `<button class="btn btn-default btn-xs tblk-load-more">${__('Load more')}</button>` : ''}
				</div>`;

			$root.html(`
				${title}
				${toolbar}
				${rows.length ? `
				${(opts.show_cards !== false) ? `<div class="tblk-cards">${cards}</div>` : ''}
				<div class="tblk-table-wrap">
					<table class="tblk-table">
						<thead><tr>${headCells}</tr></thead>
						<tbody>${bodyRows}</tbody>
						${footer}
					</table>
				</div>
				${summary}` : `<div class="tblk-empty">${__('No bookings found for this filter.')}</div>`}
				${showing}`);
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

		// Carian — debounce seperti page asal.
		$root.on('input', '.tblk-search', debounce(function () {
			const i = inst();
			if (!i) return;
			i.st.search = this.value;
			i.load(true);
		}, 350));

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
			if ($(ev.target).closest('a, button').length) return;
			const i = inst();
			const b = $(this).data('booking') || $(this).closest('[data-booking]').data('booking');
			if (!i || !b) return;
			ev.stopPropagation();
			(i.opts.on_open_booking || default_open)(b);
		});

		// Baris jadual → hook on_row_click (default = on_open_booking).
		$root.on('click', 'tr.tblk-row', function (ev) {
			if ($(ev.target).closest('a, button, .tblk-msg-btn, td.tblk-col-bkopen').length) return;
			const i = inst();
			const b = $(this).data('booking');
			if (!i || !b) return;
			(i.opts.on_row_click || i.opts.on_open_booking || default_open)(b);
		});
	}

	return { create, COLUMNS, PRESETS };
})();
