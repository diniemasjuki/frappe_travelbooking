	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRAVEL DATE & PACKAGE ADMIN (tm_package_admin.js)
	   ════════════════════════════════════════════════════════════════════
	   Admin peringkat TRIP >> TRAVEL DATE >> PACKAGE OFFER —
	   default products & components, price matrix (import/markup),
	   page tabs v3 (Info/Prices/Config), elemen tambahan, produk &
	   komponen, kad itinerary, modal Travel Date penuh.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_travel_package_admin() (router),
	   default_components_dialog(), travel_date_dialog(),
	   cruise_schedule hookup & autocomplete add-row.
	   ════════════════════════════════════════════════════════════════════ */

		// ── TRAVEL DATE (hierarki ERD: Trip >> Travel Date >> Packages) ──
		// ── DEFAULT PRODUCTS & COMPONENTS (peringkat TRIP — hierarki ERD) ──
		// Editor senarai Trip.default_components: pra-isi pakej baharu.
		// cruise_tour auto-link trip; flight → Link Flight; activity/
		// merchandise → Link Item (ERPNext product).
		function default_components_dialog(trip, links, onDone) {
			const rows = (links?.default_components || []).map((r) => ({
				type: r.component_type,
				ref: r.trip || r.flight || r.component_item || '',
				for: r.age_option || '',
				mode: r.selection_mode || 'customer_pick',
				qty: r.qty || 1,
				mandatory: !!r.mandatory,
			}));
			const TYPES = ['cruise_tour', 'flight', 'activity', 'merchandise'];
			const AGES = ['', 'ADULT', 'CHILD', 'INFANT', 'TODDLER'];
			const MODES = ['fixed', 'customer_pick', 'optional'];
			const d = new frappe.ui.Dialog({
				title: 'Default Products & Components — ' + trip, size: 'large',
			});
			function renderRows() {
				d.$body.find('.tm-dc-rows').html(rows.map((r, i) => `
					<tr>
						<td><select class="form-control form-control-sm tm-dc-type" data-i="${i}">
							${TYPES.map((t) => `<option value="${t}" ${r.type === t ? 'selected' : ''}>${t}</option>`).join('')}
						</select></td>
						<td><input class="form-control form-control-sm tm-dc-ref" data-i="${i}" list="tm-dc-ref-list"
							value="${esc(r.ref)}" placeholder="Flight / Item"></td>
						<td><select class="form-control form-control-sm tm-dc-age" data-i="${i}">
							${AGES.map((a) => `<option value="${a}" ${r.for === a ? 'selected' : ''}>${a || 'General'}</option>`).join('')}
						</select></td>
						<td><select class="form-control form-control-sm tm-dc-mode" data-i="${i}">
							${MODES.map((m) => `<option value="${m}" ${r.mode === m ? 'selected' : ''}>${m}</option>`).join('')}
						</select></td>
						<td><input class="form-control form-control-sm tm-dc-qty" data-i="${i}" type="number" min="1"
							value="${r.qty}"></td>
						<td class="text-center"><input type="checkbox" class="tm-dc-req" data-i="${i}"
							${r.mandatory ? 'checked' : ''}></td>
						<td><button class="btn btn-xs btn-danger tm-dc-del" data-i="${i}">✕</button></td>
					</tr>`).join('') || `<tr><td colspan="7" class="text-muted text-center p-3">
						Tiada baris — komponen default menentukan pra-isi pakej baharu.</td></tr>`);
			}
			d.$body.html(`
				<p class="text-muted small mb-2">
					Senarai ini di-<strong>copy</strong> ke setiap pakej baharu trip ini semasa wizard
					(kemudian boleh diubah per pakej). Tidak menjejaskan pakej sedia ada.</p>
				<table id="tm-dc-table" class="table table-sm mb-0">
					<thead><tr><th>Type</th><th style="width:240px">Reference</th><th>For</th>
						<th>Selection</th><th>Qty</th><th class="text-center">Required</th><th></th></tr></thead>
					<tbody class="tm-dc-rows"></tbody>
				</table>
				<datalist id="tm-dc-ref-list"></datalist>
				<button class="btn btn-sm btn-default tm-dc-add mt-2">+ Component</button>
			`);
			renderRows();
			// Datalist cadangan: Item aktif untuk activity/merchandise.
			tlinks('list_component_items', { limit: 100 }).then((r) => {
				const items = (Array.isArray(r) ? r : (r?.message || [])).map((it) =>
					`<option value="${esc(it.name)}">${esc(it.item_name || '')}</option>`).join('');
				d.$body.find('#tm-dc-ref-list').html(items);
			}).catch(() => {});
			d.$body.find('.tm-dc-rows').on('change', 'select,input', function () {
				const i = $(this).data('i');
				const cls = $(this).attr('class') || '';
				if (cls.includes('tm-dc-type')) rows[i].type = $(this).val();
				if (cls.includes('tm-dc-ref')) rows[i].ref = $(this).val().trim();
				if (cls.includes('tm-dc-age')) rows[i].for = $(this).val();
				if (cls.includes('tm-dc-mode')) rows[i].mode = $(this).val();
				if (cls.includes('tm-dc-qty')) rows[i].qty = parseInt($(this).val() || 1, 10) || 1;
				if (cls.includes('tm-dc-req')) rows[i].mandatory = $(this).is(':checked');
			});
			d.$body.find('.tm-dc-rows').on('click', '.tm-dc-del', function () {
				rows.splice($(this).data('i'), 1);
				renderRows();
			});
			d.$body.find('.tm-dc-add').on('click', () => {
				rows.push({ type: 'activity', ref: '', for: '', mode: 'customer_pick', qty: 1, mandatory: 1 });
				renderRows();
			});
			d.set_primary_action(__('Save Defaults'), async () => {
				const payload = rows.map((r) => {
					const base = {
						age_option: r.for,
						selection_mode: r.mode,
						qty: r.qty,
						mandatory: r.mandatory ? 1 : 0,
					};
					if (r.type === 'flight') return { component_type: 'flight', flight: r.ref, ...base };
					if (r.type === 'cruise_tour') return { component_type: 'cruise_tour', trip, ...base };
					return { component_type: r.type, component_item: r.ref, ...base };
				});
				try {
					await tlinks('save_trip_default_components', {
						trip, components: JSON.stringify(payload) });
					frappe.show_alert({ message: 'Default components saved', indicator: 'green' });
					d.hide();
					onDone && onDone();
				} catch (e) { /* frappe already shows it */ }
			});
			d.show();
		}

		// [BUANG Nov 2026] link_schedule_dialog (Seksyen 1 — SAMBUNGAN
		// CRUISE SCHEDULE) — butang Change/Link Cruise Schedule pada kad
		// GROUP INFO dibuang (arahan pemilik); sambungan schedule diurus
		// dalam travel_date_dialog (Selected Cruise Schedule).

		// ── HALAMAN ADMIN PAKEJ (Trip > Date > Package) — Seksyen 2 ──
		// Urus: payment terms + price matrix (extract/import daripada Trip
		// Price Category / kategori kadar schedule) + senarai komponen
		// produk. TIADA inventori (kuota kabin di peringkat tarikh).
		// Tab aktif halaman pakej — kekal antara reload (save/add/import)
		// dalam sesi SPA; reset ke Package Info bila desk dimuat semula.
		let pkgActiveTab = 'info';

		async function load_travel_package_admin(trip, dateName, offerName,
												pkgName) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: trip, route: ['travel-manager', 'trip', trip] },
				{ label: 'Date', route: ['travel-manager', 'trip', trip, 'date', dateName] },
				{ label: pkgName || '…' },
			]);
			$body.html(loading());

			// Format paparan tarikh Travel Website (baris Departure → Return
			// kad PACKAGE INFO).
			await webFmtLoad();
			const data = await api('get_offer_package_admin',
				{ travel_date: dateName, offer: offerName });
			const o = data.offer || {};
			// [Rombakan Nov 2026] BASE (price_matrix — Room Category) dan
			// ADDONS (addon_price_matrix — Flight/Hotel/Transport/Meal)
			// dipisahkan; total = base + Σ addons.
			const pmtx = data.price_matrix || [];
			const amtx = data.addon_matrix || [];
			const comps = data.components || [];
			// [BUANG Nov 2026] sumber package_template — Trip Price
			// Category hanya definisi/profil rooming, bukan harga pakej.
			const srcS = data.price_sources?.schedule_rates || [];

			// Navigasi prev/next: senarai offer sejadi tarikh ini (nama +
			// nama_tawaran + mata wang) — dikira kedudukan offer semasa.
			const offersList = (await api('get_offers_list',
				{ travel_date: dateName, upcoming: 0, limit: 200 }))?.offers || [];
			const idx = offersList.findIndex((x) => x.name === offerName);
			const prevOffer = idx > 0 ? offersList[idx - 1] : null;
			const nextOffer = (idx >= 0 && idx < offersList.length - 1)
				? offersList[idx + 1] : null;
			const goOffer = (off) => frappe.set_route(
				'travel-manager', 'trip', trip, 'date', dateName, 'pkg', off.name);

			// Breadcrumb muktamad: nama pakej penuh.
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: trip, route: ['travel-manager', 'trip', trip] },
				{ label: 'Date', route: ['travel-manager', 'trip', trip, 'date', dateName] },
				{ label: o.package_name || pkgName },
			]);

			// ── PANEL 1: PACKAGE INFO (susun atur Nov 2026 — grid Bootstrap):
			// Kolum 1 = Offer Name (h3 UPPERCASE, line-height 1.3) + 2 baris
			// konteks kecil-bold (Trip Name + ikon Cruise/Tour · Departure →
			// Return — ganti kad TRIP INFORMATION/GROUP INFO yang dibuang)
			// → Package ID / Editorial Status / Operational Status (col-lg-4
			// x3); Kolum 2 (col-auto) = Currency — bendera atas, kod mata
			// wang BAWAHNYA (asset /assets/frappe/images/flags/<iso>.svg).
			const CUR_FLAG = { MYR: 'my', SGD: 'sg', USD: 'us', GBP: 'gb',
				THB: 'th', IDR: 'id', PHP: 'ph', VND: 'vn', INR: 'in',
				JPY: 'jp', KRW: 'kr', CNY: 'cn', HKD: 'hk', TWD: 'tw',
				AUD: 'au', NZD: 'nz', AED: 'ae', SAR: 'sa', QAR: 'qa',
				CHF: 'ch', CAD: 'ca', BND: 'bn', LAK: 'la', KHR: 'kh',
				MMK: 'mm' };
			const curCode = (o.currency || '').toUpperCase();
			const flagCc = CUR_FLAG[curCode] || '';
			const flagImg = flagCc ? `
				<img src="/assets/frappe/images/flags/${flagCc}.svg"
					alt="${esc(curCode)}" onerror="this.style.display='none'">` : '';
			// Baris konteks bawah nama offer — data trip/tarikh daripada
			// payload yang sama (dahulu kad TRIP INFORMATION/GROUP INFO):
			// ikon jenis trip + nama trip, kemudian Departure → Return
			// (format Travel Website).
			const pkIsCruise = !!(data.trip && data.trip.is_a_cruise_trip)
				|| !!(data.date && data.date.cruise_schedule);
			const pkTypeIcon = pkIsCruise ? '🚢' : '⛰️';
			const pkTripLine = pkTypeIcon + ' '
				+ esc((data.trip && (data.trip.trip_name || data.trip.name)) || trip);
			const pkDatesLine = esc(webFmtDate(data.date && data.date.departure_date))
				+ ' → ' + esc(webFmtDate(data.date && data.date.return_date));
			const infoCard = card(12, `📦 PACKAGE INFO
				<button class="btn btn-default btn-xs ml-auto" id="tm-pk-edit-info"
					title="Edit nama pakej, currency & status">✏️ Edit</button>`, `
				<div class="row align-items-center">
					<div class="col min-w-0">
						${field('', `
							<h3 class="text-uppercase break-words mb-0" style="line-height:1.3"
								title="${esc(o.package_name || pkgName)}">${esc(o.package_name || pkgName)}</h3>
							<div class="small font-weight-bold text-muted" style="line-height:1.3">
								${pkTripLine}
								<span class="d-block">${pkDatesLine}</span>
							</div>`, 'col-12')}
						${infoGrid('tm-pk-info-grid', `
							${field('Package ID', `<span class="text-monospace"><strong>${esc(offerName)}</strong></span>`, 'col-12 col-lg-4')}
							${field('Editorial Status', badge(o.status_editorial, DEP_COLOR[o.status_editorial] || C.gray), 'col-12 col-lg-4')}
							${field('Operational Status', badge(o.status_operational, OPE_COLOR[o.status_operational] || C.gray), 'col-12 col-lg-4')}
						`)}
					</div>
					<div class="col-auto d-flex flex-column align-items-center justify-content-center text-center px-4">
						${field('Currency', `
							<div class="tm-cur-flag d-flex flex-column align-items-center">${flagImg}
								<strong class="mt-1">${esc(o.currency || '-')}</strong></div>`,
							'col-12')}
					</div>
				</div>`);

			// ── PANEL 2: PAYMENT TERMS & SALE MODE ──
			const ptCard = card(12, `⚙️ PAYMENT TERMS & SALE MODE`, `
				<div id="tm-pk-terms-grid" class="row no-gutters align-items-center">
					${field('Deposit %', `<input class="form-control form-control-sm" id="tm-pk-deposit" type="number"
						min="0" max="100" style="width:100px" value="${o.deposit_percent || 0}">`, 'col-6 col-lg-3')}
					${field('Final Payment (hari sebelum berlepas)', `<input class="form-control form-control-sm" id="tm-pk-final" type="number"
						min="0" style="width:100px" value="${o.final_payment_days || 0}">`, 'col-6 col-lg-3')}
					${field('Sale Mode', `<select class="form-control form-control-sm" id="tm-pk-sale-mode" style="width:140px">
						${['Public', 'Group Block', 'Full Charter', 'Private'].map((m) =>
							`<option value="${m}" ${o.sale_mode === m ? 'selected' : ''}>${m}</option>`).join('')}
					</select>`, 'col-6 col-lg-3')}
					${field('Group Block Code', `<input class="form-control form-control-sm" id="tm-pk-block-code" type="text"
						maxlength="60" style="width:160px" value="${esc(o.group_block_code || '')}"
						${o.sale_mode === 'Group Block' ? '' : 'disabled'}>`, 'col-6 col-lg-3')}
				</div>
				<div class="d-flex flex-wrap gap-2 mt-2" style="justify-content: flex-end;">
					<button class="btn btn-primary btn-sm" id="tm-pk-save-pt">Save Config</button>
				</div>
				<p id="tm-pk-terms-effective" class="text-muted small mt-2 mb-0">
					${o.deposit_percent > 0
						? `Deposit offer: <strong>${o.deposit_percent}%</strong>`
						: `Deposit offer: <strong>${o.deposit_percent || 0}%</strong>
							→ guna default Travel Settings <strong>${o.deposit_percent_default ?? '?'}%</strong>`}
					· ${o.final_payment_days > 0
						? `Final payment offer: <strong>${o.final_payment_days} hari</strong>`
						: `Final payment offer: <strong>${o.final_payment_days || 0} hari</strong>
							→ guna default <strong>${o.final_payment_days_default ?? '?'} hari</strong>`}
					· Nilai berkesan booking kini: <strong>${(o.deposit_percent_effective != null ? o.deposit_percent_effective : (o.deposit_percent || 0))}% /
					${(o.final_payment_days_effective != null ? o.final_payment_days_effective : (o.final_payment_days || 0))} hari</strong></p>
				<p id="tm-pk-terms-note" class="text-muted small mt-1 mb-0">
					0 = guna default global Travel Settings. Booking dalam tetingkap final = bayar penuh serta-merta.
					Sale Mode: Public = FIT; Group Block = kod kontrak kumpulan; Full Charter / Private = jualan terbatas.</p>`);

			// ── Import source rows (schedule rates) — baris jadual modal
			// DIBINA DALAM tmOpenImportModal() (sync checkbox dengan jadual
			// ADDITIONAL ELEMENTS semasa; lihat komen di sana).
			// Nota penukaran kurs (schedule → offer) — dikira di server
			// semasa import; sini sekadar maklumat awal kepada staf.
			const schedCurs = [...new Set(srcS.map((r) => r.currency).filter(Boolean))];
			const convNote = (schedCurs.length && o.currency &&
				!schedCurs.every((c) => c === o.currency))
				? `kurs auto ${schedCurs.join('/')} → ${o.currency}` : '';

			const MCOLS = [
				['price_adult', 'Adult'], ['price_adult_single', 'Single'],
				['price_upperberth', 'Upper'], ['price_children', 'Children'],
				['price_toddler', 'Toddler'], ['price_infant', 'Infant'],
			];
			// ── Grid berSEKSI (Nov 2026): baris dikumpulkan ikut
			// price_category kategori → PRICE MATRIX | Room Category /
			// Flight / Hotel / Transport / Meal. "Room Category" mengumpul
			// Cruise+Tour; seksi lain hanya dipapar bila ada baris ATAU
			// pilihan master tersedia (dropdown tambah baris).
			const SECTIONS = ['Room Category', 'Flight', 'Hotel', 'Transport', 'Meal'];
			const catOpts = data.category_options || {};
			const bySection = {};
			for (const p of pmtx) {
				// Base sentiasa Room Category (kategorinya Cruise/Tour).
				(bySection['Room Category'] || (bySection['Room Category'] = [])).push(p);
			}
			for (const p of amtx) {
				(bySection[p.price_category] || (bySection[p.price_category] = [])).push(p);
			}
			// isBase menentukan ROUTING buang (price_matrix vs addon table)
			// — [fix Nov 2026] sebelum ini routing ikut pane id dan salah.
			const mxRowHtml = (p, isBase) => `
						<tr>
							<td><strong>${esc(p.category_name || p.category_code)}</strong>
								<span class="text-muted text-small">${esc(p.category_code || '')}</span></td>
							${MCOLS.map(([col, label]) => `
							<td style="width:95px"><input class="form-control form-control-sm tm-pk-mx"
								data-name="${esc(p.name)}" data-code="${esc(p.category_code || '')}"
								data-col="${col}" type="number" min="0" step="0.01"
								value="${p[col] != null ? p[col] : ''}"
								placeholder="—"></td>`).join('')}
							<td><button class="btn btn-xs btn-default tm-pk-mx-del"
								data-code="${esc(p.category_code || '')}"
								data-base="${isBase ? 1 : 0}"
								title="Buang baris kategori ini daripada matrix">✕</button></td>
						</tr>`;
			// ── PAGE TABS v4 (Nov 2026): 5 tab DALAM SATU URL pkg/<offer> —
			// ℹ️ Package Info, 🗓️ Itinerary, 💰 Product Prices, ➕ Add
			// Product, ⚙️ Package Config — toggle in-page (corak halaman
			// tarikh). Addons (Flight/Hotel/Transport/Meal) DIGABUNG dalam
			// SATU child table (addon_price_matrix) → dipapar sebagai SATU
			// panel "Additional Elements" pada tab Add Product. Base
			// (Room Category) kekal dalam Product Prices.
			const isCruise = !!o.cruise_schedule;
			const pageTabIdx = (id) => 'tm-pagetab-' + id;

			// ── HARGA FINAL PER VARIANT (tab Package Info — Nov 2026):
			// jadual matrix ikut FORMAT ROOM CATEGORY — nilai setiap lajur
			// = harga base kategori + Σ SEMUA baris addon (kontrak
			// pricing.py `_apply_addon_totals` — paparan laman == jumlah
			// yang dicas). Room Category = base product cost; harga kosong
			// = slot tak dijual. TIADA layout kad — jadual terus dalam
			// pane (arahan pemilik; corak pane halaman tarikh).
			const addonSum = {};
			for (const a of amtx) {
				for (const [col] of MCOLS) {
					const v = parseFloat(a[col]);
					if (!isNaN(v)) addonSum[col] = (addonSum[col] || 0) + v;
				}
			}
			const fmtFinal = (v) => esc(o.currency || '') + ' '
				+ v.toLocaleString('en-MY', { maximumFractionDigits: 2 });
			let finalRowsHtml = (bySection['Room Category'] || []).map((p) => `
				<tr>
					<td><strong>${esc(p.category_name || p.category_code)}</strong>
						<span class="text-muted text-small">${esc(p.category_code || '')}</span></td>
					${MCOLS.map(([col]) => {
						const b = parseFloat(p[col]);
						return isNaN(b)
							? '<td class="text-right"><span class="text-extra-muted">—</span></td>'
							: `<td class="text-right">${fmtFinal(b + (addonSum[col] || 0))}</td>`;
					}).join('')}
				</tr>`).join('');
			if (!finalRowsHtml) finalRowsHtml = `<tr><td colspan="7"
				class="text-muted text-center p-3">Tiada variant Room Category
				— tambah di tab Product Prices.</td></tr>`;
			const finalPriceHtml = `
				<div class="d-flex align-items-baseline mb-2">
					<strong>💰 FINAL PRICE — PER VARIANT</strong>
					<span class="text-muted text-small ml-2">paparan customer (base + Σ addons)</span>
				</div>
				<div class="overflow-auto">
				<table class="table table-sm mb-0">
					<thead><tr><th>Variant (Room Category)</th>
						${MCOLS.map(([, label]) => `<th class="text-right">${label}</th>`).join('')}
					</tr></thead>
					<tbody>${finalRowsHtml}</tbody>
				</table></div>
				<p class="text-muted small mt-2 mb-0">
					Harga final setiap variant = base Room Category (product cost)
					+ Σ addons (Flight · Hotel · Transport · Meal) — formula sama
					dengan paparan portal customer. Harga kosong = slot tak dijual.
					${o.currency ? `Mata wang: <strong>${esc(o.currency)}</strong>` : ''}</p>`;

			// ── Grid matrix satu seksi (+ Extract & Import utk Cabin) ──
			const mxSectionHtml = (sec, withImport) => {
				const rows = bySection[sec] || [];
				const opts = (catOpts[sec] || [])
					.filter((c) => !rows.some(
						(r) => r.category_code === c.category_code));
				const isBase = sec === 'Room Category';
				// OPTIONS tertapis (rombakan Nov 2026): cruise → Cruise
				// sahaja; bukan-cruise → exclude Cruise; kategori
				// category_group 'addon' dikecualikan.
				const secOpts = opts.filter((c) => {
					if ((c.category_group || '') === 'addon') return false;
					return isCruise
						? c.price_category === 'Cruise'
						: c.price_category !== 'Cruise';
				});
				const addArea = secOpts.length ? `
				<div id="tm-pk-add-area-base" class="tm-pk-add-area d-flex flex-wrap align-items-center">
					<input class="form-control form-control-sm tm-pk-addsel"
						data-section="${esc(sec)}" placeholder="Taip untuk cari kategori..."
						autocomplete="off">
					<button class="btn btn-xs btn-default tm-pk-add" data-section="${esc(sec)}">+ Tambah</button>
				</div>` : '';
				// [Nov 2026] TIADA layout kad — kandungan terus dalam pane
				// (arahan pemilik; corak pane halaman tarikh). Butang
				// "Import from Cruise Schedule" (cruise sahaja) di kanan
				// header — buka modal import. WRAPPER .tm-pk-panel = skop
				// handler save/tambah (pengganti .card lama — setiap panel
				// berasingan supaya baris dua panel tidak saling tercampur).
				return `
				<div class="tm-pk-panel">
				<div class="d-flex align-items-center mb-2">
					<strong>${isBase
						? `🛏️ ROOM CATEGORY LIST (${rows.length} kategori)`
						: `💰 PRICE MATRIX | ${sec} (${rows.length} kategori)`}</strong>
					${isBase && isCruise ? `
					<button class="btn btn-default btn-sm ml-auto" id="tm-pk-import-open"
						title="Import kategori kadar sailing daripada Cruise Schedule tarikh ini">⬆ Import from Cruise Schedule</button>` : ''}
				</div>
				${addArea}
				<div class="overflow-auto">
				<table class="table table-sm mb-0">
					<thead><tr><th>Category</th>
						${MCOLS.map(([, label]) => `<th class="text-right">${label}</th>`).join('')}
						<th></th></tr></thead>
					<tbody>${rows.map((r) => mxRowHtml(r, true)).join('') ||
						`<tr><td colspan="8" class="text-muted text-center p-2">
							Tiada baris — tambah daripada master${withImport ? ' atau guna Import from Cruise Schedule' : ''}.</td></tr>`}</tbody>
				</table></div>
				<div id="tm-pk-save-area-base" class="mt-2">
					<span class="text-muted small d-block mb-1">1 baris = 1 kategori · Adult (twin/share), Single (solo),
					Upper (extra bed), Children (5-11), Toddler (2-4), Infant (0-23 bln). Harga kosong = slot tak dijual.
					${o.currency ? `Mata wang: <strong>${esc(o.currency)}</strong>` : ''}</span>
					<div class="text-right">
						<button class="btn btn-primary btn-sm tm-pk-save-btn"
							data-base="${isBase ? 1 : 0}">Save Price</button>
					</div>
				</div>
				</div>`;
			};

			// ── IMPORT FROM CRUISE SCHEDULE (modal — arahan pemilik Nov
			// 2026): seksyen RATE FROM CRUISE SCHEDULE (kad collapsible)
			// dipindah ke DIALOG — dibuka melalui butang "Import from
			// Cruise Schedule" pada pane Product Prices (dibina dalam
			// mxSectionHtml, cruise sahaja). Sumber = kategori kadar sailing
			// (cabin_rates) invoice schedule tarikh ini; import with Markup
			// + kurs auto (schedule → offer currency).
			const tmOpenImportModal = () => {
				if (!srcS.length) {
					frappe.msgprint('Invoice schedule ini tiada kategori kadar '
						+ '(cabin_rates) ATAU tarikh bukan cruise.');
					return;
				}
				const d = new frappe.ui.Dialog({
					title: 'Import from Cruise Schedule', size: 'large' });
				d.$wrapper.addClass('tm-dim-modal'); // body skrol sendiri
				// Baris sumber — SYNC ADDITIONAL ELEMENTS (Nov 2026 arahan
				// pemilik): kategori yang SUDAH ada dalam jadual addon →
				// checkbox DISABLED + baris dilabel (elak import dua kali);
				// bila element DIBUANG dari jadual (halaman reload), checkbox
				// kembali ENABLED. State sentiasa ikut jadual semasa kerana
				// modal dibina semula setiap kali dibuka.
				const impRowsHtml = srcS.map((r, i) => {
					const taken = addonKeys.has((r.category_code || '').trim());
					return `
					<tr${taken ? ' class="text-muted"' : ''}>
						<td><input type="checkbox" class="tm-imp-check" data-sched="1"
							data-i="${i}"${taken
								? ' disabled title="Kategori ini sudah dalam Additional Elements — buang daripada jadual untuk import semula"'
								: ''}></td>
						<td><strong>${esc(r.category_code)}</strong>
							<span class="text-muted text-small">${esc(r.category_name || '')}</span>
							${taken ? ' <span class="badge badge-secondary text-small">dalam Add. Elements</span>' : ''}</td>
						<td class="text-right">${r.price_adult}</td>
						<td class="text-right">${r.price_adult_single || '—'}</td>
						<td class="text-right">${r.price_upperberth || '—'}</td>
						<td class="text-right">${r.price_children || '—'}</td>
						<td class="text-right">${r.price_toddler || '—'}</td>
						<td class="text-right">${r.price_infant || '—'}</td>
						<td>${esc(r.currency)}</td>
					</tr>`;
				}).join('');
				d.$body.html(`
					<table class="table table-sm mb-0">
						<thead><tr><th><input type="checkbox" id="tm-imp-all-sched"
								title="Pilih semua baris schedule"></th><th>Category</th>
							<th class="text-right">Adult</th><th class="text-right">Single</th>
							<th class="text-right">Upper</th><th class="text-right">Children</th>
							<th class="text-right">Toddler</th><th class="text-right">Infant</th>
							<th>Cur</th></tr></thead>
						<tbody>${impRowsHtml}</tbody>
					</table>
					<div class="d-flex flex-wrap align-items-center gap-2 mt-2">
						<input class="form-control form-control-sm" id="tm-pk-markup"
							type="number" min="0" max="100" step="0.1" style="width:110px"
							placeholder="Markup %"
							title="Markup % digunakan pada semua nilai diimport (selepas penukaran kurs). Hasil dibundarkan KE ATAS ke integer. Kosong = harga terus.">
						${convNote ? `<span class="text-ink-green-7 small">💱 ${esc(convNote)}</span>` : ''}
					</div>`);
				// Check-all baris schedule — checkbox ENABLED sahaja (baris
				// yang sudah dalam Additional Elements ikut disabled).
				d.$body.find('#tm-imp-all-sched').on('change', function () {
					d.$body.find('.tm-imp-check[data-sched]:enabled')
						.prop('checked', this.checked);
				});
				d.set_primary_action('⬆ Import with Markup', async () => {
					const sel = [];
					d.$body.find('.tm-imp-check[data-sched]:checked')
						.each(function () {
							const i = $(this).data('i');
							const r = srcS[i];
							if (r) sel.push({ category_code: r.category_code,
								currency: r.currency,
								price_adult: r.price_adult,
								price_adult_single: r.price_adult_single,
								price_upperberth: r.price_upperberth,
								price_children: r.price_children,
								price_toddler: r.price_toddler,
								price_infant: r.price_infant });
						});
					if (!sel.length) {
						frappe.msgprint('Tanda baris sumber dahulu.');
						return;
					}
					const markup = d.$body.find('#tm-pk-markup').val();
					try {
						const res = await api('import_offer_prices',
							{ offer: offerName, rows: JSON.stringify(sel),
							  markup_percent: markup || '0' });
						const ratesTxt = res.rates && Object.keys(res.rates).length
							? ' · kurs ' + Object.entries(res.rates)
								.map(([k, v]) => `${k} = ${v}`).join(', ') : '';
						const markTxt = res.markup_percent
							? ` · markup +${res.markup_percent}%` : '';
						frappe.show_alert({
							message: `Import selesai — ${res.updated} dikemas kini, `
								+ `${res.added} ditambah${ratesTxt}${markTxt}`,
							indicator: 'green' });
						d.hide();
						load_travel_package_admin(trip, dateName, offerName, pkgName);
					} catch (e) { /* frappe already shows it */ }
				});
				d.show();
			};

			// ── Panel ADDITIONAL ELEMENTS (addons digabung — Nov 2026).
			// [Nov 2026] TIADA layout kad — kandungan terus dalam pane tab
			// Add Product (arahan pemilik; corak pane halaman tarikh).
			const addonRows = ['Flight', 'Hotel', 'Transport', 'Meal']
				.flatMap((sec) => bySection[sec] || []);
			const addonOpts = ['Flight', 'Hotel', 'Transport', 'Meal']
				.flatMap((sec) => catOpts[sec] || [])
				.filter((c) => !addonRows.some(
					(r) => r.category_code === c.category_code));
			const addonCard = `
				<div class="tm-pk-panel">
				<div class="d-flex align-items-center mb-2">
					<strong>🧩 ADDITIONAL ELEMENTS (${addonRows.length} element)</strong>
					${!addonRows.length ? `<span class="ml-2" title="Seksi aktif tetapi tiada baris harga — isi sebelum jual (amaran readiness)">⚠️</span>` : ''}
				</div>
				${addonOpts.length ? `
				<div id="tm-pk-add-area-addon" class="tm-pk-add-area d-flex flex-wrap align-items-center">
					<input class="form-control form-control-sm tm-pk-addon-sel"
						placeholder="Taip untuk cari element addon..."
						autocomplete="off">
					<button class="btn btn-xs btn-default tm-pk-addon-add">+ Tambah</button>
				</div>` : ''}
				<div class="overflow-auto tm-pk-addon-scroll">
				<table class="table table-sm mb-0">
					<thead><tr><th>Category</th>
						${MCOLS.map(([, label]) => `<th class="text-right">${label}</th>`).join('')}
						<th></th></tr></thead>
					<tbody>${addonRows.map((r) => mxRowHtml(r, false)).join('') ||
						`<tr><td colspan="8" class="text-muted text-center p-2">
							Tiada addon — tambah daripada master.</td></tr>`}</tbody>
				</table></div>
				<div id="tm-pk-save-area-addon" class="mt-2">
					<span class="text-muted small d-block mb-1">
						Semua addon (Flight · Hotel · Transport · Meal) disimpan sekali —
						total pakej = base + Σ addons.</span>
					<div class="text-right">
						<button class="btn btn-primary btn-sm tm-pk-save-btn"
							data-base="0">Save Price</button>
					</div>
				</div>
				</div>`;

			// ── PRODUCTS & COMPONENTS pakej (tab Config) ──
			const compRows = comps.map((c) => `
				<tr>
					<td>${badge(c.component_type, C.gray)}</td>
					<td><strong>${esc(c.trip || c.flight || c.component_item || '-')}</strong></td>
					<td>${esc(c.age_option || 'General')}</td>
					<td>${esc(c.selection_mode || '-')}</td>
					<td>${c.mandatory
						? '<span class="text-danger font-weight-bold">Required</span>'
						: '<span class="text-extra-muted">Optional</span>'}</td>
					<td>${c.qty || 1}</td>
					<td>${c.price_adjust_type !== 'none'
						? `${c.price_adjust_type === 'percent' ? '+' + c.price_adjust_value + '%' : '+' + c.price_adjust_value}`
						: '<span class="text-extra-muted">—</span>'}</td>
				</tr>`).join('');
			const compCard = card(12, `📦 PRODUCTS INCLUDED IN THIS PACKAGE (${comps.length})`,
				comps.length
					? `<div id="tm-pk-comp-scroll" class="overflow-auto">${tmTable(
						['Type', 'Reference', 'For', 'Selection', 'Required', 'Qty', 'Price Impact'], compRows)}</div>`
					: '<p class="text-muted small">Tiada komponen — edit di pakej (Edit di kad PACKAGES peringkat trip).</p>');

			// ── Kad ITINERARY (warisan Travel Date ← override offer ini) —
			// editor "reuse + checkbox overwrite" (Nov 2026), dipasang pada
			// tab ITINERARY (toggle in-page selepas Package Info). Mod PLAIN
			// — TIADA layout kad, kandungan terus dalam pane (arahan pemilik
			// Nov 2026; corak tab itinerary halaman tarikh) + caption sumber.
			const itinCard = itineraryOverrideCard({
				parenttype: 'Package Offer', name: offerName,
				payload: data.itinerary, parentLabel: 'Travel Date',
				plain: true,
				showSource: true,
				onSaved: () => load_travel_package_admin(trip, dateName,
					offerName, pkgName),
			});

			// ── TAB pakej (Nov 2026 — toggle DALAM SATU URL): SEMUA pane
			// di-render sekali (eager) & ditoggl in-page dengan class .active
			// (desk tiada Bootstrap JS — corak halaman tarikh). Kedudukan
			// tab: info → itinerary → prices → addons → config; tab aktif =
			// pkgActiveTab (kekal antara reload save/add/import). Wiring
			// handler berlaku SEKALI pada semua pane — elemen kekal hidup,
			// nilai input tak hilang bila bertukar tab.
			const pageTabs = [
				{ id: 'info', label: 'ℹ️ Package Info' },
				{ id: 'itinerary', label: '🗓️ Itinerary' },
				{ id: 'prices', label: '💰 Product Prices' },
				{ id: 'addons', label: '➕ Add Product' },
				{ id: 'config', label: '⚙️ Package Config' },
			];
			const paneBody = (id) => id === 'itinerary'
				? itinCard.html() // ITINERARY (warisan Travel Date ← override offer)
				: id === 'prices'
				? mxSectionHtml('Room Category', isCruise)
				: id === 'addons'
				? addonCard // ADDITIONAL ELEMENTS (Flight/Hotel/Transport/Meal)
				: id === 'config'
				? `${ptCard}${compCard}` // PAYMENT TERMS + PRODUCTS INCLUDED
				: `${finalPriceHtml}`; // info = FINAL PRICE PER VARIANT
			const panesHtml = pageTabs.map((t) => `
				<div class="tab-pane ${t.id === pkgActiveTab ? 'active' : ''}"
					id="${pageTabIdx(t.id)}" role="tabpanel"
					style="padding-top:12px"><div>${paneBody(t.id)}</div></div>`).join('');

			// ── Navigasi 3-zon: Back (kiri) · Prev/Next + kaunter (TENGAH) ·
			// Delete (kanan) — flex-fill kiri/kanan menengahkan zon tengah.
			const navRow = `
				<div id="tm-pk-navrow" class="d-flex flex-wrap align-items-center gap-2 mt-5 mb-4">
					<div class="flex-fill min-w-0">
						<button class="btn btn-default btn-sm" id="tm-pk-back">← Back to Travel Date</button>
					</div>
					<div class="d-flex align-items-center gap-2">
						<button class="btn btn-default btn-sm" id="tm-pk-prev"
							${prevOffer ? '' : 'disabled'}
							title="${prevOffer ? esc(prevOffer.offer_name || prevOffer.name) : 'Offer pertama'}">‹ Prev</button>
						<span class="text-muted text-nowrap text-small">Offer ${idx + 1} / ${offersList.length}</span>
						<button class="btn btn-default btn-sm" id="tm-pk-next"
							${nextOffer ? '' : 'disabled'}
							title="${nextOffer ? esc(nextOffer.offer_name || nextOffer.name) : 'Offer terakhir'}">Next ›</button>
					</div>
					<div class="flex-fill min-w-0 text-right">
						${isManager ? `
						<button class="btn btn-danger btn-sm" id="tm-pk-delete"
							title="Padam offer ini (pakej pada tarikh ini)">🗑 Delete Offer</button>` : ''}
					</div>
				</div>`;
			// Tabs nav — toggle DALAM SATU URL (Nov 2026 — arahan pemilik):
			// pkg/<offer> tanpa segmen view; href javascript:void(0) elak
			// hash router Frappe (corak halaman tarikh).
			const pageTabsNav = `
				<ul class="nav nav-tabs mb-3" id="tm-pk-tabs">
					${pageTabs.map((t) => `
					<li class="nav-item"><a class="nav-link ${t.id === pkgActiveTab ? 'active' : ''}"
						href="javascript:void(0)" data-tm-tab="${t.id}" role="tab"
						aria-controls="${pageTabIdx(t.id)}">${t.label}</a></li>`).join('')}
				</ul>`;

			// [BUANG Nov 2026] kad TRIP INFORMATION + GROUP INFO di atas nav
			// row (arahan pemilik) — ringkasan trip & tarikh berlepas dipindah
			// masuk ke kad PACKAGE INFO (baris kecil bawah nama offer).
			$body.html(`${navRow}<div>${infoCard}</div>${pageTabsNav}<div class="tm-pk-panes tab-content">${panesHtml}</div>`);
			// Editor itinerary di-mount dalam pane-nya (semua pane eager) —
			// wire() sekali selepas render.
			itinCard.wire();

			// [BUANG Nov 2026] binding collapsible kad RATE — seksyen Rate
			// kini modal (tmOpenImportModal); tiada lagi .tm-collapse-toggle
			// pada halaman ini.

			// ── AUTOCOMPLETE add-row (Awesomplete desk) — [Nov 2026] ──
			// Parse kod daripada label "… (CODE)" atau teks mentah.
			const parseCode = (txt) => {
				const m = (txt || "").match(/\(([^()]+)\)\s*$/);
				return m ? m[1].trim() : (txt || "").trim();
			};
			const initAddAuto = (inputEl, items, withCat) => {
				if (!inputEl || !items.length) return;
				const labels = items.map((c) => withCat
					? `${c.price_category} - ${c.category_name} (${c.category_code})`
					: `${c.category_name} (${c.category_code})`);
				if (window.Awesomplete) {
					const aw = new window.Awesomplete(inputEl, {
						list: labels, minChars: 0, maxItems: 99, autoFirst: true,
					});
					inputEl.addEventListener("awesomplete-select", (ev) => {
						inputEl.value = ev.text.value;
						inputEl.dataset.chosen = parseCode(ev.text.value);
					});
					inputEl.addEventListener("awesomplete-selectcomplete",
						(ev) => {
							inputEl.dataset.chosen = parseCode(ev.text.value);
						});
					// PAPAR SENARAI PENUH SEBELUM PENGGUNA TAIP — buka pada
					// fokus/klik (minChars 0 + evaluate kosong = semua item).
					const buka = () => {
						inputEl.value = "";
						delete inputEl.dataset.chosen;
						aw.evaluate();
						aw.open();
					};
					inputEl.addEventListener("focus", buka);
					inputEl.addEventListener("click", buka);
				}
				inputEl.dataset.items = JSON.stringify(items);
			};
			// Kunci kategori yang SUDAH ada dalam baris matrix — option
			// autocomplete tidak memapar kategori berkenaan lagi (larang
			// duplikasi). Baris lama boleh simpan docname ATAU category_code,
			// jadi kedua-dua bentuk disemak.
			const rowKeys = (rows) => new Set(rows.flatMap((r) => [
				(r.category_code || '').trim(),
				(r.pricing_for_class || '').trim(),
			].filter(Boolean)));
			// Cabin: cruise → Cruise sahaja; bukan-cruise → exclude Cruise;
			// kategori group 'addon' dikecualikan; + buang yang sudah ada.
			const baseKeys = rowKeys(bySection['Room Category'] || []);
			const baseItems = (catOpts['Room Category'] || []).filter((c) => {
				if ((c.category_group || '') === 'addon') return false;
				const secOk = isCruise ? c.price_category === 'Cruise'
									   : c.price_category !== 'Cruise';
				if (!secOk) return false;
				return !baseKeys.has(c.category_code)
					&& !baseKeys.has(c.name);
			});
			initAddAuto($body.find('.tm-pk-addsel[data-section="Room Category"]')[0],
						baseItems, false);
			// Addon: gabung 4 jenis — label "Price Category - Name (CODE)";
			// element yang sudah ada dalam jadual addon tidak dipapar.
			const addonKeys = rowKeys(addonRows);
			const addonItems = ['Flight', 'Hotel', 'Transport', 'Meal']
				.flatMap((sec) => catOpts[sec] || [])
				.filter((c) => !addonKeys.has(c.category_code)
							&& !addonKeys.has(c.name));
			initAddAuto($body.find('.tm-pk-addon-sel')[0], addonItems, true);

			// ── Navigasi ──
			$body.find('#tm-pk-back').on('click', () =>
				frappe.set_route('travel-manager', 'trip', trip, 'date', dateName));
			if (prevOffer) $body.find('#tm-pk-prev').on('click', () => goOffer(prevOffer));
			if (nextOffer) $body.find('#tm-pk-next').on('click', () => goOffer(nextOffer));
			// Padam offer ini — konfirmasi taip nama offer.
			$body.find('#tm-pk-delete').on('click', () => {
				frappe.prompt(
					[
						{
							fieldname: 'confirm_name', fieldtype: 'Data',
							label: `Taip <strong>${esc(offerName)}</strong> untuk sahkan pemadaman`,
							reqd: 1,
							description: `Akan DIPADAM SELAMANYA: offer ${esc(o.package_name || offerName)} `
								+ `pada tarikh ini beserta harga & komponennya. Travel date dan `
								+ `offer lain kekal. Booking aktif akan MENYEKAT pemadaman.`,
						},
					],
					(values) => {
						if ((values.confirm_name || '').trim() !== offerName) {
							frappe.msgprint('Nama offer tidak sepadan — pemadaman dibatalkan.');
							return;
						}
						api('delete_package_offer', { offer: offerName }).then(() => {
							frappe.show_alert({
								message: `Offer ${offerName} dipadam`,
								indicator: 'red',
							});
							frappe.set_route('travel-manager', 'trip', trip, 'date', dateName);
						}).catch(() => { /* frappe already shows it */ });
					},
					__('🗑 Delete Offer — tidak boleh dibatalkan'),
				);
			});

			// ── Wiring ──
			$body.find('#tm-pk-save-pt').on('click', async () => {
				try {
					await api('save_offer_payment_terms', {
						offer: offerName,
						deposit_percent: parseFloat($body.find('#tm-pk-deposit').val() || 0),
						final_payment_days: parseInt($body.find('#tm-pk-final').val() || 0, 10),
					});
					await api('save_offer_grouping', {
						offer: offerName,
						sale_mode: $body.find('#tm-pk-sale-mode').val(),
						group_block_code: $body.find('#tm-pk-block-code').val() || '',
					});
					frappe.show_alert({ message: 'Terms & sale mode saved', indicator: 'green' });
				} catch (e) { /* frappe already shows it */ }
			});
			// Group block code hanya aktif bila sale mode = Group Block.
			$body.find('#tm-pk-sale-mode').on('change', function () {
				$body.find('#tm-pk-block-code').prop(
					'disabled', $(this).val() !== 'Group Block');
			});
			// Kelas (bukan id) — butang wujud pada SETIAP panel matrix.
			// [FIX Nov 2026] skop = PANEL butang itu (.tm-pk-panel) — BUKAN
			// .tab-pane (Room Category List DAN Additional Elements berada
			// dalam pane yang sama; skop pane mengutip baris KEDUA-DUA panel
			// → saling meniru). Dahulu .closest('.card') — LAYOUT KAD
			// DIBUANG (Nov 2026) → wrapper .tm-pk-panel mengambil alih
			// peranan skop.
			$body.find('.tm-pk-save-btn').on('click', async function () {
				const $btn = $(this);
				const isAddon = $btn.data('base') === 0 ? 1 : 0;
				const byCode = {};
				$btn.closest('.tm-pk-panel').find('.tm-pk-mx').each(function () {
					const code = $(this).data('code');
					if (!code) return;
					byCode[code] = byCode[code]
						|| { pricing_for_class: code };
					const v = $(this).val();
					byCode[code][$(this).data('col')] =
						v === '' ? null : parseFloat(v);
				});
				if (!Object.keys(byCode).length) {
					frappe.msgprint('Tiada baris untuk disimpan.');
					return;
				}
				try {
					const res = await api('save_offer_price_matrix',
						{ offer: offerName,
						  rows: JSON.stringify(Object.values(byCode)),
						  addon: isAddon });
					const skipTxt = res.skipped && res.skipped.length
						? ` · ${res.skipped.length} ditolak (jenis salah jadual: ${res.skipped.join(', ')})` : '';
					frappe.show_alert({
						message: `Price info saved (${res.upserted} kategori → ${res.table === 'addon_price_matrix' ? 'addon' : 'base'})${skipTxt}`,
						indicator: res.skipped && res.skipped.length ? 'orange' : 'green' });
					// Refresh — jadual semua tab papar data tersimpan.
					load_travel_package_admin(trip, dateName, offerName, pkgName);
				} catch (e) { /* frappe already shows it */ }
			});
			// ✏️ Edit — nama pakej / currency / status (dialog).
			$body.find('#tm-pk-edit-info').on('click', () => {
				const isManager = (frappe.user_roles || []).includes('Tour Manager')
					|| (frappe.user_roles || []).includes('System Manager');
				const d = new frappe.ui.Dialog({
					title: 'Edit Package Info — ' + offerName,
					fields: [
						{ fieldname: 'offer_name', fieldtype: 'Data', label: 'Package Name (offer_name)',
							default: o.offer_name || o.package_name || '', reqd: 1 },
						{ fieldname: 'currency', fieldtype: 'Link', label: 'Currency',
							options: 'Currency', default: o.currency || 'MYR', reqd: 1 },
						{ fieldname: 'status_editorial', fieldtype: 'Select', label: 'Editorial Status',
							options: 'Draft\nActive\nCancelled', default: o.status_editorial || 'Draft',
							description: isManager ? '' : 'Active/Cancelled perlukan Tour Manager' },
					],
					primary_action_label: 'Save',
				});
				d.set_values({
					offer_name: o.offer_name || o.package_name || '',
					currency: o.currency || 'MYR',
					status_editorial: o.status_editorial || 'Draft',
				});
				d.set_primary_action('Save', async (v) => {
					if (!v) return;
					try {
						await api('save_offer_info', {
							offer: offerName,
							offer_name: v.offer_name,
							currency: v.currency,
							status_editorial: v.status_editorial,
						});
						frappe.show_alert({ message: 'Package info updated', indicator: 'green' });
						d.hide();
						load_travel_package_admin(trip, dateName, offerName, pkgName);
					} catch (e) { /* frappe already shows it */ }
				});
				d.show();
			});

			// Tab switching — toggle .active sendiri DALAM SATU URL (desk
			// tiada Bootstrap JS; corak halaman tarikh). Delegasi $body +
			// NAMASPACE + .off() — handler load sebelumnya dibuang dahulu.
			$body.off('click._tmpktab', '#tm-pk-tabs .nav-link')
				.on('click._tmpktab', '#tm-pk-tabs .nav-link', function (ev) {
					ev.preventDefault();
					const $link = $(this);
					const id = $link.data('tmTab');
					pkgActiveTab = id;
					$link.closest('.nav-tabs').find('.nav-link').removeClass('active');
					$link.addClass('active');
					$body.find('.tm-pk-panes > .tab-pane').removeClass('active');
					$body.find('#' + pageTabIdx(id)).addClass('active');
				});

			// Tambah baris kategori master ke seksi (row kosong — harga
			// diisi kemudian; upsert sisi server).
			$body.find('.tm-pk-add').on('click', async function () {
				const sec = $(this).data('section');
				const sel = $(this).closest('.tm-pk-panel').find('.tm-pk-addsel');
				// Autocomplete: kod daripada label terpilih "(CODE)".
				const code = sel.data('chosen') || parseCode(sel.val());
				if (!code) { frappe.msgprint('Pilih kategori dahulu.'); return; }
				// Larang duplikasi — kategori sudah ada dalam senarai.
				const existing = bySection['Room Category'] || [];
				if (existing.some((r) => r.category_code === code
						|| r.pricing_for_class === code)) {
					frappe.msgprint(
						`Kategori ${code} sudah wujud dalam Room Category List.`);
					return;
				}
				// Room Category = base; Flight/Hotel/Transport/Meal = addon.
				const isAddon = sec === 'Room Category' ? 0 : 1;
				try {
					const res = await api('save_offer_price_matrix', {
						offer: offerName,
						rows: JSON.stringify([{ pricing_for_class: code }]),
						addon: isAddon,
					});
					frappe.show_alert({
						message: `Kategori ditambah ke seksi ${sec}`,
						indicator: 'green' });
					load_travel_package_admin(trip, dateName, offerName, pkgName);
				} catch (e) { /* frappe already shows it */ }
			});
			// Buang baris kategori daripada matrix (remove:1).
			$body.find('.tm-pk-mx-del').on('click', async function () {
				const code = $(this).data('code');
				// Routing ikut data-base butang (fix: pane id lama menyebabkan
				// buang baris BASE tersalah ke jadual addon — tak berkesan).
				const isAddon = $(this).data('base') === 0 ? 1 : 0;
				if (!code) return;
				frappe.confirm(`Buang kategori ${code} daripada Price Matrix?`,
					async () => {
						try {
							await api('save_offer_price_matrix', {
								offer: offerName,
								rows: JSON.stringify([{
									pricing_for_class: code, remove: 1 }]),
								addon: isAddon,
							});
							frappe.show_alert({
								message: `Kategori ${code} dibuang`,
								indicator: 'orange' });
							load_travel_package_admin(trip, dateName, offerName, pkgName);
						} catch (e) { /* frappe already shows it */ }
					});
			});

			// Tambah element ADDON (dropdown gabung Flight/Hotel/Transport/
			// Meal) — routing addon=1.
			$body.find('.tm-pk-addon-add').on('click', async function () {
				const sel = $(this).closest('.tm-pk-panel').find('.tm-pk-addon-sel');
				const code = sel.data('chosen') || parseCode(sel.val());
				if (!code) { frappe.msgprint('Pilih element dahulu.'); return; }
				// Larang duplikasi — element sudah ada dalam jadual addon.
				if (addonRows.some((r) => r.category_code === code
						|| r.pricing_for_class === code)) {
					frappe.msgprint(
						`Element ${code} sudah wujud dalam Additional Elements.`);
					return;
				}
				try {
					const res = await api('save_offer_price_matrix', {
						offer: offerName,
						rows: JSON.stringify([{ pricing_for_class: code }]),
						addon: 1,
					});
					frappe.show_alert({
						message: `Addon element ditambah`,
						indicator: 'green' });
					load_travel_package_admin(trip, dateName, offerName, pkgName);
				} catch (e) { /* frappe already shows it */ }
			});

			// Modal IMPORT FROM CRUISE SCHEDULE — butang pada pane prices
			// (cruise sahaja; dialog dibina semula setiap buka — state
			// checkbox segar).
			$body.find('#tm-pk-import-open').on('click', tmOpenImportModal);
		}

		// Format tarikh paparan daripada Travel Website.date_display_format
		// (single doctype; default 'dd MMM yyyy') — BUKAN System Settings
		// (arahan pemilik). Dicache sekali per sessi halaman.
		let travelDateFmt = null;

		// Helper kongsi (Nov 2026): SEMUA paparan tarikh Travel Manager —
		// kad TRAVEL DATES & OFFERS, modal maklumat tarikh, dialog edit —
		// wajib ikut format laman (Travel Website.date_display_format).
		// Pastikan format dimuat (sekali panggilan, cached).
		const webFmtLoad = () => travelDateFmt
			? Promise.resolve(travelDateFmt)
			: api('get_date_display_format')
				.then((f) => { travelDateFmt = f || 'dd MMM yyyy'; return travelDateFmt; })
				.catch(() => 'dd MMM yyyy');
		// Token lowercase doctype → token moment (dd→DD, mm→MM,
		// yyyy→YYYY, MMM/MMMM kekal huruf).
		const webDispFmt = () => String(travelDateFmt || 'dd MMM yyyy')
			.replace(/\bdddd\b/gi, 'dddd').replace(/\bddd\b/gi, 'ddd')
			.replace(/\bdd\b/gi, 'DD').replace(/\bmmmm\b/gi, 'MMMM')
			.replace(/\bmmm\b/gi, 'MMM').replace(/\bmm\b/gi, 'MM')
			.replace(/\byyyy\b/gi, 'YYYY').replace(/\byy\b/gi, 'YY');
		// ISO **atau Date object** → paparan format Travel Website
		// (kosong → '—'; bukan tarikh → balik apa adanya).
		const webFmtDate = (val) => {
			if (val === null || val === undefined || val === '') return '—';
			const m = (val instanceof Date)
				? moment(val)
				: moment(String(val).slice(0, 10), 'YYYY-MM-DD', 'en');
			return m.isValid() ? m.format(webDispFmt()) : String(val);
		};

		function travel_date_dialog(trip, existing, onDone) {
			// existing = rekod get_travel_dates_list row (edit) / null (cipta).
			// [Nov 2026] Susun atur: Pergi+Pulang → Selected Cruise Schedule
			// (+ nota sailing + Clear) → senarai schedule (inline search,
			// Ship Code + Sailing Date, Active & hadapan, had 10 baris;
			// senarai DISEMBUNYIKAN bila schedule dipilih).
			// FORMAT TARIKH (Travel Website.date_display_format): input
			// bebas format diterima (format laman, ISO, dd/mm/yyyy,
			// dd-mm-yyyy, D MMM[M] YYYY) → dinormalisasi ke format laman
			// pada blur; semua paparan tarikh ikut format itu.
			// VALIDASI lingkungan (semasa Save): Departure ≤ sail_start DAN
			// sail_end ≤ Return (sailing mesti di dalam lingkungan trip),
			// + Return ≥ Departure.
			const isEdit = !!existing?.name;
			// [Nov 2026] RUANG EDIT STATUS (dipindah dari modal info) —
			// pilihan doctype Travel Date (status_editorial: Draft/Active/
			// Cancelled). Active/Cancelled manager-gated di server
			// (_gate_status_change melalui save_travel_date) → opsyen
			// DISABLED untuk bukan manager. curStatus = status semasa —
			// status TIDAK dihantar bila tidak berubah (elak gate gagal
			// untuk bukan manager yang edit medan lain pada date Active).
			const TD_STATUSES = ['Draft', 'Active', 'Cancelled'];
			const GATED_STATUS = ['Active', 'Cancelled'];
			const curStatus = existing?.status || 'Draft';
			const fmtP = webFmtLoad();
			Promise.all([
				tcc('get_trips_list', { search: trip, limit: 1 }),
				fmtP,
				// Master Trip Category — dropdown kategori (Nov 2026).
				api('list_trip_categories').catch(() => []),
			]).then(([core, , cats]) => {
				const isCruise = !!(core?.trips || []).find((t) => t.name === trip)?.is_a_cruise_trip;
				// Senarai schedule hanya untuk trip cruise (syarat 1).
				const schedsReady = isCruise
					? tlinks('list_schedules').catch(() => [])
					: Promise.resolve([]);
				schedsReady.then((schedules) => {
				const d = new frappe.ui.Dialog({
					title: isEdit ? 'Edit Travel Date' : 'New Travel Date',
				});
				// ── Format tarikh Travel Website ──
				// Alias helper kongsi (webDispFmt/webFmtDate) — definisi lama
				// dipindah ke skop atas (Nov 2026) supaya kad TRAVEL DATES &
				// modal maklumat tarikh ikut format yang sama.
				const dispFmt = webDispFmt;
				// Parse input bebas format → ISO 'YYYY-MM-DD' | null
				// (format laman primary; ISO/dd/mm/dd-mm/bulan penuh fallback).
				const parseWebDate = (val) => {
					const v = String(val || '').trim();
					if (!v) return null;
					if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
					const m = moment(v, [dispFmt(), 'DD/MM/YYYY', 'DD-MM-YYYY',
						'D MMMM YYYY', 'D MMM YYYY'], 'en');
					return m.isValid() ? m.format('YYYY-MM-DD') : null;
				};
				const fmtWebDate = webFmtDate;
				const dateExample = fmtWebDate(frappe.datetime.get_today());
				d.$body.html(`
					<div id="tm-td-dates" class="d-flex flex-wrap gap-3">
						<div style="flex:1;min-width:170px">
							<label class="control-label" for="tm-td-dep">Departure *</label>
							<div class="tm-td-date-wrap">
								<input class="form-control" id="tm-td-dep" type="text" autocomplete="off"
									placeholder="${esc(dateExample)}"
									value="${esc(existing?.departure_date ? fmtWebDate(existing.departure_date) : '')}">
								<button type="button" class="tm-td-pick" data-for="tm-td-dep"
									title="Pilih tarikh" aria-label="Pilih tarikh Departure">📅</button>
							</div>
						</div>
						<div style="flex:1;min-width:170px">
							<label class="control-label" for="tm-td-ret">Return</label>
							<div class="tm-td-date-wrap">
								<input class="form-control" id="tm-td-ret" type="text" autocomplete="off"
									placeholder="${esc(dateExample)}"
									value="${esc(existing?.return_date ? fmtWebDate(existing.return_date) : '')}">
								<button type="button" class="tm-td-pick" data-for="tm-td-ret"
									title="Pilih tarikh" aria-label="Pilih tarikh Return">📅</button>
							</div>
						</div>
						<input class="tm-td-native" id="tm-td-range-native" type="text"
							tabindex="-1" aria-hidden="true">
					</div>
					<div id="tm-td-dur" class="d-flex flex-wrap gap-3 mt-3">
						<div style="flex:0 0 120px">
							<label class="control-label" for="tm-td-days">Total Day</label>
							<input class="form-control form-control-sm" id="tm-td-days"
								type="number" min="0" step="1" placeholder="auto"
								value="${existing?.total_days || ''}">
						</div>
						<div style="flex:0 0 120px">
							<label class="control-label" for="tm-td-nights">Total Night</label>
							<input class="form-control form-control-sm" id="tm-td-nights"
								type="number" min="0" step="1" placeholder="auto"
								value="${existing?.total_nights || ''}">
						</div>
						<div class="flex-fill" style="min-width:200px">
							<label class="control-label" for="tm-td-dest">Destination</label>
							<input class="form-control form-control-sm" id="tm-td-dest"
								type="text" autocomplete="off"
								placeholder="cth: Istanbul, Turki"
								value="${esc(existing?.destination || '')}">
						</div>
					</div>
					<div class="text-muted text-small mt-1">Total Day/Night kosong →
						auto kira daripada Departure/Return</div>
					${isCruise ? `
					<div id="tm-td-sched-field" class="mt-3">
						<label class="control-label" for="tm-td-sched-name">Selected Cruise Schedule</label>
						<div class="d-flex gap-2 align-items-center">
							<input class="form-control" id="tm-td-sched-name" readonly
								placeholder="— belum dipilih —"
								value="${esc(existing?.cruise_schedule || '')}">
							<button type="button" class="btn btn-default btn-sm text-nowrap"
								id="tm-td-sched-clear" title="Clear cruise schedule"
								${existing?.cruise_schedule ? '' : 'style="display:none"'}>✕ Clear</button>
						</div>
						<div id="tm-td-sched-note" class="text-muted small mt-1" style="display:none"></div>
					</div>
					<div id="tm-td-sched-list" class="tm-sched-list mt-2"
						${existing?.cruise_schedule ? 'style="display:none"' : ''}>
						<div class="tm-sched-search d-flex align-items-center gap-2 p-2 border-bottom">
							<span class="text-muted text-small text-nowrap">Search:</span>
							<input class="form-control form-control-sm" id="tm-td-sched-q" type="text"
								placeholder="ship code atau tarikh pelayaran (YYYY-MM-DD)…">
						</div>
						<div id="tm-td-sched-hint" class="text-muted small px-2 pt-1" style="display:none"></div>
						<div id="tm-td-sched-rows"></div>
					</div>` : ''}
					<div id="tm-td-closure-field" class="mt-3">
						<label class="control-label" for="tm-td-closure">Closure (hari)</label>
						<div class="d-flex flex-wrap align-items-center gap-2">
							<input class="form-control form-control-sm" id="tm-td-closure"
								type="number" min="0" step="1" style="max-width:150px"
								value="${existing?.days_before_closure ?? ''}"
								placeholder="— tiada —">
							<span class="text-muted text-small">Hari sebelum tarikh tutup
								tempahan (≈ Departure − N hari); kosong = tiada</span>
						</div>
					</div>
					<div id="tm-td-cat-field" class="mt-3">
						<label class="control-label" for="tm-td-cat">Trip Category</label>
						<div class="d-flex flex-wrap align-items-center gap-2">
							<select class="form-control form-control-sm" id="tm-td-cat"
								style="max-width:220px" aria-label="Trip Category">
								<option value="">— tiada kategori —</option>
							</select>
							<span class="text-muted text-small">Master Trip Category —
								selenggara di Desk (/app/trip-category)</span>
						</div>
					</div>
					${isEdit ? `
					<div id="tm-td-status-field" class="mt-3">
						<label class="control-label" for="tm-td-status-sel">Status</label>
						<div class="d-flex flex-wrap align-items-center gap-2">
							<select class="form-control form-control-sm" id="tm-td-status-sel"
								style="max-width:150px" aria-label="Editorial status"
								${isManager ? '' : 'title="Active/Cancelled perlukan Tour Manager"'}>
								${TD_STATUSES.map((s) => `
									<option value="${s}" ${s === curStatus ? 'selected' : ''}${(!isManager && GATED_STATUS.includes(s)) ? ' disabled' : ''}>${s}</option>`).join('')}
							</select>
							${isManager ? '' : `
							<span class="text-muted text-small">Active/Cancelled — Tour Manager sahaja</span>`}
						</div>
					</div>` : ''}
				`);
				// Dropdown Trip Category — DITAPIS ikut jenis trip (Nov 2026,
				// checkbox is_cruise_trip pada master): trip cruise → kategori
				// bertanda sahaja; trip darat → kategori TIDAK bertanda sahaja.
				// Nilai tersimpan KEKAL dipapar walaupun di luar skop (rekod
				// lama / tanda master berubah kemudian) — elak reset senyap
				// semasa buka dialog (corak addedCur senarai schedule).
				const curCat = existing?.trip_category || '';
				const $catSel = d.$body.find('#tm-td-cat');
				const curCatObj = (cats || []).find((c) => c.name === curCat);
				const catInScope = (c) =>
					(c.is_cruise_trip ? 1 : 0) === (isCruise ? 1 : 0);
				const scopedCats = (cats || []).filter(catInScope);
				if (curCatObj && !scopedCats.some((c) => c.name === curCat)) {
					scopedCats.push(curCatObj);
				}
				$catSel.empty().append('<option value="">— tiada kategori —</option>');
				scopedCats.forEach((c) => $catSel.append($('<option>', {
					value: c.name,
					// Nilai di luar skop ditandakan — isyarat ketidakpadanan.
					text: (c.category_name || c.name)
						+ (c === curCatObj && !catInScope(c)
							? ' (kategori ' + (isCruise ? 'darat' : 'cruise') + ')'
							: ''),
				})));
				$catSel.val(curCat);
				// Baca medan tarikh → ISO (TANPA ubah apa user taip; null
				// bila kosong / format tidak dikenali).
				const valISO = (sel) => parseWebDate(d.$body.find(sel).val());
				// Normalize semasa blur/change: sah → tulis semula dalam
				// format laman; tidak sah → border merah (dilapor di Save).
				const normalizeDateInput = (sel) => {
					const $el = d.$body.find(sel);
					const raw = String($el.val() || '').trim();
					if (!raw) { $el.removeClass('tm-date-invalid'); return null; }
					const iso = parseWebDate(raw);
					if (iso) {
						$el.removeClass('tm-date-invalid');
						if (raw !== fmtWebDate(iso)) $el.val(fmtWebDate(iso));
					} else $el.addClass('tm-date-invalid');
					return iso;
				};
				// ── Durasi (Total Day/Night) — auto kira (arahan pemilik
				// Nov 2026): medan kosong diisi daripada Pergi+Pulang
				// (formula TGD trip_group_date: nights = beza tarikh,
				// days = nights + 1). Nilai yang DITAIP sendiri dihormati
				// (bendera touched); nilai tersimpan yang SAMA dengan
				// auto dianggap nilai auto (ikut tarikh semula), yang
				// BEZA → override manual dikekalkan.
				const durAuto = () => {
					const dv = valISO('#tm-td-dep');
					const rv = valISO('#tm-td-ret');
					if (!dv || !rv || rv < dv) return null;
					const nights = moment(rv).diff(moment(dv), 'days');
					return { days: nights + 1, nights };
				};
				const durTouched = { days: false, nights: false };
				const $durDays = d.$body.find('#tm-td-days');
				const $durNights = d.$body.find('#tm-td-nights');
				const initDur = ($el, key) => {
					const cur = parseInt($el.val(), 10) || 0;
					const auto = durAuto();
					if (!cur || !auto || cur === auto[key]) return;
					durTouched[key] = true;
				};
				initDur($durDays, 'days');
				initDur($durNights, 'nights');
				const syncDur = () => {
					const auto = durAuto();
					if (!auto) return;
					if (!durTouched.days) $durDays.val(auto.days);
					if (!durTouched.nights) $durNights.val(auto.nights);
				};
				// ── Senarai schedule (cruise sahaja) + penapis ──
				// [Nov 2026] Senarai dipaparkan: status Active sahaja & sailing
				// MASIH HADAPAN (sail_end ≥ hari ini), had 10 baris. Penapis
				// inline (satu input teks): padankan ship_code ATAU tarikh
				// dalam lingkungan sailing (sail_start ≤ q ≤ sail_end bila q
				// berformat tarikh; sebaliknya substring ship/kod). Auto-filter
				// 2.a kekal: Pergi & Pulang diisi → sailing mesti DI DALAM
				// lingkungan Pergi→Pulang. Senarai DISEMBUNYIKAN bila schedule
				// sudah dipilih (Clear memaparkannya semula).
				const today = frappe.datetime.get_today();
				// Render semula SENYAP bila penapis tak berubah — blur medan
				// tarikh tidak boleh memusnahkan baris yang sedang diklik
				// (klik hilang jika baris diganti antara mousedown/mouseup).
				let lastSchedSig = null;
				const renderSchedList = () => {
					const dep = valISO('#tm-td-dep');
					const ret = valISO('#tm-td-ret');
					const q = (d.$body.find('#tm-td-sched-q').val() || '').trim();
					const sig = [dep, ret, q].join('|');
					if (sig === lastSchedSig
						&& d.$body.find('#tm-td-sched-rows').children().length) return;
					lastSchedSig = sig;
					const isDateQ = /^\d{4}-\d{2}-\d{2}$/.test(q);
					const all = schedules || [];
					let rows = all.filter((s) => {
						if (s.status !== 'Active') return false;
						if (String(s.sail_end || '') < today) return false;
						const ss = String(s.sail_start || '');
						const se = String(s.sail_end || '');
						if (q && isDateQ) return ss <= q && se >= q;
						if (q) {
							const hay = [s.ship_code, s.ship_name, s.schedule_code,
								ss, se].join(' ').toLowerCase();
							if (!hay.includes(q.toLowerCase())) return false;
						}
						if (dep && ret) return ss >= dep && se <= ret;
						return true;
					});
					const total = rows.length;
					// Edit mode: schedule SEMASA dipaut mesti kekal boleh
					// dipilih walaupun statusnya bukan Active/hadapan —
					// kalau tidak, Clear → Save akan memutuskan pautan
					// secara senyap. Baris ini di-highlight (table-primary).
					const curLinked = (existing?.cruise_schedule || '').trim();
					const curS = curLinked && !q
						? (all.find((s) => s.name === curLinked) || null) : null;
					const addedCur = !!(curS && !rows.some((s) => s.name === curLinked));
					if (addedCur) rows.unshift(curS);
					rows = rows.slice(0, 10);
					const $hint = d.$body.find('#tm-td-sched-hint');
					let hint = '';
					if (dep && ret) {
						hint += `sailing dalam lingkungan ${fmtWebDate(dep)} `
							+ `→ ${fmtWebDate(ret)} · `;
					}
					hint += `${rows.length} daripada ${total + (addedCur ? 1 : 0)} schedule (Active & hadapan)`;
					$hint.text(hint).show();
					d.$body.find('#tm-td-sched-rows').html(rows.length ? `
						<table class="table table-sm mb-0 table-hover">
							<thead><tr><th>Ship Code</th><th>Sailing Date</th></tr></thead>
							<tbody>${rows.map((s) => `
								<tr class="tm-td-sched pointer ${s.name === curLinked ? 'table-primary' : ''}"
									data-name="${esc(s.name)}"
									title="${esc(s.ship_name || '')} · ${esc(s.status || '')}${s.name === curLinked ? ' · (semasa dipaut)' : ''}">
									<td><strong>${esc(s.ship_code || s.schedule_code || s.name)}</strong></td>
									<td>${esc(fmtWebDate(s.sail_start))} → ${esc(fmtWebDate(s.sail_end))}</td>
								</tr>`).join('')}</tbody>
						</table>`
						: '<p class="text-muted small p-2 mb-0">Tiada schedule Active dalam lingkungan ini.</p>');
				};
				// Sync: schedule dipilih → senarai DISEMBUNYIKAN + butang Clear
				// dipapar + nota kecil tarikh pelayaran (start → end, format
				// laman); kosong → senarai dipapar semula, nota disembunyi.
				const syncSchedUI = () => {
					const cur = d.$body.find('#tm-td-sched-name').val();
					d.$body.find('#tm-td-sched-clear').toggle(!!cur);
					d.$body.find('#tm-td-sched-list').toggle(!cur);
					const $note = d.$body.find('#tm-td-sched-note');
					const s = cur ? (schedules || []).find((x) => x.name === cur) : null;
					if (s) {
						$note.text(`Sailing: ${fmtWebDate(s.sail_start)} → ${fmtWebDate(s.sail_end)}`).show();
					} else $note.hide();
					if (!cur) renderSchedList();
				};
				syncSchedUI();
				// ── Date RANGE selector (AirDatepicker — lib stok frappe):
				// aktif semasa FOCUS medan Pergi/Pulang (atau butang 📅);
				// mod julat — pilihan pertama → Departure, kedua → Return;
				// ditulis dalam format laman. Input native disorok dipindah
				// ke wrap medan difokus supaya kalendar sejajar medan.
				// v3 TIADA close-on-outside-click — didengar sendiri di bawah.
				const rangeNative = d.$body.find('#tm-td-range-native')[0];
				let rangeDP = null;
				const closeRange = () => {
					if (rangeDP) rangeDP.hide();
					$(document).off('mousedown._tmrange keydown._tmrange');
				};
				const openRangePicker = ($wrap) => {
					if (!rangeNative || !$wrap.length) return;
					if (rangeDP) { rangeDP.destroy(); rangeDP = null; }
					$wrap[0].appendChild(rangeNative);
					rangeDP = new AirDatepicker(rangeNative, {
						range: true,
						autoClose: false,
						position: 'bottom',
						container: $wrap[0],
						// locale OBJECT frappe (string 'en' tidak didaftarkan
						// dalam build v3 — constructor throw).
						locale: frappe.ui.form.get_datepicker_locale(),
						keyboardNav: false,
						toggleSelected: false,
						dateFormat: (date) => Array.isArray(date)
							? date.map((x) => moment(x).format(dispFmt())).join(' → ')
							: moment(date).format(dispFmt()),
						buttons: ['clear'],
						onSelect: ({date}) => {
							// v3 range: `date` = array tarikh terpilih
							const arr = Array.isArray(date) ? date
								: (date ? [date] : []);
							if (!arr.length) {
								// butang Clear pada kalendar
								d.$body.find('#tm-td-dep, #tm-td-ret')
									.val('').removeClass('tm-date-invalid');
							} else {
								d.$body.find('#tm-td-dep')
									.val(fmtWebDate(arr[0]))
									.removeClass('tm-date-invalid');
								d.$body.find('#tm-td-ret')
									.val(arr[1] ? fmtWebDate(arr[1]) : '')
									.removeClass('tm-date-invalid');
							}
							syncDur(); // auto kira durasi ikut tarikh baharu
							lastSchedSig = null;
							if (!d.$body.find('#tm-td-sched-name').val()) {
								renderSchedList();
							}
							if (arr.length >= 2) closeRange();
						},
					});
					// Praset kalendar daripada nilai medan semasa (senyap).
					const dep = valISO('#tm-td-dep');
					const ret = valISO('#tm-td-ret');
					try {
						if (dep && ret) {
							rangeDP.selectDate(
								[moment(dep).toDate(), moment(ret).toDate()],
								{silent: true});
						} else if (dep) {
							rangeDP.selectDate(moment(dep).toDate(), {silent: true});
						}
						rangeDP.setViewDate(moment(dep || ret
							|| frappe.datetime.get_today()).toDate());
					} catch (e) { /* praset gagal — kalendar dari hari ini */ }
					// Tutup kalendar bila klik/Escape di luar kalendar & medan
					// (v3 tidak lakukan ini secara default).
					$(document).off('mousedown._tmrange keydown._tmrange')
						.on('mousedown._tmrange', (e) => {
							if ($(e.target).closest(rangeDP.$datepicker).length
								|| $(e.target).closest(
									'#tm-td-dep, #tm-td-ret, .tm-td-pick').length) return;
							closeRange();
						})
						.on('keydown._tmrange', (e) => {
							if (e.key === 'Escape') closeRange();
						});
					rangeDP.show();
				};
				d.$body.on('focus', '#tm-td-dep, #tm-td-ret', function () {
					openRangePicker($(this).closest('.tm-td-date-wrap'));
				});
				d.$body.on('click', '.tm-td-pick', function () {
					openRangePicker($(this).closest('.tm-td-date-wrap'));
				});
				// Pilih schedule (2.b): bila Pergi/Pulang kosong/tidak sah —
				// amaran tulis-ganti; selepas pengesahan, Departure/Return
				// DIISI daripada sailing window schedule terpilih. Bila
				// tarikh SUDAH diisi — kekalkan nilai pengguna (tiada
				// tulis-ganti senyap).
				// MOUSEDOWN (bukan click): mousedown berlaku SEBELUM blur
				// medan tarikh → pilihan terselamat walaupun blur memicu
				// render semula senarai.
				d.$body.on('mousedown', '#tm-td-sched-rows .tm-td-sched', function () {
					const name = $(this).data('name');
					const dep = valISO('#tm-td-dep');
					const ret = valISO('#tm-td-ret');
					const fillDates = !dep || !ret;
					const pick = () => {
						d.$body.find('#tm-td-sched-name').val(name);
						const s = fillDates
							? (schedules || []).find((x) => x.name === name) : null;
							if (s) {
								if (s.sail_start) {
									d.$body.find('#tm-td-dep')
										.val(fmtWebDate(s.sail_start))
										.removeClass('tm-date-invalid');
								}
								if (s.sail_end) {
									d.$body.find('#tm-td-ret')
										.val(fmtWebDate(s.sail_end))
										.removeClass('tm-date-invalid');
								}
								lastSchedSig = null; // paksa render semula seterusnya
							}
							syncSchedUI();
							syncDur(); // tarikh diisi daripada sailing window
					};
					if (fillDates) {
						frappe.confirm(
							'Tarikh Pergi/Pulang masih kosong. Memilih cruise schedule '
							+ 'akan MENGISI Departure & Return daripada tarikh pelayaran '
							+ 'schedule DAN MENULIS-GANTI maklumat sailing (kapal, tarikh '
							+ 'pelayaran, port) pada travel date ini. Teruskan?',
							() => pick());
					} else pick();
				});
				// Butang Clear — kosongkan pilihan & papar senarai semula.
				d.$body.on('click', '#tm-td-sched-clear', () => {
					d.$body.find('#tm-td-sched-name').val('');
					syncSchedUI();
				});
				// Tarikh berubah → normalize paparan (blur) + kemas kini
				// senarai (bila schedule belum dipilih) + auto kira durasi.
				d.$body.find('#tm-td-dep, #tm-td-ret')
					.on('change blur', function () {
						normalizeDateInput('#' + this.id);
						if (!d.$body.find('#tm-td-sched-name').val()) renderSchedList();
						syncDur();
					});
				d.$body.find('#tm-td-sched-q')
					.on('input', frappe.utils.debounce(renderSchedList, 250));
				// ── Reset (syarat 3) — kosongkan borang & penapis ──
				const resetForm = () => {
					d.$body.find('#tm-td-dep, #tm-td-ret, #tm-td-sched-q')
						.val('');
					d.$body.find('#tm-td-dep, #tm-td-ret')
						.removeClass('tm-date-invalid');
					d.$body.find('#tm-td-sched-name').val('');
					// Durasi turut dikosongkan & kembali ke mod auto
					// (bendera touched reset — tarikh baharu auto isi).
					d.$body.find('#tm-td-days, #tm-td-nights').val('');
					durTouched.days = false;
					durTouched.nights = false;
					syncSchedUI();
				};
				d.set_secondary_action(resetForm);
				d.set_secondary_action_label(__('Reset'));
				d.set_primary_action(isEdit ? 'Save' : 'Create', async () => {
					// days_before_closure sengaja DIHANTAR HANYA bila medan
					// wujud (dialog lama) — nilai sedia ada kekal tidak disentuh
					// pada edit kerana save_travel_date hanya set medan dihantar.
					const depRaw = String(d.$body.find('#tm-td-dep').val() || '').trim();
					const retRaw = String(d.$body.find('#tm-td-ret').val() || '').trim();
					const dep = valISO('#tm-td-dep');
					const ret = valISO('#tm-td-ret');
					// ── VALIDASI format tarikh ──
					if (depRaw && !dep) {
						frappe.msgprint(`Departure "${depRaw}" bukan tarikh sah `
							+ `(contoh format: ${dateExample}).`);
						return;
					}
					if (retRaw && !ret) {
						frappe.msgprint(`Return "${retRaw}" bukan tarikh sah `
							+ `(contoh format: ${dateExample}).`);
						return;
					}
					if (!dep) {
						frappe.msgprint('Departure date is required.');
						return;
					}
					const schedName = d.$body.find('#tm-td-sched-name').val() || null;
					const sched = schedName
						? (schedules || []).find((x) => x.name === schedName) : null;
					// Trip cruise WAJIB ada schedule (selari validate()
					// controller Travel Date — elak error mentah server).
					if (isCruise && !schedName) {
						frappe.msgprint('Cruise Schedule diperlukan untuk '
							+ 'travel date trip cruise — pilih dari senarai.');
						return;
					}
					// ── VALIDASI lingkungan tarikh ──
					if (dep && ret && ret < dep) {
						frappe.msgprint(`Return (${fmtWebDate(ret)}) tidak boleh `
							+ `sebelum Departure (${fmtWebDate(dep)}).`);
						return;
					}
					if (sched && dep && ret) {
						const ss = String(sched.sail_start || '');
						const se = String(sched.sail_end || '');
						if (dep > ss || se > ret) {
							frappe.msgprint(`Lingkungan tarikh tidak sah — sailing `
								+ `schedule ${fmtWebDate(ss)} → ${fmtWebDate(se)} mesti `
								+ `berada DI DALAM lingkungan Departure → Return `
								+ `(${fmtWebDate(dep)} → ${fmtWebDate(ret)}).`);
							return;
						}
					}
					const values = {
						trip,
						departure_date: dep,
						return_date: ret || null,
						cruise_schedule: schedName,
					};
					// days_before_closure — medan Closure (dipaparkan semula
					// Nov 2026, SEBELUM Status). Sentiasa dihantar: kosong →
					// 0 (MEMBUANG closure sedia ada — selari nota "kosong =
					// tiada"); clamp ≥ 0 (doctype non_negative).
					const $closure = d.$body.find('#tm-td-closure');
					if ($closure.length) {
						const cv = parseInt($closure.val(), 10);
						values.days_before_closure =
							isNaN(cv) ? 0 : Math.max(0, cv);
					}
					// total_days/total_nights — Sentiasa dihantar: kosong →
					// 0 (server auto kira daripada tarikh — validate Travel
					// Date, formula TGD); clamp ≥ 0 (doctype non_negative).
					const dDays = parseInt($durDays.val(), 10);
					values.total_days = isNaN(dDays) ? 0 : Math.max(0, dDays);
					const dNights = parseInt($durNights.val(), 10);
					values.total_nights =
						isNaN(dNights) ? 0 : Math.max(0, dNights);
					// destination — Sentiasa dihantar (kosong = buang
					// destinasi tersimpan, selari trip_category).
					values.destination = String(
						d.$body.find('#tm-td-dest').val() || '').trim();
					// trip_category — dihantar HANYA bila berubah (kosong =
					// buang kategori; server set '' selari medan lain). Master
					// gagal dimuat (kosong) + ada nilai tersimpan → JANGAN
					// hantar (dropdown tak berupsyen — elak padam senyap).
					if (($catSel.val() || '') !== curCat
							&& ((cats || []).length || !curCat)) {
						values.trip_category = $catSel.val() || '';
					}
					if (isEdit) values.name = existing.name;
					// Status — dihantar HANYA bila berubah (dari ruang edit
					// dalam borang ini); gate manager diurus sisi server.
					const $statusSel = d.$body.find('#tm-td-status-sel');
					if ($statusSel.length && $statusSel.val()
							&& $statusSel.val() !== curStatus) {
						values.status_editorial = $statusSel.val();
					}
					try {
						const res = await api('save_travel_date', { values: JSON.stringify(values) });
						frappe.show_alert({ message: 'Travel date saved', indicator: 'green' });
						d.hide();
						onDone && onDone(res.name);
					} catch (e) { /* frappe already shows it */ }
				});
				d.show();
				});
			});
		}

		// ── Modal maklumat PENUH Travel Date (Nov 2026) — dipanggil dari
		// datatable TRAVEL DATES & OFFERS (klik baris). Susun atur (arahan
		// pemilik): baris 1 Departure→Return, baris 2 Group Date/Travel Date
		// ID/Closure/Status, baris 3 cruise sahaja (Sailing Date + Cruise
		// Schedule kod sahaja + Embarkation & Disembarkation) — nilai
		// Departure→Return & Sailing Date dalam format H3 TANPA style
		// custom (selari kad GROUP INFO), kemudian jadual Room Category
		// Capacity (dari payload rooming, selari kad Rooming halaman
		// tarikh) SEBELUM jadual pakej (Package Name/Currency/Status/Sold
		// — TANPA kiraan pakej). Medan Status = paparan badge SAHAJA —
		// edit status dibuat dalam BORANG EDIT Travel Date (dialog
		// travel_date_dialog, dibuka melalui butang Edit). Footer:
		// Footer: Close (paling kiri) · 🗑 Delete Date (manager — padam
		// group date + SEMUA offer anak, API delete_travel_date) ·
		// Edit · Open (primary, paling kanan).
		function travel_date_info_modal(trip, row, onDone) {
			const d = new frappe.ui.Dialog({
				title: 'Travel Date — '
					+ (row.departure_date ? webFmtDate(row.departure_date) : row.name),
				size: 'large',
			});
			d.$wrapper.addClass('tm-dim-modal');
			d.$body.html(loading());
			// Footer standard diperlukan supaya .modal-footer wujud — kandungan
			// diganti penuh oleh wireFooter() selepas detail termuat.
			d.set_primary_action(__('Close'), () => d.hide());
			let detail = null;
			const renderBody = () => {
				const dt = detail.date;
				const isCruise = !!dt.is_a_cruise_trip || !!dt.cruise_schedule;
				const offers = detail.offers || [];
				const roomingRows = detail.rooming || [];
				// Nilai tarikh utama — H3 tanpa style custom (selari baris
				// Departure Date kad GROUP INFO: d-block/break-words/
				// font-weight-bold/mb-0 semuanya utiliti stok).
				const h3Date = (label, valHtml) => `
					<div class="col-12">
						<span class="text-muted d-block">${label}</span>
						<h3 class="d-block break-words font-weight-bold mb-0">${valHtml}</h3>
					</div>`;
				d.$body.html(`
					${infoGrid('tm-dim-info', `
						${h3Date('Departure → Return',
							`${esc(webFmtDate(dt.departure_date))} → ${esc(webFmtDate(dt.return_date))}`)}
						${field('Group Date', `<span class="font-weight-normal">${esc(dt.travel_date_name || dt.name)}</span>`, 'col-6 col-lg-3')}
						${field('Travel Date ID', `<span class="text-monospace">${esc(dt.name)}</span>`, 'col-6 col-lg-3')}
						${field('Closure', `<strong>${dt.days_before_closure ? dt.days_before_closure + ' hari' : '—'}</strong>`, 'col-6 col-lg-3')}
						${field('Status', `<span data-dim-status>${badge(dt.status, DEP_COLOR[dt.status] || C.gray)}</span>`, 'col-6 col-lg-3')}
						${field('Durasi', `<strong>${esc(tmDurTxt(dt))}</strong>`, 'col-6 col-lg-3')}
						${field('Destination', esc(dt.destination || '—'), 'col-6 col-lg-3')}
						${isCruise ? h3Date('Sailing Date',
							`${esc(webFmtDate(dt.sailing_start))} → ${esc(webFmtDate(dt.sailing_end))}`) : ''}
						${isCruise ? field('Cruise Schedule', `<span class="text-monospace"><strong>${esc(dt.cruise_schedule || '—')}</strong></span>`, 'col-12 col-lg-6') : ''}
						${isCruise ? field('Embarkation & Disembarkation', `${esc(dt.embarkation_port || '—')} → ${esc(dt.disembarkation_port || '—')}`, 'col-12 col-lg-6') : ''}
					`)}
					${roomingRows.length ? `
					${secTitle('Room Category Capacity', '', 'mt-3')}
					<div class="overflow-auto">
					<table class="table table-sm table-hover m-0">
						<thead><tr><th>Room Category</th>
							<th class="text-right">Sold</th>
							<th class="text-right">Available</th></tr></thead>
						<tbody>${roomingRows.map((r) => `
							<tr>
								<td><strong>${esc(r.category_name || r.category_code)}</strong>
									<span class="text-muted text-small">${esc(r.category_code || '')}</span></td>
								<td class="text-right">${r.sold || 0}</td>
								<td class="text-right">${r.available ?? '—'}</td>
							</tr>`).join('')}</tbody>
					</table></div>` : ''}
					${secTitle('Packages on this date', '', 'mt-3')}
					${offers.length ? `
					<div class="overflow-auto">
					<table class="table table-sm table-hover m-0">
						<thead><tr><th>Package Name</th><th>Currency</th><th>Status</th>
							<th class="text-right">Sold</th></tr></thead>
						<tbody>${offers.map((o) => `
							<tr>
								<td><strong>${esc(o.package_name || '')}</strong>
									<span class="text-muted text-small">${esc(o.name)}</span></td>
								<td>${esc(o.currency || '—')}</td>
								<td>${badge(o.status_operational, OPE_COLOR[o.status_operational] || C.gray)}</td>
								<td class="text-right">${o.sold_pax || 0}</td>
							</tr>`).join('')}</tbody>
					</table></div>` : '<p class="text-muted small">Tiada pakej pada tarikh ini.</p>'}
				`);
			};
			// Footer (arahan pemilik): Close paling KIRI · Edit · Open
			// (primary) paling KANAN — butang ⚠ Cancel/Activate dibuang.
			const wireFooter = () => {
				d.$wrapper.find('.modal-footer').html(`
					<button class="btn btn-default btn-sm tm-dim-btn" data-act="close">Close</button>
					<div class="ml-auto d-flex gap-2">
						${isManager ? `
						<button class="btn btn-danger btn-sm tm-dim-btn" data-act="delete"
							title="Padam group date ini beserta SEMUA offer di bawahnya">🗑 Delete Date</button>` : ''}
						<button class="btn btn-default btn-sm tm-dim-btn" data-act="edit">Edit</button>
						<button class="btn btn-primary btn-sm tm-dim-btn" data-act="open">Open →</button>
					</div>
				`);
			};
			Promise.all([
				api('get_travel_date_detail', { travel_date: row.name }),
				webFmtLoad(),
			]).then(([res]) => {
				if (!res?.date) { d.hide(); return; }
				detail = res;
				renderBody();
				wireFooter();
			}).catch(() => { /* frappe already shows it */ });
			d.$wrapper.on('click', '.tm-dim-btn', function () {
				const act = $(this).data('act');
				if (act === 'open') {
					d.hide();
					frappe.set_route('travel-manager', 'trip', trip, 'date', row.name);
				} else if (act === 'edit') {
					d.hide();
					travel_date_dialog(trip, row, onDone);
				} else if (act === 'close') {
					d.hide();
				} else if (act === 'delete') {
					// [Nov 2026] Padam group date + SEMUA offer anaknya —
					// API delete_travel_date (guard booking aktif/pax
					// terjual di server; manager sahaja). Prompt sahkan
					// nama, corak sama butang Delete Date halaman tarikh.
					const nOffers = (detail?.offers || []).length;
					frappe.prompt(
						[
							{
								fieldname: 'confirm_name', fieldtype: 'Data',
								label: `Taip <strong>${esc(row.name)}</strong> untuk sahkan pemadaman`,
								reqd: 1,
								description: `Akan DIPADAM SELAMANYA: group date ${esc(row.name)} `
									+ `(${esc(row.departure_date || '')}) beserta ${nOffers} offer(s) `
									+ `dan harga/komponennya. Trip dan tarikh-tarikh lain kekal. `
									+ `Booking aktif akan MENYEKAT pemadaman.`,
							},
						],
						(values) => {
							if ((values.confirm_name || '').trim() !== row.name) {
								frappe.msgprint('Nama tarikh tidak sepadan — pemadaman dibatalkan.');
								return;
							}
							api('delete_travel_date', { travel_date: row.name })
								.then((res) => {
									frappe.show_alert({
										message: `Group date ${row.name} dipadam `
											+ `(${res.deleted.offers} offers)`,
										indicator: 'red',
									});
									d.hide();
									if (onDone) onDone();
								})
								.catch(() => { /* frappe already shows it */ });
						},
						__('🗑 Delete Date Group — tidak boleh dibatalkan'),
					);
				}
			});
			d.show();
		}
