// travel_booking/module_admin_portal/page/travel_manager/travel_manager.js
// TRAVEL MANAGER v3 — DIRECTORY ROUTING (permintaan pengguna):
//   /app/travel-manager            → indeks: senarai trip (kad sahaja)
//   /app/travel-manager/<TRIP>     → DIREKTORI trip itu:
//       PAUTAN PRODUK (cruise schedule / flight arrangement / komponen)
//       PAKEJ · TARIKH PERJALANAN · JUALAN TRIP INI
//
// Hierarki Trip-first; semua operasi melalui API berpagarkan role —
// TIADA akses DocType terus. Kelulusan Active/Retired/Cancelled:
// Tour Manager/System Manager sahaja.

frappe.pages['travel-manager'].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Travel Manager'),
		single_column: true,
	});

	wrapper.querySelector('.page-head').innerHTML = `
		<div class="tm-head">
			<div class="tm-breadcrumb" style="display:flex;align-items:center;gap:10px;
				padding:14px 4px;border-bottom:1px solid #e8e8e8">
				<button class="btn btn-xs btn-default tm-back" style="display:none">← Semua Trip</button>
				<div class="tm-title-wrap">
					<h2 style="margin:0;font-weight:700">Travel Manager</h2>
					<p class="tm-subtitle" style="margin:2px 0 0;color:#666;font-size:12.5px">
						Trip → pautan → pakej → tarikh → jualan.</p>
				</div>
				<button class="btn btn-xs btn-default tm-refresh" style="margin-left:auto">
					Muat Semula</button>
			</div>
			<div class="tm-tabs" style="display:none;gap:6px;padding:10px 4px">
				<button class="btn btn-default tm-tab" data-tab="trips">Trip</button>
				<button class="btn btn-default tm-tab" data-tab="sales">Jualan</button>
				<button class="btn btn-default tm-tab" data-tab="summary">Ringkasan</button>
			</div>
		</div>
		<div class="tm-body" style="padding:6px 4px 40px"></div>
	`;

	window.TravelManager = (function () {
		const $body = $(wrapper).find('.tm-body');
		const $back = $(wrapper).find('.tm-back');
		const $tabs = $(wrapper).find('.tm-tabs');
		const $title = $(wrapper).find('.tm-title-wrap h2');
		const $subtitle = $(wrapper).find('.tm-subtitle');

		const isManager = frappe.user.has_role('Tour Manager') || frappe.user.has_role('System Manager');

		const esc = (v) => frappe.utils.escape_html(v ?? '');
		const api = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.package_admin.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		const tlinks = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.trip_links.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		const hub = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.booking_hub.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		const tcc = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.trip_command_center.' + method, args, quiet: true })
				.then(r => r?.message ?? null);

		const badge = (label, color) =>
			`<span class="badge" style="background:${color}18;color:${color};
				border:1px solid ${color}55;font-weight:600">${esc(label)}</span>`;
		const C = {
			gray: '#6b7280', green: '#15803d', orange: '#b45309', red: '#b91c1c', blue: '#1d4ed8',
		};
		const DEP_COLOR = { Draft: C.gray, 'Pending Review': C.orange, Active: C.green, Retired: C.gray };
		const OPE_COLOR = { Scheduled: C.blue, Running: C.orange, Sailing: C.orange,
			Full: C.red, Closed: C.gray, Completed: C.green };
		const BKG_COLOR = { Pending: C.orange, Accepted: C.blue, Processing: C.blue,
			Confirmed: C.green, Completed: C.green, Abandoned: C.gray, Cancelled: C.red };
		const money = (n) => 'RM ' + parseFloat(n || 0).toLocaleString('en-MY',
			{ minimumFractionDigits: 2, maximumFractionDigits: 2 });

		const state = { view: null, trip: null, tab: 'trips', search: '', sales_status: 'Pending' };

		function set_header(title, subtitle, showBack, showTabs) {
			$title.text(title);
			$subtitle.text(subtitle);
			$back.toggle(!!showBack);
			$tabs.toggle(!!showTabs);
		}

		function handle_route() {
			const route = frappe.get_route() || [];
			const trip = route[1];
			if (trip && trip !== 'travel-manager') {
				show_trip(trip);
			} else {
				show_index();
			}
		}

		function show_index() {
			state.view = 'index';
			state.trip = null;
			set_header('Travel Manager', 'Trip → pautan → pakej → tarikh → jualan.', false, true);
			switch_tab(state.tab || 'trips');
		}

		function show_trip(trip) {
			state.view = 'trip';
			state.trip = trip;
			set_header(trip, 'Direktori trip — pautan, pakej, tarikh & jualan.', true, false);
			load_trip_directory(trip);
		}

		function refresh() {
			if (state.view === 'trip') load_trip_directory(state.trip);
			else if (state.tab === 'trips') load_trips();
			else if (state.tab === 'sales') load_sales();
			else load_summary();
		}

		$back.on('click', () => frappe.set_route('travel-manager'));
		$(wrapper).find('.tm-refresh').on('click', refresh);
		$(wrapper).find('.tm-tab').on('click', function () {
			state.tab = $(this).data('tab');
			$(wrapper).find('.tm-tab').removeClass('btn-primary').addClass('btn-default');
			$(this).addClass('btn-primary').removeClass('btn-default');
			refresh();
		});

		// ════════════ INDEKS: SENARAI TRIP ════════════
		function switch_tab(tab) {
			state.tab = tab;
			$(wrapper).find('.tm-tab').removeClass('btn-primary').addClass('btn-default');
			$(wrapper).find(`.tm-tab[data-tab="${tab}"]`).addClass('btn-primary').removeClass('btn-default');
			refresh();
		}

		async function load_trips() {
			$body.html(`
				<div class="tm-toolbar" style="display:flex;gap:8px;margin-bottom:12px">
					<input class="form-control tm-search" placeholder="Cari trip…"
						value="${esc(state.search)}" style="max-width:280px">
					<span style="margin-left:auto;color:#999;font-size:12px;align-self:center">
						Klik trip untuk buka direktorinya</span>
				</div>
				<div class="tm-trips"><div style="color:#999;padding:30px;text-align:center">
					<div class="spinner-border spinner-border-sm"></div></div></div>
			`);
			$(wrapper).find('.tm-search').on('input', frappe.utils.debounce(function () {
				state.search = $(this).val(); load_trips();
			}, 400));

			const data = await tcc('get_trips_list', { search: state.search, limit: 50 });
			const trips = data?.trips || [];
			const $list = $body.find('.tm-trips').empty();
			if (!trips.length) {
				$list.html('<p style="color:#999;padding:30px;text-align:center">Tiada trip.</p>');
				return;
			}
			trips.forEach((t) => {
				$list.append(`
					<div class="tm-trip panel panel-default" data-trip="${esc(t.name)}"
						style="padding:12px 14px;margin-bottom:8px;cursor:pointer">
						<div style="display:flex;align-items:center;gap:10px">
							<div style="flex:1">
								<div style="font-weight:700">${esc(t.trip_name)}
									${t.is_a_cruise_trip ? badge('🚢 Cruise', C.blue) : badge('✈️ Tour', C.orange)}</div>
								<div style="color:#888;font-size:12px">${esc(t.route || '-')}</div>
							</div>
							<div style="text-align:right">
								${badge(t.status || 'Active', DEP_COLOR[t.status] || C.gray)}
								${badge(t.published ? '🌐 Published' : '📝 Draft', t.published ? C.green : C.gray)}
							</div>
							<div style="text-align:center;min-width:60px">
								<div style="font-weight:700">${t.dates_count || 0}</div>
								<div style="font-size:11px;color:#999">tarikh</div>
							</div>
							<div>
								<button class="btn btn-xs btn-primary tm-open">Buka →</button>
							</div>
						</div>
					</div>
				`);
			});
			$list.find('.tm-trip').on('click', function () {
				frappe.set_route('travel-manager', $(this).data('trip'));
			});
		}

		// ════════════ DIREKTORI TRIP ════════════
		async function load_trip_directory(trip) {
			$body.html('<div style="color:#999;padding:30px;text-align:center">…</div>');
			const [tripCore, links, pkgs, offers, sales] = await Promise.all([
				tcc('get_trips_list', { search: trip, limit: 1 }),
				tlinks('get_trip_links', { trip }),
				api('get_packages_list', { trip, limit: 100 }),
				api('get_offers_list', { trip, upcoming: 0, limit: 200 }),
				hub('get_booking_kanban', { trip }).catch(() => null),
			]);
			const core = (tripCore?.trips || []).find((t) => t.name === trip) || {};
			// tajuk header: nama trip sebenar
			set_header(core.trip_name || trip,
				`Direktori trip — ${links?.packages?.length || 0} pakej · ` +
				`(offers ${offers?.offers?.length || 0})`, true, false);

			$body.html(`
				${render_links_section(links, trip)}
				${render_packages_section(pkgs, trip)}
				${render_dates_section(offers, trip)}
				${render_trip_sales_section(sales, trip)}
			`);
			wire_links_section($body, links, trip);
			wire_packages_section($body, trip);
			wire_dates_section($body, offers, trip);
			wire_trip_sales_section($body, trip);
		}

		// ── SEKSYEN: PAUTAN PRODUK ──
		function render_links_section(links, trip) {
			const c = links?.cruise_schedule;
			const fa = links?.flight_arrangement;
			const cruiseHtml = c ? `
				<div style="margin-bottom:6px">
					<strong>${esc(c.ship_name || c.schedule_code || c.name)}</strong>
					${badge(c.status || '-', C.blue)}
					<span style="color:#888;font-size:12px">
						${esc(c.sail_start || '')} → ${esc(c.sail_end || '')} ·
						${c.total_days || '-'} hari · currency ${esc(c.currency || '-')}</span>
				</div>
				${(c.cabin_rates || []).length ? `
				<table class="table table-condensed" style="margin:0 0 8px;font-size:12px">
					<thead><tr><th>Varian Kabin</th><th style="text-align:right">Harga Dewasa</th>
						<th style="text-align:right">Single</th><th style="text-align:right">Allotment</th>
						<th style="text-align:right">Occupy</th></tr></thead>
					<tbody>
					${c.cabin_rates.map((r) => `
						<tr>
							<td>${esc(r.pricing_for_class || '-')}</td>
							<td style="text-align:right">${money(r.price_adult)}</td>
							<td style="text-align:right">${r.price_adult_single ? money(r.price_adult_single) : '—'}</td>
							<td style="text-align:right">${r.cabin_allotment || 0}</td>
							<td style="text-align:right">${r.cabin_occupancy || 0}</td>
						</tr>`).join('')}
					</tbody>
				</table>` : '<p style="color:#999;font-size:12px">Schedule ini tiada kadar kabin.</p>'}
				<button class="btn btn-xs btn-default tm-pick-schedule">Tukar Schedule</button>
			` : `
				<p style="color:#999;font-size:12.5px;margin-bottom:6px">
					Belum ada cruise schedule dipautkan.</p>
				<button class="btn btn-xs btn-primary tm-pick-schedule">Pautkan Cruise Schedule</button>
			`;

			const faHtml = fa ? `
				<div style="font-size:12.5px;line-height:1.7">
					${badge(fa.flight_mode, C.blue)}
					<strong>${esc(fa.home_airport || '?')}</strong>
					${fa.flight_mode === 'Return' ? ' → ' + esc(fa.final_destination || '?') + ' (return)' : ' (multi-city)'}
					${fa.via_airports?.length ? ' · via ' + esc(fa.via_airports.join(', ')) : ''}
					${fa.preferred_airline ? ' · ' + esc(fa.preferred_airline) : ''}
					${fa.notes ? `<div style="color:#888">${esc(fa.notes)}</div>` : ''}
				</div>
				<button class="btn btn-xs btn-default tm-edit-fa" style="margin-top:4px">Edit</button>
			` : `
				<p style="color:#999;font-size:12.5px;margin-bottom:6px">Belum ada flight arrangement.</p>
				<button class="btn btn-xs btn-primary tm-edit-fa">+ Flight Arrangement</button>
			`;

			const comps = (links?.components || []);
			const compsHtml = comps.length ? `
				<table class="table table-condensed" style="margin:0;font-size:12px">
					<tbody>${comps.slice(0, 12).map((r) => `
						<tr><td style="width:110px">${badge(r.component_type, C.gray)}</td>
						<td>${esc(r.trip || r.flight || r.component_item || '-')}</td>
						<td style="color:#999">${esc(r.selection_mode || '')}${r.mandatory ? '' : ' (optional)'}</td></tr>`).join('')}
					</tbody>
				</table>` : '<p style="color:#999;font-size:12px">Tiada komponen — tambah melalui pakej.</p>';

			return `
				<div class="tm-section" style="border:1px solid #eee;border-radius:8px;
					padding:12px;margin-bottom:10px;background:#fff">
					<div style="font-weight:700;margin-bottom:8px">🔗 PAUTAN PRODUK</div>
					<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
						<div>
							<div style="font-size:12px;color:#666;margin-bottom:4px">
								🚢 CRUISE SCHEDULE (1)</div>
							${cruiseHtml}
						</div>
						<div>
							<div style="font-size:12px;color:#666;margin-bottom:4px">
								✈️ FLIGHT ARRANGEMENT (1)</div>
							${faHtml}
						</div>
					</div>
					<div style="margin-top:10px">
						<div style="font-size:12px;color:#666;margin-bottom:4px">
							📦 PRODUK & KOMPONEN (dari pakej)</div>
						${compsHtml}
					</div>
				</div>`;
		}

		function wire_links_section($container, links, trip) {
			$container.find('.tm-pick-schedule').on('click', function () {
				pick_schedule_dialog(trip, () => load_trip_directory(trip));
			});
			$container.find('.tm-edit-fa').on('click', function () {
				fa_dialog(links?.flight_arrangement, trip, () => load_trip_directory(trip));
			});
		}

		function pick_schedule_dialog(trip, onDone) {
			tlinks('list_schedules').then((schedules) => {
				const d = new frappe.ui.Dialog({ title: 'Pilih Cruise Schedule', size: 'large' });
				const $w = d.$body;
				$w.html(`
					<div class="list-group" style="max-height:420px;overflow:auto">
					${(schedules || []).map((s) => `
						<a href="javascript:void(0)" class="list-group-item tm-pick"
							data-name="${esc(s.name)}">
							<strong>${esc(s.ship_name || s.schedule_code || s.name)}</strong>
							<span style="color:#888;font-size:12px">
								${esc(s.sail_start || '')} → ${esc(s.sail_end || '')} · ${esc(s.status || '')}</span>
							${s.trip_link ? badge('dipaut: ' + s.trip_link, C.orange) : ''}
						</a>`).join('')}
					</div>
				`);
				$w.find('.tm-pick').on('click', function () {
					const schedule = $(this).data('name');
					tlinks('set_trip_cruise_schedule', { trip, schedule }).then(() => {
						frappe.show_alert({ message: 'Cruise schedule dipautkan', indicator: 'green' });
						d.hide();
						onDone && onDone();
					});
				});
				d.show();
			});
		}

		function fa_dialog(fa, trip, onDone) {
			const d = new frappe.ui.Dialog({
				title: 'Flight Arrangement — ' + trip,
				fields: [
					{ fieldname: 'flight_mode', fieldtype: 'Select', label: 'Mode',
						options: 'Return\nMulti-City', default: fa?.flight_mode || 'Return', reqd: 1 },
					{ fieldname: 'home_airport', fieldtype: 'Link', label: 'Home Airport (Departure)',
						options: 'Flight Airport', reqd: 1, default: fa?.home_airport },
					{ fieldname: 'final_destination', fieldtype: 'Link', label: 'Final Destination (Return)',
						options: 'Flight Airport', default: fa?.final_destination },
					{ fieldname: 'via_airports', fieldtype: 'Data',
						label: 'Via (Multi-City, pisah koma)', default: (fa?.via_airports || []).join(', ') },
					{ fieldname: 'preferred_airline', fieldtype: 'Link', label: 'Preferred Airline',
						options: 'Flight Airline', default: fa?.preferred_airline },
					{ fieldname: 'notes', fieldtype: 'Small Text', label: 'Notes', default: fa?.notes },
				],
			});
			d.set_primary_action(__('Simpan'), async () => {
				const v = d.get_values();
				if (!v) return;
				try {
					await tlinks('save_flight_arrangement', { values: JSON.stringify({
						trip,
						flight_mode: v.flight_mode,
						home_airport: v.home_airport,
						final_destination: v.flight_mode === 'Return' ? v.final_destination : '',
						preferred_airline: v.preferred_airline || '',
						notes: v.notes || '',
						via_airports: (v.via_airports || '').split(',').map((s) => s.trim()).filter(Boolean),
					}) });
					frappe.show_alert({ message: 'Flight arrangement disimpan', indicator: 'green' });
					d.hide();
					onDone && onDone();
				} catch (e) { /* frappe dah papar */ }
			});
			d.show();
		}

		// ── SEKSYEN: PAKEJ ──
		function render_packages_section(pkgs, trip) {
			const list = (pkgs?.packages || []);
			return `
				<div class="tm-section" style="border:1px solid #eee;border-radius:8px;
					padding:12px;margin-bottom:10px;background:#fff">
					<div style="display:flex;align-items:center;margin-bottom:8px">
						<div style="font-weight:700;flex:1">📦 PAKEJ (${list.length})</div>
						<button class="btn btn-xs btn-primary tm-new-package">+ Pakej Baharu</button>
					</div>
					${list.length ? `
					<table class="table table-condensed" style="margin:0;font-size:12.5px">
						<thead><tr><th>Pakej</th><th>Template</th><th>Status</th>
							<th>Offer</th><th>Harga dari</th><th></th></tr></thead>
						<tbody>${list.map((p) => `
							<tr data-pkg="${esc(p.name)}">
								<td><strong>${esc(p.package_name)}</strong>
									<span style="color:#999;font-size:11px">${esc(p.name)}</span></td>
								<td>${esc(p.package_template || '-')}</td>
								<td>${badge(p.status, DEP_COLOR[p.status] || C.gray)}</td>
								<td>${p.offer_count || 0}</td>
								<td>${p.min_price ? money(p.min_price) : '—'}</td>
								<td><button class="btn btn-xs btn-default tm-edit-package">Edit</button></td>
							</tr>`).join('')}</tbody>
					</table>` : '<p style="color:#999;font-size:12.5px">Belum ada pakej untuk trip ini.</p>'}
				</div>`;
		}

		function wire_packages_section($container, trip) {
			$container.find('.tm-new-package').on('click', () =>
				package_dialog(null, trip, () => load_trip_directory(trip)));
			$container.find('.tm-edit-package').on('click', function (e) {
				e.stopPropagation();
				package_dialog($(this).closest('tr').data('pkg'), null, () => load_trip_directory(trip));
			});
		}

		function package_dialog(name, tripDefault, onDone) {
			const d = new frappe.ui.Dialog({
				title: name ? 'Edit Pakej: ' + name : 'Pakej Baharu',
				fields: [
					{ fieldname: 'package_name', fieldtype: 'Data', label: 'Nama Pakej', reqd: 1 },
					{ fieldname: 'package_template', fieldtype: 'Select', label: 'Template',
						options: '\nCruise + Flight\nCruise Only\nFly Package\nGround Only\nCustomed' },
					{ fieldname: 'trip', fieldtype: 'Link', label: 'Trip (produk utama)',
						options: 'Trip', default: tripDefault || '', read_only: !!tripDefault },
					{ fieldname: 'default_currency', fieldtype: 'Link', label: 'Currency', options: 'Currency' },
					{ fieldname: 'status', fieldtype: 'Select', label: 'Status',
						options: 'Draft\nPending Review\nActive\nRetired', default: 'Draft',
						description: isManager ? '' : 'Active hanya oleh Tour Manager' },
					{ fieldname: 'package_description', fieldtype: 'Text Editor', label: 'Description' },
				],
			});
			if (name) {
				api('get_package_detail', { package: name }).then((det) => {
					if (!det) return;
					d.set_values({
						package_name: det.package_name,
						package_template: det.package_template || '',
						trip: det.trip,
						default_currency: det.default_currency,
						status: det.status,
						package_description: det.package_description,
					});
				});
			}
			d.set_primary_action(__('Simpan'), async () => {
				const values = d.get_values();
				if (!values) return;
				if (name) values.name = name;
				try {
					await api('save_package', { values: JSON.stringify(values) });
					frappe.show_alert({ message: 'Pakej disimpan', indicator: 'green' });
					d.hide();
					onDone && onDone();
				} catch (e) { /* frappe dah papar */ }
			});
			d.show();
		}

		// ── SEKSYEN: TARIKH PERJALANAN ──
		function render_dates_section(offers, trip) {
			const list = (offers?.offers || []);
			return `
				<div class="tm-section" style="border:1px solid #eee;border-radius:8px;
					padding:12px;margin-bottom:10px;background:#fff">
					<div style="display:flex;align-items:center;margin-bottom:8px">
						<div style="font-weight:700;flex:1">🗓️ TARIKH PERJALANAN (${list.length})</div>
						<button class="btn btn-xs btn-primary tm-new-offer">+ Offer Baharu</button>
					</div>
					${list.length ? `
					<table class="table table-condensed" style="margin:0;font-size:12.5px">
						<thead><tr><th>Berangkat</th><th>Pulang</th><th>Pakej</th>
							<th>Editorial</th><th>Operasional</th><th>Occupy</th><th></th></tr></thead>
						<tbody>${list.map((o) => `
							<tr>
								<td><strong>${esc(o.departure_date || '')}</strong></td>
								<td>${esc(o.return_date || '')}</td>
								<td>${esc(o.package_name || '')}</td>
								<td>${badge(o.status_editorial, DEP_COLOR[o.status_editorial] || C.gray)}</td>
								<td>${badge(o.status_operational, OPE_COLOR[o.status_operational] || C.gray)}</td>
								<td>${o.occupancy_pct != null
									? o.occupancy_pct + '% ' + (o.max_pax ? `(${o.current_pax || 0}/${o.max_pax})` : '')
									: '∞'}</td>
								<td style="white-space:nowrap">
									${isManager && o.status_editorial !== 'Active'
										? `<button class="btn btn-xs btn-success tm-offer-act"
											data-offer="${esc(o.name)}" data-act="Active">Aktif</button>` : ''}
									${isManager && o.status_editorial === 'Active'
										? `<button class="btn btn-xs btn-warning tm-offer-act"
											data-offer="${esc(o.name)}" data-act="Cancelled">Batal</button>` : ''}
								</td>
							</tr>`).join('')}</tbody>
					</table>` : '<p style="color:#999;font-size:12.5px">Belum ada tarikh perjalanan — cipta offer.</p>'}
				</div>`;
		}

		function wire_dates_section($container, offers, trip) {
			$container.find('.tm-new-offer').on('click', function () {
				offer_dialog(trip, () => load_trip_directory(trip));
			});
			$container.find('.tm-offer-act').on('click', function () {
				const offer = $(this).data('offer');
				const act = $(this).data('act');
				frappe.confirm(`Tukar status offer kepada "${act}"?`, async () => {
					try {
						await api('set_offer_status', { offer, status: act });
						frappe.show_alert({ message: 'Status offer dikemas kini', indicator: 'green' });
						load_trip_directory(trip);
					} catch (e) { /* frappe dah papar */ }
				});
			});
		}

		function offer_dialog(trip, onDone) {
			api('get_packages_list', { trip, limit: 100 }).then((pkgs) => {
				const list = pkgs?.packages || [];
				if (!list.length) {
					frappe.msgprint('Cipta pakej dahulu sebelum offer.');
					return;
				}
				const d = new frappe.ui.Dialog({
					title: 'Offer Baharu — ' + trip,
					fields: [
						{ fieldname: 'package', fieldtype: 'Select', label: 'Pakej', reqd: 1,
							options: list.map((p) => p.name).join('\n') },
						{ fieldname: 'departure_date', fieldtype: 'Date', label: 'Departure Date', reqd: 1 },
						{ fieldname: 'return_date', fieldtype: 'Date', label: 'Return Date' },
					],
				});
				d.set_primary_action(__('Cipta'), async () => {
					const v = d.get_values();
					if (!v) return;
					try {
						await api('generate_offer_from_template', {
							package: v.package,
							departure_date: v.departure_date,
							return_date: v.return_date || '',
						});
						frappe.show_alert({ message: 'Offer dicipta (Draft) — harga dari templat', indicator: 'green' });
						d.hide();
						onDone && onDone();
					} catch (e) { /* frappe dah papar */ }
				});
				d.show();
			});
		}

		// ── SEKSYEN: JUALAN TRIP INI ──
		function render_trip_sales_section(sales, trip) {
			const cols = sales?.columns || {};
			let rows = '';
			let shown = 0;
			['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed'].forEach((s) => {
				(cols[s] || []).slice(0, 30).forEach((b) => {
					shown++;
					rows += `
						<tr data-booking="${esc(b.name)}">
							<td><strong>${esc(b.name)}</strong></td>
							<td>${esc(b.customer_name || '')}</td>
							<td>${esc(b.trip_name || '')}</td>
							<td style="text-align:right">${money(b.total_amount)}</td>
							<td>${badge(b.status, BKG_COLOR[b.status] || C.gray)}</td>
							<td style="white-space:nowrap">${next_status_options(b.status)}</td>
						</tr>`;
				});
			});
			return `
				<div class="tm-section" style="border:1px solid #eee;border-radius:8px;
					padding:12px;background:#fff">
					<div style="font-weight:700;margin-bottom:8px">💰 JUALAN TRIP INI (${shown})</div>
					${shown ? `
					<table class="table table-condensed table-hover" style="margin:0;font-size:12.5px">
						<thead><tr><th>Booking</th><th>Customer</th><th>Trip</th>
							<th style="text-align:right">Jumlah</th><th>Status</th><th>Tindakan</th></tr></thead>
						<tbody>${rows}</tbody>
					</table>` : '<p style="color:#999;font-size:12.5px">Tiada booking untuk trip ini.</p>'}
				</div>`;
		}

		function wire_trip_sales_section($container, trip) {
			$container.find('.tm-next').on('click', function () {
				const booking = $(this).closest('tr').data('booking');
				const next = $(this).data('next');
				frappe.confirm(`Tukar status booking ${booking} → "${next}"?`, async () => {
					try {
						await hub('update_booking_status', { booking_name: booking, new_status: next });
						frappe.show_alert({ message: 'Status booking dikemas kini', indicator: 'green' });
						load_trip_directory(trip);
					} catch (err) { /* frappe dah papar */ }
				});
			});
		}

		function next_status_options(status) {
			const flow = {
				Pending: ['Accepted', 'Cancelled'],
				Accepted: ['Processing', 'Cancelled'],
				Processing: ['Confirmed'],
				Confirmed: ['Completed'],
				Completed: [],
			};
			return (flow[status] || []).map((n) =>
				`<button class="btn btn-xs btn-default tm-next" data-next="${n}">→ ${n}</button>`).join(' ')
				|| '<span style="color:#bbb">—</span>';
		}

		// ════════════ INDEKS TAB: JUALAN (semua trip) ════════════
		const SALES_STATUSES = ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed'];

		async function load_sales() {
			$body.html(`
				<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
					${SALES_STATUSES.map((s) =>
						`<button class="btn btn-xs tm-sale ${state.sales_status === s ? 'btn-primary' : 'btn-default'}"
							data-s="${s}">${s}</button>`).join('')}
				</div>
				<div class="tm-sales"><div style="color:#999;padding:30px;text-align:center">
					<div class="spinner-border spinner-border-sm"></div></div></div>
			`);
			$(wrapper).find('.tm-sale').on('click', function () {
				state.sales_status = $(this).data('s'); load_sales();
			});

			const data = await hub('get_booking_kanban', {});
			const $box = $body.find('.tm-sales').empty();
			const cols = data?.columns || {};
			let rows = '';
			let shown = 0;
			SALES_STATUSES.forEach((s) => {
				(cols[s] || []).slice(0, 50).forEach((b) => {
					shown++;
					const match = state.sales_status === s;
					rows += `
						<tr style="${match ? '' : 'opacity:.45'}">
							<td><strong>${esc(b.name)}</strong></td>
							<td>${esc(b.customer_name || '')}</td>
							<td>${esc(b.trip_name || '')}</td>
							<td>${esc(b.departure_date || b.trip_date || '')}</td>
							<td style="text-align:right">${money(b.total_amount)}</td>
							<td>${badge(b.status, BKG_COLOR[b.status] || C.gray)}</td>
							<td style="white-space:nowrap">${next_status_options(b.status)}</td>
						</tr>`;
				});
			});
			$box.html(`
				${shown ? `
				<table class="table table-hover" style="font-size:12.5px;background:#fff">
					<thead><tr><th>Booking</th><th>Customer</th><th>Trip</th>
						<th>Berangkat</th><th style="text-align:right">Jumlah</th>
						<th>Status</th><th>Tindakan</th></tr></thead>
					<tbody>${rows}</tbody>
				</table>` : '<p style="color:#999;padding:30px;text-align:center">Tiada booking.</p>'}
			`);
			$box.find('.tm-next').on('click', function () {
				const booking = $(this).closest('tr').find('td').first().text().trim();
				const next = $(this).data('next');
				frappe.confirm(`Tukar status booking ${booking} → "${next}"?`, async () => {
					try {
						await hub('update_booking_status', { booking_name: booking, new_status: next });
						frappe.show_alert({ message: 'Status booking dikemas kini', indicator: 'green' });
						load_sales();
					} catch (err) { /* frappe dah papar */ }
				});
			});
		}

		// ════════════ INDEKS TAB: RINGKASAN ════════════
		async function load_summary() {
			$body.html('<div style="color:#999;padding:30px;text-align:center">…</div>');
			const [ready, cross] = await Promise.all([
				tcc('get_readiness_summary', {}),
				isManager ? api('cross_check_structure', { limit: 500 }).catch(() => null) : Promise.resolve(null),
			]);
			const s = ready?.summary || { ready: 0, warning: 0, error: 0 };
			const trips = Object.values(ready?.trips || {});
			const problemTrips = trips.filter((t) => t.level === 'error').slice(0, 15);
			$body.html(`
				<div style="display:flex;gap:12px;margin-bottom:16px">
					<div class="panel panel-default" style="flex:1;padding:14px;text-align:center">
						<h2 style="margin:0;color:${C.green}">${s.ready || 0}</h2><div>Ready</div></div>
					<div class="panel panel-default" style="flex:1;padding:14px;text-align:center">
						<h2 style="margin:0;color:${C.orange}">${s.warning || 0}</h2><div>Amaran</div></div>
					<div class="panel panel-default" style="flex:1;padding:14px;text-align:center">
						<h2 style="margin:0;color:${C.red}">${s.error || 0}</h2><div>Tak Ready</div></div>
				</div>
				${cross ? `
				<div class="panel panel-default" style="padding:10px 14px;margin-bottom:16px;font-size:12.5px">
					<strong>Cross-check migrasi:</strong>
					${cross.clean
						? `<span style="color:${C.green}">✔ bersih — 0 drift</span>`
						: `<span style="color:${C.red}">${(cross.price_drifts || []).length} harga, ` +
						  `${(cross.allotment_drifts || []).length} allotment, ` +
						  `${(cross.sold_drifts || []).length} sold</span>`}
					(${cross.offers_checked} offer disemak)
				</div>` : ''}
				${problemTrips.length ? `
					<strong style="font-size:13px">Trip perlu tindakan:</strong>
					<ul style="font-size:12.5px">${problemTrips.map((t) =>
						`<li><a href="/app/travel-manager/${esc(t.trip)}">${esc(t.trip_name)}</a>
							— ${t.error_count} isu (${(t.errors || []).join(', ')})</li>`).join('')}</ul>`
					: `<p style="color:${C.green};font-size:12.5px">✔ Semua trip dalam keadaan baik.</p>`}
			`);
		}

		// ── ROUTING ──
		function handle_route() {
			const route = frappe.get_route() || [];
			const trip = route[1];
			if (trip && trip !== 'travel-manager') {
				show_trip(trip);
			} else {
				show_index();
			}
		}

		return { refresh, handle_route };
	})();

	TravelManager.handle_route();
};

frappe.pages['travel-manager'].on_page_show = function () {
	// route berubah semasa page masih hidup (back/forward) — re-render
	if (window.TravelManager) window.TravelManager.handle_route();
};
