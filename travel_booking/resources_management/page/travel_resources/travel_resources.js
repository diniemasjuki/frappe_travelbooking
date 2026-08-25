// travel_booking/resources_management/page/travel_resources/travel_resources.js
// Desk Page /app/travel-resources — Travel Resources & Crew Management
//
// Features:
// - KPI Cards (Crew Count, Slots, Utilization)
// - Gantt Chart View (crew-centric rows, drag-to-resize dates)
// - Calendar View (read-only monthly grid)
// - List View (slot cards)

frappe.pages['travel-resources'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Travel Resources'),
		single_column: true,
	});
	TravelResources.init(page, wrapper);
};

frappe.pages['travel-resources'].on_page_show = function () {
	if (window.TravelResources) TravelResources.on_show();
};

window.TravelResources = (function () {
	'use strict';

	const S = {
		page: null,
		wrapper: null,
		current_view: 'gantt',
		cal_month: new Date().getMonth(),
		cal_year: new Date().getFullYear(),
		crew_data: [],
		drag: null,
		day_width: 44,
		zoom: 'day',
	};

	const STATUS_COLORS = {
		Planned: '#3b82f6',
		Confirmed: '#10b981',
		Cancelled: '#ef4444',
		Completed: '#6b7280',
	};

	const GRADE_COLORS = {
		Captain: '#6d28d9',
		'Co-Captain': '#0891b2',
	};

	const GRADE_ORDER = ['Captain', 'Co-Captain'];

	const ZOOM_LEVELS = { day: 44, week: 18, month: 10 };
	const MONTH_NAMES = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December',
	];
	const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	const api = (method, args = {}) =>
		new Promise((resolve, reject) => {
			frappe.call({
				method: 'travel_booking.resources_management.api.resources_api.' + method,
				args,
				freeze: false,
			})
				.then((r) => resolve(r?.message ?? null))
				.catch((err) => {
					frappe.show_alert({ message: __('Error loading data'), indicator: 'red' }, 5);
					reject(err);
				});
		});

	function init(page, wrapper) {
		S.page = page;
		S.wrapper = wrapper;
		render_page();
		load_kpi_data();
		switch_view('gantt');
	}

	function render_page() {
		const $container = $(`
			<div class="tr-container" style="background: #f7fafc; min-height: calc(100vh - 120px);">
				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px;">
					<h1 style="font-size: 24px; font-weight: 600; color: #1a202c; margin: 0;">🧭 Travel Resources</h1>
					<div style="display: flex; gap: 4px; background: white; padding: 4px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
						<button class="tr-view-btn active" data-view="gantt" style="padding: 8px 16px; border: none; background: #3182ce; color: white; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">📊 Gantt</button>
						<button class="tr-view-btn" data-view="calendar" style="padding: 8px 16px; border: none; background: transparent; color: #718096; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">📅 Calendar</button>
						<button class="tr-view-btn" data-view="list" style="padding: 8px 16px; border: none; background: transparent; color: #718096; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">📋 List</button>
					</div>
				</div>

				<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px;" id="tr-kpi-grid">
					<div class="tr-kpi-card">
						<div class="tr-kpi-label">Active Crew</div>
						<div class="tr-kpi-value" id="tr-kpi-crew">-</div>
						<div class="tr-kpi-sub">Total available crew members</div>
					</div>
					<div class="tr-kpi-card">
						<div class="tr-kpi-label">Total Slots</div>
						<div class="tr-kpi-value" id="tr-kpi-slots">-</div>
						<div class="tr-kpi-sub">All time slots</div>
					</div>
					<div class="tr-kpi-card">
						<div class="tr-kpi-label">Active Now</div>
						<div class="tr-kpi-value" id="tr-kpi-active">-</div>
						<div class="tr-kpi-sub">Slots currently in progress</div>
					</div>
					<div class="tr-kpi-card">
						<div class="tr-kpi-label">Utilization</div>
						<div class="tr-kpi-value" id="tr-kpi-util">-%</div>
						<div class="tr-kpi-sub" id="tr-kpi-util-sub">Crew assigned today</div>
					</div>
				</div>

				<div class="tr-view-panel" id="tr-gantt-panel" style="display: none;">
					<div class="tr-panel-header">
						<h3>📊 Gantt — Crew Schedule</h3>
						<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
							<div class="tr-zoom-group" style="display: flex; gap: 2px; background: #edf2f7; padding: 3px; border-radius: 6px;">
								<button class="tr-zoom-btn active" data-zoom="day" style="padding: 4px 10px; border: none; background: #3182ce; color: white; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;">Day</button>
								<button class="tr-zoom-btn" data-zoom="week" style="padding: 4px 10px; border: none; background: transparent; color: #718096; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;">Week</button>
								<button class="tr-zoom-btn" data-zoom="month" style="padding: 4px 10px; border: none; background: transparent; color: #718096; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;">Month</button>
							</div>
							<span style="font-size: 12px; color: #a0aec0;">Drag bar edges to resize · Click bar for details</span>
						</div>
					</div>
					<div id="tr-gantt-container" style="min-height: 300px; overflow-x: auto;">
						<p class="tr-loading">Loading Gantt data...</p>
					</div>
				</div>

				<div class="tr-view-panel" id="tr-calendar-panel" style="display: none;">
					<div class="tr-panel-header">
						<h3>📅 Calendar — Monthly View</h3>
						<div style="display: flex; align-items: center; gap: 12px;">
							<button class="tr-cal-nav btn btn-sm btn-default" data-dir="prev">‹ Prev</button>
							<span id="tr-cal-label" style="font-weight: 600; min-width: 140px; text-align: center;">-</span>
							<button class="tr-cal-nav btn btn-sm btn-default" data-dir="next">Next ›</button>
						</div>
					</div>
					<div id="tr-calendar-container" style="min-height: 400px;">
						<p class="tr-loading">Loading calendar...</p>
					</div>
				</div>

				<div class="tr-view-panel" id="tr-list-panel" style="display: none;">
					<div class="tr-panel-header">
						<h3>📋 Crew Slots Overview</h3>
					</div>
					<div id="tr-slots-container" style="min-height: 300px;">
						<p class="tr-loading">Loading slot data...</p>
					</div>
				</div>
			</div>
			<style>
				.tr-kpi-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
				.tr-kpi-label { font-size: 13px; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
				.tr-kpi-value { font-size: 28px; font-weight: 700; color: #1a202c; }
				.tr-kpi-sub { font-size: 12px; color: #a0aec0; margin-top: 4px; }
				.tr-view-panel { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
				.tr-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }
				.tr-panel-header h3 { font-size: 16px; font-weight: 600; color: #2d3748; margin: 0; }
				.tr-loading { color: #718096; text-align: center; padding: 40px 0; }

				/* Gantt styles */
				.tr-gantt-wrap { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; width: max-content; min-width: 100%; }
				.tr-gantt-header { display: flex; border-bottom: 2px solid #e2e8f0; background: #f7fafc; position: sticky; top: 0; z-index: 5; }
				.tr-gantt-label-col { min-width: 200px; max-width: 200px; padding: 8px 12px; font-weight: 600; font-size: 12px; color: #4a5568; border-right: 2px solid #e2e8f0; display: flex; align-items: center; }
				.tr-gantt-timeline-header { display: flex; }
				.tr-gantt-day-header { min-width: var(--dw); max-width: var(--dw); text-align: center; font-size: 10px; color: #718096; padding: 4px 0; border-right: 1px solid #edf2f7; }
				.tr-gantt-day-header.weekend { background: #fffbeb; }
				.tr-gantt-grade-group { border-bottom: 2px solid #e2e8f0; }
				.tr-gantt-grade-label { padding: 6px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: white; cursor: pointer; display: flex; align-items: center; gap: 6px; user-select: none; }
				.tr-gantt-collapse-icon { display: inline-block; transition: transform 0.2s ease; font-size: 9px; }
				.tr-gantt-grade-group.collapsed .tr-gantt-grade-rows { display: none; }
				.tr-gantt-grade-group.collapsed .tr-gantt-collapse-icon { transform: rotate(-90deg); }
				.tr-gantt-row { display: flex; border-bottom: 1px solid #edf2f7; }
				.tr-gantt-row-label { min-width: 200px; max-width: 200px; padding: 8px 12px; font-size: 12px; color: #2d3748; border-right: 2px solid #e2e8f0; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
				.tr-gantt-row-track { position: relative; height: 36px; display: flex; }
				.tr-gantt-day-cell { min-width: var(--dw); max-width: var(--dw); border-right: 1px solid #edf2f7; }
				.tr-gantt-day-cell.weekend { background: #fffbeb; }
				.tr-gantt-day-cell.today { background: #ebf8ff; }
				.tr-gantt-bar { position: absolute; top: 4px; height: 28px; border-radius: 6px; display: flex; align-items: center; font-size: 10px; font-weight: 600; color: white; overflow: hidden; white-space: nowrap; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
				.tr-gantt-bar-label { padding: 0 8px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
				.tr-gantt-resize-handle { position: absolute; top: 0; width: 8px; height: 100%; cursor: ew-resize; z-index: 10; }
				.tr-gantt-resize-handle.left { left: 0; border-radius: 6px 0 0 6px; background: rgba(255,255,255,0.25); }
				.tr-gantt-resize-handle.right { right: 0; border-radius: 0 6px 6px 0; background: rgba(255,255,255,0.25); }
				.tr-gantt-resize-handle:hover { background: rgba(255,255,255,0.5); }
				.tr-gantt-bar.dragging { opacity: 0.8; z-index: 20; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
				.tr-gantt-drag-tooltip { position: fixed; background: #1a202c; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; z-index: 9999; pointer-events: none; }
				.tr-gantt-row-track { cursor: crosshair; }
				.tr-gantt-row:hover { background: rgba(59, 130, 246, 0.04); }

				/* Calendar styles */
				.tr-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #e2e8f0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
				.tr-cal-day-header { background: #f7fafc; padding: 8px; text-align: center; font-size: 12px; font-weight: 600; color: #4a5568; }
				.tr-cal-cell { background: white; min-height: 90px; padding: 4px; font-size: 11px; position: relative; }
				.tr-cal-cell.other-month { background: #f7fafc; color: #cbd5e0; }
				.tr-cal-cell.today { background: #ebf8ff; }
				.tr-cal-date { font-weight: 600; color: #4a5568; margin-bottom: 2px; }
				.tr-cal-event { margin-bottom: 2px; padding: 2px 6px; border-radius: 4px; color: white; font-size: 10px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
				.tr-cal-event:hover { opacity: 0.85; }
				.tr-slot-card { background: #f7fafc; border-radius: 8px; padding: 16px; border-left: 4px solid #3b82f6; margin-bottom: 12px; }
				.tr-slot-badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
				.tr-grade-badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 700; text-transform: uppercase; }

				/* === Base container (padding moved from inline so media queries can override) === */
				.tr-container { padding: 20px; }

				/* === Mobile responsive: ≤768px (tablet/landscape phone) === */
				@media (max-width: 768px) {
					.tr-container { padding: 12px; }
					.tr-view-panel { padding: 14px; border-radius: 10px; }
					.tr-kpi-card { padding: 14px; border-radius: 10px; }
					.tr-kpi-value { font-size: 22px; }
					.tr-kpi-label { font-size: 11px; }
					.tr-kpi-sub { font-size: 11px; }
					.tr-panel-header h3 { font-size: 14px; }

					/* KPI grid: 2-column on mobile instead of 4-stacked */
					#tr-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }

					/* View toggle: larger touch targets */
					.tr-view-btn { padding: 10px 12px !important; font-size: 13px !important; }
					.tr-zoom-btn { padding: 8px 10px !important; font-size: 12px !important; }

					/* DISABLE all sticky/fixed panels on mobile */
					.tr-gantt-header { position: static !important; z-index: auto !important; }
					.tr-gantt-drag-tooltip { display: none !important; }

					/* Narrower Gantt label column frees timeline space on mobile */
					.tr-gantt-label-col { min-width: 100px !important; max-width: 100px !important; font-size: 11px; }
					.tr-gantt-row-label { min-width: 100px !important; max-width: 100px !important; font-size: 11px; }

					/* Calendar: compact cells that fit 7 columns */
					.tr-cal-cell { min-height: 56px; }
					.tr-cal-day-header { padding: 4px; font-size: 10px; }
					.tr-cal-date { font-size: 10px; }
					.tr-cal-event { font-size: 9px; padding: 1px 4px; }

					/* List cards */
					.tr-slot-card { padding: 12px; }
				}

				/* === Mobile responsive: ≤480px (phone) === */
				@media (max-width: 480px) {
					.tr-container { padding: 8px; }
					.tr-kpi-value { font-size: 19px; }
					.tr-kpi-label { font-size: 10px; }
					.tr-cal-cell { min-height: 44px; }
					.tr-cal-event { font-size: 8px; }
					.tr-view-btn { padding: 8px 10px !important; font-size: 12px !important; }
				}
			</style>
		`);

		$(S.wrapper).find('.layout-main-section').html($container);
		bind_events();
	}

	function bind_events() {
		$(S.wrapper).on('click', '.tr-view-btn', function () {
			switch_view($(this).data('view'));
		});

		$(S.wrapper).on('click', '.tr-zoom-btn', function () {
			const zoom = $(this).data('zoom');
			S.zoom = zoom;
			S.day_width = ZOOM_LEVELS[zoom] || 44;
			$('.tr-zoom-btn').removeClass('active').css({ background: 'transparent', color: '#718096' });
			$(this).addClass('active').css({ background: '#3182ce', color: 'white' });
			render_gantt(S.crew_data);
		});

		$(S.wrapper).on('click', '.tr-cal-nav', function () {
			const dir = $(this).data('dir');
			if (dir === 'prev') {
				S.cal_month--;
				if (S.cal_month < 0) { S.cal_month = 11; S.cal_year--; }
			} else {
				S.cal_month++;
				if (S.cal_month > 11) { S.cal_month = 0; S.cal_year++; }
			}
			load_calendar_view();
		});

		$(S.wrapper).on('click', '.tr-gantt-bar-label', function (e) {
			if (S.drag) return;
			const name = $(this).closest('.tr-gantt-bar').data('slot-name');
			if (name) show_slot_detail(name);
		});

		$(S.wrapper).on('click', '.tr-cal-event', function () {
			const name = $(this).data('name');
			if (name) show_slot_detail(name);
		});

		$(S.wrapper).on('mousedown', '.tr-gantt-resize-handle', function (e) {
			e.preventDefault();
			e.stopPropagation();
			const $bar = $(this).closest('.tr-gantt-bar');
			const slotName = $bar.data('slot-name');
			const side = $(this).hasClass('left') ? 'left' : 'right';
			start_drag($bar, slotName, side, e);
		});

		$(S.wrapper).on('click', '.tr-gantt-row-track', function (e) {
			if (S.drag) return;
			if ($(e.target).closest('.tr-gantt-bar').length) return;

			const $row = $(this).closest('.tr-gantt-row');
			const crewId = $row.data('crew-id');
			const crewName = $row.data('crew-name');
			if (!crewId) return;

			const $wrap = $(this).closest('.tr-gantt-wrap');
			const minDateStr = $wrap.data('min-date');
			const minDate = new Date(minDateStr);
			minDate.setHours(0, 0, 0, 0);

			const trackRect = this.getBoundingClientRect();
			const clickX = e.clientX - trackRect.left;
			const dayOffset = Math.floor(clickX / S.day_width);

			const clickedDate = new Date(minDate);
			clickedDate.setDate(clickedDate.getDate() + dayOffset);

			show_new_slot_dialog(crewId, crewName, toISO(clickedDate));
		});
	}

	async function load_kpi_data() {
		try {
			const data = await api('get_resources_summary');
			if (data && data.kpi) {
				$('#tr-kpi-crew').text(data.kpi.total_active_crew || 0);
				$('#tr-kpi-slots').text(data.kpi.total_slots || 0);
				$('#tr-kpi-active').text(data.kpi.active_slots_now || 0);
				$('#tr-kpi-util').text(data.kpi.utilization_percent + '%');
				$('#tr-kpi-util-sub').text(`${data.kpi.crew_utilized_today || 0} crew assigned today`);
			}
			if (data && data.upcoming_slots && data.upcoming_slots.length > 0) {
				render_list_view(data.upcoming_slots);
			} else {
				$('#tr-slots-container').html('<p class="tr-loading">No upcoming slots found.</p>');
			}
		} catch (error) {
			$('#tr-slots-container').html('<p style="color: #ef4444; text-align: center; padding: 40px 0;">Error loading data.</p>');
		}
	}

	function render_list_view(slots) {
		let html = '<div style="display: grid; gap: 12px;">';
		slots.forEach((slot) => {
			const color = STATUS_COLORS[slot.status] || '#6b7280';
			html += `
				<div class="tr-slot-card" style="border-left-color: ${color};">
					<div style="font-weight: 600; color: #2d3748; margin-bottom: 4px;">${slot.name}</div>
					<div style="font-size: 13px; color: #718096; margin-bottom: 8px;">${slot.start_date} → ${slot.end_date}</div>
					<div style="display: flex; justify-content: space-between; align-items: center;">
						<span class="tr-slot-badge" style="background: ${color}20; color: ${color};">${slot.status || 'Unknown'}</span>
						<span style="font-size: 12px; color: #4a5568;">${slot.current_crew || 0}/${slot.max_crew || 1} crew</span>
					</div>
				</div>`;
		});
		html += '</div>';
		$('#tr-slots-container').html(html);
	}

	function switch_view(view) {
		S.current_view = view;
		$('.tr-view-btn').removeClass('active').css({ background: 'transparent', color: '#718096' });
		$(`.tr-view-btn[data-view="${view}"]`).addClass('active').css({ background: '#3182ce', color: 'white' });
		$('.tr-view-panel').hide();
		$(`#tr-${view}-panel`).show();
		if (view === 'gantt') load_gantt_view();
		else if (view === 'calendar') load_calendar_view();
	}

	async function load_gantt_view() {
		$('#tr-gantt-container').html('<p class="tr-loading">Loading Gantt data...</p>');
		try {
			const data = await api('get_gantt_data_by_crew', { filters: JSON.stringify({}) });
			S.crew_data = data || [];
			render_gantt(S.crew_data);
		} catch (err) {
			$('#tr-gantt-container').html('<p style="color: #ef4444; text-align: center; padding: 40px 0;">Error loading Gantt data.</p>');
		}
	}

	function render_gantt(crew_list) {
		if (!crew_list || crew_list.length === 0) {
			$('#tr-gantt-container').html('<p class="tr-loading">No crew found.</p>');
			return;
		}

		const today = new Date();
		today.setHours(0, 0, 0, 0);

		// Calculate date range from all slots
		let minDate = new Date(today);
		minDate.setDate(minDate.getDate() - 3);
		let maxDate = new Date(today);
		maxDate.setDate(maxDate.getDate() + 400);

		crew_list.forEach((crew) => {
			(crew.slots || []).forEach((s) => {
				const sDate = new Date(s.start);
				const eDate = new Date(s.end);
				if (sDate < minDate) minDate = new Date(sDate);
				if (eDate > maxDate) maxDate = new Date(eDate);
			});
		});
		minDate.setHours(0, 0, 0, 0);
		maxDate.setHours(0, 0, 0, 0);

		const totalDays = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1;
		const dw = S.day_width;
		const timelineWidth = totalDays * dw;

		// Build day headers — content adapts to zoom level
		let dayHeaders = '';
		let monthHeaders = '';
		if (S.zoom === 'month') {
			let curMonth = -1, monthStart = 0;
			for (let i = 0; i <= totalDays; i++) {
				const d = new Date(minDate);
				d.setDate(d.getDate() + i);
				const m = d.getMonth();
				if (i === totalDays || m !== curMonth) {
					if (curMonth !== -1) {
						const spanW = (i - monthStart) * dw;
						monthHeaders += `<div style="min-width:${spanW}px;max-width:${spanW}px;text-align:center;font-size:10px;font-weight:600;color:#4a5568;padding:3px 0;border-right:1px solid #e2e8f0;background:#f7fafc;overflow:hidden;white-space:nowrap;">${MONTH_NAMES[curMonth].slice(0, 3)}</div>`;
					}
					curMonth = m;
					monthStart = i;
				}
				if (i < totalDays) {
					const dow = d.getDay();
					const isWeekend = dow === 0 || dow === 6;
					const isToday = d.getTime() === today.getTime();
					dayHeaders += `<div class="tr-gantt-day-header${isWeekend ? ' weekend' : ''}" style="${isToday ? 'background:#ebf8ff;' : ''}"></div>`;
				}
			}
		} else if (S.zoom === 'week') {
			for (let i = 0; i < totalDays; i++) {
				const d = new Date(minDate);
				d.setDate(d.getDate() + i);
				const dow = d.getDay();
				const isWeekend = dow === 0 || dow === 6;
				const isToday = d.getTime() === today.getTime();
				dayHeaders += `<div class="tr-gantt-day-header${isWeekend ? ' weekend' : ''}" style="${isToday ? 'background:#ebf8ff;font-weight:700;' : ''}">${d.getDate()}</div>`;
			}
		} else {
			for (let i = 0; i < totalDays; i++) {
				const d = new Date(minDate);
				d.setDate(d.getDate() + i);
				const dow = d.getDay();
				const isWeekend = dow === 0 || dow === 6;
				const isToday = d.getTime() === today.getTime();
				dayHeaders += `<div class="tr-gantt-day-header${isWeekend ? ' weekend' : ''}" style="${isToday ? 'background:#ebf8ff;font-weight:700;' : ''}">${DAY_NAMES[dow]}<br>${d.getDate()}/${d.getMonth() + 1}</div>`;
			}
		}

		// Group crew by grade
		const grades = {};
		crew_list.forEach((crew) => {
			const g = crew.grade || 'Ungraded';
			if (!grades[g]) grades[g] = [];
			grades[g].push(crew);
		});

		// Sort grades: Captain first, Co-Captain second, then any others
		const sortedGrades = Object.keys(grades).sort((a, b) => {
			const ai = GRADE_ORDER.indexOf(a);
			const bi = GRADE_ORDER.indexOf(b);
			return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
		});

		// Build rows grouped by grade (collapsible)
		let rows = '';
		sortedGrades.forEach((grade) => {
			const gradeColor = GRADE_COLORS[grade] || '#6b7280';
			rows += `<div class="tr-gantt-grade-group" data-grade="${grade}"><div class="tr-gantt-grade-label" style="background: ${gradeColor};"><span class="tr-gantt-collapse-icon">▼</span> ${grade} (${grades[grade].length})</div><div class="tr-gantt-grade-rows">`;

			grades[grade].forEach((crew) => {
				// Build day cells for background
				let dayCells = '';
				for (let i = 0; i < totalDays; i++) {
					const d = new Date(minDate);
					d.setDate(d.getDate() + i);
					const dow = d.getDay();
					const isWeekend = dow === 0 || dow === 6;
					const isToday = d.getTime() === today.getTime();
					dayCells += `<div class="tr-gantt-day-cell${isWeekend ? ' weekend' : ''}${isToday ? ' today' : ''}"></div>`;
				}

				// Build bars for this crew's slots
				let bars = '';
				(crew.slots || []).forEach((slot) => {
					const slotStart = new Date(slot.start);
					const slotEnd = new Date(slot.end);
					slotStart.setHours(0, 0, 0, 0);
					slotEnd.setHours(0, 0, 0, 0);

					const offsetDays = Math.floor((slotStart - minDate) / (1000 * 60 * 60 * 24));
					const barDays = Math.max(1, Math.ceil((slotEnd - slotStart) / (1000 * 60 * 60 * 24)) + 1);
					const leftPx = offsetDays * dw;
					const widthPx = barDays * dw - 4;
					const color = STATUS_COLORS[slot.status] || '#6b7280';
					const barLabel = slot.notes || slot.slot_name;

					bars += `
						<div class="tr-gantt-bar" data-slot-name="${slot.slot_name}"
							style="left: ${leftPx}px; width: ${widthPx}px; background: ${color};"
							title="${slot.slot_name} (${slot.start} to ${slot.end}) — ${slot.role_in_slot || 'N/A'} — ${slot.status}">
							<div class="tr-gantt-resize-handle left"></div>
							<div class="tr-gantt-bar-label">${barLabel}</div>
							<div class="tr-gantt-resize-handle right"></div>
						</div>`;
				});

				rows += `
					<div class="tr-gantt-row" data-crew-id="${crew.crew_id}" data-crew-name="${crew.crew_name}">
						<div class="tr-gantt-row-label">
							<div style="font-weight: 600;">${crew.crew_name}</div>
							<div style="font-size: 10px; color: #718096;">${crew.role_position || ''} · ${crew.slots.length} slot(s)</div>
						</div>
						<div class="tr-gantt-row-track" style="width: ${timelineWidth}px;" title="Click empty area to add slot">
							${dayCells}
							${bars}
						</div>
					</div>`;
			});
			rows += '</div></div>';
		});

		const html = `
			<div class="tr-gantt-wrap" style="--dw: ${dw}px;" data-min-date="${toISO(minDate)}" data-total-days="${totalDays}">
				<div class="tr-gantt-header">
					<div class="tr-gantt-label-col">Crew Member</div>
					<div class="tr-gantt-timeline-header" style="width: ${timelineWidth}px; flex-direction: column;">
						${monthHeaders ? `<div style="display:flex;">${monthHeaders}</div>` : ''}
						<div style="display:flex;">${dayHeaders}</div>
					</div>
				</div>
				${rows}
			</div>
		`;

		$('#tr-gantt-container').html(html);

		// Collapsible grade groups — click the coloured header to toggle
		$('#tr-gantt-container').off('click', '.tr-gantt-grade-label').on('click', '.tr-gantt-grade-label', function () {
			$(this).closest('.tr-gantt-grade-group').toggleClass('collapsed');
		});
	}

	function start_drag($bar, slotName, side, e) {
		const $wrap = $bar.closest('.tr-gantt-wrap');
		const minDateStr = $wrap.data('min-date');
		const totalDays = parseInt($wrap.data('total-days'));
		const minDate = new Date(minDateStr);
		minDate.setHours(0, 0, 0, 0);

		const barStartPx = parseFloat($bar.css('left'));
		const barWidthPx = $bar.width();
		const startX = e.clientX;

		// Find original slot data
		let originalSlot = null;
		for (const crew of S.crew_data) {
			for (const s of (crew.slots || [])) {
				if (s.slot_name === slotName) { originalSlot = s; break; }
			}
			if (originalSlot) break;
		}
		if (!originalSlot) return;

		S.drag = { slotName, side, $bar, barStartPx, barWidthPx, startX, minDate, totalDays, originalSlot };
		$bar.addClass('dragging');
		show_drag_tooltip(e, originalSlot.start, originalSlot.end);

		$(document).on('mousemove.tr-drag', on_drag_move);
		$(document).on('mouseup.tr-drag', on_drag_end);
	}

	function on_drag_move(e) {
		if (!S.drag) return;
		const { $bar, barStartPx, barWidthPx, startX, side, minDate, slotName } = S.drag;
		const deltaPx = e.clientX - startX;
		const deltaDays = Math.round(deltaPx / S.day_width);
		if (deltaDays === 0 && !$bar.data('last-delta')) return;

		let newLeft = barStartPx;
		let newWidth = barWidthPx;
		let newStartStr, newEndStr;

		if (side === 'left') {
			newLeft = barStartPx + deltaDays * S.day_width;
			newWidth = barWidthPx - deltaDays * S.day_width;
			const newStart = new Date(minDate);
			newStart.setDate(newStart.getDate() + Math.round(newLeft / S.day_width));
			newStartStr = toISO(newStart);
			newEndStr = S.drag.originalSlot.end;
		} else {
			newWidth = barWidthPx + deltaDays * S.day_width;
			const newEnd = new Date(S.drag.originalSlot.start);
			newEnd.setDate(newEnd.getDate() + Math.round(newWidth / S.day_width) - 1);
			newStartStr = S.drag.originalSlot.start;
			newEndStr = toISO(newEnd);
		}

		// Prevent bar from going negative width
		if (newWidth < S.day_width - 4) return;

		// Update all bars with same slot name
		$(`.tr-gantt-bar[data-slot-name="${slotName}"]`).each(function () {
			$(this).css({ left: newLeft + 'px', width: newWidth + 'px' });
		});

		$bar.data('last-delta', deltaDays);
		show_drag_tooltip(e, newStartStr, newEndStr);
	}

	function on_drag_end(e) {
		if (!S.drag) return;
		const { slotName, $bar, minDate, side, originalSlot } = S.drag;
		$bar.removeClass('dragging');
		hide_drag_tooltip();
		$(document).off('mousemove.tr-drag');
		$(document).off('mouseup.tr-drag');

		// Calculate final dates from current bar position
		const $anyBar = $(`.tr-gantt-bar[data-slot-name="${slotName}"]`).first();
		const leftPx = parseFloat($anyBar.css('left'));
		const widthPx = $anyBar.width();
		const startDays = Math.round(leftPx / S.day_width);
		const durationDays = Math.round(widthPx / S.day_width);

		const newStart = new Date(minDate);
		newStart.setDate(newStart.getDate() + startDays);
		const newEnd = new Date(newStart);
		newEnd.setDate(newEnd.getDate() + durationDays - 1);

		const newStartStr = toISO(newStart);
		const newEndStr = toISO(newEnd);

		// Check if dates actually changed
		if (newStartStr === originalSlot.start && newEndStr === originalSlot.end) {
			S.drag = null;
			return;
		}

		S.drag = null;
		save_slot_dates(slotName, newStartStr, newEndStr);
	}

	async function save_slot_dates(slotName, startDate, endDate) {
		frappe.show_alert({ message: `Updating ${slotName}...`, indicator: 'blue' }, 3);
		try {
			const result = await api('update_slot_dates', { slot_name: slotName, start_date: startDate, end_date: endDate });
			if (result) {
				frappe.show_alert({ message: `${slotName} updated: ${result.start_date} → ${result.end_date}`, indicator: 'green' }, 4);
				// Update local data
				for (const crew of S.crew_data) {
					for (const s of (crew.slots || [])) {
						if (s.slot_name === slotName) {
							s.start = result.start_date;
							s.end = result.end_date;
							s.status = result.status;
						}
					}
				}
				// Reload to recalculate timeline range
				load_gantt_view();
			}
		} catch (err) {
			frappe.show_alert({ message: `Error updating ${slotName}`, indicator: 'red' }, 5);
			load_gantt_view();
		}
	}

	function show_drag_tooltip(e, startDate, endDate) {
		let $tip = $('.tr-gantt-drag-tooltip');
		if ($tip.length === 0) {
			$tip = $('<div class="tr-gantt-drag-tooltip"></div>').appendTo('body');
		}
		$tip.text(`${startDate} → ${endDate}`).css({ left: e.clientX + 15, top: e.clientY - 30 });
	}

	function hide_drag_tooltip() {
		$('.tr-gantt-drag-tooltip').remove();
	}

	async function load_calendar_view() {
		const monthStart = new Date(S.cal_year, S.cal_month, 1);
		const monthEnd = new Date(S.cal_year, S.cal_month + 1, 0);
		$('#tr-cal-label').text(`${MONTH_NAMES[S.cal_month]} ${S.cal_year}`);
		$('#tr-calendar-container').html('<p class="tr-loading">Loading calendar...</p>');
		try {
			const events = await api('get_calendar_events', { start: toISO(monthStart), end: toISO(monthEnd), filters: JSON.stringify({}) });
			render_calendar(events || [], monthStart);
		} catch (err) {
			$('#tr-calendar-container').html('<p style="color: #ef4444; text-align: center; padding: 40px 0;">Error loading calendar.</p>');
		}
	}

	function render_calendar(events, monthStart) {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const firstDay = new Date(monthStart);
		const startDayOfWeek = firstDay.getDay();
		const daysInMonth = new Date(S.cal_year, S.cal_month + 1, 0).getDate();
		const gridStart = new Date(firstDay);
		gridStart.setDate(gridStart.getDate() - startDayOfWeek);
		const totalCells = Math.ceil((startDayOfWeek + daysInMonth) / 7) * 7;

		let headerHtml = '';
		DAY_NAMES.forEach((name) => { headerHtml += `<div class="tr-cal-day-header">${name}</div>`; });

		let cellsHtml = '';
		for (let i = 0; i < totalCells; i++) {
			const d = new Date(gridStart);
			d.setDate(d.getDate() + i);
			const isOtherMonth = d.getMonth() !== S.cal_month;
			const isToday = d.getTime() === today.getTime();
			const dateStr = toISO(d);
			const dayEvents = events.filter((e) => {
				const eStart = new Date(e.start); eStart.setHours(0,0,0,0);
				const eEnd = new Date(e.end); eEnd.setHours(0,0,0,0);
				return d >= eStart && d <= eEnd;
			});
			let eventsHtml = '';
			dayEvents.forEach((e) => {
				const color = STATUS_COLORS[e.extendedProps?.status] || '#6b7280';
				const shortTitle = e.title.length > 22 ? e.title.substring(0, 20) + '…' : e.title;
				eventsHtml += `<div class="tr-cal-event" data-name="${e.id}" style="background: ${color};" title="${e.title}">${shortTitle}</div>`;
			});
			cellsHtml += `<div class="tr-cal-cell${isOtherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}"><div class="tr-cal-date">${d.getDate()}</div>${eventsHtml}</div>`;
		}

		$('#tr-calendar-container').html(`<div class="tr-cal-grid">${headerHtml}${cellsHtml}</div>`);
	}

	async function show_slot_detail(slot_name) {
		try {
			const data = await api('get_slot_detail', { slot_name });
			if (!data) return;
			const slot = data.slot;
			const color = STATUS_COLORS[slot.status] || '#6b7280';
			const existingCrewIds = (data.allocations || []).map((a) => a.crew).filter(Boolean);

			let crewRows = '';
			(data.allocations || []).forEach((a) => {
				const crewInfo = a.crew_info || {};
				const grade = crewInfo.grade || '';
				const gradeColor = GRADE_COLORS[grade] || '#6b7280';
				crewRows += `<tr>
					<td style="padding: 6px 12px; border-bottom: 1px solid #edf2f7;">${a.crew_name || a.crew}${grade ? ` <span class="tr-grade-badge" style="background:${gradeColor}20;color:${gradeColor};">${grade}</span>` : ''}</td>
					<td style="padding: 6px 12px; border-bottom: 1px solid #edf2f7;">${a.role_in_slot || '-'}</td>
					<td style="padding: 6px 12px; border-bottom: 1px solid #edf2f7;">${a.allocation_status || '-'}</td>
					<td style="padding: 4px 12px; border-bottom: 1px solid #edf2f7; text-align: center;">
						<button class="tr-remove-crew-btn" data-crew-id="${a.crew}" data-crew-name="${a.crew_name || a.crew}" data-slot-name="${slot.name}" title="Remove ${a.crew_name || a.crew}" style="background:#fee2e2;color:#dc2626;border:1px solid #fecaca;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px;">✕</button>
					</td>
				</tr>`;
			});

			const dialog = new frappe.ui.Dialog({
				title: `Slot Detail: ${slot.name}`,
				size: 'large',
				primary_action_label: __('Add Crew'),
				primary_action: () => {
					show_add_crew_dialog(slot.name, slot.current_crew, slot.max_crew, existingCrewIds, dialog);
				},
			});

			$(dialog.body).html(`
				<div style="margin-bottom: 16px;">
					<div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;">
						<span class="tr-slot-badge" style="background: ${color}20; color: ${color};">${slot.status}</span>
						<span style="font-size: 13px; color: #4a5568;">📅 ${slot.start_date} → ${slot.end_date}</span>
						<span style="font-size: 13px; color: #4a5568;">👥 ${slot.current_crew}/${slot.max_crew} crew</span>
					</div>
					${slot.trip_name ? `<div style="font-size: 13px; color: #718096;">Trip: ${slot.trip_name}</div>` : ''}
					${slot.notes ? `<div style="font-size: 13px; color: #718096; margin-top: 8px;">Notes: ${slot.notes}</div>` : ''}
				</div>
				<div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
				<table style="width: 100%; border-collapse: collapse; min-width: 480px;">
					<thead><tr style="background: #f7fafc;">
						<th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #718096;">Crew</th>
						<th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #718096;">Role</th>
						<th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #718096;">Status</th>
						<th style="padding: 8px 12px; text-align: center; font-size: 12px; color: #718096;">Action</th>
					</tr></thead>
					<tbody>${crewRows || '<tr><td colspan="4" style="padding: 12px; text-align: center; color: #a0aec0;">No crew assigned</td></tr>'}</tbody>
				<tfoot><tr><td colspan="4" style="padding: 8px;">
					<button class="btn btn-sm btn-default tr-add-crew-btn" data-slot-name="${slot.name}" style="width: 100%; font-size: 13px;">＋ Add Crew Member</button>
				</td></tr></tfoot>
				</table>
				</div>`);

			$(dialog.body).on('click', '.tr-remove-crew-btn', function () {
				const crewId = $(this).data('crew-id');
				const crewName = $(this).data('crew-name');
				frappe.confirm(`Remove <b>${crewName}</b> from this slot?`, () => {
					api('remove_crew_from_slot', { slot_name: slot.name, crew_id: crewId })
						.then(() => {
							frappe.show_alert({ message: `${crewName} removed`, indicator: 'green' }, 4);
							dialog.hide();
							show_slot_detail(slot.name);
							load_gantt_view();
						})
						.catch(() => {});
				});
			});

			$(dialog.body).on('click', '.tr-add-crew-btn', function () {
				show_add_crew_dialog(slot.name, slot.current_crew, slot.max_crew, existingCrewIds, dialog);
			});

			$(dialog.footer).prepend('<button class="btn btn-default" data-close-btn>Close</button>');
			$(dialog.footer).find('[data-close-btn]').on('click', () => dialog.hide());

			dialog.show();
		} catch (err) {
			frappe.show_alert({ message: 'Error loading slot detail', indicator: 'red' }, 5);
		}
	}

	function show_add_crew_dialog(slotName, currentCrew, maxCrew, existingCrewIds, parentDialog) {
		const dialog = new frappe.ui.Dialog({
			title: __('Add Crew to Slot'),
			fields: [
				{
					fieldname: 'crew',
					label: 'Crew Member',
					fieldtype: 'Link',
					options: 'Crew',
					reqd: 1,
					get_query: () => {
						const filters = { status: ['in', ['Active', 'On Leave']] };
						if (existingCrewIds.length > 0) {
							filters.name = ['not in', existingCrewIds];
						}
						return { filters };
					},
				},
				{
					fieldname: 'role_in_slot',
					label: 'Role in Slot',
					fieldtype: 'Select',
					options: 'Tour Leader\nDriver\nGuide\nStaff\nOther',
				},
				{
					fieldname: 'max_crew',
					label: 'Max Crew',
					fieldtype: 'Int',
					default: Math.max(maxCrew || 1, (currentCrew || 0) + 1),
					description: `Currently ${currentCrew || 0} crew assigned`,
				},
			],
			primary_action_label: __('Add'),
			primary_action: (values) => {
				const $btn = dialog.get_primary_btn();
				$btn.prop('disabled', true).html(__('Adding...'));
				api('add_crew_to_slot', {
					slot_name: slotName,
					crew_id: values.crew,
					role_in_slot: values.role_in_slot || '',
					max_crew: String(values.max_crew || 1),
				})
					.then((result) => {
						if (result) {
							frappe.show_alert({ message: `${result.added_crew} added to slot`, indicator: 'green' }, 4);
							dialog.hide();
							parentDialog.hide();
							show_slot_detail(slotName);
							load_gantt_view();
						}
					})
					.catch(() => {})
					.finally(() => {
						$btn.prop('disabled', false).html(__('Add'));
					});
			},
		});
		dialog.show();
	}

	function show_new_slot_dialog(crewId, crewName, startDate) {
		const dialog = new frappe.ui.Dialog({
			title: __('New Crew Slot'),
			fields: [
				{ fieldname: 'slot_name', label: 'Slot Name', fieldtype: 'Data', default: startDate, reqd: 1, description: 'Unique name for this slot' },
				{ fieldname: 'start_date', label: 'Start Date', fieldtype: 'Date', default: startDate, reqd: 1 },
				{ fieldname: 'end_date', label: 'End Date', fieldtype: 'Date', default: startDate, reqd: 1 },
				{ fieldname: 'crew_display', label: 'Crew', fieldtype: 'Data', default: crewName, read_only: 1 },
				{ fieldname: 'role_in_slot', label: 'Role in Slot', fieldtype: 'Select', options: 'Tour Leader\nDriver\nGuide\nStaff\nOther' },
				{ fieldname: 'max_crew', label: 'Max Crew', fieldtype: 'Int', default: 1 },
				{ fieldname: 'notes', label: 'Notes', fieldtype: 'Small Text', reqd: 1 },
			],
			primary_action_label: __('Create Slot'),
			primary_action: (values) => {
				create_new_slot(values, crewId, dialog);
			},
		});
		dialog.show();
	}

	async function create_new_slot(values, crewId, dialog) {
		const $btn = dialog.get_primary_btn();
		$btn.prop('disabled', true).html(__('Creating...'));
		try {
			const result = await api('create_slot', {
				start_date: values.start_date,
				end_date: values.end_date,
				crew_id: crewId,
				role_in_slot: values.role_in_slot || '',
				max_crew: String(values.max_crew || 1),
				slot_name: values.slot_name || '',
				notes: values.notes || '',
			});
			if (result) {
				frappe.show_alert({ message: `Slot ${result.slot_name} created`, indicator: 'green' }, 4);
				dialog.hide();
				load_gantt_view();
				load_kpi_data();
			}
		} catch (err) {
			// Error dialog already shown by frappe.call
		} finally {
			$btn.prop('disabled', false).html(__('Create Slot'));
		}
	}

	function toISO(date) {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, '0');
		const d = String(date.getDate()).padStart(2, '0');
		return `${y}-${m}-${d}`;
	}

	function on_show() {
		if (S.wrapper) {
			load_kpi_data();
			switch_view(S.current_view);
		}
	}

	return { init, on_show };
})();
