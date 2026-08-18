// travel_booking/travel_booking_management/page/trip_manager/trip_manager.js
// Desk Page /app/trip-manager — satu trip pada satu masa, inline forms (tiada modal).
//
// Routing: /app/trip-manager            -> empty (pilih/cipta trip)
//          /app/trip-manager/<trip-name> -> manage trip itu (3 doctype: Trip +
//          Trip Group Date + Trip Package) sebagai inline full forms.
//
// Navigasi antara trip (sub-route sama) ditangkap oleh frappe.router.on('change');
// on_page_show menangani ketibaan/refresh. Guard idempotensi elak double-load.
//
// Semua tulisan melalui travel_booking.api.trip_manager (server guna
// frappe.get_doc + save() — auto-generate nama/kod & validasi kekal di server).

frappe.pages['trip-manager'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Trip Manager'),
		single_column: true,
	});
	TripManagerPage.init(page, wrapper);
};

frappe.pages['trip-manager'].on_page_show = function (/* wrapper */) {
	if (window.TripManagerPage) TripManagerPage.on_show();
};

/* ============================================================
   TripManagerPage — controller (IIFE, sekali sahaja)
   ============================================================ */
window.TripManagerPage = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const S = {
		page: null,
		wrapper: null,
		bundle: null, // trip + dates + packages + lookups
		current: null, // trip name yang dipilih (dari route)
		tab: 'info',
		can_delete: false,
		creating: false, // tengah create trip baru (jangan ditindih route)
	};

	const DEFAULT_IMG = '/assets/travel_booking/img/defaultaroya.jpg';

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const fmtDate = (iso) => {
		if (!iso) return '';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return String(iso);
		return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
	};
	const fmtMoney = (n) =>
		parseFloat(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

	const addDays = (iso, n) => {
		if (!iso) return '';
		const d = new Date(iso + 'T00:00:00');
		d.setDate(d.getDate() + n);
		return d.toISOString().slice(0, 10);
	};

	const STATUS_COLORS = {
		Active: 'green', 'Pending Review': 'orange', Full: 'blue', Closed: 'gray',
		Completed: 'blue', Cancelled: 'red', Inactive: 'gray',
	};
	const badge = (label, color) =>
		`<span class="tm-badge tm-badge--${color || 'gray'}">${esc(label)}</span>`;

	// 6 kolum harga pricing (ikut trip_package.js / Trip Package Price)
	const PRICE_COLS = [
		['price_adult_single', 'Single (12+)'],
		['price_adult', 'Twin (12+)'],
		['price_upperberth', 'Upper'],
		['price_children', 'Child (5-11)'],
		['price_toddler', 'Toddler (2-4)'],
		['price_infant', 'Infant (0-2)'],
	];

	const debounce = (fn, ms) => {
		let t;
		// guna function biasa (bukan arrow) supaya `this` jQuery (elemen
		// input) terpelihara merentasi setTimeout — arrow akan kehilangkannya
		// dan $(this).val() jadi undefined → .trim() baling TypeError.
		return function (...a) {
			const ctx = this;
			clearTimeout(t);
			t = setTimeout(() => fn.apply(ctx, a), ms);
		};
	};

	/* ---------- API helper ---------- */
	const api = (method, args) =>
		new Promise((resolve, reject) => {
			frappe
				.call({
					method: 'travel_booking.api.trip_manager.' + method,
					args: args || {},
					freeze: true,
					freeze_message: __('Sila tunggu...'),
				})
				.then((r) => resolve(r && r.message))
				.catch((e) => reject(e));
		});

	/* ============================================================
	   ROUTING + LIFECYCLE
	   ============================================================ */
	function init(page, wrapper) {
		S.page = page;
		S.wrapper = $(wrapper);
		S.can_delete = frappe.user.has_role('Tour Manager');

		inject_css();
		build_shell();

		// sub-route change (navigasi antara trip, back/forward) — mekanisme utama
		frappe.router.on('change', on_route_change);
		// initial: event 'change' pertama dah berlaku sebelum on_page_load register
		on_route_change();
	}

	function on_show() {
		// ketibaan dari page lain / refresh — belt-and-suspenders (guard idempotensi)
		on_route_change();
	}

	function on_route_change() {
		const route = frappe.get_route() || [];
		if (route[0] !== 'trip-manager') return; // bukan page ini
		if (S.creating) return; // tengah create trip baru, jangan ditindih
		const trip = route[1] || null;
		if (trip && trip === S.current && S.bundle) return; // idempotensi
		if (trip) {
			load_trip(trip);
		} else {
			S.current = null;
			S.bundle = null;
			render_empty();
		}
	}

	/* ============================================================
	   SHELL + PICKER
	   ============================================================ */
	function build_shell() {
		S.page.main.append(`
			<div class="tm-picker-bar">
				<div class="tm-picker">
					<input type="text" class="tm-picker-input form-control input-sm" placeholder="${__('Cari trip...')}" />
					<div class="tm-picker-dropdown is-hidden"></div>
				</div>
				<div class="tm-current-label"></div>
				<button class="btn btn-primary btn-sm tm-new-trip">${__('+ Trip Baru')}</button>
			</div>
			<div class="tm-editor-area">
				<div class="tm-empty">${__('Pilih trip dari carian di atas, atau cipta trip baru.')}</div>
			</div>`);

		const $input = S.wrapper.find('.tm-picker-input');
		const $drop = S.wrapper.find('.tm-picker-dropdown');

		// Senaraikan SEMUA trip bila input difokus (q kosong → API pulangkan
		// semua, di-order by modified DESC); filter ikut teks ditaip. Inilah
		// carutan "senaraikan trip" — tak perlu menaip dulu untuk nampak senarai.
		const load_picker = (q) =>
			api('get_managed_trips', { q: q || '' }).then((trips) => render_picker_dropdown(trips || []));

		$input.on('focus', function () { load_picker(''); });
		$input.on('input', debounce(function () {
			load_picker($(this).val().trim());
		}, 300));

		// tutup dropdown bila klik luar
		$(document).on('click.tm-picker', function (e) {
			if (!$(e.target).closest('.tm-picker').length) $drop.addClass('is-hidden');
		});

		S.wrapper.find('.tm-new-trip').on('click', start_new_trip);
		wire_picker_clicks();
	}

	function render_picker_dropdown(trips) {
		const $drop = S.wrapper.find('.tm-picker-dropdown');
		if (!trips.length) {
			$drop.removeClass('is-hidden').html(
				`<div class="tm-picker-empty">${__('Tiada trip ditemui.')}</div>`);
			return;
		}
		$drop.removeClass('is-hidden').html(
			trips.map((t) => `
				<div class="tm-picker-row" data-name="${esc(t.name)}">
					<img class="tm-picker-thumb" src="${esc(t.trip_image || DEFAULT_IMG)}"
						onerror="this.src='${DEFAULT_IMG}'" />
					<div class="tm-picker-body">
						<div class="tm-picker-name">${esc(t.trip_name)}</div>
						<div class="tm-picker-sub">${esc(t.trip_organizer || '')} · ${t.date_count} tarikh · ${t.package_count} pakej</div>
					</div>
					${t.published ? badge('Published', 'green') : badge('Draft', 'gray')}
				</div>`).join(''));
	}

	// event delegate untuk row dropdown (daftar sekali)
	function wire_picker_clicks() {
		S.wrapper.on('click', '.tm-picker-row', function () {
			const name = $(this).data('name');
			S.wrapper.find('.tm-picker-dropdown').addClass('is-hidden');
			S.wrapper.find('.tm-picker-input').val('');
			frappe.set_route('trip-manager', name);
		});
	}

	/* ============================================================
	   LOAD + RENDER EDITOR
	   ============================================================ */
	function load_trip(name) {
		S.current = name;
		S.wrapper.find('.tm-editor-area').html(
			`<div class="tm-loading">${__('Memuat data trip...')}</div>`);
		return api('get_trip_bundle', { trip: name }).then((bundle) => {
			S.bundle = bundle;
			S.tab = S.tab || 'info';
			render_editor();
		});
	}

	function render_empty() {
		S.wrapper.find('.tm-editor-area').html(
			`<div class="tm-empty">${__('Pilih trip dari carian di atas, atau cipta trip baru.')}</div>`);
		S.wrapper.find('.tm-current-label').html('');
	}

	function render_editor() {
		const t = S.bundle.trip;
		const area = S.wrapper.find('.tm-editor-area').html('');
		S.wrapper.find('.tm-current-label').html(esc(t.trip_name));

		const dates = S.bundle.dates || [];
		const packages = S.bundle.packages || [];

		area.append(`
			<div class="tm-editor">
				<div class="tm-editor-head">
					<img class="tm-editor-cover" src="${esc(t.trip_image || DEFAULT_IMG)}"
						onerror="this.src='${DEFAULT_IMG}'" />
					<div class="tm-editor-head-body">
						<div class="tm-editor-title">${esc(t.trip_name)}</div>
						<div class="tm-editor-sub">
							${esc(t.name)} · ${esc(t.trip_organizer || '')}
							${t.route ? ` · <a href="/${esc(t.route)}" target="_blank">/${esc(t.route)}</a>` : ''}
						</div>
						<div class="tm-editor-badges">
							${t.published ? badge('Published', 'green') : badge('Draft', 'gray')}
							${badge(t.status, STATUS_COLORS[t.status])}
							${t.is_a_cruise_trip ? badge('Cruise Trip', 'blue') : ''}
						</div>
					</div>
					${S.can_delete ? `<button class="btn btn-danger btn-xs tm-del-trip">${__('Padam Trip')}</button>` : ''}
				</div>
				<div class="tm-tabs">
					<button class="tm-tab is-active" data-tab="info">${__('Maklumat Trip')}</button>
					<button class="tm-tab" data-tab="dates">${__('Tarikh Departure')} <span class="tm-tab-count">${dates.length}</span></button>
					<button class="tm-tab" data-tab="packages">${__('Pakej')} <span class="tm-tab-count">${packages.length}</span></button>
				</div>
				<div class="tm-pane" data-pane="info"></div>
				<div class="tm-pane is-hidden" data-pane="dates"></div>
				<div class="tm-pane is-hidden" data-pane="packages"></div>
			</div>`);

		render_info_pane();
		render_dates_pane();
		render_packages_pane();
		switch_tab(S.tab || 'info');

		// wire tabs + delete trip
		S.wrapper.find('.tm-tab').off('click.tm-tab').on('click.tm-tab', function () {
			switch_tab($(this).data('tab'));
		});
		S.wrapper.find('.tm-del-trip').off('click.tm-del').on('click.tm-del', function () {
			confirm_delete('Trip', S.current);
		});
	}

	function switch_tab(tab) {
		S.tab = tab;
		S.wrapper.find('.tm-tab').removeClass('is-active');
		S.wrapper.find(`.tm-tab[data-tab="${tab}"]`).addClass('is-active');
		S.wrapper.find('.tm-pane').addClass('is-hidden');
		S.wrapper.find(`.tm-pane[data-pane="${tab}"]`).removeClass('is-hidden');
	}

	/* ============================================================
	   TAB 1 — MAKLMAT TRIP (inline form)
	   ============================================================ */
	function render_info_pane() {
		const t = S.bundle.trip;
		const L = S.bundle.lookups;
		const pane = S.wrapper.find('.tm-pane[data-pane="info"]');

		const destSelected = new Set(t.destinations || []);
		const destChips = (L.destinations || []).map((d) =>
			`<span class="tm-chip ${destSelected.has(d.name) ? 'is-on' : ''}" data-dest="${esc(d.name)}">${esc(d.destination_name || d.name)} <span class="tm-chip-x">×</span></span>`
		).join('');

		pane.html(`
			<div class="tm-info-form">
				<div class="tm-grid-2">
					<div class="tm-field">
						<label>${__('Trip Name')} *</label>
						<input type="text" data-fld="trip_name" value="${esc(t.trip_name || '')}" />
					</div>
					<div class="tm-field">
						<label>${__('Organizer')}</label>
						<input type="text" value="${esc(t.trip_organizer || '')}" disabled />
						<div class="tm-hint">${__('Tidak boleh ditukar selepas create (set only once)')}</div>
					</div>
					<div class="tm-field">
						<label>${__('Status')}</label>
						${select_html('status', ['Pending Review', 'Active', 'Completed', 'Cancelled'], t.status)}
					</div>
					<div class="tm-field">
						<label>${__('Route (SEO)')}</label>
						<input type="text" data-fld="route" value="${esc(t.route || '')}" placeholder="trips/nama-trip" />
						<div class="tm-hint">${__('Kosongkan untuk jana semula automatik')}</div>
					</div>
				</div>
				<div class="tm-field">
					<label>${__('Cover Image')}</label>
					<div class="tm-image-row">
						<img class="tm-thumb" src="${esc(t.trip_image || DEFAULT_IMG)}" onerror="this.src='${DEFAULT_IMG}'" />
						<input type="text" data-fld="trip_image" value="${esc(t.trip_image || '')}" />
						<button class="btn btn-secondary btn-xs tm-upload-img">${__('Muat Naik Gambar')}</button>
					</div>
				</div>
				<div class="tm-field">
					<label>${__('Destinations')}</label>
					<div class="tm-chips" data-fld="destinations">${destChips}</div>
				</div>
				<div class="tm-grid-2">
					<label class="tm-check"><input type="checkbox" data-fld="published" ${t.published ? 'checked' : ''} /> ${__('Published')}</label>
					<label class="tm-check"><input type="checkbox" data-fld="is_a_cruise_trip" ${t.is_a_cruise_trip ? 'checked' : ''} /> ${__('Cruise Trip')}</label>
				</div>
				<div class="tm-field">
					<label>${__('Description')}</label>
					<textarea data-fld="description">${esc(t.description || '')}</textarea>
				</div>
				<button class="btn btn-primary btn-sm tm-save-info">${__('Simpan Maklumat Trip')}</button>
			</div>`);

		// destination chips toggle
		pane.find('.tm-chips[data-fld="destinations"] .tm-chip').on('click', function () {
			$(this).toggleClass('is-on');
		});
		pane.find('.tm-upload-img').on('click', upload_trip_image);
		pane.find('.tm-save-info').on('click', save_info);
	}

	function upload_trip_image() {
		const d = new frappe.ui.Dialog({
			title: __('Muat Naik Gambar'),
			fields: [{ fieldname: 'file', fieldtype: 'Attach', label: __('Gambar'), options: { allow_image: true } }],
		});
		d.set_value('file', S.wrapper.find('[data-fld="trip_image"]').val());
		d.set_primary_action(__('Set'), function () {
			const v = d.get_value('file');
			S.wrapper.find('[data-fld="trip_image"]').val(v || '');
			S.wrapper.find('.tm-thumb').attr('src', v || DEFAULT_IMG);
			d.hide();
		});
		d.show();
	}

	function collect_info() {
		const pane = S.wrapper.find('.tm-pane[data-pane="info"]');
		const destinations = pane.find('.tm-chips[data-fld="destinations"] .tm-chip.is-on')
			.map(function () { return $(this).data('dest'); }).get();
		return {
			name: S.current,
			trip_name: pane.find('[data-fld="trip_name"]').val(),
			status: pane.find('[data-fld="status"]').val(),
			route: pane.find('[data-fld="route"]').val(),
			trip_image: pane.find('[data-fld="trip_image"]').val(),
			description: pane.find('[data-fld="description"]').val(),
			published: pane.find('[data-fld="published"]').is(':checked') ? 1 : 0,
			is_a_cruise_trip: pane.find('[data-fld="is_a_cruise_trip"]').is(':checked') ? 1 : 0,
			destinations,
		};
	}

	function save_info() {
		const payload = collect_info();
		if (!payload.trip_name) { frappe.msgprint(__('Trip Name wajib diisi.')); return; }
		api('save_trip', { payload }).then(() => {
			frappe.show_alert(__('Disimpan.'), 3);
			return load_trip(S.current);
		});
	}

	/* ============================================================
	   TAB 2 — TARIKH DEPARTURE (stack of inline full forms)
	   ============================================================ */
	function render_dates_pane() {
		const pane = S.wrapper.find('.tm-pane[data-pane="dates"]');
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const dates = S.bundle.dates || [];

		pane.html(`<div class="tm-form-stack"></div>
			<button class="btn btn-secondary btn-sm tm-add-date">${__('+ Tambah Tarikh')}</button>`);

		const stack = pane.find('.tm-form-stack');
		dates.forEach((dt) => stack.append(render_date_form(dt, false)));
		if (!dates.length) {
			stack.append(`<div class="tm-empty-inline">${isCruise
				? __('Tiada tarikh. Tambah untuk pilih cruise schedule.')
				: __('Tiada tarikh departure. Klik "Tambah Tarikh".')}</div>`);
		}

		pane.find('.tm-add-date').on('click', function () {
			stack.find('.tm-empty-inline').remove();
			stack.append(render_date_form(null, true));
		});
	}

	function render_date_form(dt, creating) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const L = S.bundle.lookups;
		const cruiseOnly = creating ? false : !!dt.is_cruise_only;

		const scheduleOptions = (L.cruise_schedules || []).map((s) =>
			`<option value="${esc(s.name)}" ${dt && dt.cruise_schedule === s.name ? 'selected' : ''}>${esc(s.schedule_code)} · ${esc(s.ship_name)} · ${fmtDate(s.sail_start)}</option>`
		).join('');

		// info cruise sedia ada (dari field tersimpan pada Trip Group Date)
		const existingCruiseInfo = (!creating && isCruise && dt && dt.cruise_schedule)
			? `<div class="tm-cruise-info">${cruise_info_html(dt)}</div>` : '';

		const cruiseSection = isCruise ? `
			<div class="tm-section tm-cruise-section">
				<div class="tm-field">
					<label>${__('Cruise Schedule')}</label>
					<select data-fld="cruise_schedule"><option value="">${__('— Pilih —')}</option>${scheduleOptions}</select>
				</div>
				<div data-cruise-info>${existingCruiseInfo}</div>
				${creating
					? `<label class="tm-check"><input type="checkbox" data-fld="is_cruise_only" /> ${__('Cruise Only')}</label>`
					: (cruiseOnly ? `<div>${badge('Cruise Only', 'blue')}</div>` : '')}
			</div>` : '';

		const datesHidden = cruiseOnly ? 'is-hidden' : '';
		const $form = $(`
			<div class="tm-form-card tm-date-form" data-name="${creating ? '' : esc(dt.name)}" data-creating="${creating ? 1 : 0}">
				<div class="tm-form-head">
					<div>
						<div class="tm-form-title">${creating ? __('Tarikh Baru') : esc(dt.trip_group_name)}</div>
						<div class="tm-form-sub">${creating ? '' : esc(dt.trip_group_code || '')}</div>
					</div>
					<div class="tm-form-actions">
						${creating ? `<button class="btn btn-default btn-xs tm-cancel-new">${__('Batal')}</button>` : ''}
						${!creating && S.can_delete ? `<button class="btn btn-danger btn-xs tm-del-date">${__('Padam')}</button>` : ''}
					</div>
				</div>
				<div class="tm-form-body">
					${cruiseSection}
					<div class="tm-section tm-dates-section ${datesHidden}">
						<div class="tm-grid-2">
							<div class="tm-field">
								<label>${__('Departure')} *</label>
								<input type="date" data-fld="departure_date" value="${creating ? '' : esc(dt.departure_date || '')}" />
							</div>
							<div class="tm-field">
								<label>${__('Return')} *</label>
								<input type="date" data-fld="return_date" value="${creating ? '' : esc(dt.return_date || '')}" />
							</div>
						</div>
						${!creating && (dt.total_days || dt.total_nights)
							? `<div class="tm-hint">${dt.total_days}D ${dt.total_nights}N</div>` : ''}
					</div>
					<div class="tm-section">
						<div class="tm-grid-2">
							<div class="tm-field">
								<label>${__('Capacity')}</label>
								<input type="number" min="0" data-fld="max_participants" value="${creating ? (isCruise ? 0 : 12) : (dt.max_participants || 0)}" />
							</div>
							<div class="tm-field">
								<label>${__('Status')}</label>
								${select_html('status', ['Active', 'Full', 'Closed', 'Completed', 'Pending Review', 'Cancelled'], creating ? 'Active' : dt.status)}
							</div>
						</div>
						${!creating ? `<div class="tm-hint">${__('Ditempah')}: ${dt.current_participants || 0} · ${__('Kosong')}: ${dt.available_slots || 0}</div>` : ''}
					</div>
					<div class="tm-field">
						<label>${__('Description')}</label>
						<textarea data-fld="trip_group_description">${creating ? '' : esc(dt.trip_group_description || '')}</textarea>
					</div>
				</div>
				<div class="tm-form-foot">
					<button class="btn btn-primary btn-sm tm-save-date">${__('Simpan')}</button>
				</div>
			</div>`);

		wire_date_form($form, creating);
		return $form;
	}

	function cruise_info_html(sch) {
		// sch = objek cruise schedule (dari lookup) ATAU date record dgn field sailing_*
		const sailStart = sch.sail_start || sch.sailing_start;
		const sailEnd = sch.sail_end || sch.sailing_end;
		const ship = sch.ship_name;
		const shipCode = sch.ship_code;
		const portStart = sch.port_start || sch.embarkation_port;
		const portEnd = sch.port_end || sch.disembarkation_port;
		const days = sch.total_days || sch.cruise_days;
		return `<div>Ship: ${esc(ship || '-')} ${shipCode ? '(' + esc(shipCode) + ')' : ''}</div>
			<div>Sailing: ${fmtDate(sailStart)} → ${fmtDate(sailEnd)} ${days ? '· ' + days + 'D' : ''}</div>
			<div>Port: ${esc(portStart || '-')} → ${esc(portEnd || '-')}</div>`;
	}

	function wire_date_form($form, creating) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;

		if (isCruise) {
			$form.find('[data-fld="cruise_schedule"]').on('change', function () { on_date_cruise_change($form); });
		}
		if (creating && isCruise) {
			$form.find('[data-fld="is_cruise_only"]').on('change', function () { on_date_cruise_only_change($form); });
		}
		$form.find('[data-fld="departure_date"]').on('change', function () { on_date_departure_change($form); });

		$form.find('.tm-save-date').on('click', function () { save_date_form($form, creating); });
		$form.find('.tm-cancel-new').on('click', function () { $form.remove(); });
		$form.find('.tm-del-date').on('click', function () {
			confirm_delete('Trip Group Date', $form.data('name'));
		});
	}

	function on_date_cruise_change($form) {
		const sel = $form.find('[data-fld="cruise_schedule"]').val();
		const sch = (S.bundle.lookups.cruise_schedules || []).find((s) => s.name === sel);
		const $info = $form.find('[data-cruise-info]');
		if (!sch) { $info.empty(); return; }
		$info.html(`<div class="tm-cruise-info">${cruise_info_html(sch)}</div>`);

		const $dep = $form.find('[data-fld="departure_date"]');
		const $ret = $form.find('[data-fld="return_date"]');
		const only = $form.find('[data-fld="is_cruise_only"]').is(':checked');
		if (only) {
			$dep.val(sch.sail_start); $ret.val(sch.sail_end);
		} else {
			// Fly Cruise: suggest sail-1 / sail+1 bila kosong
			if (!$dep.val()) $dep.val(addDays(sch.sail_start, -1));
			if (!$ret.val()) $ret.val(addDays(sch.sail_end, 1));
		}
		toggle_date_dates_section($form);
	}

	function on_date_cruise_only_change($form) {
		const only = $form.find('[data-fld="is_cruise_only"]').is(':checked');
		const sch = (S.bundle.lookups.cruise_schedules || [])
			.find((s) => s.name === $form.find('[data-fld="cruise_schedule"]').val());
		if (only && sch) {
			$form.find('[data-fld="departure_date"]').val(sch.sail_start);
			$form.find('[data-fld="return_date"]').val(sch.sail_end);
		}
		$form.find('[data-fld="max_participants"]').val(0);
		toggle_date_dates_section($form);
	}

	function on_date_departure_change($form) {
		const dep = $form.find('[data-fld="departure_date"]').val();
		const $ret = $form.find('[data-fld="return_date"]');
		const ret = $ret.val();
		if (!dep) return;
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		let length = 14; // non-cruise default
		if (isCruise) {
			const sch = (S.bundle.lookups.cruise_schedules || [])
				.find((s) => s.name === $form.find('[data-fld="cruise_schedule"]').val());
			length = (sch && sch.total_days > 0) ? sch.total_days : 7;
		}
		if (!ret || dep > ret) $ret.val(addDays(dep, length));
	}

	function toggle_date_dates_section($form) {
		const only = $form.find('[data-fld="is_cruise_only"]').is(':checked');
		$form.find('.tm-dates-section').toggleClass('is-hidden', only);
	}

	function collect_date_form($form, creating) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const payload = {
			departure_date: $form.find('[data-fld="departure_date"]').val(),
			return_date: $form.find('[data-fld="return_date"]').val(),
			max_participants: $form.find('[data-fld="max_participants"]').val(),
			status: $form.find('[data-fld="status"]').val(),
			trip_group_description: $form.find('[data-fld="trip_group_description"]').val(),
		};
		if (creating) {
			payload.trip = S.current;
			if (isCruise) {
				payload.cruise_schedule = $form.find('[data-fld="cruise_schedule"]').val() || '';
				payload.is_cruise_only = $form.find('[data-fld="is_cruise_only"]').is(':checked') ? 1 : 0;
			}
		} else {
			payload.name = $form.data('name');
			if (isCruise) payload.cruise_schedule = $form.find('[data-fld="cruise_schedule"]').val() || '';
		}
		return payload;
	}

	function save_date_form($form, creating) {
		const payload = collect_date_form($form, creating);
		const only = $form.find('[data-fld="is_cruise_only"]').is(':checked');
		// validation: departure <= return (kecuali cruise-only)
		if (!only && payload.departure_date && payload.return_date && payload.departure_date > payload.return_date) {
			frappe.msgprint(__('Departure mesti lebih awal dari Return.')); return;
		}
		if (S.bundle.trip.is_a_cruise_trip && creating && !payload.cruise_schedule) {
			frappe.msgprint(__('Cruise Schedule wajib untuk trip cruise.')); return;
		}
		api('save_group_date', { payload }).then(() => {
			frappe.show_alert(__('Disimpan.'), 3);
			return load_trip(S.current);
		});
	}

	/* ============================================================
	   TAB 3 — PAKEJ (stack of inline full forms)
	   ============================================================ */
	function render_packages_pane() {
		const pane = S.wrapper.find('.tm-pane[data-pane="packages"]');
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const packages = S.bundle.packages || [];

		pane.html(`<div class="tm-form-stack"></div>
			<button class="btn btn-secondary btn-sm tm-add-pkg">${__('+ Tambah Pakej')}</button>`);

		const stack = pane.find('.tm-form-stack');
		packages.forEach((p) => stack.append(render_package_form(p, false)));
		if (!packages.length) {
			stack.append(`<div class="tm-empty-inline">${__('Tiada pakej. Klik "Tambah Pakej".')}</div>`);
		}

		pane.find('.tm-add-pkg').on('click', function () {
			stack.find('.tm-empty-inline').remove();
			stack.append(render_package_form(null, true));
		});
	}

	function render_package_form(p, creating) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const L = S.bundle.lookups;
		const cruiseOnly = creating ? false : !!p.is_cruise_only;

		// package_type: locked selepas create
		const pkgTypeField = creating
			? `<select data-fld="package_type"></select>`
			: `<div class="tm-readonly">${esc(p.package_type || '')}</div>`;

		// is_cruise_only: checkbox hanya create + cruise
		const cruiseOnlyField = (creating && isCruise)
			? `<label class="tm-check"><input type="checkbox" data-fld="is_cruise_only" /> ${__('Cruise Only')}</label>`
			: (cruiseOnly ? badge('Cruise Only', 'blue') : '');

		// airport_form: locked selepas create
		const airportField = creating
			? `<select data-fld="airport_form"><option value="">${__('— Pilih —')}</option>${airport_options(L.airports)}</select>`
			: `<div class="tm-readonly">${esc(p.airport_form || '-')}</div>`;

		const $form = $(`
			<div class="tm-form-card tm-pkg-form" data-name="${creating ? '' : esc(p.name)}" data-creating="${creating ? 1 : 0}" data-pkg-type="${creating ? '' : esc(p.package_type || '')}" data-cruise-only="${creating ? 0 : (p.is_cruise_only ? 1 : 0)}">
				<div class="tm-form-head">
					<div>
						<div class="tm-form-title">${creating ? __('Pakej Baru') : esc(p.package_title)}</div>
						<div class="tm-form-sub">${creating ? '' : esc(p.package_code || '')}</div>
					</div>
					<div class="tm-form-actions">
						${creating ? `<button class="btn btn-default btn-xs tm-cancel-new">${__('Batal')}</button>` : ''}
						${!creating && S.can_delete ? `<button class="btn btn-danger btn-xs tm-del-pkg">${__('Padam')}</button>` : ''}
					</div>
				</div>
				<div class="tm-form-body">
					<div class="tm-grid-2">
						<div class="tm-field">
							<label>${__('Package Type')}</label>
							${pkgTypeField}
						</div>
						<div class="tm-field">${cruiseOnlyField}</div>
						<div class="tm-field tm-airport-field">
							<label>${__('Depart From (Airport)')}</label>
							${airportField}
						</div>
						<div class="tm-field">
							<label>${__('Currency')}</label>
							${select_html('currency', (L.currencies || []).map((c) => c.name), creating ? 'MYR' : (p.currency || 'MYR'))}
						</div>
						<div class="tm-field">
							<label>${__('Status')}</label>
							${select_html('status', ['Pending Review', 'Active', 'Inactive'], creating ? 'Active' : p.status)}
						</div>
					</div>
					<div class="tm-field">
						<label>${__('Package Description')}</label>
						<textarea data-fld="package_description">${creating ? '' : esc(p.package_description || '')}</textarea>
					</div>
					<div class="tm-field">
						<label>${__('Select Trip Dates')}</label>
						<div class="tm-chips" data-date-chips></div>
					</div>
					<div class="tm-field">
						<label>${__('Pricing')}</label>
						${isCruise ? `<button class="btn btn-secondary btn-xs tm-import-cruise">${__('Import dari Cruise Rate')}</button>` : ''}
						<div class="tm-pricing-table" data-pricing-grid></div>
					</div>
				</div>
				<div class="tm-form-foot">
					<button class="btn btn-primary btn-sm tm-save-pkg">${__('Simpan')}</button>
				</div>
			</div>`);

		// setup package_type options + auto-set (create)
		if (creating) setup_package_type($form);

		// date chips + pricing grid
		const selectedDates = creating ? [] : (p.dates || []);
		render_pkg_date_chips($form, selectedDates);
		const pricingRows = creating ? [] : (p.pricing || []);
		render_pricing_grid($form, pricingRows);

		wire_package_form($form, creating);
		toggle_pkg_airport($form);
		return $form;
	}

	function setup_package_type($form) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const sel = $form.find('[data-fld="package_type"]');
		if (isCruise) {
			sel.html('<option value="Fly Cruise">Fly Cruise</option><option value="Cruise Only">Cruise Only</option>');
			const only = $form.find('[data-fld="is_cruise_only"]').is(':checked');
			sel.val(only ? 'Cruise Only' : 'Fly Cruise');
		} else {
			sel.html('<option value="Fly Package">Fly Package</option><option value="Ground Only">Ground Only</option><option value="Customed">Customed</option>');
		}
	}

	function airport_options(airports) {
		return (airports || []).map((a) => `<option value="${esc(a.name)}">${esc(a.airport_code || a.name)} · ${esc(a.airport_name || '')}</option>`).join('');
	}

	function render_pkg_date_chips($form, selected) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const sel = new Set(selected || []);
		let dates = S.bundle.dates || [];
		if (isCruise) {
			const only = pkg_cruise_only($form);
			dates = dates.filter((d) => !!d.is_cruise_only === only);
		}
		const chips = dates.map((d) =>
			`<span class="tm-chip ${sel.has(d.name) ? 'is-on' : ''}" data-date="${esc(d.name)}">${fmtDate(d.departure_date)}${d.is_cruise_only ? ' · CO' : ''} <span class="tm-chip-x">×</span></span>`
		).join('');
		$form.find('[data-date-chips]').html(chips || `<span class="tm-hint">${__('Tiada tarikh layak.')}</span>`);
	}

	function render_pricing_grid($form, rows) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const cats = (S.bundle.lookups.price_categories || [])
			.filter((c) => (isCruise ? c.is_a_cruise : !c.is_a_cruise));
		const grid = $form.find('[data-pricing-grid]').empty();
		grid.append(`<div class="tm-pricing-head">
			<div>Category</div>${PRICE_COLS.map((c) => `<div>${c[1]}</div>`).join('')}<div></div></div>`);
		(rows || []).forEach((r) => grid.append(pricing_row_html(r, cats)));
		grid.append(`<button type="button" class="tm-pricing-add">+ ${__('Kategori')}</button>`);
	}

	function pricing_row_html(r, cats) {
		const opts = cats.map((c) => `<option value="${esc(c.name)}" ${c.name === r.pricing_for_class ? 'selected' : ''}>${esc(c.category_name)}</option>`).join('');
		return `<div class="tm-pricing-row">
			<select data-prc="pricing_for_class"><option value="">—</option>${opts}</select>
			${PRICE_COLS.map((c) => `<input type="number" step="0.01" min="0" data-prc="${c[0]}" value="${esc(r[c[0]] || 0)}" />`).join('')}
			<button type="button" class="tm-pricing-del" title="${__('Buang')}">×</button>
		</div>`;
	}

	function wire_package_form($form, creating) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;

		if (creating && isCruise) {
			$form.find('[data-fld="is_cruise_only"]').on('change', function () {
				setup_package_type($form);
				// reset dates & airport bila toggle cruise-only
				render_pkg_date_chips($form, []);
				if (creating) $form.find('[data-fld="airport_form"]').val('');
				toggle_pkg_airport($form);
			});
		}
		if (creating) {
			$form.find('[data-fld="package_type"]').on('change', function () { toggle_pkg_airport($form); });
			$form.find('[data-fld="airport_form"]').on('change', function () {
				// cadang currency dari airport (jika belum diubah user)
				const ap = (S.bundle.lookups.airports || []).find((a) => a.name === $(this).val());
				if (ap && ap.currency) $form.find('[data-fld="currency"]').val(ap.currency);
			});
		}

		// date chips toggle
		$form.on('click', '[data-date-chips] .tm-chip', function () {
			$(this).toggleClass('is-on');
		});

		// pricing grid: add / del
		$form.on('click', '.tm-pricing-add', function () {
			const isC = S.bundle.trip.is_a_cruise_trip;
			const cats = (S.bundle.lookups.price_categories || []).filter((c) => (isC ? c.is_a_cruise : !c.is_a_cruise));
			$(this).before(pricing_row_html({}, cats));
		});
		$form.on('click', '.tm-pricing-del', function () {
			$(this).closest('.tm-pricing-row').remove();
		});

		// cruise import
		$form.find('.tm-import-cruise').on('click', function () { import_cruise_rate($form); });

		$form.find('.tm-save-pkg').on('click', function () { save_package_form($form, creating); });
		$form.find('.tm-cancel-new').on('click', function () { $form.remove(); });
		$form.find('.tm-del-pkg').on('click', function () {
			confirm_delete('Trip Package', $form.data('name'));
		});
	}

	function pkg_cruise_only($form) {
		const $cb = $form.find('[data-fld="is_cruise_only"]');
		if ($cb.length) return $cb.is(':checked');
		return $form.attr('data-cruise-only') === '1';
	}

	function toggle_pkg_airport($form) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const only = pkg_cruise_only($form);
		const $pt = $form.find('[data-fld="package_type"]');
		const ptype = $pt.is('select') ? $pt.val() : ($form.attr('data-pkg-type') || '');
		const show = (!only && isCruise) || (ptype === 'Fly Package');
		$form.find('.tm-airport-field').toggleClass('is-hidden', !show);
	}

	function import_cruise_rate($form) {
		const selected = $form.find('[data-date-chips] .tm-chip.is-on').map(function () { return $(this).data('date'); }).get();
		if (!selected.length) { frappe.msgprint(__('Pilih sekurang-kurangnya satu tarikh dahulu.')); return; }
		const dt = (S.bundle.dates || []).find((d) => d.name === selected[0]);
		if (!dt || !dt.cruise_schedule) { frappe.msgprint(__('Tarikh ini tiada cruise schedule.')); return; }
		frappe.db.get_doc('Trip Cruise Schedule', dt.cruise_schedule).then((sch) => {
			const rows = (sch.cabin_rates || []).map((cr) => ({
				pricing_for_class: cr.pricing_for_class,
				price_adult_single: cr.price_adult_single,
				price_adult: cr.price_adult,
				price_upperberth: cr.price_upperberth,
				price_children: cr.price_children,
				price_toddler: cr.price_toddler,
				price_infant: cr.price_infant,
			}));
			render_pricing_grid($form, rows);
			frappe.show_alert(__('Cabin rates diimport.'), 3);
		});
	}

	function collect_package_form($form, creating) {
		const isCruise = S.bundle.trip.is_a_cruise_trip;
		const dates = $form.find('[data-date-chips] .tm-chip.is-on').map(function () { return $(this).data('date'); }).get();
		const pricing = [];
		$form.find('.tm-pricing-row').each(function () {
			const cls = $(this).find('[data-prc="pricing_for_class"]').val();
			if (!cls) return; // skip row tanpa kategori
			const row = { pricing_for_class: cls };
			PRICE_COLS.forEach((c) => { row[c[0]] = parseFloat($(this).find(`[data-prc="${c[0]}"]`).val()) || 0; });
			pricing.push(row);
		});
		const payload = {
			currency: $form.find('[data-fld="currency"]').val(),
			status: $form.find('[data-fld="status"]').val(),
			package_description: $form.find('[data-fld="package_description"]').val(),
			dates,
			pricing,
		};
		if (creating) {
			payload.trip_link = S.current;
			payload.package_type = $form.find('[data-fld="package_type"]').val();
			if (isCruise) payload.is_cruise_only = $form.find('[data-fld="is_cruise_only"]').is(':checked') ? 1 : 0;
			payload.airport_form = $form.find('[data-fld="airport_form"]').val() || '';
		} else {
			payload.name = $form.data('name');
		}
		return payload;
	}

	function save_package_form($form, creating) {
		const payload = collect_package_form($form, creating);
		if (creating && !payload.package_type) { frappe.msgprint(__('Package Type wajib.')); return; }
		if (creating && payload.package_type === 'Fly Package' && !payload.airport_form) {
			frappe.msgprint(__('Airport wajib untuk Fly Package.')); return;
		}
		api('save_package', { payload }).then(() => {
			frappe.show_alert(__('Disimpan.'), 3);
			return load_trip(S.current);
		});
	}

	/* ============================================================
	   NEW TRIP (inline create, bukan modal)
	   ============================================================ */
	function start_new_trip() {
		S.creating = true;
		S.current = null;
		S.bundle = null;
		frappe.set_route('trip-manager'); // kosongkan segmen (on_route_change pulang awal kerana S.creating)
		render_new_trip_form();
	}

	function render_new_trip_form() {
		const L = S.bundle && S.bundle.lookups ? S.bundle.lookups : null;
		// bundle mungkin null; fetch lookups ringan untuk organizer
		S.wrapper.find('.tm-current-label').html(__('Trip Baru'));
		const area = S.wrapper.find('.tm-editor-area');
		area.html(`<div class="tm-loading">${__('Memuat...')}</div>`);

		// dapatkan organizer list (bundle tak ada lagi) — guna get_managed_trips kosong tak sesuai;
		// sebaliknya fetch organizer melalui endpoint sedia ada tak ada. Guna frappe.db.get_list.
		frappe.db.get_list('Trip Organizer', { fields: ['name'], limit_page_length: 200 }).then((orgs) => {
			const orgOpts = orgs.map((o) => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('');
			area.html(`
				<div class="tm-editor">
					<div class="tm-editor-head">
						<div class="tm-editor-head-body">
							<div class="tm-editor-title">${__('Trip Baru')}</div>
							<div class="tm-editor-sub">${__('Isi maklumat asas, kemudian Simpan untuk mula urus trip ini.')}</div>
						</div>
						<button class="btn btn-default btn-xs tm-cancel-new-trip">${__('Batal')}</button>
					</div>
					<div class="tm-pane">
						<div class="tm-info-form">
							<div class="tm-grid-2">
								<div class="tm-field">
									<label>${__('Trip Name')} *</label>
									<input type="text" data-fld="trip_name" />
								</div>
								<div class="tm-field">
									<label>${__('Organizer')} *</label>
									<select data-fld="trip_organizer"><option value="">${__('— Pilih —')}</option>${orgOpts}</select>
								</div>
							</div>
							<label class="tm-check"><input type="checkbox" data-fld="is_a_cruise_trip" /> ${__('Cruise Trip')}</label>
							<div class="tm-form-foot">
								<button class="btn btn-primary btn-sm tm-save-new-trip">${__('Cipta Trip')}</button>
							</div>
						</div>
					</div>
				</div>`);

			area.find('.tm-save-new-trip').on('click', save_new_trip);
			area.find('.tm-cancel-new-trip').on('click', cancel_new_trip);
		});
	}

	function save_new_trip() {
		const area = S.wrapper.find('.tm-editor-area');
		const payload = {
			trip_name: area.find('[data-fld="trip_name"]').val(),
			trip_organizer: area.find('[data-fld="trip_organizer"]').val(),
			is_a_cruise_trip: area.find('[data-fld="is_a_cruise_trip"]').is(':checked') ? 1 : 0,
		};
		if (!payload.trip_name) { frappe.msgprint(__('Trip Name wajib.')); return; }
		if (!payload.trip_organizer) { frappe.msgprint(__('Organizer wajib.')); return; }
		api('save_trip', { payload }).then((r) => {
			S.creating = false;
			frappe.show_alert(__('Trip dicipta.'), 3);
			frappe.set_route('trip-manager', r.name);
		});
	}

	function cancel_new_trip() {
		S.creating = false;
		frappe.set_route('trip-manager'); // kembali ke empty (atau trip sebelumnya via back)
		render_empty();
	}

	/* ============================================================
	   DELETE
	   ============================================================ */
	function confirm_delete(doctype, name) {
		frappe.confirm(__('Padam {0}?', [doctype]), function () {
			api('delete_doc', { doctype, name }).then(() => {
				frappe.show_alert(__('Dipadam.'), 3);
				if (doctype === 'Trip') {
					S.current = null; S.bundle = null;
					frappe.set_route('trip-manager');
					render_empty();
				} else {
					load_trip(S.current); // reload bundle
				}
			});
		});
	}

	/* ============================================================
	   HELPERS
	   ============================================================ */
	function select_html(fieldname, options, selected) {
		const opts = options.map((o) => {
			const val = typeof o === 'string' ? o : o.value;
			const lbl = typeof o === 'string' ? o : o.label;
			return `<option value="${esc(val)}" ${val === selected ? 'selected' : ''}>${esc(lbl)}</option>`;
		}).join('');
		return `<select data-fld="${fieldname}">${opts}</select>`;
	}

	/* ============================================================
	   CSS (scoped .tm-*)
	   ============================================================ */
	function inject_css() {
		if (document.getElementById('tm-page-css')) return;
		const css = `
		.tm-picker-bar { display: flex; gap: 10px; align-items: center; padding: 0 0 14px; flex-wrap: wrap; }
		.tm-picker { position: relative; flex: 1; min-width: 220px; max-width: 420px; }
		.tm-picker-input { width: 100%; }
		.tm-current-label { font-size: 13px; font-weight: 600; color: var(--text-color,#202933); }
		.tm-picker-dropdown { position: absolute; z-index: 50; top: 100%; left: 0; right: 0; margin-top: 2px;
			background: var(--card-bg,#fff); border: 1px solid var(--border-color,#d1d8dd); border-radius: 8px;
			box-shadow: 0 6px 18px rgba(0,0,0,.12); max-height: 360px; overflow-y: auto; }
		.tm-picker-dropdown.is-hidden { display: none; }
		.tm-picker-row { display: flex; gap: 10px; padding: 8px 12px; cursor: pointer; align-items: center;
			border-bottom: 1px solid var(--border-color,#ebeff2); }
		.tm-picker-row:last-child { border-bottom: none; }
		.tm-picker-row:hover { background: var(--bg-light-gray,#f8f8f8); }
		.tm-picker-thumb { width: 36px; height: 36px; border-radius: 6px; object-fit: cover; }
		.tm-picker-body { flex: 1; min-width: 0; }
		.tm-picker-name { font-size: 12px; font-weight: 600; color: var(--text-color,#202933);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.tm-picker-sub { font-size: 10px; color: var(--text-muted,#8d99a6); margin-top: 1px; }
		.tm-picker-empty { padding: 16px; text-align: center; font-size: 12px; color: var(--text-muted,#8d99a6); }

		.tm-editor-area { padding-bottom: 40px; }
		.tm-empty { background: var(--card-bg,#fff); border: 1px dashed var(--border-color,#d1d8dd);
			border-radius: 8px; padding: 60px 20px; text-align: center; color: var(--text-muted,#8d99a6); }
		.tm-loading { padding: 40px; text-align: center; color: var(--text-muted,#8d99a6); }

		.tm-editor { background: var(--card-bg,#fff); border: 1px solid var(--border-color,#d1d8dd); border-radius: 8px; }
		.tm-editor-head { display: flex; gap: 14px; padding: 16px; border-bottom: 1px solid var(--border-color,#ebeff2); align-items: center; }
		.tm-editor-cover { width: 84px; height: 84px; border-radius: 8px; object-fit: cover; flex-shrink: 0;
			border: 1px solid var(--border-color,#ebeff2); }
		.tm-editor-head-body { flex: 1; min-width: 0; }
		.tm-editor-title { font-size: 16px; font-weight: 700; color: var(--text-color,#202933); }
		.tm-editor-sub { font-size: 12px; color: var(--text-muted,#8d99a6); margin: 3px 0 6px; }
		.tm-editor-sub a { color: #3b73d9; }
		.tm-editor-badges { display: flex; gap: 6px; flex-wrap: wrap; }

		.tm-tabs { display: flex; border-bottom: 1px solid var(--border-color,#ebeff2); padding: 0 8px; }
		.tm-tab { border: none; background: none; padding: 11px 14px; font-size: 12px; font-weight: 600;
			color: var(--text-muted,#8d99a6); border-bottom: 2px solid transparent; cursor: pointer; }
		.tm-tab.is-active { color: var(--text-color,#202933); border-bottom-color: #c9a84c; }
		.tm-tab-count { background: #f0f0f0; border-radius: 8px; padding: 0 6px; margin-left: 5px; font-size: 10px; }

		.tm-pane { padding: 16px; }
		.tm-pane.is-hidden, .is-hidden { display: none; }

		.tm-badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
		.tm-badge--green { background: #e1f3e8; color: #1d9c57; }
		.tm-badge--orange { background: #fdf2e2; color: #b96900; }
		.tm-badge--blue { background: #e2ecfd; color: #3b73d9; }
		.tm-badge--gray { background: #eef1f3; color: #6c7a89; }
		.tm-badge--red { background: #fde8e8; color: #c0392b; }

		.tm-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
		.tm-field { margin-bottom: 10px; }
		.tm-field label { display: block; font-size: 11px; font-weight: 600; color: var(--text-muted,#8d99a6); margin-bottom: 4px; }
		.tm-field input[type=text], .tm-field input[type=number], .tm-field select, .tm-field textarea {
			width: 100%; border: 1px solid var(--border-color,#d1d8dd); border-radius: 6px; padding: 7px 9px;
			font-size: 12px; background: var(--card-bg,#fff); color: var(--text-color,#202933); }
		.tm-field textarea { min-height: 90px; resize: vertical; }
		.tm-field input:disabled, .tm-field select:disabled { background: #f5f7f8; color: var(--text-muted,#8d99a6); }
		.tm-hint { font-size: 10px; color: var(--text-muted,#8d99a6); margin-top: 3px; }
		.tm-readonly { font-size: 12px; color: var(--text-color,#202933); padding: 7px 0; }
		.tm-check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-color,#202933); }
		.tm-check input { width: 15px; height: 15px; }

		.tm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
		.tm-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-color,#d1d8dd);
			background: var(--card-bg,#fff); border-radius: 14px; padding: 3px 9px; font-size: 11px; cursor: pointer;
			color: var(--text-muted,#8d99a6); user-select: none; }
		.tm-chip.is-on { background: #e8f0fe; border-color: #3b73d9; color: #3b73d9; }
		.tm-chip-x { font-weight: 700; opacity: .6; }

		.tm-image-row { display: flex; gap: 8px; align-items: center; }
		.tm-thumb { width: 54px; height: 54px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border-color,#ebeff2); }
		.tm-image-row input { flex: 1; }

		/* inline form cards (dates / packages) */
		.tm-form-stack { display: flex; flex-direction: column; gap: 14px; margin-bottom: 12px; }
		.tm-form-card { border: 1px solid var(--border-color,#d1d8dd); border-radius: 8px; background: #fafbfc; }
		.tm-form-card[data-creating="1"] { border-color: #c9a84c; background: #fffdf6; }
		.tm-form-head { display: flex; justify-content: space-between; align-items: center; gap: 10px;
			padding: 10px 14px; border-bottom: 1px solid var(--border-color,#ebeff2); }
		.tm-form-title { font-size: 13px; font-weight: 700; color: var(--text-color,#202933); }
		.tm-form-sub { font-size: 11px; color: var(--text-muted,#8d99a6); margin-top: 1px; }
		.tm-form-actions { display: flex; gap: 6px; }
		.tm-form-body { padding: 14px; }
		.tm-form-foot { padding: 0 14px 14px; }
		.tm-section { margin-bottom: 12px; }
		.tm-section:last-child { margin-bottom: 0; }
		.tm-cruise-section { background: #f4f8ff; border: 1px solid #d6e4fc; border-radius: 6px; padding: 10px; }
		.tm-cruise-info { font-size: 11px; color: var(--text-color,#202933); margin: 6px 0; line-height: 1.5; }
		.tm-empty-inline { padding: 24px; text-align: center; color: var(--text-muted,#8d99a6); font-size: 12px;
			border: 1px dashed var(--border-color,#d1d8dd); border-radius: 8px; }

		/* pricing grid */
		.tm-pricing-table { margin-top: 8px; overflow-x: auto; }
		.tm-pricing-head, .tm-pricing-row { display: grid;
			grid-template-columns: 150px repeat(6, minmax(70px, 1fr)) 28px; gap: 6px; align-items: center; }
		.tm-pricing-head { font-size: 10px; font-weight: 600; color: var(--text-muted,#8d99a6); padding: 4px 0;
			border-bottom: 1px solid var(--border-color,#ebeff2); margin-bottom: 4px; }
		.tm-pricing-row { margin-bottom: 4px; }
		.tm-pricing-row select, .tm-pricing-row input { font-size: 11px; padding: 5px 6px; border-radius: 5px;
			border: 1px solid var(--border-color,#d1d8dd); width: 100%; }
		.tm-pricing-add { margin-top: 6px; font-size: 11px; background: none; border: 1px dashed var(--border-color,#d1d8dd);
			border-radius: 6px; padding: 5px 10px; cursor: pointer; color: var(--text-muted,#8d99a6); }
		.tm-pricing-del { background: none; border: none; color: #c0392b; cursor: pointer; font-size: 14px; }
		`;
		$('<style id="tm-page-css"></style>').text(css).appendTo('head');
	}

	return { init, on_show };
})();
