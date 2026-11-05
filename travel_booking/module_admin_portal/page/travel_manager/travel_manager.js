// travel_booking/module_admin_portal/page/travel_manager/travel_manager.js
// TRAVEL MANAGER v6 — 1ST LAYER DIRECTORY + NAVIGATION PANEL + BREADCRUMB
// (permintaan pengguna: 3 "page" dalam satu app shell)
//
//   NAV PANEL (kiri)              KANDUNGAN (breadcrumb › …)
//   🗺️ Trip Management      →  senarai trip (grid) → direktori trip
//   👥 Booking Group Mgmt   →  /app/manage-booking-app (app sedia ada —
//                              L1 group list / L2 group detail / L3 booking)
//   📄 Booking Management   →  senarai booking individual (semua status,
//                              carian + aliran status)
//
// ROUTING:
//   /app/travel-manager                        → Trip Management
//   /app/travel-manager/trip-management        → Trip Management
//   /app/travel-manager/trip/<TRIP>            → direktori trip
//   /app/travel-manager/booking-management     → Booking Management
//
// Semua operasi melalui API berpagarkan role — TIADA akses DocType terus.
// Kelulusan Active/Retired/Cancelled: Tour Manager/System Manager sahaja.

frappe.pages['travel-manager'].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Travel Manager'),
		single_column: true,
	});

	wrapper.querySelector('.page-head').innerHTML = `
		<div class="tm-shell" style="display:flex;gap:0;align-items:stretch;
			min-height:calc(100vh - 120px)">
			<div class="tm-nav" style="width:240px;flex-shrink:0;border-right:1px solid #e8e8e8;
				padding:14px 10px">
				<div style="font-size:11px;font-weight:700;color:#999;letter-spacing:.06em;
					padding:0 10px 8px">TRAVEL MANAGER</div>
				<div class="tm-nav-items" style="display:flex;flex-direction:column;gap:4px"></div>
				<div style="margin-top:18px;padding:10px;border-top:1px solid #f0f0f0;
					font-size:11.5px;color:#999;line-height:1.6">
					Status Active/Retired/Cancelled<br>perlukan kelulusan
					<strong>Tour Manager</strong>.</div>
			</div>
			<div class="tm-main" style="flex:1;min-width:0;display:flex;flex-direction:column">
				<div class="tm-breadcrumb" style="padding:14px 18px;border-bottom:1px solid #f0f0f0;
					font-size:13px;color:#666"></div>
				<button class="btn btn-xs btn-default tm-refresh" style="margin:10px 18px 0;
					align-self:flex-start">Muat Semula</button>
				<div class="tm-body" style="padding:12px 18px 40px;flex:1"></div>
			</div>
		</div>
	`;

	window.TravelManager = (function () {
		const $body = $(wrapper).find('.tm-body');
		const $bc = $(wrapper).find('.tm-breadcrumb');
		const $navItems = $(wrapper).find('.tm-nav-items');
		const $back = $(wrapper).find('.tm-back');

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

		const GRID = 'display:grid;grid-template-columns:repeat(12,1fr);gap:14px';
		const card = (span, title, inner) => `
			<div class="panel panel-default" style="grid-column:span ${span};
				padding:12px;margin:0">
				${title ? `<div style="font-size:12px;color:#666;margin-bottom:6px;
					font-weight:700;letter-spacing:.02em">${title}</div>` : ''}
				${inner}
			</div>`;

		const NAV = [
			{ key: 'trip-management', route: 'trip-management', icon: '🗺️',
				label: 'Trip Management', desc: 'Senarai trip + direktori' },
			{ key: 'booking-group', route: 'manage-booking-app', icon: '👥',
				label: 'Booking Group Management', desc: 'Booking ikut group date — app khas', external: true },
			{ key: 'booking-management', route: 'booking-management', icon: '📄',
				label: 'Booking Management', desc: 'Booking individual + status' },
		];

		const state = {
			view: 'trip-management',  // trip-management | trip | booking-management
			trip: null,
			search: '', bkg_search: '', bkg_status: 'All',
		};

		function render_nav() {
			$navItems.html(NAV.map((n) => {
				const active = !n.external && state.view === n.key;
				return `
					<button class="btn btn-default tm-nav-item ${active ? 'tm-nav-active' : ''}"
						data-key="${n.key}" style="text-align:left;padding:10px 12px;
						border-radius:8px;display:flex;gap:10px;align-items:flex-start;
						${active ? 'background:#1d4ed810;border-color:#1d4ed855' : ''}">
						<span style="font-size:16px">${n.icon}</span>
						<span>
							<div style="font-weight:${active ? '700' : '600'};font-size:13px">
								${esc(n.label)}</div>
							<div style="font-size:11px;color:#999">${esc(n.desc)}</div>
						</span>
					</button>`;
			}).join(''));
			$navItems.find('.tm-nav-item').on('click', function () {
				const key = $(this).data('key');
				const item = NAV.find((n) => n.key === key);
				if (item.external) {
					frappe.set_route(item.route);  // app Booking Group sedia ada
					return;
				}
				frappe.set_route('travel-manager', item.route);
			});
		}

		function breadcrumb(segments) {
			// segments: [{label, route?: [..]}] — terakhir TIADA link (current)
			$bc.html(segments.map((s, i) => {
				const isLast = i === segments.length - 1;
				const inner = isLast
					? `<strong style="color:#1E1C18">${esc(s.label)}</strong>`
					: `<a href="javascript:void(0)" class="tm-bc-link" data-route='${esc(JSON.stringify(s.route))}'
						style="color:#1d4ed8">${esc(s.label)}</a>`;
				return inner + (isLast ? '' : ' <span style="color:#bbb">›</span> ');
			}).join(''));
			$bc.find('.tm-bc-link').on('click', function () {
				frappe.set_route(...JSON.parse($(this).data('route')));
			});
		}

		function handle_route() {
			const route = frappe.get_route() || [];
			const seg = route[1];
			if (seg === 'trip' && route[2]) {
				state.view = 'trip';
				state.trip = route[2];
				render_nav();
				load_trip_directory(state.trip);
			} else if (seg === 'booking-management') {
				state.view = 'booking-management';
				render_nav();
				load_bookings();
			} else {
				state.view = 'trip-management';
				render_nav();
				load_trips();
			}
		}

		function refresh() {
			handle_route();
		}
		$(wrapper).find('.tm-refresh').on('click', refresh);

		// ════════════ TRIP MANAGEMENT ════════════
		async function load_trips() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip Management' },
			]);
			$body.html(`<div style="color:#999;padding:30px;text-align:center">
				<div class="spinner-border spinner-border-sm"></div></div>`);

			const [tripsData, ready] = await Promise.all([
				tcc('get_trips_list', { search: state.search, limit: 60 }),
				tcc('get_readiness_summary', {}),
			]);
			const trips = tripsData?.trips || [];
			const s = ready?.summary || { ready: 0, warning: 0, error: 0 };

			const tripCards = trips.map((t) => `
				<div class="panel panel-default tm-trip" data-trip="${esc(t.name)}"
					style="padding:12px;margin:0;cursor:pointer">
					<div style="font-weight:700;margin-bottom:4px">${esc(t.trip_name)}</div>
					<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
						${t.is_a_cruise_trip ? badge('🚢 Cruise', C.blue) : badge('✈️ Tour', C.orange)}
						${badge(t.status || 'Active', DEP_COLOR[t.status] || C.gray)}
						${badge(t.published ? '🌐' : '📝', t.published ? C.green : C.gray)}
					</div>
					<div style="color:#888;font-size:12px;display:flex;justify-content:space-between">
						<span>${esc((t.route || '-').slice(0, 30))}</span>
						<span><strong>${t.dates_count || 0}</strong> tarikh</span>
					</div>
				</div>
			`).join('');

			$body.html(`
				<div style="${GRID}">
					${card(4, '', `<h2 style="margin:0;color:${C.green};display:inline">${s.ready || 0}</h2>
						<span style="color:#888"> trip ready</span>`)}
					${card(4, '', `<h2 style="margin:0;color:${C.orange};display:inline">${s.warning || 0}</h2>
						<span style="color:#888"> dengan amaran</span>`)}
					${card(4, '', `<h2 style="margin:0;color:${C.red};display:inline">${s.error || 0}</h2>
						<span style="color:#888"> perlu tindakan</span>`)}
					${card(12, `TRIP (${trips.length}) — klik untuk buka direktori
						<input class="form-control tm-search" placeholder="Cari…"
							value="${esc(state.search)}"
							style="display:inline-block;width:200px;margin-left:10px;height:26px;
							padding:2px 8px;font-size:12px">`,
						`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px">
							${tripCards || '<p style="color:#999">Tiada trip.</p>'}
						</div>`)}
				</div>
			`);

			$body.find('.tm-trip').on('click', function () {
				frappe.set_route('travel-manager', 'trip', $(this).data('trip'));
			});
			$body.find('.tm-search').on('input', frappe.utils.debounce(function () {
				state.search = $(this).val(); load_trips();
			}, 400));
		}

		// ════════════ BOOKING MANAGEMENT (individual) ════════════
		const BKG_STATUSES = ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed', 'Abandoned', 'Cancelled'];

		async function load_bookings() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Booking Management' },
			]);
			$body.html(`
				<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
					<input class="form-control tm-bkg-search" placeholder="Cari booking/customer/trip…"
						value="${esc(state.bkg_search)}" style="max-width:280px;height:28px;font-size:12.5px">
					${['All'].concat(BKG_STATUSES).map((s) =>
						`<button class="btn btn-xs tm-bst ${state.bkg_status === s ? 'btn-primary' : 'btn-default'}"
							data-s="${s}">${s}</button>`).join('')}
				</div>
				<div class="tm-bkg"><div style="color:#999;padding:30px;text-align:center">
					<div class="spinner-border spinner-border-sm"></div></div></div>
			`);
			$body.find('.tm-bkg-search').on('input', frappe.utils.debounce(function () {
				state.bkg_search = $(this).val().toLowerCase(); render_bookings();
			}, 300));
			$body.find('.tm-bst').on('click', function () {
				state.bkg_status = $(this).data('s'); render_bookings();
			});

			const data = await hub('get_booking_kanban', {});
			state.bkg_data = data;
			render_bookings();
		}

		function render_bookings() {
			const $box = $body.find('.tm-bkg');
			if (!$box.length) return;
			const cols = state.bkg_data?.columns || {};
			const q = state.bkg_search;
			let rows = '';
			let shown = 0;
			BKG_STATUSES.forEach((s) => {
				if (state.bkg_status !== 'All' && state.bkg_status !== s) return;
				(cols[s] || []).forEach((b) => {
					const hay = [b.name, b.customer_name, b.trip_name, b.departure_date, b.trip_date]
						.join(' ').toLowerCase();
					if (q && hay.indexOf(q) === -1) return;
					shown++;
					rows += `
						<tr data-booking="${esc(b.name)}">
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
				</table>
				<p style="color:#999;font-size:12px">${shown} booking</p>`
				: '<p style="color:#999;padding:30px;text-align:center">Tiada booking sepadan.</p>'}
			`);
			$box.find('.tm-next').on('click', function () {
				const booking = $(this).closest('tr').data('booking');
				const next = $(this).data('next');
				frappe.confirm(`Tukar status booking ${booking} → "${next}"?`, async () => {
					try {
						await hub('update_booking_status', { booking_name: booking, new_status: next });
						frappe.show_alert({ message: 'Status booking dikemas kini', indicator: 'green' });
						load_bookings();
					} catch (err) { /* frappe dah papar */ }
				});
			});
		}

		// ── F5: dialog Kuota & Harga (prasyarat flag — isi allotment tanpa DocType) ──
		function commercial_dialog(offer, onDone) {
			api('get_offer_commercial', { offer }).then((data) => {
				const inv = data?.inventory || [];
				const prs = data?.prices || [];
				const d = new frappe.ui.Dialog({
					title: 'Kuota & Harga — ' + offer, size: 'large',
				});
				d.$body.html(`
					<div style="font-weight:700;margin:4px 0 6px">Inventori
						<span style="font-weight:400;color:#999;font-size:12px">
							(allotment boleh edit; sold read-only)</span></div>
					<table class="table table-condensed" style="font-size:12.5px">
						<thead><tr><th>Kunci</th><th style="width:110px">Allotment</th>
							<th>Sold</th><th>Available</th></tr></thead>
						<tbody>${inv.map((r) => `
							<tr>
								<td>${esc(r.inventory_key)}</td>
								<td><input class="form-control form-control-sm tm-alloc"
									data-name="${esc(r.name)}" data-key="${esc(r.inventory_key)}"
									type="number" min="0" value="${r.allotment || 0}"></td>
								<td>${r.sold || 0}</td>
								<td>${r.available ?? ((r.allotment || 0) - (r.sold || 0))}</td>
							</tr>`).join('')}</tbody>
					</table>
					<div style="font-weight:700;margin:14px 0 6px">Harga Matriks
						<span style="font-weight:400;color:#999;font-size:12px">
							(price + aktif boleh edit)</span></div>
					${prs.length ? `
					<table class="table table-condensed" style="font-size:12.5px">
						<thead><tr><th>Kunci</th><th>Umur</th><th>Currency</th>
							<th style="width:130px">Harga</th><th>Aktif</th></tr></thead>
						<tbody>${prs.map((r) => `
							<tr>
								<td style="font-size:11px">${esc(r.price_key)}</td>
								<td>${esc(r.age_option || '—')}</td>
								<td>${esc(r.currency || '')}</td>
								<td><input class="form-control form-control-sm tm-price"
									data-name="${esc(r.name)}" type="number" min="0"
									step="0.01" value="${r.price || 0}"></td>
								<td><input type="checkbox" class="tm-active"
									data-name="${esc(r.name)}" ${r.active ? 'checked' : ''}></td>
							</tr>`).join('')}</tbody>
					</table>` : '<p style="color:#999;font-size:12.5px">Tiada baris harga.</p>'}
				`);
				d.set_primary_action(__('Simpan'), async () => {
					const invRows = [];
					d.$body.find('.tm-alloc').each(function () {
						invRows.push({
							name: $(this).data('name'),
							inventory_key: $(this).data('key'),
							allotment: parseInt($(this).val() || 0, 10),
						});
					});
					const priceRows = [];
					d.$body.find('.tm-price').each(function () {
						const nm = $(this).data('name');
						const active = d.$body.find(`.tm-active[data-name="${nm}"]`).is(':checked');
						priceRows.push({
							name: nm, price: parseFloat($(this).val() || 0), active,
						});
					});
					try {
						await api('save_offer_inventory', { offer, rows: JSON.stringify(invRows) });
						await api('save_offer_prices', { offer, rows: JSON.stringify(priceRows) });
						frappe.show_alert({ message: 'Kuota & harga disimpan', indicator: 'green' });
						d.hide();
						onDone && onDone();
					} catch (e) { /* frappe dah papar */ }
				});
				d.show();
			});
		}

		function next_status_options(status) {
			const flow = {
				Pending: ['Accepted', 'Cancelled'],
				Accepted: ['Processing', 'Cancelled'],
				Processing: ['Confirmed'],
				Confirmed: ['Completed'],
				Completed: [], Abandoned: [], Cancelled: [],
			};
			return (flow[status] || []).map((n) =>
				`<button class="btn btn-xs btn-default tm-next" data-next="${n}">→ ${n}</button>`).join(' ')
				|| '<span style="color:#bbb">—</span>';
		}

		// ════════════ DIREKTORI TRIP ════════════
		async function load_trip_directory(trip) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip Management', route: ['travel-manager', 'trip-management'] },
				{ label: trip },
			]);
			$body.html(`<div style="color:#999;padding:30px;text-align:center">
				<div class="spinner-border spinner-border-sm"></div></div>`);

			const [links, pkgs, offers, sales, core] = await Promise.all([
				tlinks('get_trip_links', { trip }),
				api('get_packages_list', { trip, limit: 100 }),
				api('get_offers_list', { trip, upcoming: 0, limit: 200 }),
				hub('get_booking_kanban', { trip }).catch(() => null),
				tcc('get_trips_list', { search: trip, limit: 1 }),
			]);
			const info = (core?.trips || []).find((t) => t.name === trip);
			// breadcrumb segment terakhir: nama trip sebenar
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip Management', route: ['travel-manager', 'trip-management'] },
				{ label: info?.trip_name || trip },
			]);
			set_trip_title(info?.trip_name || trip,
				`${pkgs?.packages?.length || 0} pakej · ${offers?.offers?.length || 0} tarikh perjalanan`);

			const c = links?.cruise_schedule;
			const fa = links?.flight_arrangement;

			const cruiseCard = card(6, '🚢 CRUISE SCHEDULE', c ? `
				<div style="margin-bottom:6px">
					<strong>${esc(c.ship_name || c.schedule_code || c.name)}</strong>
					${badge(c.status || '-', C.blue)}
					<span style="color:#888;font-size:12px">
						${esc(c.sail_start || '')} → ${esc(c.sail_end || '')} ·
						${c.total_days || '-'} hari · ${esc(c.currency || '-')}</span>
				</div>
				${(c.cabin_rates || []).length ? `
				<table class="table table-condensed" style="margin:0 0 8px;font-size:12px">
					<thead><tr><th>Varian Kabin</th><th style="text-align:right">Dewasa</th>
						<th style="text-align:right">Allot.</th><th style="text-align:right">Occ.</th></tr></thead>
					<tbody>${c.cabin_rates.map((r) => `
						<tr>
							<td>${esc(r.pricing_for_class || '-')}</td>
							<td style="text-align:right">${money(r.price_adult)}</td>
							<td style="text-align:right">${r.cabin_allotment || 0}</td>
							<td style="text-align:right">${r.cabin_occupancy || 0}</td>
						</tr>`).join('')}</tbody>
				</table>` : '<p style="color:#999;font-size:12px;margin:0">Tiada kadar kabin.</p>'}
				<button class="btn btn-xs btn-default tm-pick-schedule">Tukar Schedule</button>
			` : `
				<p style="color:#999;font-size:12.5px">Belum dipautkan.</p>
				<button class="btn btn-xs btn-primary tm-pick-schedule">Pautkan Cruise Schedule</button>
			`);

			const faCard = card(6, '✈️ FLIGHT ARRANGEMENT', fa ? `
				<div style="font-size:12.5px;line-height:1.8">
					${badge(fa.flight_mode, C.blue)}
					<strong>${esc(fa.home_airport || '?')}</strong>
					${fa.flight_mode === 'Return' ? ' → ' + esc(fa.final_destination || '?') + ' (return)' : ' (multi-city)'}
					${fa.via_airports?.length ? ' · via ' + esc(fa.via_airports.join(', ')) : ''}
					${fa.preferred_airline ? ' · ' + esc(fa.preferred_airline) : ''}
					${fa.notes ? `<div style="color:#888">${esc(fa.notes)}</div>` : ''}
				</div>
				<button class="btn btn-xs btn-default tm-edit-fa" style="margin-top:6px">Edit</button>
			` : `
				<p style="color:#999;font-size:12.5px">Belum ada flight arrangement.</p>
				<button class="btn btn-xs btn-primary tm-edit-fa">+ Flight Arrangement</button>
			`);

			const comps = (links?.components || []);
			const compCard = card(12, '📦 PRODUK & KOMPONEN', comps.length ? `
				<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">
					${comps.slice(0, 12).map((r) => `
						<div style="border:1px solid #eee;border-radius:6px;padding:6px 10px;font-size:12px;
							display:flex;gap:8px;align-items:center">
							${badge(r.component_type, C.gray)}
							<strong>${esc(r.trip || r.flight || r.component_item || '-')}</strong>
							<span style="color:#999;margin-left:auto">${esc(r.selection_mode || '')}</span>
						</div>`).join('')}
				</div>` : '<p style="color:#999;font-size:12px;margin:0">Tiada komponen — tambah melalui pakej.</p>');

			const pkgList = (pkgs?.packages || []);
			const pkgCard = card(12, `📦 PAKEJ (${pkgList.length})
				<button class="btn btn-xs btn-primary tm-new-package" style="float:right">+ Pakej Baharu</button>`,
				pkgList.length ? `
				<table class="table table-condensed" style="margin:0;font-size:12.5px">
					<thead><tr><th>Pakej</th><th>Template</th><th>Status</th>
						<th>Offer</th><th>Harga dari</th><th></th></tr></thead>
					<tbody>${pkgList.map((p) => `
						<tr>
							<td><strong>${esc(p.package_name)}</strong>
								<span style="color:#999;font-size:11px">${esc(p.name)}</span></td>
							<td>${esc(p.package_template || '-')}</td>
							<td>${badge(p.status, DEP_COLOR[p.status] || C.gray)}</td>
							<td>${p.offer_count || 0}</td>
							<td>${p.min_price ? money(p.min_price) : '—'}</td>
							<td><button class="btn btn-xs btn-default tm-edit-package"
								data-pkg="${esc(p.name)}">Edit</button></td>
						</tr>`).join('')}</tbody>
				</table>` : '<p style="color:#999;font-size:12.5px;margin:0">Belum ada pakej.</p>');

			const offerList = (offers?.offers || []);
			const offerCard = card(12, `🗓️ TARIKH PERJALANAN (${offerList.length})
				<button class="btn btn-xs btn-primary tm-new-offer" style="float:right">+ Offer Baharu</button>`,
				offerList.length ? `
				<table class="table table-condensed" style="margin:0;font-size:12.5px">
					<thead><tr><th>Berangkat</th><th>Pulang</th><th>Pakej</th>
						<th>Editorial</th><th>Operasional</th><th>Occupy</th><th></th></tr></thead>
					<tbody>${offerList.map((o) => `
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
									<button class="btn btn-xs btn-default tm-commercial"
										data-offer="${esc(o.name)}"
										title="Kuota & harga">Kuota/Harga</button>
									${isManager && o.status_editorial !== 'Active'
										? `<button class="btn btn-xs btn-success tm-offer-act"
											data-offer="${esc(o.name)}" data-act="Active">Aktif</button>` : ''}
									${isManager && o.status_editorial === 'Active'
										? `<button class="btn btn-xs btn-warning tm-offer-act"
											data-offer="${esc(o.name)}" data-act="Cancelled">Batal</button>` : ''}
								</td>
						</tr>`).join('')}</tbody>
				</table>` : '<p style="color:#999;font-size:12.5px;margin:0">Belum ada tarikh — cipta offer.</p>');

			const salesCols = sales?.columns || {};
			let salesRows = '';
			let salesCount = 0;
			['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed'].forEach((st) => {
				(salesCols[st] || []).slice(0, 30).forEach((b) => {
					salesCount++;
					salesRows += `
						<tr data-booking="${esc(b.name)}">
							<td><strong>${esc(b.name)}</strong></td>
							<td>${esc(b.customer_name || '')}</td>
							<td style="text-align:right">${money(b.total_amount)}</td>
							<td>${badge(b.status, BKG_COLOR[b.status] || C.gray)}</td>
							<td style="white-space:nowrap">${next_status_options(b.status)}</td>
						</tr>`;
				});
			});
			const salesCard = card(12, `💰 JUALAN TRIP INI (${salesCount})`, salesCount ? `
				<table class="table table-condensed" style="margin:0;font-size:12.5px">
					<thead><tr><th>Booking</th><th>Customer</th>
						<th style="text-align:right">Jumlah</th><th>Status</th><th>Tindakan</th></tr></thead>
					<tbody>${salesRows}</tbody>
				</table>` : '<p style="color:#999;font-size:12.5px;margin:0">Tiada booking.</p>');

			$body.html(`<div style="${GRID}">
				${cruiseCard}${faCard}${compCard}${pkgCard}${offerCard}${salesCard}
			</div>`);

			$body.find('.tm-pick-schedule').on('click', function () {
				pick_schedule_dialog(trip, () => load_trip_directory(trip));
			});
			$body.find('.tm-edit-fa').on('click', function () {
				fa_dialog(fa, trip, () => load_trip_directory(trip));
			});
			$body.find('.tm-new-package').on('click', () =>
				package_dialog(null, trip, () => load_trip_directory(trip)));
			$body.find('.tm-edit-package').on('click', function () {
				package_dialog($(this).data('pkg'), null, () => load_trip_directory(trip));
			});
			$body.find('.tm-new-offer').on('click', () =>
				offer_dialog(trip, () => load_trip_directory(trip)));
			$body.find('.tm-commercial').on('click', function () {
				commercial_dialog($(this).data('offer'), () => load_trip_directory(trip));
			});
			$body.find('.tm-offer-act').on('click', function () {
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
			$body.find('.tm-next').on('click', function () {
				const booking = $(this).closest('tr').data('booking');
				const next = $(this).data('next');
				frappe.confirm(`Tukar status booking ${booking} → "${next}"?`, async () => {
					try {
						await hub('update_booking_status', { booking_name: booking, new_status: next });
						frappe.show_alert({ message: 'Status dikemas kini', indicator: 'green' });
						load_trip_directory(trip);
					} catch (err) { /* frappe dah papar */ }
				});
			});
		}

		function set_trip_title(name, subtitle) {
			// direktori: kemas kini breadcrumb segment terakhir + subtitle bawah
			$bc.find('strong').last().text(name);
			let sub = $bc.find('.tm-dir-subtitle');
			if (!sub.length) {
				sub = $('<div class="tm-dir-subtitle" style="color:#999;font-size:12px;margin-top:2px"></div>');
				$bc.append(sub);
			}
			sub.text(subtitle || '');
		}

		function pick_schedule_dialog(trip, onDone) {
			tlinks('list_schedules').then((schedules) => {
				const d = new frappe.ui.Dialog({ title: 'Pilih Cruise Schedule', size: 'large' });
				d.$body.html(`
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
				d.$body.find('.tm-pick').on('click', function () {
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

		// ── ROUTING ──
		return { refresh, handle_route };
	})();

	TravelManager.handle_route();
};

frappe.pages['travel-manager'].on_page_show = function () {
	if (window.TravelManager) window.TravelManager.handle_route();
};
