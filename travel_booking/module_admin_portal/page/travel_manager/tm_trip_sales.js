	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRIP SALES DIRECTORY (tm_trip_sales.js)
	   ════════════════════════════════════════════════════════════════════
	   Senarai jualan SATU trip — datatable interaktif tmDataTable
	   (Booking/Customer/Amount/Status, sortable + carian inline +
	   penapis Travel Date/Status/Year-Month; kolum Actions dibuang).
	   Dipindah keluar dari trip directory (Nov 2026).
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_trip_sales() (router).
	   ════════════════════════════════════════════════════════════════════ */

		// ════════════ TRIP SALES DIRECTORY (Nov 2026) ════════════
		// Senarai jualan SATU trip — dipindahkan keluar dari trip
		// directory; halaman ini diakses melalui panel TRIP DIRECTORY
		// (trip/<trip>/sales).
		async function load_trip_sales(trip) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: trip },
				{ label: 'Sales' },
			]);
			$body.html(loading());
			const [sales, core, nav] = await Promise.all([
				hub('get_booking_kanban', { trip }).catch(() => null),
				tcc('get_trips_list', { search: trip, limit: 1 }),
				// Nav row aras trip kongsi (#tm-trip-navrow — same level dgn
				// trip directory; Nov 2026). null bila gagal — row kekal
				// dipapar dgn prev/next disabled.
				fetchTripNav(trip).catch(() => null),
				// Format paparan tarikh Travel Website (kad TRIP INFORMATION).
				webFmtLoad(),
			]);
			const info = (core?.trips || []).find((t) => t.name === trip);
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: info?.trip_name || trip, route: ['travel-manager', 'trip', trip] },
				{ label: 'Sales' },
			]);
			// Nav row aras TRIP kongsi (#tm-trip-navrow — All Trips / Prev /
			// Next / Delete, sama level dgn trip directory; Nov 2026).
			// Balik ke trip directory kekal melalui breadcrumb / butang
			// 📄 Details di footer kad TRIP INFORMATION.
			const navRow = tripNavRowHtml(trip, nav);
			// ── SALES FOR THIS TRIP — datatable interaktif (Nov 2026) ──
			// Kolum Booking/Customer/Amount/Status (kolum Actions dibuang —
			// arahan pemilik; baris statik, tiada klik). Sortable header
			// (asc/desc), carian inline & penapis Travel Date / Status /
			// Year-Month — semuanya client-side melalui pakej tmDataTable.
			const salesCols = sales?.columns || {};
			const salesRowsData = ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed']
				.flatMap((st) => salesCols[st] || []);
			const salesCard = card(12, `💰 SALES FOR THIS TRIP (${salesRowsData.length})`, `
				<div id="tm-sales-dt"></div>`);
			$body.html(`${navRow}
				<div style="margin-bottom:10px">${tripInfoCardHtml(info, trip)}</div>
				<div>${salesCard}</div>`);
			wireTripNavRow(trip, nav);
			// footer: true — select "Per page" & pagination hidup dalam
			// card-footer kad (bukan inline bawah jadual; Nov 2026) —
			// serupa kad TRAVEL DATES di trip directory.
			tmDataTable('#tm-sales-dt', salesRowsData, {
				footer: true,
				headers: ['Booking', 'Customer', 'Amount', 'Status'],
				rowHtml: (b) => `
					<tr data-booking="${esc(b.name)}">
						<td><strong>${esc(b.name)}</strong></td>
						<td>${esc(b.customer_name || '')}</td>
						<td class="text-right">${money(b.total_amount)}</td>
						<td>${badge(b.status, BKG_COLOR[b.status] || C.gray)}</td>
					</tr>`,
				searchIn: (b) => [b.name, b.customer_name].join(' '),
				searchPlaceholder: 'Search booking / customer…',
				emptyMsg: 'No bookings for this trip.',
				filters: [
					{ key: 'date', label: 'Travel date', of: (b) => b.trip_date || '—' },
					{ key: 'status', label: 'Status', of: (b) => b.status || '—' },
					{ key: 'ym', label: 'Year-month',
						of: (b) => (b.departure_date || '').slice(0, 7) || '—' },
				],
				sortable: [
					{ key: 'name', val: (b) => b.name || '' },
					{ key: 'customer', val: (b) => (b.customer_name || '').toLowerCase() },
					{ key: 'amount', val: (b) => parseFloat(b.total_amount) || 0 },
					{ key: 'status', val: (b) => b.status || '' },
				],
				sortVal: (b) => b.name || '',
			});
			}
