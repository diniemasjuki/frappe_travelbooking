// travel_booking/travel_booking_management/page/trip_command_center/trip_command_center.js
// Desk Page /app/trip-command-center - Pusat pengurusan Trip + Website Settings
//
// Gabungkan:
// - Trip Product Management (CRUD, dates, packages)
// - Website Configuration (content, SEO, branding)
// - Cruise Schedule (jika applicable)
//
// Routing: /app/trip-command-center -> main view
//          /app/trip-command-center/<trip-name> -> manage specific trip

frappe.pages['trip-command-center'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Trip Command Center'),
		single_column: false,
	});
	TripCommandCenter.init(page, wrapper);
};

frappe.pages['trip-command-center'].on_page_show = function () {
	if (window.TripCommandCenter) TripCommandCenter.on_show();
};

/* ============================================================
   TripCommandCenter - controller (IIFE)
   ============================================================ */
window.TripCommandCenter = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));
	// Strip HTML tags untuk medan Text Editor yang kini bawa HTML mentah
	const strip = (v) => {
		const s = String(v ?? '');
		return s.replace(/<[^>]+>/g, '').trim();
	};

	const S = {
		page: null,
		wrapper: null,
		current_tab: 'trips', // trips | dates | packages | website | cruise
		current_trip: null,
		filters: { search: '', status: '', type: '' },
		loading: false,
	};

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	
	const fmtDate = (iso) => {
		if (!iso) return '';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return String(iso);
		return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
	};

	const fmtMoney = (n) =>
		'RM' + parseFloat(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

	const STATUS_COLORS = {
		'Active': 'green', 'Pending Review': 'orange', 'Inactive': 'gray',
		'Published': 'blue', 'Draft': 'gray',
	};
	const badge = (label, color) =>
		`<span class="tcc-badge tcc-badge--${color || 'gray'}">${esc(label)}</span>`;

	/* ---------- API helper ---------- */
	const api = (method, args = {}) =>
		new Promise((resolve, reject) => {
			frappe.call({
				method: 'travel_booking.api.trip_command_center.' + method,
				args,
				freeze: false,
			})
			.then(r => resolve(r?.message ?? null))
			.catch(err => {
				console.error('TripCmd API Error:', method, err);
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

		inject_styles();
		build_layout();
		setup_tabs();
		setup_toolbar();
		setup_keyboard_shortcuts();
		load_tab('trips');

	frappe.router.on('change', function () {
		const route = frappe.get_route();
		if (route?.[1]) {
			const potential_trip = route[1];
			// Validate: Ignore doctype names and new document names
			const invalid_names = ['Trip', 'Trip Group Date', 'Trip Package', 'Trip Package Price'];
			const looks_like_new_doc = potential_trip.startsWith('new-');

			if (!invalid_names.includes(potential_trip) && !looks_like_new_doc) {
				S.current_trip = potential_trip;
				switch_to_tab('dates');
			} else {
				// Reset to avoid showing wrong data
				S.current_trip = null;
			}
		}
	});
	}

	function on_show() {
		if (S.current_tab) refresh_current_tab();
	}

	/* ========== LAYOUT ========== */

	function build_layout() {
		const $w = $(S.wrapper);
		$w.find('.layout-main-section').html(`
			<div id="tcc-container" class="tcc-container">
				<div id="tcc-toolbar" class="tcc-toolbar">
					<div class="tcc-toolbar-left">
						<div class="tcc-search-box">
							<input type="text" id="tcc-search" class="tcc-search-input"
								placeholder="${__('Search trips...')}" />
							<span class="tcc-search-icon">⌕</span>
						</div>
					</div>
					<div class="tcc-toolbar-right">
						<button class="btn btn-default btn-xs tcc-refresh-btn" id="tcc-refresh">${__('Refresh')}</button>
						<button class="btn btn-primary btn-xs tcc-new-trip" id="tcc-new-trip">+ ${__('New Trip')}</button>
					</div>
				</div>

				<div id="tcc-tabs" class="tcc-tabs">
					<button class="tcc-tab active" data-tab="trips">
						<span>✈️</span><span>${__('Trips')}</span>
						<span class="tcc-tab-count" id="tcc-trips-count">0</span>
					</button>
					<button class="tcc-tab" data-tab="dates">
						<span>📅</span><span>${__('Dates')}</span>
					</button>
					<button class="tcc-tab" data-tab="packages">
						<span>💰</span><span>${__('Packages')}</span>
					</button>
						<button class="tcc-tab" data-tab="website">
							<span>🌐</span><span>${__('Website')}</span>
						</button>
					<button class="tcc-tab tcc-cruise-only" data-tab="cruise">
						<span>🚢</span><span>${__('Cruise')}</span>
					</button>
				</div>

				<div id="tcc-content" class="tcc-content">
					<div class="tcc-loading"><div class="tcc-spinner"></div><p>${__('Loading...')}</p></div>
				</div>

				<div id="tcc-statusbar" class="tcc-statusbar"><span id="tcc-status-text">${__('Ready')}</span></div>
			</div>
		`);
	}

	/* ========== TAB NAVIGATION ========== */

	function setup_tabs() {
		$(document).off('click', '.tcc-tab').on('click', '.tcc-tab', function () {
			switch_to_tab($(this).data('tab'));
		});
	}

	function switch_to_tab(tab) {
		S.current_tab = tab;
		$('.tcc-tab').removeClass('active');
		$(`.tcc-tab[data-tab="${tab}"]`).addClass('active');
		load_tab(tab);
		if (frappe.router) frappe.set_route('trip-command-center');
	}

	async function load_tab(tab) {
		show_loading();
		try {
			switch (tab) {
				case 'trips': await render_trips_tab(); break;
				case 'dates': await render_dates_tab(); break;
				case 'packages': await render_packages_tab(); break;
				case 'website': await render_website_tab(); break;
				case 'cruise': await render_cruise_tab(); break;
				default: render_empty_state(__('Unknown tab'), tab);
			}
		} catch (err) {
			console.error('Tab load error:', tab, err);
			render_error_state(__('Failed to load'), err.message);
		}
		hide_loading();
		update_status(__('Ready'));
	}

	function refresh_current_tab() { if (S.current_tab) load_tab(S.current_tab); }

	/* ========== TOOLBAR ========== */

	function setup_toolbar() {
		$('#tcc-search').on('input', debounce(function () {
			S.filters.search = $(this).val().trim();
			refresh_current_tab();
		}, 300));

		$('#tcc-refresh').on('click', () => { refresh_current_tab(); frappe.show_alert({ message: __('Refreshed'), indicator: 'blue' }, 2); });
		
		$('#tcc-new-trip').on('click', () => {
			frappe.new_doc('Trip');
		});
	}

	function setup_keyboard_shortcuts() {
		$(document).off('keydown.tcc').on('keydown.tcc', e => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'f' && ($(e.target).is('body') || $(e.target).is('#tcc-search'))) {
				e.preventDefault(); $('#tcc-search').focus();
			}
			if ((e.ctrlKey || e.metaKey) && e.key === 'r' && $(e.target).closest('#tcc-container').length) {
				e.preventDefault(); refresh_current_tab();
			}
			if (!$(e.target).is('input, textarea, select')) {
				const n = parseInt(e.key);
				if (n >= 1 && n <= 4) switch_to_tab(['trips','dates','packages','website'][n-1]);
			}
			if (e.key === 'Escape') { S.current_trip = null; if (S.current_tab === 'dates') render_dates_tab(); }
		});
	}

	/* ========== TAB 1: UNIFIED TRIP VIEW (Trip + Dates + Packages) ========== */

	async function render_trips_tab() {
		const c = $('#tcc-content');
		c.html(`
			<div class="tcc-unified-header">
				<div class="tcc-unified-filters">
					<select id="tcc-filter-status" class="tcc-select">
						<option value="">${__('All Status')}</option>
						<option value="Active">${__('Active')}</option>
						<option value="Inactive">${__('Inactive')}</option>
					</select>
					<select id="tcc-filter-type" class="tcc-select">
						<option value="">${__('All Types')}</option>
						<option value="0">${__('Tour Only')}</option>
						<option value="1">${__('Cruise')}</option>
					</select>
				</div>
				<div class="tcc-unified-actions">
					<button class="btn btn-primary btn-sm tcc-new-trip">+ ${__('New Trip')}</button>
					<button class="btn btn-default btn-sm tcc-collapse-all">− ${__('Collapse All')}</button>
					<button class="btn btn-default btn-sm tcc-expand-all">+ ${__('Expand All')}</button>
				</div>
			</div>
			<div id="tcc-unified-grid" class="tcc-unified-grid">
				<div class="tcc-loading-small"><div class="tcc-spinner"></div></div>
			</div>
		`);

		// Filter handlers
		$('#tcc-filter-status, #tcc-filter-type').on('change', function () {
			S.filters.status = $('#tcc-filter-status').val();
			S.filters.type = $('#tcc-filter-type').val();
			load_unified_trips();
		});

		// Action buttons
		$('.tcc-new-trip').on('click', () => frappe.new_doc('Trip'));
		$('.tcc-collapse-all').on('click', () => $('.tcc-trip-expanded').slideUp(200).removeClass('tcc-trip-expanded'));
		$('.tcc-expand-all').on('click', () => {
			// Expand all trips and load their dates/packages
			$('.tcc-trip-card').each(function() { 
				if (!$(this).hasClass('tcc-trip-loaded')) {
					$(this).find('.tcc-expand-toggle').trigger('click');
				}
			});
		});

		await load_unified_trips();
	}

	async function load_unified_trips() {
		const grid = $('#tcc-unified-grid');
		grid.html('<div class="tcc-loading-small"><div class="tcc-spinner"></div></div>');

		try {
			const data = await api('get_trips_list', {
				search: S.filters.search,
				status: S.filters.status,
				is_cruise: S.filters.type,
				limit: 50,
			});

			if (data?.trips) {
				render_unified_trips(data.trips);
				$('#tcc-trips-count').text(data.trips.length);
			} else {
				grid.html('<div class="tcc-empty-state">' + __('No trips found') + '</div>');
			}
		} catch (err) {
			grid.html('<div class="tcc-error-state">' + __('Error loading trips') + '</div>');
		}
	}

	function render_unified_trips(trips) {
		const grid = $('#tcc-unified-grid');
		
		let html = '<div class="tcc-unified-list">';
		
		trips.forEach((t, idx) => {
			const stColor = STATUS_COLORS[t.status] || 'gray';
			const isExpanded = localStorage.getItem(`tcc_expanded_${t.name}`) === 'true';
			
			html += `
				<div class="tcc-unified-card ${isExpanded ? 'tcc-trip-expanded' : ''} ${isExpanded ? 'tcc-trip-loaded' : ''}" data-trip="${esc(t.name)}">
					<!-- Trip Header (Always Visible) -->
					<div class="tcc-trip-header" data-trip="${esc(t.name)}">
						<div class="tcc-trip-left">
							<div class="tcc-trip-img-small">
								<img src="${t.image || '/assets/travel_booking/img/defaultaroya.jpg'}" 
									onerror="this.src='/assets/travel_booking/img/defaultaroya.jpg'" />
							</div>
							<div class="tcc-trip-info">
								<h4>${esc(t.trip_name)}
									<span class="tcc-edit-link" data-trip="${esc(t.name)}">✏️</span>
								</h4>
								<p class="tcc-trip-route">${esc(t.route || '-')}</p>
								<div class="tcc-trip-badges">
									${badge(t.status || 'Active', stColor)}
									${t.is_a_cruise_trip ? badge('🚢 Cruise', 'blue') : badge('✈️ Tour', 'orange')}
									${badge(t.published ? '🌐 Published' : '📝 Draft', t.published ? 'green' : 'gray')}
								</div>
							</div>
						</div>
						<div class="tcc-trip-right">
							<div class="tcc-trip-stats">
								<div class="tcc-stat">
									<span class="tcc-stat-label">${__('Dates')}</span>
									<strong class="tcc-stat-value">${t.dates_count || 0}</strong>
								</div>
								<div class="tcc-stat">
									<span class="tcc-stat-label">${__('From')}</span>
									<strong class="tcc-stat-value tcc-price">${fmtMoney(t.min_price)}</strong>
								</div>
							</div>
							<button class="tcc-btn-expand tcc-expand-toggle ${isExpanded ? 'active' : ''}" 
								data-trip="${esc(t.name)}" title="${isExpanded ? __('Collapse') : __('Expand')}">
								<span class="tcc-arrow">${isExpanded ? '▼' : '▶'}</span>
							</button>
						</div>
					</div>

					<!-- Expanded Content (Dates + Packages) -->
					<div class="tcc-trip-expanded-content" data-content-for="${esc(t.name)}">
						${isExpanded ? '<div class="tcc-loading-inline"><div class="tcc-spinner-small"></div> Loading...</div>' : ''}
					</div>
				</div>
			`;
		});
		
		html += '</div>';
		grid.html(html);

		// Bind events
		bind_unified_events();
		
		// Auto-expand any that were previously expanded
		if ($('.tcc-trip-expanded').length) {
			$('.tcc-trip-expanded').each(function() {
				load_trip_expanded_content($(this).data('trip'));
			});
		}
	}

	function bind_unified_events() {
		// Expand/collapse toggle
		$(document).off('click', '.tcc-expand-toggle').on('click', '.tcc-expand-toggle', function (e) {
			e.stopPropagation();
			const card = $(this).closest('.tcc-unified-card');
			const tripName = $(this).data('trip');
			const contentArea = card.find('.tcc-trip-expanded-content');
			const isExpanded = card.hasClass('tcc-trip-expanded');

			if (isExpanded) {
				// ✅ BETUL: Hanya collapse content area, bukan seluruh card!
				contentArea.slideUp(300);
				card.removeClass('tcc-trip-expanded');
				$(this).removeClass('active');
				localStorage.removeItem(`tcc_expanded_${tripName}`);
			} else {
				// Expand: show content area dan load data
				card.addClass('tcc-trip-expanded');
				$(this).addClass('active');
				localStorage.setItem(`tcc_expanded_${tripName}`, 'true');

				// Slide down dulu (jika ada cached content)
				contentArea.slideDown(300);

				// Load data jika content belum loaded
				if (!card.hasClass('tcc-trip-loaded')) {
					load_trip_expanded_content(tripName);
				}
			}
		});

		// Edit trip link
		$(document).off('click', '.tcc-edit-link').on('click', '.tcc-edit-link', function (e) {
			e.stopPropagation();
			frappe.set_route('Form', 'Trip', $(this).data('trip'));
		});
	}

	async function load_trip_expanded_content(tripName) {
		const contentArea = $(`.tcc-trip-expanded-content[data-content-for="${tripName}"]`);
		
		try {
			// Load both dates and packages in parallel
			const [datesData, packagesData] = await Promise.all([
				api('get_trip_dates', { trip_name: tripName }),
				api('get_trip_packages', { trip_name: tripName }),
			]);

			const dates = datesData?.dates || [];
				const packages = packagesData?.packages || [];
				const isCruiseTrip = datesData?.trip?.is_a_cruise_trip;

				contentArea.html(`
					<!-- Dates Section -->
					<div class="tcc-section tcc-dates-section">
						<div class="tcc-section-header">
							<h4>📅 ${isCruiseTrip ? __('Cruise Sailing Schedule') : __('Departure Dates & Schedule')}</h4>
							<div class="tcc-section-actions">
								<button class="btn btn-primary btn-xs tcc-add-date" data-trip="${esc(tripName)}">+ ${__('Add Date')}</button>
							</div>
						</div>

						<div class="tcc-dates-table-wrapper">
							<table class="tcc-table">
							<thead>
										<tr>
											<th style="width:140px">${__('Departure')}</th>
											${isCruiseTrip ? `<th style="width:140px">⚓ ${__('Sailing')}</th>` : ''}
											${isCruiseTrip ? `<th style="width:140px">⛵ ${__('Sailing Return')}</th>` : ''}
											<th style="width:140px">${__('Return')}</th>
											<th>${__('Ship/Transport')}</th>
											<th style="width:70px">${__('Cap')}</th>
											<th style="width:70px">${__('Booked')}</th>
											<th style="width:80px">${__('Status')}</th>
											<th style="width:90px">${__('Actions')}</th>
										</tr>
									</thead>
									<tbody>
											${!dates.length ? `<tr><td colspan="${isCruiseTrip ? 9 : 7}" class="tcc-empty-row">
												<div class="tcc-empty-hint">📅 ${__('No dates scheduled yet')}</div>
												<button class="btn btn-primary btn-xs tcc-add-date-inline" data-trip="${esc(tripName)}">+ ${__('Add First Date')}</button>
											</td></tr>` :
										dates.map(d => `
											<tr class="tcc-date-row" data-date="${esc(d.name)}">
												<td><strong>${fmtDate(d.departure_date)}</strong></td>
												${isCruiseTrip ? `<td><strong class="tcc-sailing-date">${fmtDate(d.sailing_start)}</strong></td>` : ''}
												${isCruiseTrip ? `<td><strong class="tcc-sailing-return">${fmtDate(d.sailing_end)}</strong></td>` : ''}
												<td>${fmtDate(d.return_date)}</td>
											<td>${esc(d.ship_name || '-')}</td>
											<td>${d.max_participants || 0}</td>
											<td>
											<span class="${(d.current_participants||0) >= (d.max_participants||0) ? 'tcc-text-danger' : ''}">
												${d.current_participants || 0}
											</span>
										</td>
										<td>${badge(d.status || 'Active', STATUS_COLORS[d.status] || 'gray')}</td>
										<td>
											<button class="btn btn-default btn-xs tcc-edit-date" data-name="${esc(d.name)}">✏️</button>
										</td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
				</div>

				<!-- Packages Section -->
				<div class="tcc-section tcc-packages-section">
					<div class="tcc-section-header">
						<h4>💰 ${__('Pricing Packages')}</h4>
						<div class="tcc-section-actions">
							<button class="btn btn-primary btn-xs tcc-add-package" data-trip="${esc(tripName)}">+ ${__('New Package')}</button>
						</div>
					</div>
					
					<div class="tcc-packages-grid">
						${!packages.length ? `
							<div class="tcc-empty-hint">
								💰 ${__('No packages configured yet')}
								<button class="btn btn-primary btn-xs tcc-add-package-inline" data-trip="${esc(tripName)}">+ ${__('Create Package')}</button>
							</div>
						` :
						packages.map(p => `
								<div class="tcc-pkg-card" data-package="${esc(p.name)}">
									<div class="tcc-pkg-header">
										<h5>${esc(p.package_title || p.name)}</h5>
										<div class="tcc-pkg-badges">
											<span class="tcc-pkg-type-badge">${badge(p.package_type || '-', 'blue')}</span>
											<span class="tcc-pkg-status-badge">${badge(p.status || 'Active', STATUS_COLORS[p.status] || 'green')}</span>
										</div>
									</div>
									<div class="tcc-pkg-body">
										<p>${esc(p.package_description || '')}</p>
										${p.airport_form ? `<small class="tcc-muted">🛫 ${esc(p.airport_form)}</small>` : ''}
									</div>
									<div class="tcc-pricing">
										<small>${__('Starting from')}</small>
										<strong class="tcc-price-highlight">${fmtMoney(p.min_price)}</strong>
										${p.currency ? `<small class="tcc-muted">(${esc(p.currency)})</small>` : ''}
									</div>
									<div class="tcc-pkg-actions">
										<button class="btn btn-default btn-xs tcc-edit-pkg" data-name="${esc(p.name)}">✏️ ${__('Edit Pricing')}</button>
										<button class="btn btn-default btn-xs tcc-view-pkg" data-name="${esc(p.name)}">👁️ ${__('View Details')}</button>
									</div>
								</div>
						`).join('')}
					</div>
				</div>

				<!-- Quick Actions Bar -->
				<div class="tcc-quick-actions-bar">
					<span class="tcc-qa-item">
						✏️ <a href="#" class="tcc-qa-link" data-action="edit-trip" data-trip="${esc(tripName)}">${__('Edit Trip Info')}</a>
					</span>
					<span class="tcc-separator">|</span>
					<span class="tcc-qa-item">
						🌐 <a href="#" class="tcc-qa-link" data-action="website" data-trip="${esc(tripName)}">${__('Website Settings')}</a>
					</span>
					${dates.some(d => d.ship_name) ? `
						<span class="tcc-separator">|</span>
						<span class="tcc-qa-item">
							🚢 <a href="#" class="tcc-qa-link" data-action="cruise" data-trip="${esc(tripName)}">${__('Cruise Schedule')}</a>
						</span>
					` : ''}
				</div>
				`);

				// Bind expanded content events
				bind_expanded_events(tripName);

				// ✅ Mark card as loaded supaya tidak reload setiap kali expand
				const card = $(`.tcc-unified-card[data-trip="${tripName}"]`);
				card.addClass('tcc-trip-loaded');

			} catch (err) {
			console.error('Error loading expanded content:', err);
			contentArea.html('<div class="tcc-error-inline">' + __('Failed to load trip details') + '</div>');
		}
	}

	function bind_expanded_events(tripName) {
		const card = $(`.tcc-unified-card[data-trip="${tripName}"]`);

		// Add date buttons
		card.find('.tcc-add-date, .tcc-add-date-inline').on('click', function () {
			frappe.new_doc('Trip Group Date', { trip: tripName });
		});

		// Edit date button
		card.find('.tcc-edit-date').on('click', function () {
			frappe.set_route('Form', 'Trip Group Date', $(this).data('name'));
		});

		// Add package buttons
		card.find('.tcc-add-package, .tcc-add-package-inline').on('click', function () {
			frappe.new_doc('Trip Package', { trip_link: tripName });
		});

		// Edit package buttons
		card.find('.tcc-edit-pkg').on('click', function () {
			frappe.set_route('Form', 'Trip Package', $(this).data('name'));
		});

		// View package details (could open modal or navigate)
		card.find('.tcc-view-pkg').on('click', function () {
			frappe.set_route('Form', 'Trip Package', $(this).data('name'));
		});

		// Quick action links
		card.find('.tcc-qa-link').on('click', function (e) {
			e.preventDefault();
			const action = $(this).data('action');
			const trip = $(this).data('trip');
			
			if (action === 'edit-trip') frappe.set_route('Form', 'Trip', trip);
			else if (action === 'website') switch_to_tab('website');
			else if (action === 'cruise') switch_to_tab('cruise');
		});
	}

	/* ========== TAB 2: DATES (Group Dates) ========== */

	async function render_dates_tab() {
		const c = $('#tcc-content');
		if (!S.current_trip) {
			c.html(`
				<div class="tcc-select-prompt">
					<div class="tcc-prompt-icon">📅</div>
					<h3>${__('Trip Date Manager')}</h3>
					<p>${__('Select a trip from Trips tab to manage departure dates')}</p>
					<button class="btn btn-primary tcc-go-trips">${__('Go to Trips')}</button>
				</div>
			`);
			$('.tcc-go-trips').on('click', () => switch_to_tab('trips'));
			return;
		}

	c.html('<div class="tcc-loading"><div class="tcc-spinner"></div><p>' + __('Loading trip dates...') + '</p></div>');

	try {
		// Validate: Don't call API if no valid trip selected
		if (!S.current_trip) {
			c.html(`
				<div class="tcc-empty-state">
					<p>📅 ${__('Select a trip from the Trips tab to view its dates')}</p>
					<button class="btn btn-primary btn-xs tcc-go-trips">→ ${__('Go to Trips')}</button>
				</div>
			`);
			$('.tcc-go-trips').on('click', () => switch_to_tab('trips'));
			return;
		}

		const data = await api('get_trip_dates', { trip_name: S.current_trip });
		render_dates_view(data);
	} catch (err) {
		c.html('<div class="tcc-error-state">' + __('Error loading dates') + '</div>');
	}
	}

	function render_dates_view(data) {
		const c = $('#tcc-content');
		const trip = data.trip || {};
		const dates = data.dates || [];

		c.html(`
			<div class="tcc-dates-view">
				<div class="tcc-dates-header">
					<h3>${esc(trip.trip_name || S.current_trip)} - ${__('Departure Dates')}</h3>
					<button class="btn btn-primary btn-sm tcc-add-date" data-trip="${esc(S.current_trip)}">+ ${__('Add Date')}</button>
				</div>
				<div class="tcc-dates-list">
					<table class="tcc-table">
						<thead>
							<tr>
								<th>${__('Date')}</th>
								<th>${__('Return')}</th>
								<th>${__('Ship/Transport')}</th>
								<th>${__('Capacity')}</th>
								<th>${__('Booked')}</th>
								<th>${__('Status')}</th>
								<th>${__('Actions')}</th>
							</tr>
						</thead>
						<tbody>
							${!dates.length ? `<tr><td colspan="7" class="tcc-empty-row">${__('No dates scheduled yet')}</td></tr>` :
							dates.map(d => `
								<tr>
									<td><strong>${fmtDate(d.departure_date)}</strong></td>
									<td>${fmtDate(d.return_date)}</td>
									<td>${esc(d.ship_name || '-')}</td>
									<td>${d.max_participants || 0}</td>
									<td>
										<span class="${(d.current_participants||0) >= (d.max_participants||0) ? 'tcc-text-danger' : ''}">
											${d.current_participants || 0}
										</span>
									</td>
									<td>${badge(d.status || 'Active', STATUS_COLORS[d.status] || 'gray')}</td>
									<td>
										<button class="btn btn-default btn-xs tcc-edit-date" data-name="${esc(d.name)}">${__('Edit')}</button>
									</td>
								</tr>
							`).join('')}
						</tbody>
					</table>
				</div>
			</div>
		`);

		$('.tcc-add-date').on('click', function () {
			frappe.new_doc('Trip Group Date', { trip: $(this).data('trip') });
		});
		$('.tcc-edit-date').on('click', function () {
			frappe.set_route('Form', 'Trip Group Date', $(this).data('name'));
		});
	}

	async function load_trip_detail(trip_name) {
		// Called when switching to dates tab with selected trip
		await render_dates_tab();
	}

	/* ========== TAB 3: PACKAGES ========== */

	async function render_packages_tab() {
		const c = $('#tcc-content');
		if (!S.current_trip) {
			c.html(`
				<div class="tcc-select-prompt">
					<div class="tcc-prompt-icon">💰</div>
					<h3>${__('Package Manager')}</h3>
					<p>${__('Select a trip to manage pricing packages')}</p>
					<button class="btn btn-primary tcc-go-trips">${__('Go to Trips')}</button>
				</div>
			`);
			$('.tcc-go-trips').on('click', () => switch_to_tab('trips'));
			return;
		}

		c.html('<div class="tcc-loading"><div class="tcc-spinner"></div><p>' + __('Loading packages...') + '</p></div>');

		try {
			const data = await api('get_trip_packages', { trip_name: S.current_trip });
			render_packages_view(data);
		} catch (err) {
			c.html('<div class="tcc-error-state">' + __('Error loading packages') + '</div>');
		}
	}

	function render_packages_view(data) {
		const c = $('#tcc-content');
		const packages = data.packages || [];

		c.html(`
			<div class="tcc-packages-view">
				<div class="tcc-packages-header">
					<h3>${__('Pricing Packages')}</h3>
					<button class="btn btn-primary btn-sm tcc-add-package">+ ${__('New Package')}</button>
				</div>
				<div class="tcc-packages-grid">
					${!packages.length ? '<div class="tcc-empty-state">' + __('No packages yet') + '</div>' :
					packages.map(p => `
						<div class="tcc-package-card">
							<h4>${esc(p.package_title || p.name)}</h4>
							<span class="tcc-pkg-type">${badge(p.package_type || '-', 'blue')}</span>
							<p>${esc(p.airport_form || '')}</p>
							<div class="tcc-pkg-pricing">
								<small>${__('Starting from')}</small>
								<strong>${fmtMoney(p.min_price)}</strong>
							</div>
							<button class="btn btn-default btn-xs tcc-edit-pkg" data-name="${esc(p.name)}">${__('Edit Pricing')}</button>
						</div>
					`).join('')}
				</div>
			</div>
		`);

		$('.tcc-add-package').on('click', () => {
			frappe.new_doc('Trip Package', { trip_link: S.current_trip });
		});
		$('.tcc-edit-pkg').on('click', function () {
			frappe.set_route('Form', 'Trip Package', $(this).data('name'));
		});
	}

	/* ========== TAB 4: WEBSITE SETTINGS ========== */

	async function render_website_tab() {
		const c = $('#tcc-content');
		c.html('<div class="tcc-loading"><div class="tcc-spinner"></div><p>' + __('Loading website settings...') + '</p></div>');

		try {
			const [website_config, trips] = await Promise.all([
				api('get_website_settings'),
				api('get_published_trips'),
			]);
			render_website_view(website_config, trips);
		} catch (err) {
			c.html('<div class="tcc-error-state">' + __('Error loading website settings') + '</div>');
		}
	}

	function render_website_view(config, trips) {
		const c = $('#tcc-content');
		const wc = config || {};

		c.html(`
			<div class="tcc-website-view">
				<!-- Branding Section -->
				<div class="tcc-ws-section">
					<h3>🎨 ${__('Branding & Identity')}</h3>
					<div class="tcc-ws-grid">
						<div class="tcc-ws-field">
							<label>${__('Website Logo')}</label>
							<div class="tcc-ws-value">
								${wc.logo ? `<img src="${wc.logo}" style="max-height:60px" />` : '<span class="tcc-muted">' + __('Not set') + '</span>'}
							</div>
							<button class="btn btn-default btn-xs tcc-upload-logo">${__('Upload Logo')}</button>
						</div>
						<div class="tcc-ws-field">
							<label>${__('Footer Tagline')}</label>
							<div class="tcc-ws-value">${esc(wc.footer_tagline || '-')}</div>
						</div>
						<div class="tcc-ws-field">
							<label>${__('Support Email')}</label>
							<div class="tcc-ws-value">${esc(wc.support_email || '-')}</div>
						</div>
						<div class="tcc-ws-field">
							<label>${__('Social Media')}</label>
							<div class="tcc-ws-social">
								${wc.facebook ? `<a href="${wc.facebook}" target="_blank">📘 Facebook</a>` : ''}
								${wc.instagram ? `<a href="${wc.instagram}" target="_blank">📷 Instagram</a>` : ''}
								${wc.whatsapp ? `<a href="${wc.whatsapp}" target="_blank">💬 WhatsApp</a>` : ''}
							</div>
						</div>
					</div>
					<button class="btn btn-primary btn-sm tcc-open-website">${__('Open Website Settings Form')}</button>
				</div>

				<!-- Homepage Sections -->
				<div class="tcc-ws-section">
					<h3>🏠 ${__('Homepage Configuration')}</h3>
					<div class="tcc-ws-tabs">
						<button class="tcc-wstab active" data-wstab="cruise">${__('Cruise Page')}</button>
						<button class="tcc-wstab" data-wstab="tour">${__('Tour Page')}</button>
					</div>
					<div class="tcc-ws-content" id="tcc-ws-content">
						${render_homepage_section(wc, 'cruise')}
					</div>
				</div>

				<!-- Published Trips -->
				<div class="tcc-ws-section">
					<h3>✅ ${__('Published Trips on Website')}</h3>
					<div class="tcc-published-list">
						<table class="tcc-table">
							<thead>
								<tr>
									<th>${__('Trip')}</th>
									<th>${__('Type')}</th>
									<th>${__('Route')}</th>
									<th>${__('Status')}</th>
									<th>${__('Action')}</th>
								</tr>
							</thead>
							<tbody>
								${!(trips?.length) ? `<tr><td colspan="5" class="tcc-empty-row">${__('No published trips')}</td></tr>` :
								trips.map(t => `
									<tr>
										<td><strong>${esc(t.trip_name)}</strong></td>
										<td>${t.is_a_cruise_trip ? '🚢 Cruise' : '✈️ Tour'}</td>
										<td>${esc(t.route || '-')}</td>
										<td>${badge(t.published ? 'Published' : 'Draft', t.published ? 'green' : 'gray')}</td>
										<td>
											<a href="/${t.route}" target="_blank" class="btn btn-default btn-xs">${__('View Live')}</a>
											<button class="btn btn-default btn-xs tcc-edit-trip" data-name="${esc(t.name)}">${__('Edit')}</button>
										</td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
				</div>
			</div>
		`);

		// Bind events
		$('.tcc-wstab').on('click', function () {
			$('.tcc-wstab').removeClass('active');
			$(this).addClass('active');
			const tab = $(this).data('wstab');
			$('#tcc-ws-content').html(render_homepage_section(wc, tab));
		});

		$('.tcc-open-website').on('click', () => {
			frappe.set_route('Form', 'Travel Website');
		});
		$('.tcc-edit-trip').on('click', function () {
			frappe.set_route('Form', 'Trip', $(this).data('name'));
		});
	}

	function render_homepage_section(wc, type) {
		const prefix = type; // cruise or tour
		return `
			<div class="tcc-hp-section">
				<div class="tcc-hp-block">
					<h4>${__('Hero Section')}</h4>
					<p><strong>${__('Title')}</strong>: ${strip(wc[`${prefix}_hero_title`] || '-')}</p>
					<p><strong>${__('Subtitle')}</strong>: ${strip(wc[`${prefix}_hero_subtitle`] || '-')}</p>
				</div>
				<div class="tcc-hp-block">
					<h4>${__('Stats')}</h4>
					<div class="tcc-stats-row">
						${(wc[`${prefix}_hero_stats`] || []).map(s => `<span class="tcc-stat-item">${esc(s.label || '')}: <strong>${esc(s.value || '')}</strong></span>`).join('')}
					</div>
				</div>
				<div class="tcc-hp-block">
					<h4>${__('Benefits')}</h4>
					<div class="tcc-benefits-grid">
						${(wc[`${prefix}_benefits`] || []).map(b => `
							<div class="tcc-benefit-item">
								<span>${esc(b.icon || '⭐')}</span>
								<strong>${esc(b.title || '')}</strong>
								<p>${esc(b.description || '')}</p>
							</div>
						`).join('')}
					</div>
				</div>
				<div class="tcc-hp-block">
					<h4>${__('Testimonials')}</h4>
					${(wc[`${prefix}_testimonials`] || []).map(t => `
						<blockquote>
							<p>"${esc(t.content || '')}"</p>
							<footer>- ${esc(t.author || '')}</footer>
						</blockquote>
					`).join('')}
				</div>
			</div>
		`;
	}

	/* ========== TAB 5: CRUISE (Conditional) ========== */

	async function render_cruise_tab() {
		const c = $('#tcc-content');
		if (!S.current_trip) {
			c.html(`
				<div class="tcc-select-prompt">
					<div class="tcc-prompt-icon">🚢</div>
					<h3>${__('Cruise Schedule Manager')}</h3>
					<p>${__('Select a cruise trip to manage sailing schedules')}</p>
					<button class="btn btn-primary tcc-go-trips">${__('Go to Trips')}</button>
				</div>
			`);
			$('.tcc-go-trips').on('click', () => switch_to_tab('trips'));
			return;
		}

		c.html('<div class="tcc-loading"><div class="tcc-spinner"></div><p>' + __('Loading cruise schedules...') + '</p></div>');

		try {
			const data = await api('get_cruise_schedules', { trip_name: S.current_trip });
			render_cruise_view(data);
		} catch (err) {
			c.html('<div class="tcc-error-state">' + __('Error loading cruise data') + '</div>');
		}
	}

	function render_cruise_view(data) {
		const c = $('#tcc-content');
		const schedules = data.schedules || [];

		c.html(`
			<div class="tcc-cruise-view">
				<div class="tcc-cruise-header">
					<h3>${__('Cruise Schedules')}</h3>
					<button class="btn btn-primary btn-sm tcc-add-schedule">+ ${__('Add Schedule')}</button>
				</div>
				${!schedules.length ? '<div class="tcc-empty-state">' + __('No cruise schedules found') + '</div>' : 
				schedules.map(s => `
					<div class="tcc-schedule-card">
						<h4>🚢 ${esc(s.ship_name || s.ship_code || '-')}</h4>
						<div class="tcc-schedule-details">
							<div class="tcc-sched-field">
								<label>${__('Sailing Period')}</label>
								<span>${fmtDate(s.sail_start)} → ${fmtDate(s.sail_end)}</span>
							</div>
							<div class="tcc-sched-field">
								<label>${__('Route')}</label>
								<span>${esc(s.port_start || '-')} → ${esc(s.port_end || '-')}</span>
							</div>
							<div class="tcc-sched-field">
								<label>${__('Duration')}</label>
								<span>${s.total_days || 0} ${__('days')}</span>
							</div>
							<div class="tcc-sched-field">
								<label>${__('Cabin Rates')}</label>
								<span>${Object.keys(s.cabin_rates || {}).length} ${__('categories configured')}</span>
							</div>
						</div>
						<button class="btn btn-default btn-xs tcc-edit-schedule" data-name="${esc(s.name)}">${__('Edit Schedule')}</button>
					</div>
				`).join('')}
			</div>
		`);

		$('.tcc-add-schedule').on('click', () => {
			frappe.new_doc('Trip Cruise Schedule', { trip_link: S.current_trip });
		});
		$('.tcc-edit-schedule').on('click', function () {
			frappe.set_route('Form', 'Trip Cruise Schedule', $(this).data('name'));
		});
	}

	/* ========== UTILITIES ========== */

	function show_loading() { S.loading = true; $('#tcc-content').addClass('tcc-loading'); }
	function hide_loading() { S.loading = false; $('#tcc-content').removeClass('tcc-loading'); }
	function update_status(text) { $('#tcc-status-text').text(text); }

	function render_empty_state(title, sub) {
		$('#tcc-content').html(`<div class="tcc-empty-state"><div class="tcc-empty-icon">📭</div><h3>${esc(title)}</h3><p>${esc(sub || '')}</p></div>`);
	}
	function render_error_state(title, msg) {
		$('#tcc-content').html(`<div class="tcc-error-state"><div class="tcc-error-icon">⚠️</div><h3>${esc(title)}</h3><p>${esc(msg || '')}</p><button class="btn btn-default tcc-retry">${__('Retry')}</button></div>`);
		$('.tcc-retry').on('click', () => refresh_current_tab());
	}

	/* ========== CSS ========== */

	function inject_styles() {
		if (document.getElementById('tcc-page-css')) return;
		const css = `
		/* Trip Command Center Styles (.tcc-) */
		.tcc-container { display:flex; flex-direction:column; height:calc(100vh - 100px); background:#fff; border-radius:8px; overflow:hidden; }
		.tcc-toolbar { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid #e2e8f0; background:#f8fafc; }
		.tcc-toolbar-left,.tcc-toolbar-right { display:flex; align-items:center; gap:12px; }
		.tcc-search-box { position:relative; }
		.tcc-search-input { width:280px; padding:8px 12px 8px 32px; border:1px solid #cbd5e1; border-radius:6px; font-size:14px; }
		.tcc-search-icon { position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#94a3b8; }
		.tcc-tabs { display:flex; gap:4px; padding:12px 16px; border-bottom:1px solid #e2e8f0; background:#fff; }
		.tcc-tab { display:flex; align-items:center; gap:6px; padding:8px 16px; border:none; background:transparent; border-radius:6px; cursor:pointer; font-size:14px; font-weight:500; color:#64748b; transition:all .2s; }
		.tcc-tab:hover { background:#f1f5f9; color:#334155; }
		.tcc-tab.active { background:#3b82f6; color:white; }
		.tcc-tab-count { background:rgba(255,255,255,0.2); padding:2px 8px; border-radius:10px; font-size:12px; }
		.tcc-content { flex:1; overflow-y:auto; padding:16px; position:relative; }
		.tcc-statusbar { padding:8px 16px; border-top:1px solid #e2e8f0; background:#f8fafc; font-size:12px; color:#64748b; }
		.tcc-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:300px; color:#64748b; }
		.tcc-spinner { width:40px; height:40px; border:3px solid #e2e8f0; border-top:3px solid #3b82f6; border-radius:50%; animation:tcc-spin .8s linear infinite; }
		@keyframes tcc-spin { to { transform:rotate(360deg); } }
		.tcc-loading-small { padding:40px; text-align:center; }

		/* Badges */
		.tcc-badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; text-transform:uppercase; }
		.tcc-badge--green { background:#dcfce7; color:#166534; } .tcc-badge--blue { background:#dbeafe; color:#1e40af; }
		.tcc-badge--yellow { background:#fef9c3; color:#854d0e; } .tcc-badge--orange { background:#ffedd5; color:#9a3412; }
		.tcc-badge--red { background:#fee2e2; color:#991b1b; } .tcc-badge--gray { background:#f1f5f9; color:#475569; }

		/* Trip Cards Grid */
		.tcc-trips-filters { display:flex; gap:16px; margin-bottom:16px; }
		.tcc-select { padding:6px 10px; border:1px solid #cbd5e1; border-radius:4px; font-size:13px; min-width:150px; }
		.tcc-trips-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px; }
		.tcc-trip-card { background:white; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; cursor:pointer; transition:all .2s; }
		.tcc-trip-card:hover { box-shadow:0 4px 12px rgba(0,0,0,0.1); transform:translateY(-2px); }
		.tcc-trip-img { position:relative; height:160px; overflow:hidden; background:#f1f5f9; }
		.tcc-trip-img img { width:100%; height:100%; object-fit:cover; }
		.tcc-trip-badges { position:absolute; top:8px; left:8px; display:flex; gap:4px; flex-wrap:wrap; }
		.tcc-trip-body { padding:12px; }
		.tcc-trip-body h4 { margin:0 0 4px; font-size:15px; }
		.tcc-trip-route { font-size:12px; color:#64748b; margin:0 0 8px; }
		.tcc-trip-meta { display:flex; justify-content:space-between; font-size:12px; color:#94a3b8; margin-bottom:12px; }
		.tcc-trip-actions { display:flex; gap:8px; padding:0 12px 12px; }

		/* Tables */
		.tcc-table { width:100%; border-collapse:collapse; font-size:13px; }
		.tcc-table th { background:#f8fafc; padding:10px 12px; text-align:left; font-weight:600; color:#475569; border-bottom:2px solid #e2e8f0; }
		.tcc-table td { padding:10px 12px; border-bottom:1px solid #f1f5f9; }
		.tcc-table-striped tbody tr:nth-child(even) { background:#f8fafc; }
		.tcc-empty-row { text-align:center; color:#94a3b8; padding:20px; }
		.tcc-text-danger { color:#dc2626; font-weight:600; }

		/* Select Prompt */
		.tcc-select-prompt { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:400px; color:#64748b; text-align:center; padding:40px; }
		.tcc-prompt-icon { font-size:64px; margin-bottom:16px; }

		/* Package Cards */
		.tcc-packages-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-top:16px; }
		.tcc-package-card { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; }
		.tcc-package-card h4 { margin:0 0 8px; }
		.tcc-pkg-pricing { margin:12px 0; }
		.tcc-pkg-pricing small { font-size:11px; color:#94a3b8; }
		.tcc-pkg-pricing strong { font-size:18px; color:#22c55e; }

		/* Website Settings */
		.tcc-website-view { padding:0; }
		.tcc-ws-section { background:white; border-radius:8px; padding:20px; border:1px solid #e2e8f0; margin-bottom:16px; }
		.tcc-ws-section h3 { margin:0 0 16px; color:#1e293b; }
		.tcc-ws-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:16px; }
		.tcc-ws-field label { display:block; font-size:11px; font-weight:600; color:#64748b; margin-bottom:4px; text-transform:uppercase; }
		.tcc-ws-value { font-size:14px; color:#334155; margin-bottom:8px; }
		.tcc-ws-social a { margin-right:12px; color:#3b82f6; }
		.tcc-ws-tabs { display:flex; gap:8px; margin-bottom:16px; }
		.tcc-wstab { padding:6px 14px; border:1px solid #cbd5e1; background:white; border-radius:16px; cursor:pointer; font-size:13px; }
		.tcc-wstab.active { background:#3b82f6; color:white; border-color:#3b82f6; }
		.tcc-hp-section { padding:16px; background:#f8fafc; border-radius:8px; }
		.tcc-hp-block { margin-bottom:16px; }
		.tcc-hp-block h4 { margin:0 0 8px; color:#475569; }
		.tcc-stats-row { display:flex; gap:16px; flex-wrap:wrap; }
		.tcc-stat-item { background:white; padding:8px 12px; border-radius:4px; font-size:13px; }
		.tcc-benefits-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px; }
		.tcc-benefit-item { background:white; padding:12px; border-radius:6px; border:1px solid #e2e8f0; }
		.tcc-benefit-item strong { display:block; margin:4px 0; }
		.tcc-benefit-item p { margin:0; font-size:12px; color:#64748b; }
		blockquote { border-left:3px solid #3b82f6; padding:8px 16px; margin:8px 0; background:white; border-radius:0 4px 4px 0; }
		blockquote footer { font-size:12px; color:#64748b; }

		/* Cruise */
		.tcc-schedule-card { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:12px; }
		.tcc-schedule-card h4 { margin:0 0 12px; }
		.tcc-schedule-details { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:12px; }
		.tcc-sched-field label { display:block; font-size:11px; color:#64748b; margin-bottom:2px; }
		.tcc-sched-field span { font-size:14px; }

		/* Empty/Error States */
		.tcc-empty-state,.tcc-error-state { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:300px; color:#64748b; text-align:center; padding:40px; }
		.tcc-empty-icon,.tcc-error-icon { font-size:48px; margin-bottom:16px; }
		.tcc-empty-state h3,.tcc-error-state h3 { margin:0 0 8px; color:#475569; }
		.tcc-empty-state p,.tcc-error-state p { margin:0 0 16px; max-width:400px; }
		.tcc-muted { color:#94a3b8; }

		/* Responsive */
			@media(max-width:1024px){
				.tcc-trips-grid { grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); }
				.tcc-ws-grid { grid-template-columns:1fr; }
				.tcc-schedule-details { grid-template-columns:1fr 1fr; }
			}

			/* ===== UNIFIED TRIP VIEW STYLES (.tcc-unified-) ===== */
			
			.tcc-unified-header {
				display:flex;
				justify-content:space-between;
				align-items:center;
				padding:16px 20px;
				background:#f8fafc;
				border-bottom:1px solid #e2e8f0;
				margin-bottom:0;
				flex-wrap:wrap;
				gap:12px;
			}
			.tcc-unified-filters { display:flex; gap:8px; }
			.tcc-unified-actions { display:flex; gap:8px; }

			.tcc-unified-grid {
				display:flex;
				flex-direction:column;
				gap:12px;
			}

			/* Unified Trip Card */
			.tcc-unified-card {
				background:white;
				border:1px solid #e2e8f0;
				border-radius:10px;
				overflow:hidden;
				box-shadow:0 1px 3px rgba(0,0,0,0.04);
				transition:all .25s ease;
				margin:10px 0;
			}
			.tcc-unified-card:hover {
				box-shadow:0 4px 12px rgba(0,0,0,0.08);
			}
			.tcc-trip-expanded {
				background:#f8fafc;
				border-color:#3b82f6;
				border-left:4px solid #3b82f6;
			}

			/* Trip Header (Always Visible) */
			.tcc-trip-header {
				display:flex;
				align-items:center;
				gap:16px;
				padding:16px 20px;
				cursor:pointer;
				background:white;
				transition:background .15s;
			}
			.tcc-trip-header:hover { background:#f1f5f9; }
			.tcc-trip-expanded .tcc-trip-header { background:#eff6ff; cursor:default; }

			.tcc-trip-left { display:flex; align-items:center; gap:12px; flex:1; min-width:0; }
			.tcc-trip-img-small {
				width:60px;
				height:60px;
				border-radius:8px;
				overflow:hidden;
				flex-shrink:0;
			}
			.tcc-trip-img-small img { width:100%; height:100%; object-fit:cover; }
			
			.tcc-trip-info { flex:1; min-width:0; }
			.tcc-trip-info h4 {
				margin:0 0 4px;
				font-size:15px;
				color:#1e293b;
				display:flex;
				align-items:center;
				gap:6px;
			}
			.tcc-edit-link {
				font-size:14px;
				color:#94a3b8;
				cursor:pointer;
				opacity:0;
				transition:opacity .15s;
			}
			.tcc-edit-link:hover { opacity:1; color:#3b82f6; }
			.tcc-trip-route { font-size:12px; color:#64748b; margin:0 0 6px; }
			.tcc-trip-badges { display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; }

			.tcc-trip-right { display:flex; align-items:center; gap:12px; }
			.tcc-trip-stats { display:flex; gap:16px; }
			.tcc-stat { text-align:center; }
			.tcc-stat-label { display:block; font-size:10px; color:#94a3b8; text-transform:uppercase; font-weight:500; }
			.tcc-stat-value { display:block; font-size:16px; font-weight:700; color:#1e293b; }
			.tcc-price { color:#22c55e !important; font-size:18px !important; }

			.tcc-btn-expand {
				width:32px;
				height:32px;
				border:none;
				background:#f1f5f9;
				border-radius:6px;
				cursor:pointer;
				display:flex;
				align-items:center;
				justify-content:center;
				transition:all .2s;
				font-size:14px;
				color:#64748b;
			}
			.tcc-btn-expand:hover { background:#e2e8f0; }
			.tcc-btn-expand.active { background:#3b82f6; color:white; transform:rotate(180deg); }

			/* Expanded Content Area */
			.tcc-trip-expanded-content {
				border-top:1px solid #e2e8f0;
				background:white;
				animation:tcc-slideDown .2s ease-out;
			}
			@keyframes tcc-slideDown {
				from { opacity:0; transform:translateY(-10px); }
				to { opacity:1; transform:translateY(0); }
			}

			/* Sections within expanded content */
			.tcc-section { margin-bottom:20px; padding:20px; }
			.tcc-section:last-child { margin-bottom:0; }
			.tcc-section-header {
				display:flex;
				justify-content:space-between;
				align-items:center;
				margin-bottom:12px;
				padding-bottom:8px;
				border-bottom:1px solid #f1f5f9;
			}
			.tcc-section-header h4 { margin:0; font-size:14px; color:#334155; }

			/* Dates Table */
			.tcc-dates-table-wrapper { overflow-x:auto; }
			.tcc-date-row { transition:background .15s; }
			.tcc-date-row:hover { background:#f8fafc; }
			/* Cruise sailing date styling */
			.tcc-sailing-date {
				color:#0369a1;
				font-weight:600;
				background:#e0f2fe;
				padding:2px 6px;
				border-radius:3px;
			}
			/* Cruise sailing return date styling */
			.tcc-sailing-return {
				color:#be123c;
				font-weight:600;
				background:#fef2f2;
				padding:2px 6px;
				border-radius:3px;
			}
			.tcc-empty-row td { text-align:center; padding:20px !important; }
			.tcc-empty-hint { color:#64748b; margin-bottom:8px; }
			.tcc-text-danger { color:#ef4444; font-weight:600; }

			/* Packages Grid */
			.tcc-packages-grid {
					display:grid;
					grid-template-columns:repeat(4, 1fr);
					gap:12px;
				}
			.tcc-pkg-card {
				background:white;
				border:1px solid #e2e8f0;
				border-radius:8px;
				padding:16px;
				transition:all .2s;
			}
			.tcc-pkg-card:hover { box-shadow:0 2px 8px rgba(0,0,0,0.08); border-color:#cbd5e1; }
			.tcc-pkg-header { display:flex; justify-content:space-between; align-items:start; margin-bottom:8px; }
				.tcc-pkg-header h5 { margin:0; font-size:14px; color:#1e293b; flex:1; }
				.tcc-pkg-badges { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
				.tcc-pkg-type-badge { font-size:10px; }
				.tcc-pkg-status-badge { font-size:10px; margin-left:auto; }
			.tcc-pkg-body { min-height:80px; }
				.tcc-pkg-body p { font-size:12px; color:#64748b; margin:0 0 8px; line-height:1.4; }
			.tcc-pricing { margin:8px 0; padding:8px 0; background:#f0fdf4; border-radius:4px; text-align:center; }
			.tcc-price-highlight { font-size:20px; color:#22c55e; }
			.tcc-pkg-actions { display:flex; gap:6px; margin-top:8px; justify-content:flex-end; }

			/* Quick Actions Bar */
			.tcc-quick-actions-bar {
				display:flex;
				align-items:center;
				gap:8px;
				padding:12px 16px;
				background:#f8fafc;
				border-top:1px solid #e2e8f0;
				border-radius:0 0 8px 0;
				font-size:13px;
			}
			.tcc-qa-item a { color:#3b82f6; text-decoration:none; font-weight:500; }
			.tcc-qa-item a:hover { text-decoration:underline; }
			.tcc-separator { color:#cbd5e1; }

				/* Loading inline */
				.tcc-loading-inline { text-align:center; color:#94a3b8; }
				.tcc-spinner-small { width:24px; height:24px; border:2px solid #e2e8f0; border-top:2px solid #3b82f6; border-radius:50%; animation:tcc-spin .8s linear infinite; display:inline-block; vertical-align:middle; margin-right:4px; }
				@keyframes tcc-spin { to { transform:rotate(360deg); } }

					`;
			const s = document.createElement('style'); s.id = 'tcc-page-css'; s.textContent = css; document.head.appendChild(s);
		}

	return { init, on_show };
})();
