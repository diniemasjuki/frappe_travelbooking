	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRIP DIRECTORY (tm_trip_directory.js)
	   ════════════════════════════════════════════════════════════════════
	   Direktori satu trip — senarai travel dates (jadual + kad),
	   tambah date baharu, info cruise schedule & availabiliti.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_trip_directory() (router).
	   ════════════════════════════════════════════════════════════════════ */

		// ════════════ TRIP DIRECTORY ════════════
		async function load_trip_directory(trip) {
			// Breadcrumb sementara semasa memuat (label docname) — diganti
			// nama penuh trip selepas get_trips_list selesai di bawah.
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: trip },
			]);
			$body.html(loading());

			// [Nov 2026] sales dipindahkan ke halaman tersendiri
			// (trip/<trip>/sales) — tiada get_booking_kanban di sini lagi.
			// webFmtLoad: format paparan tarikh Travel Website (dipakai kad
			// TRAVEL DATES & modal maklumat tarikh).
			const [links, core] = await Promise.all([
				tlinks('get_trip_links', { trip }),
				tcc('get_trips_list', { search: trip, limit: 1 }),
				webFmtLoad(),
			]);
			// Hierarki ERD: senarai Travel Date trip ini (dipaparkan sebagai
			// kad TRAVEL DATES — offer anak diurus di peringkat tarikh).
			let dateList = [];
			try {
				dateList = (await api('get_travel_dates_list', { trip, limit: 200 }))?.dates || [];
			} catch (e) { dateList = []; }
			const info = (core?.trips || []).find((t) => t.name === trip);
			// Breadcrumb muktamad: segmen terakhir = nama penuh trip (boleh
			// klik balik Travel Manager / Trip List dari mana-mana peringkat).
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: info?.trip_name || trip },
			]);
			set_trip_title(info?.trip_name || trip);

			// Hierarki ERD (susun atur Nov 2026): laman utama TRIP memaparkan
			// DEFAULT komponen & pakej + Travel Dates + Sales sahaja. Maklumat
			// cruise & rooming hidup pada peringkat TRAVEL DATE (setiap tarikh
			// berpaut SATU schedule); flight arrangement hidup pada peringkat
			// PAKEJ (template trip + override per-pakej).
			const defComps = (links?.default_components || []);
			const defCompRows = defComps.map((r) => `
				<tr>
					<td>${badge(r.component_type, C.gray)}</td>
					<td><strong>${esc(r.trip || r.flight || r.component_item || '-')}</strong></td>
					<td>${esc(r.age_option || 'General')}</td>
					<td>${esc(r.selection_mode || '-')}</td>
					<td>${r.mandatory
						? '<span class="text-danger font-weight-bold">Required</span>'
						: '<span class="text-extra-muted">Optional</span>'}</td>
					<td>${r.qty || 1}</td>
				</tr>`).join('');
			// [Nov 2026] Seksyen BETA — badge (BETA) pada tajuk; butang Edit
			// DEFAULT di hujung KANAN (ml-auto) tanpa kapsyen lain.
			const compCard = card(12, `📦 DEFAULT PRODUCTS & COMPONENTS (${defComps.length})
				<span class="badge badge-warning text-uppercase font-weight-bold"
					style="font-size:10px;letter-spacing:.5px">BETA</span>
				<button class="btn btn-xs btn-primary ml-auto tm-edit-defcomp">Edit Defaults</button>`,
				defComps.length
					? `<div id="tm-dir-comp-scroll" class="overflow-auto">${tmTable(
						['Type', 'Reference', 'For', 'Selection', 'Required', 'Qty'], defCompRows)}</div>`
					: '<p class="text-muted small">No default components — new packages under this trip start empty.</p>');

			// Hierarki ERD: SATU kad gabungan Travel Date + agregat offer
			// (Travel Date ialah doctype sumber; Package Offer dikira sebagai
			// anak). dateList telah dimuatkan di atas (selari payload lain).
			// [Nov 2026] Datatable interaktif (tmDataTable): carian, penapis
			// status, pagination (lalai 10/halaman) + susunan tarikh
			// berlepas. Klik baris → modal maklumat penuh (Open / Quick
			// Edit / tukar status di dalam modal).
			const totalOffers = dateList.reduce((n, d) => n + (d.packages_count || 0), 0);
			const isCruiseTrip = !!(info?.is_a_cruise_trip
				|| dateList.some((d) => d.cruise_schedule));
			// Kod schedule cruise: schedule_code (lingkungan sailing +
			// kod kapal; ganti ship_code|sailing_start — arahan pemilik
			// Nov 2026). Fallback: nama link cruise_schedule.
			const schedChip = (d) => {
				const code = d.schedule_code || d.cruise_schedule || '';
				if (!code)
					return '<span class="text-extra-muted">—</span>';
				return `<span class="badge badge-light text-monospace"
					style="border:1px solid var(--border-color,#e2e2e2)">${esc(code)}</span>`;
			};
			const dateRowHtml = (d) => `
				<tr class="tm-date-row pointer" data-date="${esc(d.name)}"
					title="Click for full detail — Open / Quick Edit / status">
					<td>${esc(webFmtDate(d.departure_date))}</td>
					<td>${esc(webFmtDate(d.return_date))}</td>
					<td>${d.trip_category
						? esc(d.trip_category)
						: '<span class="text-extra-muted">—</span>'}</td>
					<td>${badge(d.status, DEP_COLOR[d.status] || C.gray)}</td>
					<td class="text-center">${d.sold_pax || 0}</td>
					${isCruiseTrip ? `<td>${schedChip(d)}</td>` : ''}
				</tr>`;
			const dateCard = card(12, `🗓️ TRAVEL DATES & OFFERS (${dateList.length} tarikh · ${totalOffers} offers)
				<button class="btn btn-xs btn-primary ml-auto tm-new-date">+ New Travel Date</button>`,
				dateList.length ? '<div id="tm-dates-dt"></div>'
					: '<p class="text-muted small">No travel dates yet — create one.</p>');

			// [Nov 2026] SALES FOR THIS TRIP dipindahkan ke halaman
			// trip/<trip>/sales (load_trip_sales) — panel & wiring dihapus.

			// Nav row peringkat TRIP: balik ke senarai + Delete Trip
			// (butang padam trip berada di SINI — peringkat trip, bukan
			// peringkat tarikh; arahan pemilik Nov 2026).
			// [Nov 2026] #tm-trip-navrow kini HELPER KONGSI (tm_shared.js)
			// — navigasi "same level" serupa dipaparkan pada trip directory,
			// website & sales. Senarai SEMUA trip (utk prev/next + kaunter)
			// — satu panggilan.
			const nav = await fetchTripNav(trip);
			const tripNavRow = tripNavRowHtml(trip, nav);
			// Panel TRIP INFORMATION SELEPAS nav row (arahan pemilik
			// Nov 2026) — nav bar dahulu, kemudian panel info (footer
			// direktori terbina DALAM fungsi kad), kemudian TRAVEL DATES
			// & OFFERS terus selepasnya.
			const tripInfoPanel = tripInfoCardHtml(info, trip);
			$body.html(`${tripNavRow}
				<div style="margin-bottom:10px">${tripInfoPanel}${dateCard}</div>
				<div>
				${compCard}
			</div>`);

			// Wiring nav row kongsi — dateList sudah dimuatkan di atas, jadi
			// kiraan tarikh/offer untuk dialog Delete dihantar terus (tiada
			// panggilan malas tambahan seperti di halaman website/sales).
			wireTripNavRow(trip, nav, { dates: dateList.length, offers: totalOffers });

			$body.find('.tm-edit-defcomp').on('click', () =>
				default_components_dialog(trip, links, () => load_trip_directory(trip)));
			// Datatable TRAVEL DATES — carian/penapis/pagination client-side,
			// susunan tarikh berlepas (server dah asc; sortVal pastikan).
			// footer: true — select "Per page" & pagination hidup dalam
			// card-footer kad (bukan inline bawah jadual; Nov 2026).
			if (dateList.length) {
				tmDataTable('#tm-dates-dt', dateList, {
					footer: true,
					pageSize: 10,
					searchPlaceholder: 'Search departure / schedule…',
					filterLabel: 'All statuses',
					emptyMsg: 'No travel dates match.',
					// Pax — center (header + sel; Nov 2026). Category — master
					// Trip Category (Nov 2026, arahan pemilik).
					headers: isCruiseTrip
						? ['Departure', 'Return', 'Category', 'Status',
							{text: 'Pax', cls: 'text-center'}, 'Cruise Schedule']
						: ['Departure', 'Return', 'Category', 'Status',
							{text: 'Pax', cls: 'text-center'}],
					searchIn: (d) => [d.name, d.travel_date_name, d.departure_date,
						d.return_date, webFmtDate(d.departure_date),
						webFmtDate(d.return_date), d.status, d.ship_name,
						d.schedule_code, d.cruise_schedule,
						d.trip_category].join(' '),
					filterOf: (d) => d.status || '',
					sortVal: (d) => d.departure_date || '',
					rowHtml: dateRowHtml,
				});
			}
			// Travel Date — klik baris → modal maklumat penuh. Delegasi pada
			// $body dengan NAMASPACE (._tmdat) + .off() dahulu — handler
			// lama (load sebelumnya / SPA navigation / onDone reload) mesti
			// dibuang supaya SATU klik = SATU modal (tidak bertindan).
			$body.off('click._tmdat', '#tm-dates-dt .tm-date-row')
				.on('click._tmdat', '#tm-dates-dt .tm-date-row', function (ev) {
					if ($(ev.target).closest('button, a').length) return;
					const row = dateList.find((d) => d.name === $(this).data('date'));
					if (row) travel_date_info_modal(trip, row, () => load_trip_directory(trip));
				});
			$body.find('.tm-new-date').on('click', () =>
				travel_date_dialog(trip, null, () => load_trip_directory(trip)));
		}
