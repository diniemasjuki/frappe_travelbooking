	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRAVEL DATES DIREKTORI (tm_dates_directory.js)
	   ════════════════════════════════════════════════════════════════════
	   Direktori SEMUA Travel Date (group date) aras-trip — sub-menu TRIP
	   pada nav travel-manager (Nov 2026): pantau & urus SEMUA kumpulan
	   tarikh SEKALI gus tanpa akses borang doctype.
	     /travel-dates          → direktori (datatable: carian, penapis
	                               status + kategori + jenis trip,
	                               penapis TRIP = input autocomplete
	                               100% lebar (senarai cadangan penuh
	                               lebar — corak sama dgn Package
	                               Offers), saiz halaman, pagination &
	                               sortable; baris DIKUMPUL ikut trip —
	                               header kumpulan COLLAPSIBLE (klik
	                               header / Collapse-Expand all), bukan
	                               kolum Trip; select-all + bulk
	                               edit/padam)
	   Status editorial = badge PAPARAN SAHAJA (corak Package Offers —
	   perubahan status melalui dialog ✏️ / bulk edit; Active/Cancelled
	   kekal manager-gated di server). Tarikh berlepas/pulang diubah
	   MELALUI dialog ✏️ sahaja (doc.save penuh — durasi dikira semula &
	   tarikh disinkron ke offer anak); bulk edit terhad kepada kategori
	   & status (DATE_BULK_EDIT_FIELDS server).
	   Tiada detail view sendiri — baris deep-link ke halaman Travel Date
	   sedia ada (trip/<trip>/date/<date>); pautan trip → direktori trip.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, state, breadcrumb, esc, badge, C, card, tmDataTable,
	   isManager, webFmtLoad/webFmtDate, api) secara terus.
	   API AWAM: load_dates_directory() (dipanggil router shell).
	   Backend: travel_booking.api.package_admin (helper `api` kongsi) —
	     get_dates_directory / save_date_info / delete_travel_date /
	     bulk_update_dates / bulk_delete_dates.
	   Komponen: kad/card() stok Bootstrap, jadual tmDataTable() kongsi
	   (EXT {raw} header select-all + EXT groupOf/groupHeaderHtml utk
	   pengumpulan ikut trip), dialog frappe.ui.Dialog / frappe.prompt /
	   frappe.confirm + FieldGroup utk nilai bulk (corak
	   open_traveller_bulk_dialog) — tiada CSS baharu.
	   ════════════════════════════════════════════════════════════════════ */

		// ── Helper & konstanta seksyen ──
		// Status editorial doctype Travel Date (operational KEKAL auto-job).
		// Active/Cancelled di-gate server (_gate_status_change: Tour
		// Manager/System Manager sahaja) — disemak dalam dialog ✏️ & bulk
		// edit, BUKAN badge paparan. (TD_STATUSES setempat travel_date_dialog
		// — skop fungsi; TIDAK berlanggar dgn nama ini.)
		const TDD_STATUSES = ['Draft', 'Active', 'Cancelled'];
		// Katalog bulk edit — cermin DATE_BULK_EDIT_FIELDS
		// (package_admin.py). Tarikh berlepas/pulang SENGAJA tidak ditawarkan
		// utk bulk — perubahan tarikh melalui dialog ✏️ (doc.save penuh:
		// durasi dikira semula + sinkron tarikh/sailing ke offer anak).
		const TDD_BULK_FIELDS = [
			{ key: 'trip_category', label: 'Trip Category',
				fieldtype: 'Link', options: 'Trip Category' },
			{ key: 'status_editorial', label: 'Editorial Status',
				fieldtype: 'Select', options: TDD_STATUSES },
		];
		// Kebenaran (selari gate server): tulis = Manager/Operator,
		// padam = Tour Manager/System Manager sahaja.
		const tddCanWrite = isManager || frappe.user.has_role('Tour Operator');
		const tddCanDelete = isManager;

		// Kunci kumpulan (groupOf/tddCollapsed/pre-sort DUA aras — SATU
		// sumber): label trip; tarikh legasi TANPA trip diberi kumpulan
		// sentinel "__notrip__" ("Tanpa trip") supaya SEMUA baris ada
		// kumpulan yang boleh diruntuhkan/buka.
		const TDD_NOTRIP = '__notrip__';
		const tddGroupKey = (r) => r.trip_label || r.trip || TDD_NOTRIP;

		// Baris senarai terkini + pilihan (Set) — rujukan handler
		// delegated (dikemaskini setiap load; handler dipasang SEKALI
		// di bawah — baris dirender semula oleh pagination/sort/search).
		let tddRows = [];
		const tddSel = new Set();
		const tddCollapsed = new Set();  // trip kumpulan yang diruntuhkan
		let tddDt = null;
		let tddTotal = 0;  // jumlah rekod server (utk amaran cap & kiraan strip)

		// Strip ringkasan (counts) — dirender semula selepas setiap mutasi
		// supaya kekal seiring dgn tddRows tanpa fetch semula.
		const tddSummaryHtml = () => {
			const shown = tddRows.length;
			const truncated = tddTotal > shown;
			const bySt = (s) => tddRows.filter(
				(r) => (r.status || 'Draft') === s).length;
			const offersTotal = tddRows.reduce((n, r) => n + (r.packages_count || 0), 0);
			const soldTotal = tddRows.reduce((n, r) => n + (r.sold_pax || 0), 0);
			return `
				<span class="text-nowrap"><strong class="text-body">${shown}</strong> tarikh${truncated ? ` daripada <strong>${tddTotal}</strong>` : ''}</span>
				<span class="text-nowrap" style="color:${C.green}"><strong>${bySt('Active')}</strong> active</span>
				<span class="text-nowrap" style="color:${C.gray}"><strong>${bySt('Draft')}</strong> draft</span>
				<span class="text-nowrap" style="color:${C.red}"><strong>${bySt('Cancelled')}</strong> cancelled</span>
				<span class="text-nowrap"><strong>${offersTotal}</strong> offers</span>
				<span class="text-nowrap"><strong>${soldTotal}</strong> pax sold</span>
				${truncated ? `<span class="text-nowrap" style="color:${C.orange}">⚠ paparan terhad ${shown} (cap 1000) — gunakan carian</span>` : ''}`;
		};
		// Kemas kini strip ringkasan + kiraan tajuk kad selepas mutasi.
		const tddRefreshMeta = () => {
			$body.find('#tm-dd-summary').html(tddSummaryHtml());
			$body.find('#tm-dd-count').text(tddRows.length);
		};

		// Render semula jadual — tmDataTable.rerender jana semula
		// tbody (+thead) daripada tddRows/tddSel/tddCollapsed — kemudian
		// selaras checkbox header & label butang collapse-all.
		const renderTddTable = () => {
			tddDt?.rerender();
			tddSyncSelAll();
			tddUpdateCollapseBtn();
		};

		// Selaras checkbox select-all header dgn baris DIPAPAR semasa
		// (checked bila semua dipapar dipilih; indeterminate bila separa).
		// Baris kumpulan yang DIRUNTUHKAN (d-none) TIDAK dikira —
		// select-all hanya meliputi baris yang kelihatan.
		const tddSyncSelAll = () => {
			const boxes = $body.find('.tm-dd-sel').filter(':visible').toArray();
			const all = boxes.length > 0 && boxes.every((b) => b.checked);
			const some = boxes.some((b) => b.checked);
			$body.find('#tm-dd-selall').prop({ checked: all, indeterminate: some && !all });
		};

		// Kemas kini label/keadaan butang bulk (toolbar atas).
		const tddUpdateButtons = () => {
			const n = tddSel.size;
			$body.find('#tm-dd-bulk-edit').prop('disabled', !n)
				.text(n ? `✏️ Bulk Edit (${n})` : '✏️ Bulk Edit');
			$body.find('#tm-dd-bulk-del').prop('disabled', !n)
				.text(n ? `🗑 Delete (${n})` : '🗑 Delete');
		};

		// Label butang Collapse/Expand all — ikut keadaan tddCollapsed
		// (semua kumpulan diruntuhkan → tawar Expand all).
		const tddUpdateCollapseBtn = () => {
			const keys = [...new Set(tddRows.map(tddGroupKey))];
			const all = keys.length > 0 && keys.every((k) => tddCollapsed.has(k));
			$body.find('#tm-dd-collapse-all').text(all ? '⤢ Expand all' : '⤡ Collapse all');
		};

		// Badge status editorial — PAPARAN SAHAJA (corak Package Offers:
		// bukan dropdown editable). Perubahan status melalui dialog ✏️ /
		// bulk edit — gate Tour Manager disemak di server.
		const tddStatusBadge = (d) => {
			const st = d.status || 'Draft';
			const color = st === 'Active' ? C.green
				: st === 'Cancelled' ? C.red : C.gray;
			return badge(st, color);
		};

		// ── Baris header kumpulan (ikut trip) — EXT groupHeaderHtml
		// tmDataTable: caret runtuh/buka + trip sebagai pautan direktori +
		// flag Cruise + bilangan tarikh DLM senarai terfilter. Tarikh legasi
		// tanpa trip → kumpulan "Tanpa trip" (juga collapsible). Klik
		// mana-mana pada baris header = runtuh/buka (KECUALI klik pautan
		// trip — kekal navigasi). colspan = 8 kolum (checkbox | Departure
		// | Return | Category | Status | Offers | Pax | aksi).
		const tddGroupHeaderHtml = (g, firstRow, count) => `
			<tr class="tm-dd-group table-light" data-trip="${esc(g)}"
				title="Klik untuk runtuh/buka kumpulan trip ini">
				<td colspan="8">
					<span class="tm-dd-grp-caret text-muted"
						aria-hidden="true">${tddCollapsed.has(g) ? '▸' : '▾'}</span>
					${firstRow.trip
						? `<a href="javascript:void(0)"
							class="tm-dd-trip font-weight-bold"
							data-trip="${esc(firstRow.trip)}">${esc(firstRow.trip_label || firstRow.trip)}</a>
							<span class="text-muted text-small text-monospace">${esc(firstRow.trip)}</span>`
						: '<strong class="text-muted">Tanpa trip</strong>'}
					${firstRow.trip && firstRow.is_a_cruise_trip
						? ` ${badge('Cruise', C.blue)}` : ''}
					<span class="text-muted text-small ml-2">${count} date${count === 1 ? '' : 's'}</span>
				</td>
			</tr>`;

		// ── Baris jadual direktori (tmDataTable rowHtml) — Trip dipaparkan
		// sbg HEADER KUMPULAN (arahan pemilik), bukan kolum. Baris trip
		// yang diruntuhkan diberi d-none (tddCollapsed kekal merentas
		// render — carian/penapis/sort/pagination). Departure = deep-link
		// ke halaman Travel Date (trip/<trip>/date/<date>); tarikh legasi
		// tanpa trip → teks biasa. ──
		const tddRowHtml = (d) => `
			<tr class="tm-dd-row${tddCollapsed.has(tddGroupKey(d)) ? ' d-none' : ''}"
				data-name="${esc(d.name)}">
				<td class="text-center"><input type="checkbox" class="tm-dd-sel"
					data-name="${esc(d.name)}" ${tddSel.has(d.name) ? 'checked' : ''}
					title="Pilih tarikh utk bulk edit/padam"/></td>
				<td class="text-nowrap">
					${d.trip && d.name
						? `<a href="javascript:void(0)"
							class="tm-dd-open font-weight-bold"
							data-trip="${esc(d.trip)}" data-date="${esc(d.name)}">${esc(webFmtDate(d.departure_date))}</a>`
						: `<span class="font-weight-bold">${esc(webFmtDate(d.departure_date))}</span>`}
					<div class="text-muted text-small text-monospace">${esc(d.name)}</div>
				</td>
				<td class="text-nowrap">${esc(webFmtDate(d.return_date))}</td>
				<td>${d.trip_category
					? esc(d.trip_category)
					: '<span class="text-extra-muted">—</span>'}</td>
				<td>${tddStatusBadge(d)}</td>
				<td class="text-center"><strong>${d.packages_count ?? 0}</strong>
					${d.active_packages
						? `<div class="text-small" style="color:${C.green}">${d.active_packages} active</div>` : ''}</td>
				<td class="text-center"><strong>${d.sold_pax ?? 0}</strong></td>
				<td class="text-nowrap text-right">
					${tddCanWrite ? `<button type="button"
						class="btn btn-xs btn-default tm-dd-edit"
						data-name="${esc(d.name)}" title="Edit tarikh">✏️</button>` : ''}
					${tddCanDelete ? `<button type="button"
						class="btn btn-xs btn-danger tm-dd-del"
						data-name="${esc(d.name)}" title="Padam tarikh (+ offer anak)">🗑</button>` : ''}
				</td>
			</tr>`;

		// ── Handler delegated (SEKALI sahaja — baris jadual dirender semula
		// oleh pagination/sort/search tmDataTable, jadi delegasi pada $body) ──
		$body.on('change', '.tm-dd-sel', function () {
			const name = $(this).data('name');
			if (this.checked) tddSel.add(name); else tddSel.delete(name);
			tddSyncSelAll(); tddUpdateButtons();
		});
		// Select-all header — meliputi baris DIPAPAR semasa sahaja
		// (carian/penapis/kumpulan diruntuhkan tetap dihormati).
		$body.on('click', '#tm-dd-selall', function () {
			const checked = this.checked;
			$body.find('.tm-dd-sel').filter(':visible').each(function () {
				this.checked = checked;
				const name = $(this).data('name');
				if (checked) tddSel.add(name); else tddSel.delete(name);
			});
			tddUpdateButtons();
		});
		// Re-sync header checkbox selepas re-render dalaman tmDataTable
		// (carian/penapis/sort/pagination — event bubble ke $body).
		$body.on('click input change', '.tm-dt-page, .tm-dt-sortable, .tm-dt-size, .tm-dt-search, .tm-dt-mf, .tm-dt-filter',
			() => setTimeout(tddSyncSelAll, 0));
		// Trip → direktori trip; tarikh berlepas → halaman Travel Date.
		$body.on('click', '.tm-dd-trip', function (e) {
			e.stopPropagation();
			frappe.set_route('travel-manager', 'trip', $(this).data('trip'));
		});
		// Runtuh/buka kumpulan trip — klik pada baris header kumpulan
		// (klik pautan trip KECUALI — kekal navigasi). Keadaan dalam
		// tddCollapsed kekal merentas render; baris kumpulan diberi d-none
		// dalam rowHtml.
		$body.on('click', '.tm-dd-group', function (e) {
			if ($(e.target).closest('.tm-dd-trip').length) return;
			const trip = $(this).data('trip');
			if (!trip) return;
			if (tddCollapsed.has(trip)) tddCollapsed.delete(trip);
			else tddCollapsed.add(trip);
			renderTddTable();
		});
		// Collapse/Expand SEMUA kumpulan (butang toolbar atas) — termasuk
		// kumpulan "Tanpa trip" (legasi).
		$body.on('click', '#tm-dd-collapse-all', () => {
			const keys = [...new Set(tddRows.map(tddGroupKey))];
			if (keys.length && keys.every((k) => tddCollapsed.has(k)))
				tddCollapsed.clear();
			else
				keys.forEach((k) => tddCollapsed.add(k));
			renderTddTable();
		});
		$body.on('click', '.tm-dd-open', function (e) {
			e.stopPropagation();
			const $a = $(this);
			if (!$a.data('trip') || !$a.data('date')) return;
			frappe.set_route('travel-manager', 'trip', $a.data('trip'),
				'date', $a.data('date'));
		});
		// Status badge = paparan sahaja — tiada handler inline (perubahan
		// status melalui dialog ✏️ / bulk edit, gate di server).
		// Edit dialog / padam per baris.
		$body.on('click', '.tm-dd-edit', function (e) {
			e.stopPropagation();
			const row = tddRows.find((r) => r.name === $(this).data('name'));
			if (row) tdd_edit_dialog(row);
		});
		$body.on('click', '.tm-dd-del', function (e) {
			e.stopPropagation();
			const name = $(this).data('name');
			if (name) tdd_delete_dialog(name);
		});
		// Butang bulk (toolbar atas) — label/keadaan dikemas kini
		// tddUpdateButtons().
		$body.on('click', '#tm-dd-bulk-edit', () => { if (tddSel.size) tdd_bulk_edit_dialog(); });
		$body.on('click', '#tm-dd-bulk-del', () => { if (tddSel.size) tdd_bulk_delete_dialog(); });

		// ══════════════ TRAVEL DATES (direktori aras-trip) ══════════════
		async function load_dates_directory() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Travel Dates' },
			]);
			$body.html(loading());
			await webFmtLoad();

			const data = await api('get_dates_directory', { limit: 1000 });
			tddRows = data?.dates || [];
			tddSel.clear();
			tddCollapsed.clear();
			tddDt = null;
			// Susunan lalai DIKUMPUL ikut trip (corak Package Offers): trip
			// naik ikut nama (kunci = tddGroupKey), tarikh dlm trip ikut
			// tarikh berlepas. Sort kolum (klik header) hanya menyusun DALAM
			// kumpulan (EXT groupOf).
			tddRows.sort((a, b) =>
				tddGroupKey(a) < tddGroupKey(b) ? -1
				: tddGroupKey(a) > tddGroupKey(b) ? 1
				: String(a.departure_date || '').localeCompare(String(b.departure_date || '')));
			const shown = tddRows.length;
			tddTotal = parseInt(data?.total, 10) || shown;

			$body.html(`
				<div class="d-flex flex-wrap gap-2 align-items-center text-muted mb-3">
					<div class="d-flex gap-2 overflow-auto py-1" id="tm-dd-summary"
						aria-label="Ringkasan travel dates">${tddSummaryHtml()}</div>
					<div class="d-flex gap-2 ml-auto">
						${shown ? `<button type="button"
							class="btn btn-outline-secondary btn-sm"
							id="tm-dd-collapse-all">⤡ Collapse all</button>` : ''}
						${tddCanWrite ? `<button type="button"
							class="btn btn-primary btn-sm" id="tm-dd-bulk-edit"
							disabled>✏️ Bulk Edit</button>` : ''}
						${tddCanDelete ? `<button type="button"
							class="btn btn-outline-danger btn-sm" id="tm-dd-bulk-del"
							disabled>🗑 Delete</button>` : ''}
					</div>
				</div>
				${card(12, `📅 TRAVEL DATES <span class="text-muted">(<span id="tm-dd-count">${shown}</span>${tddTotal > shown ? ` / ${tddTotal}` : ''})</span>`, `
					<div id="tm-dates-dir-dt"></div>`)}
			`);

			// Jadual interaktif kongsi: carian + penapis (status, kategori,
			// jenis trip, trip) + sortable + pagination dalam card-footer
			// (footer: true). Baris DIKUMPUL ikut trip — header kumpulan
			// disisipkan tmDataTable (EXT groupOf).
			tddDt = tmDataTable('#tm-dates-dir-dt', tddRows, {
				footer: true,
				pageSize: 10,
				pageSizeOptions: [10, 25, 50, 100],
				pageSizesLabel: 'Per page',
				headers: [
					// EXT {raw} — HTML mentah (checkbox select-all header).
					{ raw: `<input type="checkbox" id="tm-dd-selall"
						title="Pilih semua baris dipaparkan"/>` },
					'Departure Date', 'Return Date', 'Trip Category',
					'Status', { text: 'Offers', cls: 'text-center' },
					{ text: 'Pax', cls: 'text-center' }, '',
				],
				rowHtml: tddRowHtml,
				// EXT pengumpulan: trip = kunci kumpulan (tddGroupKey —
				// legasi tanpa trip → kumpulan "Tanpa trip"); header
				// kumpulan (caret + nama trip + flag Cruise + bil. tarikh)
				// menggantikan kolum Trip.
				groupOf: (r) => tddGroupKey(r),
				groupHeaderHtml: (g, firstRow, count) =>
					tddGroupHeaderHtml(g, firstRow, count),
				searchIn: (r) => [r.name, r.travel_date_name, r.trip_label,
					r.trip, r.trip_category, r.status,
					r.departure_date, r.return_date,
					webFmtDate(r.departure_date), webFmtDate(r.return_date)]
					.join(' '),
				searchPlaceholder: 'Search trip / date name / departure…',
				emptyMsg: 'No travel dates yet — create one from a trip '
					+ 'directory ("+ New Travel Date").',
				filters: [
					{ key: 'status', label: 'All statuses',
						of: (r) => r.status || 'Draft' },
					{ key: 'trip_category', label: 'All categories',
						of: (r) => r.trip_category || '—' },
					{ key: 'cruise', label: 'All trip types',
						of: (r) => r.is_a_cruise_trip ? 'Cruise' : 'Non-Cruise' },
					// trip = select TERSEMBUNYI — dikawal input autocomplete
					// 100% lebar (blok bawah).
					{ key: 'trip', label: 'All trips',
						of: (r) => r.trip_label || r.trip || '—' },
				],
				sortable: [
					null,
					{ key: 'dep', val: (r) => r.departure_date || '' },
					{ key: 'ret', val: (r) => r.return_date || '' },
					{ key: 'cat', val: (r) => (r.trip_category || '').toLowerCase() },
					{ key: 'status', val: (r) => TDD_STATUSES.indexOf(r.status || 'Draft') },
					{ key: 'offers', val: (r) => r.packages_count || 0 },
					{ key: 'pax', val: (r) => r.sold_pax || 0 },
					null,
				],
			});
			tddUpdateButtons();
			tddUpdateCollapseBtn();
			tddSyncSelAll();

			// ── Penapis TRIP: input autocomplete 100% lebar (arahan
			// pemilik, Nov 2026 — corak sama dgn direktori Package
			// Offers): select trip sedia ada DISEMBUNYIKAN tetapi kekal
			// sebagai sumber keadaan penapis (trigger change → st.mf
			// tmDataTable), input hanya kulit UI yang lebih baik: senarai
			// cadangan penuh lebar (nama trip + ID + badge Cruise + bil.
			// tarikh), navigasi keyboard, butang ✕. ──
			const $tripSel = $body.find('#tm-dates-dir-dt .tm-dt-mf[data-key="trip"]');
			$tripSel.addClass('d-none');
			// Satu opsyen per kumpulan trip — susun ikut label; kiraan
			// tarikh per kumpulan diira sekali.
			const tripOpts = [...new Map(tddRows.map((r) => [tddGroupKey(r), {
				key: tddGroupKey(r),
				label: r.trip_label || r.trip || '—',
				id: r.trip || '',
				cruise: !!r.is_a_cruise_trip,
				count: 0,
			}])).values()].sort((a, b) =>
				a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1);
			tripOpts.forEach((t) => {
				t.count = tddRows.filter((r) => tddGroupKey(r) === t.key).length;
			});
			let tddTripLabel = '';  // label trip dipilih (utk restore input)

			const $tripWrap = $(`
				<div class="tm-dd-trip-wrap position-relative w-100 mt-1">
					<div class="input-group input-group-sm">
						<input type="text" autocomplete="off"
							class="form-control tm-dd-trip-input"
							placeholder="Filter by trip — taip untuk cari nama / ID trip…"
							aria-label="Filter by trip">
						<div class="input-group-append">
							<button type="button"
								class="btn btn-outline-secondary tm-dd-trip-clear d-none"
								title="Buang penapis trip">✕</button>
						</div>
					</div>
					<div class="dropdown-menu tm-dd-trip-list w-100"
						role="listbox" aria-label="Trip options"></div>
				</div>`);
			$body.find('#tm-dates-dir-dt .tm-dt-toolbar').append($tripWrap);
			const $tripInput = $tripWrap.find('.tm-dd-trip-input');
			const $tripList = $tripWrap.find('.tm-dd-trip-list');
			const $tripClear = $tripWrap.find('.tm-dd-trip-clear');

			// Senarai cadangan — ditapis ikut teks (nama ATAU ID trip);
			// setiap item = baris penuh lebar (dropdown-item = block 100%).
			const tripRenderList = (q) => {
				const qq = (q || '').toLowerCase();
				const matches = tripOpts.filter((t) => !qq
					|| t.label.toLowerCase().includes(qq)
					|| t.id.toLowerCase().includes(qq));
				$tripList.html(matches.length ? matches.map((t, i) => `
					<button type="button" role="option" aria-selected="false"
						class="dropdown-item tm-dd-trip-opt${i === 0 ? ' active' : ''}"
						data-label="${esc(t.label)}">
						${t.label === '—'
							? '<strong class="text-muted">Tanpa trip</strong>'
							: `<span class="font-weight-bold">${esc(t.label)}</span>`}
						${t.id ? `<span class="text-muted text-small text-monospace">${esc(t.id)}</span>` : ''}
						${t.cruise ? ` ${badge('Cruise', C.blue)}` : ''}
						<span class="text-muted text-small ml-2">${t.count} date${t.count === 1 ? '' : 's'}</span>
					</button>`).join('')
				: '<div class="dropdown-item text-muted text-small">Tiada trip sepadan.</div>');
				$tripList.addClass('show');
			};
			const tripCloseList = () => $tripList.removeClass('show');
			// Guna label sbg nilai penapis (nilai opsyen select = label).
			const tripApply = (label) => {
				tddTripLabel = label || '';
				$tripInput.val(tddTripLabel);
				$tripClear.toggleClass('d-none', !tddTripLabel);
				tripCloseList();
				$tripSel.val(tddTripLabel).trigger('change');
			};
			$tripInput.on('focus input', function () {
				tripRenderList($(this).val());
			});
			$tripInput.on('keydown', function (e) {
				const $items = $tripList.find('.tm-dd-trip-opt');
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					if (!$items.length) return;
					let idx = $items.index($tripList.find('.tm-dd-trip-opt.active'));
					idx = e.key === 'ArrowDown'
						? Math.min(idx + 1, $items.length - 1)
						: Math.max(idx - 1, 0);
					$items.removeClass('active');
					$items.eq(idx).addClass('active');
					return;
				}
				if (e.key === 'Enter') {
					e.preventDefault();
					$tripList.find('.tm-dd-trip-opt.active')
						.trigger('mousedown');
					return;
				}
				if (e.key === 'Escape') {
					tripCloseList();
					$tripInput.val(tddTripLabel);
				}
			});
			// mousedown (bukan click) — berlaku SEBELUM blur input, jadi
			// pilihan sempat dimohon dan preventDefault kekalkan fokus.
			$tripList.on('mousedown', '.tm-dd-trip-opt', function (e) {
				e.preventDefault();
				tripApply($(this).data('label'));
			});
			$tripInput.on('blur', function () {
				// Lewat kecil — mousedown opsyen sempat berlaku dulu;
				// pulihkan teks ke pilihan semasa.
				setTimeout(() => {
					tripCloseList();
					$tripInput.val(tddTripLabel);
				}, 150);
			});
			$tripClear.on('click', () => {
				tripApply('');
				$tripInput.focus();
			});
		}

		// ══════════════ DIALOG EDIT DATE ══════════════
		// Kemaskini segera SATU tarikh: Departure/Return, Trip Category &
		// status editorial — satu endpoint save_date_info. Tarikh melalui
		// doc.save() penuh di server (durasi dikira semula + sinkron ke
		// offer anak). Status TIDAK dihantar bila tidak berubah — elak gate
		// Tour Manager gagal utk Operator yang edit medan lain (corak sama
		// dgn po_edit_dialog). Server memulangkan nilai EFEKTIF — baris
		// di-patch tempatan + render semula (tiada fetch).
		function tdd_edit_dialog(d) {
			const curStatus = d.status || 'Draft';
			const curCat = d.trip_category || '';
			const curDep = d.departure_date || '';
			const curRet = d.return_date || '';
			const tddD = new frappe.ui.Dialog({
				title: `✏️ Edit Travel Date — ${d.name}`,
				fields: [
					{ fieldname: 'departure_date', fieldtype: 'Date',
						label: 'Departure Date', reqd: 1,
						default: curDep,
						description: 'Perubahan tarikh disinkron ke SEMUA offer '
							+ 'anak & durasi dikira semula.' },
					{ fieldname: 'return_date', fieldtype: 'Date',
						label: 'Return Date', default: curRet },
					{ fieldname: 'trip_category', fieldtype: 'Link',
						options: 'Trip Category', label: 'Trip Category',
						default: curCat },
					{ fieldname: 'status_editorial', fieldtype: 'Select',
						label: 'Editorial Status',
						options: TDD_STATUSES.join('\n'), default: curStatus,
						description: 'Active/Cancelled perlukan Tour Manager '
							+ '(disemak di server).' },
				],
				primary_action_label: '💾 Simpan',
				primary_action: (values) => {
					const args = {
						date: d.name,
						departure_date: values.departure_date || '',
						return_date: values.return_date || '',
						trip_category: (values.trip_category || '').trim(),
					};
					if ((values.status_editorial || '') !== curStatus)
						args.status_editorial = values.status_editorial;
					const $btn = tddD.get_primary_btn().prop('disabled', true);
					api('save_date_info', args).then((out) => {
						tddD.hide();
						// Patch baris tempatan + render semula (tiada fetch) —
						// nilai EFEKTIF daripada server.
						if (out?.departure_date) d.departure_date = out.departure_date;
						if (out?.return_date) d.return_date = out.return_date;
						if (out) d.trip_category = out.trip_category || '';
						if (out?.status_editorial) d.status = out.status_editorial;
						renderTddTable();
						tddRefreshMeta();
						frappe.show_alert({
							message: `Travel Date ${d.name} disimpan`, indicator: 'green' });
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			tddD.show();
		}

		// ══════════════ DIALOG PADAM DATE (per baris) ══════════════
		// Corak trip/offer: taip nama penuh untuk sahkan. Server
		// (delete_travel_date) memadam offer anak tarikh ini sekali dan
		// MENYEKAT pemadaman bila masih ada booking aktif / pax terjual —
		// mesej sebab dipaparkan frappe.
		function tdd_delete_dialog(name) {
			frappe.prompt(
				[{
					fieldname: 'confirm_name', fieldtype: 'Data', reqd: 1,
					label: `Taip <strong>${esc(name)}</strong> untuk sahkan pemadaman`,
					description: `Travel Date <strong>${esc(name)}</strong> beserta
						SEMUA offer di dalamnya dipadam selama-lamanya. Pemadaman
						DISEKAT bila masih ada booking aktif atau pax terjual —
						mesej sistem menyatakan sebabnya.`,
				}],
				(values) => {
					if ((values.confirm_name || '').trim() !== name) {
						frappe.msgprint('Nama tarikh tidak sepadan — pemadaman dibatalkan.');
						return;
					}
					api('delete_travel_date', { travel_date: name }).then((out) => {
						const idx = tddRows.findIndex((r) => r.name === name);
						if (idx > -1) tddRows.splice(idx, 1);
						tddSel.delete(name);
						tddTotal = Math.max(tddRows.length, tddTotal - 1);
						renderTddTable(); tddUpdateButtons(); tddRefreshMeta();
						frappe.show_alert({
							message: `Travel Date ${name} dipadam`
								+ (out?.deleted?.offers ? ` (${out.deleted.offers} offer)` : ''),
							indicator: 'red' });
					}).catch(() => { /* frappe already shows it */ });
				},
				__('🗑 Delete Travel Date — tidak boleh dibatalkan'),
			);
		}

		// Ringkasan hasil bulk — alert ringkas bila bersih; msgprint dgn
		// senarai sebab bila ada skipped/failed (mirror po_bulk_result_alert).
		const tdd_bulk_result_alert = (fieldLabel, out) => {
			const updated = (out?.updated || out?.deleted || []).length;
			const skipped = out?.skipped || [];
			const failed = out?.failed || [];
			if (!skipped.length && !failed.length) {
				frappe.show_alert({
					message: `${fieldLabel}: ${updated} travel date${updated === 1 ? '' : 's'} updated`,
					indicator: 'green' });
				return;
			}
			const li = (arr) => arr.map((x) =>
				`<li class="text-muted text-small"><span class="text-monospace">${esc(x.name)}</span> — ${esc(x.reason || '')}</li>`).join('');
			frappe.msgprint(`
				<p><strong>${esc(fieldLabel)}</strong>: ${updated} updated,
					${skipped.length} skipped, ${failed.length} failed.</p>
				${skipped.length ? `<div class="text-small text-muted mb-1">Skipped:</div><ul class="pl-3">${li(skipped)}</ul>` : ''}
				${failed.length ? `<div class="text-small text-muted mb-1">Failed:</div><ul class="pl-3">${li(failed)}</ul>` : ''}`);
		};

		// ══════════════ DIALOG BULK EDIT ══════════════
		// Corak po_bulk_edit_dialog (Package Offers): pilih medan → widget
		// nilai FieldGroup ikut fieldtype → Apply ke SEMUA tarikh dipilih.
		// Server (bulk_update_dates) memproses per rekod — updated/skipped/
		// failed dilaporkan; baris updated di-patch tempatan (tiada fetch).
		function tdd_bulk_edit_dialog() {
			const names = [...tddSel];
			const d = new frappe.ui.Dialog({
				title: `✏️ Bulk Edit — ${names.length} travel date${names.length > 1 ? 's' : ''}`,
			});
			d.$body.html(`
				<div class="tm-dd-bulk">
					<div class="text-muted text-small mb-1">Pilih medan untuk dikemas
						kini pada semua tarikh dipilih:</div>
					<select class="form-control tm-dd-bulk-field">
						<option value="">— Select Field —</option>
						${TDD_BULK_FIELDS.map((f) =>
							`<option value="${f.key}">${esc(f.label)}</option>`).join('')}
					</select>
					<div class="tm-dd-bulk-value" style="margin-top:10px;"></div>
					<div style="margin-top:10px;">
						<button type="button"
							class="btn btn-primary btn-sm tm-dd-bulk-apply" disabled>
							Apply to All</button>
					</div>
					<div class="text-muted text-small mt-2">Status Active/Cancelled
						memerlukan Tour Manager (gate server). Perubahan tarikh
						berlepas/pulang melalui dialog ✏️ per baris. Nilai kosong
						ditolak.</div>
				</div>`);
			let fg = null;
			const $val = d.$body.find('.tm-dd-bulk-value');
			const $apply = d.$body.find('.tm-dd-bulk-apply');
			const getSel = () => TDD_BULK_FIELDS.find(
				(f) => f.key === d.$body.find('.tm-dd-bulk-field').val());
			// Widget nilai ikut fieldtype medan dipilih — FieldGroup lama
			// dibuang (badan dikosongkan; instance diganti).
			const renderValue = () => {
				$val.empty(); fg = null;
				$apply.prop('disabled', true);
				const f = getSel();
				if (!f) return;
				fg = new frappe.ui.FieldGroup({
					fields: [{
						fieldtype: f.fieldtype, fieldname: 'bulk_value',
						label: f.label,
						options: Array.isArray(f.options)
							? f.options.join('\n') : f.options,
						reqd: 1,
					}],
					body: $val.get(0),
					// Enter TIDAK memicu aksi global Desk (trigger_primary_action).
					no_submit_on_enter: true,
				});
				fg.make();
				$apply.prop('disabled', false);
			};
			d.$body.find('.tm-dd-bulk-field').on('change', renderValue);

			$apply.on('click', async function () {
				const f = getSel();
				if (!f) return;
				let v = '';
				try {
					v = fg ? (fg.get_values(true)?.bulk_value ?? '') : '';
				} catch (e) {
					console.error('bulk edit get_values:', e);
					return;
				}
				if (v === '' || v == null) {
					frappe.show_alert({ message: 'Please enter a value',
						indicator: 'orange' });
					return;
				}
				const $btn = $(this).prop('disabled', true);
				try {
					const out = await api('bulk_update_dates', {
						dates: names, field: f.key, value: String(v) });
					d.hide();
					// Patch baris tempatan dgn nilai EFEKTIF daripada server —
					// status editorial tersimpan sebagai `status` pada baris
					// direktori (get_dates_directory alias).
					const vOut = out?.value != null ? String(out.value) : String(v);
					const rowKey = f.key === 'status_editorial' ? 'status' : f.key;
					(out?.updated || []).forEach((name) => {
						const row = tddRows.find((r) => r.name === name);
						if (row) row[rowKey] = vOut;
					});
					renderTddTable();
					tddRefreshMeta();
					tdd_bulk_result_alert(f.label, out);
				} catch (e) {
					// api() sudah papar alert ralat — benarkan cuba semula
					$btn.prop('disabled', false);
				}
			});
			d.show();
		}

		// ══════════════ BULK PADAM ══════════════
		// frappe.confirm dgn kiraan — server (bulk_delete_dates) mengekang
		// setiap tarikh dgn guard sama dgn padam tunggal (booking aktif /
		// pax terjual pada offer anak); guard gagal = skipped (+ sebab).
		// Offer anak ikut terpadam (offers_deleted dilaporkan). Baris
		// dipadam dibuang daripada tddRows (in-place — tmDataTable memegang
		// rujukan array yang sama).
		function tdd_bulk_delete_dialog() {
			const names = [...tddSel];
			frappe.confirm(
				`Padam <strong>${names.length}</strong> travel date terpilih
					beserta SEMUA offer di dalamnya? Tindakan ini
					<b>tidak boleh dibatalkan</b>.<br>
					<small class="text-muted">Tarikh yang masih dipaut booking
					aktif atau pax terjual akan dilangkau (skipped) dan
					dilaporkan.</small>`,
				() => {
					api('bulk_delete_dates', { dates: names }).then((out) => {
						const deleted = out?.deleted || [];
						const del = new Set(deleted);
						for (let i = tddRows.length - 1; i >= 0; i--)
							if (del.has(tddRows[i].name)) tddRows.splice(i, 1);
						deleted.forEach((n) => tddSel.delete(n));
						tddTotal = Math.max(tddRows.length, tddTotal - deleted.length);
						renderTddTable(); tddUpdateButtons(); tddRefreshMeta();
						tdd_bulk_result_alert('Delete', {
							updated: deleted,
							skipped: out?.skipped || [],
							failed: out?.failed || [] });
						if (out?.offers_deleted)
							frappe.show_alert({
								message: `${out.offers_deleted} offer ikut terpadam`,
								indicator: 'orange' });
					}).catch(() => { /* frappe already shows it */ });
				});
		}
