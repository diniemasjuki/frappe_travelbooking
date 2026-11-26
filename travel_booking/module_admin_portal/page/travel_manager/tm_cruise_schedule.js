	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: CRUISE SCHEDULE (tm_cruise_schedule.js)
	   ════════════════════════════════════════════════════════════════════
	   Urusan PENUH Trip Cruise Schedule tanpa akses borang doctype:
	     /cruise-schedule            → senarai (datatable: carian, penapis
	                                   bulan-tahun + port + status, saiz
	                                   halaman, pagination & sortable)
	     /cruise-schedule/<NAME>     → detail (info + kadar kabin +
	                                   travel date/offer dipaut, prev/next)
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, isManager, dsb.) secara
	   terus.
	   API AWAM: load_cruise_schedules() + load_cruise_schedule_detail()
	   (dipanggil oleh router shell).
	   Backend: travel_booking.api.cruise_schedule_admin (csa helper).
	   Komponen: kad/card() stok Bootstrap, jadual tmDataTable() kongsi
	   (carian + penapis + pagination dalam card-footer), dialog borang
	   frappe.ui.Dialog + Link control makeLink() — tiada CSS baharu.
	   ════════════════════════════════════════════════════════════════════ */

		// ── Helper & konstanta seksyen ──
		const csa = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.cruise_schedule_admin.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		// Status = cermin pilihan field Trip Cruise Schedule.status.
		const CS_STATUSES = ['Pending Review', 'Active', 'Running', 'Sailing',
			'Full', 'Closed', 'Completed', 'Cancelled'];
		// Warna badge status — asas OPE_COLOR kongsi + status tambahan.
		const CS_COLOR = Object.assign({}, OPE_COLOR, {
			'Pending Review': C.orange, Active: C.green, Cancelled: C.red,
		});
		// Kebenaran (selari permission doctype): tulis = Manager/Operator,
		// padam = Tour Manager/System Manager sahaja (Operator tiada delete).
		const csCanWrite = isManager || frappe.user.has_role('Tour Operator');
		const csCanDelete = isManager;
		// Baris senarai terkini — rujukan handler delegated (dikemaskini
		// setiap load; handler sendiri HANYA dipasang sekali di bawah).
		let csRows = [];

		// ── Baris jadual senarai (tmDataTable rowHtml) ──
		const csRowHtml = (s) => `
			<tr class="tm-cs-row pointer" data-name="${esc(s.name)}"
				title="Buka detail schedule">
				<td>
					<div class="font-weight-bold text-monospace">${esc(s.schedule_code || s.name)}</div>
					<div class="text-muted text-small">${esc(s.trip_code || s.name)}</div>
				</td>
				<td>
					<div class="font-weight-bold">${esc(s.ship_code || '—')}</div>
					<div class="text-muted text-small">${esc(s.ship_name || '')}</div>
				</td>
				<td class="text-nowrap">${esc(webFmtDate(s.sail_start))} → ${esc(webFmtDate(s.sail_end))}</td>
				<td class="text-nowrap text-muted">${s.total_days || 0}D / ${s.total_nights || 0}N</td>
				<td class="text-nowrap">${esc(s.port_start || '—')} → ${esc(s.port_end || '—')}</td>
				<td>${badge(s.status || '—', CS_COLOR[s.status] || C.gray)}</td>
				<td class="text-center"><strong>${s.cabin_count || 0}</strong>${s.min_price != null
					? `<div class="text-muted text-small">from ${esc(fmtNum(s.min_price))}</div>` : ''}</td>
				<td class="text-center"><strong>${s.dates_count || 0}</strong>
					<div class="text-muted text-small">${s.offers_count || 0} offer</div></td>
				<td class="text-nowrap text-right">
					${csCanWrite ? `<button type="button" class="btn btn-xs btn-default tm-cs-edit"
						data-name="${esc(s.name)}" title="Sunting schedule">✏️</button>` : ''}
					${csCanDelete ? `<button type="button" class="btn btn-xs btn-danger tm-cs-del"
						data-name="${esc(s.name)}" title="Padam schedule">🗑</button>` : ''}
				</td>
			</tr>`;

		// ── Handler delegated (SEKALI sahaja — baris jadual dirender semula
		// oleh pagination/sort tmDataTable, jadi delegasi pada $body) ──
		$body.on('click', '.tm-cs-row', function (e) {
			// Klik butang aksi (✏️/🗑) BUKAN navigasi baris.
			if ($(e.target).closest('button').length) return;
			const name = $(this).data('name');
			if (name) frappe.set_route('travel-manager', 'cruise-schedule', name);
		});
		$body.on('click', '.tm-cs-edit', function (e) {
			e.stopPropagation();
			const row = csRows.find((r) => r.name === $(this).data('name'));
			if (row) cruise_schedule_dialog(row, () => load_cruise_schedules());
		});
		$body.on('click', '.tm-cs-del', function (e) {
			e.stopPropagation();
			const name = $(this).data('name');
			const row = csRows.find((r) => r.name === name);
			cs_delete_dialog(name, row?.schedule_code || name,
				() => load_cruise_schedules());
		});

		// ══════════════ CRUISE SCHEDULE (senarai) ══════════════
		async function load_cruise_schedules() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Cruise Schedule' },
			]);
			$body.html(loading());
			await webFmtLoad();

			const data = await csa('get_cruise_schedules', { limit: 500 });
			csRows = data?.schedules || [];
			const rows = csRows;
			const today = frappe.datetime.get_today();
			const nActive = rows.filter((r) => r.status === 'Active').length;
			const nUpcoming = rows.filter((r) => String(r.sail_end || '') >= today).length;

			$body.html(`
				<div class="d-flex flex-wrap gap-2 align-items-center text-muted mb-3">
					<div class="d-flex gap-2 overflow-auto py-1" aria-label="Ringkasan schedule">
						<span class="text-nowrap"><strong class="text-body">${rows.length}</strong> schedule</span>
						<span class="text-nowrap" style="color:${C.green}"><strong>${nActive}</strong> active</span>
						<span class="text-nowrap" style="color:${C.blue}"><strong>${nUpcoming}</strong> sailing hadapan</span>
					</div>
					<div class="d-flex gap-2 ml-auto">
						${csCanWrite ? `
						<button type="button" class="btn btn-primary btn-sm" id="tm-cs-new">+ New Schedule</button>` : ''}
					</div>
				</div>
				${card(12, `🚢 CRUISE SCHEDULES <span class="text-muted">(${rows.length})</span>`, `
					<div id="tm-cs-dt"></div>`)}
			`);

			// Jadual interaktif kongsi: carian + penapis (bulan-tahun,
			// port mula/pulang, status) + sortable + pagination dalam
			// card-footer (footer: true).
			tmDataTable('#tm-cs-dt', rows, {
				footer: true,
				headers: ['Schedule', 'Ship', 'Sailing', 'Dur.', 'Ports',
					'Status', 'Cabins', 'Linked', ''],
				rowHtml: csRowHtml,
				searchIn: (r) => [r.name, r.schedule_code, r.ship_code,
					r.ship_name, r.trip_code, r.trip_name_cruise_company,
					r.port_start, r.port_end, r.status].join(' '),
				searchPlaceholder: 'Search ship / code / port…',
				emptyMsg: 'No cruise schedules yet. Click "+ New Schedule" to create one.',
				filters: [
					{ key: 'ym', label: 'Month (YYYY-MM)',
						of: (r) => String(r.sail_start || '').slice(0, 7) || '—' },
					{ key: 'port_start', label: 'Start port',
						of: (r) => r.port_start || '—' },
					{ key: 'port_end', label: 'Return port',
						of: (r) => r.port_end || '—' },
					{ key: 'status', label: 'Status', of: (r) => r.status || '—' },
				],
				sortable: [
					{ key: 'code', val: (r) => r.schedule_code || r.name || '' },
					{ key: 'ship', val: (r) => r.ship_code || '' },
					{ key: 'sail', val: (r) => String(r.sail_start || '') },
					{ key: 'days', val: (r) => r.total_days || 0 },
					null,
					{ key: 'status', val: (r) => r.status || '' },
					{ key: 'cabins', val: (r) => r.cabin_count || 0 },
					{ key: 'linked', val: (r) => r.dates_count || 0 },
					null,
				],
				sortVal: (r) => String(r.sail_start || ''),
				pageSize: 10,
				pageSizesLabel: 'Per page',
			});

			$body.find('#tm-cs-new').on('click', () =>
				cruise_schedule_dialog(null, (res) =>
					// Cipta berjaya → terus ke halaman detail schedule baharu
					// (kadar kabin dikemas kini dari sana).
					frappe.set_route('travel-manager', 'cruise-schedule', res.name)));
		}

		// ══════════════ CRUISE SCHEDULE (detail) ══════════════
		async function load_cruise_schedule_detail(name) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Cruise Schedule', route: ['travel-manager', 'cruise-schedule'] },
				{ label: name },
			]);
			$body.html(loading());
			await webFmtLoad();

			let detail = null, listData = null;
			try {
				[detail, listData] = await Promise.all([
					csa('get_cruise_schedule_detail', { schedule: name }),
					// Senarai penuh untuk nav prev/next (null-tolerant).
					csa('get_cruise_schedules', { limit: 500 }).catch(() => null),
				]);
			} catch (e) { /* frappe already shows it */ }
			const s = detail?.schedule;
			if (!s) {
				frappe.show_alert({ message: `Schedule ${name} tidak dijumpai`,
					indicator: 'red' });
				frappe.set_route('travel-manager', 'cruise-schedule');
				return;
			}
			const code = s.schedule_code || name;
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Cruise Schedule', route: ['travel-manager', 'cruise-schedule'] },
				{ label: code },
			]);

			// Nav prev/next — susunan sama seperti senarai (sail_start desc).
			const list = listData?.schedules || [];
			const idx = list.findIndex((x) => x.name === name);
			const prev = idx > 0 ? list[idx - 1] : null;
			const next = (idx >= 0 && idx < list.length - 1) ? list[idx + 1] : null;
			const navRow = `
				<div id="tm-cs-navrow" class="d-flex flex-wrap align-items-center gap-2 mt-5 mb-4">
					<div class="flex-fill min-w-0">
						<button type="button" class="btn btn-default btn-sm" id="tm-cs-back">← All Schedules</button>
					</div>
					<div class="d-flex align-items-center gap-2">
						<button type="button" class="btn btn-default btn-sm" id="tm-cs-prev"
							${prev ? '' : 'disabled'}
							title="${prev ? esc(prev.schedule_code || prev.name) : 'Schedule pertama'}">‹ Prev</button>
						<span class="text-muted text-nowrap text-small">Schedule ${idx + 1} / ${list.length}</span>
						<button type="button" class="btn btn-default btn-sm" id="tm-cs-next"
							${next ? '' : 'disabled'}
							title="${next ? esc(next.schedule_code || next.name) : 'Schedule terakhir'}">Next ›</button>
					</div>
					<div class="d-flex flex-wrap gap-2 flex-fill min-w-0 justify-content-md-end">
						${csCanWrite ? `
						<button type="button" class="btn btn-outline btn-outline-primary btn-sm" id="tm-cs-edit">✏️ Edit Schedule</button>` : ''}
						${csCanDelete ? `
						<button type="button" class="btn btn-danger btn-sm" id="tm-cs-del">🗑 Delete Schedule</button>` : ''}
					</div>
				</div>`;

			// ── Kad SCHEDULE INFORMATION ──
			const infoCard = card(12, `🧭 SCHEDULE INFORMATION
				<span class="ml-auto">${badge(s.status || '—', CS_COLOR[s.status] || C.gray)}</span>`, `
				<div class="row">
					<div class="col-12">
						<h2 class="text-monospace text-truncate mb-2"
							style="font-size:1.15rem" title="${esc(code)}">${esc(code)}</h2>
					</div>
					${field('Schedule ID', `<span class="text-monospace">${esc(s.name)}</span>`, 'col-6 col-md-3', true)}
					${field('Ship', `${esc(s.ship_code || '—')} · ${esc(s.ship_name || '—')}`, 'col-6 col-md-3', true)}
					${field('Cruise Line', esc(s.cruise_line_company || '—'), 'col-6 col-md-3', true)}
					${field('Currency', esc(s.currency || '—'), 'col-6 col-md-3', true)}
					${field('Sailing', `${esc(webFmtDate(s.sail_start))} → ${esc(webFmtDate(s.sail_end))}`, 'col-12 col-md-6', true)}
					${field('Duration', `${s.total_days || 0} days / ${s.total_nights || 0} nights`, 'col-6 col-md-3', true)}
					${field('Created', esc(webFmtDate(String(s.creation || '').slice(0, 10))), 'col-6 col-md-3', true)}
					${field('Route', `${esc(s.port_start || '—')} → ${esc(s.port_end || '—')}`, 'col-12 col-md-6', true)}
					${field('Trip Code', esc(s.trip_code || '—'), 'col-6 col-md-3', true)}
					${field('Active Reservations', String(detail.reservations || 0), 'col-6 col-md-3', true)}
					${s.trip_name_cruise_company
						? field('Trip Name (Cruise Co.)', esc(s.trip_name_cruise_company), 'col-12', true) : ''}
				</div>`);

			// ── Kad CABIN RATES ──
			const rates = detail.cabin_rates || [];
			const ratesRows = rates.map((r) => `
				<tr>
					<td class="font-weight-bold">${esc(r.pricing_for_class || '—')}</td>
					<td class="text-right">${esc(fmtNum(r.price_adult))}</td>
					<td class="text-right">${esc(fmtNum(r.price_adult_single))}</td>
					<td class="text-right">${esc(fmtNum(r.price_upperberth))}</td>
					<td class="text-right">${esc(fmtNum(r.price_children))}</td>
					<td class="text-right">${esc(fmtNum(r.price_toddler))}</td>
					<td class="text-right">${esc(fmtNum(r.price_infant))}</td>
					<td class="text-right">${r.cabin_allotment ? esc(r.cabin_allotment) : '—'}</td>
					<td class="text-right">${esc(r.cabin_occupancy ?? 0)}</td>
					<td class="text-right">${r.cabin_available != null ? esc(r.cabin_available) : '—'}</td>
				</tr>`).join('');
			const ratesCard = card(12, `💰 CABIN RATES <span class="text-muted">(${rates.length})</span>
				${csCanWrite ? `
				<button type="button" class="btn btn-outline btn-outline-primary btn-sm ml-auto"
					id="tm-cs-edit-rates">✎ Edit Rates</button>` : ''}`, `
				<div class="table-responsive">
				${tmTable(['Class', 'Adult', 'Single', 'Upper', 'Children',
					'Toddler', 'Infant', 'Allotment', 'Occupancy', 'Available'],
					ratesRows, 'No cabin rates yet. Click "Edit Rates" to add pricing & allotment.')}
				</div>`);

			// ── Kad LINKED TRAVEL DATES (klik → halaman tarikh trip) ──
			const dates = detail.travel_dates || [];
			const datesCard = card(12, `📅 LINKED TRAVEL DATES <span class="text-muted">(${dates.length})</span>`, `
				<div class="table-responsive">
				${tmTable(['Travel Date', 'Trip', 'Departure → Return', 'Status'],
					dates.map((d) => `
						<tr class="tm-cs-td pointer" data-trip="${esc(d.trip)}" data-td="${esc(d.name)}"
							title="Buka halaman travel date">
							<td class="font-weight-bold">${esc(d.name)}</td>
							<td>${esc(d.trip || '—')}</td>
							<td class="text-nowrap">${esc(webFmtDate(d.departure_date))} → ${esc(webFmtDate(d.return_date))}</td>
							<td>${badge(d.status_editorial || '—',
								OPE_COLOR[d.status_editorial] || DEP_COLOR[d.status_editorial] || C.gray)}</td>
						</tr>`).join(''),
					'No travel dates linked to this schedule.')}
				</div>`);

			// ── Kad PACKAGE OFFERS (klik → halaman offer) ──
			const offers = detail.offers || [];
			const offersCard = card(12, `📦 PACKAGE OFFERS <span class="text-muted">(${offers.length})</span>`, `
				<div class="table-responsive">
				${tmTable(['Offer', 'Travel Date', 'Trip', 'Status'],
					offers.map((o) => `
						<tr class="tm-cs-offer pointer" data-trip="${esc(o.trip)}"
							data-td="${esc(o.travel_date)}" data-offer="${esc(o.name)}"
							title="Buka halaman offer">
							<td class="font-weight-bold">${esc(o.offer_name || o.name)}</td>
							<td>${esc(o.travel_date || '—')}</td>
							<td>${esc(o.trip || '—')}</td>
							<td>${badge(o.status_editorial || '—',
								OPE_COLOR[o.status_editorial] || DEP_COLOR[o.status_editorial] || C.gray)}</td>
						</tr>`).join(''),
					'No package offers sharing this schedule.')}
				</div>`);

			$body.html(navRow + infoCard + ratesCard + datesCard + offersCard);

			// ── Pendawaian butang halaman (elemen segar — direct binding) ──
			$body.find('#tm-cs-back').on('click', () =>
				frappe.set_route('travel-manager', 'cruise-schedule'));
			if (prev) $body.find('#tm-cs-prev').on('click', () =>
				frappe.set_route('travel-manager', 'cruise-schedule', prev.name));
			if (next) $body.find('#tm-cs-next').on('click', () =>
				frappe.set_route('travel-manager', 'cruise-schedule', next.name));
			$body.find('#tm-cs-edit').on('click', () =>
				cruise_schedule_dialog(s, () => load_cruise_schedule_detail(name)));
			$body.find('#tm-cs-del').on('click', () =>
				cs_delete_dialog(name, code,
					() => frappe.set_route('travel-manager', 'cruise-schedule')));
			$body.find('#tm-cs-edit-rates').on('click', () =>
				cruise_rates_dialog(name, code, rates,
					() => load_cruise_schedule_detail(name)));
			$body.find('.tm-cs-td').on('click', function () {
				frappe.set_route('travel-manager', 'trip',
					$(this).data('trip'), 'date', $(this).data('td'));
			});
			$body.find('.tm-cs-offer').on('click', function () {
				frappe.set_route('travel-manager', 'trip', $(this).data('trip'),
					'date', $(this).data('td'), 'pkg', $(this).data('offer'));
			});
		}

		// ══════════════ DIALOG TAMBAH / SUNTING SCHEDULE ══════════════
		// existing = baris senarai ATAU rekod detail (edit); null = cipta.
		// Semua medan doctype utama ada di sini; kadar kabin diurus
		// berasingan (cruise_rates_dialog) supaya dialog kekal ringkas.
		function cruise_schedule_dialog(existing, onDone) {
			const isEdit = !!existing?.name;
			const d = new frappe.ui.Dialog({
				title: isEdit
					? `✏️ Edit Cruise Schedule — ${existing.name}`
					: '🚢 New Cruise Schedule',
				fields: [
					{ fieldname: 'ship_code', fieldtype: 'Select', label: 'Ship Code',
						reqd: 1, options: 'AC01\nHV01',
						default: existing?.ship_code || 'AC01',
						description: 'Kod kapal — asas siri nama rekod (.ship_code.YY.#).' },
					{ fieldname: 'ship_name', fieldtype: 'Data', label: 'Ship Name',
						default: existing?.ship_name || 'Aroya' },
					{ fieldname: 'cruise_line_company', fieldtype: 'Link',
						label: 'Cruise Line Company', options: 'Trip Organizer',
						default: existing?.cruise_line_company || 'Aroya Cruise',
						// [FIX] filters format OBJEK BIASA {field: value} — format
						// senarai [[doctype, field, op, value]] dipecahkan oleh
						// set_custom_query build ini ($.extend ke atas {} menjadikan
						// {"0": [...]}) → 417 "Field not found: Trip Organizer.0".
						filters: { is_a_cruise_line: 1 } },
					{ fieldname: 'sail_start', fieldtype: 'Date', label: 'Sailing Start',
						reqd: 1, default: existing?.sail_start },
					{ fieldname: 'sail_end', fieldtype: 'Date', label: 'Sailing End',
						reqd: 1, default: existing?.sail_end },
					{ fieldname: 'total_days', fieldtype: 'Int', label: 'Days',
						default: existing?.total_days,
						description: 'Kosong = dikira automatik daripada tarikh pelayaran.' },
					{ fieldname: 'total_nights', fieldtype: 'Int', label: 'Nights',
						default: existing?.total_nights,
						description: 'Kosong = dikira automatik daripada tarikh pelayaran.' },
					{ fieldname: 'port_start', fieldtype: 'Link', label: 'Start Port',
						options: 'Trip Destination Point', reqd: 1,
						default: existing?.port_start },
					{ fieldname: 'port_end', fieldtype: 'Link', label: 'Return Port',
						options: 'Trip Destination Point', reqd: 1,
						default: existing?.port_end },
					{ fieldname: 'status', fieldtype: 'Select', label: 'Status',
						options: CS_STATUSES.join('\n'),
						default: existing?.status || 'Pending Review',
						description: 'Active = open for booking. Schedule Active mesti terkait ≥1 Package Offer aktif (diperiksa semasa simpan).' },
					{ fieldname: 'trip_code', fieldtype: 'Data',
						label: 'Trip Code (by cruise company)',
						default: existing?.trip_code },
					{ fieldname: 'trip_name_cruise_company', fieldtype: 'Data',
						label: 'Trip Name (by cruise company)',
						default: existing?.trip_name_cruise_company },
					{ fieldname: 'currency', fieldtype: 'Link', label: 'Currency',
						options: 'Currency', default: existing?.currency || 'MYR' },
				],
				primary_action_label: isEdit ? '💾 Simpan' : '🚢 Cipta Schedule',
				primary_action: (values) => {
					// Pantas gagal: tarikh hujung mesti selepas mula (server
					// juga mengesahkan — ini elak satu pusingan).
					if (values.sail_start && values.sail_end
							&& values.sail_end < values.sail_start) {
						frappe.msgprint('Sailing End mesti sama atau selepas Sailing Start.');
						return;
					}
					const $btn = d.get_primary_btn().prop('disabled', true);
					csa('save_cruise_schedule', {
						values: JSON.stringify({ name: existing?.name || '', ...values }),
					}).then((res) => {
						d.hide();
						frappe.show_alert({
							message: `Schedule ${res.name} ${isEdit ? 'disimpan' : 'dicipta'}`,
							indicator: 'green',
						});
						if (onDone) onDone(res);
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.show();
		}

		// ══════════════ DIALOG KADAR KABIN (cabin_rates) ══════════════
		// Grid ringkas: kelas (Link autocomplete Trip Price Category) +
		// 6 kolum harga + allotment; tambah/buang baris sebelum simpan.
		// occupancy/availability dikira semula automatik oleh hook server.
		function cruise_rates_dialog(scheduleName, code, existingRates, onDone) {
			const rates = (existingRates || []).map((r) => ({
				pricing_for_class: r.pricing_for_class || '',
				price_adult: r.price_adult ?? null,
				price_adult_single: r.price_adult_single ?? null,
				price_upperberth: r.price_upperberth ?? null,
				price_children: r.price_children ?? null,
				price_toddler: r.price_toddler ?? null,
				price_infant: r.price_infant ?? null,
				cabin_allotment: r.cabin_allotment ?? null,
			}));
			// Kolum harga — selari grid PRICE MATRIX wizard/offer admin.
			const PCOLS = [
				['price_adult', 'Adult'], ['price_adult_single', 'Single'],
				['price_upperberth', 'Upper'], ['price_children', 'Children'],
				['price_toddler', 'Toddler'], ['price_infant', 'Infant'],
			];
			const d = new frappe.ui.Dialog({
				title: `💰 Cabin Rates — ${code}`,
				primary_action_label: '💾 Simpan Rates',
				primary_action: () => {
					// Baris tanpa Class tidak bermakna (server buang senyap) —
					// halang di sini dengan mesej jelas supaya tiada kadar
					// hilang tanpa sedar.
					const emptyClass = rates.filter((r) => !r.pricing_for_class).length;
					if (emptyClass) {
						frappe.msgprint(`${emptyClass} baris kadar belum ada <strong>Class</strong> —
							isi kelas kabin (atau buang baris berkenaan) sebelum simpan.`);
						return;
					}
					const clean = rates.filter((r) => r.pricing_for_class).map((r) => ({
						pricing_for_class: r.pricing_for_class,
						price_adult: r.price_adult, price_adult_single: r.price_adult_single,
						price_upperberth: r.price_upperberth, price_children: r.price_children,
						price_toddler: r.price_toddler, price_infant: r.price_infant,
						cabin_allotment: r.cabin_allotment,
					}));
					const $btn = d.get_primary_btn().prop('disabled', true);
					csa('save_cruise_schedule', {
						values: JSON.stringify({ name: scheduleName, cabin_rates: clean }),
					}).then(() => {
						d.hide();
						frappe.show_alert({ message: 'Cabin rates disimpan',
							indicator: 'green' });
						if (onDone) onDone();
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.$wrapper.find('.modal-dialog').addClass('modal-lg');
			// [FIX] Wrapper jadual BUKAN .table-responsive — overflow:auto
			// memotong dropdown carian kelas (awesomplete ul position:absolute)
			// sehingga hasil carian "tenggelam" di bawah jadual. .tm-csr-wrap
			// (travel_manager.css) kekal overflow:visible. tm-dim-modal juga
			// TIDAK dipakai (max-height modal-body memotong senarai walaupun
			// ada ruang skrin bawah modal) — dialog biar tumbuh ikut kandungan.
			d.$body.html(`
				<p class="text-muted small mb-2">Kadar &amp; allotment kabin bagi sailing ini.
					Kelas = <strong>Trip Price Category</strong>. Occupancy &amp; availability
					dikira semula automatik selepas simpan.</p>
				<div class="tm-csr-wrap">
					<table class="table table-sm mb-0">
						<thead><tr>
							<th>Class</th>
							${PCOLS.map(([, l]) => `<th class="text-right">${l}</th>`).join('')}
							<th class="text-right">Allotment</th>
							<th></th>
						</tr></thead>
						<tbody id="tm-csr-rows"></tbody>
					</table>
				</div>
				<button type="button" class="btn btn-outline btn-outline-primary btn-sm mt-2"
					id="tm-csr-add">+ Add Cabin Rate</button>
			`);
			// [FIX] Dropdown carian kelas TERAPUNG: bila ruang BAWAH input
			// tidak cukup hingga ke MATA skrin (baris akhir jadual / senarai
			// cadangan panjang) DAN ruang DI ATAS input cukup untuk seluruh
			// senarai, ia dibalik TERBUKA KE ATAS (kelas .tm-csr-flip).
			// Pengukuran ikut VIEWPORT (bukan kotak modal-body) — tanpa
			// container overflow, sempadan sebenar ialah skrin. Observer
			// atas <ul> mengukur semula setiap kali awesomplete mengisi item
			// (keputusan carian datang secara async dari server).
			const flipClassDropdown = (inputEl) => {
				const ul = inputEl.closest('.awesomplete')?.querySelector('ul');
				if (!ul || !ul.children.length) return;
				ul.classList.remove('tm-csr-flip');
				const ub = ul.getBoundingClientRect();
				const ib = inputEl.getBoundingClientRect();
				const fitsBelow = ub.bottom <= window.innerHeight - 8;
				const fitsAbove = ib.top >= ub.height + 16;
				if (!fitsBelow && fitsAbove) ul.classList.add('tm-csr-flip');
			};
			const watchClassDropdown = (inputEl) => {
				const ul = inputEl.closest('.awesomplete')?.querySelector('ul');
				if (!ul) return;
				new MutationObserver(() => flipClassDropdown(inputEl))
					.observe(ul, { childList: true });
			};
			// Render baris + kawalan Link kelas (dibina semula setiap render;
			// nilai input harga disimpan dulu ke state `rates` melalui
			// delegated input handler supaya tidak hilang).
			const renderRows = () => {
				const $rows = d.$body.find('#tm-csr-rows');
				$rows.html(rates.length ? rates.map((r, i) => `
					<tr data-i="${i}">
						<td style="min-width:170px"><div class="tm-csr-class"></div></td>
						${PCOLS.map(([f]) => `
						<td><input type="number" step="0.01" min="0"
							class="form-control form-control-sm tm-csr-num"
							data-i="${i}" data-f="${f}" value="${r[f] ?? ''}"></td>`).join('')}
						<td><input type="number" step="1" min="0"
							class="form-control form-control-sm tm-csr-num"
							data-i="${i}" data-f="cabin_allotment" value="${r.cabin_allotment ?? ''}"></td>
						<td><button type="button" class="btn btn-xs btn-danger tm-csr-del"
							data-i="${i}" title="Buang baris">✕</button></td>
					</tr>`).join('')
					: '<tr><td colspan="9" class="text-muted small py-2">Tiada baris — klik "+ Add Cabin Rate".</td></tr>');
				$rows.find('tr[data-i]').each(function () {
					const i = parseInt($(this).attr('data-i'), 10);
					const ctrl = makeLink($(this).find('.tm-csr-class'), {
						fieldname: 'pricing_for_class',
						doctype: 'Trip Price Category',
						value: rates[i].pricing_for_class || '',
						set: (v) => { rates[i].pricing_for_class = v; },
						small: true,
					});
					if (ctrl?.$input?.[0]) watchClassDropdown(ctrl.$input[0]);
				});
			};
			d.$body.on('input', '.tm-csr-num', function () {
				const i = parseInt($(this).attr('data-i'), 10);
				const f = $(this).attr('data-f');
				const v = String(this.value).trim();
				rates[i][f] = v === '' ? null : parseFloat(v);
			});
			d.$body.on('click', '.tm-csr-del', function () {
				rates.splice(parseInt($(this).attr('data-i'), 10), 1);
				renderRows();
			});
			d.$body.find('#tm-csr-add').on('click', () => {
				rates.push({ pricing_for_class: '', price_adult: null,
					price_adult_single: null, price_upperberth: null,
					price_children: null, price_toddler: null, price_infant: null,
					cabin_allotment: null });
				renderRows();
			});
			renderRows();
			d.show();
		}

		// ══════════════ DIALOG PADAM SCHEDULE ══════════════
		// Corak trip: taip nama penuh untuk sahkan. Server menyekat
		// pemadaman bila masih dipaut (reservasi aktif / travel date /
		// offer / rooming) — mesej rujukan dipaparkan frappe.
		function cs_delete_dialog(schedule, code, onDone) {
			frappe.prompt(
				[{
					fieldname: 'confirm_name', fieldtype: 'Data', reqd: 1,
					label: `Taip <strong>${esc(schedule)}</strong> untuk sahkan pemadaman`,
					description: `Schedule <strong>${esc(code)}</strong> akan dipadam
						selama-lamanya berserta kadar kabinnya. Pemadaman DISEKAT
						bila schedule masih dipautkan travel date / offer /
						reservasi aktif — mesej sistem akan menyenaraikannya.`,
				}],
				(values) => {
					if ((values.confirm_name || '').trim() !== schedule) {
						frappe.msgprint('Nama schedule tidak sepadan — pemadaman dibatalkan.');
						return;
					}
					csa('delete_cruise_schedule', { schedule }).then(() => {
						frappe.show_alert({ message: `Schedule ${schedule} dipadam`,
							indicator: 'red' });
						if (onDone) onDone();
					}).catch(() => { /* frappe already shows it */ });
				},
				__('🗑 Delete Cruise Schedule — tidak boleh dibatalkan'),
			);
		}
