		/* ════════════════════════════════════════════════════════════════════
		   SEKSYEN: CUSTOMER DIREKTORI (tm_customer.js)
		   ════════════════════════════════════════════════════════════════════
		   Direktori SEMUA customer — tab Customer pada nav travel-manager
		   (Nov 2026), selepas Booking: pantau & urus customer
		   TANPA akses borang doctype (arahan pemilik).
		     /customer            → direktori (datatable: carian SERVER-SIDE
		                           — jumlah customer auto-bertambah dari
		                           portal; penapis type/group/B2B, saiz
		                           halaman, pagination, sortable & COLUMN
		                           TOGGLE — EXT persistKey tmDataTable;
		                           baris klik → detail)
		     /customer/<NAMA>     → detail customer: Info (✏️), Contacts
		                           (✏️ — flag portal-user), Billing Address
		                           (✏️), Monitoring kewangan (billed/paid/
		                           tunggakan per currency, credit note,
		                           lebihan belum agih, loyalty points bila
		                           aktif), Bookings (deep-link Booking
		                           Manager L3), Payments & Invoices, B2B
		                           Partner (model sedia ada — Travel B2B
		                           Partner / Customer Group "B2B").
		   Kewangan: agregat server dari sumber ERPNext authoritative
		   (SO docstatus=1 grand_total+advance_paid per currency; SI
		   is_return=1 = credit note; PE unallocated = lebihan belum
		   agih). Loyalty: feature-detect server (loyalty_enabled) —
		   kolum/seksyen disembunyi bila Loyalty Program tidak aktif.
		   Edit: mutasi melalui API role-gated (doc.save penuh — hooks
		   billing_address_sync menyebar); medan struktur (type/group/
		   disabled) manager-gated di server.
		   Di-include ke dalam scope IIFE page oleh render_include
		   (concatenation server-side) — semua fungsi/const di sini HIDUP
		   dalam scope page travel_manager dan boleh merujuk closure shell
		   ($body, state, breadcrumb, esc, badge, C, card, tmDataTable,
		   isManager, webFmtLoad/webFmtDate, fmtNum, cst) secara terus.
		   API AWAM: load_customers() / load_customer_detail(name)
		   (dipanggil router shell).
		   Backend: travel_booking.api.customer_admin (helper `cst`
		   kongsi) — get_customers_directory / get_customer_detail /
		   save_customer_info / save_customer_contact /
		   save_customer_address.
		   Komponen: kad/card() stok Bootstrap, jadual tmDataTable() kongsi
		   (EXT serverSearch + EXT persistKey column-toggle), tmTable(),
		   infoGrid()/field(), dialog frappe.ui.Dialog + FieldGroup —
		   CSS baharu hanya utiliti .tm-dt-cols/.tm-dt-colhide (EXT
		   column-toggle tmDataTable).
		   ════════════════════════════════════════════════════════════════════ */

		// ── Kebenaran (selari gate server customer_admin.py) ──
		// Tulis kontak/billing (mengalir ke dokumen bil & portal):
		// Manager/Operator — corak tddCanWrite.
		const custCanWrite = isManager || frappe.user.has_role('Tour Operator');
		// Medan struktur (type/group/disabled) — pengurusan sahaja;
		// gate SEBENAR di server (save_customer_info).
		const custCanManage = isManager;

		// ── Keadaan seksyen ──
		let custRows = [];        // baris direktori terkini
		let custDt = null;        // instance tmDataTable
		let custTotal = 0;        // jumlah rekod server (amaran cap & strip)
		let custLoyaltyOn = false;
		let custDetail = null;    // respons get_customer_detail semasa
		let custDetailName = null;

		// ── Helper paparan kewangan per-currency ──
		// App jual MYR+SGD — JANGAN guna money() (hardcode "RM"); nilai
		// sentiasa bersama kod currency (fmtNum tanpa simbol).
		const custBalancesHtml = (r, key) => {
			const list = r.balances || [];
			if (!list.length) return '<span class="text-muted">—</span>';
			return list.map((b) => {
				const val = key === 'credit' ? (b.credit || 0) : (b[key] ?? 0);
				const cls = key === 'outstanding'
					? (val > 0 ? 'text-danger' : 'text-muted')
					: (key === 'credit' && val ? 'text-success' : '');
				return `<div class="text-nowrap ${cls}">${esc(b.currency)} ${fmtNum(val)}</div>`;
			}).join('');
		};
		// Jumlah rentas-currency utk SORT sahaja (paparan kekal
		// pecahan per-currency — jumlah campur currency tidak bermakna).
		const custSumBal = (r, key) => (r.balances || [])
			.reduce((n, b) => n + (key === 'credit' ? (b.credit || 0) : (b[key] ?? 0)), 0);

		// ── Strip ringkasan direktori ──
		const custSummaryHtml = () => {
			const shown = custRows.length;
			const truncated = custTotal > shown;
			const b2b = custRows.filter((r) => r.b2b_partner).length;
			const perCur = {};
			custRows.forEach((r) => (r.balances || []).forEach((b) => {
				const agg = perCur[b.currency]
					|| (perCur[b.currency] = { outstanding: 0, credit: 0 });
				agg.outstanding += Math.max(0, b.outstanding || 0);
				agg.credit += b.credit || 0;
			}));
			const balChips = Object.entries(perCur).map(([cur, a]) => `
				<span class="text-nowrap" style="color:${C.red}"><strong>${esc(cur)} ${fmtNum(a.outstanding)}</strong> tunggakan</span>
				${a.credit ? `<span class="text-nowrap" style="color:${C.green}"><strong>${esc(cur)} ${fmtNum(a.credit)}</strong> credit</span>` : ''}`)
				.join('');
			return `
				<span class="text-nowrap"><strong class="text-body">${shown}</strong> customer${truncated ? ` daripada <strong>${custTotal}</strong>` : ''}</span>
				<span class="text-nowrap"><strong>${b2b}</strong> B2B partner</span>
				${balChips}
				${custLoyaltyOn ? `<span class="text-nowrap"><strong>${custRows.reduce((n, r) => n + (r.loyalty_points || 0), 0)}</strong> loyalty pts</span>` : ''}
				${truncated ? `<span class="text-nowrap" style="color:${C.orange}">⚠ paparan terhad ${shown} (cap 1000) — gunakan carian</span>` : ''}`;
		};
		const custRefreshMeta = () => {
			$body.find('#tm-cust-summary').html(custSummaryHtml());
			$body.find('#tm-cust-count').text(custRows.length);
		};

		// ── Baris jadual direktori ──
		const custRowHtml = (r) => `
			<tr class="tm-cust-row" style="cursor:pointer" data-name="${esc(r.name)}"
				title="Buka detail customer">
				<td>
					<div class="font-weight-bold">${esc(r.customer_name || r.name)}
						${r.disabled ? `<span class="badge badge-secondary ml-1">Disabled</span>` : ''}</div>
					<div class="text-muted text-small">${esc(r.email || 'tiada email')}</div>
				</td>
				<td>${esc(r.customer_type || '—')}</td>
				<td>${esc(r.customer_group || '—')}</td>
				<td class="text-center"><strong>${r.bookings ?? 0}</strong></td>
				<td class="text-nowrap">${esc(r.last_booking ? webFmtDate(r.last_booking) : '—')}</td>
				<td class="text-right">${custBalancesHtml(r, 'billed')}</td>
				<td class="text-right">${custBalancesHtml(r, 'paid')}</td>
				<td class="text-right">${custBalancesHtml(r, 'outstanding')}</td>
				<td class="text-right">${custBalancesHtml(r, 'credit')}</td>
				${custLoyaltyOn ? `<td class="text-center"><strong>${r.loyalty_points ?? 0}</strong></td>` : ''}
				<td>${r.b2b_partner
					? `<span class="badge" style="background:${C.blue}18;color:${C.blue};border:1px solid ${C.blue}55"
						title="Billing Customer partner B2B">🤝 ${esc(r.b2b_partner_name || r.b2b_partner)}</span>`
					: '<span class="text-muted">—</span>'}</td>
			</tr>`;

		// ── Handler delegated (SEKALI sahaja — baris dirender semula oleh
		// pagination/sort/search/column-toggle tmDataTable) ──
		// Baris → detail customer (klik pautan/butang dalam baris dikecualikan).
		$body.on('click', '.tm-cust-row', function (e) {
			if ($(e.target).closest('a,button,input,label').length) return;
			frappe.set_route('travel-manager', 'customer', $(this).data('name'));
		});
		// Detail — dialog & deep-link.
		$body.on('click', '#tm-cust-edit-info', () => cust_edit_info_dialog());
		$body.on('click', '.tm-cust-edit-contact', function (e) {
			e.stopPropagation();
			const ct = (custDetail?.contacts || [])
				.find((x) => x.name === $(this).data('contact'));
			if (ct) cust_edit_contact_dialog(ct);
		});
		$body.on('click', '#tm-cust-edit-address', () => cust_edit_address_dialog());
		// Baris booking → page Booking Order (L3) DALAM DIREKTORI CUSTOMER
		// INI (customer/<C>/<BK>) — crumb customer kekal, butang kembali ke
		// customer & Prev/Next ikut booking customer tersebut (Nov 2026;
		// dahulunya dilompatkan ke booking-group/<BK>).
		$body.on('click', '.tm-cust-bk-row', function (e) {
			if ($(e.target).closest('a,button,input').length) return;
			const bk = String($(this).data('booking') || '');
			if (bk && custDetailName) {
				frappe.set_route('travel-manager', 'customer', custDetailName, bk);
			}
		});

		// ══════════════ DIREKTORI (senarai) ══════════════
		async function load_customers() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Customer' },
			]);
			$body.html(loading());
			await webFmtLoad();

			const data = await cst('get_customers_directory', { limit: 1000 });
			custRows = (data?.customers || []).slice();
			custTotal = parseInt(data?.total, 10) || custRows.length;
			custLoyaltyOn = !!data?.loyalty_enabled;
			custDt = null;

			// Kolum direktori — Loyalty bersyarat (feature-detect server).
			const custHeaders = [
				'Customer', 'Type', 'Group', { text: 'Bookings', cls: 'text-center' },
				'Last Booking', { text: 'Billed', cls: 'text-right' },
				{ text: 'Paid', cls: 'text-right' },
				{ text: 'Outstanding', cls: 'text-right' },
				{ text: 'Credit Note', cls: 'text-right' },
				...(custLoyaltyOn ? [{ text: 'Loyalty', cls: 'text-center' }] : []),
				'B2B Partner',
			];

			$body.html(`
				<div class="d-flex flex-wrap gap-2 overflow-auto py-1 text-muted mb-3"
					id="tm-cust-summary" aria-label="Ringkasan customer">${custSummaryHtml()}</div>
				${card(12, `👤 CUSTOMER <span class="text-muted">(<span id="tm-cust-count">${custRows.length}</span>${custTotal > custRows.length ? ` / ${custTotal}` : ''})</span>`, `
					<div id="tm-cust-dt"></div>`)}
			`);

			// Jadual interaktif kongsi + EXT:
			//   serverSearch — carian di server (nama/email/group; volume
			//     customer tinggi — baris diganti in-place oleh EXT);
			//   persistKey — column toggle (pilihan kolum di-persist
			//     localStorage ikut kunci bawah).
			custDt = tmDataTable('#tm-cust-dt', custRows, {
				footer: true,
				pageSize: 25,
				pageSizeOptions: [10, 25, 50, 100],
				pageSizesLabel: 'Per page',
				headers: custHeaders,
				rowHtml: custRowHtml,
				serverSearch: (q) => cst('get_customers_directory',
					{ search: (q || '').trim(), limit: 1000 })
					.then((res) => {
						custTotal = parseInt(res?.total, 10) || 0;
						return res?.customers || [];
					}),
				persistKey: 'tm-cust-cols',
				searchPlaceholder: 'Search nama / email / group…',
				emptyMsg: 'Tiada customer dijumpai.',
				filters: [
					{ key: 'type', label: 'All types', of: (r) => r.customer_type || '' },
					{ key: 'group', label: 'All groups', of: (r) => r.customer_group || '' },
					{ key: 'b2b', label: 'All customers',
						of: (r) => r.b2b_partner ? 'B2B Partner' : 'Direct' },
				],
				sortable: [
					{ key: 'cust', val: (r) => (r.customer_name || r.name || '').toLowerCase() },
					{ key: 'type', val: (r) => r.customer_type || '' },
					{ key: 'group', val: (r) => r.customer_group || '' },
					{ key: 'bookings', val: (r) => r.bookings || 0 },
					{ key: 'last', val: (r) => r.last_booking || '' },
					{ key: 'billed', val: (r) => custSumBal(r, 'billed') },
					{ key: 'paid', val: (r) => custSumBal(r, 'paid') },
					{ key: 'outstanding', val: (r) => r.outstanding_total || 0 },
					{ key: 'credit', val: (r) => r.credit_total || 0 },
					...(custLoyaltyOn ? [{ key: 'loyalty', val: (r) => r.loyalty_points || 0 }] : []),
					null,
				],
			});
		}

		// ══════════════ DETAIL SATU CUSTOMER ══════════════
		// KONTEKS DIREKTORI customer untuk page booking order
		// (tm_booking_view.js) — dipanggil shell (show_booking_order) bila
		// route customer/<C>/<BK>: kembali ke customer ini, Prev/Next =
		// booking customer ini (server, terkini dahulu — susunan sama dengan
		// jadual BOOKINGS di detail customer).
		function customer_dir_ctx(cust) {
			const base = ['travel-manager', 'customer', cust];
			return {
				dir: 'customer:' + cust,
				back: { label: cust, route: base },
				route_for: (name) => [...base, name],
				nav: { scope: 'customer', customer: cust },
			};
		}

		async function load_customer_detail(name) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Customer', route: ['travel-manager', 'customer'] },
				{ label: name },
			]);
			$body.html(loading());
			await webFmtLoad();

			custDetail = await cst('get_customer_detail', { customer: name });
			custDetailName = name;
			const d = custDetail;
			const c = d?.customer;
			if (!c) {
				$body.html(card(12, '👤 CUSTOMER',
					'<p class="text-muted mb-0">Customer tidak dijumpai — mungkin telah dipadam.</p>'));
				return;
			}
			const loyaltyOn = !!d.loyalty_enabled;
			custLoyaltyOn = loyaltyOn;
			const fin = d.finance || {};
			const billing = (d.addresses || []).find((a) => a.address_type === 'Billing');

			$body.html(`
				${custInfoCardHtml(c, d)}
				${custContactsCardHtml(d)}
				${custAddressCardHtml(d, billing)}
				${custMonitorCardHtml(d)}
				${custBookingsCardHtml(d)}
				${custPaymentsCardHtml(fin)}
				${d.b2b ? custB2BCardHtml(d.b2b) : ''}
			`);
		}

		// Muat semula detail selepas mutasi (agregat berubah — patch
		// tempatan tidak praktikal merentas kad; satu fetch murah).
		const custReloadDetail = () =>
			custDetailName && load_customer_detail(custDetailName);

		// ── Kad INFO CUSTOMER ──
		const custInfoCardHtml = (c, d) => card(12,
			`👤 ${esc(c.customer_name || c.name)}
				<span class="text-muted text-small text-monospace">${esc(c.name)}</span>
				${c.customer_type ? badge(c.customer_type, C.blue) : ''}
				${c.customer_group ? badge(c.customer_group, c.gray) : ''}
				${c.disabled ? badge('Disabled', C.red) : ''}
				${d.b2b ? badge(`🤝 B2B: ${d.b2b.partner_name || d.b2b.name}`, C.green) : ''}`,
			`
				${infoGrid('tm-cust-info', `
					${field('Email', esc(custPrimaryEmail(d) || '—'), 'col-md-4 col-6')}
					${field('Phone', esc(custPrimaryPhone(d) || '—'), 'col-md-4 col-6')}
					${field('Territory', esc(c.territory || '—'), 'col-md-4 col-6')}
					${c.rc_display_currency !== undefined
						? field('Display Currency', esc(c.rc_display_currency || '—'), 'col-md-4 col-6') : ''}
					${field('Dicipta', esc(webFmtDate(String(c.creation || '').slice(0, 10))), 'col-md-4 col-6')}
					${field('Bookings', `<strong>${d.bookings_total ?? 0}</strong>
						${custChannelChips(d.channel_split)}`, 'col-md-4 col-6')}
				`)}
				${loyaltyOnSection(d)}`,
			`
				${custCanWrite ? `<button type="button" class="btn btn-primary btn-sm"
					id="tm-cust-edit-info">✏️ Edit Info</button>` : ''}
				<div class="text-muted text-small ml-auto">Autoname Customer =
					naming series — tukar nama TIDAK rename dokumen.</div>`,
			'd-flex flex-wrap align-items-center');

		// Email/phone primary pertama daripada contacts (konsisten dgn
		// agregat direktori server — row primary dahulu).
		const custPrimaryEmail = (d) => (d.contacts || [])
			.flatMap((ct) => ct.emails || []).find((e) => e.is_primary)?.email
			|| (d.contacts || []).flatMap((ct) => ct.emails || [])[0]?.email || '';
		const custPrimaryPhone = (d) => (d.contacts || [])
			.flatMap((ct) => ct.phones || []).find((p) => p.is_primary)?.phone
			|| (d.contacts || []).flatMap((ct) => ct.phones || [])[0]?.phone || '';

		const custChannelChips = (split) => ' ' + Object.entries(split || {})
			.map(([ch, n]) => `<span class="badge badge-light ml-1" title="Booking channel">${esc(ch)}: ${n}</span>`)
			.join('');

		const loyaltyOnSection = (d) => d.loyalty_enabled ? `
			${secTitle('⭐ LOYALTY', 'ERPNext Loyalty Program aktif', 'mt-3')}
			${infoGrid('tm-cust-loyalty', `
				${field('Program', esc(d.customer?.loyalty_program || '—'), 'col-md-4 col-6')}
				${field('Points Semasa', `<strong>${d.loyalty_points ?? 0}</strong> pts`, 'col-md-4 col-6')}
			`)}` : '';

		// ── Kad CONTACTS ──
		const custContactsCardHtml = (d) => {
			const rows = (d.contacts || []).map((ct) => `
				<tr>
					<td>
						<div class="font-weight-bold">${esc(ct.full_name || ct.name)}</div>
						<div class="text-muted text-small text-monospace">${esc(ct.name)}</div>
					</td>
					<td>${(ct.emails || []).map((e) => `
						<div class="text-nowrap">${esc(e.email)}
							${e.is_primary ? '<span class="badge badge-light">primary</span>' : ''}</div>`).join('')
						|| '<span class="text-muted">—</span>'}</td>
					<td>${(ct.phones || []).map((p) => `
						<div class="text-nowrap">${esc(p.phone)}
							${p.is_primary ? '<span class="badge badge-light">primary</span>' : ''}</div>`).join('')
						|| '<span class="text-muted">—</span>'}</td>
					<td>${ct.is_portal_user
						? badge('Portal User', C.green)
						: badge('No Login', C.gray)}</td>
					<td class="text-right">
						${custCanWrite ? `<button type="button"
							class="btn btn-xs btn-default tm-cust-edit-contact"
							data-contact="${esc(ct.name)}" title="Edit email/phone primary">✏️</button>` : ''}
					</td>
				</tr>`).join('');
			return card(12, '📇 CONTACTS',
				tmTable(['Contact', 'Emails', 'Phones', 'Portal', ''], rows,
					'Tiada contact di-link ke customer ini.'),
				`
				<div class="text-muted text-small">Email lama KEKAL sebagai row
					(bukan dipadam) supaya login portal & resolusi booking tidak
					putus — akaun login TIDAK ditukar.</div>`,
				'd-flex flex-wrap align-items-center');
		};

		// ── Kad ADDRESSES ──
		const custAddressCardHtml = (d, billing) => {
			const fmtAddr = (a) => [
				a.address_line1, a.address_line2, a.city, a.state, a.pincode, a.country,
			].filter(Boolean).map((x) => esc(x)).join(', ');
			const rows = (d.addresses || []).map((a) => `
				<tr>
					<td>${esc(a.address_type || '—')}
						${a.is_primary_address ? '<span class="badge badge-light">primary</span>' : ''}
						${a.disabled ? '<span class="badge badge-secondary">disabled</span>' : ''}</td>
					<td>${fmtAddr(a) || '<span class="text-muted">—</span>'}
						<div class="text-muted text-small text-monospace">${esc(a.name)}</div></td>
				</tr>`).join('');
			return card(12, '🏠 ADDRESSES',
				tmTable(['Type', 'Address'], rows, 'Tiada alamat di-link ke customer ini.'),
				`
				${custCanWrite ? `<button type="button" class="btn btn-primary btn-sm"
					id="tm-cust-edit-address">✏️ ${billing ? 'Edit' : 'Create'} Billing Address</button>` : ''}
				<div class="text-muted text-small ml-auto">Alamat billing disebarkan ke
					booking customer ini oleh hook billing_address_sync.</div>`,
				'd-flex flex-wrap align-items-center');
		};

		// ── Kad MONITORING (kewangan + loyalty) ──
		const custMonitorCardHtml = (d) => {
			const fin = d.finance || {};
			const perCur = fin.per_currency || [];
			const curRows = perCur.map((b) => `
				<tr>
					<td><strong>${esc(b.currency)}</strong></td>
					<td class="text-right">${fmtNum(b.billed)}</td>
					<td class="text-right">${fmtNum(b.paid)}</td>
					<td class="text-right ${b.outstanding > 0 ? 'text-danger font-weight-bold' : 'text-muted'}">${fmtNum(b.outstanding)}</td>
				</tr>`).join('');
			const advances = (fin.unallocated_advances || []);
			const advTotal = advances.reduce((n, a) => n + (a.unallocated_amount || 0), 0);
			const creditTotal = (fin.credit_notes || [])
				.reduce((n, x) => n + Math.abs(x.grand_total || 0), 0);
			return card(12, '💰 MONITORING — Tunggakan & Lebihan',
				`
				${secTitle('🧾 Ringkasan per currency',
					'SO docstatus=1 (grand_total vs advance_paid)')}
				${perCur.length ? `
				<table class="table table-sm table-hover mb-0">
					<thead><tr>
						<th>Currency</th><th class="text-right">Billed</th>
						<th class="text-right">Paid</th><th class="text-right">Outstanding</th>
					</tr></thead>
					<tbody>${curRows}</tbody>
				</table>` : '<p class="text-muted small mb-0">Tiada order diinvois (SO) lagi.</p>'}
				${creditTotal ? `
					<div class="mt-3">${secTitle('↩️ Credit Note',
						'Sales Invoice is_return — pulangan/lebihan bayaran')}</div>
					<div class="text-success font-weight-bold">${fmtNum(creditTotal)}</div>` : ''}
				${advTotal ? `
					<div class="mt-3">${secTitle('➕ Lebihan belum agih',
						'Payment Entry unallocated — advance/overpayment')}</div>
					<div class="font-weight-bold" style="color:${C.orange}">${fmtNum(advTotal)}
						<span class="text-muted text-small">(${advances.length} payment entry)</span></div>` : ''}
				`);
		};

		// ── Kad BOOKINGS (deep-link Booking Manager) ──
		const custBookingsCardHtml = (d) => {
			const rows = (d.bookings || []).map((b) => `
				<tr class="tm-cust-bk-row" style="cursor:pointer" data-booking="${esc(b.name)}"
					title="Buka booking dalam Booking Manager">
					<td class="text-nowrap font-weight-bold">${esc(b.booking_number || b.name)}</td>
					<td>${esc(b.trip_title || b.trip_name || '—')}</td>
					<td class="text-nowrap">${esc(b.departure_date ? webFmtDate(b.departure_date) : '—')}</td>
					<td>${esc(b.booking_channel || 'Direct')}</td>
					<td class="text-center">${b.booked_pax ?? 0}</td>
					<td>${badge(b.status || '—', BKG_COLOR[b.status] || C.gray)}</td>
					<td>${badge(b.payment_status || '—',
						(b.payment_status || '').includes('Refund') ? C.orange
						: (b.payment_status === 'Paid' ? C.green : C.blue))}</td>
					<td class="text-right">${custBalancesHtml(b, 'outstanding')}</td>
				</tr>`).join('');
			return card(12,
				`📋 BOOKINGS <span class="text-muted">(${d.bookings_total ?? (d.bookings || []).length} — 50 terkini)</span>`,
				tmTable(['Booking', 'Trip', 'Departure', 'Channel', 'Pax', 'Status',
					'Payment', 'Outstanding'], rows,
					'Tiada booking untuk customer ini (customer ATAU end-customer B2B).'));
		};

		// ── Kad PAYMENTS & INVOICES ──
		const custPaymentsCardHtml = (fin) => {
			const invRows = (fin.invoices || []).map((si) => `
				<tr><td class="text-monospace text-small">${esc(si.name)}</td>
					<td class="text-nowrap">${esc(si.posting_date ? webFmtDate(si.posting_date) : '—')}</td>
					<td class="text-right">${esc(si.currency)} ${fmtNum(si.grand_total)}</td>
					<td class="text-right ${si.outstanding_amount > 0 ? 'text-danger' : 'text-success'}">${fmtNum(si.outstanding_amount)}</td></tr>`).join('');
			const cnRows = (fin.credit_notes || []).map((si) => `
				<tr><td class="text-monospace text-small">${esc(si.name)}</td>
					<td class="text-nowrap">${esc(si.posting_date ? webFmtDate(si.posting_date) : '—')}</td>
					<td class="text-right text-success">${esc(si.currency)} ${fmtNum(Math.abs(si.grand_total))}</td></tr>`).join('');
			const peRows = (fin.unallocated_advances || []).map((pe) => `
				<tr><td class="text-monospace text-small">${esc(pe.name)}</td>
					<td class="text-nowrap">${esc(pe.posting_date ? webFmtDate(pe.posting_date) : '—')}</td>
					<td class="text-right">${fmtNum(pe.paid_amount)}</td>
					<td class="text-right" style="color:${C.orange}">${fmtNum(pe.unallocated_amount)}</td></tr>`).join('');
			return card(12, '🧾 PAYMENTS & INVOICES', `
				${secTitle('Sales Invoice', '20 terkini')}
				${tmTable(['Invoice', 'Date', 'Total', 'Outstanding'], invRows,
					'Tiada invois rasmi lagi — invois auto-dicipta bila SO fully paid.')}
				${secTitle('Credit Note (is_return)', '', 'mt-3')}
				${tmTable(['Credit Note', 'Date', 'Jumlah'], cnRows,
					'Tiada credit note bagi customer ini.')}
				${secTitle('Payment Entry — lebihan belum agih', '', 'mt-3')}
				${tmTable(['Payment', 'Date', 'Paid', 'Unallocated'], peRows,
					'Tiada lebihan/advance belum agih.')}
			`);
		};

		// ── Kad B2B PARTNER (model sedia ada — surface, bukan baharu) ──
		const custB2BCardHtml = (b2b) => {
			const userRows = (b2b.users || []).map((u) => `
				<tr><td class="text-monospace text-small">${esc(u.user)}</td>
					<td>${esc(u.access_level || '—')}</td></tr>`).join('');
			const pkgRows = (b2b.package_discounts || []).map((p) => `
				<tr><td class="text-monospace text-small">${esc(p.trip_package)}</td>
					<td class="text-right">${fmtNum(p.discount_percent)}%</td></tr>`).join('');
			return card(12,
				`🤝 B2B PARTNER <span class="text-muted text-small text-monospace">${esc(b2b.name)}</span>
					${badge(b2b.status || 'Active', C.green)}`,
				`
				${infoGrid('tm-cust-b2b', `
					${field('Partner', esc(b2b.partner_name || b2b.name), 'col-md-4 col-6')}
					${field('Net Rate Default',
						b2b.default_discount_percent != null
							? `<strong>${fmtNum(b2b.default_discount_percent)}%</strong>` : '—',
						'col-md-4 col-6')}
					${field('Contact Email', esc(b2b.contact_email || '—'), 'col-md-4 col-6')}
					${field('Booking Split (partner)', custChannelChips(b2b.channel_split), 'col-12')}
				`)}
				${secTitle('Partner Users', 'log masuk portal & tempah atas nama pelanggan akhir', 'mt-3')}
				${tmTable(['User', 'Access Level'], userRows, 'Tiada user partner.')}
				${secTitle('Net Rate per Pakej', '', 'mt-3')}
				${tmTable(['Trip Package', 'Discount'], pkgRows, 'Tiada diskaun pakej khusus — net rate default digunakan.')}
				`);
		};

		// ══════════════ DIALOG EDIT INFO CUSTOMER ══════════════
		// Medan struktur (type/group/disabled) manager-gated DI SERVER —
		// hanya dihantar bila BERUBAH (corak po_edit_dialog: elak gate
		// gagal untuk Operator yang edit medan lain).
		function cust_edit_info_dialog() {
			const c = custDetail?.customer;
			if (!c) return;
			const fields = [
				{ fieldname: 'customer_name', fieldtype: 'Data',
					label: 'Customer Name', reqd: 1,
					default: c.customer_name || '' },
				{ fieldname: 'customer_type', fieldtype: 'Select',
					label: 'Customer Type',
					options: ['Individual', 'Company'].join('\n'),
					default: c.customer_type || 'Individual',
					description: 'Manager sahaja (gate server). Customer B2B = Company.' },
				// Customer Group = SELECT (bukan Link): DocPerm Customer
				// Group ERPNext tiada row System Manager (role Sales
				// sahaja) — medan Link akan trigger validate_link_and_
				// fetch 403 + modal ralat pada user desk. Pilihan datang
				// dari server (customer_groups dalam respons detail).
				{ fieldname: 'customer_group', fieldtype: 'Select',
					label: 'Customer Group',
					options: (custDetail?.customer_groups || []).join('\n'),
					default: c.customer_group || '',
					description: 'Manager sahaja (gate server). Group "B2B" = '
						+ 'Billing Customer partner B2B.' },
			];
			if (c.rc_display_currency !== undefined) {
				fields.push({ fieldname: 'rc_display_currency', fieldtype: 'Link',
					label: 'Display Currency (portal)', options: 'Currency',
					default: c.rc_display_currency || '' });
			}
			fields.push({ fieldname: 'disabled', fieldtype: 'Check',
				label: 'Disabled', default: c.disabled ? 1 : 0,
				description: 'Manager sahaja (gate server).' });
			const d = new frappe.ui.Dialog({
				title: `✏️ Edit Customer — ${esc(c.name)}`,
				fields,
				primary_action_label: '💾 Simpan',
				primary_action: (values) => {
					const args = { name: c.name,
						customer_name: (values.customer_name || '').trim(),
						rc_display_currency: values.rc_display_currency || '' };
					if ((values.customer_type || '') !== (c.customer_type || ''))
						args.customer_type = values.customer_type;
					if ((values.customer_group || '') !== (c.customer_group || ''))
						args.customer_group = values.customer_group;
					if (!!values.disabled !== !!c.disabled)
						args.disabled = values.disabled ? 1 : 0;
					const $btn = d.get_primary_btn().prop('disabled', true);
					cst('save_customer_info', { values: JSON.stringify(args) })
						.then(() => {
							d.hide();
							frappe.show_alert({ message: `Customer ${c.name} disimpan`,
								indicator: 'green' });
							custReloadDetail();
						}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.show();
		}

		// ══════════════ DIALOG EDIT CONTACT (email/phone primary) ══════════════
		function cust_edit_contact_dialog(ct) {
			const curEmail = (ct.emails || []).find((e) => e.is_primary)?.email
				|| (ct.emails || [])[0]?.email || '';
			const curPhone = (ct.phones || []).find((p) => p.is_primary)?.phone
				|| (ct.phones || [])[0]?.phone || '';
			const d = new frappe.ui.Dialog({
				title: `✏️ Edit Contact — ${esc(ct.full_name || ct.name)}`,
				fields: [
					{ fieldname: 'email', fieldtype: 'Data', label: 'Email (primary)',
						default: curEmail,
						description: 'Row email lama KEKAL (nyah-primary) — login '
							+ 'portal & resolusi booking tidak putus. Akaun login '
							+ 'portal (User) TIDAK ditukar.' },
					{ fieldname: 'phone', fieldtype: 'Data', label: 'Phone (primary)',
						default: curPhone,
						description: 'Dinormalisakan ke format +60-xxx (Frappe).' },
				],
				primary_action_label: '💾 Simpan',
				primary_action: (values) => {
					const $btn = d.get_primary_btn().prop('disabled', true);
					cst('save_customer_contact', {
						customer: custDetailName, contact: ct.name,
						email: (values.email || '').trim(),
						phone: (values.phone || '').trim(),
					}).then(() => {
						d.hide();
						frappe.show_alert({ message: 'Contact dikemas kini',
							indicator: 'green' });
						custReloadDetail();
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.show();
		}

		// ══════════════ DIALOG EDIT BILLING ADDRESS ══════════════
		// Helper server sama dengan wizard checkout — upsert Address
		// 'Billing' primary + sebar snapshot booking (hook sync).
		function cust_edit_address_dialog() {
			const billing = (custDetail?.addresses || [])
				.find((a) => a.address_type === 'Billing');
			const d = new frappe.ui.Dialog({
				title: `✏️ ${billing ? 'Edit' : 'Create'} Billing Address`,
				fields: [
					{ fieldname: 'address_line1', fieldtype: 'Data', reqd: 1,
						label: 'Address Line 1', default: billing?.address_line1 || '' },
					{ fieldname: 'city', fieldtype: 'Data', label: 'City',
						default: billing?.city || '' },
					{ fieldname: 'state', fieldtype: 'Data', label: 'State',
						default: billing?.state || '' },
					{ fieldname: 'postcode', fieldtype: 'Data', label: 'Postcode',
						default: billing?.pincode || '' },
					{ fieldname: 'country', fieldtype: 'Link', options: 'Country',
						reqd: 1, label: 'Country', default: billing?.country || 'Malaysia',
						description: 'Resolusi case-insensitive di server — negara '
							+ 'tidak dikenali menggagalkan simpanan.' },
				],
				primary_action_label: '💾 Simpan',
				primary_action: (values) => {
					const $btn = d.get_primary_btn().prop('disabled', true);
					cst('save_customer_address', {
						customer: custDetailName,
						values: JSON.stringify({
							address_line1: values.address_line1 || '',
							city: values.city || '',
							state: values.state || '',
							postcode: values.postcode || '',
							country: values.country || '',
						}),
					}).then(() => {
						d.hide();
						frappe.show_alert({ message: 'Alamat billing disimpan '
							+ '(sebaran booking oleh hook)', indicator: 'green' });
						custReloadDetail();
					}).catch(() => { /* frappe already shows it */ })
						.always(() => $btn.prop('disabled', false));
				},
			});
			d.show();
		}
