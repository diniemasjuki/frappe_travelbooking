	/* ════════════════════════════════════════════════════════════════════
	   SUB-PAKEJ: HELPER KONGSI (tm_shared.js)
	   ════════════════════════════════════════════════════════════════════
	   Helper & komponen UI kongsi untuk SEMUA seksyen travel-manager.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   
	   KANDUNGAN:
	   • esc/api/tlinks/tmg/hub/tcc — escape & panggilan API (whitelist).
	   • badge, C, DEP_COLOR/OPE_COLOR/BKG_COLOR, money, fmtNum, titleCase.
	   • card / tmTable / tmDataTable — kad panel & jadual interaktif
	     (carian, penapis, saiz halaman & pagination client-side).
	   • loading / secTitle / field / infoGrid / makeLink — helper UI stok.
	   • ITIN_SEGMENTS / itineraryDayDialog / itineraryOverrideCard —
	     kad itinerary "reuse + checkbox overwrite" (date & offer).
	   • tripInfoCardHtml / groupInfoCardHtml — panel info kongsi
	     (dipakai date/package/directory/sales/website; footer navigasi
	     Details | Website | Sales diurus oleh handler delegated shell —
	     aktif & keterlihatan footer ditentukan daripada URL semasa).
	   • fetchTripNav / tripNavRowHtml / wireTripNavRow / deleteTripDialog
	     — nav row aras trip #tm-trip-navrow kongsi 3 halaman (directory /
	     website / sales — navigasi "same level" serupa).
	   ════════════════════════════════════════════════════════════════════ */

		const esc = (v) => frappe.utils.escape_html(v ?? '');
		const api = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.package_admin.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		const tlinks = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.trip_links.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		// trip_manager endpoints use a `payload: dict` annotation — send as a
		// JSON body (use_json) so the server receives a real dict, not a string.
		const tmg = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.trip_manager.' + method, args,
				quiet: true, use_json: true })
				.then(r => r?.message ?? null);
		const hub = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.booking_hub.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		const tcc = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.trip_command_center.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		// Direktori Customer (Nov 2026) — travel_booking.api.customer_admin.
		const cst = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.customer_admin.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		// Direktori Traveller (Nov 2026) — travel_booking.api.traveller_admin.
		const tva = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.traveller_admin.' + method, args, quiet: true })
				.then(r => r?.message ?? null);
		// Senarai flat Booking/Addon (Nov 2026) — travel_booking.api.
		// manage_trip_booking (corak helper BookingManagement, scope shell).
		const mtb = (method, args = {}) =>
			frappe.call({ method: 'travel_booking.api.manage_trip_booking.' + method, args, quiet: true })
				.then(r => r?.message ?? null);

		const badge = (label, color) =>
			`<span class="badge" style="background:${color}18;color:${color};
				border:1px solid ${color}55;font-weight:600">${esc(label)}</span>`;
		const C = {
			gray: '#6b7280', green: '#15803d', orange: '#b45309', red: '#b91c1c', blue: '#1d4ed8',
		};
		const DEP_COLOR = { Draft: C.gray, 'Pending Review': C.orange, Active: C.green, Retired: C.gray };
		const OPE_COLOR = { Scheduled: C.blue, Running: C.orange, Sailing: C.orange,
			Full: C.red, Closed: C.gray, Completed: C.green };
		const BKG_COLOR = { Pending: C.orange, Accepted: C.blue, Processing: C.blue,
			Confirmed: C.green, Completed: C.green, Abandoned: C.gray, Cancelled: C.red };
		const money = (n) => 'RM ' + parseFloat(n || 0).toLocaleString('en-MY',
			{ minimumFractionDigits: 2, maximumFractionDigits: 2 });
		// Numbers only, without a currency symbol ("from" prices can be
		// MYR/SGD depending on the package).
		const fmtNum = (n) => parseFloat(n || 0).toLocaleString('en-MY',
			{ maximumFractionDigits: 2 });
		// Small title-case helper for axis names — JS has no String.title().
		const titleCase = (s) => String(s).replace(/(^|[\s_-])([a-z])/g,
			(m, a, b) => a + b.toUpperCase());

		// Kad panel — KOMPONEN STOK Bootstrap: .card + .card-header +
		// .card-body (+ .card-footer opsional). Semua panggilan card() guna
		// span=12 → susunan menegak penuh; parameter span dikekalkan untuk
		// keserasian panggilan. Body = .card-body Bootstrap (observer beri
		// margin praktis my-2 kepada div kosong anak terus).
		// footerClass (opsional) — utiliti tambahan pada .card-footer
		// (cth. 'p-0' kad TRIP INFORMATION — footer direktori melekat
		// rapat ke tepi kad, arahan pemilik Nov 2026).
		const card = (span, title, inner, footerHtml, footerClass, bodyClass) => `
			<div class="card mb-3">
				${title ? `<div class="card-header d-flex flex-wrap align-items-center gap-2 text-body">${title}</div>` : ''}
				<div class="card-body ${bodyClass || ''}">${inner || ''}</div>
				${footerHtml ? `<div class="card-footer ${footerClass || ''}">${footerHtml}</div>` : ''}
			</div>`;
		// Jadual listing seragam — komponen stok .table.table-sm, margin
		// bawah dibuang (mb-0) supaya melekat rapat dalam kad. tableClass
		// (opsyenal) — kelas tambahan pada <table> (cth. m-0 kad Travel
		// Date wizard — arahan pemilik Nov 2026).
		const tmTable = (headers, rowsHtml, emptyMsg, tableClass) => rowsHtml ? `
			<table class="table table-sm table-hover mb-0 ${tableClass || ''}">
				<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
				<tbody>${rowsHtml}</tbody>
			</table>`
			: `<p class="text-muted small mt-2 mb-0">${esc(emptyMsg || 'No records.')}</p>`;
		// ── tmDataTable (Nov 2026): jadual listing interaktif stok Bootstrap
		// — carian, penapis (pilihan), saiz halaman (lalai 10) & pagination
		// client-side. `rows` = array objek data; headers = array string ATAU
		// objek {text, cls} (cls = kelas <th>, cth. 'text-center' — Nov 2026);
		// rowHtml(row) → <tr> HTML
		// penuh (baris klik dsb. diurus pemanggil melalui delegasi $body).
		// searchIn(row) → teks gabungan utk carian; filterOf(row) → nilai
		// penapis (dipadankan dgn <option> filterOptions); sortVal(row)
		// mengawal susunan (asc). Render semula hanya <tbody> + pager.
		// EXT (Nov 2026 — trip sales): option opsional tambahan,
		// backward-compatible (call-site sedia ada tiada perubahan):
		//   filters: [{key, label, of(row)}] — pelbagai select penapis;
		//     opsyen auto-terbit daripada nilai berbeza of(row). Bila
		//     dibekalkan, select penapis legacy single TIDAK dirender.
	//   sortable: [{key, val(row)} | null, ...] — array SELARI dgn
	//     headers; kolum berkenaan boleh diklik (asc → desc → …).
	//     Indikator ▲/▼ pada header aktif; bila tiada kolum dipilih,
	//     susunan lalai kekal sortVal(row) asc.
	//   headers entry {raw: html} (EXT Nov 2026 — Package Offers):
	//     kolum header HTML mentah TANPA esc (checkbox select-all).
	//   groupOf: (row) => kunci kumpulan (EXT Nov 2026 — Package Offers):
	//     bila dibekalkan, baris DIKUMPUL — susunan group-first: kumpulan
	//     disusun naik (localeCompare kunci), sort kolum BERLAKU DALAM
	//     kumpulan sahaja. Header kumpulan disisipkan semasa render
	//     SAHAJA — tidak dikira dalam kiraan rekod/pagination.
	//   groupHeaderHtml: (groupVal, firstRow, count) → <tr> HTML penuh
	//     utk baris header kumpulan (count = bil. baris kumpulan dalam
	//     senarai TERFILTER). Kumpulan kosong (''/null) tiada header.
	//     Default fallback: <tr class="table-light"> dgn kunci kumpulan.
		//   footer: true — select saiz halaman & pagination (navigasi
		//     jadual) dipindahkan ke .card-footer kad (dicipta jika belum
		//     ada), bukan inline bawah jadual. Toolbar kekal: carian +
		//     penapis + kiraan rekod. (EXT Nov 2026 — kad TRAVEL DATES.)
		//   serverSearch: async (q) => rows (EXT Nov 2026 — Customer):
		//     carian dijalankan DI SERVER (volume rekod tinggi — cth
		//     direktori Customer auto-bertambah dari portal setiap emel
		//     baharu). Input carian terbina memanggil fungsi ini
		//     (debounce 400ms) dan mengganti kandungan `rows` IN-PLACE +
		//     render semula; penapis carian klien (st.q) dilangkau kerana
		//     baris sudah ditapis server. Sort/pagination/penapis multi
		//     KECAL client-side atas set hasil.
		//   persistKey: 'kunci-localStorage' (EXT Nov 2026 — Customer):
		//     butang "▦ Columns ▾" muncul dalam toolbar — checkbox per
		//     kolum (label daripada headers {text}); kolum tersorok
		//     dibuang daripada thead & nth <td> disembunyikan (utiliti
		//     .tm-dt-colhide); colspan baris header kumpulan dilaraskan.
		//     Pilihan di-persist dalam localStorage ikut kunci.
		const tmDataTable = (mount, rows, opts) => {
			const o = Object.assign({ pageSize: 10, pageSizeOptions: [10, 25, 50],
				pageSizesLabel: 'Per page', searchPlaceholder: 'Search…',
				filterLabel: 'All', emptyMsg: 'No records.' }, opts || {});
				const st = { q: '', filter: '', mf: {}, page: 1, size: o.pageSize,
					sortKey: null, sortDir: 1 };
				// ── EXT column-toggle (persistKey): kolum tersorok ikut
				// INDEKS headers (paralel dgn sortable); di-persist dalam
				// localStorage. Header {raw} tiada label → tiada checkbox.
				const colHide = new Set();
				const colLabels = (o.headers || []).map((h) => {
					const item = (h && typeof h === 'object') ? h : {text: h};
					return item.text ?? null;
				});
				if (o.persistKey) {
					try {
						(JSON.parse(localStorage.getItem(o.persistKey) || '[]') || [])
							.forEach((i) => colHide.add(parseInt(i, 10)));
					} catch (e) { /* localStorage rosak — abaikan */ }
				}
				const colPersist = () => {
					if (!o.persistKey) return;
					try {
						localStorage.setItem(o.persistKey, JSON.stringify([...colHide]));
					} catch (e) { /* storage penuh/private — abaikan */ }
				};
			const filtered = () => rows.filter((r) => {
				// serverSearch: baris SUDAH ditapis server (st.q tidak
				// di-set) — langkau penapis carian klien; searchIn
				// mungkin tidak dibekalkan pemanggil.
				const hit = o.serverSearch || !st.q
					|| (o.searchIn(r) || '').toLowerCase()
						.includes(st.q.toLowerCase());
				const okF = !o.filters && st.filter && o.filterOf
					? o.filterOf(r) === st.filter : true;
				const okM = !(o.filters || []).some((f) =>
					st.mf[f.key] && f.of(r) !== st.mf[f.key]);
				return hit && okF && okM;
			}).sort((a, b) => {
				// Group-first (EXT groupOf): kumpulan disusun naik ikut
				// kunci — sort kolum hanya DALAM kumpulan.
				if (o.groupOf) {
					const ga = o.groupOf(a), gb = o.groupOf(b);
					if (ga !== gb) return ga < gb ? -1 : ga > gb ? 1 : 0;
				}
				const sc = (o.sortable || []).find((s) => s && s.key === st.sortKey);
				// Tiada sortVal & tiada kolum sortable aktif → comparator 0
				// (sort stabil ES2019+ kekalkan susunan asal rows) — elak
				// TypeError "gv is not a function" untuk pemanggil tanpa
				// sortVal (cth. datatable FAQ).
				const gv = sc ? sc.val : (o.sortVal || (() => 0));
				const va = gv(a), vb = gv(b);
				return (va < vb ? -1 : va > vb ? 1 : 0) * (sc ? st.sortDir : 1);
			});
			const $m = $(mount);
			// Select saiz halaman — footer mode diberi max-width (form-control
			// default width:100% → meregang penuh dalam footer yang lapang).
			const sizeSelect = (maxWidth) => `
				<select class="form-control form-control-sm tm-dt-size"
					${maxWidth ? `style="max-width:${maxWidth}px"` : ''}
					aria-label="Rows per page">
					${o.pageSizeOptions.map((n) => `
						<option value="${n}" ${n === st.size ? 'selected' : ''}>${n}</option>`).join('')}
				</select>`;
			$m.html(`
				<div class="tm-dt-toolbar d-flex flex-wrap gap-2 align-items-center mb-2">
					<input class="form-control form-control-sm tm-dt-search"
						style="max-width:220px" placeholder="${esc(o.searchPlaceholder)}"
						aria-label="Search table">
					${o.persistKey ? `
					<div class="tm-dt-cols-wrap">
						<button type="button" class="btn btn-sm btn-outline-secondary tm-dt-cols-btn"
							aria-expanded="false" title="Pilih kolum paparan">
							<span aria-hidden="true">▦</span>
							<span class="d-none d-lg-inline">Columns</span>
							<span aria-hidden="true">▾</span>
						</button>
						<div class="tm-dt-cols"></div>
					</div>` : ''}
					${o.filters ? o.filters.map((f) => `
						<select class="form-control form-control-sm tm-dt-mf" data-key="${esc(f.key)}"
							style="max-width:190px" aria-label="${esc(f.label)}">
							<option value="">${esc(f.label)}</option>
						</select>`).join('')
					: `
					<select class="form-control form-control-sm tm-dt-filter"
						style="max-width:160px" aria-label="Filter table">
						<option value="">${esc(o.filterLabel)}</option>
					</select>`}
					<span class="tm-dt-count text-muted text-small ml-auto"></span>
					${o.footer ? '' : sizeSelect()}
				</div>
				<div class="tm-dt-body overflow-auto">${o.emptyTableHtml || ''}</div>
				${o.footer ? ''
					: '<div class="tm-dt-pager d-flex flex-wrap align-items-center gap-2 mt-2"></div>'}
			`);
			// Footer mode — select saiz halaman + pager diletakkan dalam
			// .card-footer kad (dicipta jika kad belum ada footer). Scope
			// carian/delegasi diperluas ke kad kerana elemen berkenaan
			// berada LUAR mount div (dalam card-footer).
			// Kandungan TANPA kad (tab pane — Nov 2026, arahan pemilik):
			// tiada .card leluhur → footer dibina DALAM mount selepas jadual.
			const $cardEl = o.footer ? $m.closest('.card') : null;
			const $scope = o.footer && $cardEl && $cardEl.length ? $cardEl : $m;
			if (o.footer) {
				let $footer;
				if ($cardEl && $cardEl.length) {
					$footer = $cardEl.find('.card-footer').length
						? $cardEl.find('.card-footer').first()
						: $('<div class="card-footer"></div>').insertAfter($cardEl.find('.card-body'));
				} else {
					$footer = $m.find('.card-footer').first();
					if (!$footer.length) {
						$footer = $('<div class="card-footer"></div>');
						$m.children('.tm-dt-body').last().after($footer);
					}
				}
				$footer.addClass('d-flex flex-wrap align-items-center gap-2')
					.append(`<span class="text-muted text-small">${esc(o.pageSizesLabel)}</span>`)
					.append(sizeSelect(110))
					.append('<div class="tm-dt-pager d-flex flex-wrap align-items-center gap-2 ml-auto"></div>');
			}
			const filterSel = $m.find('.tm-dt-filter');
			if (filterSel.length && o.filterOf) {
				const uniqFilters = [...new Set(rows.map((r) => o.filterOf(r)).filter(Boolean))];
				uniqFilters.sort().forEach((f) => filterSel.append(
					$('<option>', { value: f, text: f })));
			}
			// Opsyen select multi-penis — nilai berbeza of(row), disusun.
			$m.find('.tm-dt-mf').each(function () {
				const key = $(this).data('key');
				const f = (o.filters || []).find((x) => x.key === key);
				if (!f) return;
				[...new Set(rows.map((r) => f.of(r)).filter(Boolean))].sort()
					.forEach((v) => $(this).append(
						$('<option>', { value: v, text: v })));
			});
			const renderPage = () => {
				const list = filtered();
				const pages = Math.max(1, Math.ceil(list.length / st.size));
				if (st.page > pages) st.page = pages;
				const slice = list.slice((st.page - 1) * st.size, st.page * st.size);
			$m.find('.tm-dt-body').html(slice.length
				? `<table class="table table-sm mb-0 table-hover">
						<thead><tr>${o.headers.map((h, i) => {
						// Header: string ATAU objek {text, cls} — cls untuk
						// penjajaran/kelas tambahan pada <th> (Nov 2026).
						// {raw: html} (EXT Nov 2026 — Package Offers):
						// HTML mentah TANPA esc — pemanggil dalaman page
						// sahaja (cth. checkbox select-all di header).
							const item = (h && typeof h === 'object') ? h : {text: h};
							// EXT column-toggle: kolum tersorok DIBUANG
							// daripada thead (indeks kekal paralel dgn
							// sortable — pemetaan tak terjejas).
							if (o.persistKey && colHide.has(i)) return '';
							const hcls = item.cls ? ` class="${item.cls}"` : '';
							const sc = o.sortable ? o.sortable[i] : null;
						if (item.raw) return `<th${hcls}>${item.raw}</th>`;
						if (!sc) return `<th${hcls}>${esc(item.text)}</th>`;
						const on = st.sortKey === sc.key;
						return `<th class="tm-dt-sortable${on ? ' tm-dt-sorted' : ''}${item.cls ? ' ' + item.cls : ''}"
							data-key="${esc(sc.key)}" style="cursor:pointer;user-select:none"
							title="Klik untuk susun">${esc(item.text)}${on
								? (st.sortDir === 1 ? ' <span class="text-muted">▲</span>'
									: ' <span class="text-muted">▼</span>') : ''}</th>`;
					}).join('')}</tr></thead>
						<tbody>${(() => {
						// Sisip baris header kumpulan (EXT groupOf): pada
						// baris pertama setiap kumpulan DALAM muka surat ini
						// (header sentiasa muncul di atas setiap muka surat)
						// — baris header TIDAK dikira dalam pagination/
						// kiraan rekod. Kumpulan kosong tiada header.
						let prevG = null;
						return slice.map((r) => {
							const g = o.groupOf ? o.groupOf(r) : null;
							let head = '';
							if (o.groupOf && g && g !== prevG) {
								const n = list.filter(
									(x) => o.groupOf(x) === g).length;
								head = o.groupHeaderHtml
									? o.groupHeaderHtml(g, r, n)
									: `<tr class="table-light"><td colspan="${o.headers.length}">${esc(g)}</td></tr>`;
							}
							prevG = g;
							return head + o.rowHtml(r);
						}).join('');
					})()}</tbody></table>`
				: `<p class="text-muted small my-2">${esc(o.emptyMsg)}</p>`);
				// EXT column-toggle — sorok nth <td>: rowHtml pemanggil
				// jana SEMUA kolum, jadi kolum tak nampak disembunyikan di
				// sini; baris header kumpulan (satu td colspan) cukup
				// dilaraskan colspannya ke bilangan kolum tampak.
				if (o.persistKey && colHide.size && slice.length) {
					$m.find('.tm-dt-body tbody tr').each(function () {
						const tds = $(this).children('td');
						if (tds.length === 1 && tds.first().attr('colspan')) {
							tds.first().attr('colspan',
								Math.max(1, o.headers.length - colHide.size));
							return;
						}
						tds.each((ci, td) =>
							$(td).toggleClass('tm-dt-colhide', colHide.has(ci)));
					});
				}
				$m.find('.tm-dt-count').text(
					`${list.length} record${list.length === 1 ? '' : 's'}`);
				const pageBtn = (p, label, disabled, active) => `
					<li class="page-item ${disabled ? 'disabled' : ''} ${active ? 'active' : ''}">
						<a class="page-link tm-dt-page" href="javascript:void(0)"
							data-page="${p}">${label}</a></li>`;
				let btns = pageBtn(st.page - 1, '‹', st.page <= 1);
				const win = [];
				for (let p = 1; p <= pages; p++) {
					if (p === 1 || p === pages || Math.abs(p - st.page) <= 1) win.push(p);
				}
				let last = 0;
				win.forEach((p) => {
					if (p - last > 1) btns += pageBtn(0, '…', true);
					btns += pageBtn(p, p, false, p === st.page);
					last = p;
				});
				btns += pageBtn(st.page + 1, '›', st.page >= pages);
				$scope.find('.tm-dt-pager').html(pages > 1 ? `
					<ul class="pagination pagination-sm mb-0">${btns}</ul>
					<span class="text-muted text-small">Page ${st.page} / ${pages}</span>` : '');
			};
			// EXT serverSearch — input carian memanggil server (debounce
			// 400ms), mengganti kandungan `rows` in-place; input dikunci
			// seketika supaya query bertindih tidak race.
			$m.find('.tm-dt-search').on('input', frappe.utils.debounce(async function () {
				if (o.serverSearch) {
					const $inp = $(this);
					$inp.prop('disabled', true);
					try {
						const fresh = await o.serverSearch($inp.val() || '');
						rows.length = 0;
						rows.push(...(fresh || []));
					} finally {
						$inp.prop('disabled', false);
					}
					st.page = 1;
					renderPage();
					return;
				}
				st.q = $(this).val(); st.page = 1; renderPage();
			}, 400));
			// EXT column-toggle — dropdown checkbox (corak tm-nav-sub:
			// butang toggle panel; klik luar menutup).
			if (o.persistKey) {
				const $colsBtn = $m.find('.tm-dt-cols-btn');
				const $cols = $m.find('.tm-dt-cols');
				const renderColsPanel = () => {
					$cols.html(colLabels.map((label, i) => label == null ? '' : `
						<label class="d-flex align-items-center gap-2 mb-0">
							<input type="checkbox" class="tm-dt-colcb" data-idx="${i}"
								${colHide.has(i) ? '' : 'checked'}>
							<span>${esc(label)}</span>
						</label>`).join(''));
				};
				renderColsPanel();
				$colsBtn.on('click', (e) => {
					e.stopPropagation();
					const open = !$cols.hasClass('open');
					$cols.toggleClass('open', open);
					$colsBtn.attr('aria-expanded', open ? 'true' : 'false');
				});
				$cols.on('click', (e) => e.stopPropagation());
				$cols.on('change', '.tm-dt-colcb', function () {
					const i = parseInt($(this).data('idx'), 10);
					if ($(this).is(':checked')) colHide.delete(i);
					else colHide.add(i);
					colPersist();
					renderPage();
				});
				$(document).on('click.tmDtCols', (e) => {
					if (!$(e.target).closest('.tm-dt-cols-wrap').length) {
						$cols.removeClass('open');
						$colsBtn.attr('aria-expanded', 'false');
					}
				});
			}
			filterSel.on('change', function () {
				st.filter = $(this).val(); st.page = 1; renderPage();
			});
			$m.find('.tm-dt-mf').on('change', function () {
				st.mf[$(this).data('key')] = $(this).val();
				st.page = 1; renderPage();
			});
			// Header sortable — delegated (thead dirender semula setiap
			// renderPage); klik aktifkan asc, klik lagi desc (toggle).
			$m.on('click', '.tm-dt-sortable', function () {
				const k = $(this).data('key');
				if (st.sortKey === k) st.sortDir = -st.sortDir;
				else { st.sortKey = k; st.sortDir = 1; }
				renderPage();
			});
			$scope.find('.tm-dt-size').on('change', function () {
				st.size = parseInt($(this).val(), 10) || 10; st.page = 1; renderPage();
			});
			// Pagination — delegated pada scope (dalam card-footer bila
			// footer mode — luar mount div).
			$scope.on('click', '.tm-dt-page', function () {
				const p = parseInt($(this).data('page'), 10);
				if (p >= 1) { st.page = p; renderPage(); }
			});
			renderPage();
			return { rerender: renderPage };
		};
		// ── Helper UI kongsi (v9): spinner, tajuk seksi, medan label→nilai,
		// grid info. Semua guna utiliti stok Bootstrap/Frappe.
		const loading = () => `
			<div class="d-flex justify-content-center align-items-center text-muted p-5">
				<div class="spinner-border spinner-border-sm"></div>
			</div>`;
		// title: HTML bebas; note: teks kecil kelabu di sebelah.
		// title: HTML bebas; note: teks kecil kelabu di sebelah;
		// extraClass (opsyenal) — utiliti tambahan pada div tajuk seksi
		// (cth. 'mt-3' — jarak atas lebih besar; menewaskan my-2 kerana
		// urutan utiliti Bootstrap dalam stylesheet).
		const secTitle = (title, note, extraClass) => `
			<div class="d-flex align-items-baseline gap-2 font-weight-bold my-2 ${extraClass || ''}">${title}${note
				? `<span class="text-muted font-weight-normal">${note}</span>` : ''}</div>`;
		// Medan label→nilai untuk grid info (PACKAGE/GROUP INFO dsb.).
		// extraClass = kolum Bootstrap grid (col-*); kosong → col-12.
		// Label kosong (cth. nama trip besar) → span label tidak dirender.
		// [Nov 2026] padding py-1/px-2 DIBUANG pada semua grid (arahan
		// pemilik) — field tanpa padding; parameter `tight` dikekalkan
		// sebagai no-op utk keserasian panggilan sedia ada.
		// VALUE span = font-weight-bold (arahan pemilik Nov 2026: label
		// kekal, nilai lebih tebal; input dalam span ikut CSS .form-control).
		const field = (label, valueHtml, extraClass, tight) => `
			<div class="${extraClass || 'col-12'}">
				${label ? `<span class="text-muted d-block">${label}</span>` : ''}
				<span class="d-block break-words font-weight-bold">${valueHtml ?? '—'}</span>
			</div>`;
		// Grid info ber-ID — baris Bootstrap grid tanpa gutter.
		const infoGrid = (id, inner) => `
			<div id="${id}" class="row no-gutters align-items-center">${inner || ''}</div>`;
		// Kawalan Link (autocomplete Frappe/Awesomplete) dipasang pada elemen
		// div — senarai pilihan datang terus daripada doctype (cth. Currency,
		// Trip Organizer), bukan <select> statik. Digunakan oleh Add Offer
		// (currency) di halaman tarikh & wizard (org/currency).
		// only_input — wrapper mudah TANPA <div class="clearfix"> (label
		// kosong + help) warisan template base_input; label halaman sudah
		// disediakan pemanggil — DOM bersih, tiada clearfix (Nov 2026).
		const makeLink = (el, o) => {
			const ctrl = frappe.ui.form.make_control({
				parent: el,
				df: {
					fieldtype: 'Link', fieldname: o.fieldname,
					options: o.doctype, filters: o.filters,
					change: function () { o.set(this.get_value() || ''); },
				},
				render_input: true,
				only_input: true,
			});
			ctrl.$input.attr('placeholder', o.placeholder || 'Type to search…');
			if (o.small) ctrl.$input.addClass('form-control-sm');
			if (o.value) ctrl.set_value(o.value);
			return ctrl;
		};

		// ── Kad ITINERARY OVERRIDE — model "reuse + checkbox overwrite"
		// (Nov 2026): Travel Date / Package Offer masing-masing boleh pegang
		// senarai Trip Itinerary sendiri; baris sendiri HANYA diguna bila
		// switch ditanda — jika tidak (atau baris kosong), paparan mewarisi
		// aras atas (resolver server: Trip ← Travel Date ← Package Offer).
		// Satu kad untuk kedua aras — dipasang di halaman Travel Date &
		// halaman Package Offer (view info).
		// cfg: {parenttype, name, payload, parentLabel, copyLabel, onSaved}
		// [Nov 2026] ITIN_SEGMENTS dibuang bersama medan segment doctype
		// Trip Itinerary — itinerary dirender flat.

		// ── Dialog borang SATU hari itinerary (kongsi: Trip template di tab
		// Website + kad override Travel Date / Package Offer). Senarai di kad
		// hanya papar Day + Day Title; tambah/sunting penuh melalui modal ini.
		// `row` dimutate terus (Objek sama dalam array state) — batal = tiada
		// perubahan; Simpan → callback re-render. ──
		const itineraryDayDialog = (row, onSave) => {
			const d = new frappe.ui.Dialog({
				title: row._is_new ? '＋ Hari Itinerary Baharu'
					: `✏️ Sunting Hari ${row.day ?? ''}`,
				fields: [
					{ fieldname: 'day', fieldtype: 'Int', label: 'Day', reqd: 1,
						// [FIX Nov 2026] papar nilai hari sedia ada semasa sunting
						// (dahulunya medan kosong — pengguna terpaksa taip semula)
						default: row.day ?? '',
						description: 'Nombor hari (integer) — senarai dipapar mengikut turutan hari.' },
					{ fieldname: 'day_title', fieldtype: 'Data', label: 'Day Title',
						reqd: 1, default: row.day_title || '' },
					{ fieldname: 'destination_point', fieldtype: 'Link',
						label: 'Destination / Port',
						options: 'Trip Destination Point',
						default: row.destination_point || '' },
					{ fieldname: 'meals', fieldtype: 'Data', label: 'Meals',
						description: 'Sertakan dengan koma, cth: Breakfast, Lunch, Dinner',
						default: row.meals || '' },
					// [Nov 2026] Day Image — medan Attach Image doctype Trip
					// Itinerary yang tertinggal pada dialog (state & whitelist
					// server sedia bawa day_image — upload kini boleh dari
					// ketiga-tiga aliran: Trip template, Travel Date &
					// Package Offer override). Upload SENTIASA PUBLIC (imej
					// web) — ikut corak cover/gallery halaman Website;
					// optimisasi resize/mampat berlaku server-side
					// (utils/image_optimize.py — hook File.after_insert).
					{ fieldname: 'day_image', fieldtype: 'Attach Image',
						label: 'Day Image', default: row.day_image || '',
						options: { make_attachments_public: true,
							allow_toggle_private: false } },
					{ fieldname: 'description', fieldtype: 'Text Editor',
						label: 'Description', default: row.description || '' },
				],
				primary_action_label: row._is_new ? 'Tambah' : 'Simpan',
				primary_action: (values) => {
					Object.assign(row, values);
					delete row._is_new;
					d.hide();
					if (onSave) onSave();
				},
			});
			d.show();
			// Day — kekalkan INPUT integer sahaja (ControlInt masih menerima
			// aksara sementara menaip): buang semua bukan digit secara langsung.
			const $day = d.get_field('day')?.$input;
			if ($day) $day.on('input', function () {
				const cleaned = this.value.replace(/[^0-9]/g, '');
				if (cleaned !== this.value) this.value = cleaned;
			});
			return d;
		};

		// ── Drag-to-reorder senarai hari itinerary (Nov 2026) — SortableJS
		// (global desk: window.Sortable dari libs.bundle). Handle khusus per
		// baris (.tm-itin-drag) supaya klik butang ✏️/✕ tidak terjejas.
		// Selepas lepas: array state disusun semula ikut susunan DOM dan
		// NOMBOR HARI ditetapkan semula berurutan (1,2,3…); onDone() →
		// re-render. Simpan ke server kekal melalui butang Save kad. ──
		const wireItinSortable = ($tbody, rows, onDone) => {
			if (!($tbody && $tbody.length && window.Sortable && rows.length > 1))
				return;
			new Sortable($tbody[0], {
				handle: '.tm-itin-drag',
				animation: 150,
				ghostClass: 'tm-itin-ghost',
				onEnd: () => {
					// Indeks lama ikut susunan DOM baharu → susun semula array.
					const order = $tbody.find('tr[data-i]').map(function () {
						return $(this).data('i');
					}).get();
					const reordered = order.map((i) => rows[i]).filter(Boolean);
					rows.length = 0;
					rows.push(...reordered);
					rows.forEach((r, i) => { r.day = i + 1; });
					if (onDone) onDone();
				},
			});
		};

		const itineraryOverrideCard = (cfg) => {
			const p = cfg.payload || {};
			const st = {
				own: (p.own_itinerary || []).map((r) => ({ ...r })),
				overwrite: !!p.overwrite_itinerary,
				effective: p.effective_itinerary || [],
				source: p.itinerary_source || 'trip',
				// Rantaian INDUK (tanpa aras semasa) — sumber Salin & Add-
				// from (Nov 2026): TD → Trip; offer → TD efektif (TD
				// overwrite → baris TD; tiada → Trip). Resolver server.
				parent: p.parent_itinerary || [],
				parentSrc: p.parent_source || 'trip',
			};
			const ROOT = '.tm-itin-ov';

			// Label Salin FACTORIZED — ikut sumber induk sebenar (bukan
			// hardcode pemanggil): parent_source 'travel_date' → "Salin
			// dari Travel Date"; selainnya → "Salin dari Trip". cfg.copyLabel
			// kekal sebagai fallback (payload lama tanpa parent_source).
			const copyLabel = () => st.parentSrc === 'travel_date'
				? 'Salin dari Travel Date'
				: (cfg.copyLabel || 'Salin dari Trip');

			// Baris senarai ringkas (Day + Day Title sahaja) — sunting penuh
			// melalui modal itineraryDayDialog.
			const editRow = (r, i) => `
				<tr data-i="${i}">
					<td class="tm-itin-drag" title="Seret untuk susun semula">⠿</td>
					<td style="width:70px" class="text-muted">${esc(r.day ?? '')}</td>
					<td>${esc(r.day_title || '')}${r.day_image
						? ' <span title="Ada imej hari">🖼️</span>' : ''}</td>
					<td class="text-nowrap" style="width:90px">
						<button class="btn btn-xs btn-default tm-itin-ov-edit" data-i="${i}"
							title="Sunting hari">✏️</button>
						<button class="btn btn-xs btn-danger tm-itin-ov-del" data-i="${i}"
							title="Buang baris">✕</button>
					</td>
				</tr>`;

			// Pratonton efektif (readonly) — baris yang AKAN dilihat pelanggan
			// pada tarikh/pakej ini mengikut rantaian warisan semasa. TD pertama
			// KOSONG (30px) — selari header/body (kolum handle drag di mod edit)
			// — arahan pemilik Nov 2026.
			const prevRow = (r) => `
				<tr class="text-muted">
					<td style="width:30px"></td>
					<td style="width:70px">${r.day ?? ''}</td>
					<td>${esc(r.day_title || '')}${r.day_image
						? ' <span title="Ada imej hari">🖼️</span>' : ''}</td>
					<td></td>
				</tr>`;

			// Badge sumber (Nov 2026 — arahan pemilik): gaya Bootstrap
			// TANPA custom style; dipaparkan di KANAN card-header.
			//   Overwrite aktif → badge-danger "Overwrite"
			//   Waris (mengikut aras sumber) → badge-primary "Inherit …"
			const srcBadge = () => st.overwrite && st.own.length
				? '<span class="badge badge-danger">Overwrite</span>'
				: `<span class="badge badge-primary">${esc(st.source === 'travel_date'
					? 'Inherit Travel Date' : st.source === 'package_offer'
					? 'Inherit Offer' : 'Inherit')}</span>`;

			// Body kad: amaran + jadual (switch & butang aksi DALAM TFOOT —
			// table-footer jadual, auto selari kolum; card-footer DIBUANG —
			// arahan pemilik Nov 2026). cfg.showSource (halaman travel
			// date): caption sumber di bawah jadual — "N hari · asas
			// itinerary daripada Trip" / "senarai sendiri (overwrite)".
			const bodyInner = () => {
				const editing = st.overwrite;
				const rows = editing ? st.own : st.effective;
				// Label aras sumber (factorized — ikut badge srcBadge):
				// trip/travel_date/package_offer → nama paparan.
				const srcLabel = () => st.source === 'travel_date' ? 'Travel Date'
					: st.source === 'package_offer' ? 'Package Offer' : 'Trip';
				const srcCaption = cfg.showSource
					? `<p class="text-muted text-small mt-2 mb-0">${rows.length} hari · ${
						editing ? 'senarai sendiri (overwrite)'
						: `asas itinerary daripada ${esc(srcLabel())}`}</p>`
					: '';
				return `
					${editing && !st.own.length
						? `<p class="text-warning small mb-2">⚠️ Switch aktif tetapi tiada baris —
							warisan ${esc(cfg.parentLabel)} masih diguna. Klik "${esc(copyLabel())}"
							untuk pra-isi.</p>` : ''}
					<div class="table-responsive">
					<table class="table table-sm mb-0">
						<thead><tr><th style="width:30px"></th><th style="width:70px">Day</th><th>Day Title</th><th></th></tr></thead>
						<tbody>${rows.map(editing ? editRow : prevRow).join('')
							|| `<tr><td colspan="4" class="text-muted small">Tiada baris${editing
								? ` — klik "${esc(copyLabel())}" untuk pra-isi daripada ${esc(cfg.parentLabel)}.`
								: ` pada ${esc(cfg.parentLabel)}.`}</td></tr>`}</tbody>
						<tfoot><tr><td colspan="4">${footerInner()}</td></tr></tfoot>
					</table></div>${srcCaption}`;
			};

			// TFOOT jadual (dipanggil bodyInner): switch Overwrite (kiri) +
			// butang aksi (kanan, ml-auto). "Salin" & "+ Hari" hanya bila
			// overwrite AKTIF; "Simpan Itinerary" SENTIASA dipapar (matikan
			// switch → simpan = kembali ke warisan). Dahulu card-footer —
			// DIBUANG, kandungan pindah ke tfoot (arahan pemilik Nov 2026).
			const footerInner = () => {
				const editing = st.overwrite;
				return `
					<div class="d-flex flex-wrap align-items-center gap-2">
						<div class="custom-control custom-switch">
							<input type="checkbox" class="custom-control-input" id="tm-itin-ov-sw"
								${st.overwrite ? 'checked' : ''}>
							<label class="custom-control-label" for="tm-itin-ov-sw">Overwrite —
								guna senarai ini mengatasi ${esc(cfg.parentLabel)}</label>
						</div>
						<div class="d-flex flex-wrap align-items-center gap-2 ml-auto">
							${editing ? `
							<button class="btn btn-outline btn-outline-primary btn-sm" id="tm-itin-ov-copy">📋 ${esc(copyLabel())}</button>
							<button class="btn btn-outline btn-outline-primary btn-sm" id="tm-itin-ov-addfrom"
								title="Pilih baris daripada ${esc(copyLabel().replace('Salin dari ', ''))} untuk ditambah sebagai hari baharu">➕ Add from…</button>
							<button class="btn btn-outline btn-outline-primary btn-sm" id="tm-itin-ov-add">+ Hari</button>`
								: '<span class="text-muted small">Aktifkan switch untuk edit senarai sendiri.</span>'}
							<button class="btn btn-primary btn-sm" id="tm-itin-ov-save">💾 Simpan Itinerary</button>
						</div>
					</div>`;
			};

			const render = ($root) => {
				if (!$root || !$root.length) return;
				// Body (jadual + tfoot aksi + caption) di-render semula setiap
				// kali state berubah; badge & kiraan hari hidup dalam
				// card-header (mod plain tiada header — rujukan jadi no-op).
				// Card-footer DIBUANG (aksi dalam tfoot — Nov 2026).
				const $card = $root.closest('.card');
				const $scope = $card.length ? $card : $root.closest(ROOT);
				$root.html(bodyInner());
				// Drag-to-reorder hari (edit mode sahaja — preview statik).
				// NOTE: `editing` TIADA dalam scope render() (hanya dalam
				// bodyInner/footerInner) — guna st.overwrite; rujukan `editing`
				// di sini dulu lempar ReferenceError & matikan seluruh render
				// (tab Itinerary kosong — bug ditemui Nov 2026).
				if (st.overwrite) wireItinSortable($root.find('tbody'), st.own,
					() => render($root));
				$scope.find('#tm-itin-ov-count')
					.text((st.overwrite ? st.own.length : st.effective.length) + ' hari');
				$scope.find('#tm-itin-ov-badge').html(srcBadge());
				$scope.find('#tm-itin-ov-sw').on('change', function () {
					st.overwrite = $(this).is(':checked');
					render($root);
				});
				// Pra-isi baris sendiri daripada rantaian INDUK (Salin —
				// Nov 2026) + auto-tick. Sumber = st.parent (TD → Trip;
				// offer → TD efektif/Trip) — BUKAN st.effective (yang sudah
				// termasuk baris sendiri bila overwrite aktif).
				$scope.find('#tm-itin-ov-copy').on('click', () => {
					st.own = st.parent.map((r) => ({
						day: r.day, day_title: r.day_title,
						destination_point: r.destination_point, meals: r.meals,
						day_image: r.day_image || '', description: r.description || '',
					}));
					st.overwrite = true;
					render($root);
				});
				// ➕ Add from… — modal PILIH baris daripada rantaian induk;
				// dipilih → DITAMBAH sebagai baris baharu (bukan replace).
				// Nombor hari disusun semula berurutan selepas tambah.
				$scope.find('#tm-itin-ov-addfrom').on('click', () => {
					if (!st.parent.length) {
						frappe.msgprint(`Tiada itinerary pada sumber (${esc(copyLabel()
							.replace('Salin dari ', ''))}) untuk ditambah.`);
						return;
					}
					// Checkbox DIBUNGKUS dalam <label> (implicit labeling —
					// TIADA id/for). Id global (tm-itin-af-N) dulu BERLANGGAR
					// antara dialog (frappe.ui.Dialog kekal dalam DOM selepas
					// hide; SPA session) → klik label toggle checkbox dialog
					// lama yang tersembunyi → baris "tak boleh add" (yang tak
					// berlanggar je yang berjaya — bug Nov 2026).
					const listHtml = st.parent.map((r, i) => `
						<label class="custom-control custom-checkbox mb-1">
							<input type="checkbox" class="custom-control-input" data-i="${i}">
							<span class="custom-control-label">
								<strong class="text-muted">Day ${esc(r.day ?? '')}</strong>
								${esc(r.day_title || '')}
								${r.destination_point ? `<span class="text-muted text-small">· ${esc(r.destination_point)}</span>` : ''}
							</span>
						</label>`).join('');
					const daf = new frappe.ui.Dialog({
						title: '➕ Add from ' + copyLabel().replace('Salin dari ', '')
							+ ' — pilih hari untuk ditambah',
						fields: [{
							fieldname: 'pick', fieldtype: 'HTML',
							options: `<div style="max-height:320px;overflow:auto">${listHtml}</div>`,
						}],
						primary_action_label: 'Tambah Dipilih',
						primary_action: () => {
							const picked = daf.$body.find('input:checked')
								.map(function () { return st.parent[$(this).data('i')]; })
								.get().filter(Boolean);
							daf.hide();
							if (!picked.length) return;
							st.own.push(...picked.map((r) => ({
								day: 0, day_title: r.day_title || '',
								destination_point: r.destination_point || '',
								meals: r.meals || '', day_image: r.day_image || '',
								description: r.description || '',
							})));
							st.own.forEach((r, i) => { r.day = i + 1; });
							st.overwrite = true;
							render($root);
						},
					});
					daf.show();
				});
				// Tambah/sunting hari — borang penuh dalam modal (senarai kekal
				// ringkas: Day + Day Title sahaja).
				$scope.find('#tm-itin-ov-add').on('click', () => {
					const row = { day: st.own.length + 1,
						day_title: '', destination_point: '', meals: '',
						description: '', day_image: '', _is_new: true };
					itineraryDayDialog(row, () => { st.own.push(row); render($root); });
				});
				$scope.find('.tm-itin-ov-edit').on('click', function () {
					const row = st.own[$(this).data('i')];
					if (row) itineraryDayDialog(row, () => render($root));
				});
				$scope.find('.tm-itin-ov-del').on('click', function () {
					st.own.splice($(this).data('i'), 1);
					// Nombor hari kekal berurutan selepas buang baris.
					st.own.forEach((r, i) => { r.day = i + 1; });
					render($root);
				});
				$scope.find('#tm-itin-ov-save').on('click', async function () {
					const $btn = $(this).prop('disabled', true);
					try {
						await api('save_itinerary', {
							parenttype: cfg.parenttype, name: cfg.name,
							overwrite_itinerary: st.overwrite ? 1 : 0,
							itinerary: JSON.stringify(st.own),
						});
						frappe.show_alert({ message: 'Itinerary disimpan', indicator: 'green' });
						if (cfg.onSaved) cfg.onSaved();
					} catch (e) { /* frappe already shows it */ }
					$btn.prop('disabled', false);
				});
				// Chevron collapsible — ikut keadaan .collapse (tutup ▾ /
				// buka ▴). off().on() elok duplikasi selepas render semula.
				if (cfg.collapsible) {
					$scope.find('#tm-itin-ov-body')
						.off('shown.bs.collapse hidden.bs.collapse')
						.on('shown.bs.collapse', () => $scope.find('#tm-itin-ov-chev').text('▴'))
						.on('hidden.bs.collapse', () => $scope.find('#tm-itin-ov-chev').text('▾'));
				}
			};

			const plainHtml = () => `<div class="tm-itin-ov">${card(12,
				`🗓️ ITINERARY <span id="tm-itin-ov-count" class="text-muted"></span>
				<span id="tm-itin-ov-badge" class="ml-auto">${srcBadge()}</span>`,
				bodyInner())}</div>`;

			// Variant COLLAPSIBLE (Nov 2026 — arahan pemilik, halaman travel
			// date): header kad jadi toggle Bootstrap .collapse — body
			// TERSEMBUNYI secara lalai (tiada .show); klik header untuk buka/
			// tutup. Badge sumber & kiraan hari kekal di header. (card-footer
			// dibuang — aksi dalam tfoot jadual.)
			const collapsibleHtml = () => `<div class="tm-itin-ov">
				<div class="card mb-3">
					<div class="card-header d-flex flex-wrap align-items-center gap-2 text-body"
						id="tm-itin-ov-head" style="cursor:pointer"
						data-toggle="collapse" data-target="#tm-itin-ov-body"
						aria-expanded="false" aria-controls="tm-itin-ov-body">
						🗓️ ITINERARY <span id="tm-itin-ov-count" class="text-muted"></span>
						<span class="ml-auto d-flex align-items-center gap-2">
							<span id="tm-itin-ov-badge">${srcBadge()}</span>
							<span id="tm-itin-ov-chev">▾</span>
						</span>
					</div>
					<div id="tm-itin-ov-body" class="collapse">
						<div class="card-body">${bodyInner()}</div>
					</div>
				</div></div>`;

			// Variant PLAIN (Nov 2026 — arahan pemilik, tab halaman travel
			// date): TIADA card-header, TIADA kelas .card/.card-body (pane
			// tab delimit kandungan); aksi dalam tfoot jadual.
			const plainNoHeaderHtml = () => `<div class="tm-itin-ov">
				<div class="tm-itin-ov-body">${bodyInner()}</div></div>`;

			return {
				html: () => cfg.plain ? plainNoHeaderHtml()
					: cfg.collapsible ? collapsibleHtml() : plainHtml(),
				// Kad ini sentiasa di-render ke dalam $body (satu kad per
				// halaman) — cari root .tm-itin-ov secara global; mod plain
				// guna penanda .tm-itin-ov-body (kelas .card-body tiada).
				wire: () => render($body.find(
					ROOT + ' .card-body, ' + ROOT + ' .tm-itin-ov-body').first()),
			};
		};

		// ── PANEL INFO KONGSI (dipakai berulang di semua directory yang
		// berkaitan — Nov 2026) ──
		// tripInfoCardHtml(info, trip): maklumat asas TRIP sahaja —
		// trip / date / package directory. Susun atur (Nov 2026, grid
		// Bootstrap, arahan pemilik):
		//   baris 1 = Trip Name (h2 UPPERCASE 1.25rem, col-12 DALAM grid)
		//   baris 2 = kolum 1 (10/12): baris Trip ID/Status/Published/
		//             Featured (col-6 col-md-3 x4) · baris Organizer (9/12)
		//             + Created (col-6 col-md-3)  |  kolum 2 (2/12):
		//             Type 12/12 — ICON BESAR atas + caption (Cruise/Tour)
		//             baris baru, tengah.
		//   Grid ber-gutter BIASA (TIADA no-gutters) + semua field tight
		//   (tiada py-1/px-2) — jarak diurus gutter; selari kad CONTENT
		//   tab Website (arahan pemilik Nov 2026).
		// `info` = rekod trip (get_trips_list ATAU payload.trip); kosong → ''.
		// FOOTER DIREKTORI = SATU FAKTOR fungsi ini (arahan pemilik):
		// .card-footer Details | Website | Sales dibina DI DALAM — setiap
		// halaman yang papar kad TRIP INFORMATION automatik dapat navigasi
		// direktori di kaki kad (handler delegated di shell). Website kini
		// ke halaman manage kandungan DALAM travel-manager (bukan borang
		// Trip) — pengguna tak perlu akses doctype terus.
		// [Nov 2026] BUTANG RESPON KEPADA DIREKTORI AKTIF — ditentukan
		// daripada URL semasa (bukan parameter pemanggil), parse kata kunci
		// shell selari handle_route: segmen selepas trip/<TRIP>.
		//   (tiada) | 'website' | 'sales' → footer DIPAPAR; butang halaman
		//     semasa di-disable (lokasi pengguna)
		//   sub-direktori lain ('date', 'pkg', …) → footer DISEMBUNYIKAN.
		// Butang footer = `btn` SAHAJA (tiada btn-default) dan card-footer
		// ber-p-0 — btn-group melekat rapat ke tepi kad (arahan pemilik).
		// [Nov 2026] Kad BOLEH COLLAPSE — klik header (caret ▸/▾ di kanan)
		// buka/tutup body + footer. Handler delegated di bawah (sekali
		// sahaja — hidup pada semua halaman & selepas re-render); state
		// kekal dalam closure (reset bila desk di-reload). Corak idiom
		// kad RATE (data-target + tm-collapse-caret).
		let tmTripInfoCollapsed = false;
		const tripInfoCardHtml = (info, trip) => {
			if (!info) return '';
			const typeIcon = info.is_a_cruise_trip ? '🚢' : '⛰️';
			const typeText = info.is_a_cruise_trip ? 'Cruise' : 'Tour';
			const route = frappe.get_route() || [];
			const iTrip = route.indexOf('trip');
			const sub = (iTrip !== -1 && route[iTrip + 1]) ? route[iTrip + 2] : null;
			const showFooter = !sub || ['website', 'sales'].includes(sub);
			const dirActive = (sub === 'website' || sub === 'sales') ? sub : 'detail';
			const dirBtn = (dir, label, tip) => `
				<button type="button" class="btn btn-sm flex-fill tm-dir-${dir}"
					data-trip="${esc(trip)}" ${dirActive === dir
						? 'disabled title="Halaman semasa"' : `title="${tip}"`}>${label}</button>`;
			const footerHtml = !showFooter ? '' : `
				<div class="btn-group w-100" role="group" aria-label="Trip directory">
					${dirBtn('detail', '📄 Details', 'Trip directory')}
					${dirBtn('website', '🌐 Website', 'Kandungan website trip')}
					${dirBtn('sales', '💰 Sales', 'Senarai booking trip ini')}
				</div>`;
			const headerTitle = `
				<span class="tm-trip-info-toggle pointer d-flex align-items-center w-100"
					data-target="tm-trip-info-body"
					title="Klik untuk buka/tutup panel">🧭 TRIP INFORMATION
					<span class="tm-collapse-caret ml-auto text-muted"
						aria-hidden="true">${tmTripInfoCollapsed ? '▸' : '▾'}</span>
				</span>`;
			return card(12, headerTitle, `
				<div id="tm-trip-info-body"
					class="tm-trip-info-body${tmTripInfoCollapsed ? ' d-none' : ''}">
				<div class="row">
					<div class="col-12">
						<h2 class="text-uppercase text-truncate mb-0"
							style="font-size:1.25rem;line-height:1.2"
							title="${esc(info.trip_name || trip)}">${esc(info.trip_name || trip)}</h2>
					</div>
					<div class="col-10 min-w-0">
						<div class="row">
							${field('Trip ID', `<span class="text-monospace"><strong>${esc(trip)}</strong></span>`, 'col-6 col-md-3', true)}
							${field('Status', badge(info.status, DEP_COLOR[info.status] || C.gray), 'col-6 col-md-3', true)}
							${field('Published', info.published ? '✅ Yes' : '— No', 'col-6 col-md-3', true)}
							${field('Featured', info.featured ? '✅ Yes' : '— No', 'col-6 col-md-3', true)}
						</div>
						<div class="row">
							${field('Organizer', esc(info.trip_organizer || '—'), 'col-9', true)}
							${field('Created', esc(webFmtDate(info.creation)), 'col-6 col-md-3', true)}
						</div>
					</div>
					<div class="col-2 d-flex align-items-center justify-content-center text-center">
						${field('Type', `
							<div aria-hidden="true" style="font-size:2.5rem;line-height:1.1">${typeIcon}</div>
							<div class="font-weight-bold text-uppercase">${typeText}</div>`, 'col-12', true)}
					</div>
				</div>
				</div>`, footerHtml, tmTripInfoCollapsed ? 'p-0 d-none' : 'p-0');
		};
		// Toggle collapse kad TRIP INFORMATION — delegated pada $body supaya
		// sentiasa hidup (semua halaman directory/website/sales/date/pkg,
		// kekal selepas setiap $body.html() re-render).
		$body.on('click', '.tm-trip-info-toggle', function () {
			tmTripInfoCollapsed = !tmTripInfoCollapsed;
			$(this).closest('.card').find('.tm-trip-info-body, .card-footer')
				.toggleClass('d-none', tmTripInfoCollapsed);
			$(this).find('.tm-collapse-caret')
				.text(tmTripInfoCollapsed ? '▸' : '▾');
		});
		// tmDurTxt(date) — teks durasi "N Hari · M Malam" (Nov 2026): nilai
		// tersimpan Travel Date; rekod lama belum disave → kiraan klien
		// daripada tarikh (formula TGD: nights = beza, days = nights + 1).
		// '' bila tiada sumber (tiada nilai & tiada tarikh lengkap).
		const tmDurTxt = (date) => {
			if (!date) return '';
			let days = date.total_days || 0;
			let nights = date.total_nights || 0;
			if ((!days || !nights)
					&& date.departure_date && date.return_date) {
				nights = moment(String(date.return_date).slice(0, 10),
					'YYYY-MM-DD', 'en').diff(moment(String(date.departure_date)
						.slice(0, 10), 'YYYY-MM-DD', 'en'), 'days');
				days = nights + 1;
			}
			return (days || nights)
				? `${days || '—'} Hari · ${nights ?? '—'} Malam` : '';
		};
		// groupInfoCardHtml(date, withActions, extraInner): maklumat GROUP
		// DATE — dipaparkan pada date directory (butang Edit pada
		// card-header) dan package directory (info sahaja). `date` = dict
		// bentuk get_travel_date_detail.date; kosong → ''. `extraInner` =
		// HTML tambahan (jadual room category) — baris 4 col-12 dalam grid;
		// HANYA dipaparkan bila info kategori wujud (pemanggil yang putuskan).
		// Susun atur (arahan pemilik):
		//   baris 1: Trip Name (h4 TANPA label — UPPERCASE, font weight 400)
		//            + Departure Date (h3 TANPA label — departure → return)
		//            DALAM col-12 yang sama; kedua-dua line-height 1.3
		//            (arahan pemilik Nov 2026)
		//   baris 2: Group Date (col-md-3) · Travel Date ID (col-md-3) ·
		//            Trip Category (col-md-2, master Trip Category — Nov
		//            2026) · Closure (col-md-2, nota kecil tarikh tutup
		//            anggaran) · Status (col-md-2)
		//   baris 3 (Nov 2026): Durasi ("N Hari · M Malam", col-md-3) ·
		//            Destination (col-md-3)
		//   baris 4 (trip cruise sahaja): Sailing Date · Destination Port —
		//            col-md-6
		//   baris 4 (bila ada rooming): jadual room category — col-12
		//            (bawah skali, TANPA tajuk/collapsible — arahan pemilik
		//            Nov 2026)
		// Grid & medan ikut format kad TRIP INFORMATION (tripInfoCardHtml):
		// row ber-gutter biasa (TIADA no-gutters), field tight (TIADA
		// py-1/px-2), nilai `d-block break-words font-weight-bold` — ketebalan
		// datang daripada span field(), tanpa <strong> tambahan.
		// [BUANG Nov 2026] butang Change/Link Cruise Schedule — sambungan
		// schedule diurus dalam dialog Edit Date (Selected Cruise
		// Schedule). Semua tarikh ikut format Travel Website (webFmtDate).
		const groupInfoCardHtml = (date, withActions, extraInner) => {
			if (!date) return '';
			// Sailing hanya untuk trip cruise (is_a_cruise_trip ATAU
			// cruise_schedule dipaut) — trip darat tidak papar baris ini.
			const isCruise = !!date.is_a_cruise_trip || !!date.cruise_schedule;
			// Nota kecil tarikh tutup anggaran = departure − hari closure
			// (ikut format laman). Kosong bila tiada tarikh/hari closure.
			const estClosure = (date.departure_date && date.days_before_closure)
				? '≈ ' + moment(String(date.departure_date).slice(0, 10), 'YYYY-MM-DD', 'en')
					.subtract(date.days_before_closure, 'days').format(webDispFmt())
				: '';
			const durTxt = tmDurTxt(date);
			// Card-header: tajuk + butang Edit Date (kanan, ml-auto) bila
			// withActions — halaman tarikh sahaja. Gaya outline-primary
			// (arahan pemilik).
			const headerTitle = `🧭 GROUP INFO${withActions ? `
				<button class="btn btn-outline btn-outline-primary btn-sm ml-auto" id="tm-edit-date"
					title="Kemaskini tarikh / schedule group ini">✎ Edit Date</button>` : ''}`;
			return card(12, headerTitle, `
				<div id="tm-grp-info" class="row">
					<div class="col-12">
						<h4 class="d-block break-words mb-0"
							style="text-transform:uppercase;font-weight:400;line-height:1.3">${esc(date.trip_name || '—')}</h4>
						<h3 class="d-block break-words font-weight-bold mb-0" style="line-height:1.3">${esc(webFmtDate(date.departure_date))} → ${esc(webFmtDate(date.return_date))}</h3>
					</div>
					${field('Group Date', esc(date.travel_date_name || date.name),
						'col-12 col-md-3', true)}
					${field('Travel Date ID', esc(date.name), 'col-12 col-md-3', true)}
					${field('Trip Category', esc(date.trip_category || '—'),
						'col-12 col-md-2', true)}
					${field('Closure', `${date.days_before_closure ? date.days_before_closure + ' hari' : '—'}
						${estClosure ? `<span class="d-block text-muted text-small font-weight-normal">${esc(estClosure)}</span>` : ''}`,
						'col-12 col-md-2', true)}
					${field('Status', badge(date.status, DEP_COLOR[date.status] || C.gray),
						'col-12 col-md-2', true)}
					${field('Durasi', esc(durTxt || '—'), 'col-12 col-md-3', true)}
					${field('Destination', esc(date.destination || '—'),
						'col-12 col-md-3', true)}
					${isCruise ? field('Sailing Date',
						`${esc(webFmtDate(date.sailing_start))} → ${esc(webFmtDate(date.sailing_end))}`,
						'col-12 col-md-6', true) : ''}
					${isCruise ? field('Destination Port',
						`${esc(date.embarkation_port || '—')} → ${esc(date.disembarkation_port || '—')}`,
						'col-12 col-md-6', true) : ''}
					${extraInner ? `<div class="col-12">${extraInner}</div>` : ''}
				</div>
			`);
		};

		// ── NAV ROW ARAS TRIP — HELPER KONGSI (Nov 2026) ──
		// Navigasi "same level" #tm-trip-navrow dipaparkan SERUPA pada
		// KETIGA-TIGA halaman aras trip (dahulunya hanya trip directory):
		// trip directory · trip/<trip>/website · trip/<trip>/sales —
		// ← All Trips · ‹ Prev / kaunter / Next › · (aksi halaman) ·
		// 🗑 Delete Trip (Tour Manager/System Manager sahaja).
		// fetchTripNav(trip) — async: senarai SEMUA trip (satu panggilan)
		//   untuk prev/next + kaunter. null-tolerant (nav kosong → butang
		//   prev/next disabled, navigasi & Delete kekal berfungsi).
		// tripNavRowHtml(trip, nav, extraRight) — markup nav row;
		//   extraRight = butang khas halaman (cth. 💾 Save Website).
		// wireTripNavRow(trip, nav, counts) — pasang klik SELEPAS
		//   $body.html(); counts = {dates, offers} (directory dah muat
		//   dateList — halaman lain ambil malas semasa klik Delete).
		const fetchTripNav = async (trip) => {
			const allTrips = (await tcc('get_trips_list', { limit: 500 }))?.trips || [];
			const tripIdx = allTrips.findIndex((x) => x.name === trip);
			return {
				allTrips, tripIdx,
				prevTrip: tripIdx > 0 ? allTrips[tripIdx - 1] : null,
				nextTrip: (tripIdx >= 0 && tripIdx < allTrips.length - 1)
					? allTrips[tripIdx + 1] : null,
			};
		};
		const tripNavRowHtml = (trip, nav, extraRight) => {
			const n = nav || {};
			const prevTrip = n.prevTrip || null;
			const nextTrip = n.nextTrip || null;
			return `
				<div id="tm-trip-navrow" class="d-flex flex-wrap align-items-center gap-2 mt-5 mb-4">
					<div class="flex-fill min-w-0">
						<button class="btn btn-default btn-sm" id="tm-back-to-trips">← All Trips</button>
					</div>
					<div class="d-flex align-items-center gap-2">
						<button class="btn btn-default btn-sm" id="tm-trip-prev"
							${prevTrip ? '' : 'disabled'}
							title="${prevTrip ? esc(prevTrip.trip_name || prevTrip.name) : 'Trip pertama'}">‹ Prev</button>
						<span class="text-muted text-nowrap text-small">Trip ${(n.tripIdx ?? -1) + 1} / ${(n.allTrips || []).length}</span>
						<button class="btn btn-default btn-sm" id="tm-trip-next"
							${nextTrip ? '' : 'disabled'}
							title="${nextTrip ? esc(nextTrip.trip_name || nextTrip.name) : 'Trip terakhir'}">Next ›</button>
					</div>
					<div class="flex-fill min-w-0 text-right">
						${extraRight || ''}
						${isManager ? `
						<button class="btn btn-danger btn-sm" id="tm-delete-trip"
							title="Padam trip ini dan SEMUA maklumat berkaitan (group dates, offers, flight arrangement)">
							🗑 Delete Trip</button>` : ''}
					</div>
				</div>`;
		};
		// Dialog pengesahan pemadaman trip — kongsi ketiga-tiga halaman
		// nav row. Kiraan tarikh/offer: pemanggil boleh bekalkan
		// (directory dah ada dateList); jika tidak, diambil malas semasa
		// klik supaya teks amaran sentiasa tepat.
		const deleteTripDialog = async (trip, counts) => {
			let nDates = counts?.dates;
			let nOffers = counts?.offers;
			if (nDates == null) {
				const rows = (await api('get_travel_dates_list', { trip, limit: 200 })
					.catch(() => null))?.dates || [];
				nDates = rows.length;
				nOffers = rows.reduce((n, x) => n + (x.packages_count || 0), 0);
			}
			frappe.prompt(
				[
					{
						fieldname: 'confirm_name', fieldtype: 'Data',
						label: `Taip <strong>${esc(trip)}</strong> untuk sahkan pemadaman`,
						reqd: 1,
						description: `Akan DIPADAM SELAMANYA: ${nDates} travel date(s), `
							+ `${nOffers} offer(s) beserta harga & komponen, flight `
							+ `arrangement trip, dan rekod Trip ${esc(trip)} itu sendiri. `
							+ `Booking aktif akan MENYEKAT pemadaman. Tindakan ini tidak boleh dibatalkan.`,
					},
				],
				(values) => {
					if ((values.confirm_name || '').trim() !== trip) {
						frappe.msgprint('Nama trip tidak sepadan — pemadaman dibatalkan.');
						return;
					}
					api('delete_trip_archive', { trip }).then((res) => {
						frappe.show_alert({
							message: `Trip ${trip} dipadam (${res.deleted.travel_dates} tarikh, `
								+ `${res.deleted.offers} offers)`,
							indicator: 'red',
						});
						frappe.set_route('travel-manager', 'trip');
					}).catch(() => { /* frappe already shows it */ });
				},
				__('🗑 Delete Trip — tidak boleh dibatalkan'),
			);
		};
		const wireTripNavRow = (trip, nav, counts) => {
			$body.find('#tm-back-to-trips').on('click', () =>
				frappe.set_route('travel-manager'));
			if (nav?.prevTrip) $body.find('#tm-trip-prev').on('click', () =>
				frappe.set_route('travel-manager', 'trip', nav.prevTrip.name));
			if (nav?.nextTrip) $body.find('#tm-trip-next').on('click', () =>
				frappe.set_route('travel-manager', 'trip', nav.nextTrip.name));
			$body.find('#tm-delete-trip').on('click', () => deleteTripDialog(trip, counts));
		};
