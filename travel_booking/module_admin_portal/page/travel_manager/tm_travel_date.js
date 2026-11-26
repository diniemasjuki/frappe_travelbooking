	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: DATE DIRECTORY (tm_travel_date.js)
	   ════════════════════════════════════════════════════════════════════
	   Halaman satu Travel Date — kad GROUP INFO (edit date), ROOMING
	   CATEGORIES + availabiliti, PACKAGES ON THIS DATE (→ halaman admin
	   pakej), navigasi prev/next 3-zone.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_travel_date() (router).
	   ════════════════════════════════════════════════════════════════════ */

		// Peringkat TRAVEL DATE — susun atur (Nov 2026):
		//   Kad 1 ROOMING CATEGORIES (tanggal + schedule + availabiliti —
		//         senarai jenis rooming, klik → modal info; tiada edit kuota)
		//   Kad 2 PACKAGES ON THIS DATE (baris → halaman admin pakej)
		//   + butang ← Back to Trip + breadcrumb berfungsi penuh.
		async function load_travel_date(trip, dateName) {
			// Breadcrumb sementara (label trip docname) — diganti nama penuh
			// trip + label tarikh selepas detail termuat.
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: trip, route: ['travel-manager', 'trip', trip] },
				{ label: '…' },
			]);
			$body.html(loading());

			// Format paparan tarikh Travel Website (kad TRIP INFORMATION).
			await webFmtLoad();
			const d = await api('get_travel_date_detail', { travel_date: dateName });
			if (!d?.date) {
				$body.html('<p class="text-muted small p-4">Travel date not found.</p>');
				return;
			}
			const date = d.date;
			// Breadcrumb muktamad: nama penuh trip + label tarikh (departure ·
			// ship) — SEMUA segmen boleh diklik balik.
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: date.trip_name || trip, route: ['travel-manager', 'trip', trip] },
				{ label: (date.departure_date || '') +
					(date.ship_name ? ' · ' + date.ship_name : '') },
			]);

			const isManager = !!(frappe.user_roles || []).some((r) => r === 'System Manager' || r === 'Tour Manager');

			// ── NAVIGASI — perkara PERTAMA dalam tm-body ──
			// Prev/Next merentasi Travel Date trip yang sama (senarai sejadi
			// melalui get_travel_dates_list — hierarki Trip > Date).
			const datesList = (await api('get_travel_dates_list',
				{ trip, limit: 200 }))?.dates || [];
			// [BUANG Nov 2026] Panel TRIP INFORMATION pada halaman tarikh —
			// dibuang (arahan pemilik); fetch tripInfo turut dibuang (tiada
			// pemanggil lagi). GROUP INFO mukadimah halaman.
			const dIdx = datesList.findIndex((x) => x.name === dateName);
			const prevDate = dIdx > 0 ? datesList[dIdx - 1] : null;
			const nextDate = (dIdx >= 0 && dIdx < datesList.length - 1)
				? datesList[dIdx + 1] : null;
			const navRow = `
				<div id="tm-td-navrow" class="d-flex flex-wrap align-items-center gap-2 mt-5 mb-4">
					<div class="flex-fill min-w-0">
						<button class="btn btn-default btn-sm" id="tm-back-to-trip">← Back to Trip</button>
					</div>
					<div class="d-flex align-items-center gap-2">
						<button class="btn btn-default btn-sm" id="tm-td-prev"
							${prevDate ? '' : 'disabled'}
							title="${prevDate ? esc(prevDate.departure_date || prevDate.name) : 'Tarikh pertama'}">‹ Prev</button>
						<span class="text-muted text-nowrap text-small">Date ${dIdx + 1} / ${datesList.length}</span>
						<button class="btn btn-default btn-sm" id="tm-td-next"
							${nextDate ? '' : 'disabled'}
							title="${nextDate ? esc(nextDate.departure_date || nextDate.name) : 'Tarikh terakhir'}">Next ›</button>
					</div>
					<div class="flex-fill min-w-0 text-right">
						${isManager ? `
						<button class="btn btn-danger btn-sm" id="tm-delete-date"
							title="Padam group date ini dan offer-offer di dalamnya">
							🗑 Delete Date</button>` : ''}
					</div>
				</div>`;

			// ── KAD 1: GROUP INFO — fungsi kongsi (butang Edit Date pada
			// card-header; jadual rooming = baris 4 grid info).

			// ── ROOMING CATEGORIES (arahan pemilik Nov 2026) — jadual TANPA
			// tajuk/collapsible, BARIS BAWAH SKALI grid GROUP INFO:
			//   Berpaut cruise schedule → TERUS dari cabin_rates schedule
			//     (kategori + kadar dewasa + sold/available live).
			//   Non-cruise → senarai Trip Price Category (kategori umum).
			//   Klik baris → modal maklumat kategori penuh.
			//   Tiada info kategori → baris disembunyikan penuh.
			const roomingRows = d.rooming || [];
			const roomingInner = roomingRows.length ? `
				<table id="tm-room-table" class="table table-hover table-sm mb-0">
					<thead><tr><th>Room Category</th>
						<th class="text-right">Sold</th>
						<th class="text-right">Available</th></tr></thead>
					<tbody>${roomingRows.map((r) => `
						<tr class="tm-room-info pointer" data-cat="${esc(r.room_category)}"
							data-catname="${esc(r.category_name)}"
							data-code="${esc(r.category_code)}"
							data-sold="${r.sold || 0}" data-avail="${r.available ?? '—'}"
							title="Klik untuk maklumat kategori penuh">
							<td><strong>${esc(r.category_name || r.category_code)}</strong>
								<span class="text-muted text-small">${esc(r.category_code || '')}</span></td>
							<td class="text-right">${r.sold || 0}</td>
							<td class="text-right">${r.available ?? '—'}</td>
						</tr>`).join('')}</tbody>
				</table>` : '';
			// GROUP INFO (helper kongsi) — jadual rooming sebagai baris
			// bawah skali grid (helper render terus, tanpa pembalut).
			const groupCard = groupInfoCardHtml(date, true, roomingInner);

			// ── Pane PACKAGE: PACKAGES ON THIS DATE (hierarki ERD: Trip >
			// Date > Package). Baris klik → halaman admin PAKEJ (payment
			// terms + price matrix + components — TIADA inventori), bukan
			// modal. Kolum RINGKAS (Nov 2026 — arahan pemilik): Package ·
			// Currency · Editorial · Operational · Sold Pax sahaja —
			// harga/payment terms dilihat di halaman admin pakej; status
			// Active/Cancelled dikemaskini melalui dialog status halaman
			// pakej.
			const offers = d.offers || [];
			let pkgInner;
			if (offers.length) {
				pkgInner = `
				<div id="tm-td-offers-scroll" class="overflow-auto">
				<table id="tm-td-offers-table" class="table table-sm table-hover mb-0">
					<thead><tr><th>Package</th><th>Type</th><th>Currency</th>
						<th>Editorial</th><th>Operational</th><th>Sold Pax</th></tr></thead>
					<tbody>${offers.map((o) => `
						<tr class="tm-pkg-row pointer" data-offer="${esc(o.name)}"
							title="Buka admin pakej (payment terms, price matrix, components)">
							<td><strong>${esc(o.package_name || '')}</strong></td>
							<td>${o.offer_type === 'Mixed'
								? badge(`Mixed (${o.addon_count ?? 0})`, C.blue)
								: badge('Basic', C.gray)}</td>
							<td>${esc(o.currency || '') || '—'}</td>
							<td>${badge(o.status_editorial, DEP_COLOR[o.status_editorial] || C.gray)}</td>
							<td>${badge(o.status_operational, OPE_COLOR[o.status_operational] || C.gray)}</td>
							<td>${o.sold_pax || 0}</td>
						</tr>`).join('')}</tbody>
				</table></div>`;
			} else {
				pkgInner = '<p class="text-muted small">No packages on this date yet.</p>';
			}
			// MODEL BAHARU: offer identiti sendiri — nama + currency; harga
			// diisi selepasnya melalui Price Matrix (import/extract).
			pkgInner += `
				<div id="tm-add-offer" class="d-flex flex-wrap gap-2 align-items-center mt-2">
					<input class="form-control form-control-sm" id="tm-add-offer-name"
						placeholder="Offer name — cth: Cruise Only MYR" style="max-width:300px">
					<div id="tm-add-offer-cur" class="tm-add-offer-cur" style="width:150px"></div>
					<button class="btn btn-primary btn-sm" id="tm-add-pkg-btn">+ Add Offer</button>
				</div>`;
			// Pane content TANPA kad (Nov 2026 — arahan pemilik): kandungan
			// terus dalam tab-pane — tiada card-header, tiada kelas
			// .card/.card-body (senarai + Add Offer; room category KEMBALI ke
			// GROUP INFO — section collapsible baris bawah).
			const pkgCard = `<div>${pkgInner}</div>`;

			// ── Pane BOOKING & TRAVELLER: senarai jualan tarikh ini
			// (Nov 2026), adaptasi page Manage Booking App
			// (get_group_travellers & get_booking_profile — skrip/API disalin
			// dan dipangkas untuk kad). Datatable carian client-side
			// (tmDataTable, komponen kongsi). Muat selari; gagal satu →
			// senarai itu kosong, kad kekal (tiada blok muat keseluruhan).
			const [bkRes, tvRes] = await Promise.allSettled([
				api('get_date_bookings', { travel_date: dateName }),
				api('get_date_travellers', { travel_date: dateName }),
			]);
			const bkRows = (bkRes.status === 'fulfilled' ? bkRes.value : null) || [];
			const tvRows = (tvRes.status === 'fulfilled' ? tvRes.value : null) || [];

			// Warna badge status — adaptasi peta warna Manage Booking App
			// (PAYMENT_STATUS_COLORS / RES_STATUS_COLORS / DOC_STATUS_COLORS)
			// ke paksi hex kad Travel Manager (C). Status Booking —
			// BKG_COLOR sedia ada (tm_shared).
			const PAY_COLOR = {
				'Pending': C.orange, 'Partially Paid': C.blue, 'Paid': C.green,
				'Request Refund': C.orange, 'Pending Refund': C.orange,
				'Refunded': C.gray, 'Canceled': C.gray, 'Cancelled': C.red,
			};
			const RES_COLOR = {
				'Waiting Document': C.orange, 'Document Completed': C.green,
				'Document Expired': C.red, 'Preparation Completed': C.blue,
				'Trip On Progress': C.orange, 'Completed': C.gray,
				'Cancelled': C.red,
			};
			const DOC_COLOR = {
				'Incomplete': C.orange, 'Pending': C.orange,
				'Open for Update': C.orange, 'Pending Verification': C.blue,
				'Verified': C.green, 'Expired': C.red,
			};

			// Pane content TANPA kad — mount datatable terus dalam pane
			// (footer datatable dibina DALAM mount — tm_shared). Header kad
			// (pembilang) dibuang — arahan pemilik Nov 2026.
			const bookingsCard = '<div id="tm-td-bk-dt"></div>';
			const travellersCard = '<div id="tm-td-tv-dt"></div>';

			// ── Pane ITINERARY (Nov 2026 — arahan pemilik): jadual KEMAS
			// (import asas daripada section table itinerary TRIP — seperti
			// halaman Website) + FITUR OVERWRITE KEKAL: editor
			// "reuse + checkbox overwrite" mod PLAIN (tiada header/kelas kad)
			// — baca-sahaya bila switch OFF (baris trip), editor penuh
			// (salin/+ Hari/drag/Simpan) bila switch ON. showSource — caption
			// "N hari · asas daripada Trip" di bawah jadual.
			const itinCard = itineraryOverrideCard({
				parenttype: 'Travel Date', name: dateName,
				payload: d.itinerary, parentLabel: 'Trip',
				plain: true,
				showSource: true,
				onSaved: () => load_travel_date(trip, dateName),
			});

			// ── TAB LAYOUT (Nov 2026 — arahan pemilik): 4 kandungan jadi
			// tab. CSS stok .nav-tabs/.tab-pane (desk.bundle.css), TETAPI
			// desk TIADA Bootstrap JS (bundle bootstrap-4-web hanya untuk
			// website/web-form) → toggle .active DIURUS SENDIRI di bawah
			// (corak yang sama dipakai tab halaman admin pakej). href
			// javascript:void(0) — elak hash router Frappe.
			// RE-INIT BODY PANE (arahan pemilik): kandungan setiap pane
			// DIBUAT SEMULA setiap kali tabnya diaktifkan (initPaneBody) —
			// kawalan yang diukur ketika pane tersembunyi (Link control,
			// datatable) sentiasa dibina segar ketika pane AKTIF. Handler
			// kandungan pane guna DELEGASI $body (bertahan merentasi
			// re-init); pane lalai (Package) dibina segera selepas render.
			const dateTabs = [
				{ id: 'pkg', label: '📦 Package' },
				{ id: 'itin', label: '🗓️ Itinerary' },
				{ id: 'bkg', label: '🧾 Booking' },
				{ id: 'tv', label: '👥 Traveller' },
			];
			const dateTabsNav = `
				<ul class="nav nav-tabs mb-3" id="tm-td-tabs">
					${dateTabs.map((t, i) => `
					<li class="nav-item"><a class="nav-link ${i === 0 ? 'active' : ''}"
						href="javascript:void(0)" data-tm-tab="${t.id}" role="tab"
						aria-controls="tm-td-tab-${t.id}">${t.label}</a></li>`).join('')}
				</ul>`;
			const dateTabsPanes = `
				<div class="tab-content" id="tm-td-tab-content">
					${dateTabs.map((t, i) => `
					<div class="tab-pane ${i === 0 ? 'active' : ''}" id="tm-td-tab-${t.id}"
						role="tabpanel" aria-labelledby="tm-td-tab-${t.id}"></div>`).join('')}
				</div>`;

			// GROUP INFO mukadimah halaman (kad pertama selepas nav row);
			// TAB layout di bawahnya (arahan pemilik Nov 2026). Pane
			// DISEMBUNYIKAN kosong — body diisi initPaneBody() di bawah.
			$body.html(`${navRow}<div>${groupCard}</div>
				${dateTabsNav}${dateTabsPanes}`);

			// State Currency Add Offer — LUAR initPaneBody (nilai kekal
			// merentasi re-init); kawalan Link dibina semula bersama pane.
			let addOfferCur = 'MYR';

			// Datatable BOOKINGS — baris klik → deep-link page Booking
			// Management (/app/booking-management/booking/<name> — route
			// booking/<name> page penuh, mengganti manage-booking-app).
			const bkRowHtml = (b) => `
				<tr class="tm-bk-row pointer" data-bk="${esc(b.name)}"
					title="Buka booking dalam Manage Booking App">
					<td><strong>${esc(b.name)}</strong>
						<div class="text-muted text-small">${esc(b.booking_number || '')}</div></td>
					<td>${esc(b.customer_name || b.customer || '—')}
						<div class="text-muted text-small">${esc(b.booking_channel || '')}${b.checkout_method ? ' · ' + esc(b.checkout_method) : ''}</div></td>
					<td>${esc(b.package_offer || b.trip_package || '—')}</td>
					<td class="text-right">${b.booked_pax ?? 0}</td>
					<td>${badge(b.status || '-', BKG_COLOR[b.status] || C.gray)}</td>
					<td>${badge(b.payment_status || '-', PAY_COLOR[b.payment_status] || C.gray)}
						<div class="text-muted text-small">${Math.round(b.prog_payment || 0)}% paid</div></td>
					<td class="text-nowrap">
						<strong>${esc(b.currency || '')} ${fmtNum(b.gross)}</strong>
						<div class="text-muted text-small">paid ${fmtNum(b.paid)} · bal ${fmtNum(b.balance)}</div></td>
				</tr>`;
			const mountBkDt = () => tmDataTable('#tm-td-bk-dt', bkRows, {
				footer: true, pageSize: 10,
				searchPlaceholder: 'Search booking / customer…',
				filterLabel: 'All booking statuses',
				emptyMsg: 'No bookings on this date.',
				headers: ['Booking', 'Customer', 'Package / Offer', 'Pax',
					'Status', 'Payment', 'Amount'],
				searchIn: (b) => [b.name, b.booking_number, b.customer,
					b.customer_name, b.status, b.payment_status, b.trip_package,
					b.package_offer, b.booking_channel, b.checkout_method,
					b.currency].join(' '),
				filterOf: (b) => b.status || '',
				sortVal: (b) => b.creation || '',
				rowHtml: bkRowHtml,
			});

			// Datatable TRAVELLERS — baris klik → form Booking Reservation
			// (pautan sama digunakan panel traveller Manage Booking App).
			const tvRowHtml = (t) => `
				<tr class="tm-tv-row pointer" data-rsv="${esc(t.reservation)}"
					title="Buka Booking Reservation">
					<td><strong>${esc(t.traveller_name || '—')}</strong>
						${t.traveller ? '' : `<div class="text-muted text-small">slot guest — tiada rekod Traveller</div>`}</td>
					<td class="text-nowrap">${esc(t.reservation || '')}
						<div class="text-muted text-small">${esc(t.booking || '')}</div></td>
					<td>${esc(t.pax_type || t.guest_label || '—')}
						<div class="text-muted text-small">#${t.guest_sequence ?? ''}</div></td>
					<td>${esc(t.room_category || '—')}
						<div class="text-muted text-small">${esc(t.stateroom_no || t.cabin_no || '')}</div></td>
					<td>${esc(t.passport_no || '—')}
						<div class="text-muted text-small">${esc(t.nationality || '')}</div></td>
					<td>${badge(t.reservation_status || '-', RES_COLOR[t.reservation_status] || C.gray)}</td>
					<td>${badge(t.document_status || '-', DOC_COLOR[t.document_status] || C.gray)}</td>
				</tr>`;
			const mountTvDt = () => tmDataTable('#tm-td-tv-dt', tvRows, {
				footer: true, pageSize: 10,
				searchPlaceholder: 'Search guest / passport / booking…',
				filterLabel: 'All reservation statuses',
				emptyMsg: 'No travellers on this date.',
				headers: ['Traveller', 'Reservation', 'Pax Type', 'Room',
					'Passport', 'Reservation Status', 'Documents'],
				searchIn: (t) => [t.reservation, t.booking, t.booking_number,
					t.traveller_name, t.traveller, t.pax_type, t.guest_label,
					t.room_category, t.stateroom_no, t.cabin_no, t.room_id,
					t.passport_no, t.nationality, t.email, t.phone,
					t.reservation_status, t.document_status].join(' '),
				filterOf: (t) => t.reservation_status || '',
				sortVal: (t) => [t.booking_number || t.booking || '',
					String(t.guest_sequence ?? '').padStart(3, '0')].join(' '),
				rowHtml: tvRowHtml,
			});

			// Klik baris → navigasi (delegasi $body, NAMASPACE + .off() —
			// corak kad TRAVEL DATES: handler lama mesti dibuang).
			$body.off('click._tmtdbk', '#tm-td-bk-dt .tm-bk-row')
				.on('click._tmtdbk', '#tm-td-bk-dt .tm-bk-row', function () {
					frappe.set_route('travel-manager', 'booking-group',
						$(this).data('bk'));
				});
			$body.off('click._tmtdtv', '#tm-td-tv-dt .tm-tv-row')
				.on('click._tmtdtv', '#tm-td-tv-dt .tm-tv-row', function () {
					frappe.set_route('Form', 'Booking Reservation',
						$(this).data('rsv'));
				});

			// RE-INIT body pane — dipanggil untuk pane lalai & SETIAP
			// aktivasi tab (arahan pemilik Nov 2026).
			const initPaneBody = (id) => {
				const $pane = $body.find('#tm-td-tab-' + id);
				if (!$pane.length) return;
				if (id === 'pkg') {
					$pane.html(pkgCard);
					// Currency Add Offer — kawalan Link autocomplete (senarai
					// terus daripada doctype Currency yang enabled sahaja),
					// bukan senarai keras MYR/SGD/USD; lalai MYR. Dibina
					// SEMULA bersama pane — kawalan yang diukur ketika pane
					// tersembunyi boleh cacat lebar.
					makeLink($pane.find('#tm-add-offer-cur')[0], {
						fieldname: 'add_offer_currency', doctype: 'Currency',
						filters: { enabled: 1 }, small: true,
						value: addOfferCur, placeholder: 'MYR…',
						set: (v) => { addOfferCur = v; },
					});
				} else if (id === 'itin') {
					// Komponen override (mod plain) — html + wire SEMULA
					// bersama pane (handler switch/butang ikut re-init).
					$pane.html(itinCard.html());
					itinCard.wire();
				} else if (id === 'bkg') {
					$pane.html(bookingsCard);
					mountBkDt();
				} else if (id === 'tv') {
					$pane.html(travellersCard);
					mountTvDt();
				}
			};
			// Pane lalai (Package — aktif) dibina segera.
			initPaneBody('pkg');

			// Tab switching — toggle .active sendiri (desk tiada Bootstrap
			// JS) + RE-INIT body pane aktif. Delegasi $body + NAMASPACE +
			// .off() — corak kad TRAVEL DATES: handler lama (load
			// sebelumnya) mesti dibuang dahulu.
			$body.off('click._tmtdtab', '#tm-td-tabs .nav-link')
				.on('click._tmtdtab', '#tm-td-tabs .nav-link', function (ev) {
					ev.preventDefault();
					const $link = $(this);
					const id = $link.data('tmTab');
					$link.closest('.nav-tabs').find('.nav-link').removeClass('active');
					$link.addClass('active');
					$body.find('#tm-td-tab-content > .tab-pane').removeClass('active');
					initPaneBody(id);
					$body.find('#tm-td-tab-' + id).addClass('active');
				});

			// ── Wiring ──
			// (1) Navigasi balik ke trip info.
			$body.find('#tm-back-to-trip').on('click', () =>
				frappe.set_route('travel-manager', 'trip', trip));
			if (prevDate) $body.find('#tm-td-prev').on('click', () =>
				frappe.set_route('travel-manager', 'trip', trip, 'date', prevDate.name));
			if (nextDate) $body.find('#tm-td-next').on('click', () =>
				frappe.set_route('travel-manager', 'trip', trip, 'date', nextDate.name));
			// Padam GROUP DATE ini (offers anak ikut terpadam) — konfirmasi
			// dua peringkat: amaran senarai + taip nama tarikh.
			$body.find('#tm-delete-date').on('click', () => {
				const nOffers = (d.offers || []).length;
				frappe.prompt(
					[
						{
							fieldname: 'confirm_name', fieldtype: 'Data',
							label: `Taip <strong>${esc(dateName)}</strong> untuk sahkan pemadaman`,
							reqd: 1,
							description: `Akan DIPADAM SELAMANYA: group date ${esc(dateName)} `
								+ `(${esc(date.departure_date || '')}) beserta ${nOffers} offer(s) `
								+ `dan harga/komponennya. Trip dan tarikh-tarikh lain kekal. `
								+ `Booking aktif akan MENYEKAT pemadaman.`,
						},
					],
					(values) => {
						if ((values.confirm_name || '').trim() !== dateName) {
							frappe.msgprint('Nama tarikh tidak sepadan — pemadaman dibatalkan.');
							return;
						}
						api('delete_travel_date', { travel_date: dateName }).then((res) => {
							frappe.show_alert({
								message: `Group date ${dateName} dipadam (${res.deleted.offers} offers)`,
								indicator: 'red',
							});
							frappe.set_route('travel-manager', 'trip', trip);
						}).catch(() => { /* frappe already shows it */ });
					},
					__('🗑 Delete Date Group — tidak boleh dibatalkan'),
				);
			});
			// [BUANG Nov 2026] butang Link/Change Cruise Schedule + dialog
			// link_schedule_dialog — sambungan schedule diurus dalam dialog
			// Edit Date (Selected Cruise Schedule).
			// [BUANG Nov 2026] butang Download Latest Availability +
			// handler eksport CSV — arahan pemilik; kadar & availabiliti
			// di atas meja pada jadual rooming sahaja.
			// (3) Modal maklumat kategori (klik nama kategori) — maklumat
			// master Trip Price Category + angka slice & pool semasa.
			// DELEGASI $body (bukan bind terus) — kandungan pane di-init
			// semula setiap aktivasi tab; delegasi bertahan.
			$body.off('click._tmroom', '.tm-room-info')
				.on('click._tmroom', '.tm-room-info', function () {
					rooming_info_dialog($(this).data('code'), {
						category_name: $(this).data('catname'),
						room_category: $(this).data('cat'),
						sold: $(this).data('sold'),
						available: $(this).data('avail'),
						pool_available: $(this).data('pool'),
						schedule: date.schedule_label || date.cruise_schedule,
						ship: date.ship_name,
					}, trip, dateName);
				});

			// + Add Offer (dalam pane Package) — delegasi $body (bertahan
			// merentasi re-init body pane).
			$body.off('click._tmaddpkg', '#tm-add-pkg-btn')
				.on('click._tmaddpkg', '#tm-add-pkg-btn', async function () {
					const name = $body.find('#tm-add-offer-name').val().trim();
					const cur = addOfferCur;
					if (!name) { frappe.msgprint('Offer name is required.'); return; }
					if (!cur) { frappe.msgprint('Currency is required.'); return; }
					try {
						await api('add_offer_to_date', { travel_date: dateName,
							values: JSON.stringify({ offer_name: name, currency: cur }) });
						frappe.show_alert({ message: 'Offer added — isi Price Matrix di dalam', indicator: 'green' });
						load_travel_date(trip, dateName);
					} catch (e) { /* frappe already shows it */ }
				});
			$body.find('#tm-edit-date').on('click', () =>
				travel_date_dialog(trip, {
					name: date.name, departure_date: date.departure_date,
					return_date: date.return_date,
					cruise_schedule: date.cruise_schedule,
					days_before_closure: date.days_before_closure,
					status: date.status,
					// Kategori semasa — dialog pra-isi dropdown (Nov 2026);
					// tiada ini → dropdown reset kosong setiap buka (nampak
					// macam nilai tidak disimpan — bug diperbetulkan).
					trip_category: date.trip_category,
					// Durasi + destinasi — pra-isi dialog Edit Date
					// (Nov 2026). Kosong → auto kira semula daripada tarikh.
					total_days: date.total_days,
					total_nights: date.total_nights,
					destination: date.destination,
				}, () => load_travel_date(trip, dateName)));
			// Baris pakej → NAVIGASI ke halaman admin pakej (bukan modal;
			// route supaya deep-link & breadcrumb router berfungsi).
			// (Nov 2026: kolum tindakan dibuang — Manage/Activate/Cancel
			// dikendalikan di halaman admin pakej.) DELEGASI $body —
			// bertahan merentasi re-init body pane.
			$body.off('click._tmpkgrow', '.tm-pkg-row')
				.on('click._tmpkgrow', '.tm-pkg-row', function (ev) {
					if ($(ev.target).closest('button').length) return;
					frappe.set_route('travel-manager', 'trip', trip, 'date', dateName,
						'pkg', $(this).data('offer'));
				});
		}

		// Modal maklumat KATEGORI ROOMING — maklumat master Trip Price
		// Category (link terus, tiada carian kod) + angka slice & pool.
		async function rooming_info_dialog(code, avail, trip, dateName) {
			let cat = null;
			if (avail && avail.room_category) {
				try {
					cat = await tmg('room_category_info', { name: avail.room_category }) || null;
				} catch (e) { cat = null; }
			} else if (code) {
				try {
					cat = await tmg('room_category_info', { code }) || null;
				} catch (e) { cat = null; }
			}
			const info = Object.assign({}, cat, { category_name: (cat && cat.category_name) || (avail && avail.category_name) || code });
			const d = new frappe.ui.Dialog({
				title: 'Rooming Type — ' + (info.category_name || code || '—'),
			});
			d.$body.html(`
				<table id="tm-ri-table" class="table table-sm mb-0 tm-kv-table">
					<tr><td>Category</td>
						<td><strong>${esc(info.category_name || code)}</strong>
							${info.category_code ? `<span class="text-muted text-small">(${esc(info.category_code)})</span>` : ''}</td></tr>
					<tr><td>Category Group</td><td>${esc(info.category_group || '—')}</td></tr>
					<tr><td>Capacity</td><td>${info.capacity ?? '—'} pax
						${info.max_capacity ? `(max ${esc(info.max_capacity)})` : ''}</td></tr>
					<tr><td>Grade</td><td>${info.gred != null ? '★'.repeat(Math.round(info.gred * 5)) || '—' : '—'}</td></tr>
					${info.description ? `<tr><td>Description</td>
						<td class="whitespace-pre-wrap">${esc(info.description)}</td></tr>` : ''}
					${info.read_more_url ? `<tr><td>Media</td>
						<td><a href="${esc(info.read_more_url)}" target="_blank">${esc(info.read_more_url)}</a></td></tr>` : ''}
					<tr class="tm-kv-sep"><td></td><td></td></tr>
				<tr><td>Schedule</td><td>${esc(avail.schedule || '—')}</td></tr>
				<tr><td>Ship</td><td>${esc(avail.ship || '—')}</td></tr>
				<tr><td>Availability (sailing ini)</td><td>
					Sold <strong>${avail.sold ?? 0}</strong> ·
					Available <strong>${avail.available ?? 0}</strong></td></tr>
				</table>
				${info.name && (frappe.user_roles || []).includes('Tour Manager') ? `
				<div class="d-flex mt-3">
					<button class="btn btn-outline btn-outline-primary btn-sm ml-auto"
						id="tm-ri-edit">✎ Edit Category</button>
				</div>` : ''}
			`);
			d.show();

			// ✎ Edit Category — kemaskini master Trip Price Category
			// (Tour Manager sahaja — write doctype). Medan selari senarai
			// putih save_room_category (trip_manager). info.name = nama
			// rekod master; fallback tanpa master → tiada butang.
			d.$body.find('#tm-ri-edit').on('click', () => {
				const ed = new frappe.ui.Dialog({
					title: '✎ Edit Room Category — ' + (info.category_name || info.name),
					fields: [
						{ fieldname: 'category_name', fieldtype: 'Data',
							label: 'Category Name', reqd: 1,
							default: info.category_name || '' },
						{ fieldname: 'category_code', fieldtype: 'Data',
							label: 'Category Code', default: info.category_code || '' },
						{ fieldname: 'category_group', fieldtype: 'Select',
							label: 'Category Group',
							options: ['Cabin', 'Suite', 'Villa', 'Room', 'Addon'],
							default: info.category_group || 'Cabin' },
						{ fieldname: 'cb1', fieldtype: 'Column Break' },
						{ fieldname: 'capacity', fieldtype: 'Int',
							label: 'Capacity (pax)', default: info.capacity ?? null },
						{ fieldname: 'max_capacity', fieldtype: 'Int',
							label: 'Max Capacity', default: info.max_capacity ?? null },
						{ fieldname: 'gred', fieldtype: 'Rating',
							label: 'Grade (gred)', default: info.gred ?? null },
						{ fieldname: 'sec1', fieldtype: 'Section Break' },
						{ fieldname: 'description', fieldtype: 'Small Text',
							label: 'Description', default: info.description || '' },
						{ fieldname: 'read_more_url', fieldtype: 'Data',
							label: 'Media URL', default: info.read_more_url || '' },
						{ fieldname: 'youtube_url', fieldtype: 'Data',
							label: 'YouTube URL', default: info.youtube_url || '' },
					],
					primary_action_label: 'Simpan',
					primary_action: async (values) => {
						const $btn = ed.get_primary_btn().prop('disabled', true);
						try {
							await tmg('save_room_category', { name: info.name, values });
							frappe.show_alert({
								message: 'Room category dikemaskini',
								indicator: 'green' });
							ed.hide();
							d.hide();
							load_travel_date(trip, dateName);
						} catch (e) { /* frappe already shows it */ }
						$btn.prop('disabled', false);
					},
				});
				ed.show();
			});
		}


		function next_status_options(status) {
			const flow = {
				Pending: ['Accepted', 'Cancelled'],
				Accepted: ['Processing', 'Cancelled'],
				Processing: ['Confirmed'],
				Confirmed: ['Completed'],
				Completed: [], Abandoned: [], Cancelled: [],
			};
			return (flow[status] || []).map((n) =>
				`<button class="btn btn-xs btn-default tm-next" data-next="${n}">→ ${n}</button>`).join(' ')
				|| '<span class="text-extra-muted">—</span>';
		}
