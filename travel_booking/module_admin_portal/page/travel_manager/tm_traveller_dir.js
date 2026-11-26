// travel_booking/module_admin_portal/page/travel_manager/tm_traveller_dir.js
// TRAVELLER — DIREKTORI SEMUA PROFIL TRAVELLER (route 'traveller')
//
// [Nov 2026] Sub-menu Booking (selepas Booking Group & Addon
// Booking): direktori SEMUA profil doctype Traveller — profil dibina dari
// portal /traveller & booking desk. Konsep interface SAMA dengan direktori
// Customer (tm_customer.js): datatable tmDataTable kongsi — carian
// SERVER-SIDE (nama/IC/pasport/emel/telefon; jumlah profil auto-bertambah,
// cap 1000 + amaran pemotongan), penapis status/kewarganegaraan/kategori
// umur, sort & column-toggle (persistKey), strip ringkasan.
// Klik baris → dialog profil (bacaan sahaja — mutasi kekal melalui portal
// /traveller & flow booking sedia ada).
//
// Di-include ke dalam scope IIFE page oleh render_include (concatenation)
// — kongsi closure $body/breadcrumb/esc/badge/C/card/tmDataTable/webFmt*
// dengan fail seksyen lain. Backend: travel_booking.api.traveller_admin
// (helper `tva` kongsi tm_shared).

