// travel_booking/module_admin_portal/page/trip_manager/trip_manager_editor.js
//
// EDITOR LAYER untuk Trip Manager — dimuat oleh trip_manager.js
// (render_include pada akhir fail utama memuat fail ini).
//
// Mod: modal dialogs (TGD, Package + pricing grid + BOM, Content trip
// + galeri, Flight Schedule, Addon, Addon Package, Website sections)
// — semua tulis melalui API trip_manager_page / trip_manager (lama),
// TANPA lompat ke Desk form.

window.TripManagerEditor = (function () {
	'use strict';

	const PAGE_API = 'travel_booking.api.trip_manager_page';
	const CRUD_API = 'travel_booking.api.trip_manager'; // API lama (save_trip/save_group_date/save_package)

	/* ═══ Generic helpers ═══ */

	function field(label, fieldname, value, options) {
		options = options || {};
		const df = {
			fieldname: fieldname,
			label: label,
			// fieldtype WAJIB — make_control laksana fieldtype.replace(...)
			// dan undefined menyebabkan TypeError modal gagal terbina.
			fieldtype: options.fieldtype || 'Data',
		};
		// default HANYA bila ada nilai (undefined/null menyebabkan
		// make_control .replace gagal pada sebilangan fieldtype).
		if (value !== undefined && value !== null && value !== "") {
			df.default = value;
		}
		if (options.fieldtype) df.fieldtype = options.fieldtype;
		if (options.options) df.options = options.options;
		if (options.reqd) df.reqd = 1;
		if (options.depends_on) df.depends_on = options.depends_on;
		if (options.description) df.description = options.description;
		return df;
	}

	function linkField(label, fieldname, value, doctype, filters, reqd) {
		const df = field(label, fieldname, value, { fieldtype: 'Link', options: doctype, reqd: reqd });
		if (filters) {
			df.get_query = () => ({ filters: filters });
		}
		return df;
	}

	/* ═══ Modal: Trip Group Date ═══ */

	function editGroupDate(gd, tripName, lookups, onSaved) {
		// gd = null → cipta baharu
		const isCruise = lookups && lookups.is_cruise_trip;
		const fields = [
			field(__('Group Name'), 'trip_group_name', gd && gd.trip_group_name),
			field(__('Departure Date'), 'departure_date', gd && gd.departure_date, { fieldtype: 'Date' }),
			field(__('Return Date'), 'return_date', gd && gd.return_date, { fieldtype: 'Date' }),
			linkField(__('Cruise Schedule'), 'cruise_schedule', gd && gd.cruise_schedule,
				'Trip Cruise Schedule'),
			linkField(__('Flight Schedule'), 'flight_schedule', gd && gd.flight_schedule,
				'Flight Schedule'),
			field(__('Max Participants (0=unlimited)'), 'max_participants',
				gd ? gd.max_participants : 0, { fieldtype: 'Int' }),
			field(__('Status'), 'status', gd ? gd.status : 'Active',
				{ fieldtype: 'Select', options: 'Active\nClosed\nCancelled\nCompleted' }),
		];
		const d = new frappe.ui.Dialog({
			title: gd ? __('Edit Trip Date') : __('New Trip Date'),
			fields: fields,
			primary_action_label: gd ? __('Save') : __('Create'),
			primary_action: () => {
				const vals = d.get_values();
				if (!vals) return;
				const payload = {
					trip: tripName,
					trip_group_name: vals.trip_group_name,
					departure_date: vals.departure_date,
					return_date: vals.return_date,
					cruise_schedule: vals.cruise_schedule || '',
					flight_schedule: vals.flight_schedule || '',
					max_participants: vals.max_participants || 0,
					status: vals.status,
				};
				if (gd) payload.name = gd.name;
				frappe.call({
					method: `${CRUD_API}.save_group_date`,
					args: { payload: JSON.stringify(payload) },
					freeze: true,
				}).then(() => {
					d.hide();
					frappe.show_alert({ message: __('Trip Date saved'), indicator: 'green' });
					onSaved && onSaved();
				});
			},
		});
		d.show();
	}

	/* ═══ Modal: Package (tab: info/pricing/BOM) ═══ */

	function editPackage(pkg, tripName, lookups, onSaved) {
		const pricingRows = (pkg && pkg.pricing) || [];
		const bomRows = (pkg && pkg.bom) || [];
		const gdOptions = (lookups && lookups.dates || []).map(g => ({
			label: g.trip_group_name || g.name, value: g.name,
		}));

		const d = new frappe.ui.Dialog({
			title: pkg ? __('Edit Package') : __('New Package'),
			fields: [
				{
					fieldtype: 'Tab Break', label: __('Info'),
				},
				field(__('Package Type'), 'package_type', pkg && pkg.package_type,
					{ fieldtype: 'Select', options: 'Cruise + Flight\nCruise Only\nFly Package\nGround Only\nCustomed', reqd: true }),
				field(__('Title'), 'package_title', pkg && pkg.package_title),
				field(__('Currency'), 'currency', (pkg && pkg.currency) || 'MYR',
					{ fieldtype: 'Link', options: 'Currency', reqd: true }),
				field(__('Featured'), 'featured', pkg && pkg.featured, { fieldtype: 'Check' }),
				field(__('Status'), 'status', (pkg && pkg.status) || 'Active',
					{ fieldtype: 'Select', options: 'Pending Review\nActive\nInactive' }),
				linkField(__('Departure Airport'), 'airport_form', pkg && pkg.airport_form, 'Flight Airport'),
				field(__('Ground Arrangement'), 'ground_arrangement', pkg && pkg.ground_arrangement, { fieldtype: 'Check' }),
				{
					fieldname: 'dates', label: __('Trip Dates (pautan M:N)'),
					fieldtype: 'MultiSelectList',
					options: gdOptions.length
						? undefined
						: [],
					get_data: () => gdOptions,
					default: (pkg && pkg.gd_list) || [],
				},
				{ fieldtype: 'Tab Break', label: __('Pricing') },
				{
					fieldname: 'pricing_html', fieldtype: 'HTML',
					options: renderPricingGrid(pricingRows),
				},
				{ fieldtype: 'Tab Break', label: __('Components (BOM)') },
				{
					fieldname: 'bom_html', fieldtype: 'HTML',
					options: renderBomEditor(bomRows),
				},
			],
			size: 'extra-large',
			primary_action_label: pkg ? __('Save') : __('Create'),
			primary_action: () => {
				const vals = d.get_values();
				if (!vals) return;
				const payload = {
					trip: tripName,
					package_type: vals.package_type,
					package_title: vals.package_title,
					currency: vals.currency,
					featured: vals.featured ? 1 : 0,
					status: vals.status,
					airport_form: vals.airport_form || '',
					ground_arrangement: vals.ground_arrangement ? 1 : 0,
					dates: (d.get_value('dates') || []),
					pricing: collectPricingGrid(d),
				};
				if (pkg) payload.name = pkg.name;
				frappe.call({
					method: `${CRUD_API}.save_package`,
					args: { payload: JSON.stringify(payload) },
					freeze: true,
				}).then(r => {
					// BOM rows (child table berasingan daripada save_package lama).
					const bom = collectBomEditor(d);
					const pkgName = (r.message && r.message.name) || (pkg && pkg.name);
					return frappe.call({
						method: `${PAGE_API}.save_package_components`,
						args: { trip_package: pkgName, components: JSON.stringify(bom) },
					});
				}).then(() => {
					d.hide();
					frappe.show_alert({ message: __('Package saved'), indicator: 'green' });
					onSaved && onSaved();
				});
			},
		});
		d.show();
	}

	// Pricing grid — jadual HTML inline dalam modal (kategori × 6 harga + currency).
	function renderPricingGrid(rows) {
		const cats = ['Balcony Cabin', 'Seaview Cabin', 'Interior Cabin',
			'Seaview Superior Cabin', 'Balcony Superior Cabin',
			'Junior Suite (Khuzama)', 'Superior Suite (Khuzama)',
			'Deluxe Suite (Khuzama)', 'Premier Suite (Khuzama)',
			'Premier Family Suite (Khuzama)', 'Presidential Villa (Khuzama)',
			'Royal Villa (Khuzama)', 'Signature Suite (Khuzama)',
			'Standard Rooming'];
		const priceFields = [
			['price_adult', 'Adult'], ['price_adult_single', 'Single'],
			['price_upperberth', 'Upper Berth'], ['price_children', 'Child'],
			['price_toddler', 'Toddler'], ['price_infant', 'Infant'],
		];
		let html = `<div class="tm-edit-grid" id="tmPricingGrid">
			<div class="tm-edit-grid-head tm-edit-grid-row">
				<div>Category</div><div>Currency</div>
				${priceFields.map(([, l]) => `<div>${l}</div>`).join('')}
				<div></div>
			</div>`;
		(rows.length ? rows : [{}]).forEach((r, i) => {
			html += `<div class="tm-edit-grid-row" data-idx="${i}">
				<select class="form-control input-xs tm-pr-cat">` +
				cats.map(c => `<option value="${frappe.utils.escape_html(c)}" ${r.pricing_for_class === c ? 'selected' : ''}>${frappe.utils.escape_html(c)}</option>`).join('') +
				`</select>
				<input class="form-control input-xs tm-pr-cur" value="${frappe.utils.escape_html(r.currency || '')}" placeholder="native" style="max-width:70px">
				${priceFields.map(([f]) => `<input class="form-control input-xs tm-pr-${f}" type="number" step="0.01" value="${r[f] != null ? r[f] : ''}">`).join('')}
				<button class="btn btn-xs btn-default tm-pr-del"><i class="ti ti-x"></i></button>
			</div>`;
		});
		html += `</div><button class="btn btn-default btn-xs" id="tmPricingAdd" style="margin-top:6px;">+ ${__('Add Category')}</button>`;
		return html;
	}

	function collectPricingGrid(d) {
		const rows = [];
		d.$wrapper.find('#tmPricingGrid .tm-edit-grid-row[data-idx]').each(function () {
			const $r = $(this);
			const cat = $r.find('.tm-pr-cat').val();
			if (!cat) return;
			const row = { pricing_for_class: cat };
			const cur = $.trim($r.find('.tm-pr-cur').val() || '');
			row.currency = cur || null;
			row.price_adult = +$r.find('.tm-pr-price_adult').val() || 0;
			row.price_adult_single = +$r.find('.tm-pr-price_adult_single').val() || 0;
			row.price_upperberth = +$r.find('.tm-pr-price_upperberth').val() || 0;
			row.price_children = +$r.find('.tm-pr-price_children').val() || 0;
			row.price_toddler = +$r.find('.tm-pr-price_toddler').val() || 0;
			row.price_infant = +$r.find('.tm-pr-price_infant').val() || 0;
			rows.push(row);
		});
		return rows;
	}

	function bindPricingGrid(d) {
		d.$wrapper.on('click', '#tmPricingAdd', function () {
			const $grid = d.$wrapper.find('#tmPricingGrid');
			const $first = $grid.find('.tm-edit-grid-row[data-idx]').first();
			const $clone = $first.clone();
			$clone.attr('data-idx', $grid.find('.tm-edit-grid-row').length);
			$clone.find('input').val('');
			$grid.append($clone);
		});
		d.$wrapper.on('click', '.tm-pr-del', function () {
			$(this).closest('.tm-edit-grid-row').remove();
		});
	}

	// BOM editor — senarai baris komponen.
	function renderBomEditor(rows) {
		const types = ['Activity', 'Excursion', 'Transfer', 'Merchandise', 'Miscellaneous'];
		let html = `<div id="tmBomEditor">`;
		(rows.length ? rows : []).forEach((r, i) => {
			html += bomRowHtml(r, i);
		});
		html += `</div><button class="btn btn-default btn-xs" id="tmBomAdd" style="margin-top:6px;">+ ${__('Add Component')}</button>`;
		return html;
	}

	function bomRowHtml(r, i) {
		r = r || {};
		const types = ['Activity', 'Excursion', 'Transfer', 'Merchandise', 'Miscellaneous'];
		return `<div class="tm-bom-row" data-idx="${i}">
			<select class="form-control input-xs tm-bom-type">
				${types.map(t => `<option ${r.component_type === t ? 'selected' : ''}>${t}</option>`).join('')}
			</select>
			<input class="form-control input-xs tm-bom-link" placeholder="Trip Addon Package / Item (name)"
				value="${frappe.utils.escape_html(r.trip_addon_package || r.merchandise_item || '')}">
			<input class="form-control input-xs tm-bom-desc" placeholder="Misc description"
				value="${frappe.utils.escape_html(r.misc_description || '')}">
			<input class="form-control input-xs tm-bom-qty" type="number" min="1" style="max-width:60px"
				value="${r.qty || 1}">
			<label class="tm-bom-ppx"><input type="checkbox" class="tm-bom-perpax" ${r.per_pax ? 'checked' : ''}> /pax</label>
			<select class="form-control input-xs tm-bom-mode">
				${['Included', 'Optional (pre-trip selection)', 'Post-booking Addon']
					.map(m => `<option ${r.inclusion_mode === m ? 'selected' : ''}>${m}</option>`).join('')}
			</select>
			<button class="btn btn-xs btn-default tm-bom-del"><i class="ti ti-x"></i></button>
		</div>`;
	}

	function collectBomEditor(d) {
		const rows = [];
		d.$wrapper.find('#tmBomEditor .tm-bom-row').each(function () {
			const $r = $(this);
			const type = $r.find('.tm-bom-type').val();
			const link = $.trim($r.find('.tm-bom-link').val() || '');
			const desc = $.trim($r.find('.tm-bom-desc').val() || '');
			if (!type) return;
			if (type === 'Miscellaneous' && !desc) return;
			if (type !== 'Miscellaneous' && !link) return;
			const row = {
				component_type: type,
				inclusion_mode: $r.find('.tm-bom-mode').val(),
				qty: +$r.find('.tm-bom-qty').val() || 1,
				per_pax: $r.find('.tm-bom-perpax').is(':checked') ? 1 : 0,
			};
			if (type === 'Merchandise') row.merchandise_item = link;
			else if (type !== 'Miscellaneous') row.trip_addon_package = link;
			if (desc) row.misc_description = desc;
			rows.push(row);
		});
		return rows;
	}

	function bindBomEditor(d) {
		d.$wrapper.on('click', '#tmBomAdd', function () {
			d.$wrapper.find('#tmBomEditor').append(bomRowHtml({}));
		});
		d.$wrapper.on('click', '.tm-bom-del', function () {
			$(this).closest('.tm-bom-row').remove();
		});
	}

	/* ═══ Modal: Trip Content (description + tables + galeri) ═══ */

	function editTripContent(tripName, onSaved) {
		frappe.call({
			method: `${PAGE_API}.get_trip_content`,
			args: { trip_name: tripName },
			freeze: true,
		}).then(r => {
			const c = r.message;
			const d = new frappe.ui.Dialog({
				title: __('Edit Content') + ' — ' + tripName,
				fields: [
					{ fieldtype: 'Tab Break', label: __('Description') },
					field(__('Description (HTML)'), 'description', c.trip.description,
						{ fieldtype: 'Text Editor' }),
					field(__('Video URL (YouTube)'), 'video_url', c.trip.video_url),
					{ fieldtype: 'Tab Break', label: __('Highlights') },
					{ fieldname: 'highlights_html', fieldtype: 'HTML', options: simpleTableHtml('highlight', c.highlights, 'Highlight text') },
					{ fieldtype: 'Tab Break', label: __('Features') },
					{ fieldname: 'features_html', fieldtype: 'HTML', options: featureTableHtml(c.features) },
					{ fieldtype: 'Tab Break', label: __('FAQs') },
					{ fieldname: 'faqs_html', fieldtype: 'HTML', options: faqTableHtml(c.faqs) },
					{ fieldtype: 'Tab Break', label: __('Facilities') },
					{ fieldname: 'facilities_html', fieldtype: 'HTML', options: facilityTableHtml(c.facilities) },
					{ fieldtype: 'Tab Break', label: __('Gallery') },
					{ fieldname: 'gallery_html', fieldtype: 'HTML', options: galleryHtml(c.gallery) },
					{ fieldname: 'gallery_file', label: __('Upload Image'), fieldtype: 'Attach Image' },
				],
				size: 'extra-large',
				primary_action_label: __('Save Content'),
				primary_action: () => {
					const vals = d.get_values();
					const payload = {
						description: vals.description || '',
						video_url: vals.video_url || '',
						highlights: collectSimpleTable(d, 'highlight'),
						features: collectFeatureTable(d),
						faqs: collectFaqTable(d),
						facilities: collectFacilityTable(d),
					};
					frappe.call({
						method: `${PAGE_API}.save_trip_content`,
						args: { trip_name: tripName, payload: JSON.stringify(payload) },
						freeze: true,
					}).then(() => {
						// Upload gambar jika dipilih
						const f = d.get_value('gallery_file');
						const doClose = () => {
							d.hide();
							frappe.show_alert({ message: __('Content saved'), indicator: 'green' });
							onSaved && onSaved();
						};
						if (f && f.startsWith('data:')) {
							frappe.call({
								method: `${PAGE_API}.upload_trip_image`,
								args: { trip_name: tripName, filedata: f },
							}).then(doClose).fail(doClose);
						} else doClose();
					});
				},
			});
			d.show();
			bindSimpleTable(d, 'highlight');
			bindFaqTable(d);
			bindFacilityTable(d);
			d.$wrapper.on('click', '.tm-gal-del', function () {
				const fname = $(this).data('file');
				frappe.call({
					method: `${PAGE_API}.remove_trip_image`,
					args: { file_name: fname },
				}).then(() => {
					$(this).closest('.tm-gal-item').remove();
					frappe.show_alert({ message: __('Image removed'), indicator: 'green' });
				});
			});
		});
	}

	function simpleTableHtml(kind, rows, placeholder) {
		let html = `<div id="tmTable-${kind}">`;
		(rows || []).forEach(r => {
			html += simpleRowHtml(kind, r, placeholder);
		});
		html += `</div><button class="btn btn-default btn-xs tm-tbl-add" data-kind="${kind}" data-ph="${frappe.utils.escape_html(placeholder)}">+ ${__('Add')}</button>`;
		return html;
	}
	function simpleRowHtml(kind, r, placeholder) {
		return `<div class="tm-bom-row tm-tbl-row" data-kind="${kind}">
			<input class="form-control input-xs tm-tbl-val" placeholder="${frappe.utils.escape_html(placeholder)}" value="${frappe.utils.escape_html(r[kind] || '')}">
			<button class="btn btn-xs btn-default tm-tbl-del"><i class="ti ti-x"></i></button>
		</div>`;
	}
	function bindSimpleTable(d, kind) {
		d.$wrapper.on('click', `.tm-tbl-add[data-kind="${kind}"]`, function () {
			d.$wrapper.find(`#tmTable-${kind}`).append(
				simpleRowHtml(kind, {}, $(this).data('ph')));
		});
		d.$wrapper.on('click', '.tm-tbl-del', function () {
			$(this).closest('.tm-tbl-row').remove();
		});
	}
	function collectSimpleTable(d, kind) {
		const rows = [];
		d.$wrapper.find(`#tmTable-${kind} .tm-tbl-row`).each(function () {
			const v = $.trim($(this).find('.tm-tbl-val').val() || '');
			if (v) rows.push({ [kind]: v });
		});
		return rows;
	}

	function featureTableHtml(rows) {
		let html = `<div id="tmTable-feature">`;
		(rows || []).forEach(r => {
			html += `<div class="tm-bom-row tm-tbl-row" data-kind="feature">
				<input class="form-control input-xs tm-ft-text" placeholder="Feature" value="${frappe.utils.escape_html(r.feature || '')}">
				<label class="tm-bom-ppx"><input type="checkbox" class="tm-ft-inc" ${r.included ? 'checked' : ''}> ${__('Included')}</label>
				<button class="btn btn-xs btn-default tm-tbl-del"><i class="ti ti-x"></i></button>
			</div>`;
		});
		html += `</div><button class="btn btn-default btn-xs tm-tbl-add" data-kind="feature" data-ph="Feature">+ ${__('Add')}</button>`;
		return html;
	}
	function collectFeatureTable(d) {
		const rows = [];
		d.$wrapper.find('#tmTable-feature .tm-tbl-row').each(function () {
			const t = $.trim($(this).find('.tm-ft-text').val() || '');
			if (t) rows.push({ feature: t, included: $(this).find('.tm-ft-inc').is(':checked') ? 1 : 0 });
		});
		return rows;
	}

	function faqTableHtml(rows) {
		let html = `<div id="tmTable-faq">`;
		(rows || []).forEach(r => {
			html += faqRowHtml(r);
		});
		html += `</div><button class="btn btn-default btn-xs" id="tmFaqAdd">+ ${__('Add FAQ')}</button>`;
		return html;
	}
	function faqRowHtml(r) {
		return `<div class="tm-faq-row">
			<input class="form-control input-xs tm-faq-q" placeholder="Question" value="${frappe.utils.escape_html(r.question || '')}">
			<textarea class="form-control input-xs tm-faq-a" rows="2" placeholder="Answer">${frappe.utils.escape_html(r.answer || '')}</textarea>
			<button class="btn btn-xs btn-default tm-tbl-del"><i class="ti ti-x"></i></button>
		</div>`;
	}
	function bindFaqTable(d) {
		d.$wrapper.on('click', '#tmFaqAdd', function () {
			d.$wrapper.find('#tmTable-faq').append(faqRowHtml({}));
		});
	}
	function collectFaqTable(d) {
		const rows = [];
		d.$wrapper.find('#tmTable-faq .tm-faq-row').each(function () {
			const q = $.trim($(this).find('.tm-faq-q').val() || '');
			const a = $.trim($(this).find('.tm-faq-a').val() || '');
			if (q || a) rows.push({ question: q, answer: a });
		});
		return rows;
	}

	function facilityTableHtml(rows) {
		let html = `<div id="tmTable-facility">`;
		(rows || []).forEach(r => {
			html += `<div class="tm-bom-row tm-tbl-row" data-kind="facility">
				<input class="form-control input-xs tm-fc-name" placeholder="Facility" value="${frappe.utils.escape_html(r.facility || '')}">
				<input class="form-control input-xs tm-fc-icon" placeholder="Icon (ti-...)" value="${frappe.utils.escape_html(r.icon || '')}">
				<button class="btn btn-xs btn-default tm-tbl-del"><i class="ti ti-x"></i></button>
			</div>`;
		});
		html += `</div><button class="btn btn-default btn-xs tm-tbl-add" data-kind="facility" data-ph="Facility">+ ${__('Add')}</button>`;
		return html;
	}
	function collectFacilityTable(d) {
		const rows = [];
		d.$wrapper.find('#tmTable-facility .tm-tbl-row').each(function () {
			const f = $.trim($(this).find('.tm-fc-name').val() || '');
			if (f) rows.push({ facility: f, icon: $.trim($(this).find('.tm-fc-icon').val() || '') });
		});
		return rows;
	}

	function galleryHtml(gallery) {
		let html = `<div class="tm-gallery" id="tmGallery">`;
		(gallery || []).forEach(g => {
			html += `<div class="tm-gal-item">
				<img src="${frappe.utils.escape_html(g.file_url)}" title="${frappe.utils.escape_html(g.file_name || '')}">
				<button class="btn btn-xs btn-danger tm-gal-del" data-file="${frappe.utils.escape_html(g.name)}"><i class="ti ti-x"></i></button>
			</div>`;
		});
		html += `</div>`;
		return html;
	}

	/* ═══ Modal: Flight Schedule (+ PNR rows) ═══ */

	function editFlightSchedule(fs, onSaved) {
		const flights = (fs && fs.flights) || [];
		const d = new frappe.ui.Dialog({
			title: fs ? __('Edit Flight Schedule') : __('New Flight Schedule'),
			fields: [
				field(__('Schedule Code'), 'schedule_code', fs && fs.schedule_code),
				field(__('Status'), 'status', (fs && fs.status) || 'Active',
					{ fieldtype: 'Select', options: 'Draft\nActive\nClosed\nCompleted' }),
				field(__('Notes'), 'notes', fs && fs.notes, { fieldtype: 'Small Text' }),
				{ fieldname: 'flights_html', fieldtype: 'HTML', options: fsRowsHtml(flights) },
			],
			size: 'large',
			primary_action_label: fs ? __('Save') : __('Create'),
			primary_action: () => {
				const vals = d.get_values();
				const payload = {
					schedule_code: vals.schedule_code,
					status: vals.status,
					notes: vals.notes,
					flights: collectFsRows(d),
				};
				if (fs) payload.name = fs.name;
				frappe.call({
					method: `${PAGE_API}.save_flight_schedule`,
					args: { payload: JSON.stringify(payload) },
					freeze: true,
				}).then(() => {
					d.hide();
					frappe.show_alert({ message: __('Flight Schedule saved'), indicator: 'green' });
					onSaved && onSaved();
				});
			},
		});
		d.show();
		d.$wrapper.on('click', '#tmFsAdd', function () {
			d.$wrapper.find('#tmFsRows').append(fsRowHtml({}));
		});
		d.$wrapper.on('click', '.tm-fs-del', function () {
			$(this).closest('.tm-fs-row').remove();
		});
	}

	function fsRowsHtml(flights) {
		let html = `<div id="tmFsRows">`;
		(flights || []).forEach(f => html += fsRowHtml(f));
		html += `</div><button class="btn btn-default btn-xs" id="tmFsAdd" style="margin-top:6px;">+ ${__('Add PNR')}</button>`;
		return html;
	}
	function fsRowHtml(f) {
		return `<div class="tm-bom-row tm-fs-row">
			<input class="form-control input-xs tm-fs-pnr" placeholder="Flight (PNR name)" value="${frappe.utils.escape_html(f.flight || f.name || '')}">
			<select class="form-control input-xs tm-fs-role">
				<option ${(f.role || 'Outbound') === 'Outbound' ? 'selected' : ''}>Outbound</option>
				<option ${f.role === 'Return' ? 'selected' : ''}>Return</option>
			</select>
			<input class="form-control input-xs tm-fs-note" placeholder="Note" value="${frappe.utils.escape_html(f.note || '')}">
			<button class="btn btn-xs btn-default tm-fs-del"><i class="ti ti-x"></i></button>
		</div>`;
	}
	function collectFsRow(d) {
		const rows = [];
		d.$wrapper.find('#tmFsRows .tm-fs-row').each(function () {
			const f = $.trim($(this).find('.tm-fs-pnr').val() || '');
			if (f) rows.push({
				flight: f,
				role: $(this).find('.tm-fs-role').val(),
				note: $.trim($(this).find('.tm-fs-note').val() || ''),
			});
		});
		return rows;
	}

	/* ═══ Modal: Addon + Addon Package ═══ */

	function editAddon(addon, onSaved) {
		const d = new frappe.ui.Dialog({
			title: addon ? __('Edit Extra') : __('New Extra'),
			fields: [
				field(__('Title'), 'addon_title', addon && addon.addon_title, { reqd: true }),
				field(__('Type'), 'addon_type', (addon && addon.addon_type) || 'Other',
					{ fieldtype: 'Select', options: 'Activity\nExcursion\nTransfer\nUpgrade\nOther' }),
				field(__('Disabled'), 'disable', addon && addon.disable, { fieldtype: 'Check' }),
				field(__('Description'), 'description', addon && addon.description, { fieldtype: 'Text Editor' }),
			],
			primary_action_label: addon ? __('Save') : __('Create'),
			primary_action: () => {
				const vals = d.get_values();
				const payload = {
					addon_title: vals.addon_title,
					addon_type: vals.addon_type,
					disable: vals.disable ? 1 : 0,
					description: vals.description || '',
				};
				if (addon) payload.name = addon.name;
				frappe.call({
					method: `${PAGE_API}.save_addon`,
					args: { payload: JSON.stringify(payload) },
					freeze: true,
				}).then(() => {
					d.hide();
					frappe.show_alert({ message: __('Extra saved'), indicator: 'green' });
					onSaved && onSaved();
				});
			},
		});
		d.show();
	}

	function editAddonPackage(pkg, addonName, onSaved) {
		const rates = (pkg && pkg.rates_list) || [];
		const d = new frappe.ui.Dialog({
			title: pkg ? __('Edit Sale Package') : __('New Sale Package'),
			fields: [
				field(__('Package Name'), 'addon_package_name', pkg && pkg.addon_package_name),
				field(__('Status'), 'status', (pkg && pkg.status) || 'Active',
					{ fieldtype: 'Select', options: 'Active\nInactive' }),
				field(__('Scope'), 'scope', (pkg && pkg.scope) || 'Per Booking',
					{ fieldtype: 'Select', options: 'Per Booking\nPer Pax' }),
				field(__('Applicable To'), 'applicable_to', (pkg && pkg.applicable_to) || 'All Trips',
					{ fieldtype: 'Select', options: 'All Trips\nSpecific Trips Only' }),
				field(__('Max per Booking (0=∞)'), 'max_qty_per_booking', pkg ? pkg.max_qty_per_booking : 0, { fieldtype: 'Int' }),
				field(__('Max Total (0=∞)'), 'max_total_qty', pkg ? pkg.max_total_qty : 0, { fieldtype: 'Int' }),
				{ fieldname: 'rates_html', fieldtype: 'HTML', options: ratesHtml(rates) },
			],
			size: 'large',
			primary_action_label: pkg ? __('Save') : __('Create'),
			primary_action: () => {
				const vals = d.get_values();
				const payload = {
					addon: addonName,
					addon_package_name: vals.addon_package_name,
					status: vals.status,
					scope: vals.scope,
					applicable_to: vals.applicable_to,
					max_qty_per_booking: vals.max_qty_per_booking || 0,
					max_total_qty: vals.max_total_qty || 0,
					rates: collectRates(d),
				};
				if (pkg) payload.name = pkg.name;
				frappe.call({
					method: `${PAGE_API}.save_addon_package`,
					args: { payload: JSON.stringify(payload) },
					freeze: true,
				}).then(() => {
					d.hide();
					frappe.show_alert({ message: __('Sale Package saved'), indicator: 'green' });
					onSaved && onSaved();
				});
			},
		});
		d.show();
		d.$wrapper.on('click', '#tmRateAdd', function () {
			d.$wrapper.find('#tmRateRows').append(rateRowHtml({}));
		});
		d.$wrapper.on('click', '.tm-rate-del', function () {
			$(this).closest('.tm-rate-row').remove();
		});
	}

	function ratesHtml(rates) {
		let html = `<label class="control-label" style="font-size:12px;">${__('Rates per currency')}</label><div id="tmRateRows">`;
		(rates || []).forEach(r => html += rateRowHtml(r));
		html += `</div><button class="btn btn-default btn-xs" id="tmRateAdd">+ ${__('Add Rate')}</button>`;
		return html;
	}
	function rateRowHtml(r) {
		return `<div class="tm-bom-row tm-rate-row">
			<input class="form-control input-xs tm-rate-cur" placeholder="MYR" value="${frappe.utils.escape_html(r.currency || '')}" style="max-width:80px">
			<input class="form-control input-xs tm-rate-price" type="number" step="0.01" placeholder="0.00" value="${r.unit_price != null ? r.unit_price : ''}">
			<label class="tm-bom-ppx"><input type="checkbox" class="tm-rate-en" ${r.enabled !== 0 ? 'checked' : ''}> ${__('Enabled')}</label>
			<button class="btn btn-xs btn-default tm-rate-del"><i class="ti ti-x"></i></button>
		</div>`;
	}
	function collectRates(d) {
		const rows = [];
		d.$wrapper.find('#tmRateRows .tm-rate-row').each(function () {
			const c = $.trim($(this).find('.tm-rate-cur').val() || '').toUpperCase();
			if (!c) return;
			rows.push({
				currency: c,
				unit_price: +$(this).find('.tm-rate-price').val() || 0,
				enabled: $(this).find('.tm-rate-en').is(':checked') ? 1 : 0,
			});
		});
		return rows;
	}

	/* ═══ Import rates + sync helper (butang automasi) ═══ */

	function importCruiseRates(tripPackage, onDone) {
		frappe.confirm(
			__('Import cabin rates from cruise schedule? Existing package pricing will be replaced.'),
			() => {
				frappe.call({
					method: `${PAGE_API}.import_cruise_rates`,
					args: { trip_package: tripPackage },
					freeze: true,
				}).then(r => {
					frappe.show_alert({
						message: __('Imported {0} rate rows', [r.message.imported]),
						indicator: 'green',
					});
					onDone && onDone();
				});
			});
	}

	function syncCabinAvailability(schedule, onDone) {
		frappe.call({
			method: `${PAGE_API}.sync_cabin_availability`,
			args: { schedule: schedule },
			freeze: true,
		}).then(() => {
			frappe.show_alert({ message: __('Availability synced'), indicator: 'green' });
			onDone && onDone();
		});
	}

	// Hook: panggil bindPricingGrid/bindBomEditor selepas dialog show.
	const _origShow = frappe.ui.Dialog.prototype.show;
	frappe.ui.Dialog.prototype.show = function () {
		const r = _origShow.apply(this, arguments);
		bindPricingGrid(this);
		bindBomEditor(this);
		return r;
	};

	/* ═══ Modal: Website Section (cruise/tour/common) ═══ */

	function editWebsiteSection(section, data, onSaved) {
		// Medan per seksyen — scalar sahaja dulu (child tables menyusul
		// melalui tab dalam modal bila diperlukan).
		const s = section || 'cruise';
		const P = s === 'cruise' ? 'cruise' : s === 'tour' ? 'tour' : null;
		let fields = [];
		if (P) {
			fields = [
				field(__('Hero Tag'), P + '_hero_tag', data[P + '_hero_tag']),
				field(__('Hero Title'), P + '_hero_title', data[P + '_hero_title']),
				field(__('Hero Intro'), P + '_hero_intro', data[P + '_hero_intro'],
					{ fieldtype: 'Small Text' }),
				field(__('Hero Background (URL)'), P + '_hero_background', data[P + '_hero_background']),
				field(__('Featured Tag'), P + '_featured_tag', data[P + '_featured_tag']),
				field(__('Featured Title'), P + '_featured_title', data[P + '_featured_title']),
				field(__('Featured Subtitle'), P + '_featured_subtitle', data[P + '_featured_subtitle']),
				field(__('Featured CTA Label'), P + '_featured_cta_label', data[P + '_featured_cta_label']),
				field(__('Featured CTA URL'), P + '_featured_cta_url', data[P + '_featured_cta_url']),
				field(__('Why-Us Tag'), P + '_whyus_tag', data[P + '_whyus_tag']),
				field(__('Why-Us Title'), P + '_whyus_title', data[P + '_whyus_title']),
				field(__('Why-Us Subtitle'), P + '_whyus_subtitle', data[P + '_whyus_subtitle']),
				field(__('CTA Tag'), P + '_cta_tag', data[P + '_cta_tag']),
				field(__('CTA Title'), P + '_cta_title', data[P + '_cta_title']),
				field(__('CTA Body'), P + '_cta_body', data[P + '_cta_body'], { fieldtype: 'Small Text' }),
				field(__('CTA Primary Label'), P + '_cta_primary_label', data[P + '_cta_primary_label']),
				field(__('CTA Primary URL'), P + '_cta_primary_url', data[P + '_cta_primary_url']),
				field(__('CTA Secondary Label'), P + '_cta_secondary_label', data[P + '_cta_secondary_label']),
				field(__('CTA Secondary URL'), P + '_cta_secondary_url', data[P + '_cta_secondary_url']),
			];
		} else {
			fields = [
				field(__('Footer Tagline'), 'footer_tagline', data.footer_tagline),
				field(__('Support Email'), 'support_email', data.support_email),
				field(__('Copyright'), 'copyright_text', data.copyright_text),
				field(__('Facebook'), 'social_facebook', data.social_facebook),
				field(__('Instagram'), 'social_instagram', data.social_instagram),
				field(__('WhatsApp'), 'social_whatsapp', data.social_whatsapp),
				field(__('Chat Widget Enabled'), 'chat_widget_enabled', data.chat_widget_enabled, { fieldtype: 'Check' }),
				field(__('Chat Title'), 'chat_widget_title', data.chat_widget_title),
				field(__('Chat Subtitle'), 'chat_widget_subtitle', data.chat_widget_subtitle),
				field(__('Date Format'), 'date_display_format', data.date_display_format),
			];
		}
		const d = new frappe.ui.Dialog({
			title: __('Edit Website') + ' — ' + __(s),
			fields: fields,
			size: 'large',
			primary_action_label: __('Save'),
			primary_action: () => {
				const vals = d.get_values();
				if (!vals) return;
				frappe.call({
					method: `${PAGE_API}.save_website_section`,
					args: { section: s, payload: JSON.stringify(vals) },
					freeze: true,
				}).then(() => {
					d.hide();
					frappe.show_alert({
						message: __('Website content saved — cache cleared'),
						indicator: 'green',
					});
					onSaved && onSaved();
				});
			},
		});
			d.show();
		}

	return {
		editGroupDate, editPackage, editTripContent,
		editFlightSchedule, editAddon, editAddonPackage,
		importCruiseRates, syncCabinAvailability, editWebsiteSection,
	};
})();
