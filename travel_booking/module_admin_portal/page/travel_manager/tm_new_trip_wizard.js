	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: NEW TRIP WIZARD (tm_new_trip_wizard.js)
	   ════════════════════════════════════════════════════════════════════
	   Wizard trip baharu — route sendiri /trip/new-trip, bukan modal:
	   langkah trip → tarikh & schedule → matrix/offer → ringkasan.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_new_trip_wizard() (router).
	   FORMAT HTML (Nov 2026): komponen stok Bootstrap Frappe (desk.bundle,
	   BS4.6) — .card/.card-header/.card-body melalui helper kongsi card()
	   & tmTable(), borang .form-row/.form-group/.control-label + grid
	   col-*, checkbox .custom-control, utiliti d-flex / gap-* / text-*.
	   Lebar kolum jadual tiada utiliti stok → kelas .wz-* dalam
	   travel_manager.css (tiada inline style).
	   ════════════════════════════════════════════════════════════════════ */

		// ════════════ NEW TRIP WIZARD (3-step page) ════════════
		// Own route: /app/travel-manager/trip/new-trip — not a modal, so
		// date/script navigation stays undisturbed and it can be left open.
		// Step 1 Trip → 2 Travel Dates (+ cruise schedule) → 3 Package
		// Offers (identiti + harga + terma) → skrin ringkasan. Records are
		// created ONLY when the "Create Trip" button is pressed (step 3):
		// save_trip → save_travel_date per tarikh → add_offer_to_date per
		// offer (+ import kadar schedule / Price Matrix / payment terms /
		// status aktif).
		function load_new_trip_wizard() {
			// WIZARD 3-LANGKAH (Nov 2026 — selari hierarki baharu):
			//   1. Trip info   2. Travel Dates (+ cruise schedule)
			//   3. Package Offers per tarikh → ringkasan penciptaan.
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: 'New Trip' },
			]);
			set_trip_title('Register New Trip');
			$body.html(loading());

			// Slot lajur harga — selari grid PRICE MATRIX halaman admin offer.
			const MCOLS = [
				['price_adult', 'Adult'], ['price_adult_single', 'Single'],
				['price_upperberth', 'Upper'], ['price_children', 'Children'],
				['price_toddler', 'Toddler'], ['price_infant', 'Infant'],
			];
			const wiz = {
				step: 1,
				trip: { trip_name: '', trip_organizer: '', is_a_cruise_trip: 0,
					status: 'Pending Review', description: '' },
				// cruise_schedule SATU PER BARIS group date (trip cruise) —
				// bukan satu untuk semua tarikh (Nov 2026). collapsed — state
				// kad step 3 boleh-collapse (kekal merentas re-render).
				dates: [{ departure_date: '', return_date: '', offers: [],
					cruise_schedule: null, collapsed: false }],
				// Pembina offer yang sedang terbuka (satu tarikh pada satu masa):
				// { date_i, offer_name, currency, deposit_percent,
				//   final_payment_days, import_rates, markup_percent,
				//   matrix: [{ pricing_for_class, _label, price_* }], activate }
				draft: null,
				busy: false,
				created: null, // hasil submit — sumber skrin ringkasan (step 4)
			};
			// Kawalan Text Editor (Quill WYSIWYG) Description step 1 — dibina
			// pada render step 1; nilai dibaca get_value() semasa Next
			// (Quill tidak emit $input.change yang boleh diharap — corak
			// tm_trip_website readInputs).
			let wzDescCtrl = null;
			// Date RANGE selector (step 2) — SATU instance AirDatepicker
			// (lib stok frappe) dikongsi semua baris; input native disorok
			// dipindah ke wrap medan difokus supaya kalendar sejajar medan
			// (corak travel_date_dialog). wzCloseRange dipanggil pada SETIAP
			// render() supaya re-render tidak meninggalkan kalendar/handler
			// yatim pada DOM lama — ia juga menyembunyikan dropdown carian
			// schedule (elemen step 2 musnah bersama DOM) & buang handler
			// kedua-dua popover.
			let wzRangeDP = null;
			let wzSchedEl = null;  // dropdown carian schedule aktif (step 2)
			const wzCloseRange = () => {
				if (wzRangeDP) { wzRangeDP.hide(); wzRangeDP.destroy(); wzRangeDP = null; }
				if (wzSchedEl) wzSchedEl.classList.add('d-none');
				$(document).off('mousedown._tmwz keydown._tmwz')
					.off('mousedown._tmwsched keydown._tmwsched');
			};
			// Senarai cruise schedule — cache sekali per sesi wizard (step 2
			// di-render semula pada setiap tambah/buang baris).
			let wzSchedules = null;
			const wzGetSchedules = () => wzSchedules
				? Promise.resolve(wzSchedules)
				: tlinks('list_schedules')
					.then((r) => { wzSchedules = r || []; return wzSchedules; })
					.catch(() => []);
			// Parse teks format laman → ISO 'YYYY-MM-DD' (format Travel
			// Website primary; ISO/dd/mm/dd-mm/bulan fallback — corak
			// parseWebDate travel_date_dialog). null bila kosong/tak sah.
			const parseWebDate = (val) => {
				const v = String(val || '').trim();
				if (!v) return null;
				if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
				const m = moment(v, [webDispFmt(), 'DD/MM/YYYY', 'DD-MM-YYYY',
					'D MMMM YYYY', 'D MMM YYYY'], 'en');
				return m.isValid() ? m.format('YYYY-MM-DD') : null;
			};

			// Stepper — utiliti stok Bootstrap (text-success / text-primary /
			// text-muted); tiada inline style.
			const stepDots = () => ['Trip', 'Travel Dates', 'Offers'].map((lbl, i) => {
				const n = i + 1;
				const cls = n < wiz.step ? 'text-success'
					: n === wiz.step ? 'text-primary font-weight-bold' : 'text-muted';
				const mark = n <= wiz.step ? '●' : '○';
				return `<span class="text-nowrap ${cls}">${mark} ${n} ${lbl}</span>`;
			}).join('<span class="text-muted" aria-hidden="true">—</span>');

			const actionRow = (primary) => `
				<div class="d-flex flex-wrap gap-2 align-items-center mt-3">
					${wiz.step > 1 ? '<button class="btn btn-default btn-sm wz-back">← Back</button>' : ''}
					<button class="btn btn-default btn-sm wz-cancel">Cancel</button>
					<button class="btn btn-primary btn-sm ml-auto wz-next"
						${primary ? `data-primary="${primary}"` : ''}>${primary || 'Next →'}</button>
				</div>`;

			// Kawalan Link wizard — helper kongsi makeLink() (v8.2): sama
			// dengan Add Offer currency di halaman tarikh.
			const wzLink = makeLink;

			// Medan tarikh memaparkan format Travel Website — dibaca balik
			// parseWebDate → ISO (null bila kosong/tidak sah; invalid
			// ditanda border merah dan disemak semasa Next).
			const readDateInputs = () => {
				$body.find('.wz-dep').each(function () {
					const row = wiz.dates[$(this).data('i')];
					if (row) row.departure_date = parseWebDate($(this).val()) || '';
				});
				$body.find('.wz-ret').each(function () {
					const row = wiz.dates[$(this).data('i')];
					if (row) row.return_date = parseWebDate($(this).val()) || '';
				});
			};
			const readTripInputs = () => {
				wiz.trip.trip_name = $body.find('.wz-name').val().trim();
				// Description = kawalan Text Editor (Quill WYSIWYG) — get_value()
				// terus semasa Next, bukan bacaan DOM .val().
				if (wzDescCtrl) wiz.trip.description = wzDescCtrl.get_value() || '';
				wiz.trip.is_a_cruise_trip = $body.find('.wz-cruise').is(':checked') ? 1 : 0;
				wiz.trip.status = $body.find('.wz-status').val();
			};
			// Baca SEMUA input pembina offer terbuka daripada DOM → wiz.draft
			// (corak readDateInputs — nilai disimpan bila struktur berubah).
			const readDraftInputs = () => {
				const d = wiz.draft;
				if (!d) return;
				d.offer_name = ($body.find('.wz-of-name').val() || '').trim();
				// Currency dikemas kini melalui callback kontrol Link (lihat
				// pemasangan .wz-of-cur pada render step 3) — bukan DOM read.
				d.deposit_percent = $body.find('.wz-of-dep').val();
				d.final_payment_days = $body.find('.wz-of-final').val();
				if (wiz.trip.is_a_cruise_trip) {
					d.import_rates = $body.find('.wz-of-imp').is(':checked') ? 1 : 0;
					d.markup_percent = $body.find('.wz-of-markup').val();
				}
				if ($body.find('.wz-of-act').length)
					d.activate = $body.find('.wz-of-act').is(':checked') ? 1 : 0;
				$body.find('.wz-mx-row').each(function () {
					const row = d.matrix[$(this).data('idx')];
					if (!row) return;
					$(this).find('.wz-mx-val').each(function () {
						row[$(this).data('col')] = $(this).val();
					});
				});
			};
			// Nota ringkas harga sesebuah offer (senarai tarikh & ringkasan).
			const offerNote = (o) => {
				if (wiz.trip.is_a_cruise_trip && o.import_rates)
					return `import schedule${o.markup_percent ? ` +${esc(o.markup_percent)}%` : ''}`;
				const adults = (o.matrix || []).map((r) => parseFloat(r.price_adult))
					.filter((v) => !isNaN(v) && v > 0);
				return adults.length
					? `dari ${esc(o.currency)} ${Math.min(...adults).toLocaleString('en-MY')}`
					: 'tanpa harga';
			};
			const cancelWizard = () => frappe.confirm(
				'Discard this registration? Nothing is created yet.',
				() => frappe.set_route('travel-manager', 'trip'));
			const setBusy = (on) => {
				wiz.busy = on;
				$body.find('.wz-next, .wz-back, .wz-cancel, .wz-add-date, .wz-del-date, ' +
					'.wz-of-open, .wz-of-add, .wz-of-cancel, .wz-of-del, ' +
					'.wz-mx-add, .wz-mx-del')
					.prop('disabled', on);
			};

			// ── Pembina offer (step 3): baris grid matrix manual ──
			// Lebar kolum harga → kelas .wz-mx-col (travel_manager.css).
			const mxRowHtml = (r, idx) => `
				<tr class="wz-mx-row" data-idx="${idx}">
					<td><strong>${esc(r._label || r.pricing_for_class)}</strong></td>
					${MCOLS.map(([col]) => `
					<td class="wz-mx-col"><input class="form-control form-control-sm wz-mx-val"
						data-col="${col}" type="number" min="0" step="0.01"
						value="${r[col] != null && r[col] !== '' ? esc(r[col]) : ''}" placeholder="—"></td>`).join('')}
					<td class="text-center"><button class="btn btn-xs btn-danger wz-mx-del"
						data-idx="${idx}" title="Buang baris ini">✕</button></td>
				</tr>`;
			// ── Pembina offer (step 3): panel input satu offer baharu ──
			// Komponen stok Bootstrap: card() kongsi (card-header + card-body),
			// borang .form-row/.form-group grid col-*, checkbox .custom-control.
			// Lebar kecil tiada utiliti stok → kelas .wz-* (travel_manager.css).
			const draftPanel = (i, catOpts) => {
				const d = wiz.draft;
				const dep = wiz.dates[i].departure_date;
				return card(12, `
					<span class="font-weight-bold">➕ Offer baharu — tarikh ${esc(webFmtDate(dep))}</span>`, `
					<div id="tm-wz-draft-fields" class="form-row">
						<div class="form-group col-12 col-md-6">
							<label class="control-label" for="wz-of-name">Offer Name *</label>
							<input id="wz-of-name" class="form-control form-control-sm wz-of-name" type="text"
								placeholder="cth: ${esc(wiz.trip.trip_name)} : ${esc(dep)}"
								value="${esc(d.offer_name)}">
						</div>
						<div class="form-group col-6 col-md-2">
							<label class="control-label">Currency *</label>
							<div class="wz-of-cur"></div>
						</div>
						<div class="form-group col-3 col-md-2">
							<label class="control-label" for="wz-of-dep">Deposit %</label>
							<input id="wz-of-dep" class="form-control form-control-sm wz-of-dep" type="number"
								min="0" max="100" step="0.1"
								value="${esc(d.deposit_percent ?? '')}" placeholder="global">
						</div>
						<div class="form-group col-3 col-md-2">
							<label class="control-label" for="wz-of-final">Final Pay (hari)</label>
							<input id="wz-of-final" class="form-control form-control-sm wz-of-final" type="number"
								min="0" step="1"
								value="${esc(d.final_payment_days ?? '')}" placeholder="global">
						</div>
					</div>
					${wiz.trip.is_a_cruise_trip ? `
					<div id="tm-wz-draft-import" class="d-flex flex-wrap align-items-center gap-4 my-3">
						<div class="custom-control custom-checkbox">
							<input type="checkbox" class="custom-control-input wz-of-imp" id="wz-of-imp"
								${d.import_rates ? 'checked' : ''}>
							<label class="custom-control-label" for="wz-of-imp">Import kadar kabin daripada cruise schedule</label>
						</div>
						<div class="d-flex align-items-center gap-2">
							<label class="control-label mb-0" for="wz-of-markup">Markup %</label>
							<input id="wz-of-markup" class="form-control form-control-sm wz-of-markup" type="number"
								min="0" max="100" step="0.1"
								value="${esc(d.markup_percent ?? '')}" placeholder="0">
						</div>
					</div>` : ''}
					${(!wiz.trip.is_a_cruise_trip || !d.import_rates) ? `
					<div class="wz-mx-wrap">
						<p class="text-muted small my-1">
							<strong>Price Matrix</strong> — 1 baris = 1 kategori · Adult (twin/share),
							Single (solo), Upper (extra bed), Children (5-11), Toddler (2-4), Infant (0-23 bln).
							Harga kosong = slot tak dijual.</p>
						<div id="tm-wz-mx-addrow" class="d-flex align-items-center gap-2 mb-2">
							<select class="form-control form-control-sm wz-mx-sel" aria-label="Pilih kategori harga">
								<option value="">— tambah kategori —</option>
								${catOpts.map((c) => `<option value="${esc(c.name)}">
									${esc(c.category_code || c.name)}</option>`).join('')}
							</select>
							<button class="btn btn-xs btn-default wz-mx-add">+ Tambah</button>
						</div>
						<table id="tm-wz-mx-table" class="table table-sm mb-0">
							<thead><tr><th>Category</th>${MCOLS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead>
							<tbody>${d.matrix.map((r, idx) => mxRowHtml(r, idx)).join('')
								|| `<tr><td colspan="8" class="text-muted text-center p-2">Tiada baris — pilih kategori di atas dan tekan + Tambah.</td></tr>`}</tbody>
						</table>
					</div>` : ''}
					<div id="tm-wz-draft-actions" class="d-flex flex-wrap gap-2 mt-2">
						<button class="btn btn-primary btn-sm wz-of-add">＋ Tambah ke Tarikh Ini</button>
						<button class="btn btn-default btn-sm wz-of-cancel">Batal</button>
						${isManager ? `
						<div class="custom-control custom-checkbox ml-auto">
							<input type="checkbox" class="custom-control-input wz-of-act" id="wz-of-act"
								${d.activate ? 'checked' : ''}>
							<label class="custom-control-label" for="wz-of-act">Aktifkan offer selepas cipta</label>
						</div>` : ''}
					</div>`);
			};
			// Kad satu tarikh (step 3) — card() kongsi + tmTable() kongsi
			// (komponen stok .card/.card-header/.card-body + .table.table-sm).
			// BOLEH COLLAPSE (arahan pemilik): klik header buka/tutup body —
			// caret ▸/▾, state pada baris (collapsed) kekal merentas
			// re-render (corak kad TRIP INFORMATION).
			const dateCard = (d, i, catOpts) => card(12, `
					<span class="tm-wz-date-toggle pointer d-flex align-items-center w-100"
						data-i="${i}" title="Klik untuk buka/tutup panel">
						<span class="font-weight-bold">🗓️ Travel Date ${i + 1}</span>
						<span class="text-primary font-weight-bold">${esc(webFmtDate(d.departure_date))}</span>
						${d.return_date ? `<span class="text-muted">→ ${esc(webFmtDate(d.return_date))}</span>` : ''}
						<span class="ml-auto text-muted small">${d.offers.length} offer</span>
						<span class="tm-collapse-caret ml-1 text-muted" aria-hidden="true">${d.collapsed ? '▸' : '▾'}</span>
					</span>`,
				`<div id="tm-wz-date-body-${i}" class="wz-date-body${d.collapsed ? ' d-none' : ''}">
				${d.offers.length ? `
				<div class="table-responsive">
				${tmTable(['Offer', 'Cur', 'Harga', 'Status', ''],
					d.offers.map((o, j) => `
					<tr>
						<td><strong>${esc(o.offer_name)}</strong></td>
						<td>${esc(o.currency)}</td>
						<td class="text-muted">${offerNote(o)}</td>
						<td>${o.activate && isManager
							? '<span class="text-ink-green-7 font-weight-bold">→ Active</span>'
							: '<span class="text-muted">→ Draft</span>'}</td>
						<td class="text-center"><button class="btn btn-xs btn-danger wz-of-del"
							data-i="${i}" data-j="${j}" title="Buang offer ini">✕</button></td>
					</tr>`).join(''), null, 'm-0')}
				</div>` : '<p class="text-muted small px-3 py-2 mb-0">Tiada offer pada tarikh ini (boleh ditambah kemudian).</p>'}
				${wiz.draft && wiz.draft.date_i === i ? draftPanel(i, catOpts)
					: `<button class="btn btn-secondary btn-block btn-sm wz-of-open mt-2" data-i="${i}">＋ Add Offer</button>`}
				</div>`, null, null, 'p-0');

			// ── Submit (step 3): cipta SEMUA rekod dalam satu jujukan ──
			const submitAll = async () => {
				if (wiz.busy) return;
				if (wiz.draft) {
					frappe.msgprint('Selesaikan dahulu pembina offer yang terbuka (Tambah atau Batal).');
					return;
				}
				const totalOffers = wiz.dates.reduce((n, d) => n + d.offers.length, 0);
				if (!totalOffers) {
					frappe.msgprint('Sekurang-kurangnya satu offer diperlukan — tambah pada mana-mana tarikh.');
					return;
				}
				// Amaran lembut: offer manual tanpa harga Adult (falsafah
				// setup berperingkat — selari halaman admin offer).
				const noPrice = [];
				wiz.dates.forEach((d) => d.offers.forEach((o) => {
					if (!(wiz.trip.is_a_cruise_trip && o.import_rates)) {
						const adults = (o.matrix || []).map((r) => parseFloat(r.price_adult))
							.filter((v) => !isNaN(v) && v > 0);
						if (!adults.length) noPrice.push(o.offer_name);
					}
				}));
				const go = async () => {
					setBusy(true);
					// .wz-progress ber-class d-none (bukan inline style) — buang
					// kelas, bukan jQuery .show() (d-none ialah !important).
					$body.find('.wz-progress').removeClass('d-none')
						.text('Starting registration…');
					const created = { trip: null, travel_dates: [], offers: [] };
					let done = 0;
					const total = 1 + wiz.dates.length + totalOffers;
					const tick = (msg) => {
						done++;
						$body.find('.wz-progress').text(`${done}/${total} rekod — ${msg}`);
					};
					try {
						const t = await tmg('save_trip', { payload: {
							trip_name: wiz.trip.trip_name,
							trip_organizer: wiz.trip.trip_organizer,
							is_a_cruise_trip: wiz.trip.is_a_cruise_trip,
							status: wiz.trip.status,
							description: wiz.trip.description,
						} });
						created.trip = t?.name;
						tick('trip dicipta');
						for (const dt of wiz.dates) {
							const td = await api('save_travel_date', { values: JSON.stringify({
								trip: created.trip,
								departure_date: dt.departure_date,
								return_date: dt.return_date || null,
								// SATU schedule PER BARIS group date (trip cruise).
								cruise_schedule: dt.cruise_schedule || null,
								// Kategori perjalanan (master Trip Category).
								trip_category: dt.trip_category || null,
							}) });
							created.travel_dates.push(td?.name);
							tick(`travel date ${dt.departure_date} dicipta`);
							for (const o of dt.offers) {
								const res = await api('add_offer_to_date', {
									travel_date: td?.name,
									values: JSON.stringify({
										offer_name: o.offer_name, currency: o.currency }),
								});
								const offerName = res?.offer;
								tick(`offer ${o.offer_name} dicipta`);
								// Harga: import kadar schedule (cruise) ATAU matrix
								// manual — price_matrix ialah sumber harga utama.
								let note = '';
								if (wiz.trip.is_a_cruise_trip && o.import_rates) {
									const adm = await api('get_offer_package_admin',
										{ travel_date: td?.name, offer: offerName });
									const rows = adm?.price_sources?.schedule_rates || [];
									if (rows.length) {
										const imp = await api('import_offer_prices', {
											offer: offerName,
											rows: JSON.stringify(rows),
											markup_percent: o.markup_percent || '',
										});
										note = `${(imp?.added || 0) + (imp?.updated || 0)} baris import` +
											(o.markup_percent ? ` (+${esc(o.markup_percent)}%)` : '');
									} else {
										note = 'schedule tiada kadar — matrix kosong';
									}
								} else if ((o.matrix || []).length) {
									await api('save_offer_price_matrix', {
										offer: offerName,
										rows: JSON.stringify(
											o.matrix.map(({ _label, ...r }) => r)),
									});
									const adults = o.matrix.map((r) => parseFloat(r.price_adult))
										.filter((v) => !isNaN(v) && v > 0);
									note = adults.length
										? `dari ${esc(o.currency)} ${Math.min(...adults).toLocaleString('en-MY')}`
										: 'tiada harga adult';
								}
								if ((o.deposit_percent ?? '') !== '' || (o.final_payment_days ?? '') !== '') {
									// Hantar hanya medan berisi — '' pada parameter
									// beranotasi float/int ditolak Frappe v17.
									const termsArgs = { offer: offerName };
									if ((o.deposit_percent ?? '') !== '')
										termsArgs.deposit_percent = o.deposit_percent;
									if ((o.final_payment_days ?? '') !== '')
										termsArgs.final_payment_days = o.final_payment_days;
									await api('save_offer_payment_terms', termsArgs);
								}
								let statusNow = 'Draft';
								if (o.activate && isManager) {
									await api('set_offer_status', { offer: offerName, status: 'Active' });
									statusNow = 'Active';
								}
								created.offers.push({ name: offerName,
									offer_name: o.offer_name, departure_date: dt.departure_date,
									currency: o.currency, status: statusNow, note });
							}
						}
						wiz.created = created;
						wiz.step = 4;
						render();
					} catch (e) {
						setBusy(false);
						const lines = [];
						if (created.trip) lines.push(`Trip: ${created.trip}`);
						if (created.travel_dates.length)
							lines.push(`Travel dates: ${created.travel_dates.join(', ')}`);
						if (created.offers.length)
							lines.push(`Offers: ${created.offers.map((x) => x.name).join(', ')}`);
						frappe.msgprint({
							title: 'Registration stopped midway',
							message: (lines.length
								? `Records ALREADY created (can be continued in the directory):<br>${lines.join('<br>')}`
								: 'No records were created.') +
								'<br><br>Error: ' + frappe.utils.escape_html(e?.message || String(e)),
							indicator: 'orange',
						});
					}
				};
				if (noPrice.length) {
					frappe.confirm(`Offer berikut tiada harga Adult — teruskan juga? (setup berperingkat)<br>· ${noPrice.join('<br>· ')}`, go);
				} else {
					await go();
				}
			};

			const render = async () => {
				wzCloseRange();  // kalendar julat ditutup sebelum DOM diganti
				if (wiz.step === 1) {
					// Step card — card() kongsi: stepper dalam card-header,
					// borang stok Bootstrap (form-row/form-group/control-label).
					$body.html(card(12, `
							<span class="font-weight-bold">🧭 Step 1 · Trip Information</span>
							<span class="d-flex flex-wrap gap-2 text-small ml-auto">${stepDots()}</span>`, `
						<div class="form-row">
							<div class="form-group col-12">
								<label class="control-label" for="wz-name">Trip Name *</label>
								<input id="wz-name" class="form-control wz-name" type="text"
									placeholder="cth: Roundtrip Istanbul : Cruise Only : MYR"
									value="${esc(wiz.trip.trip_name)}">
							</div>
						</div>
						<div class="form-row">
							<div id="tm-wz-step1-org" class="form-group col-12 col-md-6">
								<label class="control-label">Trip Organizer *</label>
								<div class="wz-org"></div>
							</div>
							<div class="form-group col-6 col-md-3">
								<label class="control-label" for="wz-status">Status</label>
								<select id="wz-status" class="form-control form-control-sm wz-status">
									${['Pending Review', 'Draft', 'Active'].map((s) =>
										`<option ${wiz.trip.status === s ? 'selected' : ''}>${s}</option>`).join('')}
								</select>
							</div>
							<div class="form-group col-6 col-md-3">
								<span class="control-label d-block">Trip Type</span>
								<div class="custom-control custom-checkbox">
									<input type="checkbox" class="custom-control-input wz-cruise" id="wz-cruise"
										${wiz.trip.is_a_cruise_trip ? 'checked' : ''}>
									<label class="custom-control-label" for="wz-cruise">Cruise Trip</label>
								</div>
							</div>
						</div>
						<div class="form-row">
							<div class="form-group col-12">
								<label class="control-label">Description</label>
								<div id="wz-desc"></div>
							</div>
						</div>
						<p class="text-muted small mt-3 mb-0">
							Travel dates dikonfigur di langkah 2; offers (nama, currency
							&amp; harga) di langkah 3.</p>
						${actionRow()}`));
					wzLink($body.find('.wz-org'), {
						fieldname: 'trip_organizer', doctype: 'Trip Organizer',
						value: wiz.trip.trip_organizer,
						placeholder: 'Type the organizer name…',
						set: (v) => { wiz.trip.trip_organizer = v; },
					});
					// Description — Text Editor (Quill WYSIWYG) stok Frappe;
					// doctype Trip.description = Text Editor (HTML). Label halaman
					// disediakan sendiri → only_input (corak tm_trip_website mkCtrl).
					wzDescCtrl = frappe.ui.form.make_control({
						parent: $body.find('#wz-desc')[0],
						df: {
							fieldtype: 'Text Editor', fieldname: 'description',
							placeholder: 'Trip summary…',
						},
						render_input: true,
						only_input: true,
					});
					if (wiz.trip.description) wzDescCtrl.set_value(wiz.trip.description);
					$body.find('.wz-next').on('click', () => {
						if (wiz.busy) return;
						readTripInputs();
						if (!wiz.trip.trip_name) { frappe.msgprint('Trip Name is required.'); return; }
						if (!wiz.trip.trip_organizer) { frappe.msgprint('Trip Organizer is required.'); return; }
						wiz.step = 2;
						render();
					});
				} else if (wiz.step === 2) {
					// ── STEP 2: TRAVEL DATES ──
					// FORMAT TARIKH: paparan ikut Travel Website
					// .date_display_format (webFmtLoad — cache sekali per sessi
					// halaman); nilai state kekal ISO.
					await webFmtLoad();
					const dateExample = webFmtDate(frappe.datetime.get_today());
					const cruise = !!wiz.trip.is_a_cruise_trip;
					// Master Trip Category — dropdown per baris tarikh
					// (Nov 2026, arahan pemilik); selenggara di Desk.
					// [Nov 2026] DITAPIS ikut jenis trip (checkbox
					// is_cruise_trip pada master): cruise → kategori bertanda
					// sahaja; darat → kategori TIDAK bertanda sahaja.
					const cats = await api('list_trip_categories')
						.catch(() => []);
					const catOpts = (sel) => `
						<option value="">— tiada kategori —</option>
						${(cats || []).filter((c) =>
							(c.is_cruise_trip ? 1 : 0) === (cruise ? 1 : 0)).map((c) => `
						<option value="${esc(c.name)}" ${sel === c.name ? 'selected' : ''}>${esc(c.category_name || c.name)}</option>`).join('')}`;
					// CRUISE: SATU schedule PER BARIS group date (bukan satu
					// untuk semua) — senarai + peta utk auto-isi & validasi.
					const schedules = cruise ? await wzGetSchedules() : [];
					const schedMap = {};
					schedules.forEach((s) => { schedMap[s.name] = s; });
					// Label paparan schedule terpilih (kod kapal · sailing
					// start → end, format laman).
					const schedLabel = (name) => {
						const s = schedMap[name];
						return s ? `${s.ship_code || s.ship_name || s.schedule_code || s.name} · ${webFmtDate(s.sail_start)} → ${webFmtDate(s.sail_end)}` : '';
					};
					// Baris satu group date — medan Departure/Return
					// (paparan format laman; SATU kalendar julat kongsi
					// mengisi kedua-duanya) + schedule per baris (trip cruise).
					const dateRow = (i, r) => `
						<div id="tm-wz-date-row-${i}" class="border rounded p-2 mb-2">
							<div class="d-flex flex-wrap align-items-end gap-2">
								<div style="flex:1;min-width:150px">
									<label class="control-label text-muted text-small mb-0" for="wz-dep-${i}">Departure *</label>
									<div class="tm-td-date-wrap" data-i="${i}">
										<input id="wz-dep-${i}" class="form-control form-control-sm wz-dep" type="text"
											autocomplete="off" data-i="${i}" placeholder="${esc(dateExample)}"
											value="${r.departure_date ? esc(webFmtDate(r.departure_date)) : ''}">
										<button type="button" class="tm-td-pick wz-range-pick" data-i="${i}"
											title="Pilih lingkungan tarikh (pergi → pulang)">📅</button>
									</div>
								</div>
								<div style="flex:1;min-width:150px">
									<label class="control-label text-muted text-small mb-0" for="wz-ret-${i}">Return</label>
									<div class="tm-td-date-wrap" data-i="${i}">
										<input id="wz-ret-${i}" class="form-control form-control-sm wz-ret" type="text"
											autocomplete="off" data-i="${i}" placeholder="${esc(dateExample)}"
											value="${r.return_date ? esc(webFmtDate(r.return_date)) : ''}">
										<button type="button" class="tm-td-pick wz-range-pick" data-i="${i}"
											title="Pilih lingkungan tarikh (pergi → pulang)">📅</button>
									</div>
								</div>
								<div style="flex:1;min-width:160px">
									<label class="control-label text-muted text-small mb-0" for="wz-cat-${i}">Trip Category</label>
									<select id="wz-cat-${i}" class="form-control form-control-sm wz-cat"
										data-i="${i}" aria-label="Trip Category">${catOpts(r.trip_category)}</select>
								</div>
								${cruise ? `
								<div style="flex:2;min-width:220px">
									<label class="control-label text-muted text-small mb-0" for="wz-sched-${i}">Cruise Schedule *</label>
									<div id="wz-sched-wrap-${i}" class="wz-sched-wrap">
										<input id="wz-sched-${i}" class="form-control form-control-sm wz-sched" type="text"
											readonly autocomplete="off" data-i="${i}"
											placeholder="— pilih cruise schedule (wajib) —"
											value="${r.cruise_schedule ? esc(schedLabel(r.cruise_schedule)) : ''}"
											title="Klik untuk cari &amp; pilih schedule">
										<button type="button" id="wz-sched-toggle-${i}" class="tm-td-pick wz-sched-toggle"
											data-i="${i}" aria-label="Pilih cruise schedule"
											title="${r.cruise_schedule ? 'Buang pilihan schedule' : 'Cari &amp; pilih cruise schedule'}">${r.cruise_schedule ? '✕' : '▾'}</button>
									</div>
								</div>` : ''}
								<button class="btn btn-xs btn-danger wz-del-date" data-i="${i}"
									title="Buang tarikh ini">✕</button>
							</div>
						</div>`;
					$body.html(card(12, `
							<span class="font-weight-bold">🗓️ Step 2 · Travel Dates</span>
							<span class="d-flex flex-wrap gap-2 text-small ml-auto">${stepDots()}</span>`, `
						<p class="text-muted mb-2">
							Each date becomes a <strong>Travel Date</strong> — pilih
							lingkungan <strong>pergi → pulang</strong> (📅 / fokus medan
							membuka kalendar julat; paparan ikut format laman).
							Tambah <strong>Offers</strong> pada setiap tarikh di langkah
							seterusnya — hierarki Trip &gt;&gt; Travel Date &gt;&gt; Package Offer.
							${cruise ? `<strong>Trip cruise:</strong> satu cruise schedule per
							baris — klik medan untuk cari &amp; pilih (Ship Code /
							sailing date); sailing schedule wajib berada DI DALAM
							lingkungan tarikh baris (Departure ≤ sailing start,
							sailing end ≤ Return).` : ''}</p>
						<div id="tm-wz-dates-rows">${wiz.dates.map((r, i) => dateRow(i, r)).join('')}</div>
						<button class="btn btn-sm btn-default wz-add-date mt-1">+ Date</button>
						<div class="wz-preview border rounded p-2 my-3">
							<strong>Preview:</strong>
							${wiz.dates.filter((x) => x.departure_date).length} travel dates
						</div>
						<div class="wz-progress d-none text-primary font-weight-bold my-2"></div>
						${actionRow()}
						<input class="tm-td-native" id="wz-range-native" type="text"
							tabindex="-1" aria-hidden="true">
						<div id="wz-sched-list" class="tm-sched-list wz-sched-dd d-none">
							<div class="tm-sched-search d-flex align-items-center gap-2 p-2 border-bottom">
								<span class="text-muted text-small text-nowrap">Search:</span>
								<input class="form-control form-control-sm" id="wz-sched-q" type="text"
									placeholder="ship code atau tarikh pelayaran (YYYY-MM-DD)…">
							</div>
							<div id="wz-sched-hint" class="text-muted small px-2 pt-1 d-none"></div>
							<div id="wz-sched-rows"></div>
						</div>`));
					// ── Kalendar julat kongsi (AirDatepicker, corak
					// travel_date_dialog): mod range — pilihan pertama →
					// Departure, kedua → Return; ditulis dalam format laman.
					// Input native disorok dipindah ke wrap medan difokus.
					const rangeNative = $body.find('#wz-range-native')[0];
					const updatePreview = () => {
						readDateInputs();
						const n = wiz.dates.filter((x) => x.departure_date).length;
						$body.find('.wz-preview').html(`<strong>Preview:</strong> ${n} travel dates`);
					};
					const openRange = ($wrap) => {
						if (!rangeNative || !$wrap.length) return;
						wzCloseRange();
						$wrap[0].appendChild(rangeNative);
						wzRangeDP = new AirDatepicker(rangeNative, {
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
								? date.map((x) => moment(x).format(webDispFmt())).join(' → ')
								: moment(date).format(webDispFmt()),
							buttons: ['clear'],
							onSelect: ({date}) => {
								// range: `date` = array tarikh terpilih; baris
								// sasaran = wrap yang menempatkan input native.
								const arr = Array.isArray(date) ? date
									: (date ? [date] : []);
								const ri = $(rangeNative.closest('.tm-td-date-wrap')).data('i');
								if (!arr.length) {
									// butang Clear pada kalendar — kosongkan baris
									$body.find(`#wz-dep-${ri}, #wz-ret-${ri}`)
										.val('').removeClass('tm-date-invalid');
								} else {
									$body.find(`#wz-dep-${ri}`)
										.val(webFmtDate(arr[0])).removeClass('tm-date-invalid');
									$body.find(`#wz-ret-${ri}`)
										.val(arr[1] ? webFmtDate(arr[1]) : '')
										.removeClass('tm-date-invalid');
								}
								updatePreview();
								if (arr.length >= 2) wzCloseRange();
							},
						});
						// Praset kalendar daripada nilai baris semasa (senyap).
						const $dep = $wrap.find('.wz-dep');
						const $ret = $wrap.find('.wz-ret');
						const dep = parseWebDate($dep.val());
						const ret = parseWebDate($ret.val());
						try {
							if (dep && ret) wzRangeDP.selectDate(
								[moment(dep).toDate(), moment(ret).toDate()], {silent: true});
							else if (dep) wzRangeDP.selectDate(moment(dep).toDate(), {silent: true});
							wzRangeDP.setViewDate(moment(dep || ret
								|| frappe.datetime.get_today()).toDate());
						} catch (e) { /* praset gagal — kalendar dari hari ini */ }
						// Tutup bila klik/Escape di luar kalendar & medan
						// (v3 tidak lakukan ini secara default).
						$(document).off('mousedown._tmwz keydown._tmwz')
							.on('mousedown._tmwz', (e) => {
								if ($(e.target).closest(wzRangeDP.$datepicker).length
									|| $(e.target).closest('.tm-td-date-wrap, .tm-td-pick').length)
									return;
								wzCloseRange();
							})
							.on('keydown._tmwz', (e) => {
								if (e.key === 'Escape') wzCloseRange();
							});
						wzRangeDP.show();
					};
					// Delegated + namespace — dibersihkan dahulu supaya
					// re-render step 2 tidak menggandakan handler pada $body.
					$body.off('focus._tmwzrange click._tmwzrange')
						.on('focus._tmwzrange', '.wz-dep, .wz-ret', function () {
							openRange($(this).closest('.tm-td-date-wrap'));
						})
						.on('click._tmwzrange', '.wz-range-pick', function () {
							openRange($(this).closest('.tm-td-date-wrap'));
						});
					// Normalize paparan semasa blur/change: sah → tulis semula
					// dalam format laman; tidak sah → border merah (dilapor
					// semasa Next — corak normalizeDateInput dialog).
					$body.find('.wz-dep, .wz-ret').on('change blur', function () {
						const $el = $(this);
						const raw = String($el.val() || '').trim();
						if (!raw) { $el.removeClass('tm-date-invalid'); return; }
						const iso = parseWebDate(raw);
						if (iso) {
							$el.removeClass('tm-date-invalid');
							if (raw !== webFmtDate(iso)) $el.val(webFmtDate(iso));
						} else $el.addClass('tm-date-invalid');
					});
					// ── Schedule per baris (trip cruise): DROPDOWN CARIAN kongsi
					// (corak senarai schedule travel_date_dialog — Ship Code +
					// Sailing Date, Active & hadapan, carian kod kapal / tarikh
					// dalam lingkungan sailing, had 10 baris). Satu elemen
					// dropdown dikongsi semua baris — dipindah ke wrap medan
					// difokus (seperti kalendar julat). State kekal pada baris;
					// medan readonly memapar label terpilih.
					const schedListEl = $body.find('#wz-sched-list')[0];
					wzSchedEl = schedListEl;
					let openSchedI = null;
					let wzPickAt = 0;  // masa pilihan terakhir — bant klik tembus
					const wzCloseSched = () => {
						$(document).off('mousedown._tmwsched keydown._tmwsched');
						schedListEl.classList.add('d-none');
						openSchedI = null;
					};
					// Telan mouseup/click susulan selepas pilihan ("click-through"):
					// dropdown ditutup pada MOUSEDOWN, tetapi gestur yang sama
					// (mouseup + click) mendarat pada elemen di BAWAH dropdown —
					// untuk baris awal, itu medan/butang schedule baris
					// berikutnya (sama lajur, terus di bawah) → fokus/klik
					// sesaat membuka semula dropdown baris itu (kelihatan
					// seperti "tidak tutup"). Capture, tamat pada click
					// gestur itu (fallback masa pendek); gestur berikutnya
					// tidak terjejas.
					const swallowFollowUp = () => {
						const cleanup = () => ['mouseup', 'click'].forEach((t) =>
							document.removeEventListener(t, swallow, true));
						const swallow = (e) => {
							e.stopPropagation();
							e.preventDefault();
							if (e.type === 'click') cleanup();
						};
						['mouseup', 'click'].forEach((t) =>
							document.addEventListener(t, swallow, true));
						setTimeout(cleanup, 250);
					};
					const renderSchedRows = (q) => {
						const i = openSchedI;
						const cur = i != null ? wiz.dates[i]?.cruise_schedule : null;
						const today = frappe.datetime.get_today();
						const isDateQ = /^\d{4}-\d{2}-\d{2}$/.test(q);
						// AUTO-FILTER LINGKUNGAN BARIS (arahan pemilik Nov 2026
						// — selari dialog Edit Travel Date & validasi Next):
						// bila schedule BELUM dipilih dan kedua-dua tarikh
						// baris terisi, senarai difilter kepada schedule yang
						// berada DI DALAM lingkungan baris — Departure ≤
						// sail_start DAN sail_end ≤ Return; semua opsyen
						// tersenarai lulus validasi Next. Tarikh dibaca terus
						// daripada medan (ISO).
						let depISO = null;
						let retISO = null;
						if (i != null) {
							depISO = parseWebDate($body.find(`#wz-dep-${i}`).val());
							retISO = parseWebDate($body.find(`#wz-ret-${i}`).val());
						}
						const byRange = !cur && depISO && retISO;
						let rows = schedules.filter((s) =>
							(s.status === 'Active' && String(s.sail_end || '') >= today)
							|| s.name === cur);
						const total = rows.length;
						if (byRange) rows = rows.filter((s) =>
							String(s.sail_start || '') >= depISO
							&& String(s.sail_end || '') <= retISO);
						if (q && isDateQ) rows = rows.filter((s) =>
							String(s.sail_start || '') <= q && String(s.sail_end || '') >= q);
						else if (q) rows = rows.filter((s) =>
							[s.ship_code, s.ship_name, s.schedule_code,
								s.sail_start, s.sail_end].join(' ').toLowerCase()
								.includes(q.toLowerCase()));
						// Pilihan semasa baris kekal tersenarai (klik semula
						// boleh) walaupun di luar tapis — corak curLinked dialog.
						if (cur && !q && !rows.some((s) => s.name === cur)) {
							const cs = schedules.find((x) => x.name === cur);
							if (cs) rows.unshift(cs);
						}
						rows = rows.slice(0, 10);
						// Hint — sebut sekatan lingkungan bila filter aktif
						// (corak hint dialog; .text() → '&' literal).
						let hint = byRange
							? `sailing dalam lingkungan ${webFmtDate(depISO)} → ${webFmtDate(retISO)} · `
							: '';
						hint += `${rows.length} daripada ${total} schedule (Active & hadapan)`;
						$body.find('#wz-sched-hint').text(hint).removeClass('d-none');
						$body.find('#wz-sched-rows').html(rows.length ? `
							<table class="table table-sm mb-0 table-hover">
								<thead><tr><th>Ship Code</th><th>Sailing Date</th></tr></thead>
								<tbody>${rows.map((s) => `
									<tr class="wz-sched-row pointer ${s.name === cur ? 'table-primary' : ''}"
										data-name="${esc(s.name)}"
										title="${esc(s.ship_name || '')} · ${esc(s.status || '')}${s.name === cur ? ' · (semasa dipaut)' : ''}">
										<td><strong>${esc(s.ship_code || s.schedule_code || s.name)}</strong></td>
										<td>${esc(webFmtDate(s.sail_start))} → ${esc(webFmtDate(s.sail_end))}</td>
									</tr>`).join('')}</tbody>
							</table>`
							: `<p class="text-muted small p-2 mb-0">Tiada schedule Active${byRange
								? ' dalam lingkungan tarikh baris ini — lebarkan Departure/Return'
								: ''}.</p>`);
					};
					const openSchedList = (i) => {
						// [FIX GUI-TEST Nov 2026] Pendua + re-entrancy:
						// $q.trigger('focus') (jQuery simulate focusin) memancar
						// melalui wrap medan dan memicu handler buka ini SEKALI
						// LAGI — dua salinan #wz-sched-list dalam wrap yang sama
						// (satu berisi baris, satu kosong) → klik mendarat pada
						// salinan kosong ("tidak responsif") dan dropdown
						// kelihatan "tidak tutup". Tiga lapis:
						// (a) pulihkan salinan pendua warisan;
						document.querySelectorAll('#wz-sched-list').forEach((el) => {
							if (el !== schedListEl) el.remove();
						});
						// (b) sudah terbuka untuk baris ini → tiada apa-apa perlu;
						if (openSchedI === i && !schedListEl.classList.contains('d-none')) return;
						wzCloseRange();  // kalendar julat ditutup (satu popover)
						const wrap = $body.find(`#wz-sched-wrap-${i}`)[0];
						if (!wrap || !schedListEl) return;
						openSchedI = i;
						wrap.appendChild(schedListEl);
						schedListEl.classList.remove('d-none');
						const $q = $(schedListEl).find('#wz-sched-q').val('');
						renderSchedRows('');
						$q.off('input._tmwschedq').on('input._tmwschedq',
							frappe.utils.debounce(() => renderSchedRows($q.val()), 250));
						// Tutup bila klik/Escape di luar dropdown & medan baris
						// (v3 AirDatepicker lesson — didengar sendiri).
						$(document).off('mousedown._tmwsched keydown._tmwsched')
							.on('mousedown._tmwsched', (e) => {
								if ($(e.target).closest(schedListEl).length
									|| $(e.target).closest(
										`#wz-sched-wrap-${openSchedI}, .wz-sched-toggle`).length) return;
								wzCloseSched();
							})
							.on('keydown._tmwsched', (e) => {
								if (e.key === 'Escape') wzCloseSched();
							});
						// (c) fokus carian dengan .focus() NATIF — BUKAN
						// $q.trigger('focus') (jQuery simulate = punca re-entry).
						const qEl = schedListEl.querySelector('#wz-sched-q');
						if (qEl) qEl.focus({ preventScroll: true });
					};
					// Delegated + namespace — dibersihkan dahulu supaya
					// re-render step 2 tidak menggandakan handler pada $body.
					$body.off('focus._tmwsched click._tmwsched click._tmwstog ' +
							'mousedown._tmwsselpick')
						// fokus/klik medan baris → buka dropdown baris itu
						// (bant pendek selepas pilihan — klik tembus medan
						// baris lain tidak membuka dropdown semula)
						.on('focus._tmwsched click._tmwsched', '.wz-sched', function () {
							const i = $(this).data('i');
							if (Date.now() - wzPickAt < 350) return;
							if (openSchedI !== i) openSchedList(i);
						})
						// butang ▾/✕ — buka; ✕ membuang pilihan dahulu
						.on('click._tmwstog', '.wz-sched-toggle', function () {
							const i = $(this).data('i');
							if (!wiz.dates[i]) return;
							if (wiz.dates[i].cruise_schedule) {
								wiz.dates[i].cruise_schedule = null;
								$body.find(`#wz-sched-${i}`).val('');
								$(this).text('▾').attr('title', 'Cari & pilih cruise schedule');
							}
							openSchedList(i);
						})
						// Pilih schedule — MOUSEDOWN (bukan click): mousedown
						// berlaku SEBELUM blur medan carian → pilihan terselamat
						// (corak dialog). Baris dengan tarikh kosong di-auto-isi
						// daripada sailing window (tiada tulis-ganti bila
						// pengguna sudah isi — validasi Next yang mengadili).
						.on('mousedown._tmwsselpick', '#wz-sched-rows .wz-sched-row',
							function () {
								const name = $(this).data('name');
								const i = openSchedI;
								if (i == null || !wiz.dates[i]) return;
								wzPickAt = Date.now();
								wiz.dates[i].cruise_schedule = name || null;
								$body.find(`#wz-sched-${i}`)
									.val(schedLabel(name) || name || '');
								$body.find(`#wz-sched-toggle-${i}`).text('✕')
									.attr('title', 'Buang pilihan schedule');
								const s = schedMap[name];
								if (s) {
									const $dep = $body.find(`#wz-dep-${i}`);
									const $ret = $body.find(`#wz-ret-${i}`);
									if (!parseWebDate($dep.val()) && s.sail_start)
										$dep.val(webFmtDate(s.sail_start))
											.removeClass('tm-date-invalid');
									if (!parseWebDate($ret.val()) && s.sail_end)
										$ret.val(webFmtDate(s.sail_end))
											.removeClass('tm-date-invalid');
									updatePreview();
								}
								wzCloseSched();
								swallowFollowUp();
							});
					// Trip Category — tulis state SEGERA pada change (re-render
					// add/del baris baca semula daripada state).
					$body.find('.wz-cat').on('change', function () {
						const i = $(this).data('i');
						if (wiz.dates[i]) wiz.dates[i].trip_category = $(this).val() || '';
					});
					$body.find('.wz-add-date').on('click', () => {
						readDateInputs();
						wiz.dates.push({ departure_date: '', return_date: '',
							offers: [], cruise_schedule: null, collapsed: false });
						render();
					});
					$body.find('.wz-del-date').on('click', function () {
						readDateInputs();
						wiz.dates.splice($(this).data('i'), 1);
						render();
					});
					$body.find('.wz-next').on('click', () => {
						if (wiz.busy) return;
						readDateInputs();
						if ($body.find('.wz-dep.tm-date-invalid, .wz-ret.tm-date-invalid').length) {
							frappe.msgprint('Ada tarikh tidak sah (border merah) — betulkan dahulu.');
							return;
						}
						// Validasi per baris; ISO boleh dibanding rentetan.
						const errs = [];
						wiz.dates.forEach((r, idx) => {
							const n = idx + 1;
							if (!r.departure_date) {
								errs.push(`Tarikh #${n}: Departure wajib.`);
								return;
							}
							if (r.return_date && r.return_date < r.departure_date)
								errs.push(`Tarikh #${n}: Return awal daripada Departure.`);
							if (wiz.trip.is_a_cruise_trip) {
								// Lingkungan baris wajib MERANGKUMI sailing
								// schedule (arahan pemilik Nov 2026 — selari
								// dialog Edit Travel Date): Departure ≤
								// sail_start DAN sail_end ≤ Return.
								if (!r.cruise_schedule) {
									errs.push(`Tarikh #${n}: Cruise Schedule wajib.`);
									return;
								}
								const s = schedMap[r.cruise_schedule];
								if (s) {
									if (!r.return_date)
										errs.push(`Tarikh #${n}: Return wajib — `
											+ `sailing mesti di dalam lingkungan pergi → pulang.`);
									if (r.departure_date > String(s.sail_start || ''))
										errs.push(`Tarikh #${n}: Departure (${webFmtDate(r.departure_date)}) `
											+ `selepas sailing start (${webFmtDate(s.sail_start)}) `
											+ `— sailing mesti di dalam lingkungan baris.`);
									if (r.return_date && r.return_date < String(s.sail_end || ''))
										errs.push(`Tarikh #${n}: Return (${webFmtDate(r.return_date)}) `
											+ `sebelum sailing end (${webFmtDate(s.sail_end)}) `
											+ `— sailing mesti di dalam lingkungan baris.`);
								}
							}
						});
						if (errs.length) {
							frappe.msgprint({ title: 'Travel Dates tidak sah',
								message: errs.join('<br>'), indicator: 'red' });
							return;
						}
						wiz.dates = wiz.dates.filter((x) => x.departure_date);
						if (!wiz.dates.length) { frappe.msgprint('At least 1 departure date.'); return; }
						wiz.step = 3;
						render();
					});
				} else if (wiz.step === 3) {
					// ── STEP 3: PACKAGE OFFERS ──
					// Kategori master untuk grid manual (cruise → kategori
					// Cruise; selainnya Tour) — selari _category_options_payload.
					let catOpts = [];
					try {
						catOpts = (await tmg('room_categories', {
							price_category: wiz.trip.is_a_cruise_trip ? 'Cruise' : 'Tour',
						}).catch(() => [])) || [];
					} catch (e) { /* senarai kosong — grid manual tanpa pilihan */ }
					const totalOffers = wiz.dates.reduce((n, d) => n + d.offers.length, 0);
					$body.html(card(12, `
							<span class="font-weight-bold">📦 Step 3 · Package Offers</span>
							<span class="d-flex flex-wrap gap-2 text-small ml-auto">${stepDots()}</span>`, `
						<p class="text-muted mb-2">
							Setiap offer dicipta di bawah tarikhnya — hierarki
							Trip &gt;&gt; Travel Date &gt;&gt; Package Offer. Offer cruise boleh
							<strong>import kadar kabin</strong> terus daripada cruise
							schedule (+ markup %); selainnya isi Price Matrix manual.
							Semua rekod dicipta hanya apabila <strong>Create Trip</strong>
							ditekan.</p>
						${wiz.dates.map((d, i) => dateCard(d, i, catOpts)).join('')}
						<div class="border rounded p-2 my-3">
							<strong>Preview:</strong> ${wiz.dates.length} travel dates ·
							${totalOffers} offers
						</div>
						<div class="wz-progress d-none text-primary font-weight-bold my-2"></div>
						${actionRow('Create Trip')}`));
				// Currency = Link autocomplete — senarai terus daripada
				// doctype Currency (bukan senarai statik). Dipasang semula
				// pada setiap render kerana draftPanel dibina bersama HTML.
				if (wiz.draft && $body.find('.wz-of-cur').length) {
					wzLink($body.find('.wz-of-cur'), {
						fieldname: 'currency', doctype: 'Currency', small: true,
						value: wiz.draft.currency,
						placeholder: 'MYR…',
						set: (v) => { if (wiz.draft) wiz.draft.currency = v; },
					});
				}
				// Kad Travel Date boleh COLLAPSE — delegated + namespace
				// (re-render step 3 tidak menggandakan handler). Toggle DOM
				// TANPA re-render supaya nilai input pembina offer yang
				// terbuka kekal (corak kad TRIP INFORMATION).
				$body.off('click._tmwzdate').on('click._tmwzdate',
					'.tm-wz-date-toggle', function () {
						const i = $(this).data('i');
						const d = wiz.dates[i];
						if (!d) return;
						d.collapsed = !d.collapsed;
						$body.find(`#tm-wz-date-body-${i}`)
							.toggleClass('d-none', d.collapsed);
						$(this).find('.tm-collapse-caret')
							.text(d.collapsed ? '▸' : '▾');
					});
				// Buka pembina offer pada tarikh (pembina sedia ada dipindah —
					// nilai yang sudah ditaip kekal).
					$body.find('.wz-of-open').on('click', function () {
						if (wiz.busy) return;
						const i = $(this).data('i');
						if (wiz.draft) {
							wiz.draft.date_i = i;
						} else {
							wiz.draft = {
								date_i: i,
								offer_name: `${wiz.trip.trip_name} : ${wiz.dates[i].departure_date}`,
								currency: 'MYR', deposit_percent: '', final_payment_days: '',
								import_rates: 1, markup_percent: '',
								matrix: [], activate: 0,
							};
						}
						render();
					});
					// Toggle import ↔ grid manual tanpa re-render (CSS sahaja).
					$body.find('.wz-of-imp').on('change', function () {
						$body.find('.wz-mx-wrap').toggle(!$(this).is(':checked'));
					});
					// Tambah / buang baris matrix manual.
					$body.find('.wz-mx-add').on('click', () => {
						if (wiz.busy) return;
						readDraftInputs();
						const sel = $body.find('.wz-mx-sel').val();
						if (!sel) { frappe.msgprint('Pilih kategori dahulu.'); return; }
						if (wiz.draft.matrix.some((r) => r.pricing_for_class === sel)) {
							frappe.msgprint('Kategori ini sudah ada dalam matrix.');
							return;
						}
						const cat = catOpts.find((c) => c.name === sel);
						wiz.draft.matrix.push({ pricing_for_class: sel,
							_label: cat ? (cat.category_code || cat.name) : sel,
							price_adult: '', price_adult_single: '', price_upperberth: '',
							price_children: '', price_toddler: '', price_infant: '' });
						render();
					});
					$body.find('.wz-mx-del').on('click', function () {
						if (wiz.busy) return;
						readDraftInputs();
						wiz.draft.matrix.splice($(this).data('idx'), 1);
						render();
					});
					// Commit / buang pembina offer.
					$body.find('.wz-of-add').on('click', () => {
						if (wiz.busy) return;
						readDraftInputs();
						const d = wiz.draft;
						if (!d) return;
						if (!d.offer_name) { frappe.msgprint('Offer Name is required.'); return; }
						if (!d.currency) { frappe.msgprint('Currency is required.'); return; }
						const useImport = wiz.trip.is_a_cruise_trip && d.import_rates;
						if (!useImport && !d.matrix.length) {
							frappe.msgprint('Tambah sekurang-kurangnya satu baris Price Matrix — atau aktifkan import kadar schedule (trip cruise).');
							return;
						}
						wiz.dates[d.date_i].offers.push({
							offer_name: d.offer_name, currency: d.currency,
							deposit_percent: d.deposit_percent,
							final_payment_days: d.final_payment_days,
							import_rates: d.import_rates, markup_percent: d.markup_percent,
							matrix: d.matrix.map((r) => ({ ...r })), activate: d.activate,
						});
						wiz.draft = null;
						render();
					});
					$body.find('.wz-of-cancel').on('click', () => {
						if (!wiz.busy) { wiz.draft = null; render(); }
					});
					$body.find('.wz-of-del').on('click', function () {
						if (wiz.busy) return;
						wiz.dates[$(this).data('i')].offers.splice($(this).data('j'), 1);
						render();
					});
					$body.find('.wz-next').on('click', submitAll);
				} else {
					// ── STEP 4: RINGKASAN (selepas submit berjaya) ──
					const c = wiz.created || { trip: '', travel_dates: [], offers: [] };
					set_trip_title('Register New Trip');
					$body.html(card(12, `
							<span class="font-weight-bold">✅ Registration Complete</span>
							<span class="d-flex flex-wrap gap-2 text-small ml-auto">${stepDots()}</span>`, `
						<div id="tm-wz-done-head" class="d-flex flex-wrap align-items-center gap-3 my-3">
							<h3 class="mb-0" aria-hidden="true">✅</h3>
							<div><div class="text-large font-weight-bold">Trip didaftarkan — ${esc(c.trip)}</div>
								<div class="text-muted">${c.travel_dates.length} travel dates ·
									${c.offers.length} offers. Offer Draft selamat dibiarkan — aktifkan
									pada halaman tarikh bila sedia jual.</div></div>
						</div>
						<div class="table-responsive">
						<table id="tm-wz-done-table" class="table table-sm mb-0">
							<thead><tr><th>Travel Date</th><th>Offer</th><th>Cur</th>
								<th>Status</th><th>Harga</th></tr></thead>
							<tbody>${c.offers.map((o) => `
								<tr><td>${esc(webFmtDate(o.departure_date))}</td>
									<td><strong>${esc(o.offer_name)}</strong>
										<div class="text-muted text-small">${esc(o.name)}</div></td>
									<td>${esc(o.currency)}</td>
									<td>${o.status === 'Active'
										? '<span class="text-ink-green-7 font-weight-bold">Active</span>'
										: '<span class="text-muted">Draft</span>'}</td>
									<td class="text-muted">${esc(o.note)}</td></tr>`).join('')
								|| `<tr><td colspan="5" class="text-muted text-center p-2">Tiada offer.</td></tr>`}</tbody>
						</table>
						</div>
						<div class="d-flex flex-wrap gap-2 align-items-center mt-3">
							<button class="btn btn-primary btn-sm wz-open-trip">🚀 Buka Trip</button>
							<button class="btn btn-default btn-sm wz-done">Tutup</button>
						</div>`));
					$body.find('.wz-open-trip').on('click', () =>
						frappe.set_route('travel-manager', 'trip', c.trip));
					$body.find('.wz-done').on('click', () =>
						frappe.set_route('travel-manager', 'trip'));
				}
				// Shared controls (step 1-3 sahaja — step 4 ialah terminal):
				// Back menyimpan input tarikh & schedule sebelum undur.
				if (wiz.step < 4) {
					$body.find('.wz-back').on('click', () => {
						if (wiz.busy) return;
						if (wiz.step === 2) readDateInputs();  // simpan tarikh sebelum undur
						wiz.draft = null;
						wiz.step -= 1;
						render();
					});
					$body.find('.wz-cancel').on('click', () => {
						if (!wiz.busy) cancelWizard();
					});
				}
			};

			render();
		}
