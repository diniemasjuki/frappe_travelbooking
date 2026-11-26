// travel_booking/module_admin_portal/page/travel_manager/tm_addon_booking.js
// ADDON BOOKING — SENARAI FLAT SEMUA BOOKING ADDON (route 'addon-booking')
//
// [Nov 2026] Sub-menu Booking (selepas Booking Group): senarai
// FLAT semua order Booking Addon merentas trip — TANPA melalui travel
// date — disusun created on TERKINI dahulu (creation DESC, server-side;
// API get_all_addons). Konsep interface SAMA dengan direktori Customer
// (tm_customer.js) & senarai flat booking: datatable tmDataTable kongsi —
// carian SERVER-SIDE (order/booking/customer/offer/travel date), penapis
// status/payment/currency, sort & column-toggle (persistKey), strip
// ringkasan nilai per currency.
// Klik Booking No → Booking Info (L3) di route booking-group/<BK>.
//
// Di-include ke dalam scope IIFE page oleh render_include (concatenation)
// — kongsi closure $body/breadcrumb/esc/badge/C/card/tmDataTable/webFmt*
// dengan fail seksyen lain. Backend: get_all_addons (manage_trip_booking,
// helper `mtb` kongsi tm_shared).

/* ══════════════════════════════════════════════════════════════════════
   SEKSYEN: ADDON BOOKING — SENARAI FLAT (tm_addon_booking.js)
   ══════════════════════════════════════════════════════════════════════ */

	// ── Keadaan seksyen ──
	let abkRows = [];        // baris senarai terkini
	let abkDt = null;        // instance tmDataTable
	let abkTotal = 0;        // jumlah rekod server (amaran cap & strip)

	// Warna badge status (cermin ADDON_STATUS_COLORS BookingManagement &
	// PAYMENT_STATUS_COLORS pakej booking list).
	const ABK_STATUS_COLORS = {
		'Pending': C.orange, 'Confirmed': C.green, 'Cancelled': C.red,
	};
	const ABK_PAY_COLORS = {
		'Incomplete': C.orange, 'Pending': C.orange, 'Partially Paid': C.blue,
		'Paid': C.green, 'Request Refund': C.orange, 'Pending Refund': C.orange,
		'Refunded': C.gray,
	};
	const abkBadge = (label, colors) => (label && colors[label])
		? badge(label, colors[label])
		: (label ? `<span class="text-muted">${esc(label)}</span>` : '<span class="text-muted">—</span>');

	// ── Strip ringkasan — kiraan daripada baris SEMASA (hasil carian) ──
	const abkSummaryHtml = () => {
		const shown = abkRows.length;
		const truncated = abkTotal > shown;
		const perCur = {};
		abkRows.forEach((r) => {
			const cur = r.currency || 'MYR';
			perCur[cur] = (perCur[cur] || 0) + (r.total_amount || 0);
		});
		const amtChips = Object.entries(perCur).map(([cur, amt]) =>
			`<span class="text-nowrap"><strong>${esc(cur)} ${fmtNum(amt)}</strong></span>`);
		const pending = abkRows.filter((r) => (r.status || '') === 'Pending').length;
		return `
			<span class="text-nowrap"><strong class="text-body">${shown}</strong> order${truncated ? ` daripada <strong>${abkTotal}</strong>` : ''}</span>
			${amtChips.map((c) => `<span class="text-nowrap">${c} nilai</span>`).join('')}
			<span class="text-nowrap" style="color:${C.orange}"><strong>${pending}</strong> pending</span>
			${truncated ? `<span class="text-nowrap" style="color:${C.orange}">⚠ paparan terhad ${shown} (cap 1000) — gunakan carian</span>` : ''}`;
	};
	const abkRefreshMeta = () => {
		$body.find('#tm-abk-summary').html(abkSummaryHtml());
		$body.find('#tm-abk-count').text(abkRows.length);
	};

	// ── Baris jadual ──
	const abkRowHtml = (r) => `
		<tr class="tm-abk-row" data-booking="${esc(r.booking || '')}"
			title="${r.booking ? 'Booking No → buka Booking Info' : ''}">
			<td>
				<div class="font-weight-bold">${esc(r.name)}</div>
				<div class="text-muted text-small">${r.item_count
					? esc(r.item_count + ' item') : '<span class="text-muted">tiada item</span>'}</div>
			</td>
			<td>
				${r.booking ? `
				<a href="javascript:void(0)" class="tm-abk-bklink font-weight-bold"
					title="Buka Booking Info (L3)">${esc(r.booking_number || r.booking)}</a>
				<div class="text-muted text-small">${esc(r.booking)}</div>` : '<span class="text-muted">—</span>'}
			</td>
			<td>
				<div>${esc(r.customer_name || r.customer || '—')}</div>
			</td>
			<td>
				<div class="text-nowrap">${esc(r.travel_date || '—')}</div>
				<div class="text-muted text-small text-nowrap">${esc(r.package_offer || '')}</div>
			</td>
			<td>${abkBadge(r.status, ABK_STATUS_COLORS)}</td>
			<td>${abkBadge(r.payment_status, ABK_PAY_COLORS)}</td>
			<td class="text-right text-nowrap">
				<strong>${esc(r.currency || '')} ${fmtNum(r.total_amount)}</strong>
			</td>
			<td class="text-nowrap">${esc(r.order_date ? webFmtDate(r.order_date) : '—')}</td>
			<td class="text-nowrap">${esc(r.creation ? webFmtDate(r.creation) : '—')}</td>
		</tr>`;

	// Handler delegated (SEKALI sahaja — corak tm_customer).
	$body.on('click', '.tm-abk-bklink', function (e) {
		e.stopPropagation();
		const bk = $(this).closest('.tm-abk-row').data('booking');
		if (bk) frappe.set_route('travel-manager', 'booking-group', bk);
	});

	// Dipanggil shell handle_route() untuk kata kunci 'addon-booking'.
	async function load_addon_booking_list() {
		$body.html(loading());
		await webFmtLoad();

		const data = await mtb('get_all_addons', { limit: 1000 });
		abkRows = (data?.addons || []).slice();
		abkTotal = parseInt(data?.count, 10) || abkRows.length;
		abkDt = null;

		$body.html(`
			<div class="d-flex flex-wrap gap-2 overflow-auto py-1 text-muted mb-3"
				id="tm-abk-summary" aria-label="Ringkasan addon booking">${abkSummaryHtml()}</div>
			${card(12, `🎁 ADDON BOOKING <span class="text-muted">(<span id="tm-abk-count">${abkRows.length}</span>${abkTotal > abkRows.length ? ` / ${abkTotal}` : ''})</span>`, `
				<div id="tm-abk-dt"></div>`)}
		`);

		// Jadual interaktif kongsi + EXT (corak direktori Customer):
		//   serverSearch — carian di server; persistKey — column toggle.
		abkDt = tmDataTable('#tm-abk-dt', abkRows, {
			footer: true,
			pageSize: 25,
			pageSizeOptions: [10, 25, 50, 100],
			pageSizesLabel: 'Per page',
			headers: [
				'Order', 'Booking No', 'Customer', 'Travel Date / Offer',
				'Status', 'Payment', { text: 'Nilai', cls: 'text-right' },
				'Order Date', 'Dicipta',
			],
			rowHtml: abkRowHtml,
			serverSearch: (q) => mtb('get_all_addons',
				{ search: (q || '').trim(), limit: 1000 })
				.then((res) => {
					abkRows = (res?.addons || []).slice();
					abkTotal = parseInt(res?.count, 10) || abkRows.length;
					abkRefreshMeta();
					return abkRows;
				}),
			persistKey: 'tm-abk-cols',
			searchPlaceholder: 'Search order / booking / customer / offer…',
			emptyMsg: 'Tiada order addon dijumpai.',
			filters: [
				{ key: 'status', label: 'All status', of: (r) => r.status || '' },
				{ key: 'payment', label: 'All payments', of: (r) => r.payment_status || '' },
				{ key: 'currency', label: 'All currencies', of: (r) => r.currency || '' },
			],
			sortable: [
				{ key: 'order', val: (r) => (r.name || '').toLowerCase() },
				{ key: 'bkno', val: (r) => (r.booking_number || r.booking || '').toLowerCase() },
				{ key: 'cust', val: (r) => (r.customer_name || r.customer || '').toLowerCase() },
				{ key: 'td', val: (r) => r.travel_date || '' },
				{ key: 'status', val: (r) => r.status || '' },
				{ key: 'pay', val: (r) => r.payment_status || '' },
				{ key: 'amount', val: (r) => r.total_amount || 0 },
				{ key: 'odate', val: (r) => r.order_date || '' },
				{ key: 'created', val: (r) => r.creation || '' },
			],
		});
	}
