// travel_booking/travel_booking_management/page/trip_manager/trip_manager.js
// Desk Page /app/trip-manager — satu page mengurus 3 doctype:
// Trip + Trip Group Date + Trip Package, tanpa buka 3 form berasingan.
//
// Semua tulisan melalui travel_booking.api.trip_manager (server guna
// frappe.get_doc + save() — auto-generate nama/kod & validasi kekal
// di server). Page ini hanya render + kumpul input.

frappe.pages['trip-manager'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Trip Manager'),
		single_column: true,
	});

	TripManagerPage.init(page, wrapper);
};

frappe.pages['trip-manager'].on_page_show = function (wrapper) {
	// refresh senarai bila kembali ke page (cth. selepas edit di form lain)
	if (window.TripManagerPage) TripManagerPage.refresh_list();
};

/* ============================================================
   TripManagerPage — controller page (IIFE, sekali sahaja)
   ============================================================ */
window.TripManagerPage = (function () {
	'use strict';

	const esc = (v) => frappe.utils.escape_html(String(v ?? ''));

	const S = {
		page: null,
		wrapper: null,
		trips: [],
		bundle: null, // trip + dates + packages + lookups
		current: null, // trip name yang dipilih
		tab: 'info',
		can_delete: false,
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
				.catch((e) => {
					// ralat frappe dah dipapar oleh frappe.call; reject untuk
					// chain caller hentikan flow
					reject(e);
				});
		});

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const fmtDate = (iso) => {
		if (!iso) return '';
		const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return String(iso);
		return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
	};
	const fmtMoney = (n) =>
		parseFloat(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

	const STATUS_COLORS = {
		Active: 'green',
		'Pending Review': 'orange',
		Full: 'blue',
		Closed: 'gray',
		Completed: 'blue',
		Cancelled: 'red',
		Inactive: 'gray',
	};
	const badge = (label, color) =>
		`<span class="tm-badge tm-badge--${color || 'gray'}">${esc(label)}</span>`;

	const debounce = (fn, ms) => {
		let t;
		return (...a) => {
			clearTimeout(t);
			t = setTimeout(() => fn(...a), ms);
		};
	};

	/* ============================================================
	   INIT + SHELL
	   ============================================================ */
	function init(page, wrapper) {
		S.page = page;
		S.wrapper = $(wrapper);
		S.can_delete = frappe.user.has_role('Tour Manager');

		inject_css();
		build_shell();

		// filter di page-head Desk
		const q_field = page.add_field({
			fieldtype: 'Data',
			fieldname: 'q',
			label: __('Cari'),
			placeholder: __('Nama trip...'),
		});
		const status_field = page.add_field({
			fieldtype: 'Select',
			fieldname: 'status',
			label: __('Status'),
			options: ['', 'Pending Review', 'Active', 'Completed', 'Cancelled'],
			default: '',
		});
		q_field.$input.on('input', debounce(() => refresh_list(), 350));
		status_field.$input.on('change', refresh_list);

		page.set_primary_action(__('Trip Baru'), () => open_new_trip_dialog(), 'add');

		refresh_list();
	}

	function current_filters() {
		const q = S.page.fields_dict.q ? S.page.fields_dict.q.get_value() : '';
		const status = S.page.fields_dict.status ? S.page.fields_dict.status.get_value() : '';
		return { q: q || '', status: status || '' };
	}

	function refresh_list(keep_current) {
		const f = current_filters();
		return api('get_managed_trips', f).then((trips) => {
			S.trips = trips || [];
			render_list();
			if (keep_current && S.current && S.trips.some((t) => t.name === S.current)) {
				highlight_current();
			} else if (!keep_current) {
				S.current = null;
				S.bundle = null;
				render_editor();
			}
		});
	}

	/* ============================================================
	   CSS (scoped .tm-*)
	   ============================================================ */
	function inject_css() {
		if (document.getElementById('tm-page-css')) return;
		const css = `
		.tm-shell { display: flex; gap: 18px; align-items: flex-start; padding-bottom: 40px; }
		.tm-sidebar { width: 320px; min-width: 320px; }
		.tm-main { flex: 1; min-width: 0; }

		.tm-trip-list { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px; overflow: hidden; }
		.tm-trip-row { display: flex; gap: 10px; padding: 10px 12px; cursor: pointer;
			border-bottom: 1px solid var(--border-color, #ebeff2); align-items: center; }
		.tm-trip-row:last-child { border-bottom: none; }
		.tm-trip-row:hover { background: var(--bg-light-gray, #f8f8f8); }
		.tm-trip-row.is-active { background: #e8f0fe; }
		.tm-trip-thumb { width: 46px; height: 46px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
		.tm-trip-row-body { flex: 1; min-width: 0; }
		.tm-trip-row-name { font-weight: 600; font-size: 13px; color: var(--text-color, #202933);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.tm-trip-row-sub { font-size: 11px; color: var(--text-muted, #8d99a6); margin-top: 2px; }
		.tm-trip-row-meta { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
		.tm-mini { font-size: 10px; background: #f0f0f0; color: #6c7a89;
			border-radius: 4px; padding: 1px 6px; }

		.tm-badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 8px;
			border-radius: 10px; letter-spacing: .02em; }
		.tm-badge--green { background: #e1f3e8; color: #1d9c57; }
		.tm-badge--orange { background: #fdf2e2; color: #b96900; }
		.tm-badge--blue { background: #e2ecfd; color: #3b73d9; }
		.tm-badge--gray { background: #eef1f3; color: #6c7a89; }
		.tm-badge--red { background: #fde8e8; color: #c0392b; }
		.tm-badge--gold { background: #f6efdd; color: #8a6d1f; }

		.tm-empty { background: var(--card-bg, #fff); border: 1px dashed var(--border-color, #d1d8dd);
			border-radius: 8px; padding: 60px 20px; text-align: center; color: var(--text-muted, #8d99a6); }

		.tm-editor { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 8px; }
		.tm-editor-head { display: flex; gap: 14px; padding: 16px; border-bottom: 1px solid var(--border-color, #ebeff2);
			align-items: center; }
		.tm-editor-cover { width: 84px; height: 84px; border-radius: 8px; object-fit: cover; flex-shrink: 0;
			border: 1px solid var(--border-color, #ebeff2); }
		.tm-editor-title { font-size: 16px; font-weight: 700; color: var(--text-color, #202933); }
		.tm-editor-sub { font-size: 12px; color: var(--text-muted, #8d99a6); margin: 3px 0 6px; }
		.tm-editor-sub a { color: #3b73d9; }
		.tm-editor-badges { display: flex; gap: 6px; flex-wrap: wrap; }

		.tm-tabs { display: flex; border-bottom: 1px solid var(--border-color, #ebeff2); padding: 0 8px; }
		.tm-tab { border: none; background: none; padding: 11px 14px; font-size: 12px; font-weight: 600;
			color: var(--text-muted, #8d99a6); border-bottom: 2px solid transparent; cursor: pointer; }
		.tm-tab.is-active { color: var(--text-color, #202933); border-bottom-color: #c9a84c; }
		.tm-tab .tm-tab-count { background: #f0f0f0; border-radius: 8px;
			padding: 0 6px; margin-left: 5px; font-size: 10px; }

		.tm-pane { padding: 16px; }
		.tm-pane.is-hidden, .is-hidden { display: none; }

		.tm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
		.tm-field { margin-bottom: 4px; }
		.tm-field label { display: block; font-size: 11px; font-weight: 600;
			color: var(--text-muted, #8d99a6); margin-bottom: 4px; }
		.tm-field input[type=text], .tm-field select, .tm-field textarea {
			width: 100%; border: 1px solid var(--border-color, #d1d8dd); border-radius: 6px;
			padding: 7px 9px; font-size: 12px; background: var(--card-bg, #fff);
			color: var(--text-color, #202933); }
		.tm-field textarea { min-height: 120px; resize: vertical; }
		.tm-field input:disabled, .tm-field select:disabled { background: #f5f7f8;
			color: var(--text-muted, #8d99a6); cursor: not-allowed; }
		.tm-field .tm-hint { font-size: 10px; color: var(--text-muted, #8d99a6); margin-top: 3px; }
		.tm-check { display: flex; align-items: center; gap: 7px; font-size: 12px;
			color: var(--text-color, #202933); padding-top: 22px; }
		.tm-check input { width: 15px; height: 15px; }

		.tm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
		.tm-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 14px; padding: 3px 10px; font-size: 11px; cursor: pointer;
			color: var(--text-color, #202933); background: var(--card-bg, #fff); }
		.tm-chip.is-on { background: #e2ecfd; border-color: #b7cffb; color: #2a5bb8; font-weight: 600; }
		.tm-chip-remove { font-weight: 700; color: #c0392b; }

		.tm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
		.tm-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
			color: var(--text-muted, #8d99a6); padding: 6px 8px; border-bottom: 1px solid var(--border-color, #ebeff2); }
		.tm-table td { padding: 9px 8px; border-bottom: 1px solid var(--border-color, #ebeff2);
			color: var(--text-color, #202933); vertical-align: middle; }
		.tm-table tr:hover td { background: #fafbfc; }
		.tm-row-title { font-weight: 600; }
		.tm-row-sub { font-size: 10px; color: var(--text-muted, #8d99a6); margin-top: 2px; }
		.tm-icon-btn { border: none; background: none; cursor: pointer; padding: 3px 5px; border-radius: 4px;
			color: var(--text-muted, #8d99a6); font-size: 13px; text-decoration: none; }
		.tm-icon-btn:hover { background: #f0f0f0; color: var(--text-color, #202933); }
		.tm-icon-btn.danger:hover { background: #fde8e8; color: #c0392b; }

		.tm-section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
		.tm-section-head h5 { margin: 0; font-size: 13px; font-weight: 700; color: var(--text-color, #202933); }

		.tm-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
		.tm-card { border: 1px solid var(--border-color, #ebeff2); border-radius: 8px; padding: 12px; }
		.tm-card-title { font-size: 12px; font-weight: 700; color: var(--text-color, #202933); }
		.tm-card-sub { font-size: 10px; color: var(--text-muted, #8d99a6); margin: 2px 0 8px; }
		.tm-card-badges { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
		.tm-card-dates { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
		.tm-card-actions { display: flex; justify-content: flex-end; gap: 4px; margin-top: 8px; }

		/* pricing grid dalam dialog pakej */
		.tm-pricing-table { width: 100%; border-collapse: collapse; font-size: 11px; }
		.tm-pricing-table th { padding: 4px 5px; text-align: left; color: var(--text-muted, #8d99a6);
			font-size: 9px; text-transform: uppercase; border-bottom: 1px solid var(--border-color, #ebeff2); }
		.tm-pricing-table td { padding: 3px 5px; border-bottom: 1px solid #f2f4f5; }
		.tm-pricing-table input[type=number] { width: 100%; min-width: 62px; border: 1px solid var(--border-color, #d1d8dd);
			border-radius: 4px; padding: 4px 5px; font-size: 11px; }
		.tm-dialog-row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
		.tm-dialog-row select { flex: 1; }
		`;
		const el = document.createElement('style');
		el.id = 'tm-page-css';
		el.textContent = css;
		document.head.appendChild(el);
	}

	/* ============================================================
	   SHELL + RENDER SENARAI TRIP
	   ============================================================ */
	function build_shell() {
		S.page.main.append(`
			<div class="tm-shell">
				<div class="tm-sidebar">
					<div class="tm-trip-list"></div>
				</div>
				<div class="tm-main">
					<div class="tm-empty">${__('Pilih trip dari senarai, atau create trip baru.')}</div>
					<div class="tm-editor is-hidden"></div>
				</div>
			</div>`);

		S.wrapper.find('.tm-shell').on('click', '.tm-trip-row', function () {
			select_trip($(this).data('name'));
		});
	}

	function render_list() {
		const list = S.wrapper.find('.tm-trip-list').empty();
		if (!S.trips.length) {
			list.append(`<div style="padding:24px;text-align:center;color:var(--text-muted,#8d99a6);font-size:12px;">
				${__('Tiada trip ditemui.')}</div>`);
			return;
		}
		for (const t of S.trips) {
			const img = t.trip_image || '/assets/travel_booking/img/defaultaroya.jpg';
			list.append(`
				<div class="tm-trip-row" data-name="${esc(t.name)}">
					<img class="tm-trip-thumb" src="${esc(img)}" alt="" onerror="this.src='/assets/travel_booking/img/defaultaroya.jpg'"/>
					<div class="tm-trip-row-body">
						<div class="tm-trip-row-name" title="${esc(t.trip_name)}">${esc(t.trip_name)}</div>
						<div class="tm-trip-row-sub">${esc(t.trip_organizer || '')}</div>
						<div class="tm-trip-row-meta">
							<span class="tm-mini">${t.date_count} tarikh</span>
							<span class="tm-mini">${t.package_count} pakej</span>
							${t.is_a_cruise_trip ? '<span class="tm-mini">Cruise</span>' : ''}
						</div>
					</div>
					<div>
						${t.published ? badge('Published', 'green') : badge('Draft', 'gray')}
						<div style="margin-top:4px">${badge(t.status, STATUS_COLORS[t.status])}</div>
					</div>
				</div>`);
		}
		highlight_current();
	}

	function highlight_current() {
		S.wrapper.find('.tm-trip-row').removeClass('is-active');
		if (S.current) {
			S.wrapper.find(`.tm-trip-row[data-name="${CSS.escape(S.current)}"]`).addClass('is-active');
		}
	}

	function select_trip(name) {
		S.current = name;
		highlight_current();
		S.wrapper.find('.tm-empty').addClass('is-hidden');
		S.wrapper.find('.tm-editor').removeClass('is-hidden').html(
			`<div style="padding:40px;text-align:center;color:var(--text-muted,#8d99a6);">
				<span class="spinner"></span> ${__('Memuat data trip...')}</div>`
		);
		return load_bundle();
	}

	function load_bundle() {
		return api('get_trip_bundle', { trip: S.current }).then((bundle) => {
			S.bundle = bundle;
			render_editor();
		});
	}

	/* ============================================================
	   EDITOR (3 tab)
	   ============================================================ */
	function render_editor() {
		const editor = S.wrapper.find('.tm-editor');
		if (!S.bundle) {
			editor.addClass('is-hidden');
			S.wrapper.find('.tm-empty').removeClass('is-hidden');
			return;
		}

		const t = S.bundle.trip;
		const img = t.trip_image || '/assets/travel_booking/img/defaultaroya.jpg';
		editor.removeClass('is-hidden').html(`
			<div class="tm-editor-head">
				<img class="tm-editor-cover" src="${esc(img)}" alt="" onerror="this.src='/assets/travel_booking/img/defaultaroya.jpg'"/>
				<div style="flex:1;min-width:0">
					<div class="tm-editor-title">${esc(t.trip_name)}</div>
					<div class="tm-editor-sub">
						${esc(t.name)} &middot; ${esc(t.trip_organizer || '')}
						${t.route ? ` &middot; <a href="/${esc(t.route)}" target="_blank">${__('Lihat di web')} <span style="font-size:10px">&#8599;</span></a>` : ''}
					</div>
					<div class="tm-editor-badges">
						${t.published ? badge('Published', 'green') : badge('Draft', 'gray')}
						${badge(t.status, STATUS_COLORS[t.status])}
						${t.is_a_cruise_trip ? badge('Cruise Trip', 'gold') : ''}
					</div>
				</div>
				<div>
					${S.can_delete ? `<button class="tm-icon-btn danger tm-del-trip" title="${__('Padam trip')}">&#10005; ${__('Padam Trip')}</button>` : ''}
				</div>
			</div>
			<div class="tm-tabs">
				<button class="tm-tab" data-tab="info">${__('Maklumat Trip')}</button>
				<button class="tm-tab" data-tab="dates">${__('Tarikh Departure')}<span class="tm-tab-count">${S.bundle.dates.length}</span></button>
				<button class="tm-tab" data-tab="packages">${__('Pakej')}<span class="tm-tab-count">${S.bundle.packages.length}</span></button>
			</div>
			<div class="tm-pane" data-pane="info"></div>
			<div class="tm-pane is-hidden" data-pane="dates"></div>
			<div class="tm-pane is-hidden" data-pane="packages"></div>`);

		editor.find('.tm-tab').on('click', function () {
			switch_tab($(this).data('tab'));
		});
		editor.find('.tm-del-trip').on('click', delete_trip);

		render_info_tab();
		render_dates_tab();
		render_packages_tab();
		switch_tab(S.tab);
	}

	function switch_tab(tab) {
		S.tab = tab;
		S.wrapper.find('.tm-tab').removeClass('is-active');
		S.wrapper.find(`.tm-tab[data-tab="${tab}"]`).addClass('is-active');
		S.wrapper.find('.tm-pane').addClass('is-hidden');
		S.wrapper.find(`.tm-pane[data-pane="${tab}"]`).removeClass('is-hidden');
	}

	/* ---------- TAB 1: Maklumat Trip ---------- */
	function render_info_tab() {
		const pane = S.wrapper.find('.tm-pane[data-pane="info"]');
		const t = S.bundle.trip;
		const L = S.bundle.lookups;

		pane.html(`
			<div class="tm-grid">
				<div class="tm-field">
					<label>${__('Nama Trip')} *</label>
					<input type="text" data-fld="trip_name" value="${esc(t.trip_name)}"/>
				</div>
				<div class="tm-field">
					<label>${__('Trip Organizer')}</label>
					<input type="text" value="${esc(t.trip_organizer || '')}" disabled title="Set hanya semasa create"/>
					<div class="tm-hint">${__('Tidak boleh ditukar selepas create (set only once)')}</div>
				</div>
				<div class="tm-field">
					<label>${__('Status')}</label>
					<select data-fld="status">
						${['Pending Review', 'Active', 'Completed', 'Cancelled']
							.map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`)
							.join('')}
					</select>
				</div>
				<div class="tm-field">
					<label>${__('SEO URL (route)')}</label>
					<input type="text" data-fld="route" value="${esc(t.route || '')}" placeholder="trips/nama-trip"/>
					<div class="tm-hint">${__('Kosongkan untuk jana semula automatik')}</div>
				</div>
				<div class="tm-field">
					<label>${__('Cover Image (URL)')}</label>
					<input type="text" data-fld="trip_image" value="${esc(t.trip_image || '')}"/>
					<button class="btn btn-default btn-xs tm-upload-img" style="margin-top:5px">${__('Muat Naik Gambar')}</button>
				</div>
				<div class="tm-field tm-check">
					<input type="checkbox" data-fld="published" ${t.published ? 'checked' : ''}/>
					<span>${__('Published (tampil di website)')}</span>
				</div>
				<div class="tm-field tm-check">
					<input type="checkbox" data-fld="is_a_cruise_trip" ${t.is_a_cruise_trip ? 'checked' : ''}/>
					<span>${__('Cruise Trip')}</span>
				</div>
			</div>
			<div class="tm-field" style="margin-top:12px">
				<label>${__('Destinasi')}</label>
				<div class="tm-chips" data-fld="destinations"></div>
			</div>
			<div class="tm-field" style="margin-top:12px">
				<label>${__('Description (HTML)')}</label>
				<textarea data-fld="description">${esc(t.description || '')}</textarea>
			</div>
			<div style="margin-top:14px">
				<button class="btn btn-primary btn-sm tm-save-trip">${__('Simpan Maklumat Trip')}</button>
			</div>`);

		// destinasi: toggle chips
		const chips = pane.find('.tm-chips[data-fld="destinations"]');
		const selected = new Set(t.destinations || []);
		for (const d of L.destinations) {
			const on = selected.has(d.name);
			chips.append(`<span class="tm-chip ${on ? 'is-on' : ''}" data-name="${esc(d.name)}"
				title="${esc(d.name)}">${on ? '<span class="tm-chip-remove">&times;</span>' : '+'}
				${esc(d.destination_name || d.name)}</span>`);
		}
		chips.on('click', '.tm-chip', function () {
			const was_on = $(this).hasClass('is-on');
			$(this).toggleClass('is-on');
			if (was_on) {
				$(this).find('.tm-chip-remove').remove();
			} else {
				$(this).prepend('<span class="tm-chip-remove">&times;</span>');
			}
		});

		pane.find('.tm-save-trip').on('click', function () {
			const payload = collect_info_tab(pane);
			api('save_trip', { payload })
				.then((r) => {
					frappe.show_alert({ message: __('Maklumat trip disimpan: {0}', [r.name]), indicator: 'green' });
					return Promise.all([load_bundle(), refresh_list(true)]);
				})
				.then(() => switch_tab(S.tab));
		});

		pane.find('.tm-upload-img').on('click', upload_trip_image);
	}

	function collect_info_tab(pane) {
		const val = (fld) => pane.find(`[data-fld="${fld}"]`).val();
		const chk = (fld) => (pane.find(`[data-fld="${fld}"]`).prop('checked') ? 1 : 0);
		return {
			name: S.bundle.trip.name,
			trip_name: val('trip_name').trim(),
			status: val('status'),
			route: val('route').trim(),
			trip_image: val('trip_image').trim(),
			description: val('description'),
			published: chk('published'),
			is_a_cruise_trip: chk('is_a_cruise_trip'),
			destinations: pane
				.find('.tm-chips[data-fld="destinations"] .tm-chip.is-on')
				.map(function () {
					return $(this).data('name');
				})
				.get(),
		};
	}

	function upload_trip_image() {
		const d = new frappe.ui.Dialog({
			title: __('Muat Naik Cover Image'),
			fields: [
				{
					fieldtype: 'Attach',
					fieldname: 'image',
					label: __('Image'),
					options: { restrictions: { allowed_file_types: ['image/*'] } },
				},
			],
			primary_action_label: __('Pilih'),
			primary_action(values) {
				if (values.image) {
					S.wrapper.find('.tm-pane[data-pane="info"] [data-fld="trip_image"]').val(values.image);
					frappe.show_alert({ message: __('Gambar dipilih — klik Simpan untuk kekal.'), indicator: 'blue' });
				}
				d.hide();
			},
		});
		d.show();
	}

	/* ---------- TAB 2: Tarikh Departure (Trip Group Date) ---------- */
	function render_dates_tab() {
		const pane = S.wrapper.find('.tm-pane[data-pane="dates"]');
		const is_cruise = S.bundle.trip.is_a_cruise_trip;
		const dates = S.bundle.dates;

		let rows = '';
		for (const d of dates) {
			rows += `
				<tr>
					<td>
						<div class="tm-row-title">${esc(d.trip_group_name || d.name)}</div>
						<div class="tm-row-sub">${esc(d.name)}</div>
					</td>
					<td>
						${fmtDate(d.departure_date)} &rarr; ${fmtDate(d.return_date)}
						<div class="tm-row-sub">${d.total_days || 0}D${d.total_nights || 0}N</div>
					</td>
					<td>
						${d.max_participants || 0} pax
						<div class="tm-row-sub">${d.current_participants || 0} ditempah / ${d.available_slots} kosong</div>
					</td>
					<td>
						${badge(d.status, STATUS_COLORS[d.status])}
						${d.is_cruise_only ? '<div style="margin-top:4px">' + badge('Cruise Only', 'gold') + '</div>' : ''}
					</td>
					<td style="text-align:right;white-space:nowrap">
						<button class="tm-icon-btn tm-date-edit" data-name="${esc(d.name)}" title="${__('Edit')}">&#9998;</button>
						${S.can_delete ? `<button class="tm-icon-btn danger tm-date-del" data-name="${esc(d.name)}" title="${__('Padam')}">&#10005;</button>` : ''}
					</td>
				</tr>`;
		}

		pane.html(`
			<div class="tm-section-head">
				<h5>${__('Tarikh pakej yang dibuka (Trip Group Date)')}</h5>
				<button class="btn btn-primary btn-xs tm-add-date">+ ${__('Tambah Tarikh')}</button>
			</div>
			${dates.length ? `<table class="tm-table">
				<thead><tr>
					<th>${__('Group')}</th><th>${__('Departure &rarr; Return')}</th>
					<th>${__('Kapasiti')}</th><th>${__('Status')}</th><th></th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>` : `<div class="tm-empty" style="padding:24px">${__('Belum ada tarikh — tambah tarikh pertama untuk trip ini.')}</div>`}
			${is_cruise ? `<div class="tm-hint" style="margin-top:8px;font-size:10px;color:var(--text-muted,#8d99a6)">${__('Trip cruise: tarikh & info kapal di-fetch dari Trip Cruise Schedule.')}</div>` : ''}`);

		pane.find('.tm-add-date').on('click', () => open_date_dialog(null));
		pane.find('.tm-date-edit').on('click', function () {
			open_date_dialog($(this).data('name'));
		});
		pane.find('.tm-date-del').on('click', function () {
			confirm_delete('Trip Group Date', $(this).data('name'));
		});
	}

	function open_date_dialog(existing_name) {
		const existing = existing_name ? S.bundle.dates.find((d) => d.name === existing_name) : null;
		const is_cruise = S.bundle.trip.is_a_cruise_trip;
		const schedules = S.bundle.lookups.cruise_schedules;
		const creating = !existing;

		if (creating && is_cruise && !schedules.length) {
			frappe.msgprint(__('Trip cruise ini tiada Trip Cruise Schedule. Cipta jadual cruise di Desk dahulu sebelum tambah tarikh.'));
			return;
		}

		// bila pilih/tukar jadual cruise: cadangkan tarikh ikut logik Desk —
		// fly-cruise dep = sail-1, ret = sail+1; cruise-only dep/ret = sailing.
		function sync_dates_from_schedule(dialog) {
			const vals = dialog.get_values();
			const sch = S.bundle.lookups.cruise_schedules.find((s) => s.name === vals.cruise_schedule);
			if (!sch) return;
			const only = creating ? vals.is_cruise_only : existing.is_cruise_only;
			dialog.set_value(
				'departure_date',
				only ? sch.sail_start : frappe.datetime.add_days(sch.sail_start, -1)
			);
			dialog.set_value(
				'return_date',
				only ? sch.sail_end : frappe.datetime.add_days(sch.sail_end, 1)
			);
		}

		const fields = [];
		if (is_cruise) {
			fields.push({
				fieldtype: 'Link',
				fieldname: 'cruise_schedule',
				options: 'Trip Cruise Schedule',
				label: __('Cruise Schedule'),
				default: existing ? existing.cruise_schedule : '',
				get_query: () => ({ filters: { trip_link: S.bundle.trip.name } }),
				onchange() {
					sync_dates_from_schedule(d);
				},
			});
			if (creating) {
				fields.push({
					fieldtype: 'Check',
					fieldname: 'is_cruise_only',
					label: __('Cruise Only (tanpa penerbangan)'),
					default: 0,
					onchange() {
						sync_dates_from_schedule(d);
					},
				});
			}
		}

		fields.push(
			{
				fieldtype: 'Date',
				fieldname: 'departure_date',
				label: __('Departure Date (Dari)'),
				reqd: 1,
				default: existing ? existing.departure_date : '',
			},
			{
				fieldtype: 'Date',
				fieldname: 'return_date',
				label: __('Return Date (Hingga)'),
				reqd: 1,
				default: existing ? existing.return_date : '',
			},
			{
				fieldtype: 'Int',
				fieldname: 'max_participants',
				label: __('Capacity (max pax)'),
				default: existing ? existing.max_participants : is_cruise ? 0 : 12,
				non_negative: 1,
			},
			{
				fieldtype: 'Select',
				fieldname: 'status',
				label: __('Status'),
				options: ['Active', 'Full', 'Closed', 'Completed', 'Pending Review', 'Cancelled'],
				default: existing ? existing.status : 'Active',
			},
			{
				fieldtype: 'Small Text',
				fieldname: 'trip_group_description',
				label: __('Description'),
				default: existing ? existing.trip_group_description : '',
			}
		);

		const d = new frappe.ui.Dialog({
			title: existing
				? __('Edit Tarikh: {0}', [existing.name])
				: __('Tambah Tarikh — {0}', [S.bundle.trip.trip_name]),
			fields,
			primary_action_label: __('Simpan'),
			primary_action(values) {
				if (values.departure_date && values.return_date && values.departure_date > values.return_date) {
					frappe.msgprint(__('Departure Date mesti lebih awal dari Return Date.'));
					return;
				}
				const payload = {
					trip: S.bundle.trip.name,
					departure_date: values.departure_date,
					return_date: values.return_date,
					max_participants: values.max_participants || 0,
					status: values.status,
					trip_group_description: values.trip_group_description,
					cruise_schedule: values.cruise_schedule || '',
					is_cruise_only: values.is_cruise_only || 0,
				};
				if (existing) payload.name = existing.name;

				api('save_group_date', { payload })
					.then((r) => {
						d.hide();
						frappe.show_alert({
							message: __('Tarikh disimpan: {0}', [r.trip_group_name || r.name]),
							indicator: 'green',
						});
						return load_bundle();
					})
					.then(() => refresh_list(true));
			},
		});
		d.show();
	}

	/* ---------- TAB 3: Pakej (Trip Package) ---------- */
	function render_packages_tab() {
		const pane = S.wrapper.find('.tm-pane[data-pane="packages"]');
		const packages = S.bundle.packages;
		const date_map = {};
		for (const dt of S.bundle.dates) date_map[dt.name] = dt;

		let cards = '';
		for (const p of packages) {
			const date_chips = (p.dates || [])
				.map((n) => date_map[n])
				.filter(Boolean)
				.map(
					(dt) =>
						`<span class="tm-mini">${fmtDate(dt.departure_date)}${dt.is_cruise_only ? ' (CO)' : ''}</span>`
				)
				.join('');
			const min_adult = (p.pricing || [])
				.map((r) => parseFloat(r.price_adult))
				.filter((v) => v > 0)
				.sort((a, b) => a - b)[0];

			cards += `
				<div class="tm-card">
					<div class="tm-card-title">${esc(p.package_title || p.name)}</div>
					<div class="tm-card-sub">${esc(p.name)}${p.airport_form ? ' &middot; ' + esc(p.airport_form) : ''}</div>
					<div class="tm-card-badges">
						${badge(p.package_type || '-', 'gold')}
						${badge(p.status, STATUS_COLORS[p.status])}
						${badge(p.currency || '', 'blue')}
					</div>
					<div>
						${(p.pricing || []).length} ${__('kategori harga')}
						${min_adult ? `<div class="tm-row-sub">dari ${esc(p.currency)} ${fmtMoney(min_adult)} / ${__('dewasa')}</div>` : ''}
					</div>
					<div class="tm-card-dates">${date_chips || `<span class="tm-row-sub">${__('tiada tarikh dipilih')}</span>`}</div>
					<div class="tm-card-actions">
						${p.my_url ? `<a class="tm-icon-btn" href="${esc(p.my_url)}" target="_blank" title="${__('Booking URL')}">&#8599;</a>` : ''}
						<button class="tm-icon-btn tm-pkg-edit" data-name="${esc(p.name)}" title="${__('Edit')}">&#9998;</button>
						${S.can_delete ? `<button class="tm-icon-btn danger tm-pkg-del" data-name="${esc(p.name)}" title="${__('Padam')}">&#10005;</button>` : ''}
					</div>
				</div>`;
		}

		pane.html(`
			<div class="tm-section-head">
				<h5>${__('Pakej & harga (Trip Package)')}</h5>
				<button class="btn btn-primary btn-xs tm-add-pkg">+ ${__('Tambah Pakej')}</button>
			</div>
			${packages.length ? `<div class="tm-cards">${cards}</div>` : `<div class="tm-empty" style="padding:24px">${__('Belum ada pakej — tambah pakej untuk define harga & matawang.')}</div>`}
			${!S.bundle.dates.length ? `<div class="tm-hint" style="margin-top:8px;font-size:10px;color:var(--text-muted,#8d99a6)">${__('Nota: pakej perlu tarikh — tambah tarikh dahulu di tab Tarikh Departure.')}</div>` : ''}`);

		pane.find('.tm-add-pkg').on('click', () => open_package_dialog(null));
		pane.find('.tm-pkg-edit').on('click', function () {
			open_package_dialog($(this).data('name'));
		});
		pane.find('.tm-pkg-del').on('click', function () {
			confirm_delete('Trip Package', $(this).data('name'));
		});
	}

	function open_package_dialog(existing_name) {
		const existing = existing_name ? S.bundle.packages.find((p) => p.name === existing_name) : null;
		const is_cruise = S.bundle.trip.is_a_cruise_trip;
		const creating = !existing;
		const L = S.bundle.lookups;

		// kategori harga — cruise package guna kategori kabin (is_a_cruise),
		// trip biasa guna kategori bukan-kabin (logik sama trip_package.js)
		const categories = L.price_categories.filter((c) =>
			is_cruise ? !!c.is_a_cruise : !c.is_a_cruise
		);

		// state custom dalam dialog
		let selected_dates = creating ? [] : [...(existing.dates || [])];
		let pricing_rows = creating ? [] : (existing.pricing || []).map((r) => ({ ...r }));
		let currency_touched = false;

		const fields = [
			{
				fieldtype: 'Select',
				fieldname: 'package_type',
				label: __('Package Type'),
				options: is_cruise ? ['Fly Cruise', 'Cruise Only'] : ['Fly Package', 'Ground Only', 'Customed'],
				default: existing ? existing.package_type : is_cruise ? 'Fly Cruise' : 'Fly Package',
				read_only: !creating, // set_only_once
			},
		];
		if (is_cruise && creating) {
			fields.push({
				fieldtype: 'Check',
				fieldname: 'is_cruise_only',
				label: __('Cruise Only (tanpa penerbangan)'),
				default: 0,
				onchange() {
					const v = d.get_value('is_cruise_only');
					d.set_value('package_type', v ? 'Cruise Only' : 'Fly Cruise');
					selected_dates = []; // tarikh perlu dipilih semula ikut varian
					render_date_chips();
				},
			});
		}
		fields.push(
			{
				fieldtype: 'Link',
				fieldname: 'airport_form',
				options: 'Flight Airport',
				label: __('Depart From (airport)'),
				default: existing ? existing.airport_form : '',
				read_only: !creating, // set_only_once
				get_query: () => ({ filters: { enable: 1 } }),
				onchange() {
					// cadangkan currency ikut airport (macam fetch Desk)
					if (!creating) return;
					const ap = L.airports.find((a) => a.name === d.get_value('airport_form'));
					if (ap && ap.currency && !currency_touched) {
						d.set_value('currency', ap.currency);
					}
				},
			},
			{
				fieldtype: 'Link',
				fieldname: 'currency',
				options: 'Currency',
				label: __('Currency'),
				reqd: 1,
				default: existing ? existing.currency : 'MYR',
			},
			{
				fieldtype: 'Select',
				fieldname: 'status',
				label: __('Status'),
				options: ['Pending Review', 'Active', 'Inactive'],
				default: existing ? existing.status : 'Active',
			},
			{
				fieldtype: 'Small Text',
				fieldname: 'package_description',
				label: __('Description'),
				default: existing ? existing.package_description : '',
			},
			{ fieldtype: 'HTML', fieldname: 'dates_section' },
			{ fieldtype: 'HTML', fieldname: 'pricing_section' },
			{ fieldtype: 'HTML', fieldname: 'cruise_import_section' },
		);

		const d = new frappe.ui.Dialog({
			title: existing
				? __('Edit Pakej: {0}', [existing.name])
				: __('Tambah Pakej — {0}', [S.bundle.trip.trip_name]),
			fields,
			primary_action_label: __('Simpan'),
			primary_action(values) {
				// validasi ringkas sebelum hantar (server validate lagi)
				if (creating && values.package_type === 'Fly Package' && !values.airport_form) {
					frappe.msgprint(__('Fly Package memerlukan airport "Depart From".'));
					return;
				}
				if (!selected_dates.length) {
					frappe.msgprint(__('Pilih sekurang-kurangnya satu tarikh untuk pakej ini.'));
					return;
				}
				if (pricing_rows.some((r) => !r.pricing_for_class)) {
					frappe.msgprint(__('Ada baris harga tanpa kategori.'));
					return;
				}
				const payload = {
					trip_link: S.bundle.trip.name,
					package_type: values.package_type,
					airport_form: values.airport_form || '',
					currency: values.currency,
					status: values.status,
					package_description: values.package_description,
					is_cruise_only: is_cruise
						? creating
							? values.is_cruise_only || 0
							: existing.is_cruise_only
						: 0,
					dates: selected_dates,
					pricing: pricing_rows,
				};
				if (existing) payload.name = existing.name;

				api('save_package', { payload })
					.then((r) => {
						d.hide();
						frappe.show_alert({
							message: __('Pakej disimpan: {0}', [r.package_title || r.name]),
							indicator: 'green',
						});
						return load_bundle();
					})
					.then(() => refresh_list(true));
			},
		});

		d.fields_dict.currency &&
			d.fields_dict.currency.$input.on('change', () => (currency_touched = true));

		/* --- tarikh: chips (filter ikut varian cruise, logik Desk) --- */
		const dates_wrap = $(d.fields_dict.dates_section.wrapper);
		dates_wrap.append(`
			<div class="tm-field" style="margin-top:8px">
				<label>${__('Tarikh Terpilih')} *</label>
				<div class="tm-chips tm-pkg-dates"></div>
			</div>`);

		function render_date_chips() {
			const cruise_only_flag = is_cruise
				? creating
					? d.get_value('is_cruise_only') || 0
					: existing.is_cruise_only
				: 0;
			const wrap = dates_wrap.find('.tm-pkg-dates').empty();
			const eligible = S.bundle.dates.filter((dt) =>
				is_cruise ? (dt.is_cruise_only ? 1 : 0) === (cruise_only_flag ? 1 : 0) : true
			);
			if (!eligible.length) {
				wrap.append(`<span class="tm-row-sub">${__('tiada tarikh berpadan — tambah di tab Tarikh Departure')}</span>`);
			}
			for (const dt of eligible) {
				const on = selected_dates.includes(dt.name);
				wrap.append(`<span class="tm-chip ${on ? 'is-on' : ''}" data-name="${esc(dt.name)}">
					${on ? '<span class="tm-chip-remove">&times;</span>' : '+'}
					${fmtDate(dt.departure_date)}${dt.is_cruise_only ? ' CO' : ''}</span>`);
			}
		}
		dates_wrap.on('click', '.tm-chip', function () {
			const name = $(this).data('name');
			const i = selected_dates.indexOf(name);
			if (i >= 0) {
				selected_dates.splice(i, 1);
				$(this).removeClass('is-on').find('.tm-chip-remove').remove();
			} else {
				selected_dates.push(name);
				$(this).addClass('is-on').prepend('<span class="tm-chip-remove">&times;</span>');
			}
		});
		render_date_chips();

		/* --- pricing grid --- */
		const PRICE_COLS = [
			['price_adult_single', 'Single (12+)'],
			['price_adult', 'Twin (12+)'],
			['price_upperberth', 'Upper'],
			['price_children', 'Child (5-11)'],
			['price_toddler', 'Toddler (2-4)'],
			['price_infant', 'Infant (0-2)'],
		];
		const pricing_wrap = $(d.fields_dict.pricing_section.wrapper);
		pricing_wrap.append(`
			<div class="tm-field" style="margin-top:8px">
				<label>${__('Pricing (per kategori)')}</label>
				<div class="tm-pkg-pricing"></div>
				<div class="tm-dialog-row">
					<select class="tm-cat-select"></select>
					<button class="btn btn-default btn-xs tm-add-cat">+ ${__('Kategori')}</button>
				</div>
			</div>`);

		function render_pricing() {
			const tbl = pricing_wrap.find('.tm-pkg-pricing');
			let html = `<table class="tm-pricing-table">
				<thead><tr><th>${__('Kategori')}</th>
					${PRICE_COLS.map((c) => `<th>${c[1]}</th>`).join('')}
					<th></th></tr></thead><tbody>`;
			pricing_rows.forEach((r, i) => {
				html += `<tr>
					<td style="white-space:nowrap">${esc(r.pricing_for_class)}</td>
					${PRICE_COLS.map(
						(c) => `<td><input type="number" min="0" step="0.01" data-i="${i}" data-f="${c[0]}" value="${r[c[0]] ?? 0}"/></td>`
					).join('')}
					<td><button class="tm-icon-btn danger tm-rm-row" data-i="${i}" title="${__('Buang')}">&times;</button></td>
				</tr>`;
			});
			html += '</tbody></table>';
			if (!pricing_rows.length) {
				html += `<div class="tm-row-sub" style="margin:6px 0">${__('tiada baris harga')}</div>`;
			}
			tbl.html(html);

			// kategori yang belum dipakai
			const used = new Set(pricing_rows.map((r) => r.pricing_for_class));
			const sel = pricing_wrap.find('.tm-cat-select').empty();
			const avail = categories.filter((c) => !used.has(c.name));
			if (!avail.length) {
				sel.append(`<option value="">${__('semua kategori sudah dipakai')}</option>`).prop('disabled', true);
			} else {
				sel.prop('disabled', false);
				for (const c of avail) {
					sel.append(`<option value="${esc(c.name)}">${esc(c.category_name || c.name)}</option>`);
				}
			}
		}

		pricing_wrap.on('change', 'input[type=number]', function () {
			const i = $(this).data('i');
			pricing_rows[i][$(this).data('f')] = parseFloat($(this).val()) || 0;
		});
		pricing_wrap.on('click', '.tm-rm-row', function () {
			pricing_rows.splice($(this).data('i'), 1);
			render_pricing();
		});
		pricing_wrap.find('.tm-add-cat').on('click', () => {
			const v = pricing_wrap.find('.tm-cat-select').val();
			if (!v) return;
			const row = { pricing_for_class: v };
			for (const c of PRICE_COLS) row[c[0]] = 0;
			pricing_rows.push(row);
			render_pricing();
		});
		render_pricing();

		/* --- import cabin rates (cruise sahaja, logik trip_package.js) --- */
		if (is_cruise) {
			const cw = $(d.fields_dict.cruise_import_section.wrapper);
			cw.append(`
				<div style="margin-top:8px">
					<button class="btn btn-default btn-xs tm-import-cruise">${__('Import dari Cruise Rate')}</button>
					<span class="tm-row-sub"> — ${__('gantikan pricing dengan cabin rate dari cruise schedule tarikh pertama')}</span>
				</div>`);
			cw.find('.tm-import-cruise').on('click', () => {
				if (!selected_dates.length) {
					frappe.msgprint(__('Pilih tarikh dahulu — rate diimport dari cruise schedule tarikh pertama.'));
					return;
				}
				const dt = S.bundle.dates.find((x) => x.name === selected_dates[0]);
				if (!dt || !dt.cruise_schedule) {
					frappe.msgprint(__('Tarikh pertama tiada cruise schedule.'));
					return;
				}
				frappe.db.get_doc('Trip Cruise Schedule', dt.cruise_schedule).then((sch) => {
					pricing_rows = (sch.cabin_rates || []).map((r) => ({
						pricing_for_class: r.pricing_for_class,
						price_adult_single: r.price_adult_single,
						price_adult: r.price_adult,
						price_upperberth: r.price_upperberth,
						price_children: r.price_children,
						price_toddler: r.price_toddler,
						price_infant: r.price_infant,
					}));
					render_pricing();
					frappe.show_alert({
						message: __('{0} baris cabin rate diimport.', [pricing_rows.length]),
						indicator: 'blue',
					});
				});
			});
		}

		d.show();
	}

	/* ============================================================
	   TRIP BARU + DELETE
	   ============================================================ */
	function open_new_trip_dialog() {
		const d = new frappe.ui.Dialog({
			title: __('Trip Baru'),
			fields: [
				{
					fieldtype: 'Data',
					fieldname: 'trip_name',
					label: __('Nama Trip'),
					reqd: 1,
				},
				{
					fieldtype: 'Link',
					fieldname: 'trip_organizer',
					options: 'Trip Organizer',
					label: __('Trip Organizer'),
					reqd: 1,
				},
				{
					fieldtype: 'Check',
					fieldname: 'is_a_cruise_trip',
					label: __('Cruise Trip'),
					default: 0,
				},
			],
			primary_action_label: __('Cipta'),
			primary_action(values) {
				api('save_trip', { payload: values }).then((r) => {
					d.hide();
					frappe.show_alert({ message: __('Trip dicipta: {0}', [r.name]), indicator: 'green' });
					S.tab = 'info';
					refresh_list().then(() => select_trip(r.name));
				});
			},
		});
		d.show();
	}

	function delete_trip() {
		confirm_delete('Trip', S.bundle.trip.name);
	}

	function confirm_delete(doctype, name) {
		frappe.confirm(
			__('Padam {0} "{1}"? Tindakan ini tidak boleh dibatalkan.', [__(doctype), name]),
			() => {
				api('delete_doc', { doctype, name }).then(() => {
					frappe.show_alert({ message: __('{0} dipadam.', [__(doctype)]), indicator: 'green' });
					if (doctype === 'Trip') {
						S.current = null;
						S.bundle = null;
						refresh_list().then(render_editor);
					} else {
						load_bundle().then(() => refresh_list(true));
					}
				});
			}
		);
	}

	return {
		init,
		refresh_list,
	};
})();
