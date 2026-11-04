// travel_booking/module_admin_portal/page/travel_manager/travel_manager.js
// TRAVEL MANAGER — pengurusan trip/pakej/offer + jualan TANPA akses DocType
// terus (permintaan pengguna: senarai doctype mengelirukan).
//
// Semua operasi melalui API berpagarkan role:
//   - pakej/offer : travel_booking.api.package_admin.*
//   - jualan      : travel_booking.api.booking_hub.*  (reuse — dah gated)
//   - ringkasan   : travel_booking.api.trip_command_center.get_readiness_summary
//
// Kelulusan: status Active/Retired/Cancelled hanya Tour Manager/System
// Manager (gate server-side; butang UI turut disembunyiikan ikut role).

frappe.pages['travel-manager'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Travel Manager'),
		single_column: true,
	});
	page.set_primary_action(__('Muat Semula'), () => TravelManager.refresh(), null, 'refresh');

	wrapper.querySelector('.page-head').innerHTML = `
		<div class="tm-head" style="display:flex;align-items:center;justify-content:space-between;
			padding:14px 4px;border-bottom:1px solid #e8e8e8">
			<div>
				<h2 style="margin:0;font-weight:700">Travel Manager</h2>
				<p style="margin:2px 0 0;color:#666;font-size:12.5px">
					Urus trip, pakej & jualan — tanpa buka DocType.</p>
			</div>
		</div>
		<div class="tm-tabs" style="display:flex;gap:6px;padding:10px 4px">
			<button class="btn btn-default tm-tab" data-tab="packages">Pakej & Trip</button>
			<button class="btn btn-default tm-tab" data-tab="sales">Jualan</button>
			<button class="btn btn-default tm-tab" data-tab="summary">Ringkasan</button>
		</div>
		<div class="tm-body" style="padding:6px 4px 40px"></div>
	`;
	window.TravelManager = (function () {
		const $body = $(wrapper).find('.tm-body');
		const isManager = frappe.user.has_role('Tour Manager') || frappe.user.has_role('System Manager');

		const esc = (v) => frappe.utils.escape_html(v ?? '');
		const api = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.package_admin.' + method, args, quiet: true })
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
		const S = {
			DEP: {
				Draft: 'gray', 'Pending Review': 'orange', Active: 'green', Retired: 'gray',
			},
			OPE: {
				Draft: 'gray', Active: 'green', Cancelled: 'red',
				Scheduled: 'blue', Running: 'orange', Sailing: 'orange',
				Full: 'red', Closed: 'gray', Completed: 'green',
			},
			BKG: {
				Pending: 'orange', Accepted: 'blue', Processing: 'blue',
				Confirmed: 'green', Completed: 'green', Abandoned: 'gray', Cancelled: 'red',
			},
		};
		const money = (n) => 'RM ' + parseFloat(n || 0).toLocaleString('en-MY',
			{ minimumFractionDigits: 2, maximumFractionDigits: 2 });

		const state = { tab: 'packages', search: '', status: '', sales_status: 'Pending' };

		function switch_tab(tab) {
			state.tab = tab;
			$(wrapper).find('.tm-tab').removeClass('btn-primary').addClass('btn-default');
			$(wrapper).find(`.tm-tab[data-tab="${tab}"]`).addClass('btn-primary').removeClass('btn-default');
			refresh();
		}

		function refresh() {
			if (state.tab === 'packages') load_packages();
			else if (state.tab === 'sales') load_sales();
			else load_summary();
		}

		// ════════════ TAB 1: PAKEJ & TRIP ════════════
		async function load_packages() {
			$body.html(`
				<div class="tm-toolbar" style="display:flex;gap:8px;margin-bottom:12px">
					<input class="form-control tm-search" placeholder="Cari pakej…"
						value="${esc(state.search)}" style="max-width:260px">
					<select class="form-control tm-status" style="max-width:170px">
						<option value="">Semua status</option>
						${['Draft', 'Pending Review', 'Active', 'Retired'].map(s =>
							`<option value="${s}" ${state.status === s ? 'selected' : ''}>${s}</option>`).join('')}
					</select>
					<button class="btn btn-primary btn-sm tm-new-package"
						style="margin-left:auto">+ Pakej Baharu</button>
				</div>
				<div class="tm-list"><div style="color:#999;padding:30px;text-align:center">
					<div class="spinner-border spinner-border-sm"></div></div></div>
			`);

			$(wrapper).find('.tm-search').on('input', frappe.utils.debounce(function () {
				state.search = $(this).val(); load_packages();
			}, 400));
			$(wrapper).find('.tm-status').on('change', function () {
				state.status = $(this).val(); load_packages();
			});
			$(wrapper).find('.tm-new-package').on('click', () => package_dialog(null));

			const data = await api('get_packages_list', { search: state.search, status: state.status });
			const $list = $body.find('.tm-list').empty();
			if (!data?.packages?.length) {
				$list.html('<p style="color:#999;padding:30px;text-align:center">Tiada pakej dijumpai.</p>');
				return;
			}
			data.packages.forEach((p) => {
				$list.append(`
					<div class="tm-pkg panel panel-default" data-pkg="${esc(p.name)}"
						style="padding:12px 14px;margin-bottom:8px;cursor:pointer">
						<div style="display:flex;align-items:center;gap:10px">
							<div style="flex:1">
								<div style="font-weight:700">${esc(p.package_name)}</div>
								<div style="color:#888;font-size:12px">
									${esc(p.name)} · ${esc(p.package_template || '-')}
									· ${p.offer_count || 0} offer
									${p.min_price ? ' · dari ' + money(p.min_price) : ''}
								</div>
							</div>
							<div>${badge(p.status, S.DEP[p.status] || 'gray')}</div>
							<div>
								<button class="btn btn-xs btn-default tm-edit" data-pkg="${esc(p.name)}">Edit</button>
							</div>
						</div>
						<div class="tm-offers" style="display:none;margin-top:12px;
							border-top:1px solid #eee;padding-top:10px"></div>
					</div>
				`);
			});

			$list.find('.tm-pkg').on('click', function () {
				const $offers = $(this).find('.tm-offers');
				if ($offers.is(':visible')) { $offers.hide(); return; }
				$offers.show();
				if (!$offers.data('loaded')) load_offers($offers, $(this).data('pkg'));
			});
			$list.find('.tm-edit').on('click', function (e) {
				e.stopPropagation();
				package_dialog($(this).data('pkg'));
			});
		}

		async function load_offers($container, pkg) {
			$container.data('loaded', 1).html('<i style="color:#999">memuat…</i>');
			const data = await api('get_offers_list', { package: pkg, upcoming: 0, limit: 200 });
			const offers = data?.offers || [];
			const rows = offers.map((o) => {
				const pct = o.occupancy_pct != null ? o.occupancy_pct + '%' : '∞';
				return `
					<tr data-offer="${esc(o.name)}">
						<td>${esc(o.departure_date || '')}${o.return_date ? ' → ' + esc(o.return_date) : ''}</td>
						<td>${badge(o.status_editorial, S.DEP[o.status_editorial] || 'gray')}</td>
						<td>${badge(o.status_operational, S.OPE[o.status_operational] || 'gray')}</td>
						<td style="min-width:90px">${pct} ${o.max_pax ? `(${o.current_pax || 0}/${o.max_pax})` : ''}</td>
						<td class="tm-offer-actions" style="white-space:nowrap">
							${isManager && o.status_editorial !== 'Active'
								? `<button class="btn btn-xs btn-success tm-act" data-act="Active">Aktif</button>` : ''}
							${isManager && o.status_editorial === 'Active'
								? `<button class="btn btn-xs btn-warning tm-act" data-act="Cancelled">Batal</button>` : ''}
							${o.status_editorial === 'Active' && !isManager ? '' : ''}
						</td>
					</tr>`;
			}).join('');
			$container.html(`
				<div style="display:flex;align-items:center;margin-bottom:8px">
					<strong style="flex:1">Keberangkatan (Offers)</strong>
					<button class="btn btn-xs btn-primary tm-new-offer">+ Offer Baharu</button>
				</div>
				${offers.length ? `
				<table class="table table-condensed" style="margin:0;font-size:12.5px">
					<thead><tr><th>Tarikh</th><th>Editorial</th><th>Operasional</th>
						<th>Occupy</th><th></th></tr></thead>
					<tbody>${rows}</tbody>
				</table>` : '<p style="color:#999;font-size:12.5px">Belum ada offer — klik "+ Offer Baharu".</p>'}
			`);
			$container.find('.tm-new-offer').on('click', function (e) {
				e.stopPropagation();
				offer_dialog(pkg);
			});
			$container.find('.tm-act').on('click', function (e) {
				e.stopPropagation();
				const act = $(this).data('act');
				const offer = $(this).closest('tr').data('offer');
				set_offer_status($container, offer, act, pkg);
			});
		}

		async function set_offer_status($container, offer, act, pkg) {
			frappe.confirm(`Tukar status offer kepada "${act}"?`, async () => {
				try {
					await api('set_offer_status', { offer, status: act });
					frappe.show_alert({ message: 'Status offer dikemas kini', indicator: 'green' });
					load_offers($container, pkg);
				} catch (e) { /* frappe dah papar */ }
			});
		}

		function package_dialog(name) {
			const d = new frappe.ui.Dialog({
				title: name ? 'Edit Pakej: ' + name : 'Pakej Baharu',
				fields: [
					{ fieldname: 'package_name', fieldtype: 'Data', label: 'Nama Pakej', reqd: 1 },
					{ fieldname: 'package_template', fieldtype: 'Select', label: 'Template',
						options: '\nCruise + Flight\nCruise Only\nFly Package\nGround Only\nCustomed' },
					{ fieldname: 'trip', fieldtype: 'Link', label: 'Trip (produk utama)', options: 'Trip' },
					{ fieldname: 'default_currency', fieldtype: 'Link', label: 'Currency', options: 'Currency' },
					{ fieldname: 'status', fieldtype: 'Select', label: 'Status',
						options: 'Draft\nPending Review\nActive\nRetired', default: 'Draft',
						depends_on: isManager ? '' : 'eval:0',
						description: isManager ? '' : 'Perubahan ke Active hanya oleh Tour Manager' },
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
					const res = await api('save_package', { values: JSON.stringify(values) });
					frappe.show_alert({ message: 'Pakej disimpan', indicator: 'green' });
					d.hide();
					load_packages();
				} catch (e) { /* frappe dah papar */ }
			});
			d.show();
		}

		function offer_dialog(pkg) {
			const d = new frappe.ui.Dialog({
				title: 'Offer Baharu — ' + pkg,
				fields: [
					{ fieldname: 'departure_date', fieldtype: 'Date', label: 'Departure Date', reqd: 1 },
					{ fieldname: 'return_date', fieldtype: 'Date', label: 'Return Date' },
				],
			});
			d.set_primary_action(__('Cipta'), async () => {
				const values = d.get_values();
				if (!values) return;
				try {
					const res = await api('generate_offer_from_template',
						{ package: pkg, departure_date: values.departure_date, return_date: values.return_date || '' });
					frappe.show_alert({
						message: 'Offer dicipta (Draft) — harga disalin dari templat', indicator: 'green',
					});
					d.hide();
					load_packages();
				} catch (e) { /* frappe dah papar */ }
			});
			d.show();
		}

		// ════════════ TAB 2: JUALAN ════════════
		const SALES_STATUSES = ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed'];

		async function load_sales() {
			$body.html(`
				<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
					${SALES_STATUSES.map((s) =>
						`<button class="btn btn-xs tm-sale ${state.sales_status === s ? 'btn-primary' : 'btn-default'}"
							data-s="${s}">${s}</button>`).join('')}
					<span style="margin-left:auto;color:#999;font-size:12px;align-self:center">
						Klik status untuk tindakan</span>
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
						<tr data-booking="${esc(b.name)}" style="${match ? '' : 'opacity:.45'}">
							<td><strong>${esc(b.name)}</strong></td>
							<td>${esc(b.customer_name || '')}</td>
							<td>${esc(b.trip_name || '')}</td>
							<td>${esc(b.departure_date || b.trip_date || '')}</td>
							<td style="text-align:right">${money(b.total_amount)}</td>
							<td>${badge(b.status, S.BKG[b.status] || 'gray')}</td>
							<td class="tm-sale-actions" style="white-space:nowrap">
								${next_status_options(b.status)}
							</td>
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
			$box.find('.tm-next').on('click', function (e) {
				e.stopPropagation();
				const booking = $(this).closest('tr').data('booking');
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

		// ════════════ TAB 3: RINGKASAN ════════════
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
						<h2 style="margin:0;color:#15803d">${s.ready || 0}</h2><div>Ready</div></div>
					<div class="panel panel-default" style="flex:1;padding:14px;text-align:center">
						<h2 style="margin:0;color:#92400e">${s.warning || 0}</h2><div>Amaran</div></div>
					<div class="panel panel-default" style="flex:1;padding:14px;text-align:center">
						<h2 style="margin:0;color:#b91c1c">${s.error || 0}</h2><div>Tak Ready</div></div>
				</div>
				${cross ? `
				<div class="panel panel-default" style="padding:10px 14px;margin-bottom:16px;font-size:12.5px">
					<strong>Cross-check migrasi:</strong>
					${cross.clean
						? '<span style="color:#15803d">✔ bersih — 0 drift</span>'
						: `<span style="color:#b91c1c">${(cross.price_drifts || []).length} harga, ` +
						  `${(cross.allotment_drifts || []).length} allotment, ` +
						  `${(cross.sold_drifts || []).length} sold</span>`}
					(${cross.offers_checked} offer disemak)
				</div>` : ''}
				${problemTrips.length ? `
					<strong style="font-size:13px">Trip perlu tindakan:</strong>
					<ul style="font-size:12.5px">${problemTrips.map((t) =>
						`<li>${esc(t.trip_name)} — ${t.error_count} isu (${(t.errors || []).join(', ')})</li>`).join('')}</ul>`
					: '<p style="color:#15803d;font-size:12.5px">✔ Semua trip dalam keadaan baik.</p>'}
			`);
		}

		// ── wire tabs ──
		$(wrapper).find('.tm-tab').on('click', function () {
			switch_tab($(this).data('tab'));
		});
		switch_tab('packages');

		return { refresh };
	})();
};

frappe.pages['travel-manager'].on_page_show = function () {
	// noop — data dimuat semula secara manual (butang Muat Semula)
};
