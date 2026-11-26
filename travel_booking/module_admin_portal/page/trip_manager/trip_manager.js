// travel_booking/module_admin_portal/page/trip_manager/trip_manager.js
// Desk Page /app/trip-manager — ROUTED app page (deeper directories,
// bukan tab dalam satu page):
//
//   /app/trip-manager                    → landing hub (kad navigasi)
//   /app/trip-manager/trips              → senarai trip
//   /app/trip-manager/trip/<name>        → ONE-STOP CENTER trip
//                                          (TGD + pakej + BOM + linkage)
//   /app/trip-manager/flight-schedules   → set PNR per tarikh + yatim
//   /app/trip-manager/cruise-schedules   → pelayaran + kabin & allotment
//   /app/trip-manager/extras             → addon/excursion/activity
//
// Read-only listing — semua edit lompat ke Desk form standard.

frappe.pages['trip-manager'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Trip Manager'),
		single_column: true,
	});
	TripManagerApp.init(page, wrapper);
};

frappe.pages['trip-manager'].on_page_show = function () {
	// DEFERRED: frappe.get_route() boleh masih nilai lama seketika
	// selepas sub-route navigation — beri masa router settle dulu.
	if (window.TripManagerApp) TripManagerApp.routeDeferred();
};

window.TripManagerApp = (function () {
	'use strict';

	let page = null;
	let $container = null;
	const API = 'travel_booking.api.trip_manager_page';
	const state = { search: {} };

	function init(p, wrapper) {
		page = p;
		$container = $(wrapper).find('.layout-main-section');
		$container.html('<div class="tm-app"></div>');
		route();
		// Navigasi sub-route DALAM page sama: Frappe v17 desk guna
		// pushState (bukan location.hash), dan on_page_show/'show' event
		// boleh tercetus dengan frappe.get_route() masih nilai LAMA
		// (race). Penyelesaian: dengar popstate (pushState tak
		// men-trigger ia secara native — tapi Frappe router akan
		// men-trigger show event) + DEFER render bila route berubah:
		// on_page_show selalu render semula selepas route settle.
		$(window).off('popstate.tm').on('popstate.tm', function () {
			renderRouteDeferred();
		});
	}

	/* ═══ ROUTER ═══ */
	// Baca sub-path melalui frappe.get_route() — sumber route desk
	// (pushState). Boleh berlalu nilai lama sekejap selepas set_route —
	// semua render dari luar (on_page_show/popstate) guna versi DEFERRED
	// supaya baca selepas router selesai mengemas kini.
	function currentSubPath() {
		const parts = (frappe.get_route() || []).slice(1);
		return parts.join('/');
	}

	function route() {
		renderPath(currentSubPath());
	}

	// Render tertunda — baca route SELEPAS microtask + timeout pendek,
	// memberi masa router Frappe mengemas kini nilai route semasa.
	function renderRouteDeferred() {
		Promise.resolve().then(() => setTimeout(() => route(), 30));
	}

	function go(path) {
		// set_route (pushState + trigger show event). Render ditangani
		// oleh on_page_show → renderRouteDeferred. Fallback: jika show
		// event tak datang (kes jarang), render dari path diketahui.
		frappe.set_route('trip-manager', path);
		setTimeout(function () {
			if (currentSubPath() !== path) renderPath(path);
		}, 250);
	}

	// Render ikut path RELATIF ('trips', 'trip/NAME', ...) — dipisah
	// daripada route() supaya go() tak bergantung pada kemas kini hash.
	function renderPath(path) {
		const parts = String(path || '').split('/').filter(Boolean);
		const sub = parts[0] || '';
		if (!sub) renderLanding();
		else if (sub === 'trips') renderTrips();
		else if (sub === 'trip' && parts[1]) renderTripWorkspace(decodeURIComponent(parts[1]));
		else if (sub === 'flight-schedules') renderFlights();
		else if (sub === 'cruise-schedules') renderCruise();
		else if (sub === 'extras') renderExtras();
		else if (sub === 'website') renderWebsite();
		else renderLanding();
	}

	/* ═══ Sub-nav (semua route kecuali landing) ═══ */
	function subnav(active) {
		const items = [
			['trips', __('Trips'), 'ti-world'],
			['flight-schedules', __('Flight Schedules'), 'ti-plane'],
			['cruise-schedules', __('Cruise Schedules'), 'ti-ship'],
			['extras', __('Extras / Addons'), 'ti-basket'],
			['website', __('Website'), 'ti-world-www'],
		];
		return `<div class="tm-subnav">` + items.map(([key, label, icon]) =>
			`<button class="tm-subnav-item ${key === active ? 'tm-subnav-active' : ''}"
			          data-go="${key}"><i class="ti ${icon}"></i>${label}</button>`
		).join('') + `</div>`;
	}

	function toolbar(newLabel, newDoctype) {
		return `<div class="tm-toolbar">
			<input class="tm-search form-control input-sm"
			       placeholder="${__('Search')}..."
			       value="${frappe.utils.escape_html(state.search[newDoctype] || '')}"
			       data-search="${newDoctype}">
			<button class="btn btn-primary btn-sm" data-new-doc="${newDoctype}">
				${__('New')} ${__(newLabel)}
			</button>
		</div>`;
	}

	function bindCommon(scope, tabKey, newDoctype, loader) {
		scope.find('[data-go]').off('click').on('click', function () {
			go($(this).data('go'));
		});
		scope.find('[data-new-doc]').off('click').on('click', function () {
			frappe.set_route('Form', $(this).data('new-doc'), 'new');
		});
		const $s = scope.find('.tm-search');
		$s.on('keydown', function (e) {
			if (e.key === 'Enter') loader(true);
		}).on('blur', function () { loader(true); });
		scope.find('[data-doctype][data-name]').off('click').on('click', function () {
			const $el = $(this);
			frappe.set_route('Form', $el.data('doctype'), $el.data('name'));
		});
	}

	function loading() {
		return `<div class="text-muted" style="padding:24px;">${__('Loading')}…</div>`;
	}
	function empty_(msg) {
		return `<div class="text-muted" style="padding:24px;">${msg}</div>`;
	}

	/* ═══ LANDING HUB ═══ */
	function renderLanding() {
		page.set_title(__('Trip Manager'));
		const $app = $container.find('.tm-app');
		$app.html(loading());
		frappe.call({ method: `${API}.get_overview_counts` }).then(r => {
			const c = r.message || {};
			const cards = [
				['trips', 'ti-world', __('Trips'), __('Manage trips, dates, packages & composition'),
					[[__('Trips'), c.trips], [__('Trip Dates'), c.trip_dates]]],
				['flight-schedules', 'ti-plane', __('Flight Schedules'), __('PNR sets per trip date'),
					[[__('Schedules'), c.flight_schedules], [__('PNRs'), c.flights_total],
					 [__('Unassigned'), c.flights_orphan]]],
				['cruise-schedules', 'ti-ship', __('Cruise Schedules'), __('Sailings, cabin classes & allotment'),
					[[__('Schedules'), c.cruise_schedules]]],
				['extras', 'ti-basket', __('Extras / Addons'), __('Activities, excursions, transfers for sale'),
					[[__('Extras'), c.extras], [__('Packages'), c.extra_packages]]],
			];
			$app.html(`
				<div class="tm-landing">
					<div class="tm-landing-grid">
						${cards.map(([key, icon, title, desc, stats]) => `
							<div class="tm-landing-card" data-go="${key}">
								<div class="tm-landing-icon"><i class="ti ${icon}"></i></div>
								<div class="tm-landing-body">
									<div class="tm-landing-title">${title}</div>
									<div class="tm-landing-desc">${desc}</div>
									<div class="tm-landing-stats">
										${stats.map(([l, n]) => `<span class="tm-chip">${l}: <b>${n || 0}</b></span>`).join('')}
									</div>
								</div>
								<i class="ti ti-chevron-right tm-landing-arrow"></i>
							</div>`).join('')}
					</div>
				</div>`);
			bindCommon($app, null, null, () => {});
		});
	}

	/* ═══ ROUTE: /trips ═══ */
	function renderTrips() {
		page.set_title(__('Trips') + ' — ' + __('Trip Manager'));
		const $app = $container.find('.tm-app');
		$app.html(subnav('trips') + toolbar('Trip', 'Trip') + `<div class="tm-body">${loading()}</div>`);
		bindCommon($app, 'trips', 'Trip', force => loadTrips(force));
		loadTrips();
	}

	function loadTrips(force) {
		const $body = $container.find('.tm-body');
		frappe.call({
			method: `${API}.get_trips_overview`,
			args: { search: state.search['Trip'] || '', limit: 50 },
		}).then(r => {
			const d = r.message || { trips: [] };
			if (!d.trips.length) {
				$body.html(empty_('No trips found'));
				return;
			}
			$body.html(d.trips.map(t => `
				<div class="tm-card tm-trip-row">
					<div class="tm-card-head">
						<div>
							<a class="tm-card-title tm-trip-link" data-trip="${frappe.utils.escape_html(t.name)}">
								${frappe.utils.escape_html(t.trip_name || t.name)}
							</a>
							<div class="tm-card-sub">
								${t.is_a_cruise_trip ? '<span class="tm-badge tm-badge-cruise">Cruise</span>' : '<span class="tm-badge tm-badge-tour">Tour</span>'}
								<span class="tm-badge ${t.status === 'Active' ? 'tm-badge-active' : ''}">${frappe.utils.escape_html(t.status || '')}</span>
							</div>
						</div>
						<div class="tm-chips">
							${chip('Dates', t.tgd_count)}
							${chip('Packages', t.active_pkgs)}
							${chip('Cruise Sched', t.cruise_scheds)}
							${chip('Flight Sched', t.flight_scheds)}
							${chip('BOM', t.bom_rows)}
						</div>
					</div>
					<div class="tm-trip-actions">
						<button class="btn btn-default btn-xs tm-trip-link" data-trip="${frappe.utils.escape_html(t.name)}">
							${__('Open Workspace')} <i class="ti ti-arrow-right"></i>
						</button>
					</div>
				</div>`).join(''));
			$body.find('.tm-trip-link').off('click').on('click', function () {
				go('trip/' + encodeURIComponent($(this).data('trip')));
			});
		});
	}

	/* ═══ ROUTE: /trip/<name> — ONE-STOP CENTER ═══ */
	function renderTripWorkspace(tripName) {
		const $app = $container.find('.tm-app');
		$app.html(loading());
		frappe.call({
			method: `${API}.get_trip_workspace`,
			args: { trip_name: tripName },
		}).then(r => {
			const d = r.message;
			const t = d.trip;
			page.set_title(t.trip_name || tripName);

			$app.html(`
				<div class="tm-subnav-withback">
					<button class="btn btn-default btn-xs tm-back" data-go="trips">
						<i class="ti ti-arrow-left"></i> ${__('All Trips')}
					</button>
					${subnav('trips')}
				</div>
				<div class="tm-ws">
					<div class="tm-ws-head">
						<div>
							<div class="tm-ws-title">
								${frappe.utils.escape_html(t.trip_name || tripName)}
								${t.is_a_cruise_trip ? '<span class="tm-badge tm-badge-cruise">Cruise</span>' : '<span class="tm-badge tm-badge-tour">Tour</span>'}
								<span class="tm-badge ${t.status === 'Active' ? 'tm-badge-active' : ''}">${frappe.utils.escape_html(t.status || '')}</span>
							</div>
							<div class="tm-card-sub">
								${chip('Trip Dates', d.tgd.length)}
								${chip('Packages', d.packages.length)}
							</div>
						</div>
						<div>
							<button class="btn btn-default btn-sm" data-edit-trip="${frappe.utils.escape_html(tripName)}">
								${__('Edit Trip')}
							</button>
							<button class="btn btn-default btn-sm" data-edit-content="${frappe.utils.escape_html(tripName)}">
								<i class="ti ti-photo"></i> ${__('Content')}
							</button>
							<button class="btn btn-primary btn-sm" data-new-gd="${frappe.utils.escape_html(tripName)}">
								${__('New Trip Date')}
							</button>
							<button class="btn btn-primary btn-sm" data-new-pkg="${frappe.utils.escape_html(tripName)}">
								${__('New Package')}
							</button>
						</div>
					</div>

					<div class="tm-ws-section">
						<h5 class="tm-section-title">${__('Trip Dates')} <span class="text-muted">(${d.tgd.length})</span></h5>
						${d.tgd.length ? d.tgd.map(g => `
							<div class="tm-card tm-gd-row">
								<div class="tm-card-head">
									<div>
										<a class="tm-card-title" data-doctype="Trip Group Date" data-name="${frappe.utils.escape_html(g.name)}">
											${frappe.utils.escape_html(g.trip_group_name || g.name)}
										</a>
										<div class="tm-card-sub">
											<span class="tm-badge ${g.status === 'Active' ? 'tm-badge-active' : ''}">${frappe.utils.escape_html(g.status || '')}</span>
											${g.is_cruise_only ? '<span class="tm-badge tm-badge-cruise">Cruise Only</span>' : ''}
											<span>${frappe.utils.escape_html(fmtD(g.departure_date))} → ${frappe.utils.escape_html(fmtD(g.return_date))}</span>
											${g.max_participants ? chip('Seats left', g.seats_left != null ? g.seats_left : '∞') : ''}
										</div>
										<div class="tm-card-sub">
											${g.cruise_schedule
												? `<span class="tm-linkline"><i class="ti ti-ship"></i> <a data-doctype="Trip Cruise Schedule" data-name="${frappe.utils.escape_html(g.cruise_schedule)}">${frappe.utils.escape_html(g.cruise_schedule_title || g.cruise_schedule)}</a></span>`
												: '<span class="tm-missing"><i class="ti ti-ship-off"></i> No cruise schedule</span>'}
											${g.flight_schedule
												? `<span class="tm-linkline"><i class="ti ti-plane"></i> <a data-doctype="Flight Schedule" data-name="${frappe.utils.escape_html(g.flight_schedule)}">${frappe.utils.escape_html(g.flight_schedule_title || g.flight_schedule)}</a></span>`
												: (t.is_a_cruise_trip && !g.is_cruise_only
													? '<span class="tm-missing"><i class="ti ti-plane-off"></i> No flight schedule</span>' : '')}
										</div>
									</div>
									<div class="tm-gd-pkgs">
										${(g.packages || []).length
											? g.packages.map(p => `
												<span class="tm-tag" title="${frappe.utils.escape_html(p.package_title || '')}">
													<a data-doctype="Trip Package" data-name="${frappe.utils.escape_html(p.name)}" class="tm-tag-link">
														${frappe.utils.escape_html(p.package_type || p.name)}
													</a>
													<span class="tm-tag-cur">${frappe.utils.escape_html(p.currency || '')}</span>
												</span>`).join('')
											: '<span class="tm-missing">No packages on this date</span>'}
										<button class="btn btn-xs btn-default tm-row-edit" data-edit-gd="${frappe.utils.escape_html(g.name)}" title="${__('Edit')}">
											<i class="ti ti-pencil"></i>
										</button>
										${g.cruise_schedule ? `<button class="btn btn-xs btn-default" data-sync-avail="${frappe.utils.escape_html(g.cruise_schedule)}" title="${__('Sync cabin availability')}"><i class="ti ti-refresh"></i></button>` : ''}
									</div>
								</div>
							</div>`).join('')
						: empty_('No trip dates yet')}
					</div>

					<div class="tm-ws-section">
						<h5 class="tm-section-title">${__('Packages')} <span class="text-muted">(${d.packages.length})</span></h5>
						${d.packages.length ? d.packages.map(p => `
							<div class="tm-card">
								<div class="tm-card-head">
									<div>
										<a class="tm-card-title" data-doctype="Trip Package" data-name="${frappe.utils.escape_html(p.name)}">
											${frappe.utils.escape_html(p.package_title || p.name)}
										</a>
										<div class="tm-card-sub">
											<span class="tm-badge">${frappe.utils.escape_html(p.package_type || '')}</span>
											<span class="tm-badge ${p.status === 'Active' ? 'tm-badge-active' : ''}">${frappe.utils.escape_html(p.status || '')}</span>
											${p.featured ? '<span class="tm-badge tm-badge-star">★ Featured</span>' : ''}
											${p.price_review_required ? '<span class="tm-badge tm-badge-warn">Price Review</span>' : ''}
											${p.airport_form ? `<span class="tm-tag">from ${frappe.utils.escape_html(p.airport_form)}</span>` : ''}
										</div>
									</div>
									<div class="tm-chips">
										${chip('Dates', p.gd_list.length)}
										${chip('Price Rows', p.price_rows)}
										${chip('BOM', p.bom_rows)}
										<button class="btn btn-xs btn-default tm-row-edit" data-edit-pkg="${frappe.utils.escape_html(p.name)}" title="${__('Edit')}">
											<i class="ti ti-pencil"></i>
										</button>
										<button class="btn btn-xs btn-default" data-import-rates="${frappe.utils.escape_html(p.name)}" title="${__('Import cruise rates')}">
											<i class="ti ti-download"></i>
										</button>
									</div>
								</div>
								<div class="tm-card-sub">
									${p.from_price != null ? `<span class="tm-price">From <b>${frappe.utils.escape_html((p.currencies || []).join('/'))} ${Number(p.from_price).toLocaleString()}</b></span>` : ''}
									<span class="tm-tag-list">${p.gd_list.map(g =>
			`<a class="tm-tag" data-doctype="Trip Group Date" data-name="${frappe.utils.escape_html(g)}">${frappe.utils.escape_html(g)}</a>`).join(' ')}</span>
								</div>
								${(p.bom || []).length ? `
								<div class="tm-bom">
									<span class="tm-bom-label">${__('Includes')}:</span>
									${p.bom.map(b => `<span class="tm-tag">${frappe.utils.escape_html(b.component_type)}${b.per_pax ? ' ×' + b.qty + '/pax' : (b.qty > 1 ? ' ×' + b.qty : '')}${b.misc_description ? ' — ' + frappe.utils.escape_html(b.misc_description) : ''}</span>`).join(' ')}
								</div>` : ''}
							</div>`).join('')
						: empty_('No packages yet')}
					</div>
				</div>`);

			bindCommon($app, 'trips', null, () => {});
			// EDITOR (modal, tanpa lompat Desk form) — TripManagerEditor
			// dari trip_manager_editor.js (render_include).
			const ED = window.TripManagerEditor || {};
			const reload = () => renderTripWorkspace(tripName);
			$app.find('[data-edit-trip]').off('click').on('click', function () {
				frappe.set_route('Form', 'Trip', $(this).data('edit-trip'));
			});
			$app.find('[data-edit-content]').off('click').on('click', function () {
				ED.editTripContent && ED.editTripContent(tripName, reload);
			});
			$app.find('[data-new-gd]').off('click').on('click', function () {
				ED.editGroupDate && ED.editGroupDate(null, tripName,
					{ is_cruise_trip: t.is_a_cruise_trip }, reload);
			});
			$app.find('[data-edit-gd]').off('click').on('click', function () {
				const gd = d.tgd.find(g => g.name === $(this).data('edit-gd'));
				gd && ED.editGroupDate && ED.editGroupDate(gd, tripName,
					{ is_cruise_trip: t.is_a_cruise_trip }, reload);
			});
			$app.find('[data-new-pkg]').off('click').on('click', function () {
				ED.editPackage && ED.editPackage(null, tripName,
					{ dates: d.tgd }, reload);
			});
			$app.find('[data-edit-pkg]').off('click').on('click', function () {
				const pkg = d.packages.find(p => p.name === $(this).data('edit-pkg'));
				pkg && ED.editPackage && ED.editPackage(pkg, tripName,
					{ dates: d.tgd }, reload);
			});
			$app.find('[data-import-rates]').off('click').on('click', function () {
				ED.importCruiseRates && ED.importCruiseRates($(this).data('import-rates'), reload);
			});
			$app.find('[data-sync-avail]').off('click').on('click', function () {
				const sched = $(this).data('sync-avail');
				ED.syncCabinAvailability && ED.syncCabinAvailability(sched, reload);
			});
			// search input value cache
			$app.find('.tm-search').on('input', function () {
				state.search[$(this).data('search')] = $(this).val();
			});
		});
	}

	/* ═══ ROUTE: /flight-schedules ═══ */
	function renderFlights() {
		page.set_title(__('Flight Schedules') + ' — ' + __('Trip Manager'));
		const $app = $container.find('.tm-app');
		$app.html(subnav('flight-schedules') + toolbar('Flight Schedule', 'Flight Schedule') + `<div class="tm-body">${loading()}</div>`);
		bindCommon($app, 'flight-schedules', 'Flight Schedule', force => loadFlights(force));
		loadFlights();
	}

	function loadFlights(force) {
		const $body = $container.find('.tm-body');
		frappe.call({
			method: `${API}.get_flight_schedules`,
			args: { search: state.search['Flight Schedule'] || '', limit: 50 },
		}).then(r => {
			const d = r.message || { schedules: [], orphans: [] };
			let html = '';
			if (!d.schedules.length) {
				html += empty_('No flight schedules yet — create one to group PNRs per trip date');
			} else {
				html += d.schedules.map(s => `
					<div class="tm-card">
						<div class="tm-card-head">
							<div>
								<a class="tm-card-title" data-edit-fs="${frappe.utils.escape_html(s.name)}" style="cursor:pointer;">
									${frappe.utils.escape_html(s.schedule_code || s.name)}
								</a>
								<div class="tm-card-sub">
									<span class="tm-badge ${s.status === 'Active' ? 'tm-badge-active' : ''}">${frappe.utils.escape_html(s.status || '')}</span>
									${chip('Trip Dates', s.tgd_count)}
									${(s.tgds || []).map(g => `<span class="tm-tag">${frappe.utils.escape_html(g)}</span>`).join('')}
								</div>
							</div>
							<div>
								<button class="btn btn-xs btn-default" data-edit-fs="${frappe.utils.escape_html(s.name)}"><i class="ti ti-pencil"></i> ${__('Edit')}</button>
							</div>
						</div>
						${(s.flights || []).length ? pnrTable(s.flights) : '<div class="tm-card-sub">No PNRs in this schedule.</div>'}
					</div>`).join('');
			}
			if ((d.orphans || []).length) {
				html += `<h5 class="tm-section-title">Unassigned PNRs (not in any schedule)</h5>`;
				html += pnrTable(d.orphans, true);
			}
			$body.html(html);
			bindCommon($body, 'flight-schedules', 'Flight Schedule', () => {});
			// Modal editor FS
			const ED = window.TripManagerEditor || {};
			$body.find('[data-edit-fs]').off('click').on('click', function () {
				const name = $(this).data('edit-fs');
				const s = (d.schedules || []).find(x => x.name === name) || { name: name };
				ED.editFlightSchedule && ED.editFlightSchedule(s, () => loadFlights(true));
			});
		});
	}

	function pnrTable(flights, isOrphan) {
		return `<table class="tm-table">
			<thead><tr>
				${isOrphan ? '' : '<th>Role</th>'}
				<th>PNR</th><th>Route</th><th>Dates</th>
				<th>Type</th><th>Class</th><th>Seats</th><th>Status</th>
			</tr></thead>
			<tbody>${flights.map(f => `
				<tr>
					${isOrphan ? '' : `<td>${frappe.utils.escape_html(f.role || '')}</td>`}
					<td><a data-doctype="Flight" data-name="${frappe.utils.escape_html(f.flight || f.name)}">${frappe.utils.escape_html(f.pnr || f.name)}</a></td>
					<td>${frappe.utils.escape_html(f.home_airport || '')} → ${frappe.utils.escape_html(f.destination_airport || '')}</td>
					<td>${frappe.utils.escape_html(fmtD(f.departure_date))} – ${frappe.utils.escape_html(fmtD(f.arrival_date))}</td>
					<td>${frappe.utils.escape_html(f.ticket_type || '')}</td>
					<td>${frappe.utils.escape_html(f.flight_class || '')}</td>
					<td>${f.seats_occupied || 0}/${f.max_seat || 0}</td>
					<td>${frappe.utils.escape_html(f.status || '')}</td>
				</tr>`).join('')}
			</tbody></table>`;
	}

	/* ═══ ROUTE: /cruise-schedules ═══ */
	function renderCruise() {
		page.set_title(__('Cruise Schedules') + ' — ' + __('Trip Manager'));
		const $app = $container.find('.tm-app');
		$app.html(subnav('cruise-schedules') + toolbar('Trip Cruise Schedule', 'Trip Cruise Schedule') + `<div class="tm-body">${loading()}</div>`);
		bindCommon($app, 'cruise-schedules', 'Trip Cruise Schedule', force => loadCruise(force));
		loadCruise();
	}

	function loadCruise(force) {
		const $body = $container.find('.tm-body');
		frappe.call({
			method: `${API}.get_cruise_schedules`,
			args: { search: state.search['Trip Cruise Schedule'] || '', limit: 50 },
		}).then(r => {
			const d = r.message || { schedules: [] };
			if (!d.schedules.length) {
				$body.html(empty_('No cruise schedules'));
				return;
			}
			$body.html(d.schedules.map(s => `
				<div class="tm-card">
					<div class="tm-card-head">
						<div>
							<a class="tm-card-title" data-doctype="Trip Cruise Schedule" data-name="${frappe.utils.escape_html(s.name)}">
								${frappe.utils.escape_html(s.schedule_code || s.name)}
							</a>
							<div class="tm-card-sub">
								<span class="tm-badge tm-badge-cruise">${frappe.utils.escape_html(s.ship_code || '')} ${frappe.utils.escape_html(s.ship_name || '')}</span>
								<span class="tm-badge ${s.status === 'Active' ? 'tm-badge-active' : ''}">${frappe.utils.escape_html(s.status || '')}</span>
								${chip('Trip Dates', s.tgd_count)}
								${chip('Cabin Classes', s.cabin_classes)}
							</div>
						</div>
						<div class="tm-card-sub">${frappe.utils.escape_html(fmtD(s.sail_start))} – ${frappe.utils.escape_html(fmtD(s.sail_end))}</div>
					</div>
					${(s.cabins || []).length ? `
					<table class="tm-table">
						<thead><tr><th>Cabin Class</th><th>Allotment</th><th>Occupancy</th><th>Available</th></tr></thead>
						<tbody>${s.cabins.map(c => `
							<tr>
								<td>${frappe.utils.escape_html(c.pricing_for_class || '')}</td>
								<td>${c.cabin_allotment || 0}</td>
								<td>${c.cabin_occupancy || 0}</td>
								<td class="${(c.cabin_available || 0) < 0 ? 'tm-neg' : ''}">${c.cabin_available != null ? c.cabin_available : '—'}</td>
							</tr>`).join('')}
						</tbody>
					</table>` : '<div class="tm-card-sub">No cabin rates configured.</div>'}
				</div>`).join(''));
			bindCommon($body, 'cruise-schedules', 'Trip Cruise Schedule', () => {});
		});
	}

	/* ═══ ROUTE: /extras ═══ */
	function renderExtras() {
		page.set_title(__('Extras / Addons') + ' — ' + __('Trip Manager'));
		const $app = $container.find('.tm-app');
		$app.html(subnav('extras') + toolbar('Trip Addon', 'Trip Addon') + `<div class="tm-body">${loading()}</div>`);
		bindCommon($app, 'extras', 'Trip Addon', force => loadExtras(force));
		loadExtras();
	}

	function loadExtras(force) {
		const $body = $container.find('.tm-body');
		frappe.call({
			method: `${API}.get_extras`,
			args: { search: state.search['Trip Addon'] || '', limit: 50 },
		}).then(r => {
			const d = r.message || { addons: [] };
			if (!d.addons.length) {
				$body.html(empty_('No extras/addons yet'));
				return;
			}
			$body.html(d.addons.map(a => `
				<div class="tm-card">
					<div class="tm-card-head">
						<div>
							<a class="tm-card-title" data-edit-addon="${frappe.utils.escape_html(a.name)}" style="cursor:pointer;">
								${frappe.utils.escape_html(a.addon_title || a.name)}
							</a>
							<div class="tm-card-sub">
								<span class="tm-badge">${frappe.utils.escape_html(a.addon_type || 'Other')}</span>
								${a.disable ? '<span class="tm-badge">Disabled</span>' : '<span class="tm-badge tm-badge-active">Enabled</span>'}
								${chip('Packages', a.active_pkgs)}
							</div>
						</div>
						<div>
							<button class="btn btn-xs btn-default" data-edit-addon="${frappe.utils.escape_html(a.name)}"><i class="ti ti-pencil"></i> ${__('Edit')}</button>
							<button class="btn btn-xs btn-primary" data-new-addonpkg="${frappe.utils.escape_html(a.name)}">+ ${__('Sale Package')}</button>
						</div>
					</div>
					${(a.packages || []).length ? `
					<table class="tm-table">
						<thead><tr><th>Package</th><th>Status</th><th>Scope</th><th>Rates</th><th>Sold</th><th></th></tr></thead>
						<tbody>${a.packages.map(p => `
							<tr>
								<td><a data-edit-addonpkg="${frappe.utils.escape_html(p.name)}" data-addon="${frappe.utils.escape_html(a.name)}" style="cursor:pointer;">${frappe.utils.escape_html(p.addon_package_name || p.name)}</a>
									${p.is_cabin_upgrade ? '<span class="tm-badge tm-badge-cruise">Cabin Upgrade</span>' : ''}</td>
								<td>${frappe.utils.escape_html(p.status || '')}</td>
								<td>${frappe.utils.escape_html(p.scope || '')} · ${frappe.utils.escape_html((p.applicable_to || '').replace(' Trips Only', ''))}</td>
								<td>${frappe.utils.escape_html(p.rates || '—')}</td>
								<td>${p.current_qty_sold || 0}${p.max_total_qty ? '/' + p.max_total_qty : ''}</td>
								<td><button class="btn btn-xs btn-default" data-edit-addonpkg="${frappe.utils.escape_html(p.name)}" data-addon="${frappe.utils.escape_html(a.name)}"><i class="ti ti-pencil"></i></button></td>
							</tr>`).join('')}
						</tbody>
					</table>` : '<div class="tm-card-sub">No sale packages.</div>'}
				</div>`).join(''));
			bindCommon($body, 'extras', 'Trip Addon', () => {});
			// Modal editors extras
			const ED = window.TripManagerEditor || {};
			$body.find('[data-edit-addon]').off('click').on('click', function () {
				const name = $(this).data('edit-addon');
				const a = (d.addons || []).find(x => x.name === name) || { name: name };
				ED.editAddon && ED.editAddon(a, () => loadExtras(true));
			});
			$body.find('[data-new-addonpkg]').off('click').on('click', function () {
				ED.editAddonPackage && ED.editAddonPackage(null, $(this).data('new-addonpkg'),
					() => loadExtras(true));
			});
			$body.find('[data-edit-addonpkg]').off('click').on('click', function () {
				const pname = $(this).data('edit-addonpkg');
				const aname = $(this).data('addon');
				const a = (d.addons || []).find(x => x.name === aname);
				const p = a && (a.packages || []).find(x => x.name === pname);
				ED.editAddonPackage && ED.editAddonPackage(p || { name: pname }, aname,
					() => loadExtras(true));
			});
		});
	}

	/* ═══ ROUTE: /website — kandungan Travel Website ═══ */
	function renderWebsite() {
		page.set_title(__('Website Content') + ' — ' + __('Trip Manager'));
		const $app = $container.find('.tm-app');
		$app.html(subnav('website') + `
			<div class="tm-ws-tabs">
				<button class="tm-subnav-item tm-wst-active" data-ws-tab="cruise">${__('Cruise')}</button>
				<button class="tm-subnav-item" data-ws-tab="tour">${__('Tour')}</button>
				<button class="tm-subnav-item" data-ws-tab="common">${__('Common')}</button>
			</div>
			<div class="tm-body">${loading()}</div>`);
		bindCommon($app, 'website', null, () => {});
		$app.find('[data-ws-tab]').off('click').on('click', function () {
			$app.find('[data-ws-tab]').removeClass('tm-wst-active');
			$(this).addClass('tm-wst-active');
			loadWebsiteSection($(this).data('ws-tab'));
		});
		loadWebsiteSection('cruise');
	}

	function loadWebsiteSection(section) {
		const $body = $container.find('.tm-body');
		frappe.call({
			method: 'travel_booking.api.trip_command_center.get_website_settings',
			freeze: true,
		}).then(r => {
			const w = r.message || {};
			const ED = window.TripManagerEditor || {};
			// Bina medan ikut seksyen — guna editor modal baharu.
			if (ED.editWebsiteSection) {
				$body.html(`<div class="tm-card">
					<div class="tm-card-head"><div>
						<div class="tm-card-title">${__('Website')} — ${section}</div>
						<div class="tm-card-sub">${__('Klik Edit untuk buka editor kandungan (hero, stats, benefits, testimonials, CTA).')}</div>
					</div></div>
				</div>`);
				ED.editWebsiteSection(section, w, () => {});
			} else {
				$body.html(empty_('Editor tidak tersedia'));
			}
		});
	}

	/* ── helpers ── */
	function chip(label, n) {
		return `<span class="tm-chip">${label}: <b>${n || 0}</b></span>`;
	}
	function fmtD(v) {
		return v ? frappe.datetime.str_to_user(v) : '';
	}

	return { init, route, routeDeferred: renderRouteDeferred };
})();

/* ---------- EDITOR LAYER ----------
   Modal dialogs (TGD, Package + pricing grid + BOM, Content + galeri,
   Flight Schedule, Extras, Website) — trip_manager_editor.js di-include
   di sini: concatenation server-side oleh render_include. ---------- */
{% include "travel_booking/module_admin_portal/page/trip_manager/trip_manager_editor.js" %}
