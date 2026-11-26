	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: PACKAGE OFFERS (tm_package_offers.js)
	   ════════════════════════════════════════════════════════════════════
	   Direktori SEMUA Package Offer aras-trip — sub-menu TRIP pada nav
	   travel-manager (Nov 2026): pantau & urus semua offer SEKALI gus
	   tanpa akses borang doctype.
	     /package-offers        → direktori (datatable: carian, penapis
	                               status + currency + jenis trip, penapis
	                               TRIP = input autocomplete 100% lebar
	                               (senarai cadangan penuh lebar), saiz
	                               halaman, pagination & sortable; baris
	                               DIKUMPUL ikut trip — header kumpulan
	                               COLLAPSIBLE (klik header / Collapse-
	                               Expand all), bukan kolum Trip;
	                               select-all + bulk edit/padam)
	   Status editorial = badge PAPARAN SAHAJA (arahan pemilik — tiada
	   dropdown inline); perubahan status melalui dialog ✏️ / bulk edit
	   (Active/Cancelled kekal manager-gated di server).
	   Tiada detail view sendiri — baris deep-link ke halaman admin offer
	   sedia ada (trip/<trip>/date/<date>/pkg/<offer>) & direktori trip.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, state, breadcrumb, esc, badge, C, card, tmDataTable,
	   isManager, webFmtLoad/webFmtDate, api) secara terus.
	   API AWAM: load_package_offers() (dipanggil router shell).
	   Backend: travel_booking.api.package_admin (helper `api` kongsi) —
	     get_offers_directory / save_offer_info / delete_package_offer /
	     bulk_update_offers / bulk_delete_offers.
	   Komponen: kad/card() stok Bootstrap, jadual tmDataTable() kongsi
	   (EXT {raw} header select-all + EXT groupOf/groupHeaderHtml utk
	   pengumpulan ikut trip), dialog frappe.ui.Dialog / frappe.prompt /
	   frappe.confirm + FieldGroup utk nilai bulk (corak
	   open_traveller_bulk_dialog) — tiada CSS baharu.
	   ════════════════════════════════════════════════════════════════════ */

		// ── Helper & konstanta seksyen ──
		// Status editorial doctype Package Offer (operational KEKAL
		// auto-job — tiada edit di sini). Active/Cancelled di-gate server
		// (_gate_status_change: Tour Manager/System Manager sahaja) —
		// disemak dalam dialog ✏️ & bulk edit, BUKAN badge paparan.
		const OFF_STATUSES = ['Draft', 'Active', 'Cancelled'];
		const OFF_SALE_MODES = ['Public', 'Group Block', 'Full Charter', 'Private'];
		// Katalog bulk edit — cermin OFFER_BULK_EDIT_FIELDS
		// (package_admin.py). offer_name: nama SAMA diletak pada semua
		// offer dipilih (menggantikan nama auto-jana "{trip} : {tarikh}"
		// — arahan pemilik); flight: Link → Flight (charter).
		const OFF_BULK_FIELDS = [
			{ key: 'currency', label: 'Currency',
				fieldtype: 'Link', options: 'Currency' },
			{ key: 'status_editorial', label: 'Editorial Status',
				fieldtype: 'Select', options: OFF_STATUSES },
			{ key: 'sale_mode', label: 'Sale Mode',
				fieldtype: 'Select', options: OFF_SALE_MODES },
			{ key: 'offer_name', label: 'Offer Name', fieldtype: 'Data',
				description: 'Nama SAMA diletak pada SEMUA offer dipilih — '
					+ 'menggantikan nama auto-jana "{trip} : {tarikh}".' },
			{ key: 'flight', label: 'Charter Flight',
				fieldtype: 'Link', options: 'Flight',
				description: 'Penerbangan charter offer — mesti rekod Flight '
					+ 'yang wujud (disemak di server).' },
		];
		// Kebenaran (selari gate server): tulis = Manager/Operator,
		// padam = Tour Manager/System Manager sahaja.
		const poCanWrite = isManager || frappe.user.has_role('Tour Operator');
		const poCanDelete = isManager;

		// Kunci kumpulan (groupOf/poCollapsed/pre-sort DUA aras — SATU
		// sumber): label trip; offer legasi TANPA trip diberi kumpulan
		// sentinel "__notrip__" ("Tanpa trip") supaya SEMUA baris ada
		// kumpulan yang boleh diruntuhkan/buka.
		const PO_NOTRIP = '__notrip__';
		const poGroupKey = (r) => r.trip_label || r.trip || PO_NOTRIP;

		// Baris senarai terkini + pilihan (Set) — rujukan handler
		// delegated (dikemaskini setiap load; handler dipasang SEKALI
		// di bawah — baris dirender semula oleh pagination/sort/search).
		let poRows = [];
		const poSel = new Set();
		const poCollapsed = new Set();  // trip kumpulan yang diruntuhkan
		let poDt = null;
		let poTotal = 0;  // jumlah rekod server (utk amaran cap & kiraan strip)

		// Strip ringkasan (counts) — dirender semula selepas setiap mutasi
		// supaya kekal seiring dgn poRows tanpa fetch semula.
		const poSummaryHtml = () => {
			const shown = poRows.length;
			const truncated = poTotal > shown;
			const bySt = (s) => poRows.filter(
				(r) => (r.status_editorial || 'Draft') === s).length;
			const soldTotal = poRows.reduce((n, r) => n + (r.sold_pax || 0), 0);
			return `
				<span class="text-nowrap"><strong class="text-body">${shown}</strong> offer${truncated ? ` daripada <strong>${poTotal}</strong>` : ''}</span>
				<span class="text-nowrap" style="color:${C.green}"><strong>${bySt('Active')}</strong> active</span>
				<span class="text-nowrap" style="color:${C.gray}"><strong>${bySt('Draft')}</strong> draft</span>
				<span class="text-nowrap" style="color:${C.red}"><strong>${bySt('Cancelled')}</strong> cancelled</span>
				<span class="text-nowrap"><strong>${soldTotal}</strong> pax sold</span>
				${truncated ? `<span class="text-nowrap" style="color:${C.orange}">⚠ paparan terhad ${shown} (cap 1000) — gunakan carian</span>` : ''}`;
		};
		// Kemas kini strip ringkasan + kiraan tajuk kad selepas mutasi.
		const poRefreshMeta = () => {
			$body.find('#tm-off-summary').html(poSummaryHtml());
			$body.find('#tm-off-count').text(poRows.length);
		};

		// Render semula jadual — tmDataTable.rerender jana semula
		// tbody (+thead) daripada poRows/poSel/poCollapsed — kemudian
		// selaras checkbox header & label butang collapse-all.
		const renderPoTable = () => {
			poDt?.rerender();
			poSyncSelAll();
			poUpdateCollapseBtn();
		};

		// Selaras checkbox select-all header dgn baris DIPAPAR semasa
		// (checked bila semua dipapar dipilih; indeterminate bila separa).
		// Baris kumpulan yang DIRUNTUHKAN (d-none) TIDAK dikira —
		// select-all hanya meliputi baris yang kelihatan.
		const poSyncSelAll = () => {
			const boxes = $body.find('.tm-off-sel').filter(':visible').toArray();
			const all = boxes.length > 0 && boxes.every((b) => b.checked);
			const some = boxes.some((b) => b.checked);
			$body.find('#tm-off-selall').prop({ checked: all, indeterminate: some && !all });
		};

		// Kemas kini label/keadaan butang bulk (toolbar atas).
		const poUpdateButtons = () => {
			const n = poSel.size;
			$body.find('#tm-off-bulk-edit').prop('disabled', !n)
				.text(n ? `✏️ Bulk Edit (${n})` : '✏️ Bulk Edit');
			$body.find('#tm-off-bulk-del').prop('disabled', !n)
				.text(n ? `🗑 Delete (${n})` : '🗑 Delete');
		};

		// Label butang Collapse/Expand all — ikut keadaan poCollapsed
		// (semua kumpulan diruntuhkan → tawar Expand all).
		const poUpdateCollapseBtn = () => {
			const keys = [...new Set(poRows.map(poGroupKey))];
			const all = keys.length > 0 && keys.every((k) => poCollapsed.has(k));
			$body.find('#tm-off-collapse-all').text(all ? '⤢ Expand all' : '⤡ Collapse all');
		};

		// Badge status editorial — PAPARAN SAHAJA (arahan pemilik: bukan
		// dropdown editable). Perubahan status melalui dialog ✏️ / bulk
		// edit — gate Tour Manager disemak di server.
		const poStatusBadge = (o) => {
			const st = o.status_editorial || 'Draft';
			const color = st === 'Active' ? C.green
				: st === 'Cancelled' ? C.red : C.gray;
			return badge(st, color);
		};

		// ── Baris header kumpulan (ikut trip) — EXT groupHeaderHtml
		// tmDataTable: caret runtuh/buka + trip sebagai pautan direktori +
		// flag Cruise + bilangan offer DLM senarai terfilter. Offer legasi
		// tanpa trip → kumpulan "Tanpa trip" (juga collapsible). Klik
		// mana-mana pada baris header = runtuh/buka (KECUALI klik pautan
		// trip — kekal navigasi). colspan = 7 kolum (checkbox | Travel
		// Date | Offer | Currency | Status | Sold | aksi).
		const poGroupHeaderHtml = (g, firstRow, count) => `
			<tr class="tm-off-group table-light" data-trip="${esc(g)}"
				title="Klik untuk runtuh/buka kumpulan trip ini">
				<td colspan="7">
					<span class="tm-off-grp-caret text-muted"
						aria-hidden="true">${poCollapsed.has(g) ? '▸' : '▾'}</span>
					${firstRow.trip
						? `<a href="javascript:void(0)"
							class="tm-off-trip font-weight-bold"
							data-trip="${esc(firstRow.trip)}">${esc(firstRow.trip_label || firstRow.trip)}</a>
							<span class="text-muted text-small text-monospace">${esc(firstRow.trip)}</span>`
						: '<strong class="text-muted">Tanpa trip</strong>'}
					${firstRow.trip && firstRow.is_a_cruise_trip
						? ` ${badge('Cruise', C.blue)}` : ''}
					<span class="text-muted text-small ml-2">${count} offer${count === 1 ? '' : 's'}</span>
				</td>
			</tr>`;

		// ── Baris jadual direktori (tmDataTable rowHtml) — Trip dipaparkan
		// sbg HEADER KUMPULAN (arahan pemilik), bukan kolum. Baris trip
		// yang diruntuhkan diberi d-none (poCollapsed kekal merentas
		// render — carian/penapis/sort/pagination). ──
		const poRowHtml = (o) => `
			<tr class="tm-off-row${poCollapsed.has(poGroupKey(o)) ? ' d-none' : ''}"
				data-name="${esc(o.name)}">
				<td class="text-center"><input type="checkbox" class="tm-off-sel"
					data-name="${esc(o.name)}" ${poSel.has(o.name) ? 'checked' : ''}
					title="Pilih offer utk bulk edit/padam"/></td>
				<td class="text-nowrap">
					<div class="font-weight-bold">${esc(webFmtDate(o.departure_date))}</div>
					<div class="text-muted text-small text-monospace">${esc(o.travel_date || '—')}</div>
				</td>
				<td>
					${o.travel_date ? `<a href="javascript:void(0)"
						class="tm-off-open font-weight-bold"
						data-trip="${esc(o.trip || '')}" data-date="${esc(o.travel_date)}"
						data-offer="${esc(o.name)}">${esc(o.offer_name || o.name)}</a>`
					: `<span class="font-weight-bold">${esc(o.offer_name || o.name)}</span>`}
					<div class="text-muted text-small text-monospace">${esc(o.name)}</div>
				</td>
				<td class="text-nowrap">${esc(o.currency || 'MYR')}</td>
				<td>${poStatusBadge(o)}</td>
				<td class="text-center"><strong>${o.sold_pax ?? 0}</strong></td>
				<td class="text-nowrap text-right">
					${poCanWrite ? `<button type="button"
						class="btn btn-xs btn-default tm-off-edit"
						data-name="${esc(o.name)}" title="Edit offer">✏️</button>` : ''}
					${poCanDelete ? `<button type="button"
						class="btn btn-xs btn-danger tm-off-del"
						data-name="${esc(o.name)}" title="Padam offer">🗑</button>` : ''}
				</td>
			</tr>`;

		// ── Handler delegated (SEKALI sahaja — baris jadual dirender semula
		// oleh pagination/sort/search tmDataTable, jadi delegasi pada $body) ──
		$body.on('change', '.tm-off-sel', function () {
			const name = $(this).data('name');
			if (this.checked) poSel.add(name); else poSel.delete(name);
			poSyncSelAll(); poUpdateButtons();
		});
		// Select-all header — meliputi baris DIPAPAR semasa sahaja
		// (carian/penapis/kumpulan diruntuhkan tetap dihormati).
		$body.on('click', '#tm-off-selall', function () {
			const checked = this.checked;
			$body.find('.tm-off-sel').filter(':visible').each(function () {
				this.checked = checked;
				const name = $(this).data('name');
				if (checked) poSel.add(name); else poSel.delete(name);
			});
			poUpdateButtons();
		});
		// Re-sync header checkbox selepas re-render dalaman tmDataTable
		// (carian/penapis/sort/pagination — event bubble ke $body).
		$body.on('click input change', '.tm-dt-page, .tm-dt-sortable, .tm-dt-size, .tm-dt-search, .tm-dt-mf, .tm-dt-filter',
			() => setTimeout(poSyncSelAll, 0));
		// Trip → direktori trip; nama offer → halaman admin offer.
		$body.on('click', '.tm-off-trip', function (e) {
			e.stopPropagation();
			frappe.set_route('travel-manager', 'trip', $(this).data('trip'));
		});
		// Runtuh/buka kumpulan trip — klik pada baris header kumpulan
		// (klik pautan trip KECUALI — kekal navigasi). Keadaan dalam
		// poCollapsed kekal merentas render; baris kumpulan diberi d-none
		// dalam rowHtml.
		$body.on('click', '.tm-off-group', function (e) {
			if ($(e.target).closest('.tm-off-trip').length) return;
			const trip = $(this).data('trip');
			if (!trip) return;
			if (poCollapsed.has(trip)) poCollapsed.delete(trip);
			else poCollapsed.add(trip);
			renderPoTable();
		});
		// Collapse/Expand SEMUA kumpulan (butang toolbar atas) — termasuk
		// kumpulan "Tanpa trip" (legasi).
		$body.on('click', '#tm-off-collapse-all', () => {
			const keys = [...new Set(poRows.map(poGroupKey))];
			if (keys.length && keys.every((k) => poCollapsed.has(k)))
				poCollapsed.clear();
			else
				keys.forEach((k) => poCollapsed.add(k));
			renderPoTable();
		});
		$body.on('click', '.tm-off-open', function (e) {
			e.stopPropagation();
			const $a = $(this);
			if (!$a.data('trip') || !$a.data('date')) return;
			frappe.set_route('travel-manager', 'trip', $a.data('trip'),
				'date', $a.data('date'), 'pkg', $a.data('offer'));
		});
		// Status badge = paparan sahaja — tiada handler inline (perubahan
		// status melalui dialog ✏️ / bulk edit, gate di server).
		// Edit dialog / padam per baris.
		$body.on('click', '.tm-off-edit', function (e) {
			e.stopPropagation();
			const row = poRows.find((r) => r.name === $(this).data('name'));
			if (row) po_edit_dialog(row);
		});
		$body.on('click', '.tm-off-del', function (e) {
			e.stopPropagation();
			const name = $(this).data('name');
			if (name) po_delete_dialog(name);
		});
		// Butang bulk (toolbar atas) — label/keadaan dikemas kini
		// poUpdateButtons().
		$body.on('click', '#tm-off-bulk-edit', () => { if (poSel.size) po_bulk_edit_dialog(); });
		$body.on('click', '#tm-off-bulk-del', () => { if (poSel.size) po_bulk_delete_dialog(); });

		// ══════════════ PACKAGE OFFERS (direktori aras-trip) ══════════════
		async function load_package_offers() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'Package Offers' },
			]);
			$body.html(loading());
			await webFmtLoad();

			const data = await api('get_offers_directory', { limit: 1000 });
			poRows = data?.offers || [];
			poSel.clear();
			poCollapsed.clear();
			poDt = null;
			// Susunan lalai DIKUMPUL ikut trip (arahan pemilik): trip naik
			// ikut nama (kunci = poGroupKey), offer dlm trip ikut tarikh
			// berangkat. Sort kolum (klik header) hanya menyusun DALAM
			// kumpulan (EXT groupOf).
			poRows.sort((a, b) =>
				poGroupKey(a) < poGroupKey(b) ? -1
				: poGroupKey(a) > poGroupKey(b) ? 1
				: String(a.departure_date || '').localeCompare(String(b.departure_date || '')));
			const shown = poRows.length;
			poTotal = parseInt(data?.total, 10) || shown;

			$body.html(`
				<div class="d-flex flex-wrap gap-2 align-items-center text-muted mb-3">
					<div class="d-flex gap-2 overflow-auto py-1" id="tm-off-summary"
						aria-label="Ringkasan offers">${poSummaryHtml()}</div>
					<div class="d-flex gap-2 ml-auto">
						${shown ? `<button type="button"
							class="btn btn-outline-secondary btn-sm"
							id="tm-off-collapse-all">⤡ Collapse all</button>` : ''}
						${poCanWrite ? `<button type="button"
							class="btn btn-primary btn-sm" id="tm-off-bulk-edit"
							disabled>✏️ Bulk Edit</button>` : ''}
						${poCanDelete ? `<button type="button"
							class="btn btn-outline-danger btn-sm" id="tm-off-bulk-del"
							disabled>🗑 Delete</button>` : ''}
					</div>
				</div>
				${card(12, `📦 PACKAGE OFFERS <span class="text-muted">(<span id="tm-off-count">${shown}</span>${poTotal > shown ? ` / ${poTotal}` : ''})</span>`, `
					<div id="tm-offers-dt"></div>`)}
			`);

			// Jadual interaktif kongsi: carian + penapis (status, currency,
			// jenis trip, trip, travel date) + sortable + pagination dalam
			// card-footer (footer: true). Baris DIKUMPUL ikut trip —
			// header kumpulan disisipkan tmDataTable (EXT groupOf).
			poDt = tmDataTable('#tm-offers-dt', poRows, {
				footer: true,
				pageSize: 10,
				pageSizeOptions: [10, 25, 50, 100],
				pageSizesLabel: 'Per page',
				headers: [
					// EXT {raw} — HTML mentah (checkbox select-all header).
					{ raw: `<input type="checkbox" id="tm-off-selall"
						title="Pilih semua baris dipaparkan"/>` },
					'Travel Date', 'Package Offer', 'Currency',
					'Status', { text: 'Sold', cls: 'text-center' }, '',
				],
				rowHtml: poRowHtml,
				// EXT pengumpulan: trip = kunci kumpulan (poGroupKey —
				// legasi tanpa trip → kumpulan "Tanpa trip"); header
				// kumpulan (caret + nama trip + flag Cruise + bil. offer)
				// menggantikan kolum Trip.
				groupOf: (r) => poGroupKey(r),
				groupHeaderHtml: (g, firstRow, count) =>
					poGroupHeaderHtml(g, firstRow, count),
				searchIn: (r) => [r.name, r.offer_name, r.trip_label, r.trip,
					r.travel_date, r.currency].join(' '),
				searchPlaceholder: 'Search offer / trip / date / currency…',
				emptyMsg: 'No package offers yet — offers are created from a '
					+ 'Travel Date page ("Add Offer").',
				filters: [
					{ key: 'status', label: 'All statuses',
						of: (r) => r.status_editorial || 'Draft' },
					{ key: 'currency', label: 'All currencies',
						of: (r) => r.currency || '' },
					{ key: 'cruise', label: 'All trip types',
						of: (r) => r.is_a_cruise_trip ? 'Cruise' : 'Non-Cruise' },
					// trip = select TERSEMBUNYI — dikawal input autocomplete
					// 100% lebar (blok bawah).
					{ key: 'trip', label: 'All trips',
						of: (r) => r.trip_label || r.trip || '—' },
				],
				sortable: [
					null,
					{ key: 'date', val: (r) => r.departure_date || '' },
					{ key: 'offer', val: (r) => (r.offer_name || r.name || '').toLowerCase() },
					{ key: 'currency', val: (r) => r.currency || '' },
					{ key: 'status', val: (r) => OFF_STATUSES.indexOf(r.status_editorial || 'Draft') },
					{ key: 'sold', val: (r) => r.sold_pax || 0 },
					null,
				],
			});
			poUpdateButtons();
			poUpdateCollapseBtn();
			poSyncSelAll();

			// ── Penapis TRIP: input autocomplete 100% lebar (arahan
			// pemilik, Nov 2026) — select trip sedia ada DISEMBUNYIKAN
			// tetapi kekal sebagai sumber keadaan penapis (trigger
			// change → st.mf tmDataTable), input hanya kulit UI yang
			// lebih baik: senarai cadangan penuh lebar (nama trip + ID +
			// badge Cruise + bil. offer), navigasi keyboard, butang ✕. ──
			const $tripSel = $body.find('#tm-offers-dt .tm-dt-mf[data-key="trip"]');
			$tripSel.addClass('d-none');
			// Satu opsyen per kumpulan trip — susun ikut label; kiraan
			// offer per kumpulan diira sekali.
			const tripOpts = [...new Map(poRows.map((r) => [poGroupKey(r), {
				key: poGroupKey(r),
				label: r.trip_label || r.trip || '—',
				id: r.trip || '',
				cruise: !!r.is_a_cruise_trip,
				count: 0,
			}])).values()].sort((a, b) =>
				a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1);
			tripOpts.forEach((t) => {
				t.count = poRows.filter((r) => poGroupKey(r) === t.key).length;
			});
			let poTripLabel = '';  // label trip dipilih (utk restore input)

			const $tripWrap = $(`
				<div class="tm-off-trip-wrap position-relative w-100 mt-1">
					<div class="input-group input-group-sm">
						<input type="text" autocomplete="off"
							class="form-control tm-off-trip-input"
							placeholder="Filter by trip — taip untuk cari nama / ID trip…"
							aria-label="Filter by trip">
						<div class="input-group-append">
							<button type="button"
								class="btn btn-outline-secondary tm-off-trip-clear d-none"
								title="Buang penapis trip">✕</button>
						</div>
					</div>
					<div class="dropdown-menu tm-off-trip-list w-100"
						role="listbox" aria-label="Trip options"></div>
				</div>`);
			$body.find('#tm-offers-dt .tm-dt-toolbar').append($tripWrap);
			const $tripInput = $tripWrap.find('.tm-off-trip-input');
			const $tripList = $tripWrap.find('.tm-off-trip-list');
			const $tripClear = $tripWrap.find('.tm-off-trip-clear');

			// Senarai cadangan — ditapis ikut teks (nama ATAU ID trip);
			// setiap item = baris penuh lebar (dropdown-item = block 100%).
			const tripRenderList = (q) => {
				const qq = (q || '').toLowerCase();
				const matches = tripOpts.filter((t) => !qq
					|| t.label.toLowerCase().includes(qq)
					|| t.id.toLowerCase().includes(qq));
				$tripList.html(matches.length ? matches.map((t, i) => `
					<button type="button" role="option" aria-selected="false"
						class="dropdown-item tm-off-trip-opt${i === 0 ? ' active' : ''}"
						data-label="${esc(t.label)}">
						${t.label === '—'
							? '<strong class="text-muted">Tanpa trip</strong>'
							: `<span class="font-weight-bold">${esc(t.label)}</span>`}
						${t.id ? `<span class="text-muted text-small text-monospace">${esc(t.id)}</span>` : ''}
						${t.cruise ? ` ${badge('Cruise', C.blue)}` : ''}
						<span class="text-muted text-small ml-2">${t.count} offer${t.count === 1 ? '' : 's'}</span>
					</button>`).join('')
				: '<div class="dropdown-item text-muted text-small">Tiada trip sepadan.</div>');
				$tripList.addClass('show');
			};
			const tripCloseList = () => $tripList.removeClass('show');
			// Guna label sbg nilai penapis (nilai opsyen select = label).
			const tripApply = (label) => {
				poTripLabel = label || '';
				$tripInput.val(poTripLabel);
				$tripClear.toggleClass('d-none', !poTripLabel);
				tripCloseList();
				$tripSel.val(poTripLabel).trigger('change');
			};
			$tripInput.on('focus input', function () {
				tripRenderList($(this).val());
			});
			$tripInput.on('keydown', function (e) {
				const $items = $tripList.find('.tm-off-trip-opt');
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					if (!$items.length) return;
					let idx = $items.index($tripList.find('.tm-off-trip-opt.active'));
					idx = e.key === 'ArrowDown'
						? Math.min(idx + 1, $items.length - 1)
						: Math.max(idx - 1, 0);
					$items.removeClass('active');
					$items.eq(idx).addClass('active');
					return;
				}
				if (e.key === 'Enter') {
					e.preventDefault();
					$tripList.find('.tm-off-trip-opt.active')
						.trigger('mousedown');
					return;
				}
				if (e.key === 'Escape') {
					tripCloseList();
					$tripInput.val(poTripLabel);
				}
			});
			// mousedown (bukan click) — berlaku SEBELUM blur input, jadi
			// pilihan sempat dimohon dan preventDefault kekalkan fokus.
			$tripList.on('mousedown', '.tm-off-trip-opt', function (e) {
				e.preventDefault();
				tripApply($(this).data('label'));
			});
			$tripInput.on('blur', function () {
				// Lewat kecil — mousedown opsyen sempat berlaku dulu;
				// pulihkan teks ke pilihan semasa.
				setTimeout(() => {
					tripCloseList();
					$tripInput.val(poTripLabel);
				}, 150);
			});
			$tripClear.on('click', () => {
				tripApply('');
				$tripInput.focus();
			});
		}

		// ══════════════ DIALOG EDIT OFFER ══════════════
		// Identiti offer: nama (auto-jana, boleh diperibadikan), currency &
		// status editorial — satu endpoint save_offer_info. Status TIDAK
		// dihantar bila tidak berubah — elak gate Tour Manager gagal utk
		// Operator yang edit medan lain (corak sama dgn travel_date_dialog).
		function po_edit_dialog(o) {
			const curStatus = o.status_editorial || 'Draft';
			const d = new frappe.ui.Dialog({
				title: `✏️ Edit Offer — ${o.name}`,
				fields: [
					{ fieldname: 'offer_name', fieldtype: 'Data',
						label: 'Offer Name', default: o.offer_name || '',
						description: 'Auto-jana "{trip} : {tarikh}" — boleh diperibadikan.' },
					{ fieldname: 'currency', fieldtype: 'Link',
						options: 'Currency', label: 'Currency',
						reqd: 1, default: o.currency || 'MYR' },
					{ fieldname: 'status_editorial', fieldtype: 'Select',
						label: 'Editorial Status',
						options: OFF_STATUSES.join('\n'), default: curStatus,
						description: 'Active/Cancelled perlukan Tour Manager '
							+ '(disemak di server).' },
				],
				primary_action_label: '💾 Simpan',
				primary_action: (values) => {
					const args = {
						offer: o.name,
						offer_name: (values.offer_name || '').trim(),
						currency: (values.currency || '').trim(),
					};
					if ((values.status_editorial || '') !== curStatus)
						args.status_editorial = values.status_editorial;
					const $btn = d.get_primary_btn().prop('disabled', true);
					api('save_offer_info', args).then(() => {
						d.hide();
						// Patch baris tempatan + render semula (tiada fetch).
						if (args.offer_name) o.offer_name = args.offer_name;
						if (args.currency) o.currency = args.currency;
						if (args.status_editorial) o.status_editorial = args.status_editorial;
						renderPoTable();
						poRefreshMeta();
						frappe.show_alert({
							message: `Offer ${o.name} disimpan`, indicator: 'green' });
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.show();
		}

		// ══════════════ DIALOG PADAM OFFER (per baris) ══════════════
		// Corak trip/addon: taip nama penuh untuk sahkan. Server menyekat
		// pemadaman bila offer masih dipaut booking aktif / pax terjual —
		// mesej sebab dipaparkan frappe.
		function po_delete_dialog(name) {
			frappe.prompt(
				[{
					fieldname: 'confirm_name', fieldtype: 'Data', reqd: 1,
					label: `Taip <strong>${esc(name)}</strong> untuk sahkan pemadaman`,
					description: `Offer <strong>${esc(name)}</strong> dipadam
						selama-lamanya. Pemadaman DISEKAT bila masih ada booking
						aktif atau pax terjual — mesej sistem menyatakan sebabnya.`,
				}],
				(values) => {
					if ((values.confirm_name || '').trim() !== name) {
						frappe.msgprint('Nama offer tidak sepadan — pemadaman dibatalkan.');
						return;
					}
					api('delete_package_offer', { offer: name }).then(() => {
						const idx = poRows.findIndex((r) => r.name === name);
						if (idx > -1) poRows.splice(idx, 1);
						poSel.delete(name);
						poTotal = Math.max(poRows.length, poTotal - 1);
						renderPoTable(); poUpdateButtons(); poRefreshMeta();
						frappe.show_alert({ message: `Offer ${name} dipadam`,
							indicator: 'red' });
					}).catch(() => { /* frappe already shows it */ });
				},
				__('🗑 Delete Offer — tidak boleh dibatalkan'),
			);
		}

		// Ringkasan hasil bulk — alert ringkas bila bersih; msgprint dgn
		// senarai sebab bila ada skipped/failed.
		const po_bulk_result_alert = (fieldLabel, out) => {
			const updated = (out?.updated || []).length;
			const skipped = out?.skipped || [];
			const failed = out?.failed || [];
			if (!skipped.length && !failed.length) {
				frappe.show_alert({
					message: `${fieldLabel}: ${updated} offer${updated === 1 ? '' : 's'} updated`,
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
		// Corak open_traveller_bulk_dialog (manage_booking_app): pilih
		// medan → widget nilai FieldGroup ikut fieldtype → Apply ke SEMUA
		// offer dipilih. Server (bulk_update_offers) memproses per rekod —
		// updated/skipped/failed dilaporkan; baris updated di-patch
		// tempatan (tiada fetch semula).
		function po_bulk_edit_dialog() {
			const names = [...poSel];
			const d = new frappe.ui.Dialog({
				title: `✏️ Bulk Edit — ${names.length} offer${names.length > 1 ? 's' : ''}`,
			});
			d.$body.html(`
				<div class="tm-off-bulk">
					<div class="text-muted text-small mb-1">Pilih medan untuk dikemas
						kini pada semua offer dipilih:</div>
					<select class="form-control tm-off-bulk-field">
						<option value="">— Select Field —</option>
						${OFF_BULK_FIELDS.map((f) =>
							`<option value="${f.key}">${esc(f.label)}</option>`).join('')}
					</select>
					<div class="tm-off-bulk-value" style="margin-top:10px;"></div>
					<div style="margin-top:10px;">
						<button type="button"
							class="btn btn-primary btn-sm tm-off-bulk-apply" disabled>
							Apply to All</button>
					</div>
					<div class="text-muted text-small mt-2">Status Active/Cancelled
						memerlukan Tour Manager (gate server). Nilai kosong ditolak.</div>
				</div>`);
			let fg = null;
			const $val = d.$body.find('.tm-off-bulk-value');
			const $apply = d.$body.find('.tm-off-bulk-apply');
			const getSel = () => OFF_BULK_FIELDS.find(
				(f) => f.key === d.$body.find('.tm-off-bulk-field').val());
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
						description: f.description || undefined,
						reqd: 1,
					}],
					body: $val.get(0),
					// Enter TIDAK memicu aksi global Desk (trigger_primary_action).
					no_submit_on_enter: true,
				});
				fg.make();
				$apply.prop('disabled', false);
			};
			d.$body.find('.tm-off-bulk-field').on('change', renderValue);

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
					const out = await api('bulk_update_offers', {
						offers: names, field: f.key, value: String(v) });
					d.hide();
					// Patch baris tempatan dgn nilai EFEKTIF daripada server.
					const vOut = out?.value != null ? String(out.value) : String(v);
					(out?.updated || []).forEach((name) => {
						const row = poRows.find((r) => r.name === name);
						if (row) row[f.key] = vOut;
					});
					renderPoTable();
					poRefreshMeta();
					po_bulk_result_alert(f.label, out);
				} catch (e) {
					// api() sudah papar alert ralat — benarkan cuba semula
					$btn.prop('disabled', false);
				}
			});
			d.show();
		}

		// ══════════════ BULK PADAM ══════════════
		// frappe.confirm dgn kiraan — server (bulk_delete_offers) mengekang
		// setiap offer dgn guard sama dgn padam tunggal (booking aktif /
		// pax terjual); guard gagal = skipped (+ sebab). Baris dipadam
		// dibuang daripada poRows (in-place — tmDataTable memegang rujukan
		// array yang sama).
		function po_bulk_delete_dialog() {
			const names = [...poSel];
			frappe.confirm(
				`Padam <strong>${names.length}</strong> offer terpilih? Tindakan ini
					<b>tidak boleh dibatalkan</b>.<br>
					<small class="text-muted">Offer yang masih dipaut booking aktif
					atau pax terjual akan dilangkau (skipped) dan dilaporkan.</small>`,
				() => {
					api('bulk_delete_offers', { offers: names }).then((out) => {
						const deleted = out?.deleted || [];
						const del = new Set(deleted);
						for (let i = poRows.length - 1; i >= 0; i--)
							if (del.has(poRows[i].name)) poRows.splice(i, 1);
						deleted.forEach((n) => poSel.delete(n));
						poTotal = Math.max(poRows.length, poTotal - deleted.length);
						renderPoTable(); poUpdateButtons(); poRefreshMeta();
						po_bulk_result_alert('Delete', {
							updated: deleted,
							skipped: out?.skipped || [],
							failed: out?.failed || [] });
					}).catch(() => { /* frappe already shows it */ });
				});
		}