/* ══════════════════════════════════════════════════════════════════════
   SEKSYEN: TRAVELLER DIREKTORI (tm_traveller_dir.js)
   ══════════════════════════════════════════════════════════════════════ */

	// ── Keadaan seksyen ──
	let tvdRows = [];        // baris direktori terkini
	let tvdDt = null;        // instance tmDataTable
	let tvdTotal = 0;        // jumlah rekod server (amaran cap & strip)

	// Warna badge status dokumen traveller (Select doctype Traveller.status).
	const TVD_STATUS_COLORS = {
		'Verified': C.green,
		'Pending Verification': C.orange,
		'Incomplete': C.gray,
		'Open for Update': C.blue,
		'Expired': C.red,
	};

	// Pasport luput — merah bila telah luput, oren bila ≤ 90 hari lagi.
	const tvdPassportCell = (t) => {
		if (!t.passport_expiry) return '<span class="text-muted">—</span>';
		const days = frappe.datetime.get_diff(t.passport_expiry,
			frappe.datetime.get_today());
		const cls = days < 0 ? C.red : (days <= 90 ? C.orange : '');
		const warn = days < 0 ? ' (luput)' : (days <= 90 ? ` (${days} hari)` : '');
		return `<span class="text-nowrap" ${cls ? `style="color:${cls}"` : ''}>${esc(webFmtDate(t.passport_expiry))}${warn ? esc(warn) : ''}</span>`;
	};

	// ── Strip ringkasan direktori ──
	const tvdSummaryHtml = () => {
		const shown = tvdRows.length;
		const truncated = tvdTotal > shown;
		const withPassport = tvdRows.filter((r) => r.passport_no).length;
		const expiring = tvdRows.filter((r) => r.passport_expiry
			&& frappe.datetime.get_diff(r.passport_expiry,
				frappe.datetime.get_today()) <= 90).length;
		const statusCount = (s) => tvdRows.filter((r) => (r.status || '') === s).length;
		return `
			<span class="text-nowrap"><strong class="text-body">${shown}</strong> traveller${truncated ? ` daripada <strong>${tvdTotal}</strong>` : ''}</span>
			<span class="text-nowrap"><strong>${withPassport}</strong> berpasport</span>
			<span class="text-nowrap" style="color:${C.green}"><strong>${statusCount('Verified')}</strong> verified</span>
			<span class="text-nowrap" style="color:${C.orange}"><strong>${statusCount('Pending Verification')}</strong> menunggu verify</span>
			${expiring ? `<span class="text-nowrap" style="color:${C.orange}"><strong>${expiring}</strong> pasport ≤ 90 hari</span>` : ''}
			${truncated ? `<span class="text-nowrap" style="color:${C.orange}">⚠ paparan terhad ${shown} (cap 1000) — gunakan carian</span>` : ''}`;
	};

	// ── Baris jadual direktori ──
	const tvdRowHtml = (t) => `
		<tr class="tm-tvd-row" style="cursor:pointer" data-name="${esc(t.name)}"
			title="Buka profil traveller">
			<td>
				<div class="font-weight-bold">${esc(t.full_name || [t.first_name, t.last_name].filter(Boolean).join(' ') || t.name)}
					${t.status && TVD_STATUS_COLORS[t.status]
						? `<span class="badge ml-1" style="background:${TVD_STATUS_COLORS[t.status]}18;color:${TVD_STATUS_COLORS[t.status]};border:1px solid ${TVD_STATUS_COLORS[t.status]}55">${esc(t.status)}</span>` : ''}
				</div>
				<div class="text-muted text-small">${esc(t.email || 'tiada emel')}</div>
			</td>
			<td>
				<div class="text-nowrap">${esc(t.ic_number || '—')}</div>
				<div class="text-muted text-small text-nowrap">${esc(t.passport_no || 'tiada pasport')}</div>
			</td>
			<td>${tvdPassportCell(t)}</td>
			<td>${esc(t.nationality || '—')}</td>
			<td>${esc(t.gender || '—')}</td>
			<td class="text-center">
				<div><strong>${t.age ?? '—'}</strong></div>
				<div class="text-muted text-small">${esc(t.age_category || '')}</div>
			</td>
			<td class="text-center"><strong>${t.bookings ?? 0}</strong></td>
			<td class="text-nowrap">${esc(t.last_booking ? webFmtDate(t.last_booking) : '—')}</td>
			<td class="text-nowrap">${esc(t.creation ? webFmtDate(t.creation) : '—')}</td>
		</tr>`;

	// ── Dialog profil traveller (bacaan sahaja) — data daripada baris
	// direktori (tiada panggilan API tambahan). ──
	function tvd_profile_dialog(t) {
		const f = (label, val, cls) => field(label, val != null && val !== ''
			? esc(String(val)) : '<span class="text-muted">—</span>', cls || 'col-6 col-md-3', true);
		const addr = [t.address_line1, t.city, t.postcode, t.state, t.country]
			.filter(Boolean).join(', ');
		const d = new frappe.ui.Dialog({
			title: '🧳 ' + (t.full_name || t.name),
			size: 'large',
		});
		d.$body.html(`
			<div class="tm-tvd-profile">
				${infoGrid('tm-tvd-profile-grid', `
					${f('Traveller ID', t.name, 'col-6 col-md-4')}
					${f('Status', t.status || '', 'col-6 col-md-4')}
					${f('Kategori Umur', t.age_category || '', 'col-6 col-md-4')}
					${f('Emel', t.email)}
					${f('Telefon', t.phone)}
					${f('Jantina', t.gender)}
					${f('Tarikh Lahir', t.date_of_birth ? webFmtDate(t.date_of_birth) : '')}
					${f('Umur', t.age != null && t.age !== '' ? String(t.age) : '')}
					${f('No. IC', t.ic_number, 'col-6 col-md-4')}
					${f('No. Pasport', t.passport_no, 'col-6 col-md-4')}
					${f('Pasport Luput', t.passport_expiry ? webFmtDate(t.passport_expiry) : '', 'col-6 col-md-4')}
					${f('Kewarganegaraan', t.nationality, 'col-6 col-md-4')}
					${f('Contact Kecemasan', t.emergency_contact_name, 'col-6 col-md-4')}
					${f('Telefon Kecemasan', t.emergency_contact_phone, 'col-6 col-md-4')}
					${f('Hubungan', t.emergency_contact_relationship, 'col-6 col-md-4')}
					${f('Alamat', addr, 'col-12')}
					${f('Booking Dipaut', String(t.bookings ?? 0), 'col-6 col-md-4')}
					${f('Booking Terkini', t.last_booking ? webFmtDate(t.last_booking) : '', 'col-6 col-md-4')}
					${f('Dicipta', t.creation ? webFmtDate(t.creation) : '', 'col-6 col-md-4')}
				`)}
				<div class="text-muted text-small mt-2">
					${__('Profil diurus melalui portal /traveller & flow booking — direktori ini bacaan sahaja.')}
				</div>
			</div>`);
		d.show();
	}

	// Handler delegated (SEKALI sahaja — baris dirender semula oleh
	// pagination/sort/search/column-toggle tmDataTable; corak tm_customer).
	$body.on('click', '.tm-tvd-row', function () {
		const t = tvdRows.find((r) => r.name === $(this).data('name'));
		if (t) tvd_profile_dialog(t);
	});

	// Dipanggil shell handle_route() untuk kata kunci 'traveller'.
	async function load_traveller_dir() {
		$body.html(loading());
		await webFmtLoad();

		const data = await tva('get_travellers_directory', { limit: 1000 });
		tvdRows = (data?.travellers || []).slice();
		tvdTotal = parseInt(data?.total, 10) || tvdRows.length;
		tvdDt = null;

		$body.html(`
			<div class="d-flex flex-wrap gap-2 overflow-auto py-1 text-muted mb-3"
				id="tm-tvd-summary" aria-label="Ringkasan traveller">${tvdSummaryHtml()}</div>
			${card(12, `🧳 TRAVELLER <span class="text-muted">(<span id="tm-tvd-count">${tvdRows.length}</span>${tvdTotal > tvdRows.length ? ` / ${tvdTotal}` : ''})</span>`, `
				<div id="tm-tvd-dt"></div>`)}
		`);

		// Jadual interaktif kongsi + EXT (corak direktori Customer):
		//   serverSearch — carian di server (nama/IC/pasport/emel/telefon);
		//   persistKey — column toggle (pilihan kolum di-persist localStorage).
		tvdDt = tmDataTable('#tm-tvd-dt', tvdRows, {
			footer: true,
			pageSize: 25,
			pageSizeOptions: [10, 25, 50, 100],
			pageSizesLabel: 'Per page',
			headers: [
				'Traveller', 'IC / Pasport', { text: 'Pasport Luput' },
				'Kewarganegaraan', 'Jantina', { text: 'Umur', cls: 'text-center' },
				{ text: 'Booking', cls: 'text-center' }, 'Booking Terkini', 'Dicipta',
			],
			rowHtml: tvdRowHtml,
			serverSearch: (q) => tva('get_travellers_directory',
				{ search: (q || '').trim(), limit: 1000 })
				.then((res) => {
					tvdRows = (res?.travellers || []).slice();
					tvdTotal = parseInt(res?.total, 10) || tvdRows.length;
					$body.find('#tm-tvd-summary').html(tvdSummaryHtml());
					$body.find('#tm-tvd-count').text(tvdRows.length);
					return tvdRows;
				}),
			persistKey: 'tm-tvd-cols',
			searchPlaceholder: 'Search nama / IC / pasport / emel / telefon…',
			emptyMsg: 'Tiada traveller dijumpai.',
			filters: [
				{ key: 'status', label: 'All status', of: (r) => r.status || '' },
				{ key: 'nationality', label: 'All nationalities', of: (r) => r.nationality || '' },
				{ key: 'agecat', label: 'All ages', of: (r) => r.age_category || '' },
			],
			sortable: [
				{ key: 'name', val: (r) => (r.full_name || r.name || '').toLowerCase() },
				null,
				{ key: 'pexp', val: (r) => r.passport_expiry || '' },
				{ key: 'nat', val: (r) => r.nationality || '' },
				{ key: 'gender', val: (r) => r.gender || '' },
				{ key: 'age', val: (r) => r.age ?? -1 },
				{ key: 'bookings', val: (r) => r.bookings || 0 },
				{ key: 'last', val: (r) => r.last_booking || '' },
				{ key: 'created', val: (r) => r.creation || '' },
			],
		});
	}
