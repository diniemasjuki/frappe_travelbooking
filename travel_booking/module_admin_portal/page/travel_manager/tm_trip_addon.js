	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRIP ADDON (tm_trip_addon.js)
	   ════════════════════════════════════════════════════════════════════
	   Direktori upsell addon — sub-menu TRIP pada nav travel-manager
	   (Nov 2026): urus Trip Addon (produk) + Trip Addon Package (variant
	   harga/scoping) SEPENUHNYA tanpa akses borang doctype.
	     /trip-addon            → senarai (datatable: carian, penapis
	                               jenis + status, saiz halaman, pagination
	                               & sortable)
	     /trip-addon/<NAME>     → detail (info produk + senarai pakej:
	                               rate multi-currency, scoping, kuantiti
	                               & cutoff, prev/next)
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, isManager, dsb.) secara
	   terus.
	   API AWAM: load_trip_addons() + load_trip_addon_detail()
	   (dipanggil oleh router shell).
	   Backend: travel_booking.api.trip_addon_admin (taa helper).
	   Komponen: kad/card() stok Bootstrap, jadual tmDataTable() kongsi,
	   dialog borang frappe.ui.Dialog + Link control makeLink() — tiada
	   CSS baharu.
	   ════════════════════════════════════════════════════════════════════ */

		// ── Helper & konstanta seksyen ──
		const taa = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.trip_addon_admin.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		// Jenis addon = cermin pilihan field Trip Addon.addon_type.
		const TA_TYPES = ['Activity', 'Upgrade', 'Transfer', 'Other'];
		const TA_TYPE_COLOR = {
			Activity: C.blue, Upgrade: C.green, Transfer: C.orange, Other: C.gray,
		};
		// Kebenaran (selari permission doctype): tulis = Manager/Operator,
		// padam = Tour Manager/System Manager sahaja (Operator tiada delete).
		const taCanWrite = isManager || frappe.user.has_role('Tour Operator');
		const taCanDelete = isManager;
		// Baris senarai terkini — rujukan handler delegated (dikemaskini
		// setiap load; handler sendiri HANYA dipasang sekali di bawah).
		let taRows = [];
		// Ringkasan validity pakej utk kolum jadual/detail.
		const taValidityText = (p) => {
			if (p.validity_mode === 'Relative to Departure')
				return `Departure ${p.valid_from_offset_days ?? 0}d → ${p.valid_to_offset_days ?? 0}d`;
			if (p.validity_mode === 'Fixed Dates')
				return `${webFmtDate(p.fixed_valid_from)} → ${webFmtDate(p.fixed_valid_to)}`;
			return p.validity_mode || 'One-Off';
		};

		// ── Baris jadual senarai (tmDataTable rowHtml) ──
		const taRowHtml = (a) => `
			<tr class="tm-ta-row pointer" data-name="${esc(a.name)}"
				title="Buka detail addon">
				<td>
					<div class="font-weight-bold">${esc(a.addon_title || a.name)}</div>
					<div class="text-muted text-small text-monospace">${esc(a.name)}</div>
				</td>
				<td>${badge(a.addon_type || 'Other', TA_TYPE_COLOR[a.addon_type] || C.gray)}</td>
				<td>${esc(a.addon_organizer || '—')}</td>
				<td class="text-center"><strong>${a.packages_count || 0}</strong>
					<div class="text-muted text-small">${a.active_packages || 0} active</div></td>
				<td class="text-center"><strong>${a.sold_total || 0}</strong></td>
				<td class="text-nowrap">${a.min_rate != null
					? `<strong>${esc(a.min_rate_currency || '')} ${esc(fmtNum(a.min_rate))}</strong>`
					: '<span class="text-extra-muted">—</span>'}</td>
				<td>${badge(a.disable ? 'Disabled' : 'Live', a.disable ? C.gray : C.green)}</td>
				<td class="text-nowrap text-right">
					${taCanWrite ? `<button type="button" class="btn btn-xs btn-default tm-ta-edit"
						data-name="${esc(a.name)}" title="Sunting addon">✏️</button>` : ''}
					${taCanDelete ? `<button type="button" class="btn btn-xs btn-danger tm-ta-del"
						data-name="${esc(a.name)}" title="Padam addon">🗑</button>` : ''}
				</td>
			</tr>`;

		// ── Handler delegated (SEKALI sahaja — baris jadual dirender semula
		// oleh pagination/sort tmDataTable, jadi delegasi pada $body) ──
		$body.on('click', '.tm-ta-row', function (e) {
			// Klik butang aksi (✏️/🗑) BUKAN navigasi baris.
			if ($(e.target).closest('button').length) return;
			const name = $(this).data('name');
			if (name) frappe.set_route('travel-manager', 'trip-addon', name);
		});
		$body.on('click', '.tm-ta-edit', function (e) {
			e.stopPropagation();
			const row = taRows.find((r) => r.name === $(this).data('name'));
			if (row) trip_addon_dialog(row, () => load_trip_addons());
		});
		$body.on('click', '.tm-ta-del', function (e) {
			e.stopPropagation();
			const name = $(this).data('name');
			const row = taRows.find((r) => r.name === name);
			ta_delete_dialog(name, row?.addon_title || name,
				() => load_trip_addons());
		});

		// ══════════════ TRIP ADDON (senarai) ══════════════
		async function load_trip_addons() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Trip Addon' },
			]);
			$body.html(loading());
			await webFmtLoad();

			const data = await taa('get_trip_addons', { limit: 500 });
			taRows = data?.addons || [];
			const rows = taRows;
			const nLive = rows.filter((r) => !r.disable).length;
			const nPkgs = rows.reduce((n, r) => n + (r.packages_count || 0), 0);

			$body.html(`
				<div class="d-flex flex-wrap gap-2 align-items-center text-muted mb-3">
					<div class="d-flex gap-2 overflow-auto py-1" aria-label="Ringkasan addon">
						<span class="text-nowrap"><strong class="text-body">${rows.length}</strong> addon</span>
						<span class="text-nowrap" style="color:${C.green}"><strong>${nLive}</strong> live</span>
						<span class="text-nowrap" style="color:${C.blue}"><strong>${nPkgs}</strong> package</span>
					</div>
					<div class="d-flex gap-2 ml-auto">
						${taCanWrite ? `
						<button type="button" class="btn btn-primary btn-sm" id="tm-ta-new">+ New Addon</button>` : ''}
					</div>
				</div>
				${card(12, `🎁 TRIP ADDONS <span class="text-muted">(${rows.length})</span>`, `
					<div id="tm-ta-dt"></div>`)}
			`);

			// Jadual interaktif kongsi: carian + penapis (jenis, status) +
			// sortable + pagination dalam card-footer (footer: true).
			tmDataTable('#tm-ta-dt', rows, {
				footer: true,
				headers: ['Addon', 'Type', 'Organizer', 'Packages', 'Sold',
					'From', 'Status', ''],
				rowHtml: taRowHtml,
				searchIn: (r) => [r.name, r.addon_title, r.addon_type,
					r.addon_organizer].join(' '),
				searchPlaceholder: 'Search addon / organizer…',
				emptyMsg: 'No trip addons yet. Click "+ New Addon" to create one.',
				filters: [
					{ key: 'type', label: 'Type', of: (r) => r.addon_type || 'Other' },
					{ key: 'status', label: 'Status',
						of: (r) => (r.disable ? 'Disabled' : 'Live') },
				],
				sortable: [
					{ key: 'title', val: (r) => r.addon_title || r.name || '' },
					{ key: 'type', val: (r) => r.addon_type || '' },
					{ key: 'org', val: (r) => r.addon_organizer || '' },
					{ key: 'pkgs', val: (r) => r.packages_count || 0 },
					{ key: 'sold', val: (r) => r.sold_total || 0 },
					{ key: 'from', val: (r) => r.min_rate ?? 0 },
					{ key: 'status', val: (r) => (r.disable ? 1 : 0) },
					null,
				],
				sortVal: (r) => r.addon_title || r.name || '',
				pageSize: 10,
				pageSizesLabel: 'Per page',
			});

			$body.find('#tm-ta-new').on('click', () =>
				trip_addon_dialog(null, (res) =>
					// Cipta berjaya → terus ke halaman detail addon baharu
					// (pakej harga/scoping dikemas kini dari sana).
					frappe.set_route('travel-manager', 'trip-addon', res.name)));
		}

		// ══════════════ TRIP ADDON (detail) ══════════════
		async function load_trip_addon_detail(addon) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Trip Addon', route: ['travel-manager', 'trip-addon'] },
				{ label: addon },
			]);
			$body.html(loading());
			await webFmtLoad();

			let detail = null, listData = null;
			try {
				[detail, listData] = await Promise.all([
					taa('get_trip_addon_detail', { addon }),
					// Senarai penuh untuk nav prev/next (null-tolerant).
					taa('get_trip_addons', { limit: 500 }).catch(() => null),
				]);
			} catch (e) { /* frappe already shows it */ }
			const a = detail?.addon;
			if (!a) {
				frappe.show_alert({ message: `Addon ${addon} tidak dijumpai`,
					indicator: 'red' });
				frappe.set_route('travel-manager', 'trip-addon');
				return;
			}
			const title = a.addon_title || addon;
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Trip Addon', route: ['travel-manager', 'trip-addon'] },
				{ label: title },
			]);

			// Nav prev/next — susunan sama seperti senarai (title asc).
			const list = listData?.addons || [];
			const idx = list.findIndex((x) => x.name === addon);
			const prev = idx > 0 ? list[idx - 1] : null;
			const next = (idx >= 0 && idx < list.length - 1) ? list[idx + 1] : null;
			const navRow = `
				<div id="tm-ta-navrow" class="d-flex flex-wrap align-items-center gap-2 mt-5 mb-4">
					<div class="flex-fill min-w-0">
						<button type="button" class="btn btn-default btn-sm" id="tm-ta-back">← All Addons</button>
					</div>
					<div class="d-flex align-items-center gap-2">
						<button type="button" class="btn btn-default btn-sm" id="tm-ta-prev"
							${prev ? '' : 'disabled'}
							title="${prev ? esc(prev.addon_title || prev.name) : 'Addon pertama'}">‹ Prev</button>
						<span class="text-muted text-nowrap text-small">Addon ${idx + 1} / ${list.length}</span>
						<button type="button" class="btn btn-default btn-sm" id="tm-ta-next"
							${next ? '' : 'disabled'}
							title="${next ? esc(next.addon_title || next.name) : 'Addon terakhir'}">Next ›</button>
					</div>
					<div class="d-flex flex-wrap gap-2 flex-fill min-w-0 justify-content-md-end">
						${taCanWrite ? `
						<button type="button" class="btn btn-outline btn-outline-primary btn-sm" id="tm-ta-edit">✏️ Edit Addon</button>` : ''}
						${taCanDelete ? `
						<button type="button" class="btn btn-danger btn-sm" id="tm-ta-del">🗑 Delete Addon</button>` : ''}
					</div>
				</div>`;

			// ── Kad ADDON INFORMATION ──
			const gallery = detail.gallery_images || [];
			const infoCard = card(12, `🎁 ADDON INFORMATION
				<span class="ml-auto">${badge(a.disable ? 'Disabled' : 'Live',
					a.disable ? C.gray : C.green)}</span>`, `
				<div class="row">
					${a.cover_image ? `
					<div class="col-12 col-md-3 mb-2">
						<img src="${esc(a.cover_image)}" alt="Cover"
							class="img-fluid rounded"
							style="max-height:140px;object-fit:cover">
					</div>` : ''}
					<div class="${a.cover_image ? 'col-12 col-md-9' : 'col-12'}">
						<div class="row">
							<div class="col-12">
								<h2 class="text-truncate mb-2" style="font-size:1.15rem"
									title="${esc(title)}">${esc(title)}</h2>
							</div>
							${field('Addon ID', `<span class="text-monospace">${esc(a.name)}</span>`, 'col-6 col-md-3', true)}
							${field('Type', badge(a.addon_type || 'Other',
								TA_TYPE_COLOR[a.addon_type] || C.gray), 'col-6 col-md-3', true)}
							${field('Organizer', esc(a.addon_organizer || '—'), 'col-6 col-md-3', true)}
							${field('Created', esc(webFmtDate(String(a.creation || '').slice(0, 10))), 'col-6 col-md-3', true)}
							${field('YouTube', a.youtube_video_url
								? `<a href="${esc(a.youtube_video_url)}" target="_blank" rel="noopener">${esc(a.youtube_video_url)}</a>`
								: '—', 'col-12', true)}
						</div>
					</div>
					${a.description ? `
					<div class="col-12">
						<span class="text-muted d-block">Description</span>
						<div class="tm-ta-desc break-words">${a.description}</div>
					</div>` : ''}
					${gallery.length ? field('Gallery', `${gallery.length} photo(s)`, 'col-12', true) : ''}
				</div>`);

			// ── Kad ADDON PACKAGES ──
			const pkgs = detail.packages || [];
			const pkgRows = pkgs.map((p) => {
				const rates = (p.currency_rates || [])
					.map((r) => `${esc(r.currency)} ${esc(fmtNum(r.unit_price))}${r.enabled ? '' : ' ⛔'}`)
					.join('<br>') || '<span class="text-extra-muted">—</span>';
				const scopeRows = (p.trip_scoping || []);
				const applicability = p.applicable_to === 'All Trips'
					? badge('All Trips', C.blue)
					: `<span title="${esc(scopeRows.map((s) =>
						[s.trip_name || s.trip, s.travel_date_name || s.travel_date,
							s.offer_name || s.package_offer].filter(Boolean).join(' › ')).join('\n'))}"
						style="cursor:help">${badge(`${scopeRows.length} scoped`, C.orange)}</span>`;
				const qty = `<strong>${p.current_qty_sold || 0}</strong>${p.max_total_qty
					? ` / ${p.max_total_qty}` : ' / ∞'}<div class="text-muted text-small">
					${p.max_qty_per_booking ? `max ${p.max_qty_per_booking}/booking` : 'no per-booking cap'}</div>`;
				return `
				<tr class="tm-ta-pkg pointer" data-name="${esc(p.name)}"
					title="Sunting pakej ini">
					<td>
						<div class="font-weight-bold">${esc(p.addon_package_name || '(no name)')}</div>
						<div class="text-muted text-small text-monospace">${esc(p.name)}</div>
					</td>
					<td>${badge(p.status, p.status === 'Active' ? C.green : C.gray)}</td>
					<td>${esc(p.scope || '—')}</td>
					<td>${applicability}</td>
					<td>${rates}</td>
					<td class="text-center">${qty}</td>
					<td class="text-nowrap">${esc(taValidityText(p))}${p.sales_cutoff_enabled
						? `<div class="text-muted text-small">cutoff −${p.sales_cutoff_days_before_departure ?? 0}d</div>` : ''}</td>
					<td class="text-center"><strong>${p.sold_items || 0}</strong></td>
					<td class="text-nowrap text-right">
						${taCanWrite ? `<button type="button" class="btn btn-xs btn-default tm-ta-pkg-edit"
							data-name="${esc(p.name)}" title="Sunting pakej">✏️</button>` : ''}
						${taCanDelete ? `<button type="button" class="btn btn-xs btn-danger tm-ta-pkg-del"
							data-name="${esc(p.name)}" title="Padam pakej">🗑</button>` : ''}
					</td>
				</tr>`;
			}).join('');
			const pkgsCard = card(12, `📦 ADDON PACKAGES <span class="text-muted">(${pkgs.length})</span>
				${taCanWrite ? `
				<button type="button" class="btn btn-outline btn-outline-primary btn-sm ml-auto"
					id="tm-ta-pkg-new">＋ New Package</button>` : ''}`, `
				<div class="table-responsive">
				${tmTable(['Package', 'Status', 'Scope', 'Applicable', 'Rates',
					'Qty Sold', 'Validity', 'Sold Items', ''],
					pkgRows,
					'No packages yet. Click "+ New Package" to add pricing & scoping variants.')}
				</div>`);

			$body.html(navRow + infoCard + pkgsCard);

			// ── Pendawaian butang halaman (elemen segar — direct binding) ──
			$body.find('#tm-ta-back').on('click', () =>
				frappe.set_route('travel-manager', 'trip-addon'));
			if (prev) $body.find('#tm-ta-prev').on('click', () =>
				frappe.set_route('travel-manager', 'trip-addon', prev.name));
			if (next) $body.find('#tm-ta-next').on('click', () =>
				frappe.set_route('travel-manager', 'trip-addon', next.name));
			$body.find('#tm-ta-edit').on('click', () =>
				trip_addon_dialog({ ...a, name: a.name },
					() => load_trip_addon_detail(addon)));
			$body.find('#tm-ta-del').on('click', () =>
				ta_delete_dialog(addon, title,
					() => frappe.set_route('travel-manager', 'trip-addon')));
			$body.find('#tm-ta-pkg-new').on('click', () =>
				addon_package_dialog(addon, title, null,
					() => load_trip_addon_detail(addon)));
			$body.find('.tm-ta-pkg').on('click', function (e) {
				// Klik butang aksi (✏️/🗑) BUKAN buka dialog sunting.
				if ($(e.target).closest('button').length) return;
				if (!taCanWrite) return;
				const p = pkgs.find((x) => x.name === $(this).data('name'));
				if (p) addon_package_dialog(addon, title, p,
					() => load_trip_addon_detail(addon));
			});
			$body.find('.tm-ta-pkg-edit').on('click', function (e) {
				e.stopPropagation();
				const p = pkgs.find((x) => x.name === $(this).data('name'));
				if (p) addon_package_dialog(addon, title, p,
					() => load_trip_addon_detail(addon));
			});
			$body.find('.tm-ta-pkg-del').on('click', function (e) {
				e.stopPropagation();
				const name = $(this).data('name');
				const p = pkgs.find((x) => x.name === name);
				tap_delete_dialog(name,
					p?.addon_package_name || name,
					() => load_trip_addon_detail(addon));
			});
		}

		// ══════════════ DIALOG TAMBAH / SUNTING ADDON ══════════════
		// existing = baris senarai ATAU rekod detail (edit); null = cipta.
		// Medan produk sahaja — pakej (harga/scoping) diurus berasingan
		// (addon_package_dialog) supaya dialog kekal ringkas.
		function trip_addon_dialog(existing, onDone) {
			const isEdit = !!existing?.name;
			const d = new frappe.ui.Dialog({
				title: isEdit
					? `✏️ Edit Trip Addon — ${existing.name}`
					: '🎁 New Trip Addon',
				fields: [
					{ fieldname: 'addon_title', fieldtype: 'Data', label: 'Addon Title',
						reqd: 1, default: existing?.addon_title,
						description: 'Nama produk yang dipaparkan — mesti unik.' },
					{ fieldname: 'addon_type', fieldtype: 'Select', label: 'Addon Type',
						reqd: 1, options: TA_TYPES.join('\n'),
						default: existing?.addon_type || 'Other',
						description: 'Kategori am untuk laporan/penapisan (tak menentukan item code SO).' },
					{ fieldname: 'addon_organizer', fieldtype: 'Link',
						label: 'Organizer', options: 'Trip Organizer',
						default: existing?.addon_organizer },
					{ fieldname: 'disable', fieldtype: 'Check', label: 'Disable',
						default: existing?.disable ? 1 : 0,
						description: 'Addon berflag disable disembunyikan daripada katalog portal.' },
					{ fieldname: 'cover_image', fieldtype: 'Attach Image',
						label: 'Cover Image', default: existing?.cover_image || '' },
					{ fieldname: 'youtube_video_url', fieldtype: 'Data',
						label: 'YouTube Video URL',
						default: existing?.youtube_video_url,
						description: 'YouTube video URL atau video ID.' },
					{ fieldname: 'description', fieldtype: 'Text Editor',
						label: 'Description', default: existing?.description || '' },
				],
				primary_action_label: isEdit ? '💾 Simpan' : '🎁 Cipta Addon',
				primary_action: (values) => {
					const $btn = d.get_primary_btn().prop('disabled', true);
					taa('save_trip_addon', {
						values: JSON.stringify({ name: existing?.name || '', ...values }),
					}).then((res) => {
						d.hide();
						frappe.show_alert({
							message: `Addon ${res.name} ${isEdit ? 'disimpan' : 'dicipta'}`,
							indicator: 'green',
						});
						if (onDone) onDone(res);
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.show();
		}

		// ══════════════ DIALOG TAMBAH / SUNTING PACKAGE ══════════════
		// Variant jualan addon: medan ringkas dalam fields dialog + DUA grid
		// biasa di bawah body — Currency Rates (baris: currency terhad kepada
		// paksi yang diisytiharkan, harga, enabled) & Trip Scoping (baris:
		// trip → group date → package, link bersiri difilter ikut trip).
		// Grid dimutate dalam state temp (rates/scoping) — batal = tiada
		// perubahan; Simpan hantar keseluruhan set (server ganti baris).
		function addon_package_dialog(addonName, addonTitle, existing, onDone) {
			const isEdit = !!existing?.name;
			const rates = (existing?.currency_rates || []).map((r) => ({
				currency: r.currency || '', unit_price: r.unit_price ?? null,
				enabled: r.enabled ?? 1,
			}));
			const scoping = (existing?.trip_scoping || []).map((s) => ({
				trip: s.trip || '', travel_date: s.travel_date || '',
				package_offer: s.package_offer || '',
			}));
			// Opsyen currency rate — terhad kepada paksi yang diisytiharkan
			// (validasi server akan menolak yang lain; had di UI lebih awal).
			let taCurOpts = [];

			const d = new frappe.ui.Dialog({
				title: isEdit
					? `✏️ Edit Package — ${existing.name}`
					: `＋ New Package — ${addonTitle}`,
				fields: [
					{ fieldname: 'addon_package_name', fieldtype: 'Data',
						label: 'Package Name', reqd: 1,
						default: existing?.addon_package_name,
						description: 'Nama variant (cth. Standard / VIP) — dipaparkan bersama produk semasa checkout.' },
					{ fieldname: 'status', fieldtype: 'Select', label: 'Status',
						reqd: 1, options: 'Active\nInactive',
						default: existing?.status || 'Active' },
					{ fieldname: 'scope', fieldtype: 'Select', label: 'Scope',
						reqd: 1, options: 'Per Booking\nPer Pax',
						default: existing?.scope || 'Per Pax',
						description: 'Per Pax: setiap traveller = 1 kuantiti (assign semasa checkout). Per Booking: kuantiti aras booking.' },
					{ fieldname: 'applicable_to', fieldtype: 'Select',
						label: 'Applicable To', reqd: 1,
						options: 'All Trips\nSpecific Trips Only',
						default: existing?.applicable_to || 'All Trips',
						description: 'Specific Trips Only: mesti ada ≥1 baris dalam grid Trip Scoping di bawah.' },
					{ fieldname: 'validity_mode', fieldtype: 'Select',
						label: 'Validity Mode',
						options: 'One-Off\nSame as Trip\nRelative to Departure\nFixed Dates',
						default: existing?.validity_mode || 'One-Off' },
					{ fieldname: 'valid_from_offset_days', fieldtype: 'Int',
						label: 'Valid From Offset (days)',
						depends_on: "eval:doc.validity_mode=='Relative to Departure'",
						mandatory_depends_on: "eval:doc.validity_mode=='Relative to Departure'",
						default: existing?.valid_from_offset_days,
						description: 'Contoh -3 = sah bermula 3 hari sebelum berlepas.' },
					{ fieldname: 'valid_to_offset_days', fieldtype: 'Int',
						label: 'Valid To Offset (days)',
						depends_on: "eval:doc.validity_mode=='Relative to Departure'",
						mandatory_depends_on: "eval:doc.validity_mode=='Relative to Departure'",
						default: existing?.valid_to_offset_days },
					{ fieldname: 'fixed_valid_from', fieldtype: 'Date',
						label: 'Fixed Valid From',
						depends_on: "eval:doc.validity_mode=='Fixed Dates'",
						mandatory_depends_on: "eval:doc.validity_mode=='Fixed Dates'",
						default: existing?.fixed_valid_from },
					{ fieldname: 'fixed_valid_to', fieldtype: 'Date',
						label: 'Fixed Valid To',
						depends_on: "eval:doc.validity_mode=='Fixed Dates'",
						mandatory_depends_on: "eval:doc.validity_mode=='Fixed Dates'",
						default: existing?.fixed_valid_to },
					{ fieldname: 'max_qty_per_booking', fieldtype: 'Int',
						label: 'Max Qty Per Booking', default: existing?.max_qty_per_booking,
						description: '0 = tiada had.' },
					{ fieldname: 'max_total_qty', fieldtype: 'Int',
						label: 'Max Total Qty', default: existing?.max_total_qty,
						description: '0 = tiada had (kuantiti terjual dikira automatik).' },
					{ fieldname: 'sales_cutoff_enabled', fieldtype: 'Check',
						label: 'Enable Sales Cutoff',
						default: existing?.sales_cutoff_enabled ? 1 : 0 },
					{ fieldname: 'sales_cutoff_days_before_departure', fieldtype: 'Int',
						label: 'Cutoff (days before departure)',
						depends_on: 'eval:doc.sales_cutoff_enabled',
						mandatory_depends_on: 'eval:doc.sales_cutoff_enabled',
						default: existing?.sales_cutoff_days_before_departure ?? 7 },
				],
				primary_action_label: isEdit ? '💾 Simpan' : '＋ Cipta Package',
				primary_action: (values) => {
					// Pantas gagal — server mengesahkan semula kesemuanya.
					const cleanRates = rates.filter((r) => r.currency);
					if (!cleanRates.length) {
						frappe.msgprint('Sekurang-kurangnya satu baris Currency Rate diperlukan.');
						return;
					}
				if (values.applicable_to === 'Specific Trips Only'
						&& !scoping.filter((s) => s.trip || s.travel_date || s.package_offer).length) {
					frappe.msgprint('"Specific Trips Only" memerlukan sekurang-kurangnya satu baris Trip Scoping.');
					return;
				}
				const $btn = d.get_primary_btn().prop('disabled', true);
				taa('save_addon_package', {
					values: JSON.stringify({
						name: existing?.name || '', addon: addonName,
						...values,
						currency_rates: cleanRates,
						trip_scoping: scoping.filter((s) =>
							s.trip || s.travel_date || s.package_offer),
					}),
					}).then((res) => {
						d.hide();
						frappe.show_alert({
							message: `Package ${res.name} ${isEdit ? 'disimpan' : 'dicipta'}`,
							indicator: 'green',
						});
						if (onDone) onDone(res);
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.$wrapper.addClass('tm-dim-modal');
			d.$wrapper.find('.modal-dialog').addClass('modal-lg');
			d.$body.append(`
				<p class="text-muted small mt-3 mb-2"><strong>💰 Currency Rates</strong> —
					satu baris per currency yang diisytiharkan (Travel Settings ›
					Multi Currency Account). SO addon dikeluarkan oleh company
					yang sepadan dengan currency rate dipilih customer.</p>
				<div class="table-responsive">
					<table class="table table-sm mb-0">
						<thead><tr>
							<th style="min-width:140px">Currency</th>
							<th style="min-width:120px">Unit Price</th>
							<th>Enabled</th>
							<th></th>
						</tr></thead>
						<tbody id="tm-tar-rows"></tbody>
					</table>
				</div>
				<button type="button" class="btn btn-outline btn-outline-primary btn-sm mt-2"
					id="tm-tar-add">+ Add Rate</button>
				<p class="text-muted small mt-4 mb-2"><strong>🎯 Trip Scoping</strong> —
					hadkan pakej kepada trip / Travel Date / Package Offer tertentu
					(hanya wajib bila Applicable To = Specific Trips Only).
					Pilih Trip dahulu untuk menapis Travel Date &amp; Offer.</p>
				<div class="table-responsive">
					<table class="table table-sm mb-0">
						<thead><tr>
							<th style="min-width:180px">Trip</th>
							<th style="min-width:180px">Travel Date</th>
							<th style="min-width:180px">Package Offer</th>
							<th></th>
						</tr></thead>
						<tbody id="tm-tsc-rows"></tbody>
					</table>
				</div>
				<button type="button" class="btn btn-outline btn-outline-primary btn-sm mt-2"
					id="tm-tsc-add">+ Add Scoping</button>
			`);

			// ── Grid CURRENCY RATES ──
			const renderRates = () => {
				const $rows = d.$body.find('#tm-tar-rows');
				// Opsyen paksi belum dimuat / tiada langsung — papar nota
				// (select tanpa <option> tidak boleh dipakai).
				if (!taCurOpts.length) {
					$rows.html('<tr><td colspan="4" class="text-muted small py-2">Memuat senarai currency… — jika kekal kosong, konfigurasikan Travel Settings › Multi Currency Account dahulu.</td></tr>');
					return;
				}
				$rows.html(rates.length ? rates.map((r, i) => `
					<tr data-i="${i}">
						<td><select class="form-control form-control-sm tm-tar-cur"
							data-i="${i}">
							${taCurOpts.map((o) => `
								<option value="${esc(o.currency)}" ${o.currency === r.currency ? 'selected' : ''}>
									${esc(o.currency)}${o.symbol ? ' (' + esc(o.symbol) + ')' : ''}</option>`).join('')}
						</select></td>
						<td><input type="number" step="0.01" min="0"
							class="form-control form-control-sm tm-tar-price"
							data-i="${i}" value="${r.unit_price ?? ''}"></td>
						<td class="text-center"><input type="checkbox"
							class="tm-tar-en" data-i="${i}" ${r.enabled ? 'checked' : ''}></td>
						<td><button type="button" class="btn btn-xs btn-danger tm-tar-del"
							data-i="${i}" title="Buang baris">✕</button></td>
					</tr>`).join('')
					: '<tr><td colspan="4" class="text-muted small py-2">Tiada baris — klik "+ Add Rate".</td></tr>');
			};
			d.$body.on('change', '.tm-tar-cur', function () {
				rates[$(this).data('i')].currency = $(this).val() || '';
			});
			d.$body.on('input', '.tm-tar-price', function () {
				const v = String(this.value).trim();
				rates[$(this).data('i')].unit_price = v === '' ? null : parseFloat(v);
			});
			d.$body.on('change', '.tm-tar-en', function () {
				rates[$(this).data('i')].enabled = $(this).is(':checked') ? 1 : 0;
			});
			d.$body.on('click', '.tm-tar-del', function () {
				rates.splice(parseInt($(this).attr('data-i'), 10), 1);
				renderRates();
			});
			d.$body.find('#tm-tar-add').on('click', () => {
				// Lalai: currency pertama yang belum dipakai (elak duplikasi
				// — validate doctype menolak currency berulang).
				const used = new Set(rates.map((r) => r.currency).filter(Boolean));
				const free = (taCurOpts || []).find((o) => o.currency && !used.has(o.currency));
				rates.push({ currency: free?.currency || '',
					unit_price: null, enabled: 1 });
				renderRates();
			});

			// ── Grid TRIP SCOPING ──
			// Link control dibina semula setiap render; nilai disimpan dulu
			// ke state `scoping` melalui callback change supaya tidak hilang.
			// RECONDITION Nov 2026: Travel Date difilter ikut trip baris
			// (status_editorial Active); Package Offer guna carian
			// search_package_offers_by_travel_date (offer berpaut TERUS
			// kepada Travel Date).
			const renderScoping = () => {
				const $rows = d.$body.find('#tm-tsc-rows');
				$rows.html(scoping.length ? scoping.map((s, i) => `
					<tr data-i="${i}">
						<td><div class="tm-tsc-trip"></div></td>
						<td><div class="tm-tsc-td"></div></td>
						<td><div class="tm-tsc-pkg"></div></td>
						<td><button type="button" class="btn btn-xs btn-danger tm-tsc-del"
							data-i="${i}" title="Buang baris">✕</button></td>
					</tr>`).join('')
					: '<tr><td colspan="4" class="text-muted small py-2">Tiada baris — pakej terbuka untuk SEMUA trip (All Trips).</td></tr>');
				$rows.find('tr[data-i]').each(function () {
					const i = parseInt($(this).attr('data-i'), 10);
					makeLink($(this).find('.tm-tsc-trip'), {
						fieldname: 'trip', doctype: 'Trip',
						value: scoping[i].trip, small: true,
						// GUARD nilai sama: set_value awal (mod edit) turut
						// menyalakan change — jangan kosongkan travel date /
						// offer melainkan trip BENAR-BENAR bertukar.
						set: (v) => {
							if (v === scoping[i].trip) { updateTdFilter(i); return; }
							scoping[i].trip = v;
							// Trip berubah → travel date & offer lama mungkin
							// tak lagi sah; kosongkan & refilter.
							if (scoping[i].travel_date || scoping[i].package_offer) {
								scoping[i].travel_date = '';
								scoping[i].package_offer = '';
								renderScoping();
							} else {
								updateTdFilter(i);
							}
						},
					});
					// Kawalan Link tambahan (bukan makeLink) supaya boleh bawa
					// filters DINAMIK / get_query custom:
					const tdCtrl = frappe.ui.form.make_control({
						parent: $(this).find('.tm-tsc-td'),
						df: {
							fieldtype: 'Link', fieldname: 'travel_date',
							options: 'Travel Date',
							filters: scoping[i].trip
								? { trip: scoping[i].trip, status_editorial: 'Active' }
								: { status_editorial: 'Active' },
							change: () => {
								const v = tdCtrl.get_value() || '';
								if (v === scoping[i].travel_date) return;  // guard set_value awal
								scoping[i].travel_date = v;
								scoping[i].package_offer = '';  // offer ikut date
								renderScoping();
							},
						},
						render_input: true, only_input: true,
					});
					tdCtrl.$input.addClass('form-control-sm');
					if (scoping[i].travel_date) tdCtrl.set_value(scoping[i].travel_date);
					const pkgCtrl = frappe.ui.form.make_control({
						parent: $(this).find('.tm-tsc-pkg'),
						df: {
							fieldtype: 'Link', fieldname: 'package_offer',
							options: 'Package Offer',
							get_query: () => ({
								query: 'travel_booking.api.addon_manager.search_package_offers_by_travel_date',
								filters: {
									trip: scoping[i].trip || '',
									travel_date: scoping[i].travel_date || '',
								},
							}),
							change: () => { scoping[i].package_offer = pkgCtrl.get_value() || ''; },
						},
						render_input: true, only_input: true,
					});
					pkgCtrl.$input.addClass('form-control-sm');
					if (scoping[i].package_offer) pkgCtrl.set_value(scoping[i].package_offer);
					// Simpan ref utk refilter travel date bila trip bertukar.
					$(this).data('td-ctrl', tdCtrl);
				});
			};
			const updateTdFilter = (i) => {
				const $tr = d.$body.find(`#tm-tsc-rows tr[data-i="${i}"]`);
				const tdCtrl = $tr.data('td-ctrl');
				if (tdCtrl) tdCtrl.df.filters = {
					status_editorial: 'Active',
					...(scoping[i].trip ? { trip: scoping[i].trip } : {}),
				};
			};
			d.$body.on('click', '.tm-tsc-del', function () {
				scoping.splice(parseInt($(this).attr('data-i'), 10), 1);
				renderScoping();
			});
			d.$body.find('#tm-tsc-add').on('click', () => {
				scoping.push({ trip: '', travel_date: '', package_offer: '' });
				renderScoping();
			});

			renderRates();
			renderScoping();
			d.show();
			// Muat opsyen currency paksi selepas dialog dibuka (select
			// dirender semula dengan pilihan sebenar).
			taa('get_rate_currency_options').then((opts) => {
				taCurOpts = opts || [];
				renderRates();
			}).catch(() => { taCurOpts = []; });
		}

		// ══════════════ DIALOG PADAM ADDON / PACKAGE ══════════════
		// Corak trip/cruise: taip nama penuh untuk sahkan. Server menyekat
		// pemadaman bila masih dipaut (pakej / item jualan) — mesej
		// rujukan dipaparkan frappe.
		function ta_delete_dialog(addon, title, onDone) {
			frappe.prompt(
				[{
					fieldname: 'confirm_name', fieldtype: 'Data', reqd: 1,
					label: `Taip <strong>${esc(addon)}</strong> untuk sahkan pemadaman`,
					description: `Addon <strong>${esc(title)}</strong> akan dipadam
						selama-lamanya. Pakejnya mesti dipadam dahulu — pemadaman
						DISEKAT bila masih ada pakej atau item jualan yang
						merujuknya; mesej sistem akan menyenaraikannya.`,
				}],
				(values) => {
					if ((values.confirm_name || '').trim() !== addon) {
						frappe.msgprint('Nama addon tidak sepadan — pemadaman dibatalkan.');
						return;
					}
					taa('delete_trip_addon', { addon }).then(() => {
						frappe.show_alert({ message: `Addon ${addon} dipadam`,
							indicator: 'red' });
						if (onDone) onDone();
					}).catch(() => { /* frappe already shows it */ });
				},
				__('🗑 Delete Trip Addon — tidak boleh dibatalkan'),
			);
		}

		function tap_delete_dialog(pkg, label, onDone) {
			frappe.prompt(
				[{
					fieldname: 'confirm_name', fieldtype: 'Data', reqd: 1,
					label: `Taip <strong>${esc(pkg)}</strong> untuk sahkan pemadaman`,
					description: `Package <strong>${esc(label)}</strong> akan dipadam
						selama-lamanya. Pemadaman DISEKAT bila masih ada Booking
						Addon Item yang merujuknya (sejarah jualan).`,
				}],
				(values) => {
					if ((values.confirm_name || '').trim() !== pkg) {
						frappe.msgprint('Nama package tidak sepadan — pemadaman dibatalkan.');
						return;
					}
					taa('delete_addon_package', { package: pkg }).then(() => {
						frappe.show_alert({ message: `Package ${pkg} dipadam`,
							indicator: 'red' });
						if (onDone) onDone();
					}).catch(() => { /* frappe already shows it */ });
				},
				__('🗑 Delete Addon Package — tidak boleh dibatalkan'),
			);
		}
