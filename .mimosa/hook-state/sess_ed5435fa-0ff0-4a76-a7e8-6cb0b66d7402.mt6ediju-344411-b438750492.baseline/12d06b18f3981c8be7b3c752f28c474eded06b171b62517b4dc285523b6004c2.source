// travel_booking/travel_booking_management/page/dashboard_reports/dashboard_reports.js
// Desk Page /app/dashboard-reports — Dashboard & Analytics untuk Tour Operator
//
// Menyediakan:
// - KPI Cards (Revenue, Bookings, Occupancy, etc.)
// - Charts & Visualizations
// - Operational Reports
// - Export Functions

frappe.pages['dashboard-reports'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Dashboard & Reports'),
		single_column: false,
	});
	DashboardReports.init(page, wrapper);
};

frappe.pages['dashboard-reports'].on_page_show = function () {
	if (window.DashboardReports) DashboardReports.on_show();
};

/* ============================================================
   DashboardReports — controller (IIFE)
   ============================================================ */
window.DashboardReports = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const S = {
		page: null,
		wrapper: null,
		current_tab: 'overview', // overview | bookings | revenue | operations | reports
		date_range: '30d', // 7d | 30d | 90d | 12m | custom
		custom_from: '',
		custom_to: '',
		loading: false,
	};

	const fmtDate = (iso) => {
		if (!iso) return '';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return String(iso);
		return parseInt(m[3], 10) + '/' + parseInt(m[2], 10) + '/' + m[1];
	};

	const fmtMoney = (n) =>
		'RM' + parseFloat(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

	const fmtPercent = (n) => parseFloat(n || 0).toFixed(1) + '%';

	const api = (method, args = {}) =>
		new Promise((resolve, reject) => {
			frappe.call({
				method: 'travel_booking.api.dashboard_reports.' + method,
				args,
				freeze: false,
			})
			.then(r => resolve(r?.message ?? null))
			.catch(err => {
				console.error('Dashboard API Error:', method, err);
				frappe.show_alert({ message: __('Error loading data'), indicator: 'red' }, 5);
				reject(err);
			});
		});

	function init(page, wrapper) {
		S.page = page;
		S.wrapper = wrapper;

		inject_styles();
		build_layout();
		setup_tabs();
		setup_date_range();
		load_tab('overview');
	}

	function on_show() { if (S.current_tab) load_tab(S.current_tab); }

	/* ========== LAYOUT ========== */

	function build_layout() {
		$(S.wrapper).find('.layout-main-section').html(`
			<div id="dr-container" class="dr-container">
				<div id="dr-toolbar" class="dr-toolbar">
					<div class="dr-toolbar-left">
						<h3>${__('Travel Booking Dashboard')}</h3>
						<span class="dr-date-display" id="dr-date-display">${__('Last 30 days')}</span>
					</div>
					<div class="dr-toolbar-right">
						<select id="dr-date-range" class="dr-select">
							<option value="7d" selected>${__('Last 7 Days')}</option>
							<option value="30d">${__('Last 30 Days')}</option>
							<option value="90d">${__('Last 90 Days')}</option>
							<option value="12m">${__('Last 12 Months')}</option>
							<option value="custom">${__('Custom Range')}</option>
						</select>
						<button class="btn btn-default btn-xs dr-refresh" id="dr-refresh">🔄 ${__('Refresh')}</button>
						<button class="btn btn-default btn-xs dr-export" id="dr-export">📊 ${__('Export')}</button>
					</div>
				</div>

				<div id="dr-tabs" class="dr-tabs">
					<button class="dr-tab active" data-tab="overview">📈 ${__('Overview')}</button>
					<button class="dr-tab" data-tab="bookings">📋 ${__('Bookings')}</button>
					<button class="dr-tab" data-tab="revenue">💰 ${__('Revenue')}</button>
					<button class="dr-tab" data-tab="operations">⚙️ ${__('Operations')}</button>
					<button class="dr-tab" data-tab="reports">📑 ${__('Reports')}</button>
				</div>

				<div id="dr-content" class="dr-content">
					<div class="dr-loading"><div class="dr-spinner"></div><p>${__('Loading...')}</p></div>
				</div>

				<div id="dr-statusbar" class="dr-statusbar"><span id="dr-status-text">${__('Ready')}</span></div>
			</div>
		`);
	}

	/* ========== TABS ========== */

	function setup_tabs() {
		$(document).off('click', '.dr-tab').on('click', '.dr-tab', function () {
			switch_to_tab($(this).data('tab'));
		});
	}

	function switch_to_tab(tab) {
		S.current_tab = tab;
		$('.dr-tab').removeClass('active');
		$(`.dr-tab[data-tab="${tab}"]`).addClass('active');
		load_tab(tab);
	}

	async function load_tab(tab) {
		show_loading();
		try {
			switch (tab) {
				case 'overview': await render_overview(); break;
				case 'bookings': await render_bookings(); break;
				case 'revenue': await render_revenue(); break;
				case 'operations': await render_operations(); break;
				case 'reports': await render_reports(); break;
				default: render_empty_state(__('Unknown'), tab);
			}
		} catch (err) {
			render_error_state(__('Error'), err.message);
		}
		hide_loading();
		update_status(__('Ready'));
	}

	/* ========== DATE RANGE ========== */

	function setup_date_range() {
		$('#dr-date-range').on('change', function () {
			S.date_range = $(this).val();
			
			if (S.date_range === 'custom') {
				show_custom_date_picker();
			} else {
				$('#dr-custom-dates').remove();
				update_date_display();
				load_tab(S.current_tab);
			}
		});

		$('#dr-refresh').on('click', () => load_tab(S.current_tab));
		$('#dr-export').on('click', () => export_current_view());
	}

	function show_custom_date_picker() {
		if ($('#dr-custom-dates').length) return;

		$('#dr-date-range').after(`
			<div id="dr-custom-dates" class="dr-custom-dates">
				<input type="date" id="dr-from" class="dr-input" />
				<span>—</span>
				<input type="date" id="dr-to" class="dr-input" />
				<button class="btn btn-default btn-xs dr-apply-custom">Apply</button>
			</div>
		`);

		// Set defaults (last 30 days)
		const today = new Date();
		const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
		$('#dr-from').val(thirtyDaysAgo.toISOString().split('T')[0]);
		$('#dr-to').val(today.toISOString().split('T')[0]);

		$('.dr-apply-custom').on('click', function () {
			S.custom_from = $('#dr-from').val();
			S.custom_to = $('#dr-to').val();
			update_date_display();
			load_tab(S.current_tab);
		});
	}

	function get_date_filter() {
		const today = new Date().toISOString().split('T')[0];
		
		switch (S.date_range) {
			case '7d':
				const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
				return { from: weekAgo, to: today };
			case '30d':
				const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
				return { from: monthAgo, to: today };
			case '90d':
				const quarterAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
				return { from: quarterAgo, to: today };
			case '12m':
				const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
				return { from: yearAgo, to: today };
			case 'custom':
				return { from: S.custom_from, to: S.custom_to };
			default:
				return { from: '', to: today };
		}
	}

	function update_date_display() {
		const labels = {
			'7d': 'Last 7 Days',
			'30d': 'Last 30 Days',
			'90d': 'Last 90 Days',
			'12m': 'Last 12 Months',
			'custom': `${S.custom_from} to ${S.custom_to}`,
		};
		$('#dr-date-display').text(labels[S.date_range] || 'Custom Range');
	}

	/* ========== TAB 1: OVERVIEW (KPIs) ========== */

	async function render_overview() {
		const c = $('#dr-content');
		c.html('<div class="dr-loading"><div class="dr-spinner"></div><p>' + __('Loading dashboard...') + '</p></div>');

		const dates = get_date_filter();
		
		try {
			const [kpi, recent_bookings, upcoming] = await Promise.all([
				api('get_kpi_data', dates),
				api('get_recent_bookings', { limit: 10 }),
				api('get_upcoming_departures', { limit: 5 }),
			]);

			c.html(`
				<!-- KPI Cards -->
				<div class="dr-kpi-grid">
					<div class="dr-kpi-card dr-kpi--primary">
						<div class="dr-kpi-icon">💰</div>
						<div class="dr-kpi-body">
							<h4>${__('Total Revenue')}</h4>
							<p class="dr-kpi-value">${fmtMoney(kpi?.total_revenue || 0)}</p>
							<small class="${(kpi?.revenue_change || 0) >= 0 ? 'dr-positive' : 'dr-negative'}">
								${(kpi?.revenue_change || 0) >= 0 ? '↑' : '↓'} ${Math.abs(kpi?.revenue_change || 0)}% vs prev period
							</small>
						</div>
					</div>
					<div class="dr-kpi-card dr-kpi--success">
						<div class="dr-kpi-icon">📋</div>
						<div class="dr-kpi-body">
							<h4>${__('Total Bookings')}</h4>
							<p class="dr-kpi-value">${kpi?.total_bookings || 0}</p>
							<small class="${(kpi?.booking_change || 0) >= 0 ? 'dr-positive' : 'dr-negative'}">
								${(kpi?.booking_change || 0) >= 0 ? '↑' : '↓'} ${Math.abs(kpi?.booking_change || 0)}% vs prev period
							</small>
						</div>
					</div>
					<div class="dr-kpi-card dr-kpi--warning">
						<div class="dr-kpi-icon">👥</div>
						<div class="dr-kpi-body">
							<h4>${__('Total Travellers')}</h4>
							<p class="dr-kpi-value">${kpi?.total_travellers || 0}</p>
							<small>Avg ${kpi?.avg_pax_per_booking || 0} pax/booking</small>
						</div>
					</div>
					<div class="dr-kpi-card dr-kpi--danger">
						<div class="dr-kpi-icon">⏳</div>
						<div class="dr-kpi-body">
							<h4>${__('Pending Payments')}</h4>
							<p class="dr-kpi-value">${fmtMoney(kpi?.pending_payments || 0)}</p>
							<small>${kpi?.pending_count || 0} bookings awaiting payment</small>
						</div>
					</div>
				</div>

				<!-- Charts Row -->
				<div class="dr-charts-row">
					<div class="dr-chart-card">
						<h4>📈 ${__('Booking Trend')}</h4>
						<div id="dr-booking-trend" class="dr-chart-placeholder">
							<canvas id="bookingTrendChart"></canvas>
						</div>
					</div>
					<div class="dr-chart-card">
						<h4>💰 ${__('Revenue by Type')}</h4>
						<div id="dr-revenue-breakdown" class="dr-chart-placeholder">
							<canvas id="revenueBreakdownChart"></canvas>
						</div>
					</div>
				</div>

				<!-- Recent Activity -->
				<div class="dr-section">
					<div class="dr-half">
						<h4>🕐 ${__('Recent Bookings')}</h4>
						<table class="dr-table">
							<thead><tr><th>Booking</th><th>Customer</th><th>Trip</th><th>Amount</th><th>Status</th></tr></thead>
							<tbody>
								${!(recent_bookings?.length) ? '<tr><td colspan="5" class="dr-empty">No recent bookings</td></tr>' :
								recent_bookings.map(b => `
									<tr>
										<td><strong>${esc(b.name)}</strong></td>
										<td>${esc(b.customer_name)}</td>
										<td>${esc(b.trip_name)}</td>
										<td>${fmtMoney(b.total_amount)}</td>
										<td><span class="dr-badge dr-badge--${b.status === 'Confirmed' ? 'green' : b.status === 'Pending' ? 'orange' : 'blue'}">${b.status}</span></td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
					<div class="dr-half">
						<h4>✈️ ${__('Upcoming Departures')}</h4>
						<table class="dr-table">
							<thead><tr><th>Date</th><th>Trip</th><th>Pax</th><th>Occupancy</th></tr></thead>
							<tbody>
								${!(upcoming?.length) ? '<tr><td colspan="4" class="dr-empty">No upcoming departures</td></tr>' :
								upcoming.map(u => `
									<tr>
										<td><strong>${fmtDate(u.departure_date)}</strong></td>
										<td>${esc(u.trip_name)}</td>
										<td>${u.booked_pax || 0}/${u.max_participants || 0}</td>
										<td>
											<div class="dr-progress-small">
												<div class="dr-progress-fill" style="width:${u.occupancy_pct || 0}%"></div>
											</div>
											<small>${fmtPercent(u.occupancy_pct || 0)}</small>
										</td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
				</div>
			`);

			// Render charts if Chart.js available
			if (typeof Chart !== 'undefined') {
				render_booking_trend_chart(kpi?.booking_trend || []);
				render_revenue_breakdown_chart(kpi?.revenue_breakdown || []);
			}

		} catch (err) {
			c.html('<div class="dr-error-state">' + __('Error loading dashboard') + '</div>');
		}
	}

	function render_booking_trend_chart(data) {
		const ctx = document.getElementById('bookingTrendChart');
		if (!ctx) return;
		
		new Chart(ctx.getContext('2d'), {
			type: 'line',
			data: {
				labels: data.map(d => d.date),
				datasets: [{
					label: 'Bookings',
					data: data.map(d => d.count),
					borderColor: '#3b82f6',
					backgroundColor: 'rgba(59,130,246,0.1)',
					fill: true,
					tension: 0.4,
				}]
			},
			options: {
				responsive: true,
				plugins: { legend: { display: false } },
				scales: { y: { beginAtZero: true } }
			}
		});
	}

	function render_revenue_breakdown_chart(data) {
		const ctx = document.getElementById('revenueBreakdownChart');
		if (!ctx) return;
		
		new Chart(ctx.getContext('2d'), {
			type: 'doughnut',
			data: {
				labels: data.map(d => d.type),
				datasets: [{
					data: data.map(d => d.amount),
					backgroundColor: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'],
				}]
			},
			options: {
				responsive: true,
				plugins: { legend: { position: 'bottom' } }
			}
		});
	}

	/* ========== TAB 2: BOOKINGS ANALYSIS ========== */

	async function render_bookings() {
		const c = $('#dr-content');
		c.html('<div class="dr-loading"><div class="dr-spinner"></div></div>');

		const dates = get_date_filter();

		try {
			const [by_status, by_trip, conversion] = await Promise.all([
				api('get_bookings_by_status', dates),
				api('get_bookings_by_trip', dates),
				api('get_conversion_funnel', dates),
			]);

			c.html(`
				<div class="dr-bookings-view">
					<!-- Status Breakdown -->
					<div class="dr-charts-row">
						<div class="dr-chart-card">
							<h4>${__('Bookings by Status')}</h4>
							<div id="dr-status-chart"><canvas id="statusChart"></canvas></div>
						</div>
						<div class="dr-chart-card">
							<h4>${__('Conversion Funnel')}</h4>
							<div class="dr-funnel">
								${conversion?.map((step, i) => `
									<div class="dr-funnel-step" style="width:${step.pct || 100}%">
										<span class="dr-funnel-label">${esc(step.label)}</span>
										<span class="dr-funnel-count">${step.count}</span>
									</div>
								`).join('') || '<p>No data</p'}
							</div>
						</div>
					</div>

					<!-- Top Trips Table -->
					<div class="dr-section">
						<h4>🏆 ${__('Top Performing Trips')}</h4>
						<table class="dr-table">
							<thead>
								<tr><th>Trip</th><th>Type</th><th>Bookings</th><th>Revenue</th><th>Avg Price</th><th>Occupancy</th></tr>
							</thead>
							<tbody>
								${!(by_trip?.length) ? '<tr><td colspan="6" class="dr-empty">No data</td></tr>' :
								by_trip.map(t => `
									<tr>
										<td><strong>${esc(t.trip_name)}</strong></td>
										<td>${t.is_cruise ? '🚢 Cruise' : '✈️ Tour'}</td>
										<td>${t.booking_count || 0}</td>
										<td>${fmtMoney(t.revenue || 0)}</td>
										<td>${fmtMoney(t.avg_price || 0)}</td>
										<td>${fmtPercent(t.occupancy || 0)}</td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
				</div>
			`);

			if (typeof Chart !== 'undefined' && by_status?.length) {
				new Chart(document.getElementById('statusChart').getContext('2d'), {
					type: 'bar',
					data: {
						labels: by_status.map(s => s.status),
						datasets: [{
							label: 'Bookings',
							data: by_status.map(s => s.count),
							backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#6b7280'],
						}]
					},
					options: {
						responsive: true,
						indexAxis: 'y',
						plugins: { legend: { display: false } }
					}
				});
			}

		} catch (err) {
			c.html('<div class="dr-error-state">' + __('Error loading bookings data') + '</div>');
		}
	}

	/* ========== TAB 3: REVENUE ANALYSIS ========== */

	async function render_revenue() {
		const c = $('#dr-content');
		c.html('<div class="dr-loading"><div class="dr-spinner"></div></div>');

		const dates = get_date_filter();

		try {
			const [monthly, by_source, by_package] = await Promise.all([
				api('get_monthly_revenue', dates),
				api('get_revenue_by_source', dates),
				api('get_revenue_by_package', dates),
			]);

			c.html(`
				<div class="dr-revenue-view">
					<!-- Revenue Trend -->
					<div class="dr-chart-card dr-full-width">
						<h4>📈 ${__('Monthly Revenue Trend')}</h4>
						<div id="dr-monthly-revenue"><canvas id="monthlyRevenueChart"></canvas></div>
					</div>

					<div class="dr-charts-row">
						<div class="dr-chart-card">
							<h4>${__('Revenue by Source')}</h4>
							<div id="dr-source-chart"><canvas id="sourceChart"></canvas></div>
						</div>
						<div class="dr-chart-card">
							<h4>${__('Top Packages by Revenue')}</h4>
							<table class="dr-table dr-table-sm">
								<thead><tr><th>Package</th><th>Sales</th><th>Revenue</th></tr></thead>
								<tbody>
									${!(by_package?.length) ? '<tr><td colspan="3" class="dr-empty">No data</td></tr>' :
									by_package.slice(0, 8).map(p => `
										<tr>
											<td>${esc(p.package_title || p.name)}</td>
											<td>${p.sales_count || 0}</td>
											<td><strong>${fmtMoney(p.revenue || 0)}</strong></td>
										</tr>
									`).join('')}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			`);

			if (typeof Chart !== 'undefined') {
				if (monthly?.length) {
					new Chart(document.getElementById('monthlyRevenueChart').getContext('2d'), {
						type: 'bar',
						data: {
							labels: monthly.map(m => m.month),
							datasets: [{
								label: 'Revenue',
								data: monthly.map(m => m.revenue),
								backgroundColor: '#22c55e',
							}]
						},
						options: { responsive: true, plugins: { legend: { display: false } } }
					});
				}

				if (by_source?.length) {
					new Chart(document.getElementById('sourceChart').getContext('2d'), {
						type: 'pie',
						data: {
							labels: by_source.map(s => s.source),
							datasets: [{ data: by_source.map(s => s.amount), backgroundColor: ['#3b82f6','#22c55e','#f59e0b','#ef4444'] }]
						},
						options: { responsive: true, plugins: { legend: { position: 'right' } } }
					});
				}
			}

		} catch (err) {
			c.html('<div class="dr-error-state">' + __('Error loading revenue data') + '</div>');
		}
	}

	/* ========== TAB 4: OPERATIONS ========== */

	async function render_operations() {
		const c = $('#dr-content');
		c.html('<div class="dr-loading"><div class="dr-spinner"></div></div>');

		try {
			const [pending_docs, overdue_payments, capacity_alerts] = await Promise.all([
				api('get_pending_documents'),
				api('get_overdue_payments'),
				api('get_capacity_alerts'),
			]);

			c.html(`
				<div class="dr-ops-view">
					<!-- Alerts Section -->
					<div class="dr-alerts-grid">
						<div class="dr-alert-card dr-alert--warning">
							<h4>⚠️ ${__('Pending Documents')}</h4>
							<p class="dr-alert-count">${pending_docs?.count || 0}</p>
							<small>${__('Travellers with incomplete documentation')}</small>
							<button class="btn btn-default btn-xs dr-action-btn" data-action="documents">${__('View All')}</button>
						</div>
						<div class="dr-alert-card dr-alert--danger">
							<h4>💸 ${__('Overdue Payments')}</h4>
							<p class="dr-alert-count">${overdue_payments?.count || 0}</p>
							<small>${fmtMoney(overdue_payments?.amount || 0)} ${__('outstanding')}</small>
							<button class="btn btn-default btn-xs dr-action-btn" data-action="payments">${__('View All')}</button>
						</div>
						<div class="dr-alert-card dr-alert--info">
							<h4>📊 ${__('Capacity Alerts')}</h4>
							<p class="dr-alert-count">${capacity_alerts?.count || 0}</p>
							<small>${__('departures nearing capacity')}</small>
							<button class="btn btn-default btn-xs dr-action-btn" data-action="capacity">${__('View All')}</button>
						</div>
					</div>

					<!-- Pending Documents List -->
					<div class="dr-section">
						<h4>📄 ${__('Document Verification Queue')}</h4>
						<table class="dr-table">
							<thead>
								<tr><th>Traveller</th><th>Booking</th><th>Doc Type</th><th>Status</th><th>Due Date</th></tr>
							</thead>
							<tbody>
								${!(pending_docs?.items?.length) ? '<tr><td colspan="5" class="dr-empty">All documents verified!</td></tr>' :
								pending_docs.items.slice(0, 10).map(d => `
									<tr>
										<td>${esc(d.traveller_name)}</td>
										<td>${esc(d.booking)}</td>
										<td>${esc(d.doc_type || 'Passport')}</td>
										<td><span class="dr-badge dr-badge--orange">${d.status}</span></td>
										<td>${fmtDate(d.due_date)}</td>
									</tr>
								`).join('')}
							</tbody>
						</table>
					</div>
				</div>
			`);

			$('.dr-action-btn').on('click', function () {
				const action = $(this).data('action');
				if (action === 'documents') switch_to_tab('active'); // Would go to booking hub
				else if (action === 'payments') switch_to_tab('payment');
			});

		} catch (err) {
			c.html('<div class="dr-error-state">' + __('Error loading operations data') + '</div>');
		}
	}

	/* ========== TAB 5: REPORTS ========== */

	async function render_reports() {
		const c = $('#dr-content');

		c.html(`
			<div class="dr-reports-view">
				<h3>📑 ${__('Available Reports')}</h3>
				<div class="dr-reports-grid">
					<div class="dr-report-card" data-report="sales-summary">
						<div class="dr-report-icon">📊</div>
						<h4>${__('Sales Summary Report')}</h4>
						<p>${__('Comprehensive sales performance overview')}</p>
						<button class="btn btn-primary btn-sm dr-generate-report">${__('Generate')}</button>
					</div>
					<div class="dr-report-card" data-report="booking-list">
						<div class="dr-report-icon">📋</div>
						<h4>${__('Booking List')}</h4>
						<p>${__('Complete list of all bookings with filters')}</p>
						<button class="btn btn-primary btn-sm dr-generate-report">${__('Generate')}</button>
					</div>
					<div class="dr-report-card" data-report="traveller-manifest">
						<div class="dr-report-icon">👥</div>
						<h4>${__('Traveller Manifest')}</h4>
						<p>${__('Passenger manifest for specific trip/date')}</p>
						<button class="btn btn-primary btn-sm dr-generate-report">${__('Generate')}</button>
					</div>
					<div class="dr-report-card" data-report="revenue-by-trip">
						<div class="dr-report-icon">💰</div>
						<h4>${__('Revenue by Trip')}</h4>
						<p>${__('Revenue breakdown per trip/product')}</p>
						<button class="btn btn-primary btn-sm dr-generate-report">${__('Generate')}</button>
					</div>
					<div class="dr-report-card" data-report="payment-tracking">
						<div class="dr-report-icon">💳</div>
						<h4>${__('Payment Tracking')}</h4>
						<p>${__('Payment status and collection report')}</p>
						<button class="btn btn-primary btn-sm dr-generate-report">${__('Generate')}</button>
					</div>
					<div class="dr-report-card" data-report="addon-sales">
						<div class="dr-report-icon">🎁</div>
						<h4>${__('Addon Sales Report')}</h4>
						<p>${__('Upsell and addon revenue analysis')}</p>
						<button class="btn btn-primary btn-sm dr-generate-report">${__('Generate')}</button>
					</div>
				</div>
			</div>
		`);

		$('.dr-generate-report').on('click', function () {
			const report = $(this).closest('.dr-report-card').data('report');
			generate_report(report);
		});
	}

	function generate_report(report_type) {
		frappe.msgprint({
			title: __('Generating Report'),
			message: `<p>${__('Generating')} <strong>${report_type}</strong>...</p>
				<p>This will download a CSV/Excel file with the report data.</p>`,
			indicator: 'blue',
		});

		// In production, this would call an API endpoint that generates and returns the file
		api('generate_report', { report_type, date_range: S.date_range }).then(result => {
			if (result?.file_url) {
				window.open(result.file_url, '_blank');
			}
		});
	}

	function export_current_view() {
		// Export current tab data as CSV
		frappe.msgprint({
			title: __('Export Data'),
			message: `<p>${__('Exporting current view as CSV...')}</p>
				<p>This feature will be implemented with actual data export.</p>`,
			indicator: 'blue',
		});
	}

	/* ========== UTILITIES ========== */

	function show_loading() { S.loading = true; $('#dr-content').addClass('dr-loading'); }
	function hide_loading() { S.loading = false; $('#dr-content').removeClass('dr-loading'); }
	function update_status(text) { $('#dr-status-text').text(text); }

	function render_empty_state(title, sub) {
		$('#dr-content').html(`<div class="dr-empty-state"><div class="dr-empty-icon">📭</div><h3>${esc(title)}</h3><p>${esc(sub||'')}</p></div>`);
	}
	function render_error_state(title, msg) {
		$('#dr-content').html(`<div class="dr-error-state"><div class="dr-error-icon">⚠️</div><h3>${esc(title)}</h3><p>${esc(msg||'')}</p><button class="btn btn-default dr-retry">${__('Retry')}</button></div>`);
		$('.dr-retry').on('click', () => load_tab(S.current_tab));
	}

	/* ========== CSS ========== */

	function inject_styles() {
		if (document.getElementById('dr-page-css')) return;
		const css = `
		/* Dashboard Reports Styles (.dr-) */
		.dr-container{display:flex;flex-direction:column;height:calc(100vh-100px);background:#fff;border-radius:8px;overflow:hidden}
		.dr-toolbar{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #e2e8f0;background:#f8fafc}
		.dr-toolbar-left{display:flex;align-items:center;gap:16px}
		.dr-toolbar-left h3{margin:0;font-size:18px;color:#1e293b}
		.dr-date-display{font-size:13px;color:#64748b;background:#e2e8f0;padding:4px 12px;border-radius:12px}
		.dr-toolbar-right{display:flex;align-items:center;gap:8px}
		.dr-select{padding:6px 10px;border:1px solid #cbd5e1;border-radius:4px;font-size:13px}
		.dr-tabs{display:flex;gap:4px;padding:12px 20px;border-bottom:1px solid #e2e8f0;background:#fff}
		.dr-tab{padding:8px 16px;border:none;background:transparent;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;color:#64748b;transition:all .2s}
		.dr-tab:hover{background:#f1f5f9;color:#334155}
		.dr-tab.active{background:#3b82f6;color:white}
		.dr-content{flex:1;overflow-y:auto;padding:20px;position:relative}
		.dr-statusbar{padding:8px 20px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:12px;color:#64748b}
		.dr-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:400px;color:#64748b}
		.dr-spinner{width:40px;height:40px;border:3px solid #e2e8f0;border-top:3px solid #3b82f6;border-radius:50%;animation:dr-spin .8s linear infinite}
		@keyframes dr-spin{to{transform:rotate(360deg)}}
		.dr-custom-dates{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:6px 10px;background:white;border:1px solid #cbd5e1;border-radius:4px}
		.dr-custom-dates .dr-input{border:1px solid #e2e8f0;padding:4px 6px;border-radius:3px;font-size:12px;width:130px}

		/* KPI Cards */
		.dr-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
		.dr-kpi-card{background:white;border-radius:8px;padding:20px;display:flex;align-items:center;gap:16px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
		.dr-kpi-icon{font-size:36px}
		.dr-kpi-body h4{margin:0 0 4px;font-size:12px;color:#64748b;text-transform:uppercase;font-weight:600}
		.dr-kpi-value{margin:0;font-size:28px;font-weight:700;color:#1e293b}
		.dr-kpi-body small{font-size:12px}
		.dr-positive{color:#22c55e}.dr-negative{color:#ef4444}

		/* Charts */
		.dr-charts-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:16px;margin-bottom:24px}
		.dr-chart-card{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:16px}
		.dr-chart-card h4{margin:0 0 12px;font-size:14px;color:#475569}
		.dr-chart-placeholder{min-height:250px;position:relative}
		.dr-full-width{grid-column:1/-1}

		/* Tables */
		.dr-table{width:100%;border-collapse:collapse;font-size:13px}
		.dr-table th{background:#f8fafc;padding:10px;text-align:left;font-weight:600;color:#475569;border-bottom:2px solid #e2e8f0}
		.dr-table td{padding:10px;border-bottom:1px solid #f1f5f9}
		.dr-table-sm{font-size:12px}
		.dr-table-sm td,.dr-table-sm th{padding:6px 8px}
		.dr-empty{text-align:center;color:#94a3b8;padding:20px}
		.dr-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
		.dr-badge--green{background:#dcfce7;color:#166534}.dr-badge--blue{background:#dbeafe;color:#1e40af}
		.dr-badge--orange{background:#fef9c3;color:#854d0e}.dr-badge--red{background:#fee2e2;color:#991b1b}

		/* Sections */
		.dr-section{margin-bottom:24px}
		.dr-section h4{margin:0 0 12px;font-size:15px;color:#1e293b}
		.dr-half{display:inline-block;vertical-align:top;width:calc(50% - 8px)}
		.dr-half:first-child{margin-right:16px}

		/* Funnel */
		.dr-funnel{display:flex;flex-direction:column;gap:8px;padding:16px 0}
		.dr-funnel-step{background:linear-gradient(90deg,#3b82f6 var(--width,50%),#e2e8f0 var(--width,50%));padding:10px 16px;border-radius:4px;color:white;display:flex;justify-content:space-between;font-size:13px;font-weight:500;transition:width .3s}

		/* Progress */
		.dr-progress-small{width:80px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
		.dr-progress-fill{height:100%;background:#22c55e;transition:width .3s}

		/* Operations Alerts */
		.dr-alerts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-bottom:24px}
		.dr-alert-card{border-radius:8px;padding:16px;border-left:4px solid}
		.dr-alert--warning{background:#fffbeb;border-color:#f59e0b}
		.dr-alert--danger{background:#fef2f2;border-color:#ef4444}
		.dr-alert--info{background:#eff6ff;border-color:#3b82f6}
		.dr-alert-card h4{margin:0 0 8px;font-size:14px}
		.dr-alert-count{font-size:32px;font-weight:700;margin:4px 0}
		.dr-alert-card small{color:#64748b;font-size:12px}
		.dr-action-btn{margin-top:8px}

		/* Reports Grid */
		.dr-reports-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
		.dr-report-card{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:all .2s}
		.dr-report-card:hover{box-shadow:0 4px 12px rgba(0,0,0,0.08);transform:translateY(-2px)}
		.dr-report-icon{font-size:48px;margin-bottom:12px}
		.dr-report-card h4{margin:0 0 8px;font-size:15px}
		.dr-report-card p{font-size:12px;color:#64748b;margin:0 0 16px}

		/* Empty/Error States */
		.dr-empty-state,.dr-error-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;color:#64748b;text-align:center;padding:40px}
		.dr-empty-icon,.dr-error-icon{font-size:48px;margin-bottom:16px}
		.dr-empty-state h3,.dr-error-state h3{margin:0 0 8px;color:#475569}
		.dr-empty-state p,.dr-error-state p{margin:0 0 16px;max-width:400px}

		@media(max-width:1024px){
			.dr-kpi-grid{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
			.dr-charts-row{grid-template-columns:1fr}
			.dr-half{display:block;width:100%}
			.dr-half:first-child{margin-right:0;margin-bottom:16px}
		}
		`;
		const s = document.createElement('style'); s.id = 'dr-page-css'; s.textContent = css; document.head.appendChild(s);
	}

	return { init, on_show };
})();
