// travel_booking/module_travel_booking/page/ongoing_today/ongoing_today.js
// Desk Page /app/ongoing-today — "Ongoing Today"
//
// Page monitoring SEMUA elemen travel booking yang sensitif dengan
// timeline masa, dalam bentuk Gantt: paksi-x ialah tarikh (dari
// lookback sehingga horizon pilihan), setiap row ialah satu item
// dikelompokkan ikut row-group (payment due, room assignment, dll).
//
// Data: travel_booking.api.ongoing_today.get_monitor_data
// Segala kiraan urgency/deadline dibuat backend semasa setiap page
// load — page ini hanya melukis apa yang diberi.

frappe.pages['ongoing-today'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Ongoing Today'),
		single_column: true,
	});
	OngoingToday.init(page, wrapper);
};

frappe.pages['ongoing-today'].on_page_show = function () {
	if (window.OngoingToday) OngoingToday.on_show();
};

/* ============================================================
   OngoingToday — controller (IIFE)
   ============================================================ */
window.OngoingToday = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	const fmtDate = (iso) => {
		if (!iso) return '—';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return String(iso);
		return parseInt(m[2], 10) + ' ' + MONTHS[parseInt(m[3], 10) - 1];
	};

	const fmtMoney = (n, ccy) =>
		(ccy || '') + ' ' + parseFloat(n || 0).toLocaleString('en-MY', {
			minimumFractionDigits: 2, maximumFractionDigits: 2,
		});

	const S = {
		page: null,
		wrapper: null,
		data: null,           // payload penuh dari API
		range_days: 30,       // horizon (14/30/90)
		trip: '',             // filter ikut Trip
		urgency: 'all',       // all | overdue | critical | warning
		group_visibility: {}, // key -> bool (kumpulan disembunyikan pengguna)
		collapsed: {},        // key -> bool
		loading: false,
		timer: null,
	};

	const URGENCY_ORDER = { overdue: 0, critical: 1, warning: 2, ok: 3, info: 4 };

	const api = (method, args = {}) =>
		new Promise((resolve, reject) => {
			frappe.call({
				method: 'travel_booking.api.ongoing_today.' + method,
				args,
				freeze: false,
			})
				.then((r) => resolve(r?.message ?? null))
				.catch((err) => {
					console.error('OngoingToday API Error:', method, err);
					frappe.show_alert({ message: __('Error loading data'), indicator: 'red' }, 5);
					reject(err);
				});
		});

	/* ========== INIT ========== */

	function init(page, wrapper) {
		S.page = page;
		S.wrapper = wrapper;

		inject_styles();
		build_layout();
		setup_toolbar();
		load_data();
	}

	function on_show() {
		// Setiap kali page dimuat turun (dinavigasi semula), refresh data —
		// status "ongoing today" mesti relatif kepada masa semasa.
		if (S.data) load_data();
	}

	/* ========== LAYOUT ========== */

	function build_layout() {
		const $wrapper = $(S.wrapper);
		$wrapper.find('.layout-side-section').remove();
		$wrapper.find('.layout-main-section').css({ 'min-height': '60vh' }).html(`
			<div id="ot-container">
				<div id="ot-toolbar" class="ot-toolbar">
					<div class="ot-toolbar-left">
						<select id="ot-range" class="ot-select" title="${__('Horizon')}">
							<option value="14">${__('Next 14 days')}</option>
							<option value="30" selected>${__('Next 30 days')}</option>
							<option value="90">${__('Next 90 days')}</option>
						</select>
						<select id="ot-trip" class="ot-select" title="${__('Trip filter')}">
							<option value="">${__('All trips')}</option>
						</select>
						<select id="ot-urgency" class="ot-select" title="${__('Urgency filter')}">
							<option value="all">${__('All urgency')}</option>
							<option value="critical">${__('Critical + Overdue')}</option>
							<option value="overdue">${__('Overdue only')}</option>
						</select>
					</div>
					<div class="ot-toolbar-right">
						<button class="btn btn-default btn-xs" id="ot-refresh">${__('Refresh')}</button>
						<button class="btn btn-default btn-xs" id="ot-auto">${__('Auto 5m')}</button>
					</div>
				</div>
				<div id="ot-kpis"></div>
				<div id="ot-legend"></div>
				<div id="ot-gantt"></div>
			</div>
		`);
	}

	function setup_toolbar() {
		$('#ot-range').on('change', function () {
			S.range_days = parseInt(this.value, 10) || 30;
			load_data();
		});

		$('#ot-urgency').on('change', function () {
			S.urgency = this.value;
			render();
		});

		$('#ot-trip').on('change', function () {
			S.trip = this.value;
			load_data();
		});

		$('#ot-refresh').on('click', () => load_data());
		$('#ot-auto').on('click', () => toggle_auto_refresh());
	}

	function toggle_auto_refresh() {
		if (S.timer) {
			clearInterval(S.timer);
			S.timer = null;
			$('#ot-auto').removeClass('btn-primary').addClass('btn-default');
			frappe.show_alert({ message: __('Auto-refresh disabled'), indicator: 'gray' }, 3);
		} else {
			S.timer = setInterval(load_data, 5 * 60 * 1000);
			$('#ot-auto').removeClass('btn-default').addClass('btn-primary');
			frappe.show_alert({ message: __('Auto-refresh setiap 5 minit'), indicator: 'blue' }, 3);
			load_data();
		}
	}

	/* ========== DATA ========== */

	async function load_data() {
		if (S.loading) return;
		S.loading = true;
		$('#ot-gantt').html(loading_html());
		try {
			const data = await api('get_monitor_data', {
				range_days: S.range_days,
				trip: S.trip,
			});
			S.data = data;
			// Trip filter dropdown — populate sekali, kekalkan pilihan semasa.
			const $trip = $('#ot-trip');
			const current = S.trip;
			$trip.empty().append(`<option value="">${__('All trips')}</option>`);
			(data.trips || []).forEach((t) => {
				$trip.append(`<option value="${esc(t.name)}">${esc(t.label)}</option>`);
			});
			$trip.val(current || '');
			render();
		} finally {
			S.loading = false;
		}
	}

	/* ========== FILTERING ========== */

	function item_passes(it) {
		if (S.urgency === 'overdue') return it.urgency === 'overdue';
		if (S.urgency === 'critical') return it.urgency === 'overdue' || it.urgency === 'critical';
		return true;
	}

	/* ========== RENDER ========== */

	function render() {
		if (!S.data) return;
		render_kpis();
		render_legend();
		render_gantt();
	}

	function loading_html() {
		return `<div class="ot-loading">${__('Loading timeline…')}</div>`;
	}

	function render_kpis() {
		const k = S.data.kpis || {};
		const cards = [
			{ key: 'payment_due', label: __('Payment Due'), icon: '💰' },
			{ key: 'room_assignment', label: __('Room Assignment'), icon: '🛏️' },
			{ key: 'flight_assignment', label: __('Flight Assignment'), icon: '✈️' },
			{ key: 'pending_orders', label: __('Pending Orders'), icon: '⏳' },
			{ key: 'passport_links', label: __('Passport Links'), icon: '🛂' },
			{ key: 'documents_pending', label: __('Docs Pending'), icon: '📄' },
			{ key: 'inquiries', label: __('Inquiries'), icon: '💬' },
			{ key: 'ongoing_trips', label: __('Ongoing Trips'), icon: '🧭' },
		];
		$('#ot-kpis').html(
			cards.map((c) => {
				const stat = k[c.key] || { total: 0, overdue: 0, critical: 0 };
				return `
				<div class="ot-kpi" data-kpi-group="${c.key}" title="${esc(c.label)}">
					<div class="ot-kpi-head">
						<span class="ot-kpi-icon">${c.icon}</span>
						<span class="ot-kpi-label">${esc(c.label)}</span>
					</div>
					<div class="ot-kpi-body">
						<span class="ot-kpi-total">${stat.total}</span>
						${stat.overdue ? `<span class="ot-kpi-flag ot-kpi-flag--overdue">${stat.overdue} ${__('overdue')}</span>` : ''}
						${stat.critical ? `<span class="ot-kpi-flag ot-kpi-flag--critical">${stat.critical} ${__('critical')}</span>` : ''}
						${!stat.overdue && !stat.critical && stat.total ? `<span class="ot-kpi-flag ot-kpi-flag--ok">${__('on track')}</span>` : ''}
					</div>
				</div>`;
			}).join('')
		);
		$(document).off('click', '.ot-kpi').on('click', '.ot-kpi', function () {
			const key = $(this).data('kpi-group');
			toggle_group_pin(key);
		});
	}

	function toggle_group_pin(key) {
		// Klik KPI card = "pin": papar group itu sahaja (toggle).
		if (S.pinned === key) {
			S.pinned = null;
		} else {
			S.pinned = key;
		}
		render_gantt();
	}

	function render_legend() {
		const items = [
			['overdue', __('Overdue — sudah lepas deadline')],
			['critical', __('Critical — ≤ 3 hari lagi')],
			['warning', __('Warning — ≤ 7 hari lagi')],
			['ok', __('On track')],
		];
		$('#ot-legend').html(
			`<div class="ot-legend">
				${items.map(([u, t]) => `<span class="ot-legend-item"><span class="ot-dot ot-dot--${u}"></span>${esc(t)}</span>`).join('')}
				<span class="ot-legend-item"><span class="ot-todaymark">▏</span> ${esc(__('Hari ini'))}</span>
			</div>`
		);
	}

	/* ---------- Gantt ---------- */

	function timeline_meta() {
		const r = S.data.range;
		const start = new Date(r.start + 'T00:00:00');
		const end = new Date(r.end + 'T00:00:00');
		const total_days = Math.max(1, Math.round((end - start) / 86400000) + 1);
		return { start, end, total_days };
	}

	function pct(day) {
		const { start, total_days } = timeline_meta();
		const d = new Date(day + 'T00:00:00');
		const off = Math.round((d - start) / 86400000);
		return Math.min(100, Math.max(0, (off / total_days) * 100));
	}

	function bar_style(it) {
		// Bar mesti sentiasa kelihatan walau sehari.
		let s = it.bar_start || it.deadline || S.data.today;
		let e = it.bar_end || it.deadline || S.data.today;
		if (s > e) [s, e] = [e, s];
		const left = pct(s);
		const right = pct(e);
		const width = Math.max(0.6, right - left);
		return `left:${left}%;width:${width}%`;
	}

	function days_badge(it) {
		const d = it.days_left;
		let text, cls = it.urgency;
		if (d === null || d === undefined) text = '—';
		else if (d < 0) text = __('{0}d overdue', [Math.abs(d)]);
		else if (d === 0) text = __('hari ini');
		else text = __('{0}d', [d]);
		return `<span class="ot-days ot-days--${cls}">${esc(text)}</span>`;
	}

	function render_gantt() {
		const groups = (S.data.groups || []).filter((g) => g.items && g.items.length);
		if (S.pinned) {
			const only = groups.filter((g) => g.key === S.pinned);
			if (only.length) {
				return render_groups(only, true);
			}
		}
		if (!groups.length) {
			$('#ot-gantt').html(
				`<div class="ot-empty">${__('Tiada item sensitif masa dalam horizon ini. 🎉')}</div>`
			);
			return;
		}
		render_groups(groups, false);
	}

	function render_groups(groups, pinned) {
		const meta = timeline_meta();
		const header = axis_header(meta);

		let html = `<div class="ot-gantt ${pinned ? 'ot-gantt--pinned' : ''}">`;
		if (pinned) {
			html += `<div class="ot-pin-note">${__('Menunjukkan')}: <strong>${esc(groups[0].label)}</strong> — <a href="#" class="ot-unpin">${__('tunjuk semua')}</a></div>`;
		}
		html += header;
		html += `<div class="ot-body">`;

		groups.forEach((g) => {
			const items = g.items.filter(item_passes);
			if (!items.length) return;
			const collapsed = !!S.collapsed[g.key];
			const kpi = (S.data.kpis || {})[g.key] || {};
			html += `
			<div class="ot-group" data-group="${esc(g.key)}">
				<div class="ot-group-head">
					<span class="ot-caret ${collapsed ? 'ot-caret--closed' : ''}">▾</span>
					<span class="ot-group-title">${esc(g.label)}</span>
					<span class="ot-group-count">${items.length}</span>
					${kpi.overdue ? `<span class="ot-group-flag ot-group-flag--overdue">${kpi.overdue} ${__('overdue')}</span>` : ''}
					${kpi.critical ? `<span class="ot-group-flag ot-group-flag--critical">${kpi.critical} ${__('critical')}</span>` : ''}
					<span class="ot-group-desc">${esc(g.description || '')}</span>
				</div>`;
			if (!collapsed) {
				html += `<div class="ot-group-items">${items.map(render_row).join('')}</div>`;
			}
			html += `</div>`;
		});

		html += `</div>${header}</div>`;
		$('#ot-gantt').html(html);
	}

	function axis_header(meta) {
		// Tiket bulan pada paksi masa — setiap 1 bulan + label tarikh mula.
		const ticks = [];
		const cur = new Date(meta.start);
		cur.setDate(1);
		if (cur < meta.start) cur.setMonth(cur.getMonth() + 1);
		while (cur <= meta.end) {
			ticks.push({ date: cur.toISOString().slice(0, 10), label: MONTHS[cur.getMonth()] + ' ' + String(cur.getFullYear()).slice(2) });
			cur.setMonth(cur.getMonth() + 1);
		}
		const today_pct = pct(S.data.today);
		return `
		<div class="ot-axis">
			<div class="ot-axis-labels">${__('Item / Deadline')}</div>
			<div class="ot-axis-track">
				<div class="ot-axis-ticks">
					${ticks.map((t) => `<span class="ot-axis-tick" style="left:${pct(t.date)}%">${esc(t.label)}</span>`).join('')}
				</div>
				<div class="ot-today-line" style="left:${today_pct}%"></div>
				<div class="ot-today-tag" style="left:${today_pct}%">${__('HARI INI')}</div>
			</div>
		</div>`;
	}

	function render_row(it) {
		const label_cell = `
			<div class="ot-row-label">
				<a class="ot-row-name" data-route="${esc(it.route || it.doctype + '/' + it.name)}" href="#">${esc(it.label)}</a>
				<div class="ot-row-sub">${esc(it.sublabel || '')}</div>
			</div>
			<div class="ot-row-meta">
				${days_badge(it)}
				<span class="ot-deadline" title="${__('Deadline')}">${it.deadline ? fmtDate(it.deadline) : '—'}</span>
				<span class="ot-note">${esc(it.meta || '')}</span>
			</div>`;

		const bar_cell = `
			<div class="ot-row-track">
				<div class="ot-bar ot-bar--${it.urgency}" style="${bar_style(it)}" title="${esc(it.label)} · ${esc(it.meta || '')}">
					${it.urgency === 'overdue' ? `<span class="ot-bar-flag">!</span>` : ''}
				</div>
				<div class="ot-row-grid"></div>
			</div>`;

		return `<div class="ot-row" data-route="${esc(it.route || it.doctype + '/' + it.name)}">${label_cell}${bar_cell}</div>`;
	}

	/* ========== EVENTS ========== */

	$(document).off('click', '.ot-group-head').on('click', '.ot-group-head', function () {
		const key = $(this).closest('.ot-group').data('group');
		S.collapsed[key] = !S.collapsed[key];
		render_gantt();
	});

	$(document).off('click', '.ot-unpin').on('click', '.ot-unpin', function (e) {
		e.preventDefault();
		S.pinned = null;
		render_gantt();
	});

	$(document).off('click', '.ot-row, .ot-row-name').on('click', '.ot-row, .ot-row-name', function (e) {
		e.preventDefault();
		e.stopPropagation();
		const route = $(this).closest('[data-route]').data('route') || $(this).data('route');
		if (route) frappe.set_route(route);
	});

	/* ========== STYLES ========== */

	function inject_styles() {
		if (document.getElementById('ot-page-css')) return;
		const css = `
		<style id="ot-page-css">
		#ot-container { padding: 4px 0 32px 0; font-size: 12px; color: #1e293b; }

		/* ---- Toolbar ---- */
		.ot-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 0 10px 0; flex-wrap: wrap; }
		.ot-toolbar-left { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.ot-select { border: 1px solid #e2e8f0; border-radius: 6px; padding: 4px 8px; font-size: 12px; color: #334155; background: #fff; min-width: 120px; }
		.ot-select:focus { outline: 2px solid #bfdbfe; border-color: #93c5fd; }

		/* ---- KPI cards ---- */
		#ot-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 8px; margin-bottom: 10px; }
		.ot-kpi { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: box-shadow .15s, border-color .15s; }
		.ot-kpi:hover { box-shadow: 0 2px 8px rgba(15,23,42,.08); }
		.ot-gantt--pinned .ot-kpi[data-kpi-group="${''}"] {}
		.ot-kpi-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
		.ot-kpi-icon { font-size: 13px; }
		.ot-kpi-label { font-weight: 600; font-size: 11px; color: #475569; text-transform: uppercase; letter-spacing: .02em; }
		.ot-kpi-body { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
		.ot-kpi-total { font-size: 20px; font-weight: 700; line-height: 1; }
		.ot-kpi-flag { font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 600; }
		.ot-kpi-flag--overdue { background: #fee2e2; color: #b91c1c; }
		.ot-kpi-flag--critical { background: #ffedd5; color: #c2410c; }
		.ot-kpi-flag--ok { background: #dcfce7; color: #15803d; }

		/* ---- Legend ---- */
		.ot-legend { display: flex; gap: 14px; align-items: center; padding: 6px 2px 10px; color: #64748b; flex-wrap: wrap; }
		.ot-legend-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
		.ot-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
		.ot-dot--overdue { background: #ef4444; }
		.ot-dot--critical { background: #f97316; }
		.ot-dot--warning { background: #eab308; }
		.ot-dot--ok { background: #10b981; }
		.ot-todaymark { color: #0ea5e9; font-weight: 700; }

		/* ---- Gantt ---- */
		.ot-gantt { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
		.ot-pin-note { padding: 8px 12px; background: #f0f9ff; color: #0369a1; font-size: 12px; border-bottom: 1px solid #e0f2fe; }
		.ot-unpin { margin-left: 6px; }

		.ot-axis { display: flex; border-bottom: 2px solid #e2e8f0; background: #f8fafc; position: sticky; top: 0; z-index: 5; }
		.ot-axis-labels { width: 340px; min-width: 340px; padding: 8px 12px; font-weight: 600; color: #475569; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; border-right: 1px solid #e2e8f0; }
		.ot-axis-track { position: relative; flex: 1; height: 32px; }
		.ot-axis-tick { position: absolute; top: 8px; transform: translateX(-50%); font-size: 10px; color: #94a3b8; white-space: nowrap; }
		.ot-today-line { position: absolute; top: 0; bottom: 0; width: 2px; background: #0ea5e9; z-index: 2; }
		.ot-today-tag { position: absolute; top: 2px; transform: translateX(-50%); background: #0ea5e9; color: #fff; font-size: 8px; font-weight: 700; padding: 1px 5px; border-radius: 4px; letter-spacing: .05em; z-index: 3; white-space: nowrap; }

		.ot-body { max-height: 62vh; overflow: auto; }

		.ot-group { border-bottom: 1px solid #e2e8f0; }
		.ot-group:last-child { border-bottom: none; }
		.ot-group-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: #f8fafc; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 4; }
		.ot-group-head:hover { background: #f1f5f9; }
		.ot-caret { color: #94a3b8; font-size: 10px; transition: transform .15s; }
		.ot-caret--closed { transform: rotate(-90deg); }
		.ot-group-title { font-weight: 700; font-size: 12px; }
		.ot-group-count { background: #e2e8f0; color: #475569; border-radius: 999px; font-size: 10px; font-weight: 700; padding: 1px 7px; }
		.ot-group-flag { font-size: 10px; padding: 1px 7px; border-radius: 999px; font-weight: 600; }
		.ot-group-flag--overdue { background: #fee2e2; color: #b91c1c; }
		.ot-group-flag--critical { background: #ffedd5; color: #c2410c; }
		.ot-group-desc { color: #94a3b8; font-size: 11px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }

		.ot-row { display: flex; align-items: center; border-top: 1px solid #f1f5f9; cursor: pointer; }
		.ot-row:hover { background: #f8fafc; }
		.ot-row-label { width: 200px; min-width: 200px; padding: 5px 0 5px 12px; }
		.ot-row-name { font-weight: 600; color: #1d4ed8; text-decoration: none; }
		.ot-row-name:hover { text-decoration: underline; }
		.ot-row-sub { color: #64748b; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
		.ot-row-meta { width: 140px; min-width: 140px; padding: 5px 8px 5px 0; display: flex; flex-direction: column; gap: 2px; align-items: flex-start; border-right: 1px dashed #e2e8f0; }
		.ot-days { font-size: 10px; font-weight: 700; padding: 0 6px; border-radius: 999px; }
		.ot-days--overdue { background: #fee2e2; color: #b91c1c; }
		.ot-days--critical { background: #ffedd5; color: #c2410c; }
		.ot-days--warning { background: #fef9c3; color: #a16207; }
		.ot-days--ok { background: #dcfce7; color: #15803d; }
		.ot-days--info { background: #e2e8f0; color: #475569; }
		.ot-deadline { font-size: 10px; color: #475569; }
		.ot-note { font-size: 9px; color: #94a3b8; max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

		.ot-row-track { position: relative; flex: 1; height: 34px; margin: 0 8px; }
		.ot-row-grid { position: absolute; inset: 0; background-image: linear-gradient(90deg, transparent calc(100% - 1px), #f1f5f9 100%); background-size: calc(100% / var(--ot-grid, 30)) 100%; pointer-events: none; }
		.ot-bar { position: absolute; top: 50%; transform: translateY(-50%); height: 14px; border-radius: 7px; min-width: 6px; z-index: 2; }
		.ot-bar--overdue { background: repeating-linear-gradient(45deg, #ef4444, #ef4444 6px, #f87171 6px, #f87171 12px); }
		.ot-bar--critical { background: #f97316; }
		.ot-bar--warning { background: #eab308; }
		.ot-bar--ok { background: #10b981; }
		.ot-bar--info { background: #94a3b8; }
		.ot-bar-flag { position: absolute; right: -7px; top: -5px; background: #b91c1c; color: #fff; font-size: 9px; font-weight: 800; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }

		.ot-loading, .ot-empty { padding: 60px 20px; text-align: center; color: #94a3b8; background: #fff; border: 1px dashed #e2e8f0; border-radius: 10px; margin-top: 8px; font-size: 13px; }

		@media (max-width: 1100px) {
			.ot-row-label { width: 150px; min-width: 150px; }
			.ot-row-meta { width: 110px; min-width: 110px; }
			.ot-axis-labels { width: 260px; min-width: 260px; }
			.ot-group-desc { display: none; }
		}
		</style>`;
		$('head').append(css);
	}

	return { init, on_show };
})();
